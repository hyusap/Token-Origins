import {expect} from 'bun:test';
import {test,newTestRuntime,HttpActionsMock,EvmMock,addContractMock} from '@chainlink/cre-sdk/test';
import {bigintToProtoBigInt,type HTTPPayload} from '@chainlink/cre-sdk';
import {parseAbi,decodeAbiParameters,parseAbiParameters,keccak256,toBytes,type Hex} from 'viem';
import {onHttp} from './workflow/handler';
import {policyHash,legacyGraph,policyGraphSchema,NETWORKS,FEED_REGISTRY} from './graph';
import {assertCreSupports} from './runner';
import {joinEvidenceChunks,evidenceChunks} from './evidence-log';

const vaultAddress='0x0000000000000000000000000000000000001234';
const sepolia=BigInt(NETWORKS['ethereum-sepolia'].chainSelector);
const mainnet=BigInt(NETWORKS['ethereum-mainnet'].chainSelector);
const config={vaultAddress,chainSelector:NETWORKS['ethereum-sepolia'].chainSelector,gasLimit:'350000'};
const now=Date.parse('2026-10-06T04:40:00Z');
const specFor=(graphInput:unknown,overrides:Record<string,unknown>={})=>{
  const graph=policyGraphSchema.parse(graphInput);
  return {version:2,runId:'sdk-test-run',revision:2,graph,policyHash:policyHash(graph),maxAgeSeconds:60,broadcast:true,...overrides};
};
function setup(price:number,{paused=false,time='2026-10-06T04:39:50Z',reportVersion=2 as number|null}={}) {
  const runtime=newTestRuntime(null,{timeProvider:()=>now},config);
  const http=HttpActionsMock.testInstance();
  let httpCalls=0;
  http.sendRequest=(request)=>{httpCalls++;expect(request.url).toBe('https://api.exchange.coinbase.com/products/ETH-USD/ticker');return {statusCode:200,body:Buffer.from(JSON.stringify({price:String(price),time})).toString('base64')};};
  const evm=EvmMock.testInstance(sepolia);
  const contract=addContractMock(evm,{address:vaultAddress,abi:parseAbi(['function paused() view returns (bool)','function reportVersion() view returns (uint256)'])});
  contract.paused=()=>paused;
  if(reportVersion!==null) contract.reportVersion=()=>BigInt(reportVersion);
  evm.balanceAt=()=>({balance:bigintToProtoBigInt(1204900000000000000n)});
  let writes=0; let lastReport:Uint8Array|undefined;
  evm.writeReport=(request)=>{writes++;lastReport=request.report?.rawReport;return {txStatus:'TX_STATUS_SUCCESS',receiverContractExecutionStatus:'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS',txHash:Buffer.alloc(32,1).toString('base64')};};
  return {runtime,evm,contract,writes:()=>writes,httpCalls:()=>httpCalls,lastReport:()=>lastReport};
}
function payload(input:unknown):HTTPPayload {return {$typeName:'capabilities.networking.http.v1alpha.Payload',input:new TextEncoder().encode(JSON.stringify(input))};}
const feedAbi=parseAbi(['function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)']);
function withFeed(selector:bigint,address:string,answer:bigint,updatedAt:number) {
  const evm=selector===sepolia?EvmMock.testInstance(sepolia):EvmMock.testInstance(selector);
  const feed=addContractMock(evm,{address:address as Hex,abi:feedAbi});
  feed.latestRoundData=()=>[7n,answer,BigInt(updatedAt),BigInt(updatedAt),7n];
  return feed;
}

test('legacy threshold: false condition reads through capabilities and never writes',()=>{
  const t=setup(3500);
  const result=JSON.parse(onHttp(t.runtime,payload(specFor(legacyGraph(3000)))));
  expect(result.decision).toBe('noop');
  expect(result.noopReason).toBe('The policy condition was not met.');
  expect(result.vault.balanceWei).toBe('1204900000000000000');
  expect(result.observations[0].provider).toBe('coinbase');
  expect(t.writes()).toBe(0);
});

