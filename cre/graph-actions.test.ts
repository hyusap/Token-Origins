import {expect,test} from 'bun:test';
import {decodeAbiParameters,parseAbiParameters,keccak256,toBytes} from 'viem';
import {
  validateGraph,evaluateGraph,policyHash,describeGraph,describeAction,explainNoop,policyGraphSchema,collectSources,sourceKey,sourceIdentity,readsVault,
  encodeActionReport,encodeReportFor,actionTerms,payeeId,REPORT_VERSION,PAUSE_REPORT_VERSION,ACTION_SWEEP,ACTION_PAY,ACTION_EVACUATE,FLAG_PAUSE,REPORT_V3_BYTES,
  CCIP_DESTINATIONS,POR_REGISTRY,TOKEN_REGISTRY,LENDING_REGISTRY,ZERO_ADDRESS,type GraphInputs,type PolicyGraph,type VaultAction,type VaultTerms,
} from './graph';
import {specificationSchema} from './spec';

const now=Date.parse('2026-10-06T04:40:00Z');
const at=(secondsAgo:number)=>new Date(now-secondsAgo*1000).toISOString();
const POR='proof-of-reserve:ethereum-mainnet:WBTC', SUPPLY='token-supply:ethereum-mainnet:WBTC';
const AAVE='lending-rate:ethereum-mainnet:aave-v3:USDC', COMP='lending-rate:ethereum-mainnet:compound-v3:USDC';
const USDC='chainlink-feed:ethereum-mainnet:USDC', USDT='chainlink-feed:ethereum-mainnet:USDT', ETHF='chainlink-feed:ethereum-mainnet:ETH';
const ETH=10n**18n;
const TERMS:VaultTerms={payee:'0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',maxPaymentWei:(ETH/20n).toString(),nextPaymentAt:0,ccipConfigured:true,tokenBalance:(2n*ETH).toString(),maxCcipFeeWei:(ETH/100n).toString(),nextEvacuationAt:0};
const terms=(patch:Partial<VaultTerms>={})=>({...TERMS,...patch});
const base=(readings:GraphInputs['readings'],extra:Partial<GraphInputs>={}):GraphInputs=>({readings,vaultPaused:false,vaultBalanceWei:ETH,vaultTerms:TERMS,exchangeMaxAgeSeconds:60,...extra});
const g=(input:unknown)=>validateGraph(input).graph;

// "Sweep half to the reserve if WBTC's reserves fall below its supply."
const reserveGuard=g({nodes:[
  {id:'reserves',kind:'reading',source:{type:'proof-of-reserve',asset:'WBTC'}},
  {id:'supply',kind:'reading',source:{type:'token-supply',token:'WBTC'}},
  {id:'coverage',kind:'math',op:'/',left:'reserves',right:'supply'},
  {id:'short',kind:'compare',input:'coverage',op:'<',value:1},
],root:'short',action:{type:'sweep',fraction:0.5}});

test('Proof of Reserve coverage: reserves ÷ supply against 1, with readings archived in their own units',()=>{
  const covered=evaluateGraph(reserveGuard,base({[POR]:{value:129000,observedAt:at(1800)},[SUPPLY]:{value:128500,observedAt:at(2)}}),now);
  expect(covered.decision).toBe('noop');
  expect(covered.conditions.find(c=>c.nodeId==='short')!.detail).toBe('(Chainlink WBTC Proof of Reserve ÷ WBTC total supply) 1.003891 < 1');
  const short=evaluateGraph(reserveGuard,base({[POR]:{value:120000,observedAt:at(1800)},[SUPPLY]:{value:128500,observedAt:at(2)}}),now);
  expect(short.decision).toBe('act');
  expect(describeGraph(reserveGuard)).toBe('Sweep 50% of the vault to the reserve and pause spending when (Chainlink WBTC Proof of Reserve ÷ WBTC total supply) < 1.');
  expect(sourceIdentity({type:'proof-of-reserve',asset:'WBTC'})).toMatchObject({provider:'chainlink',unit:'WBTC',address:POR_REGISTRY.WBTC.address,chainId:1});
  expect(sourceIdentity({type:'token-supply',token:'WBTC'})).toMatchObject({provider:'erc20',unit:'WBTC',address:TOKEN_REGISTRY.WBTC.address});
  // A supply of zero would make coverage undefined: the run fails loudly instead of guessing.
  expect(()=>evaluateGraph(reserveGuard,base({[POR]:{value:1,observedAt:at(5)},[SUPPLY]:{value:0,observedAt:at(5)}}),now)).toThrow(/zero/);
});

