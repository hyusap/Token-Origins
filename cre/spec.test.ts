import {expect,test} from 'bun:test';
import {specificationSchema,parsePrice} from './spec';
import {policyHash,legacyGraph} from './graph';

const graph=legacyGraph(3000);
const spec={version:2,runId:'immutable-run',revision:1,graph,policyHash:policyHash(graph),maxAgeSeconds:60,broadcast:true};

test('a frozen specification carries its graph and matching policy hash',()=>{
  expect(specificationSchema.parse(spec).policyHash).toBe(policyHash(graph));
});

test('J8: every execution boundary re-validates the graph, not just its shape',()=>{
  const cyclic={nodes:[{id:'a',kind:'not',input:'b'},{id:'b',kind:'not',input:'a'}],root:'a',action:{type:'pause-vault'}};
  expect(()=>specificationSchema.parse({...spec,graph:cyclic})).toThrow(/cycle/);
  const orphan={...graph,nodes:[...graph.nodes,{id:'stray',kind:'vault-paused',equals:true}]};
  expect(()=>specificationSchema.parse({...spec,graph:orphan,policyHash:spec.policyHash})).toThrow(/not connected/);
});

test('a policy hash that does not match the graph is refused',()=>{
  expect(()=>specificationSchema.parse({...spec,graph:legacyGraph(2000)})).toThrow(/Policy hash does not match/);
});

test('strict specification bounds cannot add arbitrary sources, targets or relax freshness',()=>{
  expect(()=>specificationSchema.parse({...spec,priceUrl:'https://evil.test'})).toThrow();
  expect(()=>specificationSchema.parse({...spec,maxAgeSeconds:121})).toThrow();
  expect(()=>specificationSchema.parse({...spec,runId:'../escape'})).toThrow();
  expect(()=>specificationSchema.parse({...spec,version:1})).toThrow();
  const {graph:_omitted,...withoutGraph}=spec;
  expect(()=>specificationSchema.parse(withoutGraph)).toThrow();
});

test('invalid source data blocks rather than fabricating an observation',()=>{
  expect(()=>parsePrice({price:'NaN',time:'2026-10-06T04:39:30Z'})).toThrow();
  expect(()=>parsePrice({price:'2700'})).toThrow();
  const parsed=parsePrice({price:'2700.00',time:'2026-10-06T04:39:30.123456789Z'});
  expect(parsed.usd).toBe(2700);
  expect(parsed.raw).toBe('2700.00');
});
