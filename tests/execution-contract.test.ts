import { test, expect } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { migrateState, STATE_VERSION } from "../server/migrate";
import { describeAge } from "../server/chainlink";
import { policyHash, FEED_REGISTRY, legacyGraph } from "../cre/graph";
import type { ExecutionEvidence } from "../cre/runner";
import type { CanvasState, GraphObject } from "../shared/types";

const iso = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const ethPrice = (usd: number): GraphObject => ({
  id: "price:eth-usd", kind: "price", label: "ETH / USD",
  data: { price: usd, history: [] },
  provenance: { source: "Test adapter", kind: "fixture", label: "Test input", observedAt: iso(5), fetchedAt: iso() },
  visible: true, pinned: false,
});
const fixtureVault = (paused = false): GraphObject => ({
  id: "vault:grant", kind: "vault", label: "Grant vault",
  data: { paused, balance: "0.12", fixture: true },
  provenance: { source: "Fixture", kind: "fixture", label: "Fixture vault · no deployed contract", observedAt: iso(), fetchedAt: iso() },
  visible: true, pinned: false,
});
const feedObject = (symbol: string, usd: number, network: "ethereum-mainnet" | "ethereum-sepolia" = "ethereum-mainnet"): GraphObject => {
  const address = FEED_REGISTRY[network][symbol as "BTC"]!;
  return {
    id: `feed:${symbol.toLowerCase()}-usd`, kind: "feed", label: `${symbol} / USD`,
    data: { price: usd, symbol, answer: String(Math.round(usd * 1e8)), roundId: "42", feedAddress: address, network, ageLabel: describeAge(600) },
    provenance: { source: "Chainlink Data Feed", kind: "chain", chainId: network === "ethereum-mainnet" ? 1 : 11155111, address, label: "test feed", observedAt: iso(600), fetchedAt: iso() },
    visible: true, pinned: false,
  };
};
function create(options: { eth?: number; btc?: number; paused?: boolean; store?: StateStore; overrides?: Record<string, unknown> } = {}) {
  let paused = options.paused ?? false;
  return new Engine(options.store ?? new StateStore(":memory:"), {
    fetchPrice: async () => ethPrice(options.eth ?? 2500),
    fetchVault: async (fixturePaused = false) => fixtureVault(paused || fixturePaused),
    loadDeployment: async () => null,
    fetchFeedPrice: async (symbol: string, network = "ethereum-mainnet") => feedObject(symbol, options.btc ?? 85000, network as any),
    ...options.overrides,
  });
}
async function settle(engine: Engine) {
  for (let i = 0; i < 200; i++) {
    if (engine.state.runs.length && engine.state.runs.every((r) => ["confirmed", "no-op", "failed"].includes(r.status))) return engine.state.runs[0]!;
    await Bun.sleep(5);
  }
  throw new Error("Run did not settle");
}
const node = {
  eth: { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } },
  btc: { id: "btc", kind: "price", source: { type: "chainlink-feed", symbol: "BTC" } },
};
const orGraph = (order: "eth-first" | "btc-first") => {
  const a = { id: "a", kind: "compare", input: "eth", op: "<", value: 3000 };
  const b = { id: "b", kind: "compare", input: "btc", op: "<", value: 90000 };
  return {
    nodes: order === "eth-first" ? [node.eth, node.btc, a, b, { id: "or", kind: "or", inputs: ["a", "b"] }] : [node.btc, node.eth, b, a, { id: "or", kind: "or", inputs: ["b", "a"] }],
    root: "or", action: { type: "pause-vault" },
  };
};
async function composeAndRun(engine: Engine, graph: unknown) {
  await engine.invoke("discover_objects", { operationId: "discover" });
  const composed = await engine.invoke("compose_graph", { expectedRevision: engine.state.workflow.revision, graph, operationId: `compose-${crypto.randomUUID()}` });
  expect(composed.ok).toBe(true);
  await engine.invoke("run_workflow", { expectedRevision: engine.state.workflow.revision, operationId: `run-${crypto.randomUUID()}` });
  return settle(engine);
}

