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

const graphSpec={...spec,thresholdUsd:9_999_999,graph:{
  nodes:[
    {id:'eth',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},
    {id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},
    {id:'a',kind:'compare',input:'eth',op:'<',value:9_999_999},
    {id:'b',kind:'compare',input:'btc',op:'<',value:90_000},
    {id:'both',kind:'and',inputs:['a','b']}],
  root:'both',action:{type:'pause-vault'}}} as const;

/** Adds a Sepolia BTC aggregator to the EVM mock at the address the handler reads. */
function withFeed(evm:ReturnType<typeof EvmMock.testInstance>,answer:bigint,updatedAt:number) {
  const feed=addContractMock(evm,{address:'0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43',abi:parseAbi(['function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)','function decimals() view returns (uint8)'])});
  feed.decimals=()=>8;
  feed.latestRoundData=()=>[1n,answer,BigInt(updatedAt),BigInt(updatedAt),1n];
  return feed;
}

test('graph handler reads a Chainlink aggregator on the vault chain and pauses when both branches hold',()=>{
  const {runtime,evm}=setup(2700);
  withFeed(evm,8_500_000_000_000n,Math.floor(now/1000)-2400);
  let writes=0;
  evm.writeReport=()=>{writes++;return {txStatus:'TX_STATUS_SUCCESS',receiverContractExecutionStatus:'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS',txHash:Buffer.alloc(32,1).toString('base64')};};
  const result=JSON.parse(onHttp(runtime,payload(graphSpec as any)));
  expect(result.decision).toBe('pause');
  expect(writes).toBe(1);
  // The oracle branch decided while 40 minutes stale; only the reported trade must be fresh.
  expect(result.conditions.find((c:any)=>c.nodeId==='b').passed).toBe(true);
  expect(result.conditions.find((c:any)=>c.nodeId==='guard:freshness').passed).toBe(true);
});

test('graph handler withholds the report when an oracle branch fails',()=>{
  const {runtime,evm}=setup(2700);
  withFeed(evm,9_500_000_000_000n,Math.floor(now/1000)-2400); // $95k, above the $90k branch
  evm.writeReport=()=>{throw new Error('Unexpected report');};
  const result=JSON.parse(onHttp(runtime,payload(graphSpec as any)));
  expect(result.decision).toBe('noop');
  expect(result.conditions.find((c:any)=>c.nodeId==='b').passed).toBe(false);
  expect(result.conditions.find((c:any)=>c.nodeId==='both').passed).toBe(false);
});

test('graph handler refuses a feed with no configured aggregator on the vault chain',()=>{
  const {runtime}=setup(2700);
  const solSpec={...graphSpec,graph:{...graphSpec.graph,nodes:graphSpec.graph.nodes.map(n=>n.id==='btc'?{...n,source:{type:'chainlink-feed',symbol:'SOL'}}:n)}};
  expect(()=>onHttp(runtime,payload(solSpec as any))).toThrow(/No Sepolia Chainlink feed/);
});

test('graph handler surfaces receiver threshold incompatibility instead of a silent revert',()=>{
  const {runtime,evm}=setup(2700);
  withFeed(evm,8_500_000_000_000n,Math.floor(now/1000)-2400);
  evm.writeReport=()=>{throw new Error('Unexpected report');};
  // Reported price $2700 is not below the reported threshold $1000, which the
  // receiver rejects; the policy's own logic still evaluates true.
  const result=JSON.parse(onHttp(runtime,payload({...graphSpec,thresholdUsd:1000} as any)));
  expect(result.decision).toBe('noop');
  expect(result.conditions.find((c:any)=>c.nodeId==='guard:composed').passed).toBe(true);
  expect(result.conditions.find((c:any)=>c.nodeId==='guard:receiver-threshold').passed).toBe(false);
});

test('the legacy single-threshold spec still drives the handler unchanged',()=>{
  const {runtime,evm}=setup(2700);
  let writes=0;
  evm.writeReport=()=>{writes++;return {txStatus:'TX_STATUS_SUCCESS',receiverContractExecutionStatus:'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS',txHash:Buffer.alloc(32,1).toString('base64')};};
  const result=JSON.parse(onHttp(runtime,payload()));
  expect(result.decision).toBe('pause');
  expect(writes).toBe(1);
});
