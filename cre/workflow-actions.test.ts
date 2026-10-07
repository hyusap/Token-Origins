import {expect} from 'bun:test';
import {test,newTestRuntime,HttpActionsMock,EvmMock,SolanaMock,addContractMock} from '@chainlink/cre-sdk/test';
import {bigintToProtoBigInt,getNetwork,type HTTPPayload} from '@chainlink/cre-sdk';
import {parseAbi,decodeAbiParameters,parseAbiParameters,type Hex} from 'viem';
import {PublicKey} from '@solana/web3.js';
import {onHttp,onCron,solanaPlan} from './workflow/handler';
import {policyHash,policyGraphSchema,NETWORKS,POR_REGISTRY,TOKEN_REGISTRY,LENDING_REGISTRY,FEED_REGISTRY,CCIP_DESTINATIONS,payeeId,MAX_SOURCES,collectSources,sourceIdentity,type ChainSource} from './graph';
import {chainReadCost} from './onchain-reads';
import {encodeSolanaActionReport,encodeSolanaPauseReport} from './solana-report';

const vaultAddress='0x0000000000000000000000000000000000001234';
const tokenAddress='0x0000000000000000000000000000000000005678';
const sepolia=BigInt(NETWORKS['ethereum-sepolia'].chainSelector);
const mainnet=BigInt(NETWORKS['ethereum-mainnet'].chainSelector);
const baseConfig={vaultAddress,chainSelector:NETWORKS['ethereum-sepolia'].chainSelector,gasLimit:'2000000'};
const now=Date.parse('2026-10-06T04:40:00Z');
const nowSeconds=Math.floor(now/1000);
const specFor=(graphInput:unknown,overrides:Record<string,unknown>={})=>{
  const graph=policyGraphSchema.parse(graphInput);
  return {version:2,runId:'action-run',revision:5,graph,policyHash:policyHash(graph),maxAgeSeconds:60,broadcast:true,...overrides};
};
const payload=(input:unknown):HTTPPayload=>({$typeName:'capabilities.networking.http.v1alpha.Payload',input:new TextEncoder().encode(JSON.stringify(input))});
const v3Layout=parseAbiParameters('uint256,address,uint256,bytes32,uint256,bytes32,uint256,uint256,uint256,bytes32,uint256,uint64');
const feedAbi=parseAbi(['function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)']);

function setup({reportVersion=3,paused=false,balanceWei=2_000_000_000_000_000_000n,tokens=3_000_000_000_000_000_000n,config={} as Record<string,unknown>}={}) {
  const runtime=newTestRuntime(null,{timeProvider:()=>now},{...baseConfig,...config});
  const http=HttpActionsMock.testInstance();
  let httpCalls=0;
  http.sendRequest=()=>{httpCalls++;return {statusCode:200,body:Buffer.from(JSON.stringify({price:'2500',time:'2026-10-06T04:39:55Z'})).toString('base64')};};
  const evm=EvmMock.testInstance(sepolia);
  const vault=addContractMock(evm,{address:vaultAddress,abi:parseAbi(['function paused() view returns (bool)','function reportVersion() view returns (uint256)','function ccipToken() view returns (address)'])});
  let vaultReads=0;
  vault.paused=()=>{vaultReads++;return paused;};
  vault.reportVersion=()=>{vaultReads++;return BigInt(reportVersion);};
  vault.ccipToken=()=>{vaultReads++;return tokenAddress;};
  const token=addContractMock(evm,{address:tokenAddress,abi:parseAbi(['function balanceOf(address) view returns (uint256)'])});
  token.balanceOf=()=>tokens;
  evm.balanceAt=()=>({balance:bigintToProtoBigInt(balanceWei)});
  const writes:Uint8Array[]=[];
  evm.writeReport=(request)=>{writes.push(request.report!.rawReport!);return {txStatus:'TX_STATUS_SUCCESS',receiverContractExecutionStatus:'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS',txHash:Buffer.alloc(32,2).toString('base64')};};
  return {runtime,writes,vaultReads:()=>vaultReads,httpCalls:()=>httpCalls};
}
const lastV3=(writes:Uint8Array[])=>decodeAbiParameters(v3Layout,`0x${Buffer.from(writes.at(-1)!).toString('hex').slice(-768)}` as Hex);
function mainnetReads({reserves=120_000n*10n**8n,supply=128_000n*10n**8n,aaveRay=31_000_000_000_000_000_000_000_000n,compoundPerSecond=1_236_682_400n}={}) {
  const evm=EvmMock.testInstance(mainnet);
  const por=addContractMock(evm,{address:POR_REGISTRY.WBTC.address,abi:feedAbi});
  por.latestRoundData=()=>[3n,reserves,BigInt(nowSeconds-1800),BigInt(nowSeconds-1800),3n];
  const wbtc=addContractMock(evm,{address:TOKEN_REGISTRY.WBTC.address,abi:parseAbi(['function totalSupply() view returns (uint256)'])});
  wbtc.totalSupply=()=>supply;
  const aave=addContractMock(evm,{address:LENDING_REGISTRY['aave-v3'].address,abi:parseAbi(['function getReserveData(address) view returns (uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)'])});
  aave.getReserveData=(...args:readonly unknown[])=>{expect(String(args[0]).toLowerCase()).toBe(LENDING_REGISTRY['aave-v3'].assets.USDC.toLowerCase());return [0n,10n**27n,aaveRay,0n,0n,0n,nowSeconds,1,vaultAddress,vaultAddress,vaultAddress,vaultAddress,0n,0n,0n];};
  const comet=addContractMock(evm,{address:LENDING_REGISTRY['compound-v3'].address,abi:parseAbi(['function getUtilization() view returns (uint64)','function getSupplyRate(uint256) view returns (uint64)'])});
  comet.getUtilization=()=>900_000_000_000_000_000n;
  comet.getSupplyRate=(...args:readonly unknown[])=>{expect(args[0]).toBe(900_000_000_000_000_000n);return compoundPerSecond;};
  const eth=addContractMock(evm,{address:FEED_REGISTRY['ethereum-mainnet'].ETH!,abi:feedAbi});
  eth.latestRoundData=()=>[9n,2_500n*10n**8n,BigInt(nowSeconds-600),BigInt(nowSeconds-600),9n];
}

