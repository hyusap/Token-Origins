// Creates a Solana devnet wallet for CRE writes and the vault owner, saving the
// secret to .env (never printed) and showing only the address to fund.
//   bun run solana:wallet
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
const existing = await Bun.file(".env").text().catch(() => "");
const current = existing.match(/^CRE_SOLANA_PRIVATE_KEY=(.+)$/m)?.[1];
const wallet = current ? Keypair.fromSecretKey(bs58.decode(current.trim())) : Keypair.generate();
if (!current) await Bun.write(".env", `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}CRE_SOLANA_PRIVATE_KEY=${bs58.encode(wallet.secretKey)}\n`);
console.log(`${current ? "Existing" : "New"} Solana devnet wallet: ${wallet.publicKey.toBase58()}`);
console.log("Fund it with ~5 devnet SOL at https://faucet.solana.com, then run: bun run deploy:solana");
