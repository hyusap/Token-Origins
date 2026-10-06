import {expect} from 'bun:test';
import {test,newTestRuntime,HttpActionsMock,EvmMock,addContractMock} from '@chainlink/cre-sdk/test';
import {bigintToProtoBigInt,type HTTPPayload} from '@chainlink/cre-sdk';
import {parseAbi} from 'viem';
import {onHttp} from './workflow/handler';
const vaultAddress='0x0000000000000000000000000000000000001234';
const selector=16015286601757825753n;
const config={vaultAddress,chainSelector:'16015286601757825753' as const,gasLimit:'350000'};
const now=Date.parse('2026-10-06T04:40:00Z');
const spec={runId:'sdk-test-run',revision:2,thresholdUsd:3000,maxAgeSeconds:120,requireFresh:true,skipIfPaused:true,broadcast:true};
function setup(price:number,paused=false,time='2026-10-06T04:39:50Z') {
  const runtime=newTestRuntime(null,{timeProvider:()=>now},config);
  const http=HttpActionsMock.testInstance();
  http.sendRequest=(request)=>{expect(request.url).toBe('https://api.exchange.coinbase.com/products/ETH-USD/ticker');return {statusCode:200,body:Buffer.from(JSON.stringify({price:String(price),time})).toString('base64')};};
  const evm=EvmMock.testInstance(selector);
  const contract=addContractMock(evm,{address:vaultAddress,abi:parseAbi(['function paused() view returns (bool)'])});
  contract.paused=()=>paused;
  evm.balanceAt=()=>({balance:bigintToProtoBigInt(1204900000000000000n)});
  return {runtime,evm,contract};
}
function payload(input=spec):HTTPPayload {return {$typeName:'capabilities.networking.http.v1alpha.Payload',input:new TextEncoder().encode(JSON.stringify(input))};}
test('actual CRE handler fetches and reads via capabilities, false threshold never writes',()=>{const {runtime,evm}=setup(3500);let writes=0;evm.writeReport=()=>{writes++;return {};};const result=JSON.parse(onHttp(runtime,payload()));expect(result.decision).toBe('noop');expect(result.vault.balanceWei).toBe('1204900000000000000');expect(writes).toBe(0);});
test('actual CRE handler changes decision with threshold and submits report',()=>{const {runtime,evm}=setup(2700);let writes=0;evm.writeReport=(request)=>{writes++;expect(request.report?.rawReport.length).toBeGreaterThan(160);return {txStatus:'TX_STATUS_SUCCESS',receiverContractExecutionStatus:'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS',txHash:Buffer.alloc(32,1).toString('base64')};};const result=JSON.parse(onHttp(runtime,payload()));expect(result.decision).toBe('pause');expect(result.transaction.receiverConfirmed).toBe(true);expect(writes).toBe(1);});
test('actual CRE handler refuses stale observations and already-paused state',()=>{for(const [paused,time] of [[true,'2026-10-06T04:39:50Z'],[false,'2026-10-06T04:35:00Z']] as const){const {runtime,evm}=setup(2700,paused,time);evm.writeReport=()=>{throw new Error('Unexpected report');};expect(JSON.parse(onHttp(runtime,payload())).decision).toBe('noop');}});
test('actual CRE handler treats receiver revert as failure even when transaction succeeded',()=>{const {runtime,evm}=setup(2700);evm.writeReport=()=>({txStatus:'TX_STATUS_SUCCESS',receiverContractExecutionStatus:'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED'});expect(()=>onHttp(runtime,payload())).toThrow('Report did not execute successfully');});
