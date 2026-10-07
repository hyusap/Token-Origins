import { hexToBytes, type Hex } from 'viem';
import { runIdHash, REPORT_VERSION, ACTION_PAUSE } from './graph';

/**
 * Solana form of report v2, the Borsh `PauseReport` that
 * contracts/solana/programs/sotto_vault decodes (exactly 114 bytes):
 * u8 version | [32] vault | [32] keccak(runId) | u64 revision | [32] policyHash | u8 action | i64 decidedAt.
 * The same run hash and policy hash as the EVM report, so one decision is
 * identifiable on both chains. Dependency-free so it runs inside CRE's WASM.
 */
export const SOLANA_REPORT_BYTES = 114;
export interface SolanaPauseReport { vault: Uint8Array; runId: string; revision: number; policyHash: Hex; decidedAt: number }

export function encodeSolanaPauseReport(report: SolanaPauseReport): Uint8Array {
  if (report.vault.length !== 32) throw new Error('Solana vault must be a 32-byte public key');
  const out = new Uint8Array(SOLANA_REPORT_BYTES);
  const view = new DataView(out.buffer);
  let offset = 0;
  out[offset++] = REPORT_VERSION;
  out.set(report.vault, offset); offset += 32;
  out.set(hexToBytes(runIdHash(report.runId)), offset); offset += 32;
  view.setBigUint64(offset, BigInt(report.revision), true); offset += 8;
  out.set(hexToBytes(report.policyHash), offset); offset += 32;
  out[offset++] = ACTION_PAUSE;
  view.setBigInt64(offset, BigInt(report.decidedAt), true); offset += 8;
  return out;
}