test('true condition submits one v2 report bound to vault, chain, run, revision and policy',()=>{
  const t=setup(2700);
  const spec=specFor(legacyGraph(3000));
  const result=JSON.parse(onHttp(t.runtime,payload(spec)));
  expect(result.decision).toBe('act');
  expect(result.transaction.receiverConfirmed).toBe(true);
  expect(t.writes()).toBe(1);
  const [version,target,chainId,runId,revision,policy,action,decidedAt]=decodeAbiParameters(parseAbiParameters('uint256,address,uint256,bytes32,uint256,bytes32,uint256,uint256'),`0x${Buffer.from(t.lastReport()!).toString('hex').slice(-512)}` as Hex);
  expect([version,target.toLowerCase(),chainId,runId,revision,policy,action]).toEqual([2n,vaultAddress,11155111n,keccak256(toBytes('sdk-test-run')),2n,spec.policyHash,1n]);
  expect(Number(decidedAt)).toBe(now/1000);
});

test('stale trades and an already-paused vault stop before any write',()=>{
  for(const opts of [{paused:true},{time:'2026-10-06T04:35:00Z'}]) {
    const t=setup(2700,opts);
    const result=JSON.parse(onHttp(t.runtime,payload(specFor(legacyGraph(3000)))));
    expect(result.decision).toBe('noop');
    expect(t.writes()).toBe(0);
  }
});

test('a receiver revert is a failure even when the transaction succeeded',()=>{
  const t=setup(2700);
  t.evm.writeReport=()=>({txStatus:'TX_STATUS_SUCCESS',receiverContractExecutionStatus:'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED'});
  expect(()=>onHttp(t.runtime,payload(specFor(legacyGraph(3000))))).toThrow('Report did not execute successfully');
});

test('J3: a simulated sell never reaches writeReport or any read',()=>{
  const t=setup(2700);
  const sell={...specFor(legacyGraph(3000)),graph:{...legacyGraph(3000),action:{type:'sell',symbol:'ETH',amount:1,venue:'mock-venue'}}};
  expect(()=>onHttp(t.runtime,payload(sell as any))).toThrow();
  expect(t.writes()).toBe(0);
  expect(t.httpCalls()).toBe(0);
});

test('a vault that predates report v2 is refused before anything is submitted',()=>{
  const t=setup(2700,{reportVersion:null});
  expect(()=>onHttp(t.runtime,payload(specFor(legacyGraph(3000))))).toThrow(/accepts report v1, not v2/);
  expect(t.writes()).toBe(0);
});

test('J8: a direct CRE request with an invalid graph or mismatched hash is rejected',()=>{
  const t=setup(2700);
  const good=specFor(legacyGraph(3000));
  expect(()=>onHttp(t.runtime,payload({...good,policyHash:policyHash(legacyGraph(1))}))).toThrow(/Policy hash does not match/);
  expect(()=>onHttp(t.runtime,payload({...good,graph:{nodes:[{id:'a',kind:'not',input:'a'}],root:'a',action:{type:'pause-vault'}}}))).toThrow(/cycle/);
  expect(t.writes()).toBe(0);
});

