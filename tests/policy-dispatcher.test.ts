import {test,expect,afterEach} from 'bun:test';
import {policyHash,legacyGraph,sourceIdentity,evaluatePredicate,predicateHash,validateGraph,type PolicyGraph} from '../cre/graph';
import {executeCreRun,assertCreSupports} from '../cre/runner';
import {executeDispatchedPolicy,resolvePolicyTarget,recoverSolanaPolicy,policyOperationKey,type PolicyExecutorDependencies} from '../server/policy-executor';
import {Engine} from '../server/engine';
import {StateStore} from '../server/store';
import {SOLANA_GENESIS,type SolanaTransferReceipt} from '../server/solana';
import type {SolanaExecutionTarget} from '../shared/execution-target';
const sender='11111111111111111111111111111111',recipient='So11111111111111111111111111111111111111112';
const target={kind:'solana-wallet',network:'devnet',genesisHash:SOLANA_GENESIS.devnet,sender,executor:'solana-devnet'} as const satisfies SolanaExecutionTarget;
const graph=(threshold=200):PolicyGraph=>({...legacyGraph(threshold,'SOL-USD'),action:{type:'solana-transfer',network:'devnet',recipient,amountLamports:10001}});
const spec=(threshold=200)=>({version:2 as const,runId:'conditional_sol_test',revision:1,graph:graph(threshold),policyHash:policyHash(graph(threshold)),maxAgeSeconds:60,broadcast:true});
const reading=()=>({...sourceIdentity({type:'exchange-trade',pair:'SOL-USD'}),usd:150,raw:'150',observedAt:new Date().toISOString(),fetchedAt:new Date().toISOString()});
function receipt(key:string):SolanaTransferReceipt {return {network:'devnet',status:'confirmed',signature:'2'.repeat(88),sender,recipient,lamports:10001,amountSol:0.000010001,slot:15,feeLamports:5000,blockTime:new Date().toISOString(),explorerUrl:'https://explorer.solana.com/tx/test?cluster=devnet',recipientBalanceBefore:200,recipientBalanceAfter:10201,idempotencyKey:key,replayed:false};}
function setup() {
  let writes=0,vaultReads=0;const calls:any[]=[];
  const deps:PolicyExecutorDependencies={research:true,deployment:async()=>{vaultReads++;throw new Error('No vault configured');},resolveFeed:async()=>{throw new Error('unexpected feed');},fetchExchange:async()=>reading(),solanaTarget:async()=>({...target}),transfer:async input=>{writes++;calls.push(input);input.onPrepared?.('2'.repeat(88));return receipt(input.idempotencyKey);}};
  return {deps,calls,get writes(){return writes;},get vaultReads(){return vaultReads;}};
}
test('Solana action policy hash binds recipient and exact amount while old pause hash is unchanged',()=>{
  expect(policyHash(legacyGraph(3000))).toBe('0xa486154b934ef69a64205362c2c5fb2ba1d97b12f5dda07e6f6dc3ee198e1da5');
  const g=graph();expect(policyHash(g)).not.toBe(policyHash({...g,action:{...g.action,type:'solana-transfer',network:'devnet',recipient,amountLamports:10002}}));
  expect(policyHash(g)).not.toBe(policyHash({...g,action:{type:'solana-transfer',network:'devnet',recipient:sender,amountLamports:10001}}));
  expect(()=>validateGraph({...g,action:{...g.action,network:'mainnet-beta'}})).toThrow();
  expect(()=>validateGraph({...g,action:{...g.action,amountLamports:0.5}})).toThrow();
});
test('false Solana condition reads actual supplied source but never vault or signer',async()=>{
  const f=setup();const frozen=await resolvePolicyTarget(graph(100),f.deps);const result=await executeDispatchedPolicy(spec(100),frozen,undefined,f.deps);
  expect(result.decision).toBe('noop');expect(result.vault).toBeNull();expect(result.observations[0]?.key).toBe('exchange-trade:SOL-USD');expect(f.writes).toBe(0);expect(f.vaultReads).toBe(0);
});
test('passing condition dispatches exact lamports, immutable sender/genesis and stable journal key',async()=>{
  const f=setup(),logs:string[]=[];const result=await executeDispatchedPolicy(spec(),target,m=>logs.push(m),f.deps);
  expect(f.writes).toBe(1);expect(f.calls[0]).toMatchObject({amountSol:'0.000010001',recipient,expectedSender:sender,expectedGenesisHash:SOLANA_GENESIS.devnet,idempotencyKey:policyOperationKey(spec().runId,spec().policyHash)});
  expect(result.mode).toBe('solana-devnet');expect(result.solanaTransfer?.verified).toBe(true);expect(result.transaction).toBeUndefined();expect(result.vault).toBeNull();expect(logs.find(x=>x.startsWith('ORIGINS_SOLANA_SUBMITTED'))).toContain(spec().policyHash);
});
test('dry run evaluates Solana sources without signing',async()=>{const f=setup();const result=await executeDispatchedPolicy({...spec(),broadcast:false},target,undefined,f.deps);expect(result.dryRun).toBe(true);expect(f.writes).toBe(0);});
test('frozen task signer or executor drift blocks before any source read or write',async()=>{
  const f=setup();f.deps.solanaTarget=async()=>({...target,sender:recipient});await expect(executeDispatchedPolicy(spec(),target,undefined,f.deps)).rejects.toThrow('changed');expect(f.writes).toBe(0);
});
test('explicit vault conditions cannot silently omit the frozen dependency',async()=>{
  const f=setup();const g:PolicyGraph={nodes:[{id:'active',kind:'vault-paused',equals:false}],root:'active',action:graph().action};await expect(resolvePolicyTarget(g,f.deps)).rejects.toThrow('No vault');
});
test('CRE and EVM reject transfer actions before deployment/source/signer side effects',async()=>{await expect(executeCreRun(spec())).rejects.toThrow('vault reports only');await expect(assertCreSupports(spec(),[])).rejects.toThrow('vault reports only');});
test('read-only recovery uses the original policy journal key without transfer invocation',async()=>{
  const f=setup();let recovered:any;f.deps.reconcileTransfer=async input=>{recovered=input;return {status:'pending',fingerprint:'f'.repeat(64),network:'devnet',genesisHash:SOLANA_GENESIS.devnet,sender,recipient,lamports:10001,idempotencyKey:input.idempotencyKey,checkedAt:new Date().toISOString(),reason:'pending'};};
  expect((await recoverSolanaPolicy(spec(),target,f.deps)).status).toBe('pending');expect(recovered.idempotencyKey).toBe(policyOperationKey(spec().runId,spec().policyHash));expect(f.writes).toBe(0);
});
test('reusable predicate hashes without an action and evaluates with no vault pause guard',()=>{
  const {action,...predicate}=graph();const result=evaluatePredicate(predicate,{readings:{'exchange-trade:SOL-USD':{usd:150,observedAt:new Date().toISOString()}},vaultPaused:null,exchangeMaxAgeSeconds:60},Date.now());
  expect(result.decision).toBe('act');expect(result.conditions.some(c=>c.nodeId==='guard:vault-active')).toBe(false);expect(predicateHash(predicate)).not.toBe(policyHash(graph()));
});
const engines:Engine[]=[];afterEach(async()=>{for(const e of engines.splice(0)){e.monitors.close();await Promise.resolve();e.store.db.close();}});
test('injected research: semantic Solana composition/run has no vault requirement and immutable settlement ledger',async()=>{
  const f=setup();const e=new Engine(new StateStore(':memory:'),{loadDeployment:async()=>null,fetchPrice:async()=>({id:'price:sol-usd',kind:'price',label:'SOL',data:{price:150,productId:'SOL-USD'},provenance:{kind:'live',source:'Injected unit input',label:'Test',observedAt:new Date().toISOString(),fetchedAt:new Date().toISOString()},visible:true,pinned:false}),solanaTarget:f.deps.solanaTarget,solanaTransfer:f.deps.transfer});engines.push(e);
  const composed=await e.invoke('compose_graph',{expectedRevision:0,graph:graph(),operationId:'compose'});expect(composed.ok).toBe(true);expect(e.state.workflow.revisions[0]?.target).toMatchObject(target);
  const queued=await e.invoke('run_workflow',{expectedRevision:1,operationId:'run'});expect(queued.ok).toBe(true);
  for(let i=0;i<60&&e.state.runs[0]?.status!=='confirmed';i++)await Bun.sleep(5);
  const run=e.state.runs[0]!;expect(run.status).toBe('confirmed');expect(run.evidence?.solanaTransfer?.lamports).toBe(10001);expect(run.target).toMatchObject(target);expect(run.inputs?.vault).toBeUndefined();expect(e.state.objects.find(o=>o.kind==='vault')).toBeUndefined();expect(e.state.objects.find(o=>o.id==='action:solana-transfer')?.data.recipient).toBe(recipient);
});
test('injected research: successful semantic copy replay re-verifies its original journal read-only, never invokes another copy',async()=>{
  const e=new Engine(new StateStore(':memory:'),{fetchVault:async()=>{throw new Error('explicit unit research adapter');}});engines.push(e);let writes=0,reads=0,canonical=true;
  e.tradeTools.invoke=async name=>{
    if(name==='copy_evm_swap'){writes++;return {summary:'confirmed test receipt',data:{receipt:{transactionHash:'0xoriginal'}}};}
    if(name==='reconcile_evm_copy_swap'){reads++;if(!canonical)throw new Error('Previously confirmed swap no longer canonical');return {summary:'confirmed original',data:{status:'confirmed',receipt:{transactionHash:'0xoriginal',replayed:true}}};}
    return undefined;
  };
  expect((await e.invoke('copy_evm_swap',{operationId:'copy-original'})).ok).toBe(true);
  const replay=await e.invoke('copy_evm_swap',{operationId:'copy-original'});expect(replay.ok).toBe(true);expect(replay.duplicate).toBe(true);expect(reads).toBe(1);expect(writes).toBe(1);
  canonical=false;expect((await e.invoke('copy_evm_swap',{operationId:'copy-original'})).code).toBe('COPY_RECEIPT_UNVERIFIED');expect(writes).toBe(1);
});

test('injected research: a semantic no-op reports live Solana evaluation without claiming an on-chain transfer',async()=>{
  const f=setup();const e=new Engine(new StateStore(':memory:'),{loadDeployment:async()=>null,fetchPrice:async()=>({id:'price:sol-usd',kind:'price',label:'SOL',data:{price:150,productId:'SOL-USD'},provenance:{kind:'live',source:'Injected unit input',label:'Test',observedAt:new Date().toISOString(),fetchedAt:new Date().toISOString()},visible:true,pinned:false}),solanaTarget:f.deps.solanaTarget,solanaTransfer:f.deps.transfer});engines.push(e);
  expect((await e.invoke('compose_graph',{expectedRevision:0,graph:graph(100),operationId:'false-compose'})).ok).toBe(true);
  expect((await e.invoke('run_workflow',{expectedRevision:1,operationId:'false-run'})).ok).toBe(true);
  for(let i=0;i<60&&e.state.runs[0]?.status!=='no-op';i++)await Bun.sleep(5);
  expect(e.state.runs[0]?.status).toBe('no-op');expect(e.state.runs[0]?.executionMode).toBe('Solana devnet · live policy evaluation');expect(e.state.capabilities.execution).not.toContain('verified');expect(f.writes).toBe(0);
});
