import { MarkerType, type Node, type Edge } from "@xyflow/react";
import type { CanvasState, GraphObject, ExecutionRun, PolicyGraph } from "../shared/types";
import { graphInputs, policyView, sourceObjectId } from "./policy-view";

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
    return node.kind === "price" || node.kind === "reading" ? sourceObjectId(node.source) : "condition:" + id;
  };
  const isSource = (node: PolicyGraph["nodes"][number]) => node.kind === "price" || node.kind === "reading";
  const ranks = new Map<string,number>();
  const rank = (id: string): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    const inputs = graphInputs(byId.get(id)!);
    const value = inputs.length ? Math.max(...inputs.map(rank)) + 1 : isSource(byId.get(id)!) ? 0 : 1;
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
      // The vault's own balance is drawn by the vault card below, not as a separate input.
      if (!emitted.has(id) && id !== "vault:grant") {
        const column = rank(node.id);
        const row = occupied.get(column) || 0;
        occupied.set(column,row+1);
        add(id,isSource(node) ? "price" : "conditions",40+column*360,46+row*360,{
          object:isSource(node) ? view.objects.find(o => o.id===id) : undefined,
          graphNode:node,lane:"policy"});
        emitted.add(id);
        policyHeight = Math.max(policyHeight,(row+1)*360);
      }
      for (const input of graphInputs(node)) edge(`graph:${input}:${node.id}`,canvasId(input),id,node.kind==="and"||node.kind==="or"||node.kind==="not" ? node.kind.toUpperCase() : node.kind==="math" ? node.op : node.kind);
    }
    add("action:pause","action",40+actionRank*360,46,{lane:"policy"});
    edge("graph:root-action",canvasId(view.graph.root),"action:pause","root true");
  }
  const vault = visible.find(o => o.kind==="vault");
  if (vault) {
    add(vault.id,"vault",40+(active ? actionRank+1 : 1)*360,46,{object:vault,lane:"policy"});
    const action = view.graph.action;
    const verb = action.type==="pause-vault" ? "pause" : action.type==="sweep" ? "sweep" : action.type==="pay" ? "pay" : action.type==="evacuate" ? "CCIP" : null;
    if (active && verb) edge("graph:action-vault","action:pause",vault.id,verb,{sourceHandle:"report",targetHandle:"report-in"});
    // State readers are roots in the drawing to avoid implying a cycle back into their own action.
  }
  const markets = view.run ? [] : visible.filter(o => (o.kind==="price"||o.kind==="feed") && !emitted.has(o.id));
  const marketY = active || vault ? 46+policyHeight+64 : 46;
  if (markets.length) {
    add("section:markets","section",40,marketY-36,{title:active ? "Other market observations" : "Market observations",lane:"markets"});
    markets.forEach((o,i)=>add(o.id,"price",40+i%4*360,marketY+Math.floor(i/4)*360,{object:o,lane:"markets"}));
  }
  const sources = view.run ? [] : visible.filter(o=>o.kind==="source");
  const extraY = marketY+Math.ceil(markets.length/4)*360+46;
  sources.forEach((o,i)=>add(o.id,"source",40+i%4*360,extraY+Math.floor(i/4)*360,{object:o,lane:"evidence"}));
  const run = view.run || state.runs[0];
  if (run) {
    add(`run:${run.id}`,"run",40+actionRank*360,extraY+Math.ceil(sources.length/4)*360,{run,lane:"evidence"});
    if (active) edge(`evidence:${run.id}`,"action:pause",`run:${run.id}`,"result",{sourceHandle:"evidence",style:{strokeDasharray:"4 5"}});
  }
  const drawn = new Set(nodes.map(node => node.id));
  return {nodes,edges:edges.filter(e => drawn.has(e.source) && drawn.has(e.target)).map(e=>({type:"smoothstep",markerEnd:{type:MarkerType.ArrowClosed,color:"var(--bab-line-lit)"},
    labelStyle:{fill:"var(--bab-text-dim)",fontFamily:"var(--bab-mono)",fontSize:13},labelBgStyle:{fill:"var(--bab-black)"},
    ...e,style:{stroke:"var(--bab-line-lit)",strokeWidth:1,...e.style}}))};
}
