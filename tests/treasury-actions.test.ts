// Backend coverage for the winner-inspired capabilities: contract readings,
// math/time nodes, treasury actions, recipes and standing policies, plus the
// second QA pass's fixes. Everything runs on the fixture vault with injected
// readings; tests/anvil-integration.test.ts covers the same actions on chain.
import { test, expect } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { resolveFeedSymbol } from "../server/chainlink";
import { RECIPES, recipeById } from "../server/recipes";
import { toolDefinitions } from "../server/schemas";
import { compactMcpResult, RUN_SUMMARY_LIMIT } from "../scripts/mcp-compact";
import { FEED_REGISTRY, POR_REGISTRY, TOKEN_REGISTRY, LENDING_REGISTRY, sourceKey, validateGraph, type Source } from "../cre/graph";
import type { GraphObject } from "../shared/types";

const iso = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const op = () => crypto.randomUUID();
const vault = (paused = false): GraphObject => ({
  id: "vault:grant", kind: "vault", label: "Grant vault", data: { paused, balance: "0.12", balanceEth: 0.12, fixture: true },
  provenance: { source: "Fixture", kind: "fixture", label: "Fixture vault", observedAt: iso(), fetchedAt: iso() }, visible: true, pinned: false,
});
const coinbase = (usd: number): GraphObject => ({
  id: "price:eth-usd", kind: "price", label: "ETH / USD", data: { price: usd, symbol: "ETH", token: "coinbase:ETH-USD", history: [] },
  provenance: { source: "Coinbase Exchange", kind: "live", label: "Test trade", observedAt: iso(3), fetchedAt: iso() }, visible: true, pinned: false,
});
const feed = (symbol: string, usd: number): GraphObject => {
  const address = FEED_REGISTRY["ethereum-mainnet"][symbol as "BTC"]!;
  return {
    id: `feed:${symbol.toLowerCase()}-usd`, kind: "feed", label: `${symbol} / USD · Chainlink`,
    data: { price: usd, symbol, answer: String(Math.round(usd * 1e8)), roundId: "1", feedAddress: address, network: "ethereum-mainnet" },
    provenance: { source: "Chainlink Data Feed", kind: "chain", address, label: "test feed", observedAt: iso(600), fetchedAt: iso() }, visible: true, pinned: false,
  };
};
type Readings = { reserves: number; supply: number; aave: number; compound: number };
function reading(source: Exclude<Source, { type: "exchange-trade" | "chainlink-feed" | "vault-balance" }>, values: Readings): GraphObject {
  const identity = source.type === "proof-of-reserve" ? { address: POR_REGISTRY.WBTC.address, value: values.reserves, unit: "WBTC", updated: 1800 }
    : source.type === "token-supply" ? { address: TOKEN_REGISTRY.WBTC.address, value: values.supply, unit: "WBTC", updated: 0 }
    : { address: LENDING_REGISTRY[source.protocol].address, value: source.protocol === "aave-v3" ? values.aave : values.compound, unit: "%", updated: 0 };
  return {
    id: `reading:${sourceKey(source)}`, kind: "reading", label: "test reading",
    data: { value: identity.value, unit: identity.unit, display: String(identity.value), raw: String(identity.value), sourceKey: sourceKey(source), source, address: identity.address, network: "ethereum-mainnet", ageLabel: "now" },
    provenance: { source: "test", kind: "chain", label: "test", address: identity.address, observedAt: iso(identity.updated), fetchedAt: iso() }, visible: true, pinned: false,
  };
}
const FEEDS: Record<string, number> = { ETH: 2500, BTC: 85000, USDC: 0.9996, USDT: 1.0001 };
function create(overrides: Partial<Readings & { ethUsd: number; paused: boolean }> = {}) {
  const values = { reserves: 129_000, supply: 128_500, aave: 3.1, compound: 3.9, ...overrides };
  const scheduled: { callback: () => void; ms: number }[] = [];
  const engine = new Engine(new StateStore(":memory:"), {
    fetchPrice: async () => coinbase(overrides.ethUsd ?? 2500),
    fetchVault: async (paused = false) => vault(paused || Boolean(overrides.paused)),
    loadDeployment: async () => null,
    fetchFeedPrice: async (symbol: string) => feed(resolveFeedSymbol(symbol)!.symbol, symbol === "ETH" ? overrides.ethUsd ?? FEEDS.ETH! : FEEDS[resolveFeedSymbol(symbol)!.symbol] ?? 1),
    fetchReading: async (source) => reading(source as any, values),
    schedule: (callback, ms) => { scheduled.push({ callback, ms }); return () => {}; },
  });
  return { engine, scheduled, values };
}
const settle = async (engine: Engine) => {
  for (let i = 0; i < 200 && engine.state.runs.some((r) => !["confirmed", "no-op", "failed"].includes(r.status)); i++) await Bun.sleep(5);
};
const runNow = async (engine: Engine) => {
  const started = await engine.invoke("run_workflow", { expectedRevision: engine.state.workflow.revision, operationId: op() });
  expect(started.ok).toBe(true);
  await settle(engine);
  return engine.state.runs[0]!;
};

