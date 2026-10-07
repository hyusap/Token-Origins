/** Pure settlement types shared by the server, UI and CRE graph bundle. */
export interface SolanaTransferReceipt {
  network: "devnet"; status: "confirmed"; signature: string; sender: string; recipient: string;
  lamports: number; amountSol: number; slot: number; feeLamports: number; blockTime: string | null;
  explorerUrl: string; recipientBalanceBefore: number; recipientBalanceAfter: number;
  idempotencyKey: string; replayed: boolean;
}
