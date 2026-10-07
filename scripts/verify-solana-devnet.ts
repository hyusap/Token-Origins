import { Keypair } from "@solana/web3.js";
import { SolanaUtilities, type SolanaDevnetActionTarget } from "../server/solana";
import { mkdirSync, writeFileSync } from "node:fs";

// Real devnet only: no local validator, fake transaction, or substitute network is accepted.
const utilities = new SolanaUtilities();
const evidencePath = ".data/solana/evidence.devnet.json";
let target:SolanaDevnetActionTarget|undefined;
let recipient:string|undefined;
try {
  // Fix exact network, signer, generated recipient, and amount before requesting funding.
  target=await utilities.getDevnetActionTarget();
  const recipientFile = Bun.file(".data/solana/verification-recipient.json");
  if (!(await recipientFile.exists())) {
    const recipient = Keypair.generate();
    mkdirSync(".data/solana",{recursive:true,mode:0o700});
    writeFileSync(recipientFile.name!,JSON.stringify({network:"devnet",address:recipient.publicKey.toBase58(),secretKey:Array.from(recipient.secretKey)}),{flag:"wx",mode:0o600});
  }
  // BunFile caches its initial size; reopen after the exclusive node:fs creation.
  recipient=(await Bun.file(".data/solana/verification-recipient.json").json()).address;
  let wallet = await utilities.getDevnetWallet();
  let funding: unknown = null;
  if (wallet.balanceLamports < 1_010_000) {
    funding = await utilities.requestDevnetAirdrop(0.1);
    wallet = await utilities.getDevnetWallet();
  }
  const args = {recipient:recipient!,amountSol:0.001,idempotencyKey:"verify-solana-devnet-v1",expectedSender:target.sender,expectedGenesisHash:target.genesisHash};
  const receipt = await utilities.transferDevnet(args);
  const replay = await utilities.transferDevnet(args);
  if (receipt.signature !== replay.signature || !replay.replayed) throw new Error("Replay did not preserve the confirmed signature");
  const recovered=await utilities.reconcileDevnetTransfer(args);
  if(recovered.status !== "confirmed" || recovered.receipt?.signature !== receipt.signature) throw new Error("Read-only recovery did not verify the exact transfer");
  const activity = await utilities.inspectWallet({address:recipient!,limit:3});
  if (!activity.activity.some(row => row.signature === receipt.signature)) throw new Error("Confirmed transfer is missing from recipient wallet activity");
  utilities.close();
  const restarted = new SolanaUtilities();
  const persistedReplay = await restarted.transferDevnet(args);
  if (persistedReplay.signature !== receipt.signature || !persistedReplay.replayed) throw new Error("Restart lost transfer deduplication");
  restarted.close();
  const evidence = {verified:true,verifiedAt:new Date().toISOString(),network:"devnet",target,wallet,funding,receipt,recovered,
    replaySameSignature:true,restartReplaySameSignature:true,readOnlyRecoveryVerified:true,recipientActivityVerified:true,activity};
  await Bun.write(evidencePath,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} catch(error) {
  const failure = {verified:false,verifiedAt:new Date().toISOString(),network:"devnet",error:String(error),
    frozenTarget:target,intendedTransfer:recipient?{recipient,amountLamports:1_000_000}:undefined,
    note:"Real verification failed. No mocked transfer or local-chain proof is substituted."};
  await Bun.write(".data/solana/verification.failure.json",JSON.stringify(failure,null,2));
  console.error(JSON.stringify(failure,null,2));
  process.exitCode = 1;
} finally { utilities.close(); }