test("list_sources and read_source show contract readings with their units, address and age", async () => {
  const { engine } = create();
  const listed = await engine.invoke("list_sources", {});
  expect(listed.summary).toContain('Proof of Reserve WBTC');
  expect(listed.summary).toContain('{"type":"lending-rate","protocol":"compound-v3","asset":"USDC"}');
  const read = await engine.invoke("read_source", { source: { type: "proof-of-reserve", asset: "WBTC" }, operationId: op() });
  expect(read.ok).toBe(true);
  expect(read.state.focus.objectId).toBe("reading:proof-of-reserve:ethereum-mainnet:WBTC");
  expect(read.summary).toContain(POR_REGISTRY.WBTC.address);
  const bad = await engine.invoke("read_source", { source: { type: "proof-of-reserve", asset: "DOGE" }, operationId: op() });
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/^Invalid read_source arguments: asset/);
  expect(bad.error).not.toContain('"code"');
});

test("a composed reserve-coverage graph draws readings → ratio → compare → action, and runs a fixture sweep", async () => {
  const { engine } = create({ reserves: 120_000 });
  await engine.invoke("discover_objects", { objects: ["vault"], operationId: op() });
  const composed = await engine.invoke("compose_graph", { expectedRevision: 0, operationId: op(), graph: {
    nodes: [
      { id: "reserves", kind: "reading", source: { type: "proof-of-reserve", asset: "WBTC" } },
      { id: "supply", kind: "reading", source: { type: "token-supply", token: "WBTC" } },
      { id: "coverage", kind: "math", op: "/", left: "reserves", right: "supply" },
      { id: "short", kind: "compare", input: "coverage", op: "<", value: 1 },
    ], root: "short", action: { type: "sweep", fraction: 0.5 } } });
  expect(composed.ok).toBe(true);
  expect(composed.summary).toContain("Sweeps go only to the reserve fixed when the vault was deployed, and spending pauses in the same report.");
  expect(engine.state.objects.find((o) => o.id === "condition:coverage")).toMatchObject({ label: "(Chainlink WBTC Proof of Reserve ÷ WBTC total supply)", data: { math: true } });
  await engine.invoke("read_source", { source: { type: "proof-of-reserve", asset: "WBTC" }, operationId: op() });
  await engine.invoke("read_source", { source: { type: "token-supply", token: "WBTC" }, operationId: op() });
  const edges = engine.context().edges.map((e) => `${e.from}>${e.to}:${e.label}`).sort();
  expect(edges).toEqual([
    "action:pause>vault:grant:sweeps to reserve",
    "condition:coverage>condition:short:compares",
    "condition:short>action:pause:if true",
    "reading:proof-of-reserve:ethereum-mainnet:WBTC>condition:coverage:/ left",
    "reading:token-supply:ethereum-mainnet:WBTC>condition:coverage:/ right",
  ].sort());
  // "the condition" means the comparison, not the computed ratio.
  await engine.invoke("focus_object", { reference: "condition", operationId: op() });
  expect(engine.state.focus.objectId).toBe("condition:short");
  const run = await runNow(engine);
  expect(run.status).toBe("confirmed");
  expect(run.evidence?.fixtureEffects).toEqual({ sweptEth: 0.06, paused: true });
  expect(run.observations?.map((o) => [o.key, o.value, o.unit])).toEqual([["proof-of-reserve:ethereum-mainnet:WBTC", 120000, "WBTC"], ["token-supply:ethereum-mainnet:WBTC", 128500, "WBTC"]]);
  expect(engine.state.activity.summary).toBe("Revision 1: fixture vault swept 0.06 ETH to the reserve and paused in memory; no transaction.");
  expect(engine.state.objects.find((o) => o.id === "vault:grant")!.data).toMatchObject({ balanceEth: 0.06, reserveEth: 0.06, paused: true });
  // Decisions name conditions, never node ids.
  for (const decision of run.decisions) expect(decision.detail).not.toMatch(/\b(short|coverage|reserves)\b(?! ÷)/);
});

