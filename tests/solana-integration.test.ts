// Real Solana programs on a throwaway solana-test-validator: sotto_vault holding
// SOL, and a forwarder stand-in that delivers reports the way Chainlink's
// keystone forwarder does (PDA-signed CPI into on_report). Skips unless the
// Solana CLI is installed and the programs are built (cargo-build-sbf in
// contracts/solana).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, toBytes, hexToBytes } from "viem";
import { encodeSolanaPauseReport, encodeSolanaActionReport, SOLANA_REPORT_BYTES, SOLANA_ACTION_REPORT_BYTES } from "../cre/solana-report";
import { SOTTO_VAULT_PROGRAM_ID, forwarderAuthority, initializeIx, payGrantIx, resumeIx, readSolanaVault, parseVaultEvents, verifySolanaPause, configureReserveIx, treasuryPda, readTreasuryConfig } from "../cre/solana-vault";
import { policyHash, legacyGraph, runIdHash, ACTION_SWEEP, ACTION_PAUSE, FLAG_PAUSE } from "../cre/graph";

const validator = Bun.which("solana-test-validator");
const vaultSo = "contracts/solana/build/sotto_vault.so";
const mockSo = "contracts/solana/build/mock_forwarder.so";
const enabled = Boolean(validator && (await Bun.file(vaultSo).exists()) && (await Bun.file(mockSo).exists()));
const MOCK_FORWARDER = new PublicKey("AmEfFHCeHPx5M1biYUQDs8ioR7C2b2AAqSs87dXUtfMA");
const RPC = "http://127.0.0.1:8899";
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const forwarderState = Keypair.generate();
let node: ReturnType<typeof Bun.spawn> | undefined;
let vault: Keypair;
const POLICY = policyHash(legacyGraph(3000));
const disc = (name: string) => Buffer.from(hexToBytes(sha256(toBytes(name))).slice(0, 8));
const vecU8 = (bytes: Uint8Array) => { const len = Buffer.alloc(4); len.writeUInt32LE(bytes.length); return Buffer.concat([len, Buffer.from(bytes)]); };
const send = (ixs: TransactionInstruction[], signers: Keypair[]) => sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

/** Deliver a report through the forwarder stand-in, exactly as the keystone forwarder CPIs. */
let salt = 0;
function forwardIx(targetVault: PublicKey, report: Uint8Array, state = forwarderState.publicKey, extra: { pubkey: PublicKey; isWritable: boolean }[] = []) {
  return new TransactionInstruction({
    programId: MOCK_FORWARDER,
    keys: [
      { pubkey: state, isSigner: false, isWritable: true },
      { pubkey: forwarderAuthority(MOCK_FORWARDER, state), isSigner: false, isWritable: false },
      { pubkey: SOTTO_VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: targetVault, isSigner: false, isWritable: true },
      ...extra.map((account) => ({ ...account, isSigner: false })),
    ],
    // Metadata is ignored by the vault; varying it keeps identical reports from being identical transactions.
    data: Buffer.concat([disc("global:report"), vecU8(new Uint8Array(64).fill(++salt % 256)), vecU8(report)]),
  });
}
const report = (runId: string, overrides: { vault?: PublicKey; decidedAt?: number } = {}) =>
  encodeSolanaPauseReport({ vault: (overrides.vault ?? vault.publicKey).toBytes(), runId, revision: 2, policyHash: POLICY, decidedAt: overrides.decidedAt ?? Math.floor(Date.now() / 1000) });
const failure = async (promise: Promise<unknown>) => { try { await promise; return "succeeded"; } catch (error: any) { return String(error?.transactionLogs?.join("\n") ?? error?.message ?? error); } };

