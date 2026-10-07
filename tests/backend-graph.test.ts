import { test, expect } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { isLegacyShape, describeGraph } from "../cre/graph";
import type { GraphObject } from "../shared/types";

const price = (): GraphObject => ({
  id: "price:eth-usd",
  kind: "price",
  label: "ETH / USD",
  data: { price: 2500, history: [] },
  provenance: {
    source: "Test adapter",
    kind: "fixture",
    label: "Test input",
    observedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  },
  visible: true,
  pinned: false,
});
const vault = (paused = false): GraphObject => ({
  id: "vault:grant",
  kind: "vault",
  label: "Grant vault",
  data: { paused, balance: "0.12", fixture: true },
  provenance: {
    source: "Fixture",
    kind: "fixture",
    label: "Test fixture",
    observedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  },
  visible: true,
  pinned: false,
});
const create = () =>
  new Engine(new StateStore(":memory:"), {
    fetchPrice: async () => price(),
    fetchVault: async (paused = false) => vault(paused),
    loadDeployment: async () => null,
  });
const discovered = async (engine: Engine) => {
  await engine.invoke("discover_objects", { operationId: "discover" });
  return engine;
};
const ethAndBtc = {
  nodes: [
    { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } },
    { id: "btc", kind: "price", source: { type: "chainlink-feed", symbol: "BTC" } },
    { id: "ethUnder", kind: "compare", input: "eth", op: "<", value: 3000 },
    { id: "btcUnder", kind: "compare", input: "btc", op: "<", value: 90000 },
    { id: "both", kind: "and", inputs: ["ethUnder", "btcUnder"] },
  ],
  root: "both",
  action: { type: "pause-vault" },
};

test("a scalar policy still composes, and carries the equivalent graph", async () => {
  const engine = await discovered(create());
  const result = await engine.invoke("patch_workflow", {
    expectedRevision: 0,
    patch: { threshold: 2800 },
    operationId: "scalar",
  });
  expect(result.ok).toBe(true);
  const workflow = engine.state.workflow;
  expect(workflow.revision).toBe(1);
  expect(isLegacyShape(workflow.graph)).toBe(true);
  expect(describeGraph(workflow.graph)).toContain("$2,800");
  // The spoken sentence the demo relies on is unchanged.
  expect(workflow.summary).toContain("When ETH / USD is below $2,800");
});

test("a two-asset graph composes and describes itself", async () => {
  const engine = await discovered(create());
  const result = await engine.invoke("compose_graph", {
    expectedRevision: 0,
    graph: ethAndBtc,
    operationId: "compose",
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("Coinbase ETH-USD trade < $3,000");
  expect(result.summary).toContain("Chainlink BTC/USD (mainnet) < $90,000");
  // Execution has to know it needs the oracle as well as the exchange.
  expect(result.summary).toContain("Chainlink BTC/USD");
  expect(engine.state.workflow.revision).toBe(1);
  expect(isLegacyShape(engine.state.workflow.graph)).toBe(false);
  expect(engine.state.workflow.summary).toContain("and");
});

test("a scalar threshold edit refuses to silently flatten a composed graph", async () => {
  const engine = await discovered(create());
  await engine.invoke("compose_graph", {
    expectedRevision: 0,
    graph: ethAndBtc,
    operationId: "compose",
  });
  const result = await engine.invoke("patch_workflow", {
    expectedRevision: 1,
    patch: { threshold: 1000 },
    operationId: "flatten",
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("composed graph");
  // The composed policy survives the rejected edit intact.
  expect(engine.state.workflow.revision).toBe(1);
  expect(engine.state.workflow.graph.nodes).toHaveLength(5);
});

test("composition honours optimistic revision checks", async () => {
  const engine = await discovered(create());
  await engine.invoke("compose_graph", {
    expectedRevision: 0,
    graph: ethAndBtc,
    operationId: "first",
  });
  const stale = await engine.invoke("compose_graph", {
    expectedRevision: 0,
    graph: ethAndBtc,
    operationId: "stale",
  });
  expect(stale.ok).toBe(false);
  expect(stale.code).toBe("REVISION_CONFLICT");
});

test("an invalid graph is refused without touching the current policy", async () => {
  const engine = await discovered(create());
  await engine.invoke("patch_workflow", {
    expectedRevision: 0,
    patch: { threshold: 2800 },
    operationId: "scalar",
  });
  const cyclic = {
    nodes: [
      { id: "a", kind: "not", input: "b" },
      { id: "b", kind: "not", input: "a" },
    ],
    root: "a",
    action: { type: "pause-vault" },
  };
  const result = await engine.invoke("compose_graph", {
    expectedRevision: 1,
    graph: cyclic,
    operationId: "cyclic",
  });
  expect(result.ok).toBe(false);
  expect(engine.state.workflow.revision).toBe(1);
  expect(engine.state.workflow.threshold).toBe(2800);

  const smuggled = await engine.invoke("compose_graph", {
    expectedRevision: 1,
    graph: { ...ethAndBtc, action: { type: "drain-vault" } },
    operationId: "smuggled",
  });
  expect(smuggled.ok).toBe(false);
  expect(engine.state.workflow.revision).toBe(1);
});

test("composing before discovery is refused", async () => {
  const result = await create().invoke("compose_graph", {
    expectedRevision: 0,
    graph: ethAndBtc,
    operationId: "early",
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("Discover price and vault");
});

test("describe_policy reports the rule and the sources execution will fetch", async () => {
  const engine = await discovered(create());
  expect((await engine.invoke("describe_policy", {})).summary).toContain("No policy");
  await engine.invoke("compose_graph", {
    expectedRevision: 0,
    graph: ethAndBtc,
    operationId: "compose",
  });
  const result = await engine.invoke("describe_policy", {});
  expect(result.summary).toContain("Coinbase ETH-USD trade");
  expect(result.summary).toContain("Chainlink BTC/USD");
  expect(result.summary).toContain("freshness cap");
});

test("a frozen run keeps the graph that was composed when it started", async () => {
  const engine = await discovered(create());
  await engine.invoke("compose_graph", {
    expectedRevision: 0,
    graph: ethAndBtc,
    operationId: "compose",
  });
  await engine.invoke("run_workflow", { expectedRevision: 1, operationId: "run" });
  const run = engine.state.runs[0]!;
  expect(run.snapshot.graph.nodes).toHaveLength(5);
  // Revising afterwards must not reach back into the frozen snapshot.
  await engine.invoke("compose_graph", {
    expectedRevision: 1,
    graph: { ...ethAndBtc, nodes: [ethAndBtc.nodes[0], ethAndBtc.nodes[2]], root: "ethUnder" },
    operationId: "revise",
  });
  expect(run.snapshot.graph.nodes).toHaveLength(5);
  expect(engine.state.workflow.graph.nodes).toHaveLength(2);
});