test('yield spread: Compound minus Aave, in percentage points, on contract reads',()=>{
  const chase=g({nodes:[
    {id:'aave',kind:'reading',source:{type:'lending-rate',protocol:'aave-v3',asset:'USDC'}},
    {id:'comp',kind:'reading',source:{type:'lending-rate',protocol:'compound-v3',asset:'USDC'}},
    {id:'edge',kind:'math',op:'-',left:'comp',right:'aave'},
    {id:'better',kind:'compare',input:'edge',op:'>',value:0.5},
  ],root:'better',action:{type:'rebalance',from:'aave-v3',to:'compound-v3',fraction:1}});
  const result=evaluateGraph(chase,base({[AAVE]:{value:3.1,observedAt:at(1)},[COMP]:{value:3.9,observedAt:at(1)}},{vaultPaused:null}),now);
  expect(result.decision).toBe('act');
  expect(result.conditions.find(c=>c.nodeId==='better')!.detail).toBe('(Compound v3 USDC supply APR − Aave v3 USDC supply APR) 0.8% > 0.5%');
  expect(describeGraph(chase)).toBe('Submit a simulated rebalance of 100% of USDC from Aave v3 to Compound v3 when (Compound v3 USDC supply APR − Aave v3 USDC supply APR) > 0.5%.');
  expect(readsVault(chase)).toBe(false);
  expect(sourceIdentity({type:'lending-rate',protocol:'aave-v3',asset:'USDC'})).toMatchObject({provider:'aave',unit:'%',address:LENDING_REGISTRY['aave-v3'].address});
  // A contract read made 10 minutes ago is stale for an execution decision.
  expect(evaluateGraph(chase,base({[AAVE]:{value:3.1,observedAt:at(600)},[COMP]:{value:3.9,observedAt:at(1)}},{vaultPaused:null}),now).blockedBy?.nodeId).toBe(`guard:source:${AAVE}`);
  expect(()=>g({...chase,action:{type:'rebalance',from:'aave-v3',to:'aave-v3',fraction:1}})).toThrow(/two different protocols/);
});

test('treasury value: vault ETH × ETH/USD gives dollars; units must line up',()=>{
  const runway=g({nodes:[
    {id:'bal',kind:'reading',source:{type:'vault-balance'}},
    {id:'eth',kind:'price',source:{type:'chainlink-feed',symbol:'ETH'}},
    {id:'usd',kind:'math',op:'*',left:'bal',right:'eth'},
    {id:'low',kind:'compare',input:'usd',op:'<',value:5000},
  ],root:'low',action:{type:'pause-vault'}});
  expect(readsVault(runway)).toBe(true);
  expect(collectSources(runway).map(sourceKey)).toEqual(['vault-balance',ETHF]);
  const result=evaluateGraph(runway,base({'vault-balance':{value:1.2,observedAt:at(1)},[ETHF]:{value:2500,observedAt:at(600)}}),now);
  expect(result.conditions.find(c=>c.nodeId==='low')!.detail).toBe('(vault ETH balance × Chainlink ETH/USD (mainnet)) $3,000.00 < $5,000.00');
  expect(result.decision).toBe('act');
  // Multiplying by another asset's price, or mixing a percentage with dollars, is refused at composition.
  expect(()=>g({...runway,nodes:[...runway.nodes.slice(0,1),{id:'eth',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},...runway.nodes.slice(2)]})).toThrow(/own USD price/);
  expect(()=>g({nodes:[
    {id:'aave',kind:'reading',source:{type:'lending-rate',protocol:'aave-v3',asset:'USDC'}},{id:'eth',kind:'price',source:{type:'chainlink-feed',symbol:'ETH'}},
    {id:'x',kind:'math',op:'-',left:'aave',right:'eth'},{id:'c',kind:'compare',input:'x',op:'>',value:0}],root:'c',action:{type:'pause-vault'}})).toThrow(/same unit/);
});

