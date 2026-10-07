import { EVMClient, protoBigIntToBigint, HTTPClient, HTTPCapability, Runner, handler, decodeJson, encodeCallMsg, bytesToHex, hexToBase64, LATEST_BLOCK_NUMBER, TxStatus, ConsensusAggregationByFields, median, type HTTPSendRequester, type HTTPPayload, type Runtime } from '@chainlink/cre-sdk';
import { EVM_PB } from '@chainlink/cre-sdk/pb';
import { encodeFunctionData, decodeFunctionResult, parseAbi, encodeAbiParameters, parseAbiParameters, keccak256, toBytes, zeroAddress, type Address } from 'viem';
import { z } from 'zod';
import { specificationSchema, PRICE_URL, parsePrice, evaluate, type ConditionEvidence } from '../spec';
import { evaluateGraph, collectSources, sourceKey, describeSource, SEPOLIA_FEEDS, type PriceReading } from '../graph';
export const configSchema=z.object({vaultAddress:z.string().regex(/^0x[0-9a-fA-F]{40}$/),chainSelector:z.literal('16015286601757825753'),gasLimit:z.string()});
export type Config=z.infer<typeof configSchema>;
const vaultAbi=parseAbi(['function paused() view returns (bool)']);
const feedAbi=parseAbi(['function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)','function decimals() view returns (uint8)']);
/** One aggregator read, on the same chain and selector as the vault. */
function readFeed(runtime:Runtime<Config>,client:EVMClient,symbol:string):PriceReading {
  const address=SEPOLIA_FEEDS[symbol as keyof typeof SEPOLIA_FEEDS];
  if(!address) throw new Error(`No Sepolia Chainlink feed is configured for ${symbol}; the CRE path reads feeds on the vault's own chain`);
  const call=(data:`0x${string}`)=>client.callContract(runtime,{call:encodeCallMsg({from:zeroAddress,to:address,data}),blockNumber:LATEST_BLOCK_NUMBER}).result();
  const decimals=decodeFunctionResult({abi:feedAbi,functionName:'decimals',data:bytesToHex(call(encodeFunctionData({abi:feedAbi,functionName:'decimals'})).data)});
  const round=decodeFunctionResult({abi:feedAbi,functionName:'latestRoundData',data:bytesToHex(call(encodeFunctionData({abi:feedAbi,functionName:'latestRoundData'})).data)});
  const answer=round[1]; const updatedAt=round[3];
  if(answer<=0n) throw new Error(`${symbol} feed returned a non-positive answer`);
  if(updatedAt===0n) throw new Error(`${symbol} feed has no completed round`);
  return {usd:Number(answer)/10**Number(decimals),observedAt:new Date(Number(updatedAt)*1000).toISOString()};
}
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
  let conditions:ConditionEvidence[]; let decision:'pause'|'noop';
  if(spec.graph) {
    const prices:Record<string,PriceReading>={'exchange-trade:ETH-USD':{usd:price.usd,observedAt:price.observedAt}};
    for(const source of collectSources(spec.graph)) {
      if(source.type==='exchange-trade') continue;
      runtime.log(`ORIGINS_SOURCE Resolving ${describeSource(source)} on the vault's chain`);
      prices[sourceKey(source)]=readFeed(runtime,client,source.symbol);
    }
    const result=evaluateGraph(spec.graph,{prices,vaultPaused:paused,executionPrice:{usd:price.usd,observedAt:price.observedAt},executionMaxAgeSeconds:spec.maxAgeSeconds,reportedThresholdUsd:spec.thresholdUsd},runtime.now().getTime());
    conditions=result.evidence; decision=result.decision;
  } else {
    conditions=evaluate(spec,price,paused,runtime.now().getTime());
    decision=conditions.every(c=>c.passed)?'pause':'noop';
  }
  const evidence:any={runId:spec.runId,revision:spec.revision,mode:'cre-local-simulation',price,vault:{address:runtime.config.vaultAddress,chainId:11155111,paused,balanceWei:(balance.balance ? protoBigIntToBigint(balance.balance) : 0n).toString()},conditions,decision,logs:[]};
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
