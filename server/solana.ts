import { Keypair, PublicKey, SystemProgram, SystemInstruction, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SolanaTransferReceipt } from "../shared/solana-types";
export type { SolanaTransferReceipt } from "../shared/solana-types";

export type SolanaNetwork = "devnet" | "mainnet-beta";
export const SOLANA_GENESIS = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const;
const LAMPORTS = 1_000_000_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function solanaAddress(value: string): string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error("Invalid Solana address");
  try { return new PublicKey(value).toBase58(); } catch { throw new Error("Invalid Solana address"); }
}

/** Decimal parsing keeps fractional lamports and binary rounding out of transfers. */
export function solToLamports(value: number | string): number {
  let decimal = String(value);
  if (typeof value === "number" && decimal.includes("e")) {
    decimal = value.toFixed(9);
    if (Number(decimal) !== value) throw new Error("amountSol contains fractional lamports");
  }
  if (!/^(?:0|1)(?:\.\d{1,9})?$/.test(decimal)) throw new Error("amountSol must be a decimal between 0 and 1 SOL with at most 9 decimal places");
  const [whole, fraction = ""] = decimal.split(".");
  const lamports = Number(whole) * LAMPORTS + Number(fraction.padEnd(9, "0"));
  if (!Number.isSafeInteger(lamports) || lamports < 1 || lamports > LAMPORTS) throw new Error("amountSol must be greater than 0 and at most 1 SOL");
  return lamports;
}

function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`), out = "";
  while (value > 0n) { out = alphabet[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = "1" + out; }
  return out;
}
function publicRpcUrl(value: string): string {
  const u = new URL(value);
  // RPC providers put credentials in both query strings and paths (for example /v2/key).
  return `${u.protocol}//${u.host}${u.pathname === "/" ? "/" : "/[configured-endpoint]"}`;
}
function explorer(kind: "address" | "tx", value: string, network: SolanaNetwork): string {
  return `https://explorer.solana.com/${kind}/${value}${network === "devnet" ? "?cluster=devnet" : ""}`;
}

export interface SolanaDevnetActionTarget { network:"devnet";genesisHash:string;sender:string }
export interface SolanaTransferInput {
  recipient:string;amountSol:number|string;idempotencyKey:string;expectedSender?:string;expectedGenesisHash?:string;
  /** Internal synchronous persistence barrier. Never exposed as caller-supplied executable JSON. */
  onPrepared?:(signature:string)=>void;
}
interface JournalRow { fingerprint: string; payload: string; receipt: string | null }
interface IntentRow {fingerprint:string;state:string}
interface PreparedTransfer {
  signature: string; raw: string; sender: string; recipient: string; lamports: number;
  lastValidBlockHeight: number; recipientBalanceBefore: number;
}
export interface SolanaTransferRecovery {
  status:"not-submitted"|"confirmed"|"pending"|"failed"|"expired"|"uncertain";
  network:"devnet";genesisHash:typeof SOLANA_GENESIS.devnet;sender:string;recipient:string;lamports:number;idempotencyKey:string;
  checkedAt:string;fingerprint:string;signature?:string;explorerUrl?:string;receipt?:SolanaTransferReceipt;reason:string;
  lastValidBlockHeight?:number;currentBlockHeight?:number;confirmationStatus?:string;chainError?:unknown;
}

