import { test, expect } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { canvasFlow, reconcileCanvasNodes } from "../src/flow-model";
const create = () => new Engine(new StateStore(":memory:"));
test("adding another market preserves discovery order without privileging ETH", () => {
  const state = create().state;
  state.objects = [{ id: "price:btc-usd", kind: "price", visible: true }] as any;
  const previous = canvasFlow(state).nodes;
  previous.find(node => node.id === "price:btc-usd")!.measured = { width: 280, height: 280 };
  state.objects.push({ id: "price:eth-usd", kind: "price", visible: true } as any);
  const next = reconcileCanvasNodes(previous, canvasFlow(state).nodes);
  const btc = next.find(node => node.id === "price:btc-usd")!;
  const eth = next.find(node => node.id === "price:eth-usd")!;
  expect(btc.position).toEqual({ x: 40, y: 46 });
  expect(btc.position.x + 280).toBeLessThan(eth.position.x);
  expect(btc.measured).toEqual({ width: 280, height: 280 });
  state.objects = state.objects.filter(object => object.id !== eth.id);
  expect(reconcileCanvasNodes(next, canvasFlow(state).nodes).find(node => node.id === btc.id)!.position).toEqual({ x: 40, y: 46 });
});
test("policy reads left to right and unrelated markets do not move its cards", () => {
  const state = create().state;
  state.workflow.created = true;
  state.objects = [{ id: "price:eth-usd", kind: "price", visible: true }, { id: "vault:grant", kind: "vault", visible: true }] as any;
  state.edges = [{ id: "threshold", from: "price:eth-usd", to: "condition:threshold", label: "compares" }, { id: "output", from: "condition:threshold", to: "action:pause", label: "if true" }, { id: "report", from: "action:pause", to: "vault:grant", label: "pauses" }];
  const before = canvasFlow(state);
  const policy = before.nodes.filter(node => node.data.lane === "policy" && node.data.kind !== "section");
  expect(policy.map(node => node.id)).toEqual(["price:eth-usd", "condition:under-threshold", "action:pause", "vault:grant"]);
  for (let index = 1; index < policy.length; index++) {
    expect(policy[index]!.position.y).toBe(policy[0]!.position.y);
    expect(policy[index]!.position.x - policy[index - 1]!.position.x - Number(policy[index - 1]!.style!.width)).toBe(80);
  }
  state.objects.push(...[{ id: "price:btc-usd", kind: "price", visible: true }, { id: "price:sol-usd", kind: "price", visible: true }] as any);
  const after = canvasFlow(state);
  for (const node of policy) expect(after.nodes.find(item => item.id === node.id)!.position).toEqual(node.position);
  expect(after.nodes.filter(node => node.data.lane === "markets").every(node => node.position.y > 400)).toBe(true);
  for (const edge of after.edges) {
    expect(after.nodes.find(node => node.id === edge.source)!.position.x).toBeLessThan(after.nodes.find(node => node.id === edge.target)!.position.x);
  }
  expect(after.edges.find(edge => edge.id === "graph:action-vault")!.targetHandle).toBe("report-in");
});
test("clear starts a persistent fresh session with increasing state sequence", async () => {
  const engine = create();
  const originalId = engine.state.sessionId;
  engine.state.seq = 42;
  engine.state.workflow.created = true;
  engine.state.workflow.threshold = 2800;
  engine.state.capabilities.vault = "Actual local contract · Anvil";
  engine.state.conversation = [{ role: "user", text: "old work" }] as any;
  const clear = await engine.invoke("reset_session", { operationId: "clear", expectedSessionId: originalId });
  expect(clear.ok).toBe(true);
  expect(clear.state.seq).toBeGreaterThan(42);
  expect(clear.state.sessionId).not.toBe(originalId);
  expect(clear.state.objects).toHaveLength(0);
  expect(clear.state.runs).toHaveLength(0);
  expect(clear.state.workflow.created).toBe(false);
  expect(clear.state.conversation.some(c => c.role === "user")).toBe(false);
  expect(clear.state.capabilities.vault).toContain("Anvil");
  const restarted = new Engine(engine.store);
  expect(restarted.state.sessionId).toBe(clear.state.sessionId);
  expect(restarted.state.workflow.created).toBe(false);
});
test("clear rejects stale sessions and active chain runs", async () => {
  const e = create();
  expect((await e.invoke("reset_session", { operationId: "stale", expectedSessionId: "old" })).ok).toBe(false);
  e.state.runs = [{ id: "active", status: "fetching" }] as any;
  expect((await e.invoke("reset_session", { operationId: "active-clear" })).ok).toBe(false);
});
test("React Flow adapter retains authoritative relationships and immutable execution evidence", () => {
  const state = create().state;
  state.workflow.created = true; state.workflow.maxAgeSeconds = 60; state.workflow.skipPaused = true;
  state.workflow.graph = {
    nodes: [
      { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } },
      { id: "threshold", kind: "compare", input: "eth", op: "<", value: 2800 },
      { id: "freshness", kind: "freshness", input: "eth", maxAgeSeconds: 60 },
      { id: "unpaused", kind: "vault-paused", equals: false },
      { id: "all", kind: "and", inputs: ["threshold", "freshness", "unpaused"] },
    ], root: "all", action: { type: "pause-vault" },
  };
  state.objects = [{ id: "price:eth-usd", kind: "price", visible: true }, { id: "vault:grant", kind: "vault", visible: true }] as any;
  state.edges = [{ id: "threshold", from: "price:eth-usd", to: "condition:threshold", label: "compares" }, { id: "freshness", from: "price:eth-usd", to: "condition:freshness", label: "timestamp" }, { id: "vault", from: "vault:grant", to: "condition:unpaused", label: "state" }, { id: "and1", from: "condition:threshold", to: "action:pause", label: "if true" }, { id: "and2", from: "condition:freshness", to: "action:pause", label: "and" }, { id: "missing", from: "source:coinbase", to: "price:eth-usd", label: "observes" }];
  const before = JSON.stringify(state);
  const graph = canvasFlow(state);
  const ids = new Set(graph.nodes.map(n => n.id));
  expect(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  expect(graph.edges.find(e => e.id === "graph:eth:freshness")?.targetHandle).toBe("in");
  expect(graph.edges.filter(edge => edge.target === "condition:all").map(edge => edge.source)).toEqual(["condition:threshold", "condition:freshness", "condition:unpaused"]);
  expect(graph.edges.find(edge => edge.id === "graph:root-action")?.source).toBe("condition:all");
  expect(graph.nodes.filter(node => node.data.graphNode).map(node => node.data.graphNode!.id).sort()).toEqual(state.workflow.graph.nodes.map(node => node.id).sort());
  expect(JSON.stringify(state)).toBe(before);
});
test("semantic viewport navigation changes no draft or execution data", async () => {
  const e = create(); const before = JSON.stringify(e.state.workflow);
  await e.invoke("navigate_canvas", { operationId: "zoom", action: "zoom_in" });
  expect(e.state.canvasView).toEqual({ action: "zoom_in", sequence: 1 });
  expect(JSON.stringify(e.state.workflow)).toBe(before); expect(e.state.runs).toHaveLength(0);
});
