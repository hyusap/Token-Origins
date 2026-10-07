import { Connection, PublicKey, SystemProgram, TransactionInstruction, type Commitment } from '@solana/web3.js';
import { sha256, toBytes, hexToBytes, bytesToHex, type Hex } from 'viem';
import { runIdHash } from './graph';

/**
 * Node-side helpers for contracts/solana/programs/sotto_vault: instruction
 * builders, account and event decoding, and chain verification. The workflow
 * itself only needs cre/solana-report.ts.
 */
export const SOTTO_VAULT_PROGRAM_ID = new PublicKey('8g87GMMGr4JrzJpfh8v9oxyy8mwDRGawBRFJR8c1hqYD');
/** CRE's simulation forwarder on Solana devnet: what `cre workflow simulate --broadcast` writes through. */
export const SIMULATION_FORWARDER = {
  program: new PublicKey('7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK'),
  state: new PublicKey('5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7'),
};
export const SOLANA_DEVNET_RPC = process.env.ORIGINS_SOLANA_RPC || 'https://api.devnet.solana.com';
export const solanaExplorer = (signature: string, cluster = 'devnet') => `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;

const discriminator = (name: string) => hexToBytes(sha256(toBytes(name))).slice(0, 8);
const IX = { initialize: discriminator('global:initialize'), payGrant: discriminator('global:pay_grant'), resume: discriminator('global:resume'), configureReserve: discriminator('global:configure_reserve') };
const EVENT = { paused: discriminator('event:SpendingPaused'), resumed: discriminator('event:SpendingResumed'), grant: discriminator('event:GrantPaid'), swept: discriminator('event:ReserveSwept') };
const VAULT_ACCOUNT = discriminator('account:Vault');
const TREASURY_ACCOUNT = discriminator('account:TreasuryConfig');
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const le64 = (value: bigint, signed = false) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); signed ? v.setBigInt64(0, value, true) : v.setBigUint64(0, value, true); return b; };

/** The PDA the forwarder signs with when it calls on_report. */
export const forwarderAuthority = (forwarderProgram: PublicKey, state: PublicKey, receiver = SOTTO_VAULT_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from('forwarder'), state.toBuffer(), receiver.toBuffer()], forwarderProgram)[0];

/** Per-vault sweep configuration: PDA ["treasury", vault] under the vault program. */
export const treasuryPda = (vault: PublicKey, programId = SOTTO_VAULT_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from('treasury'), vault.toBuffer()], programId)[0];

/** Owner-only, once per vault: where sweeps may send SOL, and the largest share per report. */
export function configureReserveIx(vault: PublicKey, owner: PublicKey, reserve: PublicKey, maxSweepBps: number, programId = SOTTO_VAULT_PROGRAM_ID) {
  const bps = Buffer.alloc(2); bps.writeUInt16LE(maxSweepBps);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: false }, { pubkey: treasuryPda(vault, programId), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.configureReserve, reserve.toBuffer(), bps]),
  });
}
export interface TreasuryConfig { vault: string; reserve: string; maxSweepBps: number }
/** The vault's sweep configuration, or null when the program predates sweeps or it was never configured. */
export async function readTreasuryConfig(connection: Connection, vault: PublicKey, commitment: Commitment = 'confirmed'): Promise<TreasuryConfig | null> {
  const info = await connection.getAccountInfo(treasuryPda(vault), commitment);
  if (!info || !info.owner.equals(SOTTO_VAULT_PROGRAM_ID)) return null;
  const data = new Uint8Array(info.data);
  if (data.length < 8 + 32 + 32 + 2 || !equal(data.slice(0, 8), TREASURY_ACCOUNT)) return null;
  return { vault: new PublicKey(data.slice(8, 40)).toBase58(), reserve: new PublicKey(data.slice(40, 72)).toBase58(), maxSweepBps: new DataView(data.buffer, data.byteOffset).getUint16(72, true) };
}

export function initializeIx(vault: PublicKey, owner: PublicKey, forwarderProgram: PublicKey, maxReportAgeSeconds: number, programId = SOTTO_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: vault, isSigner: true, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
    data: Buffer.concat([IX.initialize, forwarderProgram.toBuffer(), le64(BigInt(maxReportAgeSeconds), true)]),
  });
}
export function payGrantIx(vault: PublicKey, owner: PublicKey, recipient: PublicKey, lamports: bigint, programId = SOTTO_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: vault, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }, { pubkey: recipient, isSigner: false, isWritable: true }],
    data: Buffer.concat([IX.payGrant, le64(lamports)]),
  });
}
export function resumeIx(vault: PublicKey, owner: PublicKey, programId = SOTTO_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: vault, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from(IX.resume),
  });
}

export interface SolanaVaultState { owner: string; forwarderProgram: string; maxReportAge: number; paused: boolean; lastRun: Hex; lastPolicyHash: Hex; lastRevision: number; lastDecidedAt: number; pauseCount: number; lamports: number }
export function decodeVault(data: Uint8Array, lamports = 0): SolanaVaultState {
  if (data.length < 8 + 32 + 32 + 8 + 1 + 32 + 32 + 8 + 8 + 8 || !equal(data.slice(0, 8), VAULT_ACCOUNT)) throw new Error('Account is not a Sotto vault');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const key = () => { const k = new PublicKey(data.slice(o, o + 32)).toBase58(); o += 32; return k; };
  const bytes32 = () => { const h = bytesToHex(data.slice(o, o + 32)); o += 32; return h; };
  const owner = key(), forwarderProgram = key();
  const maxReportAge = Number(view.getBigInt64(o, true)); o += 8;
  const paused = data[o++] === 1;
  const lastRun = bytes32(), lastPolicyHash = bytes32();
  const lastRevision = Number(view.getBigUint64(o, true)); o += 8;
  const lastDecidedAt = Number(view.getBigInt64(o, true)); o += 8;
  const pauseCount = Number(view.getBigUint64(o, true)); o += 8;
  return { owner, forwarderProgram, maxReportAge, paused, lastRun, lastPolicyHash, lastRevision, lastDecidedAt, pauseCount, lamports };
}
export async function readSolanaVault(connection: Connection, vault: PublicKey, commitment: Commitment = 'confirmed') {
  const info = await connection.getAccountInfo(vault, commitment);
  if (!info) throw new Error(`No account at ${vault.toBase58()}`);
  if (!info.owner.equals(SOTTO_VAULT_PROGRAM_ID)) throw new Error(`Account ${vault.toBase58()} is owned by ${info.owner.toBase58()}, not the Sotto vault program`);
  return decodeVault(new Uint8Array(info.data), info.lamports);
}

export type SolanaVaultEvent =
  | { name: 'SpendingPaused'; vault: string; runId: Hex; revision: number; policyHash: Hex; decidedAt: number }
  | { name: 'SpendingResumed'; vault: string }
  | { name: 'GrantPaid'; vault: string; recipient: string; amount: number }
  | { name: 'ReserveSwept'; vault: string; runId: Hex; revision: number; policyHash: Hex; reserve: string; amount: number };
/** Anchor events appear in transaction logs as "Program data: <base64>". */
export function parseVaultEvents(logs: readonly string[]): SolanaVaultEvent[] {
  const events: SolanaVaultEvent[] = [];
  for (const line of logs) {
    const match = line.match(/^Program data: (.+)$/);
    if (!match) continue;
    const data = new Uint8Array(Buffer.from(match[1]!, 'base64'));
    const head = data.slice(0, 8);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const key = (o: number) => new PublicKey(data.slice(o, o + 32)).toBase58();
    if (equal(head, EVENT.paused) && data.length >= 8 + 32 + 32 + 8 + 32 + 8)
      events.push({ name: 'SpendingPaused', vault: key(8), runId: bytesToHex(data.slice(40, 72)), revision: Number(view.getBigUint64(72, true)), policyHash: bytesToHex(data.slice(80, 112)), decidedAt: Number(view.getBigInt64(112, true)) });
    else if (equal(head, EVENT.resumed)) events.push({ name: 'SpendingResumed', vault: key(8) });
    else if (equal(head, EVENT.grant)) events.push({ name: 'GrantPaid', vault: key(8), recipient: key(40), amount: Number(view.getBigUint64(72, true)) });
    else if (equal(head, EVENT.swept) && data.length >= 8 + 32 + 32 + 8 + 32 + 32 + 8)
      events.push({ name: 'ReserveSwept', vault: key(8), runId: bytesToHex(data.slice(40, 72)), revision: Number(view.getBigUint64(72, true)), policyHash: bytesToHex(data.slice(80, 112)), reserve: key(112), amount: Number(view.getBigUint64(144, true)) });
  }
  return events;
}

export interface SolanaPauseVerification { signature: string; succeeded: boolean; event: boolean; pausedAfter: boolean; lastRunMatches: boolean; slot?: number; error?: string; logs: string[]; swept?: { reserve: string; lamports: number } }
/**
 * Confirms a CRE Solana write: the transaction succeeded, the vault emitted
 * SpendingPaused for this run, revision and policy hash, and a fresh read of
 * the vault shows it paused with this run recorded.
 */
export async function verifySolanaPause(connection: Connection, signature: string, vault: PublicKey, runId: string, revision: number, policyHash: string, expect: { pause: boolean; sweep: boolean } = { pause: true, sweep: false }): Promise<SolanaPauseVerification> {
  let tx = null;
  for (let attempt = 0; attempt < 20 && !tx; attempt++) {
    tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx) await Bun.sleep(1500);
  }
  if (!tx) return { signature, succeeded: false, event: false, pausedAfter: false, lastRunMatches: false, error: 'transaction not found', logs: [] };
  const logs = tx.meta?.logMessages ?? [];
  const succeeded = !tx.meta?.err;
  const events = parseVaultEvents(logs);
  const ours = (e: SolanaVaultEvent) => 'runId' in e && e.vault === vault.toBase58() && e.runId === runIdHash(runId) && e.revision === revision && e.policyHash.toLowerCase() === policyHash.toLowerCase();
  const sweep = events.find((e): e is Extract<SolanaVaultEvent, { name: 'ReserveSwept' }> => e.name === 'ReserveSwept' && ours(e));
  // A pause event is only expected when the vault was active; a sweep always emits.
  const event = (!expect.pause || events.some((e) => e.name === 'SpendingPaused' && ours(e))) && (!expect.sweep || Boolean(sweep));
  const state = await readSolanaVault(connection, vault);
  return { signature, succeeded, event, pausedAfter: expect.pause ? state.paused : true, lastRunMatches: state.lastRun === runIdHash(runId), slot: tx.slot, ...(tx.meta?.err ? { error: JSON.stringify(tx.meta.err) } : {}), logs, ...(sweep ? { swept: { reserve: sweep.reserve, lamports: sweep.amount } } : {}) };
}