test('depeg spread and time windows evaluate; a price may also be read by a reading node with the same hash',()=>{
  const spread=g({nodes:[
    {id:'usdc',kind:'price',source:{type:'chainlink-feed',symbol:'USDC'}},
    {id:'usdt',kind:'reading',source:{type:'chainlink-feed',symbol:'USDT'}},
    {id:'gap',kind:'math',op:'-',left:'usdc',right:'usdt'},
    {id:'wide',kind:'compare',input:'gap',op:'<',value:-0.005},
    {id:'soon',kind:'time',op:'before',at:'2026-10-10T17:00:00Z'},
    {id:'both',kind:'and',inputs:['wide','soon']},
  ],root:'both',action:{type:'pause-vault'}});
  expect(evaluateGraph(spread,base({[USDC]:{value:0.991,observedAt:at(60)},[USDT]:{value:1.0001,observedAt:at(60)}}),now).decision).toBe('act');
  expect(evaluateGraph(spread,base({[USDC]:{value:0.991,observedAt:at(60)},[USDT]:{value:1.0001,observedAt:at(60)}}),Date.parse('2026-10-11T00:00:00Z')).blockedBy?.role).toBe('root');
  expect(describeGraph(spread)).toBe('Pause spending when ((Chainlink USDC/USD (mainnet) − Chainlink USDT/USD (mainnet)) < -$0.005 and the time is before 2026-10-10 17:00 UTC).');
  const asPrice=g({...spread,nodes:spread.nodes.map(n=>n.id==='usdt'?{id:'usdt',kind:'price',source:{type:'chainlink-feed',symbol:'USDT'}}:n)});
  expect(policyHash(asPrice)).toBe(policyHash(spread));
});

test('validation: duplicate operands, sub-1e-8 thresholds, freshness on a computed value and bad payees are refused',()=>{
  const feed={id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}};
  expect(()=>g({nodes:[feed,{id:'a',kind:'compare',input:'btc',op:'<',value:1},{id:'both',kind:'and',inputs:['a','a']}],root:'both',action:{type:'pause-vault'}})).toThrow(/same input twice/);
  expect(()=>g({nodes:[feed,{id:'a',kind:'compare',input:'btc',op:'<',value:1e-9}],root:'a',action:{type:'pause-vault'}})).toThrow(/8 decimal places/);
  expect(()=>g({nodes:[feed,{id:'eth',kind:'price',source:{type:'chainlink-feed',symbol:'ETH'}},{id:'x',kind:'math',op:'/',left:'btc',right:'eth'},{id:'f',kind:'freshness',input:'x',maxAgeSeconds:60}],root:'f',action:{type:'pause-vault'}})).toThrow(/source reading/);
  const ok=[feed,{id:'a',kind:'compare',input:'btc',op:'<',value:1}];
  expect(()=>g({nodes:ok,root:'a',action:{type:'pay',payee:'0xattacker',amountEth:1}})).toThrow();
  expect(()=>g({nodes:ok,root:'a',action:{type:'pay',payee:'grantee',amountEth:11}})).toThrow();
  expect(()=>g({nodes:ok,root:'a',action:{type:'sweep',fraction:1.5}})).toThrow();
  expect(()=>g({nodes:ok,root:'a',action:{type:'sweep',fraction:0.12345}})).toThrow(/4 decimals/);
  expect(()=>g({nodes:ok,root:'a',action:{type:'evacuate',destination:'polygon',fraction:1}})).toThrow();
  expect(()=>g({nodes:ok,root:'a',action:{type:'sweep',fraction:1,to:'0xattacker'}})).toThrow();
  expect(()=>g({nodes:[{id:'r',kind:'reading',source:{type:'proof-of-reserve',asset:'TUSD'}},{id:'a',kind:'compare',input:'r',op:'<',value:1}],root:'a',action:{type:'pause-vault'}})).toThrow();
  // A price node still reads only prices.
  expect(()=>g({nodes:[{id:'r',kind:'price',source:{type:'vault-balance'}},{id:'a',kind:'compare',input:'r',op:'<',value:1}],root:'a',action:{type:'pause-vault'}})).toThrow();
});