beforeAll(async () => {
  if (!enabled) return;
  const ledger = await mkdtemp(join(tmpdir(), "sotto-ledger-"));
  node = Bun.spawn([validator!, "--reset", "--quiet", "--ledger", ledger, "--rpc-port", "8899", "--faucet-port", "9910",
    "--bpf-program", SOTTO_VAULT_PROGRAM_ID.toBase58(), vaultSo, "--bpf-program", MOCK_FORWARDER.toBase58(), mockSo], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 120; i++) { try { await connection.getLatestBlockhash(); break; } catch { await Bun.sleep(500); } }
  await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 20 * LAMPORTS_PER_SOL), "confirmed");
  await send([new TransactionInstruction({ programId: MOCK_FORWARDER, keys: [
    { pubkey: forwarderState.publicKey, isSigner: true, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: disc("global:init_state") })], [payer, forwarderState]);
  vault = Keypair.generate();
  await send([initializeIx(vault.publicKey, payer.publicKey, MOCK_FORWARDER, 300), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault.publicKey, lamports: 2 * LAMPORTS_PER_SOL })], [payer, vault]);
}, 120_000);
afterAll(() => node?.kill());

test("the Solana report is exactly the 114-byte Borsh layout the program decodes, with the EVM run hash", () => {
  const bytes = encodeSolanaPauseReport({ vault: new Uint8Array(32).fill(7), runId: "run-x", revision: 3, policyHash: POLICY, decidedAt: 1_800_000_000 });
  expect(bytes.length).toBe(SOLANA_REPORT_BYTES);
  expect(bytes[0]).toBe(2);
  expect(Buffer.from(bytes.slice(33, 65)).toString("hex")).toBe(runIdHash("run-x").slice(2));
  expect(bytes[113 - 8]).toBe(1);
});

