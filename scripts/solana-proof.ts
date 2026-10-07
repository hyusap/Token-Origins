import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { SOLANA_DEVNET_RPC, payGrantIx, readSolanaVault, resumeIx, solanaExplorer } from "../cre/solana-vault";
import type { ExecutionEvidence } from "../cre/runner";

const check = (condition: unknown, message: string) => { if (!condition) throw new Error(`Proof failed: ${message}`); };

/** The Solana half of the multichain proof, or undefined when no Solana vault is configured. */
export async function solanaLeg() {
  const vaultAddress = process.env.ORIGINS_SOLANA_VAULT;
  if (!vaultAddress) return undefined;
  const secret = process.env.CRE_SOLANA_PRIVATE_KEY;
  if (!secret) throw new Error("ORIGINS_SOLANA_VAULT is set but CRE_SOLANA_PRIVATE_KEY is not");
  const owner = Keypair.fromSecretKey(bs58.decode(secret));
  const vault = new PublicKey(vaultAddress);
  const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
  const state = await readSolanaVault(connection, vault);
  check(state.owner === owner.publicKey.toBase58(), "CRE_SOLANA_PRIVATE_KEY is not the Solana vault owner, so the proof could not resume it");
  const recipient = Keypair.generate().publicKey;
  const grant = BigInt(Math.round(Number(process.env.ORIGINS_SOLANA_GRANT_SOL || 0.01) * LAMPORTS_PER_SOL));
  const pay = () => sendAndConfirmTransaction(connection, new Transaction().add(payGrantIx(vault, owner.publicKey, recipient, grant)), [owner], { commitment: "confirmed" });
  const deployment = await Bun.file("contracts/deployment.solana.json").json().catch(() => ({ vault: vaultAddress }));
  return {
    deployment,
    isPaused: async () => (await readSolanaVault(connection, vault)).paused,
    resume: async () => sendAndConfirmTransaction(connection, new Transaction().add(resumeIx(vault, owner.publicKey)), [owner], { commitment: "confirmed" }),
    grantMustSucceed: async () => {
      console.log(`  Solana: paying a ${Number(grant) / LAMPORTS_PER_SOL} SOL grant while spending is active`);
      const signature = await pay();
      return { solanaGrantPaid: { signature, explorer: solanaExplorer(signature), recipient: recipient.toBase58(), lamports: Number(grant) } };
    },
    grantMustBeRefused: async (evidence: ExecutionEvidence) => {
      check(evidence.solana?.verified, "the CRE decision must also have paused the Solana vault");
      console.log(`  Solana: vault paused by CRE (${evidence.solana!.explorerUrl}); the next grant must be refused onchain`);
      try {
        const signature = await pay();
        throw new Error(`Proof failed: a grant was paid while paused (${signature})`);
      } catch (error: any) {
        const text = String(error?.transactionLogs?.join("\n") ?? error?.message ?? error);
        check(/SpendingIsPaused/.test(text), `grant failed for the wrong reason: ${text.slice(0, 300)}`);
        return { solanaGrantRefused: { error: "SpendingIsPaused", recipient: recipient.toBase58() } };
      }
    },
  };
}
