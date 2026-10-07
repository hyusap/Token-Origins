import {test,expect,afterEach} from 'bun:test';
import {Engine} from '../server/engine';
import {StateStore} from '../server/store';
import {legacyGraph,policyHash,sourceIdentity} from '../cre/graph';
import type {ExecutionSpecification} from '../cre/spec';
import type {ExecutionEvidence} from '../cre/runner';
import type {EngineSources} from '../server/engine';
const address='0x1111111111111111111111111111111111111111' as const;
const engines:Engine[]=[];
afterEach(async()=>{for(const e of engines.splice(0)){e.monitors.close();e.tradeTools.close();await Promise.resolve();if(e.store.db)try{e.store.db.close();}catch{}}});
function adapters(work?:(spec:ExecutionSpecification)=>Promise<void>) {
  const captured:ExecutionSpecification[]=[];let broadcasts=0;
  const sources:Partial<EngineSources>={
    fetchPrice:async()=>({id:'price:eth-usd',kind:'price',label:'ETH',data:{price:2500,productId:'ETH-USD'},visible:true,pinned:false,provenance:{kind:'fixture',source:'Explicit unit adapter',label:'Test only',observedAt:new Date().toISOString(),fetchedAt:new Date().toISOString()}}),
    fetchVault:async()=>({id:'vault:grant',kind:'vault',label:'Test receiver',data:{address,chainId:11155111,paused:false,balanceWei:'1',reportVersion:2},visible:true,pinned:false,provenance:{kind:'chain',source:'Explicit unit adapter',label:'Test only',observedAt:new Date().toISOString(),fetchedAt:new Date().toISOString()}}),
    loadDeployment:async()=>({address,chainId:11155111,forwarder:'0x2222222222222222222222222222222222222222',rpcUrl:'https://example.invalid'}),
    executeRun:async(spec)=>{
      captured.push(structuredClone(spec));if(spec.broadcast!==false)broadcasts++;await work?.(spec);
      const evidence:ExecutionEvidence={runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash,mode:'cre-local-simulation',action:'pause-vault',root:true,decision:'act',dryRun:spec.broadcast===false,decidedAt:new Date().toISOString(),vault:{address,chainId:11155111,paused:false,balanceWei:'1',reportVersion:2},observations:[{...sourceIdentity({type:'exchange-trade',pair:'ETH-USD'}),usd:2500,raw:'2500',observedAt:new Date().toISOString(),fetchedAt:new Date().toISOString()}],conditions:[{nodeId:'guard:root',kind:'composed-policy',role:'root',passed:true,detail:'Root passed'}],logs:[]};return evidence;
    },
  };
  return {sources,captured,get broadcasts(){return broadcasts;}};
}
async function create(f:ReturnType<typeof adapters>) {
  const e=new Engine(new StateStore(':memory:'),f.sources);engines.push(e);
  expect((await e.invoke('discover_objects',{operationId:'discover'})).ok).toBe(true);
  expect((await e.invoke('patch_workflow',{expectedRevision:0,patch:{threshold:3000},operationId:'compose'})).ok).toBe(true);return e;
}
async function settled(e:Engine){for(let i=0;i<100&&!['no-op','failed','confirmed'].includes(e.state.runs[0]?.status??'');i++)await Bun.sleep(5);}
test('evaluation-only freezes broadcast false even when the CRE predicate passes, and has no transaction evidence',async()=>{
  const f=adapters(),e=await create(f);const result=await e.invoke('run_workflow',{expectedRevision:1,evaluationOnly:true,operationId:'evaluate'});expect(result.ok).toBe(true);await settled(e);
  const run=e.state.runs[0]!;expect(run.evaluationOnly).toBe(true);expect(e.specFor(run).broadcast).toBe(false);expect(f.captured[0]?.broadcast).toBe(false);expect(f.broadcasts).toBe(0);expect(run.status).toBe('no-op');expect(run.decisions[0]?.passed).toBe(true);expect(run.executionMode).toContain('evaluation only');expect(run.executionMode).not.toContain('Sepolia broadcast');expect(run.noopReason).toContain('policy passed');expect(run.evidence).toMatchObject({evaluationOnly:true});expect(run.evidence?.transactionHash).toBeUndefined();
});
test('operation retry preserves evaluation intent and conflicting reuse cannot enable broadcasting',async()=>{
  const f=adapters(),e=await create(f);const args={expectedRevision:1,evaluationOnly:true,operationId:'retry'};const first=await e.invoke('run_workflow',args);await settled(e);const again=await e.invoke('run_workflow',args);expect(again.duplicate).toBe(true);expect(again.runId).toBe(first.runId);expect((await e.invoke('run_workflow',{...args,evaluationOnly:false})).code).toBe('OPERATION_CONFLICT');expect(f.captured).toHaveLength(1);expect(f.broadcasts).toBe(0);
});
test('an in-flight evaluation cannot be joined by a broadcast-enabled request',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);const f=adapters(async()=>gate),e=await create(f);
  const first=await e.invoke('run_workflow',{expectedRevision:1,evaluationOnly:true,operationId:'eval'});const joined=await e.invoke('run_workflow',{expectedRevision:1,evaluationOnly:true,operationId:'same-mode'});expect(joined.runId).toBe(first.runId);
  const conflict=await e.invoke('run_workflow',{expectedRevision:1,evaluationOnly:false,operationId:'write-mode'});expect(conflict.code).toBe('EXECUTION_MODE_CONFLICT');expect(e.state.runs).toHaveLength(1);release();await settled(e);expect(f.broadcasts).toBe(0);
});
test('a restarted evaluation has no uncertain write barrier and is never reconciled as a submission',async()=>{
  const f=adapters(),store=new StateStore(':memory:');const e=new Engine(store,f.sources);engines.push(e);const graph=legacyGraph(3000);const snapshot={revision:1,threshold:3000,maxAgeSeconds:60,skipPaused:false,graph,policyHash:policyHash(graph),reason:'Test',createdAt:new Date().toISOString()};
  e.state.runs=[{id:'interrupted-eval',revision:1,snapshot,policyHash:snapshot.policyHash,action:'pause-vault',evaluationOnly:true,status:'reporting',startedAt:new Date().toISOString(),executionMode:'CRE evaluation',target:{kind:'evm-vault',chainId:11155111,address,executor:'cre'},decisions:[],logs:[]}];store.save(e.state);e.monitors.close();e.tradeTools.close();
  const restarted=new Engine(store,f.sources);engines.push(restarted);const run=restarted.state.runs[0]!;expect(run.status).toBe('failed');expect(run.uncertain).toBe(false);expect(run.submissionPossible).toBe(false);expect(run.error).toContain('broadcast was disabled');expect(f.captured).toHaveLength(0);
});
test('a lost response after submitted then fetching progress remains uncertain and cannot resubmit',async()=>{
  const f=adapters();const hash=`0x${'a'.repeat(64)}`;let writes=0,recoveryHash:string|undefined;
  f.sources.executeRun=async(spec,progress)=>{writes++;progress?.(`ORIGINS_SUBMITTED ${JSON.stringify({hash,runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash})}`);progress?.('ORIGINS_SOURCE live price fetched');throw new Error('Response lost after source replay');};
  f.sources.findSubmittedPause=async(_id,_deployment,_expected,submittedHash)=>{recoveryHash=submittedHash;return {landed:false,paused:false};};
  const e=await create(f);const stages:string[]=[];e.listeners.add(state=>stages.push(state.runs[0]?.status??'none'));
  await e.invoke('run_workflow',{expectedRevision:1,operationId:'submit'});await settled(e);await e.queue;
  const run=e.state.runs[0]!;expect(stages).toContain('reporting');expect(run.status).toBe('failed');expect(run.uncertain).toBe(true);expect(run.submissionPossible).toBe(true);expect(run.evidence?.transactionHash).toBe(hash);expect(recoveryHash).toBe(hash);
  expect((await e.invoke('run_workflow',{expectedRevision:1,operationId:'new-submit'})).ok).toBe(false);expect(writes).toBe(1);
});
test('restart recovers a terminal failed pending journal with its exact hash and never reruns execution',async()=>{
  const f=adapters(),store=new StateStore(':memory:');const original=new Engine(store,f.sources);const graph=legacyGraph(3000),hash=`0x${'b'.repeat(64)}`,pHash=policyHash(graph);const snapshot={revision:1,threshold:3000,maxAgeSeconds:60,skipPaused:false,graph,policyHash:pHash,reason:'Test',createdAt:new Date().toISOString()};
  original.state.runs=[{id:'failed-after-submission',revision:1,snapshot,policyHash:pHash,action:'pause-vault',status:'failed',submissionPossible:true,startedAt:new Date().toISOString(),executionMode:'Preparing execution',target:{kind:'evm-vault',chainId:11155111,address,executor:'cre'},decisions:[],logs:[],evidence:{transactionHash:hash,receiptStatus:'pending'},error:'Truncated progress JSON'}];store.save(original.state);original.monitors.close();original.tradeTools.close();
  const reads:{runId:string;hash:string|undefined;expected:unknown}[]=[];
  f.sources.findSubmittedPause=async(runId,_deployment,expected,submittedHash)=>{reads.push({runId,hash:submittedHash,expected});return {landed:true,paused:true,transactionHash:hash,blockNumber:123};};
  const captions=structuredClone(original.state.conversation);
  const restarted=new Engine(store,f.sources);engines.push(restarted);await restarted.queue;const recovered=restarted.state.runs[0]!;
  expect(reads).toEqual([{runId:'failed-after-submission',hash,expected:{revision:1,policyHash:pHash}}]);expect(recovered.status).toBe('confirmed');expect(recovered.uncertain).toBe(false);expect(recovered.evidence).toMatchObject({transactionHash:hash,receiptStatus:'success',blockNumber:'123'});expect(recovered.executionMode).toBe('CRE local simulation · Sepolia broadcast · recovered receipt');expect(recovered.observations).toBeUndefined();expect(f.captured).toHaveLength(0);expect(restarted.state.activity.status).toBe('idle');expect(restarted.state.activity.summary).toContain('vault paused at block 123');expect(restarted.state.conversation).toEqual(captions);
});
