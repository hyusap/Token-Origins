import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PolicyMonitorManager, type MonitorExecutor, type PolicyMonitor } from "../server/monitor";
import { legacyGraph, policyHash, sourceIdentity } from "../cre/graph";
import type { ExecutionSpecification } from "../cre/spec";
import type { ExecutionEvidence } from "../cre/runner";
import { Keypair } from "@solana/web3.js";
import { SOLANA_GENESIS } from "../server/solana";
import { policyOperationKey, type SolanaExecutionTarget } from "../shared/execution-target";

const target = { chainId: 11155111, executor: "cre" as const, address: "0x1111111111111111111111111111111111111111" };
const graph = () => legacyGraph(3000);
const spec = (): ExecutionSpecification => ({ version: 2, runId: "activation", revision: 1, graph: graph(), policyHash: policyHash(graph()), maxAgeSeconds: 60, broadcast: true });
const managers: PolicyMonitorManager[] = [];
const databases: Database[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.close(); for (const db of databases.splice(0)) db.close(); });
const database = () => { const db = new Database(":memory:"); databases.push(db); return db; };
function evidence(input: ExecutionSpecification, decision: "act" | "noop" = "noop"): ExecutionEvidence {
  return {
    runId: input.runId, revision: input.revision, policyHash: input.policyHash, mode: "cre-local-simulation",
    vault: { ...target, paused: false, balanceWei: "10", reportVersion: 2 },
    observations: [{ ...sourceIdentity({ type: "exchange-trade", pair: "ETH-USD" }), usd: decision === "act" ? 2500 : 3500,
      raw: "2500", observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString() }],
    conditions: [], root: decision === "act", decision, action: "pause-vault", decidedAt: new Date().toISOString(),
    logs: [], ...(input.broadcast === false && decision === "act" ? { dryRun: true } : {}),
  };
}
function harness(execute: MonitorExecutor = async input => evidence(input), db = database()) {
  let time = Date.parse("2026-10-07T00:00:00Z");
  const manager = new PolicyMonitorManager(db, execute, { scheduling: false, now: () => time });
  managers.push(manager);
  return { manager, db, advance: (seconds: number) => { time += seconds * 1000; }, activate: (overrides = {}) => manager.activate({ spec: spec(), target, sessionId: "session", activationId: "activate", intervalSeconds: 15, ...overrides }) };
}

test("activation freezes the exact graph, revision, vault and freshness cap", async () => {
  const seen: ExecutionSpecification[] = [];
  const h = harness(async input => { seen.push(structuredClone(input)); input.graph.root = "mutated-runner"; return { ...evidence(input), policyHash: spec().policyHash }; });
  const input = spec();
  const activated = h.activate({ spec: input });
  input.graph.root = "changed-after-activation";
  activated.spec.graph.root = "changed-return-value";
  const stored = h.manager.get(activated.id);
  expect(stored.spec.graph.root).toBe(spec().graph.root);
  await h.manager.tick();
  expect(seen[0]!.revision).toBe(1);
  expect(seen[0]!.maxAgeSeconds).toBe(60);
  expect(h.manager.get(activated.id).spec.graph.root).toBe(spec().graph.root);
});

test("safe no-op checks continue only at the configured interval and retain every observation", async () => {
  const h = harness();
  const m = h.activate();
  await h.manager.tick();
  expect(h.manager.get(m.id).status).toBe("active");
  expect(h.manager.get(m.id).checks).toBe(1);
  await h.manager.tick();
  h.advance(14);
  await h.manager.tick();
  expect(h.manager.get(m.id).checks).toBe(1);
  h.advance(1);
  await h.manager.tick();
  expect(h.manager.get(m.id).checks).toBe(2);
  const checks = h.manager.checks(m.id);
  expect(checks).toHaveLength(2);
  expect(checks[0]!.observation!.observations[0]!.key).toBe("exchange-trade:ETH-USD");
  expect(checks[0]!.observation!.runId).not.toBe(checks[1]!.observation!.runId);
});

test("activation deduplicates stable IDs and rejects reuse for a different policy", () => {
  const h = harness();
  const m = h.activate();
  expect(h.activate().id).toBe(m.id);
  expect(h.activate({ activationId: "another" }).id).toBe(m.id);
  expect(h.manager.list()).toHaveLength(1);
  expect(() => h.activate({ intervalSeconds: 30 })).toThrow("reused");
});