test.skipIf(!enabled)("the Solana vault holds SOL and pays grants while active", async () => {
  const before = await connection.getBalance(recipient);
  const paid = await send([payGrantIx(vault.publicKey, payer.publicKey, recipient, BigInt(LAMPORTS_PER_SOL / 10))], [payer]);
  const logs = (await connection.getTransaction(paid, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.logMessages!;
  expect(parseVaultEvents(logs)).toContainEqual({ name: "GrantPaid", vault: vault.publicKey.toBase58(), recipient: recipient.toBase58(), amount: LAMPORTS_PER_SOL / 10 });
  expect((await connection.getBalance(recipient)) - before).toBe(LAMPORTS_PER_SOL / 10);
  expect((await readSolanaVault(connection, vault.publicKey)).paused).toBe(false);
}, 60_000);

test.skipIf(!enabled)("a forwarded CRE report pauses the vault, emits the policy hash, and blocks the next grant", async () => {
  const signature = await send([forwardIx(vault.publicKey, report("solana-run-1"))], [payer]);
  const verification = await verifySolanaPause(connection, signature, vault.publicKey, "solana-run-1", 2, POLICY);
  expect(verification).toMatchObject({ succeeded: true, event: true, pausedAfter: true, lastRunMatches: true });
  const state = await readSolanaVault(connection, vault.publicKey);
  expect(state).toMatchObject({ paused: true, lastPolicyHash: POLICY, lastRevision: 2, pauseCount: 1, owner: payer.publicKey.toBase58() });
  expect(await failure(send([payGrantIx(vault.publicKey, payer.publicKey, recipient, 1000n)], [payer]))).toContain("SpendingIsPaused");
}, 60_000);

test.skipIf(!enabled)("duplicates and second pauses are no-ops; bad reports are rejected onchain", async () => {
  const dup = await send([forwardIx(vault.publicKey, report("solana-run-1"))], [payer]);
  const dupLogs = (await connection.getTransaction(dup, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.logMessages!;
  expect(dupLogs.join("\n")).toContain("duplicate run; no-op");
  const second = await send([forwardIx(vault.publicKey, report("solana-run-2"))], [payer]);
  const secondLogs = (await connection.getTransaction(second, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.logMessages!;
  expect(parseVaultEvents(secondLogs).filter((e) => e.name === "SpendingPaused")).toHaveLength(0);
  expect((await readSolanaVault(connection, vault.publicKey)).pauseCount).toBe(1);
  expect(await failure(send([forwardIx(vault.publicKey, report("solana-run-3", { vault: Keypair.generate().publicKey }))], [payer]))).toContain("WrongTarget");
  expect(await failure(send([forwardIx(vault.publicKey, report("solana-run-4", { decidedAt: Math.floor(Date.now() / 1000) - 3600 }))], [payer]))).toContain("StaleReport");
  expect(await failure(send([forwardIx(vault.publicKey, report("solana-run-5").slice(0, 100))], [payer]))).toContain("UnsupportedReport");
}, 60_000);

test.skipIf(!enabled)("only the configured forwarder can deliver, and only the owner can resume", async () => {
  // A vault bound to a different forwarder rejects this forwarder's state account.
  const other = Keypair.generate();
  await send([initializeIx(other.publicKey, payer.publicKey, Keypair.generate().publicKey, 300)], [payer, other]);
  expect(await failure(send([forwardIx(other.publicKey, report("other-run", { vault: other.publicKey }))], [payer]))).toContain("MismatchedForwarderProgram");
  // Calling on_report directly, without the forwarder's PDA signature, is impossible.
  const impostor = Keypair.generate();
  const direct = new TransactionInstruction({ programId: SOTTO_VAULT_PROGRAM_ID, keys: [
    { pubkey: forwarderState.publicKey, isSigner: false, isWritable: false }, { pubkey: impostor.publicKey, isSigner: true, isWritable: false }, { pubkey: vault.publicKey, isSigner: false, isWritable: true },
  ], data: Buffer.concat([disc("global:on_report"), vecU8(new Uint8Array(0)), vecU8(report("direct-run"))]) });
  expect(await failure(send([direct], [payer, impostor]))).toContain("InvalidForwarderAuthority");
  const stranger = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL), "confirmed");
  expect(await failure(send([resumeIx(vault.publicKey, stranger.publicKey)], [stranger]))).not.toBe("succeeded");
  await send([resumeIx(vault.publicKey, payer.publicKey)], [payer]);
  expect((await readSolanaVault(connection, vault.publicKey)).paused).toBe(false);
  await send([payGrantIx(vault.publicKey, payer.publicKey, recipient, 1000n)], [payer]);
}, 60_000);

const sweepReport = (target: PublicKey, runId: string, bps: number, flags = FLAG_PAUSE, action = ACTION_SWEEP) =>
  encodeSolanaActionReport({ vault: target.toBytes(), runId, revision: 3, policyHash: POLICY, decidedAt: Math.floor(Date.now() / 1000), action, flags, bps });

test("the v3 Solana report appends flags and basis points to the v2 identity fields", () => {
  const bytes = encodeSolanaActionReport({ vault: new Uint8Array(32).fill(7), runId: "run-x", revision: 3, policyHash: POLICY, decidedAt: 1_800_000_000, action: ACTION_SWEEP, flags: FLAG_PAUSE, bps: 5000 });
  expect(bytes.length).toBe(SOLANA_ACTION_REPORT_BYTES);
  expect(bytes[0]).toBe(3);
  expect(Buffer.from(bytes.slice(33, 65)).toString("hex")).toBe(runIdHash("run-x").slice(2));
  expect([bytes[105], bytes[114], Buffer.from(bytes).readUInt16LE(115)]).toEqual([ACTION_SWEEP, FLAG_PAUSE, 5000]);
  expect(() => encodeSolanaActionReport({ vault: new Uint8Array(32), runId: "r", revision: 1, policyHash: POLICY, decidedAt: 1, action: 2, flags: 0, bps: 10001 })).toThrow();
});

test.skipIf(!enabled)("a configured vault sweeps a share of its SOL to the reserve and pauses in the same report", async () => {
  const treasury = Keypair.generate();
  const reserve = Keypair.generate().publicKey;
  await send([initializeIx(treasury.publicKey, payer.publicKey, MOCK_FORWARDER, 300), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: treasury.publicKey, lamports: 2 * LAMPORTS_PER_SOL })], [payer, treasury]);
  // Before configure_reserve, a sweep is refused: there is nowhere it may go.
  expect(await failure(send([forwardIx(treasury.publicKey, sweepReport(treasury.publicKey, "sweep-0", 5000, 0), undefined, [{ pubkey: treasuryPda(treasury.publicKey), isWritable: false }, { pubkey: reserve, isWritable: true }])], [payer]))).toContain("ReserveNotConfigured");
  await send([configureReserveIx(treasury.publicKey, payer.publicKey, reserve, 5000, forwarderState.publicKey)], [payer]);
  expect(await readTreasuryConfig(connection, treasury.publicKey)).toEqual({ vault: treasury.publicKey.toBase58(), reserve: reserve.toBase58(), forwarderState: forwarderState.publicKey.toBase58(), maxSweepBps: 5000 });
  const accounts = [{ pubkey: treasuryPda(treasury.publicKey), isWritable: false }, { pubkey: reserve, isWritable: true }];
  const before = await connection.getBalance(treasury.publicKey);
  const signature = await send([forwardIx(treasury.publicKey, sweepReport(treasury.publicKey, "sweep-1", 5000), undefined, accounts)], [payer]);
  const verification = await verifySolanaPause(connection, signature, treasury.publicKey, "sweep-1", 3, POLICY, { pause: true, sweep: true });
  expect(verification).toMatchObject({ succeeded: true, event: true, pausedAfter: true, lastRunMatches: true });
  const moved = await connection.getBalance(reserve);
  expect(verification.swept).toEqual({ reserve: reserve.toBase58(), lamports: moved });
  // Half of what sits above the rent reserve.
  const rent = await connection.getMinimumBalanceForRentExemption((await connection.getAccountInfo(treasury.publicKey))!.data.length);
  expect(moved).toBe(Math.floor((before - rent) * 5000 / 10000));
  expect(await connection.getBalance(treasury.publicKey)).toBe(before - moved);
}, 90_000);

test.skipIf(!enabled)("sweeps respect the cap, the configured reserve, and only pause or sweep are accepted", async () => {
  const treasury = Keypair.generate();
  const reserve = Keypair.generate().publicKey;
  await send([initializeIx(treasury.publicKey, payer.publicKey, MOCK_FORWARDER, 300), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: treasury.publicKey, lamports: LAMPORTS_PER_SOL })], [payer, treasury]);
  await send([configureReserveIx(treasury.publicKey, payer.publicKey, reserve, 2500, forwarderState.publicKey)], [payer]);
  const accounts = (to = reserve) => [{ pubkey: treasuryPda(treasury.publicKey), isWritable: false }, { pubkey: to, isWritable: true }];
  expect(await failure(send([forwardIx(treasury.publicKey, sweepReport(treasury.publicKey, "cap", 2501, 0), undefined, accounts())], [payer]))).toContain("InvalidAmount");
  expect(await failure(send([forwardIx(treasury.publicKey, sweepReport(treasury.publicKey, "thief", 1000, 0), undefined, accounts(Keypair.generate().publicKey))], [payer]))).toContain("WrongReserve");
  expect(await failure(send([forwardIx(treasury.publicKey, sweepReport(treasury.publicKey, "pay", 1000, 0, 3))], [payer]))).toContain("UnsupportedAction");
  // The owner configures once; a stranger cannot configure at all.
  expect(await failure(send([configureReserveIx(treasury.publicKey, payer.publicKey, Keypair.generate().publicKey, 10000, forwarderState.publicKey)], [payer]))).not.toBe("succeeded");
  const stranger = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL), "confirmed");
  const other = Keypair.generate();
  await send([initializeIx(other.publicKey, payer.publicKey, MOCK_FORWARDER, 300)], [payer, other]);
  expect(await failure(send([configureReserveIx(other.publicKey, stranger.publicKey, stranger.publicKey, 10000, forwarderState.publicKey)], [stranger]))).not.toBe("succeeded");
  // A sweep without the pause flag leaves spending on; a v3 pause report pauses like v2 did.
  await send([forwardIx(treasury.publicKey, sweepReport(treasury.publicKey, "quiet-sweep", 2500, 0), undefined, accounts())], [payer]);
  expect((await readSolanaVault(connection, treasury.publicKey)).paused).toBe(false);
  await send([forwardIx(treasury.publicKey, sweepReport(treasury.publicKey, "v3-pause", 0, 0, ACTION_PAUSE))], [payer]);
  expect((await readSolanaVault(connection, treasury.publicKey)).paused).toBe(true);
}, 90_000);

