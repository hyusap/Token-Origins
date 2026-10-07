import type { CanvasState, ExecutionRun, GraphObject, ToolResult } from '../shared/types';

/** Model transport only. Canonical HTTP/WebSocket state retains every chart point, log, and timing. */
export function compactMcpResult(result: Omit<ToolResult, "state"> & { state?: CanvasState }, toolName: string, args: Record<string, unknown> = {}) {
  if (!result.state) return { ...result };
  const state: CanvasState = result.state;
  function objectView(object: GraphObject) {
    const { history, historyLabel, ...data } = object.data;
    return { ...object, data };
  }
  function runSummary(run: ExecutionRun) {
    return {
      id: run.id, revision: run.revision, snapshot: run.snapshot, status: run.status,
      executionMode: run.executionMode, startedAt: run.startedAt, completedAt: run.completedAt,
      error: run.error, policyHash: run.policyHash, evaluationOnly: run.evaluationOnly, action: run.action, target: run.target,
      noopReason: run.noopReason, uncertain: run.uncertain, submissionPossible: run.submissionPossible,
      verification: run.evidence?.verification,
    };
  }
  const selectedRunId = typeof args.runId === 'string' ? args.runId : state.inspectedRunId ?? state.runs[0]?.id;
  return {
    ok: result.ok, summary: result.summary, runId: result.runId, error: result.error,
    code: result.code, candidates: result.candidates, duplicate: result.duplicate, data: result.data,
    state: {
      sessionId: state.sessionId, seq: state.seq, mode: state.mode, focus: state.focus,
      previousFocus: state.previousFocus.slice(-2), references: state.references.slice(-3),
      clarification: state.clarification, inspectedRunId: state.inspectedRunId,
      canvasView: state.canvasView,
      // Supplied context must retain live/paused/uncertain monitor identity.
      // Detailed check history remains available through get_monitors.
      monitors: state.monitors?.map(({ latestEvidence, logs, ...monitor }) => ({
        ...monitor,
        latestEvidence: latestEvidence ? {
          runId: latestEvidence.runId, revision: latestEvidence.revision,
          policyHash: latestEvidence.policyHash, mode: latestEvidence.mode,
          decision: latestEvidence.decision, noopReason: latestEvidence.noopReason,
          transaction: latestEvidence.transaction, solanaTransfer: latestEvidence.solanaTransfer,
        } : undefined,
      })),
      // Retain the exact watch authority and budget in operator context.
      // Individual attempts and large gate evidence are read through the watch tool.
      tradeWatches: state.tradeWatches?.map(({ logs, skippedEvents, ...watch }) => ({
        ...watch, skippedEventCount: skippedEvents.length,
      })),
      objects: state.objects.map(objectView), edges: state.edges,
      workflow: { ...state.workflow, revisions: state.workflow.revisions.slice(-2) },
      runs: state.runs.map(run => toolName === 'get_run' && run.id === selectedRunId
        ? { ...run, inputs: run.inputs ? { price: run.inputs.price ? objectView(run.inputs.price) : undefined, vault: run.inputs.vault ? objectView(run.inputs.vault) : undefined } : undefined }
        : runSummary(run)),
      activity: { status: state.activity.status }, capabilities: state.capabilities,
    },
  };
}