const feedOnly=(action:unknown)=>g({nodes:[{id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},{id:'a',kind:'compare',input:'btc',op:'<',value:90000}],root:'a',action});
const btc={['chainlink-feed:ethereum-mainnet:BTC']:{value:85000,observedAt:at(60)}};

test('action guards: sweep needs funds, pay needs an active funded vault, evacuate needs tokens; a sweep runs on a paused vault',()=>{
  const sweep=feedOnly({type:'sweep',fraction:0.5,pause:false});
  expect(evaluateGraph(sweep,base(btc,{vaultPaused:true}),now).decision).toBe('act');
  const empty=evaluateGraph(sweep,base(btc,{vaultBalanceWei:0n}),now);
  expect(empty.decision).toBe('noop');
  expect(explainNoop(empty)).toBe('Vault holds no ETH to sweep.');
  // The vault computes balance × bps / 10,000 in wei: one wei at 50% moves nothing.
  expect(explainNoop(evaluateGraph(sweep,base(btc,{vaultBalanceWei:1n}),now))).toBe("50% of the vault's 0.000000000000000001 ETH rounds down to nothing.");
  const pay=feedOnly({type:'pay',payee:'grantee',amountEth:0.01});
  expect(evaluateGraph(pay,base(btc),now).decision).toBe('act');
  expect(explainNoop(evaluateGraph(pay,base(btc,{vaultPaused:true}),now))).toBe('Vault spending is paused; no payment is made.');
  expect(explainNoop(evaluateGraph(pay,base(btc,{vaultBalanceWei:ETH/1000n}),now))).toBe('Vault holds 0.001 ETH, less than the 0.01 ETH payment.');
  const evacuate=feedOnly({type:'evacuate',destination:'base-sepolia',fraction:1,pause:false});
  expect(evaluateGraph(evacuate,base(btc),now).decision).toBe('act');
  expect(explainNoop(evaluateGraph(evacuate,base(btc,{vaultTerms:terms({tokenBalance:'0'})}),now))).toBe('Vault holds no CCIP-BnM to evacuate.');
  expect(()=>evaluateGraph(evacuate,base(btc,{vaultTerms:null}),now)).toThrow(/terms/);
  expect(()=>evaluateGraph(sweep,base(btc,{vaultBalanceWei:undefined}),now)).toThrow(/balance read/);
});

