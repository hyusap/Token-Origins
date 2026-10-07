import { hexToBytes, type Hex } from 'viem';
import { runIdHash, PAUSE_REPORT_VERSION, REPORT_VERSION, ACTION_PAUSE } from './graph';

/**
 * Solana forms of the GrantVault reports, the Borsh layouts that
 * contracts/solana/programs/sotto_vault decodes. Both carry the same run hash
 * and policy hash as the EVM report, so one decision is identifiable on both
 * chains. Dependency-free so they run inside CRE's WASM.
 *
 * v2 PauseReport (114 bytes):
 *   u8 version | [32] vault | [32] keccak(runId) | u64 revision | [32] policyHash | u8 action | i64 decidedAt
 * v3 ActionReport (117 bytes): v2's fields, then u8 flags | u16 bps.
 */
export const SOLANA_REPORT_BYTES = 114;
export const SOLANA_ACTION_REPORT_BYTES = 117;
export interface SolanaPauseReport { vault: Uint8Array; runId: string; revision: number; policyHash: Hex; decidedAt: number }
export interface SolanaActionReport extends SolanaPauseReport { action: number; flags: number; bps: number }

function writeIdentity(out: Uint8Array, version: number, report: SolanaPauseReport, action: number): number {
  if (report.vault.length !== 32) throw new Error('Solana vault must be a 32-byte public key');
  const view = new DataView(out.buffer);
  let offset = 0;
  out[offset++] = version;
  out.set(report.vault, offset); offset += 32;
  out.set(hexToBytes(runIdHash(report.runId)), offset); offset += 32;
  view.setBigUint64(offset, BigInt(report.revision), true); offset += 8;
  out.set(hexToBytes(report.policyHash), offset); offset += 32;
  out[offset++] = action;
  view.setBigInt64(offset, BigInt(report.decidedAt), true); offset += 8;
  return offset;
}

export function encodeSolanaPauseReport(report: SolanaPauseReport): Uint8Array {
  const out = new Uint8Array(SOLANA_REPORT_BYTES);
  writeIdentity(out, PAUSE_REPORT_VERSION, report, ACTION_PAUSE);
  return out;
}

export function encodeSolanaActionReport(report: SolanaActionReport): Uint8Array {
  if (!Number.isInteger(report.bps) || report.bps < 0 || report.bps > 10_000) throw new Error('bps must be 0–10000');
  const out = new Uint8Array(SOLANA_ACTION_REPORT_BYTES);
  let offset = writeIdentity(out, REPORT_VERSION, report, report.action);
  out[offset++] = report.flags;
  new DataView(out.buffer).setUint16(offset, report.bps, true);
  return out;
}
