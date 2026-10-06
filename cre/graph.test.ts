import {expect,test} from 'bun:test';
import {validateGraph,evaluateGraph,collectSources,sourceKey,policyGraphSchema,describeGraph,type PolicyGraph,type GraphInputs} from './graph';

const now=Date.parse('2026-10-06T04:40:00Z');
const at=(secondsAgo:number)=>new Date(now-secondsAgo*1000).toISOString();

// "Pause if ETH is under $3000 AND bitcoin is under $90k."
const multiSource:PolicyGraph={
  nodes:[
    {id:'eth',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},
    {id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},
    {id:'ethUnder',kind:'compare',input:'eth',op:'<',value:3000},
    {id:'btcUnder',kind:'compare',input:'btc',op:'<',value:90000},
    {id:'both',kind:'and',inputs:['ethUnder','btcUnder']},
  ],
  root:'both',
  action:{type:'pause-vault'},
};
const inputs=(overrides:Partial<GraphInputs>={}):GraphInputs=>({
  prices:{'exchange-trade:ETH-USD':{usd:2700,observedAt:at(30)},'chainlink-feed:BTC':{usd:85000,observedAt:at(2400)}},
  vaultPaused:false,
  executionPrice:{usd:2700,observedAt:at(30)},
  executionMaxAgeSeconds:120,
  reportedThresholdUsd:9_999_999,
  ...overrides,
});

test('a multi-source AND graph passes only when every branch holds',()=>{
  expect(evaluateGraph(multiSource,inputs(),now).decision).toBe('pause');
  const btcHigh=inputs({prices:{'exchange-trade:ETH-USD':{usd:2700,observedAt:at(30)},'chainlink-feed:BTC':{usd:95000,observedAt:at(2400)}}});
  const result=evaluateGraph(multiSource,btcHigh,now);
  expect(result.decision).toBe('noop');
  expect(result.evidence.find(e=>e.nodeId==='btcUnder')!.passed).toBe(false);
  expect(result.evidence.find(e=>e.nodeId==='ethUnder')!.passed).toBe(true);
});

test('OR fires on either branch and NOT inverts',()=>{
  const either:PolicyGraph={...multiSource,nodes:[...multiSource.nodes.slice(0,4),{id:'both',kind:'or',inputs:['ethUnder','btcUnder']}],root:'both'};
  const ethHigh=inputs({prices:{'exchange-trade:ETH-USD':{usd:3500,observedAt:at(30)},'chainlink-feed:BTC':{usd:85000,observedAt:at(2400)}}});
  expect(evaluateGraph(either,ethHigh,now).decision).toBe('pause');
  const inverted:PolicyGraph={...multiSource,nodes:[...multiSource.nodes,{id:'no',kind:'not',input:'both'}],root:'no'};
  expect(evaluateGraph(inverted,inputs(),now).decision).toBe('noop');
});

test('a Chainlink branch may gate the decision while the report keeps a fresh observation',()=>{
  // The BTC feed is 40 minutes old, far past the receiver's 120s cap, yet it
  // still decides; only the reported exchange trade must be fresh.
  const result=evaluateGraph(multiSource,inputs(),now);
  expect(result.decision).toBe('pause');
  expect(result.evidence.find(e=>e.nodeId==='guard:freshness')!.passed).toBe(true);
});

test('receiver freshness cap and already-paused no-op survive a graph that omits them',()=>{
  const stale=evaluateGraph(multiSource,inputs({executionPrice:{usd:2700,observedAt:at(600)}}),now);
  expect(stale.decision).toBe('noop');
  expect(stale.evidence.find(e=>e.nodeId==='guard:freshness')!.passed).toBe(false);
  const paused=evaluateGraph(multiSource,inputs({vaultPaused:true}),now);
  expect(paused.decision).toBe('noop');
  expect(paused.evidence.find(e=>e.nodeId==='guard:vault-state')!.passed).toBe(false);
  // A future-dated observation is not fresh either.
  expect(evaluateGraph(multiSource,inputs({executionPrice:{usd:2700,observedAt:at(-60)}}),now).evidence.find(e=>e.nodeId==='guard:freshness')!.passed).toBe(false);
});

test('validation rejects cycles, dangling edges, duplicate ids and mistyped operands',()=>{
  expect(()=>validateGraph({...multiSource,nodes:[...multiSource.nodes,{id:'loop',kind:'not',input:'loop2'},{id:'loop2',kind:'not',input:'loop'}],root:'loop'})).toThrow(/cycle/i);
  expect(()=>validateGraph({...multiSource,nodes:[{id:'a',kind:'compare',input:'missing',op:'<',value:1}],root:'a'})).toThrow(/unknown node/i);
  expect(()=>validateGraph({...multiSource,nodes:[...multiSource.nodes,{id:'eth',kind:'vault-paused',equals:false}]})).toThrow(/duplicate/i);
  // AND over a price reading, and compare over a condition, are both nonsense.
  expect(()=>validateGraph({...multiSource,nodes:[...multiSource.nodes,{id:'bad',kind:'and',inputs:['eth','ethUnder']}],root:'bad'})).toThrow(/needs conditions/i);
  expect(()=>validateGraph({...multiSource,nodes:[...multiSource.nodes,{id:'bad',kind:'compare',input:'ethUnder',op:'<',value:1}],root:'bad'})).toThrow(/needs a price/i);
  expect(()=>validateGraph({...multiSource,root:'eth'})).toThrow(/must be a condition/i);
  expect(()=>validateGraph({...multiSource,root:'nowhere'})).toThrow(/not a node/i);
});