const reserveSweep={nodes:[
  {id:'reserves',kind:'reading',source:{type:'proof-of-reserve',asset:'WBTC'}},
  {id:'supply',kind:'reading',source:{type:'token-supply',token:'WBTC'}},
  {id:'coverage',kind:'math',op:'/',left:'reserves',right:'supply'},
  {id:'short',kind:'compare',input:'coverage',op:'<',value:1},
],root:'short',action:{type:'sweep',fraction:0.5}};

test('Proof of Reserve and token supply are read on mainnet; a shortfall sends one v3 sweep report',()=>{
  const t=setup();
  mainnetReads();
  const spec=specFor(reserveSweep);
  const result=JSON.parse(onHttp(t.runtime,payload(spec)));
  expect(result.decision).toBe('act');
  expect(result.observations.map((o:any)=>[o.key,o.value,o.unit])).toEqual([['proof-of-reserve:ethereum-mainnet:WBTC',120000,'WBTC'],['token-supply:ethereum-mainnet:WBTC',128000,'WBTC']]);
  expect(result.observations[0]).toMatchObject({provider:'chainlink',address:POR_REGISTRY.WBTC.address,roundId:'3',observedAt:new Date((nowSeconds-1800)*1000).toISOString()});
  expect(t.writes).toHaveLength(1);
  const [version,target,chainId,,revision,policy,action,decidedAt,flags,payee,amount,destination]=lastV3(t.writes);
  expect([version,target.toLowerCase(),chainId,revision,policy,action,decidedAt,flags,amount,destination]).toEqual([3n,vaultAddress,11155111n,5n,spec.policyHash,2n,BigInt(nowSeconds),1n,5000n,0n]);
  expect(payee).toBe(`0x${'0'.repeat(64)}`);
  expect(result.report).toMatchObject({version:3,action:2,flags:1,amount:'5000'});
  expect(t.httpCalls()).toBe(0);
});

test('lending rates come from Aave and Compound contracts and drive a simulated rebalance that CRE refuses',()=>{
  const t=setup();
  mainnetReads();
  const chase=specFor({nodes:[
    {id:'aave',kind:'reading',source:{type:'lending-rate',protocol:'aave-v3',asset:'USDC'}},
    {id:'comp',kind:'reading',source:{type:'lending-rate',protocol:'compound-v3',asset:'USDC'}},
    {id:'edge',kind:'math',op:'-',left:'comp',right:'aave'},
    {id:'better',kind:'compare',input:'edge',op:'>',value:0.5},
  ],root:'better',action:{type:'rebalance',from:'aave-v3',to:'compound-v3',fraction:1}});
  expect(()=>onHttp(t.runtime,payload(chase))).toThrow(/Simulated sells run only in local rehearsal/);
  expect(t.vaultReads()).toBe(0);
  // The same reads behind a real action: 3.1% on Aave, 3.9% on Compound.
  const pause=specFor({...chase.graph,action:{type:'pause-vault'}});
  const result=JSON.parse(onHttp(t.runtime,payload(pause)));
  const rates=Object.fromEntries(result.observations.map((o:any)=>[o.provider,Math.round(o.value*1e4)/1e4]));
  expect(rates).toEqual({aave:3.1,compound:3.9});
  expect(result.decision).toBe('act');
});

