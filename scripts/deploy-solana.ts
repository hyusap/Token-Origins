// Deploys the sotto_vault program to Solana devnet and creates a funded vault
// that CRE's simulation forwarder can pause.
//   bun run deploy:solana
// Needs: the Solana CLI (`solana`), CRE_SOLANA_PRIVATE_KEY in .env (base58 secret
// key of a devnet wallet with ~5 SOL). That wallet becomes the vault owner.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { mkdir } from "node:fs/promises";
import { SOTTO_VAULT_PROGRAM_ID, SIMULATION_FORWARDER, SOLANA_DEVNET_RPC, initializeIx, readSolanaVault, solanaExplorer } from "../cre/solana-vault";

const secret = process.env.CRE_SOLANA_PRIVATE_KEY;
if (!secret) throw new Error("Set CRE_SOLANA_PRIVATE_KEY in .env (run: bun run solana:wallet)");
const owner = Keypair.fromSecretKey(bs58.decode(secret));
const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
if ((await connection.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("RPC is not Solana devnet; refusing to deploy");
const solana = Bun.which("solana");
if (!solana) throw new Error('Install the Solana CLI first: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"');
const balance = await connection.getBalance(owner.publicKey);
console.log(`Owner ${owner.publicKey.toBase58()} has ${balance / LAMPORTS_PER_SOL} devnet SOL`);

const program = await connection.getAccountInfo(SOTTO_VAULT_PROGRAM_ID);
if (program?.executable) {
  console.log(`Program ${SOTTO_VAULT_PROGRAM_ID.toBase58()} already deployed; reusing it.`);
} else {
  if (balance < 3.5 * LAMPORTS_PER_SOL) throw new Error(`Deploying needs ~3.5 devnet SOL for program rent; fund ${owner.publicKey.toBase58()} at https://faucet.solana.com`);
  await mkdir(".data", { recursive: true });
  const keyFile = ".data/solana-deployer.json";
  await Bun.write(keyFile, JSON.stringify(Array.from(owner.secretKey)));
  console.log("Deploying contracts/solana/build/sotto_vault.so (takes a minute)…");
  const deploy = Bun.spawn([solana, "program", "deploy", "contracts/solana/build/sotto_vault.so", "--program-id", "contracts/solana/keys/sotto_vault-keypair.json", "--keypair", keyFile, "--url", SOLANA_DEVNET_RPC, "--commitment", "confirmed"], { stdout: "inherit", stderr: "inherit" });
  const code = await deploy.exited;
  await Bun.write(keyFile, "");
  if (code !== 0) throw new Error("solana program deploy failed; see output above");
}

const vault = Keypair.generate();
const deposit = Number(process.env.ORIGINS_SOLANA_VAULT_DEPOSIT_SOL || 0.5);
const signature = await sendAndConfirmTransaction(connection, new Transaction().add(
  initializeIx(vault.publicKey, owner.publicKey, SIMULATION_FORWARDER.program, Number(process.env.ORIGINS_REPORT_AGE_SECONDS || 300)),
  SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: vault.publicKey, lamports: Math.round(deposit * LAMPORTS_PER_SOL) }),
), [owner, vault], { commitment: "confirmed" });
const state = await readSolanaVault(connection, vault.publicKey);
if (state.owner !== owner.publicKey.toBase58() || state.forwarderProgram !== SIMULATION_FORWARDER.program.toBase58() || state.paused)
  throw new Error("Vault did not initialize as expected");
const deployment = {
  network: "solana-devnet", programId: SOTTO_VAULT_PROGRAM_ID.toBase58(), vault: vault.publicKey.toBase58(), owner: owner.publicKey.toBase58(),
  forwarderProgram: SIMULATION_FORWARDER.program.toBase58(), forwarderState: SIMULATION_FORWARDER.state.toBase58(),
  maxReportAgeSeconds: state.maxReportAge, depositSol: deposit, initSignature: signature, explorer: solanaExplorer(signature), createdAt: new Date().toISOString(),
};
await Bun.write("contracts/deployment.solana.json", JSON.stringify(deployment, null, 2));
console.log(JSON.stringify(deployment, null, 2));
console.log(`\nAdd to your .env:\nORIGINS_SOLANA_VAULT=${vault.publicKey.toBase58()}`);
