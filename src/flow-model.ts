import { MarkerType, type Node, type Edge } from "@xyflow/react";
import type { CanvasState, GraphObject, ExecutionRun, PolicyGraph } from "../shared/types";
import { graphInputs, policyView, sourceObjectId } from "./policy-view";
import { actionObjectId } from "./policy-language";

export type InstrumentData = {
  kind: "price" | "vault" | "source" | "conditions" | "action" | "run" | "section";
  state: CanvasState;
  object?: GraphObject;
  run?: ExecutionRun;
  graphNode?: PolicyGraph["nodes"][number];
  focused: boolean;
  lane?: "policy" | "markets" | "evidence";
  title?: string;
};
export type InstrumentFlowNode = Node<InstrumentData, "instrument">;
export function reconcileCanvasNodes(previous: InstrumentFlowNode[], next: InstrumentFlowNode[]) {
  const existing = new Map(previous.map(node => [node.id, node]));
  return next.map(node => ({ ...existing.get(node.id), ...node }));
}
export function canvasFlow(state: CanvasState) {
  const view = policyView(state);
  const nodes: InstrumentFlowNode[] = [];
  const edges: Edge[] = [];
  const focus = state.focus.objectId;
  const actionId = actionObjectId(view.graph.action);
  const add = (id: string, kind: InstrumentData["kind"], x: number, y: number, extra: Partial<InstrumentData> = {}) =>
    nodes.push({id,type:"instrument",position:{x,y},style:{width:kind==="run" ? 360 : 280},draggable:false,selectable:false,
      data:{kind,state,focused:focus===id,...extra}});
  const edge = (id: string, source: string, target: string, label: string, extra: Partial<Edge> = {}) =>
    edges.push({id,source,target,sourceHandle:"out",targetHandle:"in",label,...extra});
  const active = state.workflow.created || !!view.run;
  const visible = view.objects.filter(o => o.visible);
  const byId = new Map(view.graph.nodes.map(n => [n.id,n]));
  const canvasId = (id: string): string => {
    const node = byId.get(id)!;
    return node.kind === "price" ? sourceObjectId(node.source) : "condition:" + id;
  };
  const ranks = new Map<string,number>();
  const rank = (id: string): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    const inputs = graphInputs(byId.get(id)!);
    const value = inputs.length ? Math.max(...inputs.map(rank)) + 1 : byId.get(id)!.kind === "price" ? 0 : 1;
    ranks.set(id,value);
    return value;
  };
  const occupied = new Map<number,number>();
  const emitted = new Set<string>();
  let policyHeight = 330, actionRank = 2;
  if (active) {
    actionRank = rank(view.graph.root) + 1;
    add("section:policy","section",40,0,{title:view.run ? `Frozen run · v${view.revision}` : "Draft policy",lane:"policy"});
    for (const node of view.graph.nodes) {
      const id = canvasId(node.id);
      if (!emitted.has(id)) {
        const column = rank(node.id);
        const row = occupied.get(column) || 0;
        occupied.set(column,row+1);
        add(id,node.kind==="price" ? "price" : "conditions",40+column*360,46+row*360,{
          object:node.kind==="price" ? view.objects.find(o => o.id===id) : undefined,
          graphNode:node,lane:"policy"});
        emitted.add(id);
        policyHeight = Math.max(policyHeight,(row+1)*360);
      }
      for (const input of graphInputs(node)) edge(`graph:${input}:${node.id}`,canvasId(input),id,node.kind==="and"||node.kind==="or"||node.kind==="not" ? node.kind.toUpperCase() : node.kind);
    }
    add(actionId,"action",40+actionRank*360,46,{lane:"policy"});
    const rootResult = view.run?.decisions.find(decision => decision.nodeId === view.graph.root);
    edge("graph:root-action",canvasId(view.graph.root),actionId,rootResult ? `root evaluated: ${rootResult.passed ? "true" : "false"}` : "if root passes");
  }
  const vault = visible.find(o => o.kind==="vault");
  const vaultUsed = !active || view.graph.action.type === "pause-vault" || view.graph.nodes.some(node => node.kind === "vault-paused");
  if (vault && vaultUsed) {
    add(vault.id,"vault",40+(active ? actionRank+1 : 1)*360,46,{object:vault,lane:"policy"});
    if (active && view.graph.action.type==="pause-vault") edge("graph:action-vault","action:pause",vault.id,"pause",{sourceHandle:"report",targetHandle:"report-in"});
    // State readers are roots in the drawing to avoid implying a cycle back into their own action.
  }
  const markets = view.run ? [] : visible.filter(o => (o.kind==="price"||o.kind==="feed") && !emitted.has(o.id));
  const independentVault = !view.run && vault && !vaultUsed ? vault : undefined;
  const observationCount = markets.length + Number(!!independentVault);
  const marketY = active || vault ? 46+policyHeight+64 : 46;
  if (observationCount) {
    add("section:markets","section",40,marketY-36,{title:active ? "Other observations" : "Market observations",lane:"markets"});
    markets.forEach((o,i)=>add(o.id,"price",40+i%4*360,marketY+Math.floor(i/4)*360,{object:o,lane:"markets"}));
    if (independentVault) { const index = markets.length; add(independentVault.id,"vault",40+index%4*360,marketY+Math.floor(index/4)*360,{object:independentVault,lane:"markets"}); }
  }
  const sources = view.run ? [] : visible.filter(o=>o.kind==="source");
  const extraY = marketY+Math.ceil(observationCount/4)*360+46;
  sources.forEach((o,i)=>add(o.id,"source",40+i%4*360,extraY+Math.floor(i/4)*360,{object:o,lane:"evidence"}));
  // A draft has no execution evidence attached. Node IDs can be reused across
  // revisions, so even a visually identical old result belongs to its frozen run.
  const run = view.run;
  if (run) {
    add(`run:${run.id}`,"run",40+actionRank*360,extraY+Math.ceil(sources.length/4)*360,{run,lane:"evidence"});
    if (active) edge(`evidence:${run.id}`,actionId,`run:${run.id}`,"result",{sourceHandle:"evidence",style:{strokeDasharray:"4 5"}});
  }
  return {nodes,edges:edges.map(e=>({type:"smoothstep",markerEnd:{type:MarkerType.ArrowClosed,color:"var(--bab-line-lit)"},
    labelStyle:{fill:"var(--bab-text-dim)",fontFamily:"var(--bab-mono)",fontSize:13},labelBgStyle:{fill:"var(--bab-black)"},
    ...e,style:{stroke:"var(--bab-line-lit)",strokeWidth:1,...e.style}}))};
}
