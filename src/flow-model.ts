import { MarkerType, type Node, type Edge } from "@xyflow/react";
import type { CanvasState, GraphObject, ExecutionRun } from "../shared/types";
export type InstrumentData = {
  kind: "price" | "vault" | "source" | "conditions" | "action" | "run";
  state: CanvasState;
  object?: GraphObject;
  run?: ExecutionRun;
  focused: boolean;
};
export type InstrumentFlowNode = Node<InstrumentData, "instrument">;
export function canvasFlow(state: CanvasState) {
  const nodes: InstrumentFlowNode[] = [];
  const focus = state.focus.objectId;
  const add = (id: string, kind: InstrumentData["kind"], x: number, y: number, width: number, extra: Partial<InstrumentData> = {}) =>
    nodes.push({ id, type: "instrument", position: { x, y }, style: { width }, draggable: false, selectable: false,
      data: { kind, state, focused: focus === id, ...extra } });
  const visible = state.objects.filter(o => o.visible);
  const prices = visible.filter(o => o.kind === "price").sort((a, b) => Number(b.id === "price:eth-usd") - Number(a.id === "price:eth-usd"));
  const vault = visible.find(o => o.kind === "vault");
  const sources = visible.filter(o => o.kind === "source");
  prices.forEach((price, index) => add(price.id, "price", index === 0 ? 40 : -675 - (index - 1) % 3 * 365, index === 0 ? 35 : 35 + Math.floor((index - 1) / 3) * 345, 330, { object: price }));
  if (vault) add(vault.id, "vault", 770, 35, 330, { object: vault });
  sources.forEach((source, index) => add(source.id, "source", -310, 35 + index * 345, 275, { object: source }));
  if (state.workflow.created) {
    add("conditions:and", "conditions", 770, 350, 330, { focused: !!focus?.startsWith("condition:") });
    add("action:pause", "action", 405, 485, 310);
  }
  const run = state.runs.find(r => r.id === state.inspectedRunId) || state.runs[0];
  if (run) add(`run:${run.id}`, "run", 40, 345, 330, { run });
  const ids = new Set(nodes.map(n => n.id));
  const edges: Edge[] = [];
  const combined: string[] = [];
  for (const relation of state.edges) {
    const sourceCondition = relation.from.startsWith("condition:");
    const targetCondition = relation.to.startsWith("condition:");
    const from = sourceCondition ? "conditions:and" : relation.from;
    const to = targetCondition ? "conditions:and" : relation.to;
    if (!ids.has(from) || !ids.has(to)) continue;
    if (sourceCondition && relation.to === "action:pause") { combined.push(relation.id); continue; }
    edges.push({ id: relation.id, source: from, target: to,
      sourceHandle: relation.from === "action:pause" ? "report" : "out",
      targetHandle: targetCondition ? relation.to.slice("condition:".length) : relation.to === "vault:grant" && relation.from === "action:pause" ? "report-in" : "in",
      label: relation.label, data: { relationshipIds: [relation.id] } });
  }
  if (combined.length) edges.push({ id: "conditions-output", source: "conditions:and", target: "action:pause", sourceHandle: "out", targetHandle: "in", label: "all pass", data: { relationshipIds: combined } });
  if (run && ids.has("action:pause")) edges.push({ id: `evidence:${run.id}`, source: "action:pause", target: `run:${run.id}`, sourceHandle: "evidence", targetHandle: "in", label: "result", style: { strokeDasharray: "4 5" }, data: { runId: run.id } });
  return { nodes, edges: edges.map(edge => ({ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, color: "var(--bab-line-lit)" }, style: { stroke: "var(--bab-line-lit)", strokeWidth: 1, ...edge.style }, labelStyle: { fill: "var(--bab-text-mute)", fontFamily: "var(--bab-mono)", fontSize: 9 }, labelBgStyle: { fill: "var(--bab-black)" }, ...edge })) };
}