test("unsupported targets and too frequent intervals cannot activate", () => {
  const h = harness();
  for (const seconds of [0, 14, 15.1, 3601]) expect(() => h.activate({ intervalSeconds: seconds })).toThrow("interval");
  expect(() => h.activate({ target: { ...target, chainId: 1 } })).toThrow("mainnet");
  expect(() => h.activate({ target: { ...target, address: "fixture" } })).toThrow("target");
  expect(h.manager.list()).toHaveLength(0);
});

test("a real verified pause uses separate observation/action IDs and stops forever", async () => {
  const seen: ExecutionSpecification[] = [];
  const h = harness(async input => {
    seen.push(structuredClone(input));
    return { ...evidence(input, "act"), ...(input.broadcast ? { transaction: { hash: "0xabc", blockNumber: 8, status: "success", receiverConfirmed: true, pausedAfter: true } } : {}) };
  });
  const m = h.activate();
  await h.manager.tick();
  expect(seen.map(s => s.broadcast)).toEqual([false, true]);
  expect(seen[0]!.runId).not.toBe(seen[1]!.runId);
  expect(h.manager.get(m.id).status).toBe("completed");
  expect(h.manager.get(m.id).latestEvidence!.transaction!.receiverConfirmed).toBe(true);
  h.advance(1000);
  await h.manager.tick();
  expect(seen).toHaveLength(2);
});

test("fresh action evaluation may change its mind without sending a report", async () => {
  const h = harness(async input => evidence(input, input.broadcast ? "noop" : "act"));
  const m = h.activate();
  await h.manager.tick();
  expect(h.manager.get(m.id).status).toBe("active");
  expect(h.manager.get(m.id).latestEvidence!.decision).toBe("noop");
  expect(h.manager.checks(m.id)[0]!.action!.transaction).toBeUndefined();
});

test("source failures back off visibly and stop after a bounded number of failures", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw new Error("Coinbase source unavailable"); });
  const m = h.activate();
  await h.manager.tick();
  expect(h.manager.get(m.id).lastError).toContain("Coinbase");
  h.advance(29);
  await h.manager.tick();
  expect(calls).toBe(1);
  h.advance(1);
  await h.manager.tick();
  expect(calls).toBe(2);
  for (let i = 0; i < 3; i++) { h.advance(3600); await h.manager.tick(); }
  expect(h.manager.get(m.id).status).toBe("failed");
  expect(h.manager.get(m.id).stopReason).toContain("No report");
  h.advance(3600);
  await h.manager.tick();
  expect(calls).toBe(5);
});

test("a possibly submitted action never gets blindly retried, even with a different graph", async () => {
  let calls = 0;
  const h = harness(async input => { calls++; if (input.broadcast) throw new Error("Receipt RPC timed out"); return evidence(input, "act"); });
  const m = h.activate();
  await h.manager.tick();
  expect(h.manager.get(m.id).status).toBe("uncertain");
  h.advance(3600);
  await h.manager.tick();
  expect(calls).toBe(2);
  const nextSpec = spec();
  nextSpec.graph = legacyGraph(4000); nextSpec.policyHash = policyHash(nextSpec.graph);
  expect(() => h.activate({ activationId: "new", spec: nextSpec })).toThrow("uncertain");
  expect(h.manager.deactivate(m.id).status).toBe("uncertain");
});

test("unverified and fixture actions cannot be claimed as completion", async () => {
  for (const mutate of [
    (e: ExecutionEvidence) => ({ ...e, mode: "fixture-rehearsal" as const, fixturePaused: true }),
    (e: ExecutionEvidence) => ({ ...e, transaction: { hash: "0xabc", blockNumber: 4, status: "success", receiverConfirmed: false, pausedAfter: true } }),
  ]) {
    const h = harness(async input => input.broadcast ? mutate(evidence(input, "act")) : evidence(input, "act"));
    const m = h.activate();
    await h.manager.tick();
    expect(h.manager.get(m.id).status).toBe("uncertain");
    expect(h.manager.get(m.id).lastError).toBeTruthy();
  }
});

