import type { CanvasState } from "../shared/types";
import { legacyGraph, policyGraphSchema, policyHash } from "../cre/graph";

/**
 * 1: pre-graph scalar workflows (threshold/maxAgeSeconds/skipPaused only).
 * 2: every workflow and revision carries a graph with network-bound feeds and its policy hash.
 */
export const STATE_VERSION = 2;

function normalize(graph: unknown, threshold: unknown, maxAgeSeconds: unknown) {
  const candidate = graph ?? legacyGraph(typeof threshold === "number" && threshold > 0 ? threshold : 3000);
  try {
    const parsed = policyGraphSchema.parse(candidate);
    return { graph: parsed, policyHash: policyHash(parsed, typeof maxAgeSeconds === "number" ? maxAgeSeconds : undefined) };
  } catch {
    // Keep what was stored rather than invent a policy; editing will refuse it visibly.
    return { graph: candidate as CanvasState["workflow"]["graph"], policyHash: undefined };
  }
}

/**
 * Upgrades saved canvases and restorable sessions in place. Drafts gain the
 * graph their scalar fields already described; executed runs are left exactly
 * as recorded, because their snapshots are historical evidence.
 */
export function migrateState(state: CanvasState): CanvasState {
  if (!state || typeof state !== "object" || state.stateVersion === STATE_VERSION) return state;
  const workflow = state.workflow as CanvasState["workflow"] & Record<string, unknown>;
  if (workflow) {
    if (typeof workflow.threshold !== "number") workflow.threshold = 3000;
    if (workflow.maxAgeSeconds === undefined) workflow.maxAgeSeconds = null;
    if (workflow.skipPaused === undefined) workflow.skipPaused = false;
    if (!Array.isArray(workflow.revisions)) workflow.revisions = [];
    for (const revision of workflow.revisions) {
      const next = normalize(revision.graph, revision.threshold ?? workflow.threshold, revision.maxAgeSeconds);
      revision.graph = next.graph;
      if (next.policyHash) revision.policyHash = next.policyHash;
    }
    const current = normalize(workflow.graph, workflow.threshold, workflow.maxAgeSeconds);
    workflow.graph = current.graph;
    if (current.policyHash) workflow.policyHash = current.policyHash;
  }
  if (!Array.isArray(state.runs)) state.runs = [];
  state.stateVersion = STATE_VERSION;
  return state;
}
