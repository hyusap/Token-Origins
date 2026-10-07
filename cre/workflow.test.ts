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
  const sell=specFor({nodes:[{id:'eth',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},{id:'a',kind:'compare',input:'eth',op:'<',value:3000}],root:'a',action:{type:'sell',symbol:'ETH',amount:1,venue:'mock-venue'}});
  expect(()=>onHttp(t.runtime,payload(sell))).toThrow(/Simulated sells run only in local rehearsal/);
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
  const sell=specFor({...legacyGraph(3000),action:{type:'sell',symbol:'ETH',amount:1,venue:'mock-venue'}}) as any;
  await expect(assertCreSupports(sell,['ethereum-testnet-sepolia'])).rejects.toThrow(/Simulated sells/);
});

test('the project configures RPCs for both feed networks and the Solana vault',async()=>{
  const {configuredCreChains}=await import('./runner');
  expect((await configuredCreChains()).sort()).toEqual(['ethereum-mainnet','ethereum-testnet-sepolia','solana-devnet']);
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

// ---- Solana leg: the same decision paused on a second treasury ----
import {SolanaMock} from '@chainlink/cre-sdk/test';
import {getNetwork} from '@chainlink/cre-sdk';
import {encodeSolanaPauseReport} from './solana-report';
const solanaConfig={chainSelectorName:'solana-devnet' as const,receiverProgramId:'8g87GMMGr4JrzJpfh8v9oxyy8mwDRGawBRFJR8c1hqYD',forwarderProgramId:'7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK',forwarderState:'5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7',vault:'9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'};
const solanaSelector=getNetwork({chainFamily:'solana',chainSelectorName:'solana-devnet',isTestnet:true})!.chainSelector.selector;
function setupWithSolana(price:number,opts:{paused?:boolean;solanaStatus?:string}={}) {
  const t=setup(price,{paused:opts.paused});
  const runtime=newTestRuntime(null,{timeProvider:()=>now},{...config,solana:solanaConfig});
  const solana=SolanaMock.testInstance(solanaSelector);
  const solanaWrites:any[]=[];
  solana.writeReport=(request)=>{solanaWrites.push(request);return {txStatus:opts.solanaStatus??'TX_STATUS_SUCCESS',txSignature:Buffer.alloc(64,9).toString('base64')} as any;};
  return {...t,runtime,solanaWrites};
}

test('an acting decision pauses the Solana vault too, with the same run and policy hash',()=>{
  const t=setupWithSolana(2700);
  const spec=specFor(legacyGraph(3000));
  const result=JSON.parse(onHttp(t.runtime,payload(spec)));
  expect(t.writes()).toBe(1);
  expect(t.solanaWrites.length).toBe(1);
  const request=t.solanaWrites[0];
  // Account order is part of the forwarder's hash: state, authority PDA, vault.
  const keys=request.remainingAccounts.map((a:any)=>Buffer.from(a.publicKey).toString('hex'));
  expect(keys).toHaveLength(3);
  expect(keys[2]).toBe(Buffer.from(new (require('@solana/web3.js').PublicKey)(solanaConfig.vault).toBytes()).toString('hex'));
  const expected=encodeSolanaPauseReport({vault:new (require('@solana/web3.js').PublicKey)(solanaConfig.vault).toBytes(),runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash as any,decidedAt:now/1000});
  const raw=Buffer.from(request.report.rawReport);
  expect(raw.subarray(raw.length-expected.length).equals(Buffer.from(expected))).toBe(true);
  expect(result.solana).toMatchObject({status:'success',vault:solanaConfig.vault,programId:solanaConfig.receiverProgramId});
  expect(result.solana.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{60,90}$/);
});

test('no Solana write when the policy does not act, and a Solana failure is recorded without losing EVM evidence',()=>{
  const quiet=setupWithSolana(3500);
  expect(JSON.parse(onHttp(quiet.runtime,payload(specFor(legacyGraph(3000))))).decision).toBe('noop');
  expect(quiet.solanaWrites.length).toBe(0);
  const failing=setupWithSolana(2700,{solanaStatus:'TX_STATUS_FATAL'});
  const result=JSON.parse(onHttp(failing.runtime,payload(specFor(legacyGraph(3000)))));
  expect(result.transaction.receiverConfirmed).toBe(true);
  expect(result.solana.status).toBe('failed');
});