test("reopening persisted jobs pauses safe watches and preserves activation dedup", async () => {
  const h = harness();
  const m = h.activate();
  await h.manager.tick();
  h.manager.close();
  let calls = 0;
  const restarted = harness(async input => { calls++; return evidence(input); }, h.db);
  expect(restarted.manager.get(m.id).status).toBe("paused");
  await restarted.manager.tick();
  expect(calls).toBe(0);
  expect(restarted.activate().id).toBe(m.id);
  expect(restarted.activate().status).toBe("paused");
  const resumed = restarted.activate({ activationId: "explicit-new-activation" });
  expect(resumed.id).not.toBe(m.id);
  await restarted.manager.tick();
  expect(calls).toBe(1);
});

test("restart across the durable broadcast barrier becomes uncertain with no new submission", async () => {
  const h = harness();
  const m = h.activate();
  m.status = "checking"; m.phase = "broadcast"; m.lastRunId = `${m.id}_1_action`;
  h.db.query("UPDATE policy_monitors SET status=?,payload=? WHERE id=?").run(m.status, JSON.stringify(m), m.id);
  h.manager.close();
  const restarted = harness(undefined, h.db);
  expect(restarted.manager.get(m.id).status).toBe("uncertain");
  expect(restarted.manager.get(m.id).lastRunId).toBe(m.lastRunId);
  expect(() => restarted.activate({ activationId: "retry" })).toThrow("uncertain");
});

test("deactivation during observation cancels the upcoming write", async () => {
  let release!: (result: ExecutionEvidence) => void;
  let observed!: ExecutionSpecification;
  let calls = 0;
  const h = harness(input => { calls++; observed = input; return new Promise(resolve => { release = resolve; }); });
  const m = h.activate();
  const ticking = h.manager.tick();
  h.manager.deactivate(m.id);
  release(evidence(observed, "act"));
  await ticking;
  expect(h.manager.get(m.id).status).toBe("paused");
  expect(calls).toBe(1);
  expect(h.manager.get(m.id).latestEvidence!.dryRun).toBe(true);
});

test("already paused vault stops without fabricating a transaction", async () => {
  const h = harness(async input => { const e = evidence(input); e.vault!.paused = true; return e; });
  const m = h.activate();
  await h.manager.tick();
  expect(h.manager.get(m.id).status).toBe("paused");
  expect(h.manager.get(m.id).latestEvidence!.transaction).toBeUndefined();
  expect(h.manager.get(m.id).stopReason).toContain("without claiming");
});

test("concurrent ticks share a single in-flight check", async () => {
  let release!: (result: ExecutionEvidence) => void;
  let observed!: ExecutionSpecification;
  const h = harness(input => { observed = input; return new Promise(resolve => { release = resolve; }); });
  const m = h.activate();
  const tick = h.manager.tick();
  await h.manager.tick();
  expect(h.manager.get(m.id).checks).toBe(1);
  release(evidence(observed));
  await tick;
});

async function uncertainHarness() {
  let writes = 0;
  const h = harness(async input => {
    if (input.broadcast) { writes++; throw new Error("Submission outcome unavailable"); }
    return evidence(input, "act");
  });
  const m = h.activate();
  await h.manager.tick();
  return { ...h, id: m.id, writes: () => writes };
}

test("read-only reconciliation verifies a correlated receipt without another submission", async () => {
  const h = await uncertainHarness();
  const recovered = await h.manager.reconcile(h.id, async monitor => ({
    state: "confirmed",
    evidence: { ...evidence({ ...monitor.spec, runId: monitor.lastRunId! }, "act"),
      transaction: { hash: "0xabc", blockNumber: 10, status: "success", receiverConfirmed: true, pausedAfter: true } },
  }));
  expect(recovered.status).toBe("completed");
  expect(recovered.latestEvidence!.transaction!.hash).toBe("0xabc");
  h.advance(3600); await h.manager.tick();
  expect(h.writes()).toBe(1);
});

test("fresh correlated absence proof pauses an uncertain job and requires new explicit activation", async () => {
  const h = await uncertainHarness();
  const recovered = await h.manager.reconcile(h.id, async monitor => ({
    state: "not-submitted", runId: monitor.lastRunId!, revision: monitor.spec.revision, policyHash: monitor.spec.policyHash,
    target: monitor.target, checkedAt: monitor.updatedAt, processed: false,
  }));
  expect(recovered.status).toBe("paused");
  expect(recovered.phase).toBeUndefined();
  h.advance(3600); await h.manager.tick();
  expect(h.writes()).toBe(1);
  expect(h.activate({ activationId: "new-explicit-activation" }).status).toBe("active");
});