test('treasury value reads the vault balance once and multiplies it by the ETH feed',()=>{
  const t=setup({balanceWei:1_000_000_000_000_000_000n});
  mainnetReads();
  const runway=specFor({nodes:[
    {id:'bal',kind:'reading',source:{type:'vault-balance'}},{id:'eth',kind:'price',source:{type:'chainlink-feed',symbol:'ETH'}},
    {id:'usd',kind:'math',op:'*',left:'bal',right:'eth'},{id:'low',kind:'compare',input:'usd',op:'<',value:5000}],root:'low',action:{type:'pause-vault'}});
  const result=JSON.parse(onHttp(t.runtime,payload(runway)));
  expect(result.observations.find((o:any)=>o.key==='vault-balance')).toMatchObject({value:1,unit:'ETH',raw:'1000000000000000000'});
  expect(result.conditions.find((c:any)=>c.nodeId==='low').detail).toBe('(vault ETH balance × Chainlink ETH/USD (mainnet)) $2,500.00 < $5,000.00');
  expect(t.writes).toHaveLength(1);
});

test('pay sends the payee id and wei amount; an evacuation reads the vault token balance and names the CCIP lane',()=>{
  const t=setup();
  mainnetReads();
  const ethLow=(action:unknown)=>specFor({nodes:[{id:'eth',kind:'price',source:{type:'chainlink-feed',symbol:'ETH'}},{id:'low',kind:'compare',input:'eth',op:'<',value:3000}],root:'low',action},{runId:`run-${Math.random().toString(36).slice(2)}`});
  JSON.parse(onHttp(t.runtime,payload(ethLow({type:'pay',payee:'grantee',amountEth:0.01}))));
  const pay=lastV3(t.writes);
  expect([pay[6],pay[8],pay[9],pay[10]]).toEqual([3n,0n,payeeId('grantee'),10_000_000_000_000_000n]);
  const before=t.vaultReads();
  const result=JSON.parse(onHttp(t.runtime,payload(ethLow({type:'evacuate',destination:'base-sepolia',fraction:1}))));
  expect(t.vaultReads()-before).toBe(3); // reportVersion, paused, ccipToken
  expect(result.vault.tokenBalance).toBe('3000000000000000000');
  const evacuate=lastV3(t.writes);
  expect([evacuate[6],evacuate[8],evacuate[10],evacuate[11]]).toEqual([4n,1n,10000n,BigInt(CCIP_DESTINATIONS['base-sepolia'].chainSelector)]);
});

test('guards stop real actions before any write: no funds, no tokens, paused spending for a payment',()=>{
  mainnetReads();
  const ethLow=(action:unknown)=>specFor({nodes:[{id:'eth',kind:'price',source:{type:'chainlink-feed',symbol:'ETH'}},{id:'low',kind:'compare',input:'eth',op:'<',value:3000}],root:'low',action});
  for(const [opts,action,reason] of [
    [{balanceWei:0n},{type:'sweep',fraction:1},'Vault holds no ETH to sweep.'],
    [{tokens:0n},{type:'evacuate',destination:'base-sepolia',fraction:1},'Vault holds no CCIP-BnM to evacuate.'],
    [{paused:true},{type:'pay',payee:'grantee',amountEth:0.01},'Vault spending is paused; no payment is made.'],
  ] as const) {
    const t=setup(opts as any);
    const result=JSON.parse(onHttp(t.runtime,payload(ethLow(action))));
    expect(result.decision).toBe('noop');
    expect(result.noopReason).toBe(reason);
    expect(t.writes).toHaveLength(0);
  }
});

test('a v2 vault still gets v2 pause reports, and refuses every new action before reading sources',()=>{
  mainnetReads();
  const t=setup({reportVersion:2});
  const pause=specFor({nodes:[{id:'eth',kind:'price',source:{type:'chainlink-feed',symbol:'ETH'}},{id:'low',kind:'compare',input:'eth',op:'<',value:3000}],root:'low',action:{type:'pause-vault'}});
  JSON.parse(onHttp(t.runtime,payload(pause)));
  expect(Buffer.from(t.writes[0]!).toString('hex').slice(-512).slice(0,64)).toBe('2'.padStart(64,'0'));
  const sweep=specFor({...pause.graph,action:{type:'sweep',fraction:0.5}});
  expect(()=>onHttp(t.runtime,payload(sweep))).toThrow(/pause reports only \(v2\); a sweep needs a GrantVault v3/);
  expect(t.writes).toHaveLength(1);
});

test('the cron trigger evaluates the standing policy from the workflow config',()=>{
  mainnetReads();
  const spec=specFor(reserveSweep,{runId:'watch-check-3'});
  const t=setup({config:{watch:{schedule:'*/30 * * * * *',spec}}});
  const result=JSON.parse(onCron(t.runtime,{} as any));
  expect(result).toMatchObject({runId:'watch-check-3',trigger:'cron',decision:'act'});
  expect(t.writes).toHaveLength(1);
  expect(()=>onCron(setup().runtime,{} as any)).toThrow(/No standing policy/);
});

