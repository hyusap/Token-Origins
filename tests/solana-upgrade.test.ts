// Rehearses `bun run solana:enable-sweep` on a throwaway validator: the program
// binary that is deployed on devnet today (pause-only, report v2) holds a funded
// vault; the upgrade replaces it in place with this build, and the same vault
// account then still pauses on v2 reports and also sweeps on v3 ones.
// Skips unless the Solana CLI is installed.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, toBytes, hexToBytes } from "viem";
import { encodeSolanaPauseReport, encodeSolanaActionReport } from "../cre/solana-report";
import { SOTTO_VAULT_PROGRAM_ID, forwarderAuthority, initializeIx, resumeIx, readSolanaVault, treasuryPda, readTreasuryConfig } from "../cre/solana-vault";
import { policyHash, legacyGraph, ACTION_SWEEP } from "../cre/graph";
import { enableSweep } from "../scripts/solana-enable-sweep";

const validator = Bun.which("solana-test-validator");
const legacySo = "contracts/solana/build/legacy/sotto_vault_v2.so";
const mockSo = "contracts/solana/build/mock_forwarder.so";
const enabled = Boolean(validator && Bun.which("solana") && (await Bun.file(legacySo).exists()) && (await Bun.file(mockSo).exists()));
const MOCK_FORWARDER = new PublicKey("AmEfFHCeHPx5M1biYUQDs8ioR7C2b2AAqSs87dXUtfMA");
const RPC = "http://127.0.0.1:8897";
const connection = new Connection(RPC, "confirmed");
const owner = Keypair.generate();
const forwarderState = Keypair.generate();
const vault = Keypair.generate();
const reserve = Keypair.generate().publicKey;
const POLICY = policyHash(legacyGraph(3000));
let node: ReturnType<typeof Bun.spawn> | undefined;
const disc = (name: string) => Buffer.from(hexToBytes(sha256(toBytes(name))).slice(0, 8));
const vecU8 = (bytes: Uint8Array) => { const len = Buffer.alloc(4); len.writeUInt32LE(bytes.length); return Buffer.concat([len, Buffer.from(bytes)]); };
const send = (ixs: TransactionInstruction[], signers: Keypair[]) => sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
let salt = 0;
const forward = (report: Uint8Array, extra: { pubkey: PublicKey; isWritable: boolean }[] = []) => send([new TransactionInstruction({
  programId: MOCK_FORWARDER,
  keys: [
    { pubkey: forwarderState.publicKey, isSigner: false, isWritable: true },
    { pubkey: forwarderAuthority(MOCK_FORWARDER, forwarderState.publicKey), isSigner: false, isWritable: false },
    { pubkey: SOTTO_VAULT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vault.publicKey, isSigner: false, isWritable: true },
    ...extra.map((account) => ({ ...account, isSigner: false })),
  ],
  data: Buffer.concat([disc("global:report"), vecU8(new Uint8Array(64).fill(++salt % 256)), vecU8(report)]),
})], [owner]);
const pause = (runId: string) => encodeSolanaPauseReport({ vault: vault.publicKey.toBytes(), runId, revision: 1, policyHash: POLICY, decidedAt: Math.floor(Date.now() / 1000) });

beforeAll(async () => {
  if (!enabled) return;
  const dir = await mkdtemp(join(tmpdir(), "sotto-upgrade-ledger-"));
  const authorityFile = join(dir, "authority.json");
  await Bun.write(authorityFile, JSON.stringify(Array.from(owner.secretKey)));
  node = Bun.spawn([validator!, "--reset", "--quiet", "--ledger", join(dir, "ledger"), "--rpc-port", "8897", "--faucet-port", "9907", "--gossip-port", "8007", "--dynamic-port-range", "8100-8200",
    "--upgradeable-program", SOTTO_VAULT_PROGRAM_ID.toBase58(), legacySo, authorityFile, "--bpf-program", MOCK_FORWARDER.toBase58(), mockSo], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 120; i++) { try { await connection.getLatestBlockhash(); break; } catch { await Bun.sleep(500); } }
  await connection.confirmTransaction(await connection.requestAirdrop(owner.publicKey, 20 * LAMPORTS_PER_SOL), "confirmed");
  await send([new TransactionInstruction({ programId: MOCK_FORWARDER, keys: [
    { pubkey: forwarderState.publicKey, isSigner: true, isWritable: true }, { pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: disc("global:init_state") })], [owner, forwarderState]);
  await send([initializeIx(vault.publicKey, owner.publicKey, MOCK_FORWARDER, 300), SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: vault.publicKey, lamports: 2 * LAMPORTS_PER_SOL })], [owner, vault]);
}, 120_000);
afterAll(() => node?.kill());

test.skipIf(!enabled)("enable-sweep upgrades the deployed pause-only program in place; the same vault pauses on v2 and sweeps on v3", async () => {
  // Before: the deployed program pauses on v2 and has no sweep.
  await forward(pause("before-upgrade"));
  expect((await readSolanaVault(connection, vault.publicKey)).paused).toBe(true);
  await send([resumeIx(vault.publicKey, owner.publicKey)], [owner]);
  expect(await readTreasuryConfig(connection, vault.publicKey)).toBeNull();

  const logs: string[] = [];
  const result = await enableSweep({ connection, rpcUrl: RPC, owner, vault: vault.publicKey, reserve, log: (line) => logs.push(line) });
  expect(result.upgraded).toBe(true);
  expect(result.config).toEqual({ vault: vault.publicKey.toBase58(), reserve: reserve.toBase58(), maxSweepBps: 10_000 });
  // Same account, same state history: the pause count from before the upgrade is still there.
  expect((await readSolanaVault(connection, vault.publicKey)).pauseCount).toBe(1);

  // After: v2 pause reports still work, and v3 sweeps move SOL to the reserve.
  await forward(pause("after-upgrade"));
  expect((await readSolanaVault(connection, vault.publicKey)).paused).toBe(true);
  await send([resumeIx(vault.publicKey, owner.publicKey)], [owner]);
  await forward(encodeSolanaActionReport({ vault: vault.publicKey.toBytes(), runId: "sweep-after-upgrade", revision: 2, policyHash: POLICY, decidedAt: Math.floor(Date.now() / 1000), action: ACTION_SWEEP, flags: 0, bps: 2500 }),
    [{ pubkey: treasuryPda(vault.publicKey), isWritable: false }, { pubkey: reserve, isWritable: true }]);
  expect(await connection.getBalance(reserve)).toBeGreaterThan(0.49 * LAMPORTS_PER_SOL);

  // Running it again changes nothing.
  const again = await enableSweep({ connection, rpcUrl: RPC, owner, vault: vault.publicKey, reserve, log: () => {} });
  expect(again.upgraded).toBe(false);
}, 180_000);