test("wrong-run receipts, stale absence proofs, and unavailable chain reads stay uncertain", async () => {
  const h = await uncertainHarness();
  await h.manager.reconcile(h.id, async monitor => ({
    state: "confirmed", evidence: { ...evidence({ ...monitor.spec, runId: "different-run" }, "act"),
      transaction: { hash: "0xabc", blockNumber: 10, status: "success", receiverConfirmed: true, pausedAfter: true } },
  }));
  expect(h.manager.get(h.id).status).toBe("uncertain");
  expect(h.manager.get(h.id).lastError).toContain("frozen");
  await h.manager.reconcile(h.id, async monitor => ({
    state: "not-submitted", runId: monitor.lastRunId!, revision: monitor.spec.revision, policyHash: monitor.spec.policyHash,
    target: monitor.target, checkedAt: "2026-10-06T00:00:00Z", processed: false,
  }));
  expect(h.manager.get(h.id).lastError).toContain("stale");
  await h.manager.reconcile(h.id, async () => { throw new Error("RPC offline"); });
  expect(h.manager.get(h.id).lastError).toContain("RPC offline");
  expect(h.manager.get(h.id).status).toBe("uncertain");
  expect(h.writes()).toBe(1);
});

test("deactivation during broadcasting retains the uncertainty barrier across restart", async () => {
  const h = harness();
  const m = h.activate();
  m.status = "checking"; m.phase = "broadcast"; m.lastRunId = `${m.id}_1_action`;
  h.db.query("UPDATE policy_monitors SET status=?,payload=? WHERE id=?").run(m.status, JSON.stringify(m), m.id);
  expect(h.manager.deactivate(m.id).status).toBe("paused");
  expect(() => h.activate({ activationId: "new" })).toThrow("uncertain");
  h.manager.close();
  const restarted = harness(undefined, h.db);
  expect(restarted.manager.get(m.id).status).toBe("uncertain");
});

test("production scheduling starts only after explicit activation and stops on deactivation", async () => {
  let calls = 0;
  let checked!: () => void;
  const firstCheck = new Promise<void>(resolve => { checked = resolve; });
  const db = database();
  const manager = new PolicyMonitorManager(db, async input => { calls++; checked(); return evidence(input); });
  managers.push(manager);
  expect(calls).toBe(0);
  const monitor = manager.activate({ spec: spec(), target, sessionId: "scheduler", activationId: "explicit", intervalSeconds: 15 });
  await Promise.race([firstCheck, Bun.sleep(1000).then(() => { throw new Error("Activated scheduler never checked its policy"); })]);
  expect(calls).toBe(1);
  manager.deactivate(monitor.id);
  await manager.tick();
  expect(calls).toBe(1);
});

test("activation has a bounded total number of active policies", () => {
  const h = harness();
  const next = (i: number) => {
    const input = spec(); input.graph = legacyGraph(3000 + i); input.policyHash = policyHash(input.graph);
    return h.activate({ activationId: `activate-${i}`, spec: input });
  };
  for (let i = 0; i < 8; i++) next(i);
  expect(() => next(8)).toThrow("At most 8");
  expect(h.manager.list()).toHaveLength(8);
  h.manager.deactivate(h.manager.list()[0]!.id);
  expect(next(8).status).toBe("active");
});

test("a correlated broadcast hash is durable evidence for recovery but never completes a monitor", async () => {
  const hash = `0x${"a".repeat(64)}`;
  const h = harness(async (input, _target, progress) => {
    if (!input.broadcast) return evidence(input, "act");
    progress(`ORIGINS_SUBMITTED ${JSON.stringify({ hash, runId: input.runId, revision: input.revision, policyHash: input.policyHash })}`);
    throw new Error("Receipt unavailable after broadcast");
  });
  const m = h.activate();
  await h.manager.tick();
  expect(h.manager.get(m.id).submittedHash).toBe(hash);
  expect(h.manager.get(m.id).status).toBe("uncertain");
  expect(h.manager.get(m.id).latestEvidence!.transaction).toBeUndefined();
});

