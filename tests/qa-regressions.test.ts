// Regressions for the MCP QA run (.data/mcp-qa/REPORT.md, bugs B1–B13 and the wording issues).
import { test, expect } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { resolveFeedSymbol } from "../server/chainlink";
import { describeGraph, policyGraphSchema, policyHash, legacyGraph, FEED_REGISTRY } from "../cre/graph";
import { compactMcpResult, RUN_SUMMARY_LIMIT } from "../scripts/mcp-compact";
import { toolDefinitions } from "../server/schemas";
import type { GraphObject } from "../shared/types";

const iso = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const coinbase = (symbol: string, usd: number): GraphObject => ({
  id: `price:${symbol.toLowerCase()}-usd`, kind: "price", label: `${symbol} / USD`,
  data: { price: usd, symbol, token: `coinbase:${symbol}-USD`, history: [] },
  provenance: { source: "Coinbase Exchange", kind: "live", label: "Test trade", observedAt: iso(3), fetchedAt: iso() },
  visible: true, pinned: false,
});
const vault = (paused = false): GraphObject => ({
  id: "vault:grant", kind: "vault", label: "Grant vault", data: { paused, fixture: true },
  provenance: { source: "Fixture", kind: "fixture", label: "Fixture vault", observedAt: iso(), fetchedAt: iso() },
  visible: true, pinned: false,
});
const feed = (symbol: string, usd: number, network = "ethereum-mainnet"): GraphObject => {
  const address = FEED_REGISTRY[network as "ethereum-mainnet"][symbol as "BTC"]!;
  return {
    id: `feed:${symbol.toLowerCase()}-usd${network === "ethereum-mainnet" ? "" : ":sepolia"}`, kind: "feed",
    label: `${symbol} / USD · Chainlink${network === "ethereum-mainnet" ? "" : " Sepolia"}`,
    data: { price: usd, symbol, answer: String(Math.round(usd * 1e8)), roundId: "1", feedAddress: address, network },
    provenance: { source: "Chainlink Data Feed", kind: "chain", address, label: "test feed", observedAt: iso(600), fetchedAt: iso() },
    visible: true, pinned: false,
  };
};
const PRICES: Record<string, number> = { ETH: 2600, BTC: 85000, SOL: 150 };
const create = () => new Engine(new StateStore(":memory:"), {
  // Execution asks for a market pair ("ETH-USD"); discovery asks for a symbol.
  fetchPrice: async (token = "ETH") => { const symbol = token.toUpperCase().replace(/-USD$/, ""); return coinbase(symbol, PRICES[symbol] ?? 1); },
  fetchVault: async (paused = false) => vault(paused),
  loadDeployment: async () => null,
  fetchFeedPrice: async (symbol: string, network = "ethereum-mainnet") => feed(resolveFeedSymbol(symbol)!.symbol, symbol.toUpperCase() === "USDC" ? 0.9996 : 85000, network),
});
const price = (id: string, source: object) => ({ id, kind: "price", source });
const ETH = { type: "exchange-trade", pair: "ETH-USD" };
const op = () => crypto.randomUUID();

test("B1: USDC and USD-suffixed names resolve to the right feed", () => {
  for (const input of ["USDC", "usdc", "USD Coin", "USDC/USD", "usdc-usd", "$USDC"]) expect(resolveFeedSymbol(input)?.symbol).toBe("USDC");
  for (const input of ["BTC/USD", "btcusd", "$btc", "bitcoin", "BTC USD"]) expect(resolveFeedSymbol(input)?.symbol).toBe("BTC");
  expect(resolveFeedSymbol("USDT")?.symbol).toBe("USDT");
  expect(resolveFeedSymbol("usd")).toBeNull();
  expect(resolveFeedSymbol("dogwifhat")).toBeNull();
});

test("B1: a USDC depeg policy reads its feed and runs", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { objects: ["vault"], operationId: op() });
  expect((await engine.invoke("read_price_feed", { symbol: "USDC", operationId: op() })).ok).toBe(true);
  const composed = await engine.invoke("compose_graph", { expectedRevision: 0, operationId: op(), graph: {
    nodes: [price("usdc", { type: "chainlink-feed", symbol: "USDC" }), { id: "depeg", kind: "compare", input: "usdc", op: "<", value: 0.9995 }],
    root: "depeg", action: { type: "pause-vault" } } });
  expect(composed.ok).toBe(true);
  await engine.invoke("run_workflow", { expectedRevision: 1, operationId: op() });
  for (let i = 0; i < 100 && !["confirmed", "no-op", "failed"].includes(engine.state.runs[0]!.status); i++) await Bun.sleep(5);
  expect(engine.state.runs[0]!.status).toBe("no-op");
  expect(engine.state.runs[0]!.noopReason).toBe("The policy condition was not met.");
});

