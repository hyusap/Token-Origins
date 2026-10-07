import type {SolanaTransferReceipt} from './solana-types';
import {keccak256,toBytes} from 'viem';
/** Immutable execution authority. Legacy EVM records retain their original shape. */
export interface EvmExecutionTarget { kind?: "evm-vault"; chainId:number; address:string; executor?:"local-evm"|"cre"|"testnet-evm" }
export interface SolanaExecutionTarget { kind:"solana-wallet"; network:"devnet"; genesisHash:string; sender:string; executor:"solana-devnet"; vaultDependency?:EvmExecutionTarget }
export type ExecutionTarget = EvmExecutionTarget | SolanaExecutionTarget;
export const isSolanaTarget = (target:ExecutionTarget):target is SolanaExecutionTarget => target.kind === "solana-wallet";
export const isEvmTarget = (target:ExecutionTarget):target is EvmExecutionTarget => !isSolanaTarget(target);
export function normalizeExecutionTarget(target:ExecutionTarget):ExecutionTarget {
  if(isSolanaTarget(target)) {
    if(target.network!=="devnet" || target.executor!=="solana-devnet" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target.sender) || target.genesisHash!=="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("Invalid immutable Solana devnet target");
    return {kind:"solana-wallet",network:"devnet",genesisHash:target.genesisHash,sender:target.sender,executor:"solana-devnet",...(target.vaultDependency?{vaultDependency:normalizeExecutionTarget(target.vaultDependency) as EvmExecutionTarget}: {})};
  }
  if(!Number.isInteger(target.chainId)||target.chainId<1||!/^0x[0-9a-fA-F]{40}$/.test(target.address)) throw new Error("Invalid immutable EVM target");
  return {kind:"evm-vault",chainId:target.chainId,address:target.address.toLowerCase(),executor:target.executor ?? (target.chainId===31337 ? "local-evm" : "cre")};
}
export const sameExecutionTarget = (a:ExecutionTarget,b:ExecutionTarget):boolean => JSON.stringify(normalizeExecutionTarget(a))===JSON.stringify(normalizeExecutionTarget(b));

export const policyOperationKey=(runId:string,policyHash:string)=>'policy:'+keccak256(toBytes(JSON.stringify([runId,policyHash]))).slice(2);

/** A transaction identifier alone never constitutes settlement. */
export function assertSolanaSettlement(target:ExecutionTarget,action:{type:string;network?:string;recipient?:string;amountLamports?:number},runId:string,policyHash:string,receipt:SolanaTransferReceipt & {genesisHash:string;verified:true}):void {
  if(!isSolanaTarget(target)||action.type!=='solana-transfer'||receipt.verified!==true||receipt.status!=='confirmed'||receipt.network!=='devnet'||receipt.genesisHash!==target.genesisHash||receipt.sender!==target.sender||receipt.recipient!==action.recipient||receipt.lamports!==action.amountLamports||receipt.amountSol!==receipt.lamports/1e9||receipt.idempotencyKey!==policyOperationKey(runId,policyHash)||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(receipt.signature)||!Number.isSafeInteger(receipt.slot)||receipt.slot<1||!Number.isSafeInteger(receipt.feeLamports)||receipt.feeLamports<0||!Number.isSafeInteger(receipt.recipientBalanceBefore)||!Number.isSafeInteger(receipt.recipientBalanceAfter)||receipt.recipientBalanceAfter-receipt.recipientBalanceBefore!==receipt.lamports)throw new Error('Solana settlement does not match the frozen action, authority and verified transfer receipt');
}
