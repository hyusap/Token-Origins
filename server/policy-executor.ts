import {createPublicClient,http} from 'viem';
import type {ExecutionSpecification} from '../cre/spec';
import {readsVault,type PolicyGraph} from '../cre/graph';
import {executePolicy,executeCreRun,readVaultState,type ExecutionEvidence,type RunnerDeps,type LocalDeployment,type ExchangeFetcher,type FeedResolver} from '../cre/runner';
import {normalizeExecutionTarget,sameExecutionTarget,isSolanaTarget,isEvmTarget,policyOperationKey,assertSolanaSettlement,type ExecutionTarget} from '../shared/execution-target';
import {getSolanaDevnetActionTarget,transferSolanaDevnet,reconcileSolanaDevnetTransfer,type SolanaTransferInput} from './solana';
export {policyOperationKey} from '../shared/execution-target';
export const lamportsToSol=(lamports:number)=>`${Math.floor(lamports/1e9)}.${String(lamports%1e9).padStart(9,'0')}`;
export interface PolicyExecutorDependencies {
  /** Explicit dependency-injected laboratory adapters only; no environment/user toggle. */
  research?:boolean;
  deployment:()=>Promise<(Omit<LocalDeployment,'forwarder'>&{forwarder?:string})|null>;
  resolveFeed:FeedResolver;
  fetchExchange:ExchangeFetcher;
  executeEvm?:typeof executeCreRun;
  solanaTarget?:typeof getSolanaDevnetActionTarget;
  transfer?:typeof transferSolanaDevnet;
  reconcileTransfer?:typeof reconcileSolanaDevnetTransfer;
}
export async function resolvePolicyTarget(graph:PolicyGraph,deps:PolicyExecutorDependencies):Promise<ExecutionTarget> {
  if(!deps.research&&graph.action.type!=='pause-vault')throw Object.assign(new Error('This action has no implemented CRE receiver workflow; direct signing is disabled'),{code:'CRE_EXECUTION_REQUIRED'});
  const vault=async()=>{const d=await deps.deployment();if(!d)throw new Error('This policy needs a real deployed vault');if(!deps.research&&d.chainId!==11155111)throw Object.assign(new Error('The product executes only through CRE against its Sepolia receiver; direct local/testnet execution is disabled'),{code:'CRE_EXECUTION_REQUIRED'});return normalizeExecutionTarget({kind:'evm-vault',address:d.address,chainId:d.chainId,executor:deps.research ? (process.env.ORIGINS_EXECUTION_MODE==='cre' ? 'cre' : process.env.ORIGINS_EXECUTION_MODE==='testnet' ? 'testnet-evm' : 'local-evm') : 'cre'});};
  if(graph.action.type==='pause-vault')return vault();
  const target=await (deps.solanaTarget??getSolanaDevnetActionTarget)();
  const vaultDependency=readsVault(graph)?await vault():undefined;
  if(vaultDependency&& !isEvmTarget(vaultDependency))throw new Error('Vault dependency must be EVM');
  return normalizeExecutionTarget({kind:'solana-wallet',executor:'solana-devnet',...target,...(vaultDependency?{vaultDependency}: {})});
}
export function solanaPolicyInput(spec:ExecutionSpecification,target:ExecutionTarget):SolanaTransferInput {
  const action=spec.graph.action;
  if(action.type!=='solana-transfer'||!isSolanaTarget(target))throw new Error('Solana action requires a frozen Solana target');
  return {recipient:action.recipient,amountSol:lamportsToSol(action.amountLamports),idempotencyKey:policyOperationKey(spec.runId,spec.policyHash),expectedSender:target.sender,expectedGenesisHash:target.genesisHash};
}
export async function executeDispatchedPolicy(spec:ExecutionSpecification,target:ExecutionTarget,progress:((message:string)=>void)|undefined,deps:PolicyExecutorDependencies):Promise<ExecutionEvidence> {
  if(!deps.research&&(!isEvmTarget(target)||target.executor!=='cre'||target.chainId!==11155111||spec.graph.action.type!=='pause-vault'))throw Object.assign(new Error('Only the implemented CRE pause-vault workflow may execute; direct signer routes are disabled'),{code:'CRE_EXECUTION_REQUIRED'});
  const current=await resolvePolicyTarget(spec.graph,deps);
  if(!sameExecutionTarget(target,current))throw new Error('Execution authority or input vault changed after this policy was frozen; no action was sent');
  if(isEvmTarget(target)) {
    if(spec.graph.action.type!=='pause-vault')throw new Error('Action/target mismatch');
    const deployment=await deps.deployment();if(!deployment)throw new Error('Frozen vault deployment unavailable');
    if(deployment.chainId!==target.chainId||deployment.address.toLowerCase()!==target.address.toLowerCase())throw new Error('Frozen EVM deployment changed before execution');
    return (deps.executeEvm??executeCreRun)(spec,progress,{deployment:deployment as LocalDeployment,resolveFeed:deps.resolveFeed,fetchExchange:deps.fetchExchange});
  }
  if(spec.graph.action.type!=='solana-transfer')throw new Error('Action/target mismatch');
  const deployment=target.vaultDependency?await deps.deployment():null;
  if(target.vaultDependency&&(!deployment||deployment.chainId!==target.vaultDependency.chainId||deployment.address.toLowerCase()!==target.vaultDependency.address.toLowerCase()))throw new Error('Frozen vault predicate dependency changed before execution');
  const env={mode:'solana-devnet' as const,
    readVault:async()=>{if(!deployment)throw new Error('Explicit vault predicate requires its frozen deployment');const client=createPublicClient({transport:http(deployment.rpcUrl)});if(await client.getChainId()!==deployment.chainId)throw new Error('Frozen vault predicate RPC chain mismatch');return readVaultState(client as any,deployment.address as `0x${string}`,deployment.chainId);},
    readSource:(source:Parameters<FeedResolver>[0]|Parameters<ExchangeFetcher>[0])=>source.type==='chainlink-feed'?deps.resolveFeed(source):deps.fetchExchange(source),
    deliverSolanaTransfer:async()=>{
      const receipt=await (deps.transfer??transferSolanaDevnet)({...solanaPolicyInput(spec,target),onPrepared:signature=>progress?.('ORIGINS_SOLANA_SUBMITTED '+JSON.stringify({signature,runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash}))});
      if(receipt.sender!==target.sender)throw new Error('Solana receipt sender differs from frozen authority');
      const verified={...receipt,genesisHash:target.genesisHash,verified:true as const};
      assertSolanaSettlement(target,spec.graph.action,spec.runId,spec.policyHash,verified);return verified;
    }};
  return executePolicy(spec,env,progress);
}
export async function recoverSolanaPolicy(spec:ExecutionSpecification,target:ExecutionTarget,deps:PolicyExecutorDependencies) {
  return (deps.reconcileTransfer??reconcileSolanaDevnetTransfer)(solanaPolicyInput(spec,target));
}
export function recoveredSolanaEvidence(spec:ExecutionSpecification,target:ExecutionTarget,receipt:NonNullable<Awaited<ReturnType<typeof reconcileSolanaDevnetTransfer>>['receipt']>,prior?:Pick<ExecutionEvidence,'vault'|'observations'|'conditions'>):ExecutionEvidence {
  if(!isSolanaTarget(target))throw new Error('Solana recovery target mismatch');
  const action=spec.graph.action;
  if(action.type!=='solana-transfer'||receipt.sender!==target.sender||receipt.recipient!==action.recipient||receipt.lamports!==action.amountLamports||receipt.idempotencyKey!==policyOperationKey(spec.runId,spec.policyHash))throw new Error('Recovered transfer does not match the frozen policy');
  assertSolanaSettlement(target,action,spec.runId,spec.policyHash,{...receipt,genesisHash:target.genesisHash,verified:true});
  return {runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash,mode:'solana-devnet',action:'solana-transfer',vault:prior?.vault??null,observations:prior?.observations??[],conditions:prior?.conditions??[],root:true,decision:'act',decidedAt:receipt.blockTime??new Date().toISOString(),solanaTransfer:{...receipt,genesisHash:target.genesisHash,verified:true},logs:['Recovered verified transfer only; original source observations were not recovered.']};
}