test('guards check what the vault checks: payee registry, payment cap and interval, CCIP route, fee allowance and interval',()=>{
  const pay=feedOnly({type:'pay',payee:'grantee',amountEth:0.01});
  const nowSec=Math.floor(now/1000);
  expect(explainNoop(evaluateGraph(pay,base(btc,{vaultTerms:terms({payee:ZERO_ADDRESS})}),now))).toBe('No payee named "grantee" is registered on the vault; the owner registers payees.');
  expect(explainNoop(evaluateGraph(pay,base(btc,{vaultTerms:terms({maxPaymentWei:(ETH/500n).toString()})}),now))).toBe("0.01 ETH is over the vault's 0.002 ETH payment cap.");
  expect(explainNoop(evaluateGraph(pay,base(btc,{vaultTerms:terms({nextPaymentAt:nowSec+60})}),now))).toBe('The vault allows the next payment 60s from now (2026-10-06 04:41 UTC).');
  // Gwei-normalised amounts: the guard compares the exact wei the report carries.
  const tiny=feedOnly({type:'pay',payee:'grantee',amountEth:0.000000001});
  expect(describeAction(tiny.action)).toBe('Pay 0.000000001 ETH to the grantee');
  expect(evaluateGraph(tiny,base(btc,{vaultBalanceWei:1_000_000_000n}),now).decision).toBe('act');
  expect(evaluateGraph(tiny,base(btc,{vaultBalanceWei:999_999_999n}),now).decision).toBe('noop');
  const evacuate=feedOnly({type:'evacuate',destination:'base-sepolia',fraction:1,pause:false});
  expect(explainNoop(evaluateGraph(evacuate,base(btc,{vaultTerms:terms({ccipConfigured:false})}),now))).toBe('This vault has no CCIP route configured.');
  expect(explainNoop(evaluateGraph(evacuate,base(btc,{vaultBalanceWei:ETH/1000n}),now))).toBe('Vault holds 0.001 ETH, less than the 0.01 ETH CCIP fee allowance.');
  expect(explainNoop(evaluateGraph(evacuate,base(btc,{vaultTerms:terms({nextEvacuationAt:nowSec+3600})}),now))).toMatch(/^The vault allows the next evacuation 3600s from now/);
});

test('a protective sweep or evacuation that cannot move anything still pauses an active vault, and only the pause is sent',()=>{
  const sweep=feedOnly({type:'sweep',fraction:0.5});
  const degraded=evaluateGraph(sweep,base(btc,{vaultBalanceWei:0n}),now);
  expect(degraded.decision).toBe('act');
  expect(degraded.effectiveAction).toEqual({type:'pause-vault'});
  expect(degraded.degradedBy!.detail).toBe('Vault holds no ETH to sweep');
  expect(degraded.conditions.at(-1)!.detail).toBe('Vault holds no ETH to sweep, so only the pause is sent');
  // Already paused: nothing to send at all.
  expect(evaluateGraph(sweep,base(btc,{vaultBalanceWei:0n,vaultPaused:true}),now).decision).toBe('noop');
  const evacuate=feedOnly({type:'evacuate',destination:'base-sepolia',fraction:1});
  expect(evaluateGraph(evacuate,base(btc,{vaultTerms:terms({ccipConfigured:false,tokenBalance:'0'})}),now).effectiveAction).toEqual({type:'pause-vault'});
  // The policy's own condition still gates the pause.
  expect(evaluateGraph(sweep,base({['chainlink-feed:ethereum-mainnet:BTC']:{value:95000,observedAt:at(60)}},{vaultBalanceWei:0n}),now).decision).toBe('noop');
  // A movement the vault can make is sent as written.
  expect(evaluateGraph(sweep,base(btc),now).effectiveAction).toBeUndefined();
});

