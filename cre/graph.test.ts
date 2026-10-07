import {expect,test} from 'bun:test';
import {validateGraph,evaluateGraph,collectSources,sourceKey,policyGraphSchema,describeGraph,policyHash,explainNoop,isLegacyShape,legacyGraph,encodePauseReport,formatUsd,MAX_FEED_AGE_SECONDS,sourceIdentity,type PolicyGraph,type GraphInputs} from './graph';
import {decodeAbiParameters,parseAbiParameters} from 'viem';

const now=Date.parse('2026-10-06T04:40:00Z');
const at=(secondsAgo:number)=>new Date(now-secondsAgo*1000).toISOString();
const ETH='exchange-trade:ETH-USD', BTC='chainlink-feed:ethereum-mainnet:BTC';

// "Pause if ETH is under $3000 AND bitcoin is under $90k."
const multiSource=policyGraphSchema.parse({
  nodes:[
    {id:'eth',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},
    {id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},
    {id:'ethUnder',kind:'compare',input:'eth',op:'<',value:3000},
    {id:'btcUnder',kind:'compare',input:'btc',op:'<',value:90000},
    {id:'both',kind:'and',inputs:['ethUnder','btcUnder']},
  ],
  root:'both',
  action:{type:'pause-vault'},
});
const inputs=(overrides:Partial<GraphInputs>={}):GraphInputs=>({
  readings:{[ETH]:{usd:2700,observedAt:at(30)},[BTC]:{usd:85000,observedAt:at(2400)}},
  vaultPaused:false,
  exchangeMaxAgeSeconds:60,
  ...overrides,
});

test('feed sources default to mainnet and carry their network in the key',()=>{
  const btc=multiSource.nodes.find(n=>n.id==='btc')!;
  expect(btc.kind==='price'&&btc.source.type==='chainlink-feed'&&btc.source.network).toBe('ethereum-mainnet');
  expect(collectSources(multiSource).map(sourceKey)).toEqual([ETH,BTC]);
});

test('a multi-source AND graph passes only when every branch holds',()=>{
  expect(evaluateGraph(multiSource,inputs(),now).decision).toBe('act');
  const btcHigh=evaluateGraph(multiSource,inputs({readings:{[ETH]:{usd:2700,observedAt:at(30)},[BTC]:{usd:95000,observedAt:at(2400)}}}),now);
  expect(btcHigh.decision).toBe('noop');
  expect(btcHigh.blockedBy?.role).toBe('root');
  expect(explainNoop(btcHigh)).toBe('The policy condition was not met.');
});

test('J1: reordering declarations or OR operands keeps the policy hash and the decision',()=>{
  const nodes=[
    {id:'eth',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},
    {id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},
    {id:'a',kind:'compare',input:'eth',op:'<',value:3000},
    {id:'b',kind:'compare',input:'btc',op:'<',value:90000},
    {id:'either',kind:'or',inputs:['a','b']},
  ];
  const original=policyGraphSchema.parse({nodes,root:'either',action:{type:'pause-vault'}});
  const reordered=policyGraphSchema.parse({nodes:[{...nodes[4],inputs:['b','a']},nodes[3],nodes[2],nodes[1],nodes[0]],root:'either',action:{type:'pause-vault'}});
  const renamed=policyGraphSchema.parse({nodes:[
    {id:'ether',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},
    {id:'bitcoin',kind:'price',source:{type:'chainlink-feed',symbol:'BTC',network:'ethereum-mainnet'}},
    {id:'x',kind:'compare',input:'ether',op:'<',value:3000},
    {id:'y',kind:'compare',input:'bitcoin',op:'<',value:90000},
    {id:'root',kind:'or',inputs:['y','x']},
  ],root:'root',action:{type:'pause-vault'}});
  expect(policyHash(reordered)).toBe(policyHash(original));
  expect(policyHash(renamed)).toBe(policyHash(original));
  // ETH above $3000 but BTC under $90k: the OR holds regardless of order.
  const mixed=inputs({readings:{[ETH]:{usd:3500,observedAt:at(5)},[BTC]:{usd:85000,observedAt:at(60)}}});
  expect(evaluateGraph(original,mixed,now).decision).toBe('act');
  expect(evaluateGraph(reordered,mixed,now).decision).toBe('act');
});