test("malformed or different-run broadcast progress cannot set a recovery hash", async () => {
  const h = harness(async (input, _target, progress) => {
    progress("ORIGINS_SUBMITTED {broken}");
    progress(`ORIGINS_SUBMITTED ${JSON.stringify({ hash: `0x${"b".repeat(64)}`, runId: "wrong-run", revision: input.revision, policyHash: input.policyHash })}`);
    if (!input.broadcast) return evidence(input, "act");
    throw new Error("Unknown receipt");
  });
  const m = h.activate();
  await h.manager.tick();
  expect(h.manager.get(m.id).submittedHash).toBeUndefined();
  expect(h.manager.get(m.id).status).toBe("uncertain");
});

const sender = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const solanaTarget: SolanaExecutionTarget = { kind: "solana-wallet", network: "devnet", sender, genesisHash: SOLANA_GENESIS.devnet, executor: "solana-devnet" };
function solanaSpec(): ExecutionSpecification {
  const graph = legacyGraph(200, "SOL-USD");
  graph.action = { type: "solana-transfer", network: "devnet", recipient, amountLamports: 1000 };
  return { version: 2, runId: "activation", revision: 1, graph, policyHash: policyHash(graph), maxAgeSeconds: 60, broadcast: true };
}
function solanaEvidence(input: ExecutionSpecification): ExecutionEvidence {
  const action = input.graph.action;
  if (action.type !== "solana-transfer") throw new Error("Test expects an archived transfer action");
  return { ...evidence(input, "act"), mode: "solana-devnet", action: "solana-transfer", vault: null,
    solanaTransfer: {
      network: "devnet", status: "confirmed", signature: "a".repeat(88), sender, recipient: action.recipient,
      lamports: action.amountLamports, amountSol: action.amountLamports / 1e9, slot: 12, feeLamports: 5000, blockTime: null,
      explorerUrl: "https://explorer.solana.com/tx/test?cluster=devnet", recipientBalanceBefore: 5000, recipientBalanceAfter: 5000 + action.amountLamports,
      idempotencyKey: policyOperationKey(input.runId, input.policyHash), replayed: false, verified: true, genesisHash: SOLANA_GENESIS.devnet,
    } };
}
/** Historical records are seeded as archives, never activated through the product API. */
function archive(h: ReturnType<typeof harness>, overrides: Partial<PolicyMonitor> = {}) {
  const id = `archive_${crypto.randomUUID().replaceAll("-", "")}`;
  const monitor: PolicyMonitor = { id, sessionId: "session", spec: solanaSpec(), target: solanaTarget, status: "uncertain", phase: "broadcast",
    createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z", intervalSeconds: 15, checks: 1, failures: 1,
    lastRunId: `${id}_1_action`, logs: [], ...overrides };
  h.db.query("INSERT INTO policy_monitors(id,status,next_check_at,payload) VALUES(?,?,?,?)").run(id, monitor.status, 0, JSON.stringify(monitor));
  return monitor;
}

test("product activation permits only CRE pause-vault on Sepolia", () => {
  const h = harness();
  const directTargets = [
    { ...target, executor: "testnet-evm" as const },
    { ...target, chainId: 31337, executor: "local-evm" as const },
    { ...target, chainId: 84532 },
    { ...target, chainId: 1 },
  ];
  for (const target of directTargets) expect(() => h.activate({ target })).toThrow("requires CRE");
  expect(() => h.activate({ spec: solanaSpec(), target: solanaTarget })).toThrow("requires CRE");
  expect(h.manager.list()).toHaveLength(0);
});

test("CRE dry evaluation cannot fall back to a direct runner before broadcast", async () => {
  let calls = 0;
  const h = harness(async input => { calls++; return { ...evidence(input, "act"), mode: "testnet-evm" }; });
  const m = h.activate();
  await h.manager.tick();
  expect(calls).toBe(1);
  expect(h.manager.get(m.id).lastError).toContain("did not execute through CRE");
  expect(h.manager.checks(m.id)[0]!.action).toBeUndefined();
});

test("a direct transaction cannot settle a CRE product monitor", async () => {
  const h = harness(async input => ({ ...evidence(input, "act"), ...(input.broadcast ? {
    mode: "testnet-evm" as const, transaction: { hash: "0xabc", blockNumber: 12, status: "success", receiverConfirmed: true, pausedAfter: true },
  } : {}) }));
  const m = h.activate();
  await h.manager.tick();
  expect(h.manager.get(m.id).status).toBe("uncertain");
  expect(h.manager.get(m.id).lastError).toContain("did not execute through CRE");
});