test("every recipe composes against the fixture and credits the project that inspired it", async () => {
  for (const recipe of RECIPES) {
    const { engine } = create();
    await engine.invoke("discover_objects", { operationId: op() });
    const applied = await engine.invoke("apply_recipe", { expectedRevision: 1 - 1, recipe: recipe.id, operationId: op() });
    expect(applied.ok).toBe(true);
    expect(applied.summary).toContain(recipe.inspiredBy[0]!.project);
    expect(validateGraph(engine.state.workflow.graph).graph.action.type).toBe(recipe.build(recipe.params.parse({})).action.type);
  }
  const catalog = await create().engine.invoke("list_recipes", {});
  for (const recipe of RECIPES) expect(catalog.summary).toContain(recipe.id);
  expect(catalog.summary).toContain("SentinelCRE (Convergence 2026, CRE & AI, 1st place)");
  const { engine } = create();
  await engine.invoke("discover_objects", { operationId: op() });
  const unknown = await engine.invoke("apply_recipe", { expectedRevision: 0, recipe: "drain-everything", operationId: op() });
  expect(unknown.ok).toBe(false);
  const badParam = await engine.invoke("apply_recipe", { expectedRevision: 0, recipe: "grant-stream", params: { amountEth: 50 }, operationId: op() });
  expect(badParam.ok).toBe(false);
  const extra = await engine.invoke("apply_recipe", { expectedRevision: 0, recipe: "grant-stream", params: { to: "0xattacker" }, operationId: op() });
  expect(extra.ok).toBe(false);
});

test("recipes run end to end in the fixture: stream pays, cover pays the insured, evacuation queues tokens, the yield chase is simulated", async () => {
  const cases: [string, Record<string, unknown>, (run: any, engine: Engine) => void][] = [
    ["grant-stream", { amountEth: 0.001 }, (run) => expect(run.evidence.fixtureEffects).toEqual({ paidEth: 0.001, payee: "grantee" })],
    ["parametric-cover", { strike: 3000 }, (run) => expect(run.evidence.fixtureEffects).toEqual({ paidEth: 0.002, payee: "insured" })],
    ["crash-evacuation", { floor: 3000 }, (run, engine) => { expect(run.evidence.fixtureEffects).toEqual({ paused: true, evacuatedTokens: 2 }); expect(engine.state.objects.find((o) => o.id === "vault:grant")!.data.ccipTokens).toBe(0); }],
    ["yield-chaser", {}, (run) => { expect(run.evidence.simulatedRebalance).toMatchObject({ simulated: true, from: "aave-v3", to: "compound-v3", fromAprPercent: 3.1, toAprPercent: 3.9 }); expect(run.evidence.transactionHash).toBeUndefined(); }],
    ["runway-guard", { minUsd: 1000 }, (run) => expect(run.evidence.fixtureEffects).toEqual({ paused: true })],
    ["depeg-shield", { maxSpread: 0.0001 }, (run) => expect(run.evidence.fixtureEffects).toEqual({ paused: true })],
  ];
  for (const [id, params, check] of cases) {
    const { engine } = create();
    await engine.invoke("discover_objects", { operationId: op() });
    expect((await engine.invoke("apply_recipe", { expectedRevision: 0, recipe: id, params, operationId: op() })).ok).toBe(true);
    const run = await runNow(engine);
    expect([id, run.status, run.error]).toEqual([id, "confirmed", undefined]);
    check(run, engine);
  }
});