test("B2: a feed-only policy composes without a Coinbase price; prerequisites name what to discover", async () => {
  const engine = create();
  const btcOnly = { nodes: [price("btc", { type: "chainlink-feed", symbol: "BTC" }), { id: "drop", kind: "compare", input: "btc", op: "<", value: 90000 }], root: "drop" };
  const noVault = await engine.invoke("compose_graph", { expectedRevision: 0, operationId: op(), graph: { ...btcOnly, action: { type: "pause-vault" } } });
  expect(noVault.ok).toBe(false);
  expect(noVault.error).toBe('Discover the grant vault (discover_objects with objects ["vault"]) before composing this policy');
  // A simulated sell touches no vault, so it needs nothing discovered.
  expect((await engine.invoke("compose_graph", { expectedRevision: 0, operationId: op(), graph: { ...btcOnly, action: { type: "sell", symbol: "BTC", amount: 1, venue: "mock-venue" } } })).ok).toBe(true);
  await engine.invoke("discover_objects", { objects: ["vault"], operationId: op() });
  expect((await engine.invoke("compose_graph", { expectedRevision: 1, operationId: op(), graph: { ...btcOnly, action: { type: "pause-vault" } } })).ok).toBe(true);
});

test("B3: repeated undo walks back through history instead of toggling", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { operationId: op() });
  for (const [revision, threshold] of [[0, 3000], [1, 2900], [2, 2800]] as const)
    await engine.invoke("patch_workflow", { expectedRevision: revision, patch: { threshold }, operationId: op() });
  const thresholds = [];
  for (let revision = 3; revision < 5; revision++) {
    expect((await engine.invoke("undo_revision", { expectedRevision: revision, operationId: op() })).ok).toBe(true);
    thresholds.push(engine.state.workflow.threshold);
  }
  expect(thresholds).toEqual([2900, 3000]);
  const last = await engine.invoke("undo_revision", { expectedRevision: 5, operationId: op() });
  expect(last.ok).toBe(false);
  expect(last.error).toBe("No earlier revision to restore");
  // Editing after an undo, then undoing, returns to the state before that edit.
  await engine.invoke("patch_workflow", { expectedRevision: 5, patch: { threshold: 2500 }, operationId: op() });
  await engine.invoke("undo_revision", { expectedRevision: 6, operationId: op() });
  expect(engine.state.workflow.threshold).toBe(3000);
});

const threeWay = { nodes: [
  price("eth", ETH), price("btc", { type: "chainlink-feed", symbol: "BTC" }), price("sol", { type: "chainlink-feed", symbol: "SOL" }),
  { id: "ethLow", kind: "compare", input: "eth", op: "<", value: 2000 },
  { id: "btcLow", kind: "compare", input: "btc", op: "<", value: 80000 },
  { id: "solHigh", kind: "compare", input: "sol", op: ">", value: 300 },
  { id: "any", kind: "or", inputs: ["ethLow", "btcLow", "solHigh"] },
], root: "any", action: { type: "pause-vault" } };

test("B4: answering a clarification by name focuses that candidate", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { tokens: ["ETH", "BTC"], operationId: op() });
  await engine.invoke("compose_graph", { expectedRevision: 0, graph: threeWay, operationId: op() });
  const ask = await engine.invoke("focus_object", { reference: "condition", operationId: op() });
  expect(engine.state.clarification?.candidates).toEqual(["condition:ethLow", "condition:btcLow", "condition:solHigh"]);
  expect(ask.summary).toContain("Which condition");
  await engine.invoke("focus_object", { reference: "the bitcoin one", operationId: op() });
  expect(engine.state.focus.objectId).toBe("condition:btcLow");
  expect(engine.state.clarification).toBeUndefined();
});

test("B5: provider words pick the Chainlink feed or the Coinbase trade; plain tickers stay the trade", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { tokens: ["BTC"], operationId: op() });
  await engine.invoke("read_price_feed", { symbol: "BTC", operationId: op() });
  await engine.invoke("read_price_feed", { symbol: "BTC", network: "ethereum-sepolia", operationId: op() });
  expect(engine.state.objects.find((o) => o.id === "feed:btc-usd")!.label).toBe("BTC / USD · Chainlink");
  expect(engine.resolve("BTC feed")!.id).toBe("feed:btc-usd");
  expect(engine.resolve("chainlink bitcoin")!.id).toBe("feed:btc-usd");
  expect(engine.resolve("sepolia BTC feed")!.id).toBe("feed:btc-usd:sepolia");
  expect(engine.resolve("coinbase BTC")!.id).toBe("price:btc-usd");
  expect(engine.resolve("btc")!.id).toBe("price:btc-usd");
});