test('composition cannot smuggle in an arbitrary source or a second action',()=>{
  expect(()=>policyGraphSchema.parse({...multiSource,nodes:[{id:'x',kind:'price',source:{type:'http',url:'https://evil.test'}}]})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,nodes:[{id:'x',kind:'price',source:{type:'chainlink-feed',symbol:'DOGE'}}]})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,action:{type:'drain-vault'}})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,action:{type:'pause-vault',to:'0xattacker'}})).toThrow();
  expect(()=>policyGraphSchema.parse({...multiSource,nodes:[]})).toThrow();
});

test('sources are collected once each for the fetch plan',()=>{
  const repeated:PolicyGraph={...multiSource,nodes:[...multiSource.nodes,{id:'eth2',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},{id:'alsoUnder',kind:'compare',input:'eth2',op:'<',value:4000}]};
  const sources=collectSources(repeated);
  expect(sources).toHaveLength(2);
  expect(sources.map(sourceKey).sort()).toEqual(['chainlink-feed:BTC','exchange-trade:ETH-USD']);
});

test('a missing resolved reading blocks rather than evaluating on a default',()=>{
  expect(()=>evaluateGraph(multiSource,inputs({prices:{'exchange-trade:ETH-USD':{usd:2700,observedAt:at(30)}}}),now)).toThrow(/Missing resolved reading/);
});

test('the legacy three-scalar policy is expressible as a graph',()=>{
  const legacy:PolicyGraph={
    nodes:[
      {id:'eth',kind:'price',source:{type:'exchange-trade',pair:'ETH-USD'}},
      {id:'under',kind:'compare',input:'eth',op:'<',value:3000},
      {id:'recent',kind:'freshness',input:'eth',maxAgeSeconds:120},
      {id:'active',kind:'vault-paused',equals:false},
      {id:'all',kind:'and',inputs:['under','recent','active']},
    ],
    root:'all',action:{type:'pause-vault'},
  };
  expect(validateGraph(legacy).graph.root).toBe('all');
  expect(evaluateGraph(legacy,inputs(),now).decision).toBe('pause');
  expect(evaluateGraph(legacy,inputs({vaultPaused:true}),now).decision).toBe('noop');
});

const sellGraph:PolicyGraph={
  nodes:[
    {id:'btc',kind:'price',source:{type:'chainlink-feed',symbol:'BTC'}},
    {id:'drop',kind:'compare',input:'btc',op:'<',value:90000},
  ],
  root:'drop',
  action:{type:'sell',symbol:'BTC',amount:0.5,venue:'mock-venue'},
};

test('a sell action is accepted, described as simulated, and skips the receiver rule',()=>{
  const {graph}=validateGraph(sellGraph);
  expect(graph.action.type).toBe('sell');
  expect(describeGraph(graph)).toBe('Submit a simulated sell of 0.5 BTC when Chainlink BTC/USD < $90,000.');
  // The receiver threshold rule governs report delivery, which a sell never does.
  const result=evaluateGraph(graph,inputs({reportedThresholdUsd:1}),now);
  expect(result.evidence.some(e=>e.nodeId==='guard:receiver-threshold')).toBe(false);
  expect(result.decision).toBe('pause');
  // The same graph ending in a pause would be blocked by that rule.
  const pausing={...graph,action:{type:'pause-vault'}} as PolicyGraph;
  expect(evaluateGraph(pausing,inputs({reportedThresholdUsd:1}),now).decision).toBe('noop');
});

test('a sell cannot name an unlisted asset, an arbitrary venue or a negative size',()=>{
  expect(()=>policyGraphSchema.parse({...sellGraph,action:{type:'sell',symbol:'DOGE',amount:1,venue:'mock-venue'}})).toThrow();
  expect(()=>policyGraphSchema.parse({...sellGraph,action:{type:'sell',symbol:'BTC',amount:1,venue:'binance'}})).toThrow();
  expect(()=>policyGraphSchema.parse({...sellGraph,action:{type:'sell',symbol:'BTC',amount:-1,venue:'mock-venue'}})).toThrow();
  expect(()=>policyGraphSchema.parse({...sellGraph,action:{type:'sell',symbol:'BTC',amount:1,venue:'mock-venue',to:'0xattacker'}})).toThrow();
});