const crossChain={
  nodes:[
    {id:'eth',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},
    {id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC',network:'ethereum-mainnet'}},
    {id:'a',kind:'compare',input:'eth',op:'<',value:9_999_999},
    {id:'b',kind:'compare',input:'btc',op:'<',value:90_000},
    {id:'both',kind:'and',inputs:['a','b']}],
  root:'both',action:{type:'pause-vault'}} as const;

test('a mainnet feed is read from the mainnet aggregator the canvas shows, while the report lands on Sepolia',()=>{
  const t=setup(2700);
  withFeed(mainnet,FEED_REGISTRY['ethereum-mainnet'].BTC!,8_500_000_000_000n,Math.floor(now/1000)-2400);
  const result=JSON.parse(onHttp(t.runtime,payload(specFor(crossChain))));
  expect(result.decision).toBe('act');
  expect(t.writes()).toBe(1);
  const btc=result.observations.find((o:any)=>o.provider==='chainlink');
  expect(btc).toMatchObject({network:'ethereum-mainnet',chainId:1,address:FEED_REGISTRY['ethereum-mainnet'].BTC,usd:85000,raw:'8500000000000',roundId:'7'});
  expect(result.conditions.find((c:any)=>c.nodeId==='b').passed).toBe(true);
});

test('a Sepolia feed is read on Sepolia, and an oracle branch can withhold the report',()=>{
  const t=setup(2700);
  withFeed(sepolia,FEED_REGISTRY['ethereum-sepolia'].BTC!,9_500_000_000_000n,Math.floor(now/1000)-600);
  const sepoliaGraph={...crossChain,nodes:crossChain.nodes.map(n=>n.id==='btc'?{...n,source:{type:'chainlink-feed',symbol:'BTC',network:'ethereum-sepolia'}}:n)};
  const result=JSON.parse(onHttp(t.runtime,payload(specFor(sepoliaGraph as any))));
  expect(result.decision).toBe('noop');
  expect(result.conditions.find((c:any)=>c.nodeId==='b').passed).toBe(false);
  expect(t.writes()).toBe(0);
});

test('J7: a network the CRE project has no RPC for is refused before simulation',async()=>{
  const spec=specFor(crossChain) as any;
  await expect(assertCreSupports(spec,['ethereum-testnet-sepolia'])).rejects.toThrow(/needs an RPC for ethereum-mainnet.*will not substitute/);
  await expect(assertCreSupports(spec,['ethereum-testnet-sepolia','ethereum-mainnet'])).resolves.toBeUndefined();

});

test('the project configures RPCs for both feed networks',async()=>{
  const {configuredCreChains}=await import('./runner');
  expect((await configuredCreChains()).sort()).toEqual(['ethereum-mainnet','ethereum-testnet-sepolia']);
});

test('evidence leaves the workflow in log lines under the 1 KB CRE limit and reassembles exactly',()=>{
  const t=setup(2700);
  withFeed(mainnet,FEED_REGISTRY['ethereum-mainnet'].BTC!,8_500_000_000_000n,Math.floor(now/1000)-2400);
  const logs:string[]=[];
  const original=t.runtime.log.bind(t.runtime);
  t.runtime.log=(message:string)=>{logs.push(message);original(message);};
  const returned=onHttp(t.runtime,payload(specFor(crossChain)));
  expect(returned.length).toBeGreaterThan(1024);
  for(const line of logs) expect(new TextEncoder().encode(line).length).toBeLessThan(1024);
  // The CLI decorates and interleaves lines; reassembly must not care.
  const transcript=logs.map((line,i)=>`2026-10-07T05:00:0${i%10}Z [USER LOG] ${line}`).reverse().join('\n');
  expect(joinEvidenceChunks(transcript)).toBe(returned);
});

test('a missing or inconsistent evidence chunk is an error, never partial evidence',()=>{
  const chunks=evidenceChunks(JSON.stringify({big:'x'.repeat(3000)}));
  expect(chunks.length).toBeGreaterThan(3);
  expect(()=>joinEvidenceChunks(chunks.filter((_,i)=>i!==1).join('\n'))).toThrow(/chunk 2\/\d+ is missing/);
  expect(()=>joinEvidenceChunks('no evidence here')).toThrow(/no structured execution evidence/);
});

function assertUnsupportedSellBeforeCapabilities(answer:bigint) {
  const t=setup(2700);
  const updatedAt=Math.floor(now/1000)-2400;
  const feed=withFeed(mainnet,FEED_REGISTRY['ethereum-mainnet'].BTC!,answer,updatedAt);
  let feedReads=0,vaultReads=0;
  feed.latestRoundData=()=>{feedReads++;return [7n,answer,BigInt(updatedAt),BigInt(updatedAt),7n];};
  t.contract.paused=()=>{vaultReads++;return false;};
  t.contract.reportVersion=()=>{vaultReads++;return 2n;};
  const graph={nodes:[
    {id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC',network:'ethereum-mainnet'}},
    {id:'drop',kind:'compare',input:'btc',op:'<',value:90_000}],
    root:'drop',action:{type:'pause-vault'}};
  const validSpec=specFor(graph);
  const sellSpec={...validSpec,graph:{...validSpec.graph,action:{type:'sell',symbol:'BTC',amount:0.5,venue:'mock-venue'}}};
  // Unsupported actions are rejected as specifications, independently of
  // whether their proposed price condition would pass. No simulated order.
  expect(()=>onHttp(t.runtime,payload(sellSpec))).toThrow();
  expect(t.writes()).toBe(0);
  expect(t.httpCalls()).toBe(0);
  expect(feedReads).toBe(0);
  expect(vaultReads).toBe(0);
}

test('CRE refuses an unsupported sell before reads or writes even when its proposed condition would pass',()=>{
  assertUnsupportedSellBeforeCapabilities(8_500_000_000_000n);
});

test('CRE refuses an unsupported sell before reads or writes even when its proposed condition would fail',()=>{
  assertUnsupportedSellBeforeCapabilities(9_500_000_000_000n);
});