test('the policy hash changes with anything that changes meaning',()=>{
  const base=policyHash(multiSource);
  const variant=(patch:(g:PolicyGraph)=>void)=>{const g=structuredClone(multiSource);patch(g);return policyHash(g);};
  expect(variant(g=>{(g.nodes[2] as any).value=3001;})).not.toBe(base);
  expect(variant(g=>{(g.nodes[2] as any).op='<=';})).not.toBe(base);
  expect(variant(g=>{(g.nodes[1] as any).source.network='ethereum-sepolia';})).not.toBe(base);
  expect(variant(g=>{(g.nodes[4] as any).kind='or';})).not.toBe(base);
  expect(variant(g=>{(g.nodes[0] as any).source.pair='SOL-USD';})).not.toBe(base);
});

test('J4: nested A AND (B OR NOT C) evaluates, narrates and validates as one structure',()=>{
  const nested=validateGraph({
    nodes:[
      {id:'eth',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},
      {id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},
      {id:'A',kind:'compare',input:'eth',op:'<',value:3000},
      {id:'B',kind:'compare',input:'btc',op:'<',value:80000},
      {id:'C',kind:'vault-paused',equals:true},
      {id:'notC',kind:'not',input:'C'},
      {id:'BorNotC',kind:'or',inputs:['B','notC']},
      {id:'root',kind:'and',inputs:['A','BorNotC']},
    ],
    root:'root',action:{type:'pause-vault'},
  }).graph;
  expect(describeGraph(nested)).toBe('Pause spending when (Coinbase ETH-USD trade < $3,000 and (Chainlink BTC/USD (mainnet) < $80,000 or not (vault is paused))).');
  // B is false (BTC $85k) but NOT C holds: a false intermediate inside a passing OR.
  const result=evaluateGraph(nested,inputs(),now);
  expect(result.decision).toBe('act');
  expect(result.conditions.find(c=>c.nodeId==='B')!.passed).toBe(false);
  expect(result.conditions.find(c=>c.nodeId==='BorNotC')!.passed).toBe(true);
  expect(result.conditions.find(c=>c.nodeId==='guard:root')!.role).toBe('root');
});

test('mandatory guards: every source within its own age limit, and no second pause',()=>{
  const staleTrade=evaluateGraph(multiSource,inputs({readings:{[ETH]:{usd:2700,observedAt:at(61)},[BTC]:{usd:85000,observedAt:at(60)}}}),now);
  expect(staleTrade.decision).toBe('noop');
  expect(staleTrade.blockedBy?.nodeId).toBe(`guard:source:${ETH}`);
  // A feed 40 minutes old is normal for a heartbeat feed; one older than the heartbeat window is not.
  expect(evaluateGraph(multiSource,inputs({readings:{[ETH]:{usd:2700,observedAt:at(5)},[BTC]:{usd:85000,observedAt:at(MAX_FEED_AGE_SECONDS+1)}}}),now).decision).toBe('noop');
  const future=evaluateGraph(multiSource,inputs({readings:{[ETH]:{usd:2700,observedAt:at(-120)},[BTC]:{usd:85000,observedAt:at(60)}}}),now);
  expect(future.blockedBy?.detail).toContain('in the future');
  // The run's exchange cap can be tightened but never relaxed past 120 seconds.
  expect(evaluateGraph(multiSource,inputs({exchangeMaxAgeSeconds:9999,readings:{[ETH]:{usd:2700,observedAt:at(121)},[BTC]:{usd:85000,observedAt:at(60)}}}),now).decision).toBe('noop');
  const paused=evaluateGraph(multiSource,inputs({vaultPaused:true}),now);
  expect(paused.root).toBe(true);
  expect(paused.decision).toBe('noop');
  expect(explainNoop(paused)).toContain('already paused');
});

test('USD comparisons keep 1e-8 precision for stablecoin thresholds',()=>{
  const peg=validateGraph({nodes:[
    {id:'usdc',kind:'price',source:{type:'chainlink-feed',symbol:'USDC'}},
    {id:'depeg',kind:'compare',input:'usdc',op:'<',value:0.9995},
  ],root:'depeg',action:{type:'pause-vault'}}).graph;
  const key='chainlink-feed:ethereum-mainnet:USDC';
  const run=(usd:number)=>evaluateGraph(peg,{readings:{[key]:{usd,observedAt:at(60)}},vaultPaused:false,exchangeMaxAgeSeconds:60},now);
  // Cents rounding would call 0.99949 equal to 0.9995 and miss the depeg.
  expect(run(0.99949).decision).toBe('act');
  expect(run(0.9995).decision).toBe('noop');
  expect(run(0.99951).decision).toBe('noop');
  expect(formatUsd(0.99949)).toBe('$0.99949');
  expect(formatUsd(2712.3456)).toBe('$2,712.35');
});

