import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { specificationSchema, type ExecutionSpecification } from "../cre/spec";
import type { ExecutionEvidence } from "../cre/runner";
import { readsVault } from "../cre/graph";
import { normalizeExecutionTarget, sameExecutionTarget, isEvmTarget, isSolanaTarget, policyOperationKey, type EvmExecutionTarget, type SolanaExecutionTarget } from "../shared/execution-target";

export const MIN_MONITOR_INTERVAL_SECONDS = 15;
export const MAX_MONITOR_INTERVAL_SECONDS = 3600;
export const MAX_ACTIVE_MONITORS = 8;
const MAX_FAILURES = 5;
export type MonitorTarget = EvmExecutionTarget | SolanaExecutionTarget;
export type MonitorStatus = "active" | "checking" | "paused" | "completed" | "failed" | "uncertain";
export interface PolicyMonitor {
  id: string;
  sessionId: string;
  status: MonitorStatus;
  /** Immutable policy and receiver identity. Each attempt gets its own run ID. */
  spec: ExecutionSpecification;
  target: MonitorTarget;
  intervalSeconds: number;
  createdAt: string;
  updatedAt: string;
  nextCheckAt?: string;
  checks: number;
  failures: number;
  phase?: "observe" | "broadcast";
  lastRunId?: string;
  /** A correlated broadcast identifier, never proof of settlement by itself. */
  submittedHash?: string;
  submittedSignature?: string;
  lastError?: string;
  stopReason?: string;
  latestEvidence?: ExecutionEvidence;
  recovery?: MonitorRecovery;
  logs: { at: string; message: string }[];
}
export interface MonitorCheck {
  id: string;
  monitorId: string;
  startedAt: string;
  completedAt?: string;
  observation?: ExecutionEvidence;
  action?: ExecutionEvidence;
  error?: string;
}
export type MonitorExecutor = (
  spec: ExecutionSpecification,
  target: MonitorTarget,
  progress: (message: string) => void,
) => Promise<ExecutionEvidence>;
export type MonitorRecovery =
  | { state: "confirmed"; evidence: ExecutionEvidence }
  | { state: "not-submitted"; runId: string; revision: number; policyHash: string; target: MonitorTarget; checkedAt: string; processed: false; journalVerified?: true; chainVerified?: true }
  | { state: "expired" | "failed"; runId: string; revision: number; policyHash: string; target: SolanaExecutionTarget; checkedAt: string;
      signature: string; journalVerified: true; chainVerified: true; lastValidBlockHeight?: number; blockHeight?: number; transactionError?: string }
  | { state: "unknown"; reason: string };
interface MonitorOptions {
  now?: () => number;
  /** Tests advance tick explicitly. Production uses bounded setTimeout scheduling. */
  scheduling?: boolean;
  onChange?: (monitor: PolicyMonitor) => void;
}
const copy = <T>(value: T): T => structuredClone(value);
const sameAuthority = (a: MonitorTarget, b: MonitorTarget) => isSolanaTarget(a) && isSolanaTarget(b)
  ? a.sender === b.sender && a.genesisHash === b.genesisHash && a.network === b.network
  : isEvmTarget(a) && isEvmTarget(b) && a.chainId === b.chainId && a.address.toLowerCase() === b.address.toLowerCase();

/**
 * Backend-local durable watcher. Only explicit activation starts scheduling;
 * reopening the database never silently grants permission to restart a job.
 * Observe failures are safe to retry. Once a write might have started, any
 * interruption stops the job as uncertain rather than submitting another run.
 */
