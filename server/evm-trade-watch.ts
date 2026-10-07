import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isAddress } from "viem";
import { validatePredicate, predicateHash, evaluatePredicate, type PredicateGraph, type GraphInputs, type GraphResult, type Observation } from "../cre/graph";

/** The concrete adapter must use the task-wallet journal and verified V2 swap decoder. */
export interface FrozenTradeVenue {
  network: string; venueId: string; chainId: number; genesisHash: string;
  signer: string; router: string; factory: string; pair: string; token0: string; token1: string;
  routerCodeHash: string; factoryCodeHash: string; pairCodeHash: string; headBlock: string; headBlockHash: string;
}
export interface WatchedLeaderTrade {
  transactionHash: string; blockNumber: string; blockHash: string; logIndex: number;
  leader: string; router: string; pair: string; tokenIn: string; tokenOut: string; amountInRaw: string;
}
export interface TradeWatchExecution {
  operationId: string; sourceTransactionHash: string; chainId: number; signer: string;
  tokenIn: string; tokenOut: string; amountInRaw: string;
  status: "confirmed" | "not-submitted" | "reverted" | "uncertain";
  transactionHash?: string; blockNumber?: string; amountOutRaw?: string; error?: string;
}
export interface TradeWatchPredicate { graph: PredicateGraph; exchangeMaxAgeSeconds: number; vaultTarget?: { chainId: number; address: string } }
export interface TradeWatchGate { predicateHash: string; inputs: GraphInputs; result: GraphResult; evaluatedAt: string; observations?: Observation[] }
export interface TradeWatchAdapter {
  evaluatePredicate?(predicate: TradeWatchPredicate, venue: FrozenTradeVenue): Promise<TradeWatchGate>;
  freeze(input: { network: string; venueId: string }): Promise<FrozenTradeVenue>;
  /** Verify frozen code, genesis, signer and token identities every check. */
  confirmedHead(venue: FrozenTradeVenue): Promise<string>;
  blockHash(venue: FrozenTradeVenue, blockNumber: string): Promise<string>;
  /** Return only receipt-verified leader swaps, in the inclusive confirmed range. */
  scan(venue: FrozenTradeVenue, leader: string, fromBlock: string, toBlock: string): Promise<WatchedLeaderTrade[]>;
  execute(input: { venue: FrozenTradeVenue; trade: WatchedLeaderTrade; operationId: string; amountInRaw: string; slippageBps: number; beforeBroadcast: () => Promise<boolean> }): Promise<TradeWatchExecution>;
  /** Read-only journal/receipt recovery: never sign or resubmit here. */
  reconcile(input: { venue: FrozenTradeVenue; attempt: TradeWatchAttempt }): Promise<TradeWatchExecution>;
}
export interface TradeWatchActivation {
  activationId: string; sessionId: string; network: string; venueId: string; leader: string;
  startBlock: "next" | string; tokenIn: string; tokenOut: string; predicate?: TradeWatchPredicate; proportionBps: number; perTradeInputCapRaw: string;
  cumulativeInputCapRaw: string; slippageBps: number; maxTrades: number; intervalSeconds: number;
}
export interface EvmTradeWatch {
  id: string; sessionId: string; status: "active" | "checking" | "paused" | "completed" | "failed" | "uncertain";
  config: Omit<TradeWatchActivation, "activationId" | "sessionId">; venue: FrozenTradeVenue;
  nextBlock: string; cursorAnchor?: { blockNumber: string; blockHash: string }; createdAt: string; updatedAt: string; nextCheckAt?: string;
  checks: number; failures: number; reservedTrades: number; reservedInputRaw: string;
  conditionHash?: string;
  skippedEvents: { sourceTransactionHash: string; reason: string; at: string; gate?: TradeWatchGate }[];
  pendingAttemptId?: string; lastError?: string; stopReason?: string;
  logs: { at: string; message: string }[];
}
export interface TradeWatchAttempt {
  id: string; watchId: string; operationId: string; source: WatchedLeaderTrade; amountInRaw: string;
  status: "reserved" | "confirmed" | "not-submitted" | "reverted" | "uncertain";
  createdAt: string; updatedAt: string; gate?: TradeWatchGate; execution?: TradeWatchExecution; error?: string;
}
export interface TradeWatchOptions { now?: () => number; scheduling?: boolean; onChange?: (watch: EvmTradeWatch) => void }
const clone = <T>(v: T): T => structuredClone(v);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const raw = (v: string, positive = true) => {
  if (!/^(0|[1-9]\d*)$/.test(v) || v.length > 78 || (positive && BigInt(v) === 0n) || BigInt(v) >= 2n ** 256n) throw new Error("Amounts and blocks must be canonical bounded raw integers");
  return BigInt(v);
};
const address = (v: string) => { if (!isAddress(v)) throw new Error("Expected an EVM address"); return v.toLowerCase(); };
const txHash = (v: string) => { if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("Expected a transaction or block hash"); return v.toLowerCase(); };