test('validation rejects cycles, dangling edges, duplicate ids, mistyped operands and orphans',()=>{
  expect(()=>validateGraph({...multiSource,nodes:[...multiSource.nodes,{id:'loop',kind:'not',input:'loop2'},{id:'loop2',kind:'not',input:'loop'}],root:'loop'})).toThrow(/cycle/i);
  expect(()=>validateGraph({...multiSource,nodes:[{id:'a',kind:'compare',input:'missing',op:'<',value:1}],root:'a'})).toThrow(/unknown node/i);
  expect(()=>validateGraph({...multiSource,nodes:[...multiSource.nodes,{id:'eth',kind:'vault-paused',equals:false}]})).toThrow(/duplicate/i);
  expect(()=>validateGraph({...multiSource,nodes:[...multiSource.nodes,{id:'bad',kind:'and',inputs:['eth','ethUnder']}],root:'bad'})).toThrow(/needs conditions/i);
  expect(()=>validateGraph({...multiSource,nodes:[...multiSource.nodes,{id:'bad',kind:'compare',input:'ethUnder',op:'<',value:1}],root:'bad'})).toThrow(/needs a price/i);
  expect(()=>validateGraph({...multiSource,root:'eth'})).toThrow(/must be a condition/i);
  expect(()=>validateGraph({...multiSource,root:'nowhere'})).toThrow(/not a node/i);
  // A branch the root never reaches would be fetched and displayed without deciding anything.
  expect(()=>validateGraph({...multiSource,root:'ethUnder'})).toThrow(/not connected to root/);
});

test('validation binds feeds to their network registry and bounds the fetch plan',()=>{
  expect(()=>validateGraph({nodes:[{id:'s',kind:'price',source:{type:'chainlink-feed',symbol:'SOL',network:'ethereum-sepolia'}},{id:'c',kind:'compare',input:'s',op:'<',value:1}],root:'c',action:{type:'pause-vault'}})).toThrow(/No Chainlink SOL\/USD feed is configured on Ethereum Sepolia/);
  const symbols=['BTC','LINK','SOL','BNB','AVAX','AAVE'];
  const wide={nodes:[
    ...symbols.map(s=>({id:`p${s}`,kind:'price',source:{type:'chainlink-feed',symbol:s}})),
    ...symbols.map(s=>({id:`c${s}`,kind:'compare',input:`p${s}`,op:'<',value:1})),
    {id:'any1',kind:'or',inputs:symbols.slice(0,3).map(s=>`c${s}`)},
    {id:'any2',kind:'or',inputs:symbols.slice(3).map(s=>`c${s}`)},
    {id:'any',kind:'or',inputs:['any1','any2']},
  ],root:'any',action:{type:'pause-vault'}};
  expect(()=>validateGraph(wide)).toThrow(/at most 5 distinct sources/);
});

test('composition cannot smuggle in an arbitrary source, network or a second action',()=>{
  expect(()=>policyGraphSchema.parse({...multiSource,nodes:[{id:'x',kind:'price',source:{type:'http',url:'https://evil.test'}}]})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,nodes:[{id:'x',kind:'price',source:{type:'chainlink-feed',symbol:'DOGE'}}]})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,nodes:[{id:'x',kind:'price',source:{type:'chainlink-feed',symbol:'BTC',network:'polygon'}}]})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,nodes:[{id:'x',kind:'price',source:{type:'chainlink-feed',symbol:'BTC',address:'0xattacker'}}]})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,action:{type:'drain-vault'}})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,action:{type:'pause-vault',to:'0xattacker'}})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,nodes:[]})).toThrow();
});

test('sources are collected once each for the fetch plan',()=>{
  const repeated=policyGraphSchema.parse({...multiSource,nodes:[...multiSource.nodes.slice(0,4),
    {id:'eth2',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},{id:'alsoUnder',kind:'compare',input:'eth2',op:'<',value:4000},
    {id:'both',kind:'and',inputs:['ethUnder','btcUnder','alsoUnder']}]});
  expect(collectSources(repeated).map(sourceKey)).toEqual([ETH,BTC]);
});

test('a missing reading throws instead of evaluating as false (which NOT would invert)',()=>{
  expect(()=>evaluateGraph(multiSource,inputs({readings:{[ETH]:{usd:2700,observedAt:at(30)}}}),now)).toThrow(/Missing resolved reading/);
  const negated=validateGraph({nodes:[{id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},{id:'hi',kind:'compare',input:'btc',op:'>',value:1},{id:'n',kind:'not',input:'hi'}],root:'n',action:{type:'pause-vault'}}).graph;
  expect(()=>evaluateGraph(negated,inputs({readings:{}}),now)).toThrow(/Missing resolved reading/);
});