test("watch_policy re-checks a frozen revision quietly, stops after it acts, and survives draft edits", async () => {
  const { engine, scheduled } = create({ ethUsd: 2500 });
  await engine.invoke("discover_objects", { operationId: op() });
  await engine.invoke("apply_recipe", { expectedRevision: 0, recipe: "crash-evacuation", params: { floor: 2000 }, operationId: op() });
  const watched = await engine.invoke("watch_policy", { expectedRevision: 1, everySeconds: 60, maxChecks: 5, operationId: op() });
  expect(watched.ok).toBe(true);
  expect(watched.summary).toContain("Watching revision 1 every 60s for up to 5 checks; it stops after the first time it acts.");
  expect(scheduled.at(-1)!.ms).toBe(10);
  const lines = engine.state.conversation.length;
  // Two quiet checks: nothing to do, nothing said, next check scheduled a minute out.
  for (const n of [1, 2]) {
    const run = await engine.tickWatch();
    expect(run).toMatchObject({ status: "no-op", trigger: "watch", watchCheck: n });
    expect(scheduled.at(-1)!.ms).toBe(60_000);
  }
  expect(engine.state.conversation.length).toBe(lines);
  expect(engine.state.activity.summary).toMatch(/^Watching revision 1: check 2 of 5, no action/);
  // Editing the draft does not change what is watched.
  await engine.invoke("apply_recipe", { expectedRevision: 1, recipe: "grant-stream", operationId: op() });
  expect((await engine.invoke("describe_policy", {})).summary).toContain("Watching revision 1 every 60s: check 2 of 5");
  // ETH crashes: the next check acts and the watch stops itself.
  engine.sources.fetchFeedPrice = async (symbol: string) => feed(resolveFeedSymbol(symbol)!.symbol, 1800);
  const acted = await engine.tickWatch();
  expect(acted).toMatchObject({ status: "confirmed", revision: 1, action: "evacuate" });
  expect(engine.state.watch).toMatchObject({ status: "stopped", checks: 3 });
  expect(engine.state.watch!.stopReason).toMatch(/^acted on check 3\./);
  expect(engine.state.conversation.at(-1)!.text).toMatch(/^Watch on revision 1 acted on check 3/);
  expect(await engine.tickWatch()).toBeUndefined();
});

test("a watch ends after its last check or on request, refuses stale revisions, and never resumes after a restart", async () => {
  const store = new StateStore(":memory:");
  const { engine } = create({ ethUsd: 2500 });
  await engine.invoke("discover_objects", { operationId: op() });
  await engine.invoke("apply_recipe", { expectedRevision: 0, recipe: "crash-evacuation", operationId: op() });
  expect((await engine.invoke("watch_policy", { expectedRevision: 0, operationId: op() })).error).toContain("watch it with expectedRevision 1");
  expect((await engine.invoke("watch_policy", { expectedRevision: 1, everySeconds: 5, operationId: op() })).ok).toBe(false);
  await engine.invoke("watch_policy", { expectedRevision: 1, everySeconds: 30, maxChecks: 2, operationId: op() });
  await engine.tickWatch();
  await engine.tickWatch();
  expect(engine.state.watch).toMatchObject({ status: "stopped", checks: 2 });
  expect(engine.state.watch!.stopReason).toMatch(/^finished all 2 checks/);
  await engine.invoke("watch_policy", { expectedRevision: 1, operationId: op() });
  const stopped = await engine.invoke("stop_watching", { operationId: op() });
  expect(stopped.summary).toMatch(/^Stopped watching revision 1 after 0 checks/);
  expect((await engine.invoke("stop_watching", { operationId: op() })).ok).toBe(false);
  // Persisted as watching, restarted: the new process does not resume it.
  await engine.invoke("watch_policy", { expectedRevision: 1, operationId: op() });
  store.save(engine.state);
  const restarted = new Engine(store, { loadDeployment: async () => null, schedule: () => () => {} });
  expect(restarted.state.watch).toMatchObject({ status: "stopped", stopReason: "The backend restarted; call watch_policy again to resume." });
  // The MCP view carries the watch without its frozen snapshot.
  const view = compactMcpResult({ ok: true, summary: "", state: engine.context() }, "get_context");
  expect((view.state as any).watch).toMatchObject({ status: "watching", revision: 1 });
  expect("snapshot" in (view.state as any).watch).toBe(false);
});