/** Durable, explicitly activated bounded leader following. Reopening never restarts jobs. */
export class EvmTradeWatchManager {
  private now: () => number;
  private closed = false;
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private activationQueue: Promise<unknown> = Promise.resolve();
  constructor(private db: Database, private adapter: TradeWatchAdapter, private options: TradeWatchOptions = {}) {
    this.now = options.now ?? Date.now;
    db.exec(`CREATE TABLE IF NOT EXISTS evm_trade_watches(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evm_trade_watch_activations(id TEXT PRIMARY KEY, signature TEXT NOT NULL, watch_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evm_trade_watch_attempts(id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, dedup_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evm_trade_watch_skips(watch_id TEXT NOT NULL,source_hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(watch_id,source_hash));`);
    for (const w of this.list()) {
      if (!["active", "checking"].includes(w.status) && !w.pendingAttemptId) continue;
      w.status = w.pendingAttemptId ? "uncertain" : "paused";
      delete w.nextCheckAt;
      w.stopReason = w.pendingAttemptId ? "Backend restarted after a trade may have been submitted; read-only reconciliation is required." : "Backend restarted; a new explicit activation is required.";
      this.log(w, w.stopReason); this.save(w);
    }
  }
  private iso() { return new Date(this.now()).toISOString(); }
  private log(w: EvmTradeWatch, message: string) { w.logs.push({ at: this.iso(), message }); w.logs = w.logs.slice(-40); }
  private save(w: EvmTradeWatch) { w.updatedAt = this.iso(); this.db.query("INSERT INTO evm_trade_watches(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(w.id, JSON.stringify(w)); try { this.options.onChange?.(clone(w)); } catch { /* UI notifications cannot invalidate the durable signing barrier. */ } }
  private saveAttempt(a: TradeWatchAttempt, dedupKey?: string) {
    a.updatedAt = this.iso();
    if (dedupKey) this.db.query("INSERT INTO evm_trade_watch_attempts(id,watch_id,dedup_key,payload) VALUES(?,?,?,?)").run(a.id, a.watchId, dedupKey, JSON.stringify(a));
    else this.db.query("UPDATE evm_trade_watch_attempts SET payload=? WHERE id=?").run(JSON.stringify(a), a.id);
  }
  get(id: string): EvmTradeWatch { const row = this.db.query("SELECT payload FROM evm_trade_watches WHERE id=?").get(id) as { payload: string } | null; if (!row) throw new Error(`Unknown trade watch ${id}`); return JSON.parse(row.payload); }
  list(sessionId?: string): EvmTradeWatch[] { return (this.db.query("SELECT payload FROM evm_trade_watches ORDER BY rowid DESC").all() as { payload: string }[]).map(r => JSON.parse(r.payload) as EvmTradeWatch).filter(w => !sessionId || w.sessionId === sessionId); }
  attempts(id: string): TradeWatchAttempt[] { this.get(id); return (this.db.query("SELECT payload FROM evm_trade_watch_attempts WHERE watch_id=? ORDER BY rowid").all(id) as { payload: string }[]).map(r => JSON.parse(r.payload)); }
  activate(input: TradeWatchActivation): Promise<EvmTradeWatch> {
    const frozenInput=clone(input);
    const queued = this.activationQueue.then(() => this.activateOnce(frozenInput));
    this.activationQueue = queued.catch(() => {}); return queued;
  }
  private async activateOnce(input: TradeWatchActivation) {
    if (this.closed) throw new Error("Trade watch manager is closed");
    if (!input.activationId || input.activationId.length > 200 || !input.sessionId || input.sessionId.length > 200) throw new Error("Activation requires stable operation and session IDs");
    if (!input.network || input.network.length > 64 || !input.venueId || input.venueId.length > 200) throw new Error("Explicit network and venue are required");
    const leader = address(input.leader);
    if (input.startBlock !== "next") raw(input.startBlock, false);
    const perTrade = raw(input.perTradeInputCapRaw), cumulative = raw(input.cumulativeInputCapRaw);
    if (perTrade > cumulative) throw new Error("Per-trade input cap cannot exceed the cumulative cap");
    if (!Number.isInteger(input.proportionBps) || input.proportionBps < 1 || input.proportionBps > 10000) throw new Error("proportionBps must be 1–10000");
    if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 500) throw new Error("slippageBps must be 1–500");
    if (!Number.isInteger(input.maxTrades) || input.maxTrades < 1 || input.maxTrades > 100) throw new Error("maxTrades must be 1–100");
    if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 15 || input.intervalSeconds > 3600) throw new Error("Trade watch interval must be 15–3600 whole seconds");
    const tokenIn = address(input.tokenIn), tokenOut = address(input.tokenOut);
    if (tokenIn === tokenOut) throw new Error("Input and output token directions must differ");
    const validated = input.predicate ? clone(input.predicate) : undefined;
    if (validated) {
      validated.graph = validatePredicate(validated.graph).graph;
      if (!Number.isInteger(validated.exchangeMaxAgeSeconds) || validated.exchangeMaxAgeSeconds < 1 || validated.exchangeMaxAgeSeconds > 120) throw new Error("Predicate exchange freshness must be 1–120 whole seconds");
      const usesVault = validated.graph.nodes.some(n => n.kind === "vault-paused");
      if (usesVault && !validated.vaultTarget) throw new Error("A vault predicate requires an explicit frozen vault target");
      if (validated.vaultTarget) { validated.vaultTarget.address = address(validated.vaultTarget.address); if (![31337,11155111,84532,10143].includes(validated.vaultTarget.chainId)) throw new Error("Unsupported predicate vault chain"); }
      if (!this.adapter.evaluatePredicate) throw new Error("This trade adapter does not support real predicate observations");
    }
    const { activationId, sessionId, ...config } = { ...input, leader, tokenIn, tokenOut, ...(validated ? { predicate: validated } : {}) };
    const signature = hash({ sessionId, config });
    const prior = this.db.query("SELECT signature,watch_id FROM evm_trade_watch_activations WHERE id=?").get(activationId) as { signature: string; watch_id: string } | null;
    if (prior) { if (prior.signature !== signature) throw new Error("Activation ID reused with different trade authorization"); return this.get(prior.watch_id); }
    const venue = clone(await this.adapter.freeze({ network: config.network, venueId: config.venueId }));
    this.assertVenue(venue, config);
    if (![venue.token0, venue.token1].includes(tokenIn) || ![venue.token0, venue.token1].includes(tokenOut)) throw new Error("Frozen token direction must belong to the allowlisted pair");
    if (leader === venue.signer) throw new Error("Leader cannot be the task signer");
    for (const w of this.list()) {
      if (w.venue.chainId !== venue.chainId || w.venue.genesisHash !== venue.genesisHash || w.venue.signer !== venue.signer) continue;
      if (w.pendingAttemptId || w.status === "uncertain") throw new Error(`Trade watch ${w.id} is uncertain; reconcile it before granting more signing authority`);
      if (["active", "checking"].includes(w.status)) throw new Error(`Signer already has active trade watch ${w.id}; stop it before another activation`);
    }
    if (this.list().filter(w => ["active", "checking"].includes(w.status)).length >= 8) throw new Error("At most 8 trade watches can be active");
    const w: EvmTradeWatch = { id: `trade_watch_${crypto.randomUUID().replaceAll("-", "")}`, sessionId, status: "active", config, venue,
      nextBlock: config.startBlock === "next" ? (raw(venue.headBlock, false) + 1n).toString() : config.startBlock,
      ...(config.startBlock === "next" ? {cursorAnchor:{blockNumber:venue.headBlock,blockHash:venue.headBlockHash}} : {}),
      createdAt: this.iso(), updatedAt: this.iso(), nextCheckAt: this.iso(), checks: 0, failures: 0, reservedTrades: 0,
      reservedInputRaw: "0", skippedEvents: [], ...(validated ? { conditionHash: predicateHash(validated.graph) } : {}), logs: [] };
    this.log(w, `Explicitly watching confirmed leader swaps from block ${w.nextBlock}; at most ${config.maxTrades} signed attempts. Only the frozen token direction is eligible; a false predicate skips that source event permanently.`);
    this.db.transaction(() => { this.save(w); this.db.query("INSERT INTO evm_trade_watch_activations(id,signature,watch_id) VALUES(?,?,?)").run(activationId, signature, w.id); })();
    this.schedule(); return clone(w);
  }
  private assertVenue(v: FrozenTradeVenue, config: { network: string; venueId: string }) {
    if (![31337, 11155111, 84532, 10143].includes(v.chainId) || v.network !== config.network || v.venueId !== config.venueId) throw new Error("Only explicit task-wallet local/testnet venues are supported; mainnet signing is unavailable");
    for (const field of ["signer", "router", "factory", "pair", "token0", "token1"] as const) v[field] = address(v[field]);
    for (const field of ["genesisHash", "routerCodeHash", "factoryCodeHash", "pairCodeHash", "headBlockHash"] as const) v[field] = txHash(v[field]);
    raw(v.headBlock, false);
    if (v.token0 === v.token1) throw new Error("Pool token identities must differ");
  }
  stop(id: string) { const w = this.get(id); if (["completed", "failed", "uncertain", "paused"].includes(w.status)) return w; w.status = "paused"; delete w.nextCheckAt; w.stopReason = w.pendingAttemptId ? "Stopped; the recorded in-flight trade may still settle and must be reconciled." : "Stopped by explicit request; no further scans or trades will start."; this.log(w, w.stopReason); this.save(w); this.schedule(); return clone(w); }
  async tick() {
    if (this.closed || this.busy) return; this.busy = true;
    try { for (const w of this.list().filter(w => w.status === "active" && Date.parse(w.nextCheckAt ?? "") <= this.now())) { if (this.closed) break; if (this.get(w.id).status === "active") await this.check(w); } }
    finally { this.busy = false; this.schedule(); }
  }
  private assertTrade(t: WatchedLeaderTrade, w: EvmTradeWatch, from: bigint, to: bigint) {
    t.transactionHash = txHash(t.transactionHash); t.blockHash = txHash(t.blockHash);
    if (address(t.leader) !== w.config.leader || address(t.router) !== w.venue.router || address(t.pair) !== w.venue.pair ||
      ![w.venue.token0, w.venue.token1].includes(address(t.tokenIn)) || ![w.venue.token0, w.venue.token1].includes(address(t.tokenOut)) || address(t.tokenIn) === address(t.tokenOut) ||
      !Number.isInteger(t.logIndex) || t.logIndex < 0 || raw(t.blockNumber, false) < from || raw(t.blockNumber, false) > to) throw new Error("Leader trade does not match the frozen confirmed range and venue");
    t.tokenIn = address(t.tokenIn); t.tokenOut = address(t.tokenOut); raw(t.amountInRaw);
  }
  private assertExecution(e: TradeWatchExecution, w: EvmTradeWatch, a: TradeWatchAttempt) {
    if (e.operationId !== a.operationId || txHash(e.sourceTransactionHash) !== a.source.transactionHash || e.chainId !== w.venue.chainId || address(e.signer) !== w.venue.signer || address(e.tokenIn) !== a.source.tokenIn || address(e.tokenOut) !== a.source.tokenOut || e.amountInRaw !== a.amountInRaw) throw new Error("Trade result does not match the frozen signed attempt");
    if (e.status === "confirmed") { if (!e.transactionHash || !e.blockNumber || !e.amountOutRaw) throw new Error("Confirmed trade requires a verified swap receipt and actual output"); txHash(e.transactionHash); raw(e.blockNumber, false); raw(e.amountOutRaw); }
    if (!["confirmed", "not-submitted", "reverted", "uncertain"].includes(e.status)) throw new Error("Unknown trade journal outcome");
  }
  private skip(w: EvmTradeWatch, t: WatchedLeaderTrade, reason: string, gate?: TradeWatchGate) {
    this.db.query("INSERT OR IGNORE INTO evm_trade_watch_skips(watch_id,source_hash,payload) VALUES(?,?,?)").run(w.id,t.transactionHash,JSON.stringify({reason,gate,at:this.iso()}));
    w.skippedEvents.push({sourceTransactionHash:t.transactionHash, reason, at:this.iso(), ...(gate ? {gate:clone(gate)} : {})});
    w.skippedEvents = w.skippedEvents.slice(-100); this.log(w, `Skipped ${t.transactionHash}: ${reason}`); this.save(w);
  }
  private async evaluateGate(w: EvmTradeWatch): Promise<TradeWatchGate> {
    const gate = await this.adapter.evaluatePredicate!(clone(w.config.predicate!), clone(w.venue));
    if (gate.predicateHash !== w.conditionHash || gate.inputs.exchangeMaxAgeSeconds !== w.config.predicate!.exchangeMaxAgeSeconds) throw new Error("Predicate result does not match the frozen condition and freshness");
    const evaluatedAt=Date.parse(gate.evaluatedAt);
    if (!Number.isFinite(evaluatedAt) || evaluatedAt > this.now()+5000) throw new Error("Predicate evaluation timestamp is invalid");
    const archived = evaluatePredicate(w.config.predicate!.graph, gate.inputs, evaluatedAt);
    if (JSON.stringify(archived) !== JSON.stringify(gate.result)) throw new Error("Predicate evaluation disagrees with archived real inputs");
    // Recheck aging at handoff; rounded display ages need not match a prior millisecond.
    const now=this.now(), result = evaluatePredicate(w.config.predicate!.graph, gate.inputs, now);
    return clone({...gate, result, evaluatedAt:new Date(now).toISOString()});
  }
  private async check(w: EvmTradeWatch) {
    w.status = "checking"; w.checks++; delete w.nextCheckAt; this.save(w);
    let possibleWrite = false;
    try {
      const head = raw(await this.adapter.confirmedHead(clone(w.venue)), false), from = raw(w.nextBlock, false);
      if (w.cursorAnchor && txHash(await this.adapter.blockHash(clone(w.venue),w.cursorAnchor.blockNumber)) !== w.cursorAnchor.blockHash) {
        w.status="failed"; w.stopReason="Confirmed cursor block changed on chain; stopped for explicit reorg review without copying or advancing."; this.log(w,w.stopReason);this.save(w);return;
      }
      // Bound each RPC scan. A missed query never advances this cursor.
      const to = head < from + 999n ? head : from + 999n;
      const trades = to < from ? [] : await this.adapter.scan(clone(w.venue), w.config.leader, from.toString(), to.toString());
      for (const t of trades) this.assertTrade(t, w, from, to);
      trades.sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex);
      for (const t of trades) {
        w = this.get(w.id); if (w.status !== "checking" || this.closed) return;
        const dedupKey = hash([w.venue.chainId, w.venue.genesisHash, w.venue.signer, t.transactionHash]);
        if (this.db.query("SELECT id FROM evm_trade_watch_attempts WHERE dedup_key=?").get(dedupKey) || this.db.query("SELECT source_hash FROM evm_trade_watch_skips WHERE watch_id=? AND source_hash=?").get(w.id,t.transactionHash)) continue;
        const proportional = raw(t.amountInRaw) * BigInt(w.config.proportionBps) / 10000n;
        const amount = proportional < raw(w.config.perTradeInputCapRaw) ? proportional : raw(w.config.perTradeInputCapRaw);
        if (amount === 0n) { this.log(w, `Skipped ${t.transactionHash}: proportional raw input rounds to zero`); this.save(w); continue; }
        if (t.tokenIn !== w.config.tokenIn || t.tokenOut !== w.config.tokenOut) { this.skip(w, t, "Opposite token direction is outside this activation"); continue; }
        let gate: TradeWatchGate | undefined;
        if (w.config.predicate) { gate = await this.evaluateGate(w); if (gate.result.decision !== "act") { this.skip(w, t, "Fresh composed predicate is false or blocked", gate); continue; } }
        w = this.get(w.id); if (w.status === "paused" || this.closed) return;
        const spent = BigInt(w.reservedInputRaw);
        if (w.reservedTrades >= w.config.maxTrades || spent + amount > raw(w.config.cumulativeInputCapRaw)) { w.status = "completed"; w.stopReason = "Explicit trade count or input budget reached; no additional signing is authorized."; this.log(w, w.stopReason); this.save(w); return; }
        const a: TradeWatchAttempt = { id: `${w.id}_${w.reservedTrades + 1}`, watchId: w.id, operationId: `${w.id}:${t.transactionHash}`, source: clone(t), amountInRaw: amount.toString(), status: "reserved", createdAt: this.iso(), updatedAt: this.iso(), ...(gate ? { gate } : {}) };
        this.db.transaction(() => { const current = this.get(w.id); if (current.status !== "checking" || current.pendingAttemptId) throw new Error("Trade authorization changed before reservation"); if (current.reservedTrades >= current.config.maxTrades || BigInt(current.reservedInputRaw) + amount > raw(current.config.cumulativeInputCapRaw)) throw new Error("Trade budget changed before reservation"); current.reservedTrades++; current.reservedInputRaw = (BigInt(current.reservedInputRaw) + amount).toString(); current.pendingAttemptId = a.id; this.saveAttempt(a, dedupKey); this.save(current); })();
        possibleWrite = true;
        const result = await this.adapter.execute({ venue: clone(w.venue), trade: clone(t), operationId: a.operationId, amountInRaw: a.amountInRaw, slippageBps: w.config.slippageBps, beforeBroadcast: async () => {
          const current = this.get(w.id);
          if (current.status !== "checking" || current.pendingAttemptId !== a.id || this.closed) return false;
          if (!current.config.predicate) return true;
          const finalGate = await this.evaluateGate(current); a.gate = finalGate; this.saveAttempt(a);
          return finalGate.result.decision === "act";
        } });
        w = this.get(w.id); this.assertExecution(result, w, a); a.execution = clone(result); a.status = result.status; this.saveAttempt(a);
        if (result.status === "uncertain") throw new Error(result.error ?? "Trade journal cannot yet prove settlement or absence");
        delete w.pendingAttemptId; possibleWrite = false;
        this.log(w, `${result.status}: leader ${t.transactionHash}${result.transactionHash ? ` → follower ${result.transactionHash}` : ""}`);
        if (w.reservedTrades >= w.config.maxTrades) { w.status = "completed"; w.stopReason = "Explicit maximum signed attempts reached; this watch is stopped."; }
        this.save(w); if (["paused", "completed"].includes(w.status)) return;
      }
      w = this.get(w.id); if (w.status === "paused" || this.closed) return;
      if (to >= from) { const anchorHash=txHash(await this.adapter.blockHash(clone(w.venue),to.toString())); w.nextBlock = (to + 1n).toString(); w.cursorAnchor={blockNumber:to.toString(),blockHash:anchorHash}; }
      w.status = "active"; w.failures = 0; delete w.lastError;
      w.nextCheckAt = new Date(this.now() + w.config.intervalSeconds * 1000).toISOString(); this.save(w);
    } catch (error) {
      w = this.get(w.id); w.lastError = error instanceof Error ? error.message : String(error); w.failures++;
      if (possibleWrite || w.pendingAttemptId) { w.status = "uncertain"; w.stopReason = "A signed trade may have been submitted; stopped without replay. Reconcile its recorded operation read-only."; delete w.nextCheckAt; const a = this.attempts(w.id).find(a => a.id === w.pendingAttemptId); if (a) { a.status = "uncertain"; a.error = w.lastError; this.saveAttempt(a); } }
      else if (w.status !== "paused") { w.status = w.failures >= 5 ? "failed" : "active"; if (w.status === "active") w.nextCheckAt = new Date(this.now() + Math.min(3600, w.config.intervalSeconds * 2 ** w.failures) * 1000).toISOString(); else { delete w.nextCheckAt; w.stopReason = "Stopped after five scan failures; confirmed cursor was retained."; } }
      this.log(w, w.lastError); this.save(w);
    }
  }
  async reconcile(id: string) {
    let w = this.get(id); if (!w.pendingAttemptId || w.status !== "uncertain") return w;
    const a = this.attempts(id).find(a => a.id === w.pendingAttemptId); if (!a) throw new Error("Missing durable trade attempt");
    try { const result = await this.adapter.reconcile({ venue: clone(w.venue), attempt: clone(a) }); w = this.get(id); this.assertExecution(result, w, a); a.execution = clone(result); a.status = result.status; this.saveAttempt(a); if (result.status === "uncertain") throw new Error(result.error ?? "Journal remains uncertain"); delete w.pendingAttemptId; w.status = w.reservedTrades >= w.config.maxTrades ? "completed" : "paused"; w.stopReason = "Read-only reconciliation settled the recorded attempt; monitoring remains stopped until a new explicit activation."; delete w.lastError; delete w.nextCheckAt; this.log(w, w.stopReason); this.save(w); }
    catch (error) { w = this.get(id); w.status = "uncertain"; w.lastError = `Recovery remains uncertain: ${error instanceof Error ? error.message : String(error)}`; delete w.nextCheckAt; this.log(w, w.lastError); this.save(w); }
    return this.get(id);
  }
  private schedule() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; if (this.closed || this.busy || this.options.scheduling === false) return; const due = this.list().filter(w => w.status === "active" && w.nextCheckAt).map(w => Date.parse(w.nextCheckAt!)); if (!due.length) return; this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, Math.max(10, Math.min(...due) - this.now())); this.timer.unref(); }
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