test("archived direct monitors cannot execute even if persisted as active", async () => {
  let calls = 0;
  const h = harness(async input => { calls++; return evidence(input); });
  const solana = archive(h, { status: "active", phase: undefined, nextCheckAt: "2026-10-07T00:00:00.000Z" });
  const local = archive(h, { spec: spec(), target: { chainId: 31337, address: target.address }, status: "active", phase: undefined, nextCheckAt: "2026-10-07T00:00:00.000Z" });
  await h.manager.tick();
  expect(calls).toBe(0);
  expect(h.manager.get(solana.id).status).toBe("paused");
  expect(h.manager.get(local.id).status).toBe("paused");
  expect(h.manager.get(solana.id).stopReason).toContain("archived read-only");
});

test("historical Solana receipt recovery remains read-only and requires exact frozen settlement", async () => {
  let calls = 0;
  const h = harness(async input => { calls++; return evidence(input); });
  const m = archive(h, { submittedSignature: "a".repeat(88) });
  await h.manager.reconcile(m.id, async monitor => {
    const e = solanaEvidence({ ...monitor.spec, runId: monitor.lastRunId! }); e.solanaTransfer!.recipient = sender;
    return { state: "confirmed", evidence: e };
  });
  expect(h.manager.get(m.id).status).toBe("uncertain");
  const recovered = await h.manager.reconcile(m.id, async monitor => ({ state: "confirmed", evidence: solanaEvidence({ ...monitor.spec, runId: monitor.lastRunId! }) }));
  expect(recovered.status).toBe("completed");
  expect(recovered.latestEvidence!.solanaTransfer!.signature).toBe("a".repeat(88));
  await h.manager.tick();
  expect(calls).toBe(0);
  expect(() => h.activate({ spec: solanaSpec(), target: solanaTarget })).toThrow("requires CRE");
});

test("historical Solana expiry stops the old job and never enables a new direct monitor", async () => {
  const h = harness();
  const m = archive(h);
  const recovery = (monitor: PolicyMonitor) => ({ state: "expired" as const, runId: monitor.lastRunId!, revision: monitor.spec.revision,
    policyHash: monitor.spec.policyHash, target: solanaTarget, checkedAt: monitor.updatedAt, signature: "a".repeat(88), journalVerified: true as const, chainVerified: true as const,
    lastValidBlockHeight: 100, blockHeight: 101 });
  await h.manager.reconcile(m.id, async monitor => ({ ...recovery(monitor), blockHeight: 100 }));
  expect(h.manager.get(m.id).status).toBe("uncertain");
  const recovered = await h.manager.reconcile(m.id, async monitor => recovery(monitor));
  expect(recovered.status).toBe("paused");
  expect(recovered.stopReason).toContain("expired");
  h.advance(3600); await h.manager.tick();
  expect(h.manager.get(m.id).checks).toBe(1);
  expect(() => h.activate({ spec: solanaSpec(), target: solanaTarget, activationId: "explicit-new-activation" })).toThrow("requires CRE");
});

test("legacy local targets stay readable and paused across restart", async () => {
  const h = harness();
  const m = archive(h, { spec: spec(), target: { chainId: 31337, address: target.address }, status: "active", phase: undefined });
  h.manager.close();
  const restarted = harness(undefined, h.db);
  expect(restarted.manager.get(m.id).target).toMatchObject({ kind: "evm-vault", chainId: 31337, address: target.address });
  expect(restarted.manager.get(m.id).status).toBe("paused");
  await restarted.manager.tick();
  expect(restarted.manager.get(m.id).checks).toBe(1);
});

test("a recorded archived Solana signature cannot be cleared by contradictory journal absence", async () => {
  const h = harness();
  const m = archive(h, { submittedSignature: "a".repeat(88) });
  const recovered = await h.manager.reconcile(m.id, async monitor => ({ state: "not-submitted", runId: monitor.lastRunId!, revision: monitor.spec.revision,
    policyHash: monitor.spec.policyHash, target: solanaTarget, checkedAt: monitor.updatedAt, processed: false, journalVerified: true, chainVerified: true }));
  expect(recovered.status).toBe("uncertain");
  expect(recovered.lastError).toContain("signed Solana transaction was recorded");
});