test('units: prices subtract only with the same asset, price ratios do not scale amounts, and constant graphs are refused',()=>{
  const price=(id:string,symbol:string)=>({id,kind:'price',source:{type:'chainlink-feed',symbol}});
  const vault={id:'v',kind:'reading',source:{type:'vault-balance'}};
  // ETH value of the vault minus a BTC price: a USD amount and a price are different units.
  expect(()=>g({nodes:[price('btc','BTC'),price('eth','ETH'),vault,{id:'usd',kind:'math',op:'*',left:'v',right:'eth'},{id:'d',kind:'math',op:'-',left:'usd',right:'btc'},{id:'a',kind:'compare',input:'d',op:'>',value:0}],root:'a',action:{type:'pause-vault'}})).toThrow(/a USD amount and a USD price of BTC/);
  // BTC/USD ÷ ETH/USD is an exchange rate, comparable but not a multiplier for ETH holdings.
  expect(()=>g({nodes:[price('btc','BTC'),price('eth','ETH'),{id:'r',kind:'math',op:'/',left:'btc',right:'eth'},{id:'a',kind:'compare',input:'r',op:'>',value:20}],root:'a',action:{type:'pause-vault'}})).not.toThrow();
  expect(()=>g({nodes:[price('btc','BTC'),price('eth','ETH'),vault,{id:'r',kind:'math',op:'/',left:'btc',right:'eth'},{id:'x',kind:'math',op:'*',left:'r',right:'v'},{id:'a',kind:'compare',input:'x',op:'>',value:1}],root:'a',action:{type:'pause-vault'}})).toThrow(/price ratio between two assets/);
  expect(()=>g({nodes:[price('eth','ETH'),{id:'d',kind:'math',op:'-',left:'eth',right:'eth'},{id:'a',kind:'compare',input:'d',op:'>',value:0}],root:'a',action:{type:'pause-vault'}})).toThrow(/on both sides/);
  expect(()=>g({nodes:[price('eth','ETH'),{id:'a',kind:'compare',input:'eth',op:'>',value:-5}],root:'a',action:{type:'pause-vault'}})).toThrow(/never negative/);
  // A spread can be negative.
  expect(()=>g({nodes:[{id:'cb',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},price('eth','ETH'),{id:'d',kind:'math',op:'-',left:'cb',right:'eth'},{id:'a',kind:'compare',input:'d',op:'<',value:-20}],root:'a',action:{type:'pause-vault'}})).not.toThrow();
  // A cyclic graph cannot be hashed into a stack overflow.
  expect(()=>policyHash({nodes:[{id:'a',kind:'not',input:'b'},{id:'b',kind:'not',input:'a'}],root:'a',action:{type:'pause-vault'}})).toThrow(/cycle/);
});

test('narration keeps decided differences visible, times keep their seconds, and the time a node hashes is the time it decides',()=>{
  const close=g({nodes:[{id:'eth',kind:'price',source:{type:'chainlink-feed',symbol:'ETH'}},{id:'a',kind:'compare',input:'eth',op:'<',value:3000}],root:'a',action:{type:'pause-vault'}});
  const result=evaluateGraph(close,base({[ETHF]:{value:2999.999,observedAt:at(5)}}),now);
  expect(result.conditions.find(c=>c.nodeId==='a')!.detail).toBe('Chainlink ETH/USD (mainnet) $2,999.999 < $3,000');
  const timed=g({nodes:[{id:'t',kind:'time',op:'after',at:'2026-10-06T04:40:00.500Z'}],root:'t',action:{type:'pause-vault'}});
  // Hashed as 04:40:00, so it holds at 04:40:00.000 too.
  expect(evaluateGraph(timed,base({}),now).root).toBe(true);
  expect(describeGraph(g({nodes:[{id:'t',kind:'time',op:'after',at:'2026-10-06T04:40:30Z'}],root:'t',action:{type:'pause-vault'}}))).toBe('Pause spending when the time is after 2026-10-06 04:40:30 UTC.');
  expect(describeGraph(g({nodes:[{id:'t',kind:'time',op:'after',at:'2026-10-06T04:40:00Z'}],root:'t',action:{type:'pause-vault'}}))).toBe('Pause spending when the time is after 2026-10-06 04:40 UTC.');
});

test('every action is part of the policy hash; recorded Sepolia hashes still recompute exactly',async()=>{
  const actions=[{type:'pause-vault'},{type:'sweep',fraction:0.5},{type:'sweep',fraction:0.5,pause:false},{type:'sweep',fraction:0.25},
    {type:'pay',payee:'grantee',amountEth:0.01},{type:'pay',payee:'insured',amountEth:0.01},{type:'pay',payee:'grantee',amountEth:0.02},
    {type:'evacuate',destination:'base-sepolia',fraction:1},{type:'rebalance',from:'aave-v3',to:'compound-v3',fraction:1}];
  expect(new Set(actions.map(a=>policyHash(feedOnly(a)))).size).toBe(actions.length);
  for(const file of ['demo/sepolia-evidence-2026-10-07T07-28-49-635Z.json','demo/sepolia-evidence-2026-10-07T09-04-16-874Z.json']) {
    const proof=await Bun.file(new URL(`../${file}`,import.meta.url)).json();
    for(const name of ['falseCondition','trueCondition']) {
      const spec=specificationSchema.parse(proof.cases[name].spec);
      expect(policyHash(spec.graph,spec.maxAgeSeconds)).toBe(proof.cases[name].evidence.policyHash);
    }
  }
});