/** Public read APIs and a bounded devnet signer. No personal-wallet or mainnet signing path exists. */
export class SolanaUtilities {
  private db?: Database;
  private pending = new Map<string, {fingerprint:string;work:Promise<SolanaTransferReceipt>}>();
  constructor(private options: { dataDir?: string; rpcUrls?: Partial<Record<SolanaNetwork, string[]>>; fetch?: typeof fetch; confirmationTimeoutMs?: number } = {}) {}
  private get dataDir() { return this.options.dataDir || process.env.ORIGINS_SOLANA_DATA_DIR || ".data/solana"; }
  private endpoints(network: SolanaNetwork): string[] {
    if (network !== "devnet" && network !== "mainnet-beta") throw new Error("Unsupported Solana network");
    return this.options.rpcUrls?.[network] || (network === "devnet"
      ? [process.env.ORIGINS_SOLANA_DEVNET_RPC || "https://api.devnet.solana.com", "https://solana-devnet.g.alchemy.com/v2/demo", "https://solana-devnet.api.onfinality.io/public"]
      : [process.env.ORIGINS_SOLANA_MAINNET_RPC || "https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"]);
  }
  private async rawRpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
    const response = await (this.options.fetch || fetch)(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Solana ${method}: HTTP ${response.status}`);
    const body = await response.json() as { error?: { message?: string }; result?: T };
    if (body.error) throw new Error(`Solana ${method}: ${body.error.message || "RPC rejected request"}`);
    if (!("result" in body)) throw new Error(`Solana ${method}: invalid RPC response`);
    return body.result as T;
  }
  private async rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
    try { return await this.rawRpc<T>(url,method,params); }
    catch (firstError) {
      // RPC throttling can start after genesis validation. Fail over only to an independently
      // verified endpoint on the requested cluster; immutable signed bytes make sends retry-safe.
      if (!/HTTP (?:429|5\d\d)|rate limit|timeout|connect|fetch failed/i.test(String(firstError))) throw firstError;
      const network = (["devnet","mainnet-beta"] as const).find(n=>this.endpoints(n).includes(url));
      if (!network) throw firstError;
      for (const alternative of this.endpoints(network).filter(x=>x!==url)) {
        try {
          if (await this.rawRpc<string>(alternative,"getGenesisHash") !== SOLANA_GENESIS[network]) continue;
          return await this.rawRpc<T>(alternative,method,params);
        } catch { /* Preserve original failure if every real endpoint is unavailable. */ }
      }
      throw firstError;
    }
  }
  private async cluster(network: SolanaNetwork): Promise<{url: string; genesisHash: string}> {
    const failures: string[] = [];
    for (const url of this.endpoints(network)) {
      try {
        const hash = await this.rawRpc<string>(url, "getGenesisHash");
        if (hash !== SOLANA_GENESIS[network]) throw new Error(`RPC genesis does not match ${network}; refusing network substitution`);
        return { url, genesisHash: hash };
      } catch (error) { failures.push(`${publicRpcUrl(url)}: ${String(error)}`); }
    }
    throw new Error(`Solana ${network} unavailable: ${failures.join("; ")}`);
  }
  private wallet(create=true): Keypair {
    if(create) mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const path = join(this.dataDir, "devnet-wallet.json");
    if(create) try {
      const k = Keypair.generate();
      writeFileSync(path, JSON.stringify({ network: "devnet", address: k.publicKey.toBase58(), secretKey: Array.from(k.secretKey), createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved.network !== "devnet" || !Array.isArray(saved.secretKey) || saved.secretKey.length !== 64 || saved.secretKey.some((n: unknown) => !Number.isInteger(n) || Number(n) < 0 || Number(n) > 255)) throw new Error("Invalid task devnet wallet; refusing to replace it");
    const wallet = Keypair.fromSecretKey(Uint8Array.from(saved.secretKey));
    if (wallet.publicKey.toBase58() !== saved.address) throw new Error("Task devnet wallet address mismatch");
    return wallet;
  }
  private journal(): Database {
    if (!this.db) {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      this.db = new Database(join(this.dataDir, "operations.sqlite"));
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS transfers (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT); CREATE TABLE IF NOT EXISTS transfer_intents (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL)");
    }
    return this.db;
  }
  close() { this.db?.close(); this.db = undefined; }
  /** Verify the public cluster and freeze the task signer, without requiring a balance or faucet. */
  async getDevnetActionTarget():Promise<SolanaDevnetActionTarget> {
    await this.cluster("devnet");
    return {network:"devnet",genesisHash:SOLANA_GENESIS.devnet,sender:this.wallet().publicKey.toBase58()};
  }
  private validateTransfer(input: SolanaTransferInput,readOnly=false) {
    const recipient=solanaAddress(input.recipient),lamports=solToLamports(input.amountSol);
    if (typeof input.idempotencyKey !== "string" || !/^[\w:.-]{1,160}$/.test(input.idempotencyKey)) throw new Error("An idempotencyKey of 1–160 letters, digits, underscores, colons, dots, or hyphens is required");
    if(input.expectedGenesisHash !== undefined && input.expectedGenesisHash !== SOLANA_GENESIS.devnet) throw new Error("Frozen expectedGenesisHash does not match supported Solana devnet");
    const sender=this.wallet(!readOnly && input.expectedSender === undefined).publicKey.toBase58();
    if (input.expectedSender !== undefined) {
      const expected=solanaAddress(input.expectedSender);
      if (sender !== expected) throw new Error("Task Solana signer changed from the frozen expectedSender; refusing transfer or recovery");
    }
    return {sender,recipient,lamports,fingerprint:createHash("sha256").update(JSON.stringify({network:"devnet",genesisHash:SOLANA_GENESIS.devnet,sender,recipient,lamports})).digest("hex")};
  }
  private correlateRow(row: JournalRow,input:SolanaTransferInput,fingerprint:string): PreparedTransfer {
    const prepared=JSON.parse(row.payload) as PreparedTransfer;
    const sender=this.wallet(false).publicKey.toBase58();
    if(prepared.sender !== sender) throw new Error("Saved Solana transfer sender does not match the current immutable task signer");
    if(input.expectedSender !== undefined && prepared.sender !== input.expectedSender) throw new Error("Saved Solana transfer sender does not match frozen expectedSender");
    if(prepared.recipient !== input.recipient || prepared.lamports !== solToLamports(input.amountSol)) throw new Error("Idempotency key already belongs to a different transfer; saved target does not match immutable input");
    this.verifyPreparedBytes(prepared,input.idempotencyKey);
    if(row.fingerprint !== fingerprint) {
      // Migrate the original bounded devnet journal only after correlating its actual signer
      // and complete target. Existing public receipt evidence stays associated with its wallet.
      const legacy=createHash("sha256").update(JSON.stringify({network:"devnet",recipient:input.recipient,lamports:solToLamports(input.amountSol)})).digest("hex");
      if(row.fingerprint !== legacy) throw new Error("Idempotency key already belongs to a different transfer");
      this.journal().query("UPDATE transfers SET fingerprint = ? WHERE operation_id = ? AND fingerprint = ?").run(fingerprint,input.idempotencyKey,legacy);
      row.fingerprint=fingerprint;
    }
    if(row.receipt) {
      const receipt=JSON.parse(row.receipt) as SolanaTransferReceipt;
      if(receipt.signature !== prepared.signature || receipt.sender !== prepared.sender || receipt.recipient !== prepared.recipient || receipt.lamports !== prepared.lamports || receipt.network !== "devnet" || receipt.idempotencyKey !== input.idempotencyKey)
        throw new Error("Saved Solana receipt does not match its immutable transfer");
    }
    return prepared;
  }
  private verifyPreparedBytes(prepared:PreparedTransfer,id:string) {
    try {
      const tx=Transaction.from(Buffer.from(prepared.raw,"base64"));
      const transfer=SystemInstruction.decodeTransfer(tx.instructions[0]!);
      const memo=tx.instructions[1];
      const expectedMemo=`origins:${createHash("sha256").update(`devnet:${prepared.sender}:${id}`).digest("hex")}`;
      if(!tx.verifySignatures() || !tx.signature || base58(tx.signature) !== prepared.signature || tx.feePayer?.toBase58() !== prepared.sender ||
        transfer.fromPubkey.toBase58() !== prepared.sender || transfer.toPubkey.toBase58() !== prepared.recipient || transfer.lamports !== BigInt(prepared.lamports) ||
        tx.instructions.length !== 2 || memo?.programId.toBase58() !== "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" || memo.data.toString("utf8") !== expectedMemo)
        throw new Error("Signed transaction mismatch");
    }catch { throw new Error("Saved signed Solana transaction does not match immutable sender, recipient, amount, signature, or operation memo"); }
  }
  async getDevnetWallet() {
    const wallet = this.wallet(), address = wallet.publicKey.toBase58();
    const {url, genesisHash} = await this.cluster("devnet");
    const balance = await this.rpc<{value: number}>(url, "getBalance", [address, {commitment:"confirmed"}]);
    return {address, network:"devnet" as const, balanceLamports:balance.value, balanceSol:balance.value / LAMPORTS,
      explorerUrl:explorer("address",address,"devnet"),rpcUrl:publicRpcUrl(url),genesisHash};
  }
  async inspectWallet(input: {address: string; network?: SolanaNetwork; limit?: number}) {
    const address = solanaAddress(input.address), network = input.network || "devnet", limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Wallet activity limit must be an integer between 1 and 20");
    const {url, genesisHash} = await this.cluster(network);
    const [balance, signatures] = await Promise.all([
      this.rpc<{context:{slot:number};value:number}>(url,"getBalance",[address,{commitment:"confirmed"}]),
      this.rpc<Array<{signature:string;slot:number;blockTime:number|null;err:unknown}>>(url,"getSignaturesForAddress",[address,{limit,commitment:"confirmed"}]),
    ]);
    const activity = [];
    for (const row of signatures) {
      const transaction = await this.rpc<any>(url,"getTransaction",[row.signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:1}]);
      if (!transaction) { activity.push({...row,available:false,explorerUrl:explorer("tx",row.signature,network)}); continue; }
      const keys = transaction.transaction.message.accountKeys;
      const index = keys.findIndex((k:any) => (typeof k === "string" ? k : k.pubkey) === address);
      const instructions = [...transaction.transaction.message.instructions, ...(transaction.meta?.innerInstructions || []).flatMap((r:any)=>r.instructions)];
      activity.push({ signature:row.signature,slot:row.slot,blockTime:row.blockTime === null ? null : new Date(row.blockTime * 1000).toISOString(),
        success:transaction.meta?.err === null, feeLamports:transaction.meta?.fee ?? null,
        balanceDeltaLamports:index >= 0 && transaction.meta ? transaction.meta.postBalances[index]-transaction.meta.preBalances[index] : null,
        nativeTransfers:instructions.filter((i:any)=>i.program === "system" && i.parsed?.type === "transfer").map((i:any)=>i.parsed.info),
        tokenBalanceChanges:transaction.meta ? {before:transaction.meta.preTokenBalances || [],after:transaction.meta.postTokenBalances || []} : null,
        programs:[...new Set(instructions.map((i:any)=>i.programId).filter(Boolean))], available:true,explorerUrl:explorer("tx",row.signature,network) });
    }
    return {address,network,balanceLamports:balance.value,balanceSol:balance.value/LAMPORTS,slot:balance.context.slot,
      activity,explorerUrl:explorer("address",address,network),rpcUrl:publicRpcUrl(url),genesisHash,fetchedAt:new Date().toISOString(),
      capabilities:{activityInspection:true,nativeTransfer:network === "devnet",copyTradingSwaps:false},
      historyComplete:false,historyLabel:`Latest ${limit} confirmed signatures; pagination and swap classification are not provided`};
  }
  async requestDevnetAirdrop(amountSol = 0.1) {
    const lamports = solToLamports(amountSol), wallet = this.wallet(), address = wallet.publicKey.toBase58();
    const {url} = await this.cluster("devnet");
    const signature = await this.rpc<string>(url,"requestAirdrop",[address,lamports]);
    await this.confirm(url,signature);
    return {address,signature,network:"devnet" as const,explorerUrl:explorer("tx",signature,"devnet")};
  }
  async transferDevnet(input: SolanaTransferInput): Promise<SolanaTransferReceipt> {
    input={...input};
    const {sender,recipient,lamports,fingerprint}=this.validateTransfer(input);
    input={...input,expectedSender:sender,expectedGenesisHash:SOLANA_GENESIS.devnet};
    const cached = this.journal().query("SELECT * FROM transfers WHERE operation_id = ?").get(input.idempotencyKey) as JournalRow | null;
    if (cached) this.correlateRow(cached,input,fingerprint);
    // Reserve immutable intent before the first asynchronous RPC. Another process recovering
    // an interrupted action can distinguish an unstarted run from an executor still preparing.
    this.journal().query("INSERT OR IGNORE INTO transfer_intents(operation_id,fingerprint,state) VALUES(?,?,?)").run(input.idempotencyKey,fingerprint,cached?"prepared":"preparing");
    const intent=this.journal().query("SELECT * FROM transfer_intents WHERE operation_id = ?").get(input.idempotencyKey) as IntentRow;
    if(intent.fingerprint !== fingerprint) throw new Error("Idempotency key already belongs to a different transfer intent");
    if (cached?.receipt) {
      const receipt={...JSON.parse(cached.receipt),replayed:true} as SolanaTransferReceipt;
      input.onPrepared?.(receipt.signature);
      return receipt;
    }
    const active = this.pending.get(input.idempotencyKey);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new Error("Idempotency key already belongs to a different transfer");
      return {...await active.work,replayed:true};
    }
    const work = this.performTransfer(input,recipient,lamports,fingerprint);
    this.pending.set(input.idempotencyKey,{fingerprint,work});
    try { return await work; }
    catch(error) {
      if(!this.journal().query("SELECT operation_id FROM transfers WHERE operation_id = ?").get(input.idempotencyKey))
        this.journal().query("UPDATE transfer_intents SET state = 'preparation-failed' WHERE operation_id = ?").run(input.idempotencyKey);
      throw error;
    }finally { this.pending.delete(input.idempotencyKey); }
  }
  private async performTransfer(input:SolanaTransferInput, recipient: string, lamports: number, fingerprint: string): Promise<SolanaTransferReceipt> {
    const id=input.idempotencyKey;
    const {url} = await this.cluster("devnet");
    let row = this.journal().query("SELECT * FROM transfers WHERE operation_id = ?").get(id) as JournalRow | null;
    if (!row) {
      const wallet = this.wallet(), sender = wallet.publicKey.toBase58();
      if(input.expectedSender !== undefined && sender !== input.expectedSender) throw new Error("Task Solana signer changed from frozen expectedSender before signing");
      if (recipient === sender) throw new Error("Recipient must differ from the task wallet");
      const recipientKey = new PublicKey(recipient);
      if (!PublicKey.isOnCurve(recipientKey.toBytes())) throw new Error("Devnet SOL recipient must be an on-curve wallet address");
      const [balance,before,latest,rent] = await Promise.all([
        this.rpc<{value:number}>(url,"getBalance",[sender,{commitment:"confirmed"}]),
        this.rpc<{value:number}>(url,"getBalance",[recipient,{commitment:"confirmed"}]),
        this.rpc<{value:{blockhash:string;lastValidBlockHeight:number}}>(url,"getLatestBlockhash",[{commitment:"confirmed"}]),
        this.rpc<number>(url,"getMinimumBalanceForRentExemption",[0]),
      ]);
      if (before.value === 0 && lamports < rent) throw new Error(`New recipient requires at least ${rent / LAMPORTS} SOL for rent exemption`);
      const transaction = new Transaction({feePayer:wallet.publicKey,recentBlockhash:latest.value.blockhash})
        .add(SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:recipientKey,lamports}));
      // Separate intents with the same amount/recipient must not collapse to the same signature
      // when the RPC returns the same recent blockhash. Hash the operation ID to avoid publishing it.
      transaction.add(new TransactionInstruction({
        keys:[], programId:new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        data:Buffer.from(`origins:${createHash("sha256").update(`devnet:${sender}:${id}`).digest("hex")}`),
      }));
      const fee = await this.rpc<{value:number|null}>(url,"getFeeForMessage",[transaction.serializeMessage().toString("base64"),{commitment:"confirmed"}]);
      if (fee.value === null) throw new Error("Solana could not estimate transfer fee");
      if (balance.value < lamports + fee.value) throw new Error(`Task devnet wallet is underfunded: needs ${(lamports + fee.value) / LAMPORTS} SOL; faucet funding is required`);
      transaction.sign(wallet);
      const payload: PreparedTransfer = {signature:base58(transaction.signature!),raw:transaction.serialize().toString("base64"),sender,recipient,lamports,
        lastValidBlockHeight:latest.value.lastValidBlockHeight,recipientBalanceBefore:before.value};
      // Persist signed bytes before broadcast. Restarts/retries always resend this exact signature.
      this.journal().query("INSERT OR IGNORE INTO transfers (operation_id,fingerprint,payload) VALUES (?,?,?)").run(id,fingerprint,JSON.stringify(payload));
      this.journal().query("UPDATE transfer_intents SET state = 'prepared' WHERE operation_id = ?").run(id);
      row = this.journal().query("SELECT * FROM transfers WHERE operation_id = ?").get(id) as JournalRow;
    }
    const prepared=this.correlateRow(row,input,fingerprint);
    // The callback must durably record the known signature before any send can occur.
    // If it throws, signed bytes remain recoverable, and no broadcast happens here.
    input.onPrepared?.(prepared.signature);
    if (row.receipt) return {...JSON.parse(row.receipt),replayed:true};
    // A conditional policy's frozen signer must still match immediately before broadcasting.
    if(this.wallet(false).publicKey.toBase58() !== prepared.sender || (input.expectedSender !== undefined && prepared.sender !== input.expectedSender)) throw new Error("Task Solana signer changed from frozen expectedSender before broadcast");
    const existing = await this.status(url,prepared.signature);
    if (existing?.err) throw new Error(`Solana transfer failed on chain: ${JSON.stringify(existing.err)}`);
    if (!existing || !["confirmed","finalized"].includes(existing.confirmationStatus)) {
      const height = await this.rpc<number>(url,"getBlockHeight",[{commitment:"confirmed"}]);
      if (height > prepared.lastValidBlockHeight) throw new Error(`Saved Solana transaction expired; ${id} cannot be reused. Inspect ${prepared.signature} before creating another transfer`);
      const signature = await this.rpc<string>(url,"sendTransaction",[prepared.raw,{encoding:"base64",skipPreflight:false,preflightCommitment:"confirmed",maxRetries:3}]);
      if (signature !== prepared.signature) throw new Error("RPC returned an unexpected transaction signature");
    }
    await this.confirm(url,prepared.signature);
    let tx: any = null;
    for (let attempt = 0; attempt < 8 && !tx; attempt++) {
      tx = await this.rpc<any>(url,"getTransaction",[prepared.signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:1}]);
      if (!tx) await sleep(700);
    }
    const receipt=this.verifyReceipt(tx,prepared,id,false);
    this.journal().query("UPDATE transfers SET receipt = ? WHERE operation_id = ?").run(JSON.stringify(receipt),id);
    this.journal().query("UPDATE transfer_intents SET state = 'confirmed' WHERE operation_id = ?").run(id);
    return receipt;
  }
  private verifyReceipt(tx:any,prepared:PreparedTransfer,id:string,replayed:boolean):SolanaTransferReceipt {
    const {recipient,lamports}=prepared;
    if (!tx?.meta || tx.meta.err !== null) throw new Error("Confirmed Solana transfer receipt is unavailable or unsuccessful; replay this operation to recover evidence");
    if(!Array.isArray(tx.transaction?.signatures) || !tx.transaction.signatures.includes(prepared.signature)) throw new Error("On-chain receipt signature does not match the saved signed transaction");
    const matching = tx.transaction.message.instructions.some((i:any)=>i.program === "system" && i.parsed?.type === "transfer" && i.parsed.info.source === prepared.sender && i.parsed.info.destination === recipient && i.parsed.info.lamports === lamports);
    const recipientIndex = tx.transaction.message.accountKeys.findIndex((k:any)=>(typeof k === "string" ? k : k.pubkey) === recipient);
    if (!matching || recipientIndex < 0 || tx.meta.postBalances[recipientIndex] - tx.meta.preBalances[recipientIndex] !== lamports) throw new Error("On-chain transfer receipt does not match requested recipient and amount");
    const receipt: SolanaTransferReceipt = {network:"devnet",status:"confirmed",signature:prepared.signature,sender:prepared.sender,recipient,lamports,amountSol:lamports/LAMPORTS,
      slot:tx.slot,feeLamports:tx.meta.fee,blockTime:tx.blockTime == null ? null : new Date(tx.blockTime*1000).toISOString(),
      explorerUrl:explorer("tx",prepared.signature,"devnet"),recipientBalanceBefore:tx.meta.preBalances[recipientIndex],recipientBalanceAfter:tx.meta.postBalances[recipientIndex],idempotencyKey:id,replayed};
    return receipt;
  }
  /** Reads journal + real chain evidence only. Never signs, sends, or restarts a transfer. */
  async reconcileDevnetTransfer(input:SolanaTransferInput):Promise<SolanaTransferRecovery> {
    input={...input};
    const {sender,recipient,lamports,fingerprint}=this.validateTransfer(input,true);
    input={...input,expectedSender:sender,expectedGenesisHash:SOLANA_GENESIS.devnet};
    const base={network:"devnet" as const,genesisHash:SOLANA_GENESIS.devnet,sender,recipient,lamports,fingerprint,idempotencyKey:input.idempotencyKey,checkedAt:new Date().toISOString()};
    const row=this.journal().query("SELECT * FROM transfers WHERE operation_id = ?").get(input.idempotencyKey) as JournalRow|null;
    if(!row) {
      const intent=this.journal().query("SELECT * FROM transfer_intents WHERE operation_id = ?").get(input.idempotencyKey) as IntentRow|null;
      if(intent?.fingerprint && intent.fingerprint !== fingerprint) throw new Error("Idempotency key already belongs to a different transfer intent");
      if(this.pending.has(input.idempotencyKey)) return {...base,status:"pending",reason:"An in-flight executor is still preparing this transfer; recovery cannot declare it absent"};
      if(intent) return {...base,status:"uncertain",reason:`A durable transfer intent exists (${intent.state}), but signed bytes were not prepared. Recovery cannot infer that another executor has stopped`};
      return {...base,status:"not-submitted",reason:"No transfer intent, signed transaction, or in-flight call exists in the task journal for this operation"};
    }
    const prepared=this.correlateRow(row,input,fingerprint);
    if(prepared.sender !== sender) throw new Error("Saved Solana transfer sender does not match current task signer");
    const correlated={...base,signature:prepared.signature,explorerUrl:explorer("tx",prepared.signature,"devnet"),lastValidBlockHeight:prepared.lastValidBlockHeight};
    try {
      const {url}=await this.cluster("devnet");
      const [status,tx]=await Promise.all([
        this.status(url,prepared.signature),
        this.rpc<any>(url,"getTransaction",[prepared.signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:1}]),
      ]);
      if(tx?.meta && tx.meta.err === null) {
        const receipt=this.verifyReceipt(tx,prepared,input.idempotencyKey,true);
        this.journal().query("UPDATE transfers SET receipt = ? WHERE operation_id = ?").run(JSON.stringify({...receipt,replayed:false}),input.idempotencyKey);
        this.journal().query("UPDATE transfer_intents SET state = 'confirmed' WHERE operation_id = ?").run(input.idempotencyKey);
        return {...correlated,status:"confirmed",receipt,checkedAt:new Date().toISOString(),reason:"Fresh devnet receipt verifies the exact sender, recipient, lamports, and recipient balance change"};
      }
      if((tx?.meta?.err != null) || (status?.err != null && ["confirmed","finalized"].includes(status.confirmationStatus)))
        return {...correlated,status:"failed",chainError:tx?.meta?.err ?? status?.err,checkedAt:new Date().toISOString(),reason:"Confirmed chain evidence records a failed transaction; it cannot become a successful transfer"};
      if(status) return {...correlated,status:"pending",confirmationStatus:status.confirmationStatus,checkedAt:new Date().toISOString(),reason:"Transaction is known to devnet but its successful settlement receipt is not yet verified"};
      const height=await this.rpc<number>(url,"getBlockHeight",[{commitment:"finalized"}]);
      if(row.receipt) return {...correlated,status:"uncertain",currentBlockHeight:height,checkedAt:new Date().toISOString(),reason:"An archived confirmed receipt exists, but current devnet does not expose its transaction; no absence or duplicate-send permission is inferred"};
      if(height > prepared.lastValidBlockHeight && tx === null) {
        // Re-read history only after finalized height proves expiration, so a transfer that
        // landed between the first lookup and the height read cannot become an absence proof.
        const [afterStatus,afterTx]=await Promise.all([
          this.status(url,prepared.signature),
          this.rpc<any>(url,"getTransaction",[prepared.signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:1}]),
        ]);
        if(afterStatus || afterTx) return {...correlated,status:"pending",currentBlockHeight:height,checkedAt:new Date().toISOString(),reason:"Chain evidence changed during expiration verification; reconcile again without resubmission"};
        return {...correlated,status:"expired",currentBlockHeight:height,checkedAt:new Date().toISOString(),reason:"Fresh devnet history status and transaction are both absent after finalized height exceeded the signed blockhash expiration; this operation remains stopped"};
      }
      return {...correlated,status:"pending",currentBlockHeight:height,checkedAt:new Date().toISOString(),reason:"Prepared signature is not currently found, but its blockhash can still land; no new submission is permitted"};
    }catch(error) {
      return {...correlated,status:"uncertain",checkedAt:new Date().toISOString(),reason:`Read-only recovery cannot establish settlement: ${String(error)}`};
    }
  }
  private async status(url: string, signature: string) {
    const result = await this.rpc<{value:Array<{err:unknown;confirmationStatus:string}|null>}>(url,"getSignatureStatuses",[[signature],{searchTransactionHistory:true}]);
    return result.value[0];
  }
  private async confirm(url: string, signature: string) {
    const deadline = Date.now() + (this.options.confirmationTimeoutMs ?? 45_000);
    while (Date.now() < deadline) {
      const status = await this.status(url,signature);
      if (status?.err) throw new Error(`Solana transaction failed: ${JSON.stringify(status.err)}`);
      if (status && ["confirmed","finalized"].includes(status.confirmationStatus)) return;
      await sleep(1_000);
    }
    throw new Error(`Solana confirmation timed out for ${signature}; replay the same operation to recover without sending twice`);
  }
}

const defaultUtilities = new SolanaUtilities();
export const inspectSolanaWallet = (input: {address:string;network?:SolanaNetwork;limit?:number}) => defaultUtilities.inspectWallet(input);
export const getSolanaDevnetWallet = () => defaultUtilities.getDevnetWallet();
export const getSolanaDevnetActionTarget = () => defaultUtilities.getDevnetActionTarget();
export const transferSolanaDevnet = (input: SolanaTransferInput) => defaultUtilities.transferDevnet(input);
export const reconcileSolanaDevnetTransfer = (input:SolanaTransferInput) => defaultUtilities.reconcileDevnetTransfer(input);