test.skipIf(!enabled)("review fixes: sweeps only through the bound forwarder state, a pausing sweep keeps its pause, and older runs cannot replay", async () => {
  const treasury = Keypair.generate();
  const reserve = Keypair.generate().publicKey;
  await send([initializeIx(treasury.publicKey, payer.publicKey, MOCK_FORWARDER, 300), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: treasury.publicKey, lamports: LAMPORTS_PER_SOL })], [payer, treasury]);
  // The vault cannot be its own reserve.
  expect(await failure(send([configureReserveIx(treasury.publicKey, payer.publicKey, treasury.publicKey, 10000, forwarderState.publicKey)], [payer]))).toContain("InvalidConfiguration");
  await send([configureReserveIx(treasury.publicKey, payer.publicKey, reserve, 10000, forwarderState.publicKey)], [payer]);
  const accounts = [{ pubkey: treasuryPda(treasury.publicKey), isWritable: false }, { pubkey: reserve, isWritable: true }];
  // A stranger's forwarder state under the same forwarder program is refused for sweeps.
  const rogueState = Keypair.generate();
  await send([new TransactionInstruction({ programId: MOCK_FORWARDER, keys: [
    { pubkey: rogueState.publicKey, isSigner: true, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: disc("global:init_state") })], [payer, rogueState]);
  expect(await failure(send([forwardIx(treasury.publicKey, sweepReport(treasury.publicKey, "rogue-sweep", 5000, 0), rogueState.publicKey, accounts)], [payer]))).toContain("MismatchedForwarderState");
  // Dust that would leave the reserve below rent: a pausing sweep still pauses.
  const dust = sweepReport(treasury.publicKey, "dust-sweep", 1, FLAG_PAUSE);
  const signature = await send([forwardIx(treasury.publicKey, dust, undefined, accounts)], [payer]);
  const logs = (await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.logMessages!;
  expect(parseVaultEvents(logs).map((e) => e.name)).toEqual(["SpendingPaused", "SweepFailed"]);
  expect((await readSolanaVault(connection, treasury.publicKey)).paused).toBe(true);
  expect(await connection.getBalance(reserve)).toBe(0);
  // Without the pause flag the same failure fails the report.
  await send([resumeIx(treasury.publicKey, payer.publicKey)], [payer]);
  expect(await failure(send([forwardIx(treasury.publicKey, sweepReport(treasury.publicKey, "dust-2", 1, 0), undefined, accounts)], [payer]))).toContain("NothingToMove");
  // Run A, then a newer run B, then A again: the replay is refused as stale.
  // Decision times after everything above (within the 60 s clock-skew allowance).
  const now = Math.floor(Date.now() / 1000) + 20;
  const at = (runId: string, decidedAt: number) => encodeSolanaActionReport({ vault: treasury.publicKey.toBytes(), runId, revision: 3, policyHash: POLICY, decidedAt, action: ACTION_SWEEP, flags: 0, bps: 1000 });
  const a = at("run-a", now - 20);
  await send([forwardIx(treasury.publicKey, a, undefined, accounts)], [payer]);
  await send([forwardIx(treasury.publicKey, at("run-b", now - 10), undefined, accounts)], [payer]);
  const swept = await connection.getBalance(reserve);
  expect(await failure(send([forwardIx(treasury.publicKey, a, undefined, accounts)], [payer]))).toContain("StaleReport");
  expect(await connection.getBalance(reserve)).toBe(swept);
}, 120_000);