test("J1: node order changes neither the stored policy identity nor the decision", async () => {
  const results = [];
  for (const order of ["eth-first", "btc-first"] as const) {
    // ETH $3500 fails its branch; BTC $85k passes; OR holds either way.
    const engine = create({ eth: 3500, btc: 85000 });
    const run = await composeAndRun(engine, orGraph(order));
    results.push({ hash: engine.state.workflow.policyHash, threshold: engine.state.workflow.threshold, status: run.status, runHash: run.policyHash });
  }
  expect(results[0]!.hash).toBe(results[1]!.hash!);
  expect(results[0]!.threshold).toBe(results[1]!.threshold);
  expect(results.map((r) => r.status)).toEqual(["confirmed", "confirmed"]);
  expect(results[0]!.runHash).toBe(results[0]!.hash!);
});

test("J2: the fixture path evaluates the composed graph, not a scalar threshold", async () => {
  const engine = create({ eth: 2500 });
  const run = await composeAndRun(engine, { nodes: [node.eth, { id: "above", kind: "compare", input: "eth", op: ">", value: 3000 }], root: "above", action: { type: "pause-vault" } });
  expect(run.status).toBe("no-op");
  expect(run.noopReason).toBe("The policy condition was not met.");
  expect(engine.fixturePaused).toBe(false);
  expect(run.decisions.find((d) => d.nodeId === "guard:root")?.passed).toBe(false);
});

test("J3: a simulated sell yields simulated evidence only, with no pause and no transaction", async () => {
  const engine = create({ btc: 85000 });
  const run = await composeAndRun(engine, {
    nodes: [node.btc, { id: "drop", kind: "compare", input: "btc", op: "<", value: 90000 }],
    root: "drop", action: { type: "sell", symbol: "BTC", amount: 0.5, venue: "mock-venue" },
  });
  expect(run.status).toBe("confirmed");
  expect(run.evidence?.simulatedOrder).toMatchObject({ simulated: true, symbol: "BTC", amount: 0.5, referencePriceUsd: 85000, notionalUsd: 42500 });
  expect(run.evidence?.transactionHash).toBeUndefined();
  expect(run.evidence?.pausedAfter).toBeUndefined();
  expect(engine.fixturePaused).toBe(false);
  expect(engine.state.activity.summary).toContain("simulated sell of 0.5 BTC; no transaction, no asset moved");
  expect(engine.state.objects.find((o) => o.id === "action:pause")?.label).toBe("Simulated sell of 0.5 BTC");
});

test("every source reading is archived with its identity, and the feed card shows the execution read", async () => {
  const engine = create({ eth: 2500, btc: 85000 });
  const run = await composeAndRun(engine, orGraph("eth-first"));
  const btc = run.observations?.find((o) => o.provider === "chainlink");
  expect(btc).toMatchObject({ key: "chainlink-feed:ethereum-mainnet:BTC", network: "ethereum-mainnet", chainId: 1, address: FEED_REGISTRY["ethereum-mainnet"].BTC, usd: 85000, roundId: "42" });
  expect(run.observations?.find((o) => o.provider === "coinbase")?.usd).toBe(2500);
  expect(engine.state.objects.some((o) => o.id === "feed:btc-usd")).toBe(true);
  expect(engine.state.edges.some((e) => e.from === "feed:btc-usd")).toBe(true);
});

test("J5: revising during a run leaves the frozen graph and its inputs untouched", async () => {
  const engine = create({ eth: 2500 });
  await engine.invoke("discover_objects", { operationId: "d" });
  await engine.invoke("compose_graph", { expectedRevision: 0, graph: orGraph("eth-first"), operationId: "c1" });
  await engine.invoke("run_workflow", { expectedRevision: 1, operationId: "r1" });
  const frozen = structuredClone(engine.state.runs[0]!.snapshot);
  await engine.invoke("compose_graph", { expectedRevision: 1, graph: { nodes: [node.eth, { id: "x", kind: "compare", input: "eth", op: "<", value: 1 }], root: "x", action: { type: "pause-vault" } }, operationId: "c2" });
  const run = await settle(engine);
  expect(run.snapshot).toEqual(frozen);
  expect(run.policyHash).toBe(frozen.policyHash!);
  expect(engine.state.workflow.revision).toBe(2);
  expect(engine.state.workflow.policyHash).not.toBe(frozen.policyHash);
});

