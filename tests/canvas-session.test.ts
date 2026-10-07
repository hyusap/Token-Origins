import { test, expect } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { canvasFlow } from "../src/flow-model";
const create = () => new Engine(new StateStore(":memory:"));
test("clear archives the entire session, persists across restart, and restores without chain calls", async () => {
  const engine = create();
  const originalId = engine.state.sessionId;
  engine.state.workflow.created = true;
  engine.state.workflow.revision = 4;
  engine.state.workflow.threshold = 2800;
  engine.state.focus = { objectId: "workflow:treasury", label: "Treasury policy" };
  engine.state.capabilities.vault = "Actual local contract · Anvil";
  engine.state.runs = [{ id: "proof", status: "confirmed", revision: 4, snapshot: { threshold: 2800 }, evidence: { transactionHash: "0x123", pausedAfter: true } }] as any;
  const proof = structuredClone(engine.state.runs);
  const clear = await engine.invoke("reset_session", { operationId: "clear", expectedSessionId: originalId });
  expect(clear.ok).toBe(true); expect(clear.state.runs).toHaveLength(0);
  expect(clear.state.canUndoClear).toBe(true); expect(clear.state.capabilities.vault).toContain("Anvil");
  const restarted = new Engine(engine.store);
  const restored = await restarted.invoke("restore_session", { operationId: "restore", expectedSessionId: clear.state.sessionId });
  expect(restored.ok).toBe(true); expect(restored.state.runs).toEqual(proof);
  expect(restored.state.workflow.threshold).toBe(2800); expect(restored.state.sessionId).not.toBe(originalId);
  expect(restored.state.canUndoClear).toBe(false);
  expect((await restarted.invoke("restore_session", { operationId: "restore" , expectedSessionId: clear.state.sessionId })).duplicate).toBe(true);
});
test("clear rejects stale sessions and active runs; undo does not overwrite new work", async () => {
  const e = create();
  expect((await e.invoke("reset_session", { operationId: "stale", expectedSessionId: "old" })).ok).toBe(false);
  e.state.runs = [{ id: "active", status: "fetching" }] as any;
  expect((await e.invoke("reset_session", { operationId: "active-clear" })).ok).toBe(false);
  e.state.runs = []; e.state.workflow.created = true;
  await e.invoke("reset_session", { operationId: "clear" });
  await e.invoke("submit_utterance", { operationId: "new", text: "new work" });
  expect((await e.invoke("restore_session", { operationId: "undo-new" })).ok).toBe(false);
  expect(e.state.conversation.some(c => c.text === "new work")).toBe(true);
});
test("React Flow adapter retains authoritative relationships and immutable execution evidence", () => {
  const state = create().state;
  state.workflow.created = true; state.workflow.maxAgeSeconds = 60; state.workflow.skipPaused = true;
  state.objects = [{ id: "price:eth-usd", kind: "price", visible: true }, { id: "vault:grant", kind: "vault", visible: true }] as any;
  state.edges = [{ id: "threshold", from: "price:eth-usd", to: "condition:threshold", label: "compares" }, { id: "freshness", from: "price:eth-usd", to: "condition:freshness", label: "timestamp" }, { id: "vault", from: "vault:grant", to: "condition:unpaused", label: "state" }, { id: "and1", from: "condition:threshold", to: "action:pause", label: "if true" }, { id: "and2", from: "condition:freshness", to: "action:pause", label: "and" }, { id: "missing", from: "source:coinbase", to: "price:eth-usd", label: "observes" }];
  const before = JSON.stringify(state);
  const graph = canvasFlow(state);
  const ids = new Set(graph.nodes.map(n => n.id));
  expect(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  expect(graph.edges.find(e => e.id === "graph:root-action")?.source).toBe("condition:" + state.workflow.graph.root);
  expect(graph.nodes.filter(node => node.data.graphNode).map(node => node.data.graphNode!.id).sort())
    .toEqual(state.workflow.graph.nodes.map(node => node.id).sort());
  expect(JSON.stringify(state)).toBe(before);
});
test("semantic viewport navigation changes no draft or execution data", async () => {
  const e = create(); const before = JSON.stringify(e.state.workflow);
  await e.invoke("navigate_canvas", { operationId: "zoom", action: "zoom_in" });
  expect(e.state.canvasView).toEqual({ action: "zoom_in", sequence: 1 });
  expect(JSON.stringify(e.state.workflow)).toBe(before); expect(e.state.runs).toHaveLength(0);
});