const solanaBase={chainSelectorName:'solana-devnet' as const,receiverProgramId:'8g87GMMGr4JrzJpfh8v9oxyy8mwDRGawBRFJR8c1hqYD',forwarderProgramId:'7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK',forwarderState:'5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7',vault:'9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'};
const sweepAccounts={treasury:'5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7',reserve:'7593tF3wMY5bT9hLv6hGgMXanRkgG7p48jsA6JcpXWtE'};

test('Solana plan: sweep where a reserve is configured, pause otherwise, and nothing for payments',()=>{
  expect(solanaPlan({type:'sweep',fraction:0.5,pause:true},{...solanaBase,sweep:sweepAccounts})).toEqual({write:true,action:2,flags:1,bps:5000,sweep:true});
  expect(solanaPlan({type:'sweep',fraction:0.5,pause:true},solanaBase)).toEqual({write:true,action:1,flags:0,bps:0,sweep:false});
  expect(solanaPlan({type:'sweep',fraction:0.5,pause:false},solanaBase)).toMatchObject({write:false});
  expect(solanaPlan({type:'evacuate',destination:'base-sepolia',fraction:1,pause:true},solanaBase)).toMatchObject({write:true,action:1});
  expect(solanaPlan({type:'pay',payee:'grantee',amountEth:0.01},solanaBase)).toMatchObject({write:false,reason:expect.stringMatching(/Ethereum only/)});
});

test('a sweep writes the v3 Solana report with the treasury config and reserve appended to the hashed accounts',()=>{
  mainnetReads();
  const t=setup({config:{solana:{...solanaBase,sweep:sweepAccounts}}});
  const solana=SolanaMock.testInstance(getNetwork({chainFamily:'solana',chainSelectorName:'solana-devnet',isTestnet:true})!.chainSelector.selector);
  const requests:any[]=[];
  solana.writeReport=(request)=>{requests.push(request);return {txStatus:'TX_STATUS_SUCCESS',txSignature:Buffer.alloc(64,9).toString('base64')} as any;};
  const spec=specFor(reserveSweep);
  const result=JSON.parse(onHttp(t.runtime,payload(spec)));
  expect(requests).toHaveLength(1);
  const keys=requests[0].remainingAccounts.map((a:any)=>new PublicKey(Buffer.from(a.publicKey)).toBase58());
  expect(keys.slice(2)).toEqual([solanaBase.vault,sweepAccounts.treasury,sweepAccounts.reserve]);
  expect(requests[0].remainingAccounts[4].isWritable).toBe(true);
  const expected=encodeSolanaActionReport({vault:new PublicKey(solanaBase.vault).toBytes(),runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash as Hex,decidedAt:nowSeconds,action:2,flags:1,bps:5000});
  const raw=Buffer.from(requests[0].report.rawReport);
  expect(raw.subarray(raw.length-expected.length).equals(Buffer.from(expected))).toBe(true);
  expect(result.solana).toMatchObject({action:'sweep',pauses:true,reserve:sweepAccounts.reserve,bps:5000,status:'success'});
  // A payment leaves Solana alone and says why.
  const pay=specFor({...reserveSweep,action:{type:'pay',payee:'grantee',amountEth:0.01}},{runId:'pay-run'});
  const paid=JSON.parse(onHttp(t.runtime,payload(pay)));
  expect(requests).toHaveLength(1);
  expect(paid.solanaSkipped).toMatch(/Ethereum only/);
  expect(encodeSolanaPauseReport({vault:new PublicKey(solanaBase.vault).toBytes(),runId:'x',revision:1,policyHash:spec.policyHash as Hex,decidedAt:1}).length).toBe(114);
});

test('the worst-case graph stays inside the CRE read quota',()=>{
  // Every chain source costs at most 2 reads (Compound), and only one Compound market exists; the vault takes up to 5.
  const sources:ChainSource[]=[{type:'lending-rate',protocol:'compound-v3',asset:'USDC'},{type:'lending-rate',protocol:'aave-v3',asset:'USDC'},{type:'proof-of-reserve',asset:'WBTC'},{type:'token-supply',token:'WBTC'},{type:'chainlink-feed',symbol:'BTC',network:'ethereum-mainnet'}];
  expect(sources).toHaveLength(MAX_SOURCES);
  expect(5+sources.reduce((sum,source)=>sum+chainReadCost(source),0)).toBeLessThanOrEqual(15);
  for(const source of sources) expect(sourceIdentity(source).network).toBe('ethereum-mainnet');
  expect(collectSources(policyGraphSchema.parse(reserveSweep)).length).toBe(2);
});