test("pay guards: a paused fixture vault never pays, and the guard explains why", async () => {
  const { engine } = create({ paused: true });
  await engine.invoke("discover_objects", { operationId: op() });
  await engine.invoke("apply_recipe", { expectedRevision: 0, recipe: "parametric-cover", params: { strike: 3000 }, operationId: op() });
  const run = await runNow(engine);
  expect(run.status).toBe("no-op");
  expect(run.noopReason).toBe("Vault spending is paused; no payment is made.");
});

// ---- second QA pass ----
test("QA2-1: returning to the scalar rule removes the composed graph's conditions", async () => {
  const { engine } = create();
  await engine.invoke("discover_objects", { operationId: op() });
  const composite = { nodes: [
    { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } }, { id: "btc", kind: "price", source: { type: "chainlink-feed", symbol: "BTC" } },
    { id: "ethLow", kind: "compare", input: "eth", op: "<", value: 3000 }, { id: "btcLow", kind: "compare", input: "btc", op: "<", value: 90000 },
    { id: "both", kind: "and", inputs: ["ethLow", "btcLow"] }], root: "both", action: { type: "pause-vault" } };
  const conditions = () => engine.state.objects.filter((o) => o.id.startsWith("condition:")).map((o) => o.id);
  await engine.invoke("patch_workflow", { expectedRevision: 0, patch: { threshold: 3000 }, operationId: op() });
  await engine.invoke("compose_graph", { expectedRevision: 1, operationId: op(), graph: composite });
  // Undo back to the scalar revision.
  expect((await engine.invoke("undo_revision", { expectedRevision: 2, operationId: op() })).ok).toBe(true);
  expect(conditions()).toEqual(["condition:threshold"]);
  expect((await engine.invoke("focus_object", { reference: "btcLow", operationId: op() })).ok).toBe(false);
  // Composing a single-compare rule directly lands on the same shape.
  await engine.invoke("compose_graph", { expectedRevision: 3, operationId: op(), graph: composite });
  await engine.invoke("compose_graph", { expectedRevision: 4, operationId: op(), graph: { nodes: composite.nodes.slice(0, 1).concat([{ id: "x", kind: "compare", input: "eth", op: "<", value: 2900 } as any]), root: "x", action: { type: "pause-vault" } } });
  expect(conditions()).toEqual(["condition:threshold"]);
});

test("QA2-2: compose discloses an inherited freshness cap and accepts a new one", async () => {
  const { engine } = create();
  await engine.invoke("discover_objects", { operationId: op() });
  await engine.invoke("patch_workflow", { expectedRevision: 0, patch: { maxAgeSeconds: 15 }, operationId: op() });
  const graph = { nodes: [{ id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } }, { id: "a", kind: "compare", input: "eth", op: ">", value: 1 }, { id: "b", kind: "compare", input: "eth", op: "<", value: 9 }, { id: "c", kind: "or", inputs: ["a", "b"] }], root: "c", action: { type: "pause-vault" } };
  const inherited = await engine.invoke("compose_graph", { expectedRevision: 1, graph, operationId: op() });
  expect(inherited.summary).toContain("The Coinbase trade must be at most 15s old (kept from the previous revision; pass maxAgeSeconds to change it).");
  const reset = await engine.invoke("compose_graph", { expectedRevision: 2, graph, maxAgeSeconds: null, operationId: op() });
  expect(reset.summary).not.toContain("at most");
  expect(engine.state.workflow.maxAgeSeconds).toBeNull();
});

test("QA2-3: a feed-only policy accepts cap and guard edits without a Coinbase price", async () => {
  const { engine } = create();
  await engine.invoke("discover_objects", { objects: ["vault"], operationId: op() });
  await engine.invoke("compose_graph", { expectedRevision: 0, operationId: op(), graph: { nodes: [{ id: "usdc", kind: "price", source: { type: "chainlink-feed", symbol: "USDC" } }, { id: "d", kind: "compare", input: "usdc", op: "<", value: 0.99 }], root: "d", action: { type: "pause-vault" } } });
  expect((await engine.invoke("patch_workflow", { expectedRevision: 1, patch: { skipPaused: true }, operationId: op() })).ok).toBe(true);
});