test('the legacy scalar policy round-trips as a graph',()=>{
  const legacy=legacyGraph(3000);
  expect(isLegacyShape(legacy)).toBe(true);
  expect(isLegacyShape(multiSource)).toBe(false);
  expect(isLegacyShape(undefined)).toBe(false);
  expect(evaluateGraph(legacy,inputs(),now).decision).toBe('act');
  expect(evaluateGraph(legacy,inputs({vaultPaused:true}),now).decision).toBe('noop');
});

test('policies reject simulated trading and unsupported actions',()=>{
  for(const action of [
    {type:'sell',symbol:'BTC',amount:0.5,venue:'mock-venue'},
    {type:'sell',symbol:'BTC',amount:0.5},
    {type:'copy-trade',wallet:'0x123'},
  ]) expect(()=>policyGraphSchema.parse({...multiSource,action})).toThrow();
});

test('a vault pause requires a real vault read',()=>{
  expect(()=>evaluateGraph(multiSource,inputs({vaultPaused:null}),now)).toThrow(/vault read/);
});

test('report v2 binds target, chain, run, revision, policy and action',()=>{
  const hash=policyHash(multiSource);
  const encoded=encodePauseReport({target:'0x0000000000000000000000000000000000001234',chainId:11155111,runId:'run-1',revision:3,policyHash:hash,decidedAt:1_800_000_000});
  const [version,target,chainId,,revision,policy,action,decidedAt]=decodeAbiParameters(parseAbiParameters('uint256,address,uint256,bytes32,uint256,bytes32,uint256,uint256'),encoded);
  expect([version,target,chainId,revision,policy,action,decidedAt]).toEqual([2n,'0x0000000000000000000000000000000000001234',11155111n,3n,hash,1n,1_800_000_000n]);
  expect((encoded.length-2)/2).toBe(256);
});


test('exact exchange markets carry their own source identity and policy hash',()=>{
  const sol=validateGraph(legacyGraph(200,'SOL-USD')).graph;
  expect(sourceIdentity(collectSources(sol)[0]!).url).toBe('https://api.exchange.coinbase.com/products/SOL-USD/ticker');
  expect(policyHash(sol)).not.toBe(policyHash(legacyGraph(200)));
  expect(describeGraph(sol)).toBe('Pause spending when Coinbase SOL-USD trade < $200.');
  expect(evaluateGraph(sol,inputs({readings:{'exchange-trade:SOL-USD':{usd:150,observedAt:at(5)}}}),now).decision).toBe('act');
});

test('schema and policy hashing refuse malformed semantics without recursion',()=>{
  const cycle={nodes:[{id:'a',kind:'not',input:'a'}],root:'a',action:{type:'pause-vault'}};
  expect(()=>policyGraphSchema.parse(cycle)).toThrow(/cycle/);
  expect(()=>policyHash(cycle as never)).toThrow(/cycle/);
  expect(()=>policyGraphSchema.parse({...multiSource,root:'ethUnder'})).toThrow(/not connected/);
});

test('shared dependencies stay readable in each narrated branch',()=>{
  const shared=validateGraph({nodes:[
    {id:'eth',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},
    {id:'under',kind:'compare',input:'eth',op:'<',value:3000},
    {id:'recent',kind:'freshness',input:'eth',maxAgeSeconds:60},
    {id:'all',kind:'and',inputs:['under','recent']},
  ],root:'all',action:{type:'pause-vault'}}).graph;
  expect(describeGraph(shared)).toBe('Pause spending when (Coinbase ETH-USD trade < $3,000 and Coinbase ETH-USD trade observed within 60s).');
});

test('branch reuse cannot create unbounded policy descriptions',()=>{
  const graph:PolicyGraph={nodes:[{id:'base',kind:'vault-paused',equals:false}],root:'base',action:{type:'pause-vault'}};
  for(let index=1;index<40;index++) {
    const previous=graph.root;
    graph.root='branch'+index;
    graph.nodes.push({id:graph.root,kind:'or',inputs:Array(8).fill(previous)});
  }
  validateGraph(graph);
  expect(describeGraph(graph).length).toBeLessThan(4100);
});

test('state-only policies need no fabricated market quote',()=>{
  const graph=validateGraph({nodes:[{id:'active',kind:'vault-paused',equals:false}],root:'active',action:{type:'pause-vault'}}).graph;
  const result=evaluateGraph(graph,inputs({readings:{}}),now);
  expect(result.decision).toBe('act');
  expect(result.conditions.some(c=>c.kind==='source-freshness')).toBe(false);
  expect(evaluateGraph(graph,inputs({readings:{},vaultPaused:true}),now).decision).toBe('noop');
});