test("J6: a pre-graph saved canvas migrates, stays editable, and keeps its historical runs", () => {
  const legacyRun = { id: "run-old", revision: 1, snapshot: { revision: 1, threshold: 2800, maxAgeSeconds: 60, skipPaused: true, createdAt: iso(), reason: "old" }, status: "confirmed", startedAt: iso(), executionMode: "Local EVM rehearsal", decisions: [], logs: [], evidence: { transactionHash: "0xabc", blockNumber: "5" } };
  const old = {
    sessionId: "s", seq: 3, mode: "compose", focus: { objectId: null, label: "" }, previousFocus: [], references: [], objects: [], edges: [],
    workflow: { id: "workflow:treasury", revision: 1, threshold: 2800, maxAgeSeconds: 60, skipPaused: true, summary: "old", created: true, revisions: [{ revision: 1, threshold: 2800, maxAgeSeconds: 60, skipPaused: true, createdAt: iso(), reason: "old" }] },
    runs: [legacyRun], conversation: [], activity: { status: "idle", prompt: "", summary: "" }, latency: [], capabilities: {},
  } as unknown as CanvasState;
  const migrated = migrateState(structuredClone(old));
  expect(migrated.stateVersion).toBe(STATE_VERSION);
  expect(migrated.workflow.graph).toEqual(legacyGraph(2800));
  expect(migrated.workflow.revisions[0]!.policyHash).toBe(policyHash(legacyGraph(2800)));
  // Historical evidence is not rewritten or given a graph it never had.
  expect(migrated.runs[0]).toEqual(legacyRun as any);
});

test("J6: an engine loads a pre-graph database and accepts a scalar edit", async () => {
  const store = new StateStore(":memory:");
  const state = create().state;
  const old = structuredClone(state) as any;
  delete old.stateVersion;
  delete old.workflow.graph;
  delete old.workflow.policyHash;
  Object.assign(old.workflow, { created: true, revision: 1, threshold: 2800, revisions: [{ revision: 1, threshold: 2800, maxAgeSeconds: null, skipPaused: false, createdAt: iso(), reason: "old" }] });
  old.objects = [ethPrice(2500), fixtureVault()];
  store.save(old);
  const engine = create({ store });
  expect(engine.state.workflow.graph).toEqual(legacyGraph(2800));
  const edit = await engine.invoke("patch_workflow", { expectedRevision: 1, patch: { threshold: 2700 }, operationId: "edit" });
  expect(edit.ok).toBe(true);
  expect(engine.state.workflow.graph).toEqual(legacyGraph(2700));
});

function deployedEngine(store: StateStore, overrides: Record<string, unknown>) {
  return create({ store, overrides: { loadDeployment: async () => ({ address: "0x0000000000000000000000000000000000001234", chainId: 31337, rpcUrl: "http://127.0.0.1:8545" }), ...overrides } });
}

test("J10: a restart mid-execution blocks new runs until the chain says what happened", async () => {
  for (const landed of [true, false]) {
    const store = new StateStore(":memory:");
    let release: () => void = () => {};
    const hanging = deployedEngine(store, { executeRun: () => new Promise((resolve) => { release = () => resolve(undefined as never); }) });
    await hanging.invoke("discover_objects", { operationId: "d" });
    await hanging.invoke("patch_workflow", { expectedRevision: 0, patch: { threshold: 3000 }, operationId: "p" });
    await hanging.invoke("run_workflow", { expectedRevision: 1, operationId: "r" });
    await Bun.sleep(30);
    const runId = hanging.state.runs[0]!.id;
    expect(hanging.state.runs[0]!.status).toBe("fetching");

    // A new process starts while the old one was mid-run.
    let answer: (value: any) => void = () => {};
    const restarted = deployedEngine(store, { findSubmittedPause: () => new Promise((resolve) => { answer = resolve; }) });
    expect(restarted.state.runs[0]!.uncertain).toBe(true);
    const blocked = await Promise.race([restarted.invoke("run_workflow", { expectedRevision: 1, operationId: "r2" }), Bun.sleep(50).then(() => null)]);
    // The run request queues behind reconciliation rather than racing it.
    expect(blocked).toBeNull();
    answer(landed ? { landed: true, transactionHash: "0xfeed", blockNumber: 9, paused: true } : { landed: false, paused: false });
    await Bun.sleep(30);
    const run = restarted.state.runs.find((r) => r.id === runId)!;
    expect(run.uncertain).toBe(false);
    if (landed) {
      expect(run.status).toBe("confirmed");
      expect(run.evidence?.transactionHash).toBe("0xfeed");
    } else {
      expect(run.status).toBe("failed");
      expect(run.error).toContain("Safe to run again");
    }
    release();
  }
});