test("QA2-4/5/7: navigation never idles a running run; clarifications expire; unknown names list what exists", async () => {
  const { engine } = create();
  await engine.invoke("discover_objects", { tokens: ["ETH"], operationId: op() });
  await engine.invoke("read_price_feed", { symbol: "BTC", operationId: op() });
  await engine.invoke("compose_graph", { expectedRevision: 0, operationId: op(), graph: { nodes: [
    { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } }, { id: "btc", kind: "price", source: { type: "chainlink-feed", symbol: "BTC" } },
    { id: "ethLow", kind: "compare", input: "eth", op: "<", value: 1 }, { id: "btcLow", kind: "compare", input: "btc", op: "<", value: 1 },
    { id: "any", kind: "or", inputs: ["ethLow", "btcLow"] }], root: "any", action: { type: "pause-vault" } } });
  await engine.invoke("focus_object", { reference: "condition", operationId: op() });
  expect(engine.state.clarification).toBeDefined();
  await engine.invoke("discover_objects", { objects: ["vault"], operationId: op() });
  expect(engine.state.clarification).toBeUndefined();
  const eth = await engine.invoke("focus_object", { reference: "ETH", operationId: op() });
  expect(eth.state.focus.objectId).toBe("price:eth-usd");
  const missing = await engine.invoke("inspect_object", { reference: "dogecoin", operationId: op() });
  expect(missing.error).toMatch(/^Nothing on the canvas matches "dogecoin"\. Visible objects: /);
  // U7: a condition inspects as a sentence.
  const condition = await engine.invoke("inspect_object", { reference: "condition:btcLow", operationId: op() });
  expect(condition.summary).toMatch(/^Chainlink BTC\/USD \(mainnet\) < \$1\. Part of revision 1: /);
  // B10 leftover: focus and inspect while a run executes leave the activity executing.
  engine.state.runs.unshift({ id: "run-busy", revision: 1, snapshot: engine.state.workflow.revisions[0]!, status: "fetching", startedAt: iso(), executionMode: "x", decisions: [], logs: [] });
  engine.state.activity = { status: "executing", prompt: "", summary: "Running" };
  await engine.invoke("focus_object", { reference: "vault", operationId: op() });
  await engine.invoke("inspect_object", { reference: "vault", operationId: op() });
  expect(engine.state.activity.status).toBe("executing");
  engine.state.runs.shift();
});

test("QA2-10/11: an older run fetched with get_run does not widen later results; ids are length-bounded", () => {
  const huge = "x".repeat(200_000);
  expect(toolDefinitions.get_run.schema.safeParse({ runId: huge }).success).toBe(false);
  expect(toolDefinitions.reset_session.schema.safeParse({ operationId: "x", expectedSessionId: huge }).success).toBe(false);
  const state: any = { ...new Engine(new StateStore(":memory:"), { loadDeployment: async () => null }).context() };
  state.runs = Array.from({ length: 15 }, (_, i) => ({ id: `run-${i}`, revision: 1, status: "no-op", startedAt: iso(), executionMode: "x", decisions: [], logs: [], snapshot: {} }));
  state.inspectedRunId = "run-14";
  expect(compactMcpResult({ ok: true, summary: "", state }, "describe_policy").state!.runs).toHaveLength(RUN_SUMMARY_LIMIT);
  expect(compactMcpResult({ ok: true, summary: "", state }, "get_run", { runId: "run-14" }).state!.runs).toHaveLength(RUN_SUMMARY_LIMIT + 1);
});

test("recipe parameters are typed: a payee name, never an address; fractions within (0,1]", () => {
  const stream = recipeById("grant-stream")!;
  expect(() => stream.params.parse({ payee: "0xattacker" })).toThrow();
  expect(() => recipeById("reserve-guardian")!.params.parse({ sweepFraction: 2 })).toThrow();
  expect(stream.params.parse({})).toEqual({ amountEth: 0.001, ethFloor: 1000, payee: "grantee" });
});