test("B6: canvas edges follow the nested structure and never point at missing objects", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { operationId: op() });
  const nested = { nodes: [
    price("eth", ETH), price("btc", { type: "chainlink-feed", symbol: "BTC" }),
    { id: "A", kind: "compare", input: "eth", op: "<", value: 3000 },
    { id: "B", kind: "compare", input: "btc", op: "<", value: 80000 },
    { id: "C", kind: "vault-paused", equals: true },
    { id: "notC", kind: "not", input: "C" },
    { id: "BorNotC", kind: "or", inputs: ["B", "notC"] },
    { id: "root", kind: "and", inputs: ["A", "BorNotC"] },
  ], root: "root", action: { type: "pause-vault" } };
  await engine.invoke("compose_graph", { expectedRevision: 0, graph: nested, operationId: op() });
  const visible = () => engine.context().edges.map((e) => `${e.from}>${e.to}:${e.label}`).sort();
  // The BTC feed has not been read: no edge may point at it yet.
  expect(visible().some((e) => e.startsWith("feed:"))).toBe(false);
  await engine.invoke("read_price_feed", { symbol: "BTC", operationId: op() });
  expect(visible()).toEqual([
    "action:pause>vault:grant:pauses",
    "condition:A>condition:root:and",
    "condition:BorNotC>condition:root:and",
    "condition:B>condition:BorNotC:or",
    "condition:C>condition:notC:negates",
    "condition:notC>condition:BorNotC:or",
    "condition:root>action:pause:if true",
    "feed:btc-usd>condition:B:compares",
    "price:eth-usd>condition:A:compares",
    "source:coinbase>price:eth-usd:observes",
    "vault:grant>condition:C:state",
  ].sort());
  expect(engine.state.objects.find((o) => o.id === "condition:notC")!.label).toBe("Not (Vault paused)");
  expect(engine.state.objects.find((o) => o.id === "condition:root")!.data).toMatchObject({ logic: true, root: true });
  // Logic nodes are focusable by name but not offered as "the condition".
  await engine.invoke("focus_object", { reference: "condition", operationId: op() });
  expect(engine.state.clarification?.candidates).toEqual(["condition:A", "condition:B", "condition:C"]);
});

test("B7: a shared price input is phrased in full, never as a node id", () => {
  const graph = policyGraphSchema.parse({ nodes: [
    price("eth", ETH),
    { id: "under", kind: "compare", input: "eth", op: "<", value: 3000 },
    { id: "fresh", kind: "freshness", input: "eth", maxAgeSeconds: 60 },
    { id: "both", kind: "and", inputs: ["under", "fresh"] },
  ], root: "both", action: { type: "pause-vault" } });
  expect(describeGraph(graph)).toBe("Pause spending when (Coinbase ETH-USD trade < $3,000 and Coinbase ETH-USD trade observed within 60s).");
});

const settle = async (engine: Engine) => {
  for (let i = 0; i < 200 && engine.state.runs.some((r) => !["confirmed", "no-op", "failed"].includes(r.status)); i++) await Bun.sleep(5);
};

test("B8: the exchange freshness cap is part of the policy hash; feed-only graphs ignore it", async () => {
  const graph = legacyGraph(3000);
  expect(policyHash(graph)).toBe(policyHash(graph, 60));
  expect(policyHash(graph, 30)).not.toBe(policyHash(graph, 60));
  const feedOnly = policyGraphSchema.parse({ nodes: [price("btc", { type: "chainlink-feed", symbol: "BTC" }), { id: "d", kind: "compare", input: "btc", op: "<", value: 1 }], root: "d", action: { type: "pause-vault" } });
  expect(policyHash(feedOnly, 30)).toBe(policyHash(feedOnly, 60));
  const engine = create();
  await engine.invoke("discover_objects", { operationId: op() });
  await engine.invoke("patch_workflow", { expectedRevision: 0, patch: { threshold: 3000 }, operationId: op() });
  const before = engine.state.workflow.policyHash;
  await engine.invoke("patch_workflow", { expectedRevision: 1, patch: { maxAgeSeconds: 30 }, operationId: op() });
  expect(engine.state.workflow.policyHash).not.toBe(before);
  expect((await engine.invoke("describe_policy", {})).summary).toContain("at most 30s old");
});