test("J10: an unreachable chain keeps the run uncertain and refuses a blind retry", async () => {
  const store = new StateStore(":memory:");
  const state = create().state as any;
  state.runs = [{ id: "run-x", revision: 1, snapshot: { ...state.workflow }, status: "reporting", startedAt: iso(), executionMode: "Local EVM", decisions: [], logs: [] }];
  state.workflow = { ...state.workflow, created: true, revision: 1, revisions: [{ ...state.workflow, revision: 1 }] };
  store.save(state);
  const engine = deployedEngine(store, { findSubmittedPause: async () => { throw new Error("connection refused"); } });
  await engine.reconcileQueued();
  expect(engine.state.runs[0]!.uncertain).toBe(true);
  expect(engine.state.runs[0]!.error).toContain("Outcome unknown after restart");
  const retry = await engine.invoke("run_workflow", { expectedRevision: 1, operationId: "retry" });
  expect(retry.ok).toBe(false);
  expect(retry.error).toContain("outcome is still unknown");
});

const verifiedPause = (spec: any): ExecutionEvidence => ({
  runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash, mode: "local-evm-rehearsal",
  observations: [{ key: "exchange-trade:ETH-USD", provider: "coinbase", label: "Coinbase ETH-USD trade", usd: 2500, raw: "2500", observedAt: iso(5), fetchedAt: iso() }],
  vault: { address: "0x0000000000000000000000000000000000001234", chainId: 31337, paused: false, balanceWei: "1", reportVersion: 2 },
  conditions: [{ nodeId: "guard:root", kind: "composed-policy", role: "root", passed: true, detail: "true" }],
  root: true, decision: "act", action: "pause-vault", decidedAt: iso(), logs: [],
  transaction: { hash: "0xabc", blockNumber: 7, status: "success", receiverConfirmed: true, pausedAfter: true },
});

test("a deployed run records verified receipt evidence bound to its policy hash", async () => {
  const engine = deployedEngine(new StateStore(":memory:"), { executeRun: async (spec: any) => verifiedPause(spec) });
  const run = await composeAndRun(engine, orGraph("eth-first"));
  expect(run.status).toBe("confirmed");
  expect(run.evidence).toMatchObject({ transactionHash: "0xabc", blockNumber: "7", pausedAfter: true, policyHash: engine.state.workflow.policyHash });
  expect(run.executionMode).toBe("Local EVM rehearsal · no CRE consensus");
  expect(engine.state.activity.summary).toContain("vault paused at block 7");
});

test("a failed write and mismatched evidence are failures, never confirmations", async () => {
  const failing = deployedEngine(new StateStore(":memory:"), { executeRun: async () => { throw new Error("Transaction, receiver event, and fresh pause read did not all confirm"); } });
  const failed = await composeAndRun(failing, orGraph("eth-first"));
  expect(failed.status).toBe("failed");
  expect(failed.evidence).toBeUndefined();
  const forged = deployedEngine(new StateStore(":memory:"), { executeRun: async (spec: any) => ({ ...verifiedPause(spec), policyHash: `0x${"1".repeat(64)}` }) });
  const mismatched = await composeAndRun(forged, orGraph("eth-first"));
  expect(mismatched.status).toBe("failed");
  expect(mismatched.error).toContain("policy hash");
  const unverified = deployedEngine(new StateStore(":memory:"), { executeRun: async (spec: any) => ({ ...verifiedPause(spec), transaction: { ...verifiedPause(spec).transaction!, receiverConfirmed: false } }) });
  expect((await composeAndRun(unverified, orGraph("eth-first"))).status).toBe("failed");
});

test("orphan nodes, unregistered feeds and oversized graphs are refused at compose time", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { operationId: "d" });
  const orphan = await engine.invoke("compose_graph", { expectedRevision: 0, graph: { ...orGraph("eth-first"), root: "a" }, operationId: "o" });
  expect(orphan.ok).toBe(false);
  expect(orphan.error).toContain("not connected");
  const sepoliaSol = await engine.invoke("compose_graph", { expectedRevision: 0, graph: { nodes: [{ id: "s", kind: "price", source: { type: "chainlink-feed", symbol: "SOL", network: "ethereum-sepolia" } }, { id: "c", kind: "compare", input: "s", op: "<", value: 1 }], root: "c", action: { type: "pause-vault" } }, operationId: "s" });
  expect(sepoliaSol.ok).toBe(false);
  expect(sepoliaSol.error).toContain("Ethereum Sepolia");
  expect(engine.state.workflow.revision).toBe(0);
});
