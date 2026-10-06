import { EVMClient, protoBigIntToBigint, HTTPClient, HTTPCapability, Runner, handler, decodeJson, encodeCallMsg, bytesToHex, hexToBase64, LATEST_BLOCK_NUMBER, TxStatus, ConsensusAggregationByFields, median, type HTTPSendRequester, type HTTPPayload, type Runtime } from '@chainlink/cre-sdk';
import { EVM_PB } from '@chainlink/cre-sdk/pb';
import { encodeFunctionData, decodeFunctionResult, parseAbi, encodeAbiParameters, parseAbiParameters, keccak256, toBytes, zeroAddress, type Address } from 'viem';
import { z } from 'zod';
import { specificationSchema, PRICE_URL, parsePrice, evaluate } from '../spec';
export const configSchema=z.object({vaultAddress:z.string().regex(/^0x[0-9a-fA-F]{40}$/),chainSelector:z.literal('16015286601757825753'),gasLimit:z.string()});
export type Config=z.infer<typeof configSchema>;
const vaultAbi=parseAbi(['function paused() view returns (bool)']);
function fetchPrice(sender:HTTPSendRequester):{usd:number;observedAt:number} {
  const reply=sender.sendRequest({url:PRICE_URL,method:'GET',headers:{'Accept':'application/json'}}).result();
  if(reply.statusCode!==200) throw new Error(`Price source returned ${reply.statusCode}`);
  const price=parsePrice(JSON.parse(new TextDecoder().decode(reply.body)));
  return {usd:price.usd,observedAt:Date.parse(price.observedAt)};
}
export function onHttp(runtime:Runtime<Config>,payload:HTTPPayload):string {
  const spec=specificationSchema.parse(decodeJson(payload.input));
  const client=new EVMClient(BigInt(runtime.config.chainSelector));
  const input=new HTTPClient().sendRequest(runtime,fetchPrice,ConsensusAggregationByFields<{usd:number;observedAt:number}>({usd:median<number>,observedAt:median<number>}))().result();
  const price={usd:input.usd,observedAt:new Date(input.observedAt).toISOString(),source:PRICE_URL};
  const pausedReply=client.callContract(runtime,{call:encodeCallMsg({from:zeroAddress,to:runtime.config.vaultAddress as Address,data:encodeFunctionData({abi:vaultAbi,functionName:'paused'})}),blockNumber:LATEST_BLOCK_NUMBER}).result();
  const paused=decodeFunctionResult({abi:vaultAbi,functionName:'paused',data:bytesToHex(pausedReply.data)});
  const balance=client.balanceAt(runtime,{account:runtime.config.vaultAddress,blockNumber:LATEST_BLOCK_NUMBER}).result();
  const conditions=evaluate(spec,price,paused,runtime.now().getTime());
  const evidence:any={runId:spec.runId,revision:spec.revision,mode:'cre-local-simulation',price,vault:{address:runtime.config.vaultAddress,chainId:11155111,paused,balanceWei:(balance.balance ? protoBigIntToBigint(balance.balance) : 0n).toString()},conditions,decision:conditions.every(c=>c.passed)?'pause':'noop',logs:[]};
  runtime.log(`ORIGINS_INPUT ${JSON.stringify(evidence)}`);
  if(evidence.decision==='pause' && spec.broadcast!==false) {
    const report=runtime.report({encodedPayload:hexToBase64(encodeAbiParameters(parseAbiParameters('bytes32,uint256,uint256,uint256,uint256'),[keccak256(toBytes(spec.runId)),BigInt(spec.revision),BigInt(Math.round(price.usd*100)),BigInt(Math.round(spec.thresholdUsd*100)),BigInt(Math.floor(input.observedAt/1000))])),encoderName:'evm',signingAlgo:'ecdsa',hashingAlgo:'keccak256'}).result();
    const tx=client.writeReport(runtime,{receiver:runtime.config.vaultAddress,report,gasConfig:{gasLimit:runtime.config.gasLimit}}).result();
    const receiverConfirmed=tx.receiverContractExecutionStatus===EVM_PB.ReceiverContractExecutionStatus.SUCCESS;
    evidence.transaction={hash:tx.txHash?bytesToHex(tx.txHash):null,status:tx.txStatus===TxStatus.SUCCESS?'success':'failed',receiverConfirmed};
    if(tx.txStatus!==TxStatus.SUCCESS||!receiverConfirmed) throw new Error(`Report did not execute successfully: ${tx.errorMessage||tx.receiverContractExecutionStatus}`);
  }
  runtime.log(`ORIGINS_EVIDENCE ${JSON.stringify(evidence)}`);
  return JSON.stringify(evidence);
}