export class PolicyMonitorManager {
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private closed = false;
  private now: () => number;
  constructor(private db: Database, private execute: MonitorExecutor, private options: MonitorOptions = {}) {
    this.now = options.now ?? Date.now;
    db.exec(`CREATE TABLE IF NOT EXISTS policy_monitors (id TEXT PRIMARY KEY, status TEXT NOT NULL, next_check_at INTEGER, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_monitor_activations (id TEXT PRIMARY KEY, signature TEXT NOT NULL, monitor_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_monitor_checks (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, payload TEXT NOT NULL);`);
    for (const monitor of this.list()) {
      if (monitor.status !== "active" && monitor.status !== "checking" && !(monitor.status === "paused" && monitor.phase === "broadcast")) continue;
      const uncertain = monitor.phase === "broadcast";
      monitor.status = uncertain ? "uncertain" : "paused";
      delete monitor.nextCheckAt;
      monitor.stopReason = uncertain
        ? "Backend restarted after a report may have been submitted. Check this run on chain before activating another policy."
        : this.isProductRoute(monitor.spec, monitor.target)
          ? "Backend restarted. Explicitly activate the CRE policy again to resume monitoring."
          : "Backend restarted. This direct-execution archive remains paused and cannot be reactivated.";
      this.log(monitor, monitor.stopReason);
      this.save(monitor);
    }
  }
  private iso() { return new Date(this.now()).toISOString(); }
  private log(monitor: PolicyMonitor, message: string) {
    monitor.logs.push({ at: this.iso(), message });
    monitor.logs = monitor.logs.slice(-40);
  }
  private save(monitor: PolicyMonitor) {
    monitor.updatedAt = this.iso();
    this.db.query("INSERT INTO policy_monitors(id,status,next_check_at,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,next_check_at=excluded.next_check_at,payload=excluded.payload")
      .run(monitor.id, monitor.status, monitor.nextCheckAt ? Date.parse(monitor.nextCheckAt) : null, JSON.stringify(monitor));
    this.options.onChange?.(copy(monitor));
  }
  get(id: string): PolicyMonitor {
    const row = this.db.query("SELECT payload FROM policy_monitors WHERE id=?").get(id) as { payload: string } | null;
    if (!row) throw new Error(`Unknown policy monitor ${id}`);
    const monitor = JSON.parse(row.payload) as PolicyMonitor;
    monitor.target = normalizeExecutionTarget(monitor.target);
    return monitor;
  }
  list(sessionId?: string): PolicyMonitor[] {
    const rows = this.db.query("SELECT payload FROM policy_monitors ORDER BY rowid DESC").all() as { payload: string }[];
    return rows.map(row => { const monitor = JSON.parse(row.payload) as PolicyMonitor; monitor.target = normalizeExecutionTarget(monitor.target); return monitor; }).filter(m => !sessionId || m.sessionId === sessionId);
  }
  checks(id: string): MonitorCheck[] {
    this.get(id);
    return (this.db.query("SELECT payload FROM policy_monitor_checks WHERE monitor_id=? ORDER BY rowid").all(id) as { payload: string }[])
      .map(row => JSON.parse(row.payload));
  }
  private saveCheck(check: MonitorCheck) {
    this.db.query("INSERT INTO policy_monitor_checks(id,monitor_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(check.id, check.monitorId, JSON.stringify(check));
  }
  private isProductRoute(spec: ExecutionSpecification, target: MonitorTarget) {
    return spec.graph.action.type === "pause-vault" && isEvmTarget(target) && target.executor === "cre" && target.chainId === 11155111;
  }
  private assertProductRoute(spec: ExecutionSpecification, target: MonitorTarget) {
    if (!this.isProductRoute(spec, target))
      throw new Error("Policy monitoring requires CRE pause-vault execution on Sepolia. Direct EVM, local, mainnet and Solana actions are archived read-only.");
  }
  activate(input: { spec: ExecutionSpecification; target: MonitorTarget; activationId: string; sessionId: string; intervalSeconds?: number }): PolicyMonitor {
    if (this.closed) throw new Error("Policy monitor manager is closed");
    const spec = specificationSchema.parse(copy(input.spec));
    if (!input.sessionId || !input.activationId || input.activationId.length > 200) throw new Error("Activation requires a session and stable operation ID");
    const interval = input.intervalSeconds ?? 30;
    if (!Number.isInteger(interval) || interval < MIN_MONITOR_INTERVAL_SECONDS || interval > MAX_MONITOR_INTERVAL_SECONDS)
      throw new Error(`Monitor interval must be ${MIN_MONITOR_INTERVAL_SECONDS}–${MAX_MONITOR_INTERVAL_SECONDS} whole seconds`);
    const target = normalizeExecutionTarget(input.target);
    this.assertProductRoute(spec, target);
    const identity = { ...spec, runId: "monitor", broadcast: true };
    const signature = createHash("sha256").update(JSON.stringify({ identity, target, interval, sessionId: input.sessionId })).digest("hex");
    const legacySignature = isEvmTarget(target) ? createHash("sha256").update(JSON.stringify({ identity, target: { chainId: target.chainId, address: target.address.toLowerCase() }, interval, sessionId: input.sessionId })).digest("hex") : undefined;
    const previous = this.db.query("SELECT signature,monitor_id FROM policy_monitor_activations WHERE id=?").get(input.activationId) as { signature: string; monitor_id: string } | null;
    if (previous) {
      if (previous.signature !== signature && previous.signature !== legacySignature) throw new Error("Activation operation ID reused with a different policy or interval");
      return this.get(previous.monitor_id);
    }
    const uncertain = this.list().find(m => sameAuthority(m.target, target) && (m.status === "uncertain" || m.phase === "broadcast"));
    if (uncertain) throw new Error(`Monitor ${uncertain.id} has an uncertain action; reconcile its chain evidence before activating a policy for this target again`);
    const matching = this.list().find(m => m.spec.policyHash === spec.policyHash && sameExecutionTarget(m.target, target) && ["active", "checking"].includes(m.status));
    if (matching) {
      if (matching.sessionId !== input.sessionId || matching.intervalSeconds !== interval || matching.spec.maxAgeSeconds !== spec.maxAgeSeconds || matching.spec.revision !== spec.revision)
        throw new Error(`This policy is already monitored by ${matching.id}; deactivate it before changing its activation`);
      this.db.query("INSERT INTO policy_monitor_activations(id,signature,monitor_id) VALUES(?,?,?)").run(input.activationId, signature, matching.id);
      return matching;
    }
    if (this.list().filter(m => ["active", "checking"].includes(m.status)).length >= MAX_ACTIVE_MONITORS)
      throw new Error(`At most ${MAX_ACTIVE_MONITORS} policies can be monitored at once; deactivate a monitor first`);
    const id = `monitor_${crypto.randomUUID().replaceAll("-", "")}`;
    const monitor: PolicyMonitor = {
      id, sessionId: input.sessionId, status: "active", spec: { ...spec, runId: id, broadcast: true }, target,
      intervalSeconds: interval, createdAt: this.iso(), updatedAt: this.iso(), nextCheckAt: this.iso(), checks: 0, failures: 0, logs: [],
    };
    this.log(monitor, `Activated revision ${spec.revision}; checking every ${interval}s while this backend is running`);
    this.db.transaction(() => {
      this.save(monitor);
      this.db.query("INSERT INTO policy_monitor_activations(id,signature,monitor_id) VALUES(?,?,?)").run(input.activationId, signature, id);
    })();
    this.schedule();
    return copy(monitor);
  }
  deactivate(id: string): PolicyMonitor {
    const monitor = this.get(id);
    if (["completed", "failed", "uncertain", "paused"].includes(monitor.status)) return monitor;
    monitor.status = "paused";
    delete monitor.nextCheckAt;
    monitor.stopReason = monitor.phase === "broadcast"
      ? "Deactivated; a report already in flight may still confirm. Its final evidence will be retained."
      : "Deactivated by explicit request; no further checks will run.";
    this.log(monitor, monitor.stopReason);
    this.save(monitor);
    this.schedule();
    return monitor;
  }
  /** Read-only chain reconciliation. Neither outcome restarts the original job. */
  async reconcile(id: string, recover: (monitor: PolicyMonitor) => Promise<MonitorRecovery>): Promise<PolicyMonitor> {
    let monitor = this.get(id);
    if (monitor.status !== "uncertain") return monitor;
    try {
      if (!monitor.lastRunId || monitor.phase !== "broadcast") throw new Error("No frozen action run is available to reconcile");
      const recovery = await recover(copy(monitor));
      monitor = this.get(id);
      if (monitor.status !== "uncertain") return monitor;
      if (recovery.state === "unknown") throw new Error(recovery.reason);
      if (recovery.state === "confirmed") {
        const evidence = recovery.evidence;
        const frozen = { ...monitor.spec, runId: monitor.lastRunId! };
        this.assertEvidence(evidence, frozen, monitor.target);
        if (this.isProductRoute(frozen, monitor.target) && evidence.mode !== "cre-local-simulation")
          throw new Error("A CRE monitor cannot be recovered as confirmed from direct-execution evidence");
        this.assertSettlement(evidence, frozen, monitor.target);
        if ((isEvmTarget(monitor.target) && monitor.submittedHash && evidence.transaction?.hash.toLowerCase() !== monitor.submittedHash.toLowerCase()) ||
          (isSolanaTarget(monitor.target) && monitor.submittedSignature && evidence.solanaTransfer?.signature !== monitor.submittedSignature))
          throw new Error("Recovery receipt differs from the persisted submitted transaction");
        monitor.latestEvidence = copy(evidence);
        monitor.status = "completed";
        monitor.stopReason = `Recovered a verified on-chain ${monitor.spec.graph.action.type === "pause-vault" ? "pause" : "Solana transfer"}; this monitor remains stopped.`;
      } else {
        const age = this.now() - Date.parse(recovery.checkedAt);
        if (recovery.runId !== monitor.lastRunId || recovery.revision !== monitor.spec.revision || recovery.policyHash !== monitor.spec.policyHash ||
          !sameExecutionTarget(recovery.target, monitor.target) || !Number.isFinite(age) || age < -5000 || age > 120000)
          throw new Error("Absence proof is stale or does not match the frozen run and vault");
        if (recovery.state === "not-submitted") {
          if (recovery.processed !== false || (isSolanaTarget(monitor.target) && (!recovery.journalVerified || !recovery.chainVerified)))
            throw new Error("Solana absence proof requires read-only journal and chain verification");
          if (isSolanaTarget(monitor.target) && monitor.submittedSignature)
            throw new Error("A signed Solana transaction was recorded; journal absence cannot rule out its submission");
        } else {
          if (!isSolanaTarget(monitor.target) || recovery.journalVerified !== true || recovery.chainVerified !== true ||
            !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(recovery.signature) || (monitor.submittedSignature && recovery.signature !== monitor.submittedSignature))
            throw new Error("Recovery does not prove the exact frozen Solana transaction");
          if (recovery.state === "expired" && (!Number.isSafeInteger(recovery.blockHeight) || !Number.isSafeInteger(recovery.lastValidBlockHeight) ||
            recovery.lastValidBlockHeight! < 0 || recovery.blockHeight! <= recovery.lastValidBlockHeight!))
            throw new Error("Solana transaction expiry has not been definitively proven");
          if (recovery.state === "failed" && !recovery.transactionError?.trim())
            throw new Error("Solana transaction failure lacks a verified chain error");
        }
        monitor.status = "paused";
        const resume = this.isProductRoute(monitor.spec, monitor.target)
          ? "Explicitly activate a new CRE monitor to resume."
          : "This direct-execution archive cannot be reactivated.";
        monitor.stopReason = recovery.state === "not-submitted"
          ? `Fresh chain recovery found no submitted action for this run. ${resume}`
          : `The frozen Solana transaction ${recovery.state}; this monitor remains stopped. ${resume}`;
      }
      monitor.recovery = copy(recovery);
      delete monitor.phase;
      delete monitor.lastError;
      delete monitor.nextCheckAt;
      this.log(monitor, monitor.stopReason);
      this.save(monitor);
    } catch (error) {
      monitor = this.get(id);
      monitor.lastError = `Recovery remains uncertain: ${error instanceof Error ? error.message : String(error)}`;
      this.log(monitor, monitor.lastError);
      this.save(monitor);
    }
    return this.get(id);
  }
  /** Call without awaiting a long-running scheduler; one bounded batch only. */
  async tick(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const due = this.list().filter(m => m.status === "active" && Date.parse(m.nextCheckAt ?? "") <= this.now());
      // Sequential broadcasts avoid shared CRE runtime configuration races.
      for (const monitor of due) {
        if (this.closed) break;
        if (this.get(monitor.id).status === "active") await this.check(monitor);
      }
    } finally { this.busy = false; this.schedule(); }
  }
  private assertEvidence(evidence: ExecutionEvidence, spec: ExecutionSpecification, target: MonitorTarget) {
    if (evidence.runId !== spec.runId || evidence.revision !== spec.revision || evidence.policyHash !== spec.policyHash || evidence.action !== spec.graph.action.type)
      throw new Error("Monitor execution evidence does not match the frozen policy");
    if (evidence.mode === "fixture-rehearsal" || evidence.fixturePaused) throw new Error("Monitor execution requires real chain evidence");
    if (spec.graph.action.type === "pause-vault") {
      if (!isEvmTarget(target) || !evidence.vault || evidence.vault.chainId !== target.chainId || evidence.vault.address.toLowerCase() !== target.address.toLowerCase() || evidence.vault.reportVersion !== 2 || evidence.solanaTransfer)
        throw new Error("Monitor requires a real report-v2 vault matching its frozen chain and address");
    } else if (spec.graph.action.type === "solana-transfer") {
      if (!isSolanaTarget(target) || evidence.mode !== "solana-devnet" || evidence.transaction)
        throw new Error("Solana action requires devnet execution; an EVM vault or transaction cannot settle it");
      if (readsVault(spec.graph)) {
        if (!target.vaultDependency || !evidence.vault || evidence.vault.chainId !== target.vaultDependency.chainId || evidence.vault.address.toLowerCase() !== target.vaultDependency.address.toLowerCase())
          throw new Error("Solana execution did not read its frozen EVM vault dependency");
      } else if (evidence.vault !== null) throw new Error("This Solana policy does not read a vault; a fabricated vault is not accepted");
      if (evidence.solanaTransfer && (evidence.solanaTransfer.genesisHash !== target.genesisHash || evidence.solanaTransfer.sender !== target.sender))
        throw new Error("Solana receipt does not match the frozen task wallet and devnet genesis");
    }
  }
  private assertSettlement(evidence: ExecutionEvidence, spec: ExecutionSpecification, target: MonitorTarget) {
    if (evidence.dryRun || evidence.decision !== "act") throw new Error("A dry run or no-op cannot confirm an action");
    if (spec.graph.action.type === "pause-vault") {
      const tx = evidence.transaction;
      if (!tx?.hash || tx.status !== "success" || !tx.receiverConfirmed || !tx.pausedAfter)
        throw new Error("Pause action has no verified receipt, receiver event and paused-vault evidence");
    } else if (spec.graph.action.type === "solana-transfer") {
      const receipt = evidence.solanaTransfer;
      const action = spec.graph.action;
      if (!isSolanaTarget(target) || !receipt || receipt.verified !== true || receipt.status !== "confirmed" || receipt.network !== "devnet" ||
        receipt.genesisHash !== target.genesisHash || receipt.sender !== target.sender || receipt.recipient !== action.recipient ||
        receipt.lamports !== action.amountLamports || receipt.amountSol !== action.amountLamports / 1_000_000_000 || receipt.idempotencyKey !== policyOperationKey(spec.runId, spec.policyHash) || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(receipt.signature) ||
        !Number.isSafeInteger(receipt.slot) || receipt.slot < 1 || !Number.isSafeInteger(receipt.feeLamports) || receipt.feeLamports < 0 || !Number.isSafeInteger(receipt.recipientBalanceBefore) || !Number.isSafeInteger(receipt.recipientBalanceAfter) ||
        receipt.recipientBalanceAfter - receipt.recipientBalanceBefore !== action.amountLamports)
        throw new Error("Solana action has no verified transfer receipt matching its frozen sender, genesis, recipient, amount and run");
    }
  }
  private async check(monitor: PolicyMonitor) {
    try { this.assertProductRoute(monitor.spec, monitor.target); }
    catch (error) {
      monitor.status = "paused";
      monitor.stopReason = error instanceof Error ? error.message : String(error);
      delete monitor.nextCheckAt;
      this.log(monitor, monitor.stopReason);
      this.save(monitor);
      return;
    }
    monitor.status = "checking";
    monitor.phase = "observe";
    monitor.checks++;
    delete monitor.nextCheckAt;
    const check: MonitorCheck = { id: `${monitor.id}_${monitor.checks}`, monitorId: monitor.id, startedAt: this.iso() };
    const observeSpec = { ...copy(monitor.spec), runId: `${check.id}_observe`, broadcast: false };
    monitor.lastRunId = observeSpec.runId;
    this.saveCheck(check);
    this.save(monitor);
    const progress = (message: string) => {
      const current = this.get(monitor.id);
      const tag = message.includes("ORIGINS_SOLANA_SUBMITTED ") ? "ORIGINS_SOLANA_SUBMITTED " : "ORIGINS_SUBMITTED ";
      const marker = message.indexOf(tag);
      if (marker >= 0 && current.phase === "broadcast") {
        try {
          const submitted = JSON.parse(message.slice(marker + tag.length));
          if (submitted.runId === current.lastRunId && submitted.revision === current.spec.revision && submitted.policyHash === current.spec.policyHash && /^0x[a-fA-F0-9]{64}$/.test(submitted.hash))
            if (isEvmTarget(current.target)) current.submittedHash = submitted.hash;
          if (submitted.runId === current.lastRunId && submitted.revision === current.spec.revision && submitted.policyHash === current.spec.policyHash && isSolanaTarget(current.target) &&
            (submitted.sender === undefined || submitted.sender === current.target.sender) && (submitted.genesisHash === undefined || submitted.genesisHash === current.target.genesisHash) && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(submitted.signature))
            current.submittedSignature = submitted.signature;
        } catch { /* Malformed progress cannot authorize an action or settle it. */ }
      }
      this.log(current, message);
      this.save(current);
    };
    let broadcasting = false;
    try {
      const observed = await this.execute(observeSpec, copy(monitor.target), progress);
      if (observed.transaction || observed.solanaTransfer || observed.fixturePaused) broadcasting = true;
      check.observation = copy(observed);
      this.saveCheck(check);
      this.assertEvidence(observed, observeSpec, monitor.target);
      if (observed.mode !== "cre-local-simulation") throw new Error("Monitor observation did not execute through CRE; no broadcast is permitted");
      if (observed.transaction || observed.solanaTransfer || observed.fixturePaused) throw new Error("Observation unexpectedly returned a write; no further execution is permitted");
      monitor = this.get(monitor.id);
      monitor.latestEvidence = copy(observed);
      if (monitor.status === "paused" || this.closed) { this.save(monitor); return; }
      if (monitor.spec.graph.action.type === "pause-vault" && observed.vault?.paused) {
        monitor.status = "paused";
        monitor.stopReason = "Vault is already paused; monitoring stopped without claiming a new transaction.";
        this.log(monitor, monitor.stopReason);
      } else if (observed.decision === "act") {
        const actionSpec = { ...copy(monitor.spec), runId: `${check.id}_action`, broadcast: true };
        monitor.phase = "broadcast";
        monitor.lastRunId = actionSpec.runId;
        this.save(monitor); // Durable uncertainty barrier before any possible write.
        broadcasting = true;
        const acted = await this.execute(actionSpec, copy(monitor.target), progress);
        check.action = copy(acted);
        this.saveCheck(check);
        this.assertEvidence(acted, actionSpec, monitor.target);
        if (acted.mode !== "cre-local-simulation") throw new Error("Monitor action did not execute through CRE; direct execution cannot settle a product monitor");
        monitor = this.get(monitor.id);
        monitor.latestEvidence = copy(acted);
        this.save(monitor);
        if (acted.decision === "act") {
          this.assertSettlement(acted, actionSpec, monitor.target);
          if (isSolanaTarget(monitor.target) && monitor.submittedSignature && acted.solanaTransfer?.signature !== monitor.submittedSignature)
            throw new Error("Verified transfer signature differs from the persisted submitted transaction");
          monitor.status = "completed";
          monitor.stopReason = `${monitor.spec.graph.action.type === "pause-vault" ? "Pause" : "Solana transfer"} confirmed on chain; this monitor will not submit another action.`;
          this.log(monitor, monitor.stopReason);
        } else if (acted.transaction || acted.solanaTransfer) {
          throw new Error("An action receipt cannot be accepted as a no-op; inspect the recorded transaction before retrying");
        } else if (monitor.status !== "paused") {
          // The runner fetched inputs again; a changed price can safely cancel the write.
          monitor.status = "active";
        }
      } else { monitor.status = "active"; }
      monitor.failures = 0;
      delete monitor.lastError;
      delete monitor.phase;
      if (monitor.status === "active") monitor.nextCheckAt = new Date(this.now() + monitor.intervalSeconds * 1000).toISOString();
      this.save(monitor);
    } catch (error) {
      monitor = this.get(monitor.id);
      const message = error instanceof Error ? error.message : String(error);
      check.error = message;
      monitor.lastError = message;
      monitor.failures++;
      const uncertain = broadcasting || Boolean(check.observation?.transaction || check.observation?.solanaTransfer);
      if (uncertain) {
        monitor.status = "uncertain";
        monitor.stopReason = "An action may have been submitted. Monitoring stopped; inspect the recorded run on chain before retrying.";
        delete monitor.nextCheckAt;
      } else if (monitor.status !== "paused") {
        monitor.status = monitor.failures >= MAX_FAILURES ? "failed" : "active";
        if (monitor.status === "active") {
          const delaySeconds = Math.min(3600, monitor.intervalSeconds * 2 ** monitor.failures);
          monitor.nextCheckAt = new Date(this.now() + delaySeconds * 1000).toISOString();
        } else {
          monitor.stopReason = `Stopped after ${MAX_FAILURES} consecutive observation failures. No report was submitted.`;
          delete monitor.nextCheckAt;
        }
      }
      this.log(monitor, `${uncertain ? "Uncertain action" : "Check failed"}: ${message}`);
      this.save(monitor);
    } finally {
      check.completedAt = this.iso();
      this.saveCheck(check);
    }
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.busy || this.options.scheduling === false) return;
    const next = this.list().filter(m => m.status === "active" && m.nextCheckAt).map(m => Date.parse(m.nextCheckAt!));
    if (!next.length) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, Math.max(10, Math.min(...next) - this.now()));
    this.timer.unref();
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
