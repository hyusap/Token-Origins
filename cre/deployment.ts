import { resolve } from 'node:path';
import { isAddress, type Address } from 'viem';
export interface ExecutionDeployment {
  address: Address; forwarder: Address; chainId: number; rpcUrl: string;
  mode?: string; name?: string; explorerUrl?: string;
}
export function isLocalRpc(rpcUrl: string): boolean {
  try { const url = new URL(rpcUrl); return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}
/** Product receiver for actual CRE capability execution. No localhost fallback. */
export async function creDeployment():Promise<ExecutionDeployment> {
  const path=process.env.ORIGINS_CRE_DEPLOYMENT_FILE || resolve(import.meta.dir,'../contracts/deployment.sepolia.json');
  const file=Bun.file(path);const record=await file.exists()?await file.json():null;
  const address=process.env.ORIGINS_SEPOLIA_VAULT || record?.address;
  const forwarder=process.env.ORIGINS_SEPOLIA_FORWARDER || record?.forwarder;
  const rpcUrl=process.env.ORIGINS_SEPOLIA_RPC || record?.rpcUrl || 'https://ethereum-sepolia-rpc.publicnode.com';
  if(!isAddress(address)||!isAddress(forwarder)||typeof rpcUrl!=='string'||isLocalRpc(rpcUrl))throw new Error('CRE requires a real Sepolia receiver and forwarder from its deployment manifest or explicit environment');
  if(!process.env.ORIGINS_SEPOLIA_VAULT && (record?.chainId!==11155111 || record?.reportVersion!==2))throw new Error('CRE deployment manifest must identify a report-v2 Sepolia receiver');
  const sameRecord=record?.address?.toLowerCase()===address.toLowerCase();
  return {...(sameRecord?record:{}),address,forwarder,chainId:11155111,rpcUrl,mode:'cre-sepolia'};
}
export async function executionDeployment(): Promise<ExecutionDeployment> {
  if((process.env.ORIGINS_EXECUTION_MODE||'cre')==='cre')return creDeployment();
  const path = process.env.DEPLOYMENT_FILE || resolve(import.meta.dir, '../.data/deployment.json');
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error('No deployed vault configured; deployment is required before execution');
  const raw = await file.json();
  const address = raw.address || raw.vaultAddress || raw.contractAddress;
  if (!isAddress(address) || !isAddress(raw.forwarder) || !Number.isInteger(raw.chainId) || raw.chainId <= 0 || typeof raw.rpcUrl !== 'string') throw new Error('Invalid execution deployment');
  if (process.env.ORIGINS_EXECUTION_MODE === 'testnet') {
    if (!SUPPORTED_TESTNETS[raw.chainId]) throw new Error('Public execution is restricted to supported test networks');
    if (isLocalRpc(raw.rpcUrl)) throw new Error('Public testnet execution requires a public RPC');
  } else if (raw.chainId !== 31337 || !isLocalRpc(raw.rpcUrl)) throw new Error('Local execution supports only an isolated localhost development chain');
  return {...raw, address};
}
export const SUPPORTED_TESTNETS: Record<number, {name: string; rpcUrl: string; explorerUrl: string}> = {
  11155111: {name: 'Ethereum Sepolia', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', explorerUrl: 'https://sepolia.etherscan.io'},
  84532: {name: 'Base Sepolia', rpcUrl: 'https://base-sepolia-rpc.publicnode.com', explorerUrl: 'https://sepolia.basescan.org'},
};