test("B9, B10, U6: a focused run inspects as that run; polling neither chats nor idles; retries report the outcome", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { operationId: op() });
  await engine.invoke("patch_workflow", { expectedRevision: 0, patch: { threshold: 2000 }, operationId: op() });
  const runOp = op();
  const started = await engine.invoke("run_workflow", { expectedRevision: 1, operationId: runOp });
  const lines = engine.state.conversation.length;
  const activity = engine.state.activity.status;
  await engine.invoke("get_run", { runId: started.runId });
  await engine.invoke("describe_policy", {});
  expect(engine.state.conversation.length).toBe(lines);
  if (engine.state.runs.some((r) => !["confirmed", "no-op", "failed"].includes(r.status))) expect(engine.state.activity.status).toBe(activity);
  await settle(engine);
  const retry = await engine.invoke("run_workflow", { expectedRevision: 1, operationId: runOp });
  expect(retry.duplicate).toBe(true);
  expect(retry.summary).toStartWith(`Same request as before (no new execution). Run ${started.runId} for revision 1 is no-op`);
  await engine.invoke("focus_object", { reference: `run:${started.runId}`, operationId: op() });
  const inspected = await engine.invoke("inspect_object", { reference: "this", operationId: op() });
  expect(inspected.ok).toBe(true);
  expect(inspected.runId).toBe(started.runId);
  expect(inspected.summary).toContain("no-op");
});

test("B11: reset_session leaves the fixture vault's paused state alone", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { operationId: op() });
  await engine.invoke("patch_workflow", { expectedRevision: 0, patch: { threshold: 3000 }, operationId: op() });
  await engine.invoke("run_workflow", { expectedRevision: 1, operationId: op() });
  await settle(engine);
  expect(engine.state.runs[0]!.status).toBe("confirmed");
  const reset = await engine.invoke("reset_session", { operationId: op() });
  expect(reset.summary).toContain("Contract state is unchanged");
  await engine.invoke("discover_objects", { objects: ["vault"], operationId: op() });
  expect(engine.state.objects.find((o) => o.id === "vault:grant")!.data.paused).toBe(true);
});

test("B12: free-text arguments are bounded", () => {
  const huge = "x".repeat(200_000);
  expect(toolDefinitions.set_activity.schema.safeParse({ status: "thinking", prompt: huge, summary: "s" }).success).toBe(false);
  expect(toolDefinitions.focus_object.schema.safeParse({ reference: huge, operationId: op() }).success).toBe(false);
  expect(toolDefinitions.patch_workflow.schema.safeParse({ expectedRevision: 0, patch: {}, reason: huge, operationId: op() }).success).toBe(false);
});

test("B13: compact results carry at most the last runs, without snapshots, plus a total count", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { operationId: op() });
  await engine.invoke("patch_workflow", { expectedRevision: 0, patch: { threshold: 2000 }, operationId: op() });
  for (let i = 0; i < RUN_SUMMARY_LIMIT + 3; i++) {
    await engine.invoke("run_workflow", { expectedRevision: 1, operationId: op() });
    await settle(engine);
  }
  const result = await engine.invoke("describe_policy", {});
  const view = compactMcpResult(result as any, "describe_policy");
  expect(view.state!.runs).toHaveLength(RUN_SUMMARY_LIMIT);
  expect((view.state as any).runCount).toBe(RUN_SUMMARY_LIMIT + 3);
  expect(view.state!.runs.every((run) => !("snapshot" in run))).toBe(true);
  // An explicitly requested older run is still returned in full.
  const oldest = engine.state.runs.at(-1)!.id;
  const full = compactMcpResult((await engine.invoke("get_run", { runId: oldest })) as any, "get_run", { runId: oldest });
  expect(full.state!.runs.find((run) => run.id === oldest)).toHaveProperty("snapshot");
});

test("U4, U5: errors are readable and name the next step", async () => {
  const engine = create();
  await engine.invoke("discover_objects", { operationId: op() });
  const sol = await engine.invoke("compose_graph", { expectedRevision: 0, operationId: op(), graph: {
    nodes: [price("sol", { type: "exchange-trade", pair: "SOLUSD" }), { id: "c", kind: "compare", input: "sol", op: "<", value: 100 }], root: "c", action: { type: "pause-vault" } } });
  expect(sol.ok).toBe(false);
  expect(sol.error).toContain("exact Coinbase USD market such as ETH-USD");
  expect(sol.error).not.toContain('"code"');
  const badOp = await engine.invoke("compose_graph", { expectedRevision: 0, operationId: op(), graph: {
    nodes: [price("eth", ETH), { id: "c", kind: "compare", input: "eth", op: "==", value: 100 }], root: "c", action: { type: "pause-vault" } } });
  expect(badOp.ok).toBe(false);
  expect(badOp.error).not.toContain('"code"');
  await engine.invoke("patch_workflow", { expectedRevision: 0, patch: { threshold: 2500 }, operationId: op() });
  await engine.invoke("patch_workflow", { expectedRevision: 1, patch: { threshold: 2400 }, operationId: op() });
  const stale = await engine.invoke("run_workflow", { expectedRevision: 1, operationId: op() });
  expect(stale.ok).toBe(false);
  expect(stale.error).toContain("Draft is now revision 2; run it with expectedRevision 2");
  const missing = await engine.invoke("focus_object", { reference: "dogecoin chart", operationId: op() });
  expect(missing.ok).toBe(false);
  expect(missing.error).toContain("Grant vault");
});
