import type { CanvasState, ExecutionRun, GraphObject, RunDecision, PolicyGraph } from "../shared/types";
import { describeAction, describeGraph, describeSource, sourceKey, isLegacyShape } from "./policy-language";
import type { PriceSource } from "../cre/graph";

export { isLegacyShape as isLegacyPolicy };
export function selectedRun(state: CanvasState): ExecutionRun | undefined {
  return state.runs.find(run => run.id === state.inspectedRunId || `run:${run.id}` === state.focus.objectId || run.id === state.focus.objectId);
}
export function sourceObjectId(source: PriceSource): string {
  return source.type === "exchange-trade" ? `price:${source.pair.toLowerCase()}` :
    `feed:${source.symbol.toLowerCase()}-usd${!source.network || source.network === "ethereum-mainnet" ? "" : ":" + source.network.replace("ethereum-", "")}`;
}
/** Pre-graph historical runs can only be reconstructed from their own archived scalar threshold. */
export function frozenGraph(run: ExecutionRun): PolicyGraph {
  return run.snapshot.graph || {
    nodes: [{id:"eth",kind:"price",source:{type:"exchange-trade",pair:"ETH-USD"}},
      {id:"under-threshold",kind:"compare",input:"eth",op:"<",value:run.snapshot.threshold}],
    root:"under-threshold",action:{type:"pause-vault"},
  };
}
/** Build a read-only presentation of the frozen inputs; never overwrite live draft objects. */
export function policyView(state: CanvasState) {
  const run = selectedRun(state);
  const graph = run ? frozenGraph(run) : state.workflow.graph;
  const summary = run ? describeGraph(graph) : state.workflow.summary;
  const action = run ? describeAction(graph.action) : state.objects.find(o => o.id === "action:pause")?.label || describeAction(graph.action);
  const objects = [...state.objects];
  {
    for (const node of graph.nodes) {
      if (node.kind !== "price") continue;
      const id = sourceObjectId(node.source);
      const archived = run?.observations?.find(o => o.key === sourceKey(node.source));
      const prior = objects.find(o => o.id === id);
      const legacy = run && !run.observations && run.inputs?.price.id === id ? run.inputs.price : undefined;
      if (!run && prior) continue;
      const network = node.source.type === "chainlink-feed" ? node.source.network || "ethereum-mainnet" : undefined;
      const identity = {network,chainId:network ? network === "ethereum-mainnet" ? 1 : 11155111 : undefined};
      const observation: GraphObject = archived ? {
        id, kind: node.source.type === "chainlink-feed" ? "feed" : "price", label: archived.label,
        visible: true, pinned: false,
        data: {symbol: node.source.type === "chainlink-feed" ? node.source.symbol : node.source.pair.split("-")[0],
          price: archived.usd, raw: archived.raw, network: archived.network, chainId: archived.chainId, address: archived.address,
          history: [{price: archived.usd, observedAt: archived.observedAt}], historyLabel: "Archived execution observation"},
        provenance: {source: archived.provider, kind: node.source.type === "chainlink-feed" ? "chain" : "live",
          label: "Archived execution observation", observedAt: archived.observedAt, fetchedAt: archived.fetchedAt,
          address: archived.address, chainId: archived.chainId, url: archived.url},
      } : legacy || {
        id, kind: node.source.type === "chainlink-feed" ? "feed" : "price", label: describeSource(node.source),
        visible: true, pinned: false, data: {symbol: node.source.type === "chainlink-feed" ? node.source.symbol : node.source.pair.split("-")[0],network:identity.network,chainId:identity.chainId},
        provenance: {source: describeSource(node.source),kind:"derived",label:run ? "Execution observation unavailable" : "Source configured · not fetched",chainId:identity.chainId,observedAt:"",fetchedAt:""},
      };
      // Archived observations win even if the draft's live market has changed.
      if (prior) objects[objects.indexOf(prior)] = observation;
      else objects.push(observation);
    }
    if (run?.inputs?.vault) {
      const index = objects.findIndex(o => o.id === run.inputs!.vault.id);
      if (index >= 0) objects[index] = structuredClone(run.inputs.vault);
      else objects.push(structuredClone(run.inputs.vault));
    }
  }
  return {run, graph, summary, action, objects, revision: run?.revision ?? state.workflow.revision};
}
export const decisionRole = (decision: RunDecision): "node" | "root" | "guard" =>
  decision.role || (decision.nodeId === "guard:root" ? "root" : decision.nodeId?.startsWith("guard:") ? "guard" : "node");
export function runOutcome(run: ExecutionRun): string {
  if (run.uncertain) return "Execution interrupted. Checking chain evidence before another run can start.";
  if (run.status === "failed") return `Execution failed: ${run.error || "The write could not be verified."}`;
  if (run.status === "no-op") return run.noopReason || "No action taken.";
  if (run.evidence?.simulatedOrder) {
    const order = run.evidence.simulatedOrder;
    return `Simulated sell of ${order.amount} ${order.symbol}; no transaction, no asset moved.`;
  }
  if (run.status === "confirmed" && run.evidence?.transactionHash)
    return `Spending pause verified${run.evidence.blockNumber ? " at block " + run.evidence.blockNumber : ""}. Receipt, receiver event and fresh vault state confirmed.`;
  if (run.status === "confirmed" && run.evidence?.fixture)
    return "Fixture spending paused in memory. No transaction was submitted.";
  if (run.status === "confirmed") return run.evidence?.verification || "Rehearsal completed.";
  return "Fetching and evaluating fresh execution inputs.";
}
export function settledExecutionReply(state: CanvasState, summary: string): string | null {
  const run = state.runs[0];
  const prompt = state.conversation.filter(c => c.role === "user").at(-1);
  // The transport records utterances after semantic tools complete, so captions may be newer than run.startedAt.
  if (!run || !prompt ||
      !/queued|preparing|no result yet/i.test(summary) ||
      !["confirmed", "no-op", "failed"].includes(run.status)) return null;
  return runOutcome(run);
}
export const graphInputs = (node: PolicyGraph["nodes"][number]): string[] =>
  node.kind === "and" || node.kind === "or" ? node.inputs :
  node.kind === "compare" || node.kind === "freshness" || node.kind === "not" ? [node.input] : [];