test('report v3 carries the action terms; v2 vaults get the pause layout and refuse everything else',()=>{
  const identity={target:'0x0000000000000000000000000000000000001234' as const,chainId:11155111,runId:'run-7',revision:4,policyHash:keccak256(toBytes('p')),decidedAt:1_800_000_000};
  const layout=parseAbiParameters('uint256,address,uint256,bytes32,uint256,bytes32,uint256,uint256,uint256,bytes32,uint256,uint64');
  const decode=(action:VaultAction)=>decodeAbiParameters(layout,encodeActionReport({...identity,...actionTerms(action)}));
  const sweep=decode({type:'sweep',fraction:0.5,pause:true});
  expect([sweep[0],sweep[6],sweep[8],sweep[10]]).toEqual([BigInt(REPORT_VERSION),BigInt(ACTION_SWEEP),BigInt(FLAG_PAUSE),5000n]);
  const pay=decode({type:'pay',payee:'grantee',amountEth:0.01});
  expect([pay[6],pay[9],pay[10]]).toEqual([BigInt(ACTION_PAY),payeeId('grantee'),10_000_000_000_000_000n]);
  const evacuate=decode({type:'evacuate',destination:'base-sepolia',fraction:1,pause:false});
  expect([evacuate[6],evacuate[8],evacuate[10],evacuate[11]]).toEqual([BigInt(ACTION_EVACUATE),0n,10000n,BigInt(CCIP_DESTINATIONS['base-sepolia'].chainSelector)]);
  expect((encodeActionReport({...identity,...actionTerms({type:'pause-vault'})}).length-2)/2).toBe(REPORT_V3_BYTES);
  const v2=encodeReportFor(PAUSE_REPORT_VERSION,{type:'pause-vault'},identity);
  expect((v2.length-2)/2).toBe(256);
  expect(decodeAbiParameters(parseAbiParameters('uint256'),v2.slice(0,66) as `0x${string}`)[0]).toBe(BigInt(PAUSE_REPORT_VERSION));
  expect(()=>encodeReportFor(PAUSE_REPORT_VERSION,{type:'sweep',fraction:1,pause:true},identity)).toThrow(/pause reports only/);
  expect(()=>encodeReportFor(null,{type:'pause-vault'},identity)).toThrow(/redeploy/);
});

test('narration names every action plainly, and says simulated where nothing moves',()=>{
  expect(describeAction({type:'pay',payee:'grantee',amountEth:0.01})).toBe('Pay 0.01 ETH to the grantee');
  expect(describeAction({type:'evacuate',destination:'base-sepolia',fraction:1,pause:true})).toBe("Bridge 100% of the vault's CCIP-BnM to the reserve on Base Sepolia via CCIP and pause spending");
  expect(describeAction({type:'sweep',fraction:0.25,pause:false})).toBe('Sweep 25% of the vault to the reserve');
  expect(describeAction({type:'rebalance',from:'aave-v3',to:'compound-v3',asset:'USDC',fraction:0.5})).toMatch(/^Simulated rebalance/);
  const graph:PolicyGraph=policyGraphSchema.parse({nodes:[{id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},{id:'a',kind:'compare',input:'btc',op:'<',value:90000}],root:'a',action:{type:'pay',payee:'grantee',amountEth:0.01}});
  expect(describeGraph(graph)).toBe('Pay 0.01 ETH to the grantee when Chainlink BTC/USD (mainnet) < $90,000.');
});
