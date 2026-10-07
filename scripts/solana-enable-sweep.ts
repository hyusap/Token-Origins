// Lets the existing Solana vault sweep to a reserve, not just pause:
//   1. upgrades the sotto_vault program on devnet in place (same program ID, same vault account)
//      when the deployed binary is not the one in contracts/solana/build; v2 pause reports keep working;
//   2. creates the vault's treasury config (reserve + max share per report).
//   bun run solana:enable-sweep
// Needs: the Solana CLI, CRE_SOLANA_PRIVATE_KEY (the wallet that deployed the program and owns the vault)
// and ORIGINS_SOLANA_VAULT. An upgrade temporarily needs about 2 devnet SOL for the program buffer;
// it is refunded when the upgrade completes. Optional ORIGINS_SOLANA_RESERVE (default: the owner).
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOTTO_VAULT_PROGRAM_ID, SOLANA_DEVNET_RPC, configureReserveIx, readSolanaVault, readTreasuryConfig, type TreasuryConfig } from "../cre/solana-vault";

export interface EnableSweepOptions {
  connection: Connection;
  rpcUrl: string;
  owner: Keypair;
  vault: PublicKey;
  reserve: PublicKey;
  binary?: string;
  programId?: PublicKey;
  log?: (message: string) => void;
}
/** Upgrades the program if its deployed bytes differ from the local build, then configures the vault's reserve. */
export async function enableSweep(options: EnableSweepOptions): Promise<{ upgraded: boolean; config: TreasuryConfig }> {
  const { connection, owner, vault, reserve } = options;
  const programId = options.programId ?? SOTTO_VAULT_PROGRAM_ID;
  const log = options.log ?? console.log;
  const state = await readSolanaVault(connection, vault);
  if (state.owner !== owner.publicKey.toBase58()) throw new Error(`The configured key (${owner.publicKey.toBase58()}) does not own vault ${vault.toBase58()}`);
  // The program's executable bytes live in its program-data account after a 45-byte header.
  const local = new Uint8Array(await Bun.file(options.binary ?? "contracts/solana/build/sotto_vault.so").arrayBuffer());
  const program = await connection.getAccountInfo(programId);
  if (!program?.executable) throw new Error("sotto_vault is not deployed; run bun run deploy:solana first");
  const programData = new PublicKey(program.data.subarray(4, 36));
  const deployed = await connection.getAccountInfo(programData);
  if (!deployed) throw new Error("Program data account not found");
  const HEADER = 45;
  const current = deployed.data.subarray(HEADER, HEADER + local.length);
  const upToDate = current.length === local.length && current.every((byte, i) => byte === local[i]) && deployed.data.subarray(HEADER + local.length).every((byte) => byte === 0);
  if (upToDate) log("The deployed program already matches the local build.");
  else {
    const solana = Bun.which("solana");
    if (!solana) throw new Error('Install the Solana CLI first: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"');
    const balance = await connection.getBalance(owner.publicKey);
    const bufferRent = await connection.getMinimumBalanceForRentExemption(local.length + 37);
    const room = deployed.data.length - HEADER;
    const extendRent = local.length > room ? await connection.getMinimumBalanceForRentExemption(local.length - room) : 0;
    log(`Owner ${owner.publicKey.toBase58()} has ${balance / LAMPORTS_PER_SOL} SOL; the upgrade needs about ${((bufferRent + extendRent) / LAMPORTS_PER_SOL + 0.01).toFixed(2)} SOL (the buffer part is refunded).`);
    if (balance < bufferRent + extendRent + 0.01 * LAMPORTS_PER_SOL) throw new Error(`Fund ${owner.publicKey.toBase58()} with devnet SOL at https://faucet.solana.com and run again`);
    const dir = await mkdtemp(join(tmpdir(), "sotto-upgrade-"));
    const keyFile = join(dir, "authority.json");
    await Bun.write(keyFile, JSON.stringify(Array.from(owner.secretKey)));
    try {
      const run = async (args: string[]) => {
        const proc = Bun.spawn([solana, ...args, "--keypair", keyFile, "--url", options.rpcUrl, "--commitment", "confirmed"], { stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (code !== 0) throw new Error(`solana ${args.slice(0, 2).join(" ")} failed: ${(err || out).trim().slice(-600)}`);
        return out;
      };
      // Older CLIs do not grow the program account on their own.
      if (local.length > room) await run(["program", "extend", programId.toBase58(), String(local.length - room)]);
      log("Upgrading sotto_vault in place (same program ID; existing vault accounts are untouched)…");
      await run(["program", "deploy", options.binary ?? "contracts/solana/build/sotto_vault.so", "--program-id", programId.toBase58(), "--upgrade-authority", keyFile]);
      // An upgraded program is invocable only from the slot after its deployment.
      const deployedAt = await connection.getSlot("confirmed");
      for (let i = 0; i < 60 && (await connection.getSlot("confirmed")) < deployedAt + 2; i++) await Bun.sleep(400);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  let config = await readTreasuryConfig(connection, vault);
  if (config) log(`Vault ${vault.toBase58()} already sweeps to ${config.reserve} (at most ${config.maxSweepBps / 100}% per report).`);
  else {
    const signature = await sendAndConfirmTransaction(connection, new Transaction().add(configureReserveIx(vault, owner.publicKey, reserve, 10_000, programId)), [owner], { commitment: "confirmed" });
    config = await readTreasuryConfig(connection, vault);
    if (!config || config.reserve !== reserve.toBase58()) throw new Error("Treasury config did not verify");
    log(`Vault ${vault.toBase58()} now sweeps to ${config.reserve} (configure tx ${signature}).`);
  }
  return { upgraded: !upToDate, config };
}

if (import.meta.main) {
  const secret = process.env.CRE_SOLANA_PRIVATE_KEY;
  const vaultAddress = process.env.ORIGINS_SOLANA_VAULT;
  if (!secret) throw new Error("Set CRE_SOLANA_PRIVATE_KEY in .env (the wallet that deployed the program)");
  if (!vaultAddress) throw new Error("Set ORIGINS_SOLANA_VAULT in .env (printed by bun run deploy:solana)");
  const owner = Keypair.fromSecretKey(bs58.decode(secret));
  const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
  if ((await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("RPC is not Solana devnet; refusing to upgrade");
  const result = await enableSweep({ connection, rpcUrl: SOLANA_DEVNET_RPC, owner, vault: new PublicKey(vaultAddress), reserve: new PublicKey(process.env.ORIGINS_SOLANA_RESERVE || owner.publicKey.toBase58()) });
  const record = await Bun.file("contracts/deployment.solana.json").json().catch(() => ({}));
  await Bun.write("contracts/deployment.solana.json", JSON.stringify({ ...record, reserve: result.config.reserve, ...(result.upgraded ? { programUpgradedAt: new Date().toISOString() } : {}) }, null, 2));
  console.log("Done. CRE sweeps now move SOL on Solana in the same decision as ETH on Sepolia.");
}
