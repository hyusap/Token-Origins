import type { CanvasState, ExecutionRun, GraphObject, ToolResult } from '../shared/types';

/** Run summaries carried in each result; get_run with an explicit runId reaches older ones. */
export const RUN_SUMMARY_LIMIT = 10;

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
      id: run.id, revision: run.revision, status: run.status,
      executionMode: run.executionMode, startedAt: run.startedAt, completedAt: run.completedAt,
      error: run.error,
      policyHash: run.policyHash, action: run.action, noopReason: run.noopReason, uncertain: run.uncertain,
      ...(run.trigger === "watch" ? { trigger: run.trigger, watchCheck: run.watchCheck } : {}),
      verification: run.evidence?.verification,
      ...(run.evidence?.ccipExplorerUrl ? { ccipExplorerUrl: run.evidence.ccipExplorerUrl } : {}),
    };
  }
  const selectedRunId = typeof args.runId === 'string' ? args.runId : state.inspectedRunId ?? state.runs[0]?.id;
  // Newest runs first; the selected run is always kept so get_run can return it in full.
  const listed = state.runs.filter((run, index) => index < RUN_SUMMARY_LIMIT || (toolName === 'get_run' && run.id === selectedRunId));
  return {
    ok: result.ok, summary: result.summary, runId: result.runId, error: result.error,
    code: result.code, candidates: result.candidates, duplicate: result.duplicate,
    state: {
      sessionId: state.sessionId, seq: state.seq, mode: state.mode, focus: state.focus,
      previousFocus: state.previousFocus.slice(-2), references: state.references.slice(-3),
      clarification: state.clarification, inspectedRunId: state.inspectedRunId,
      canvasView: state.canvasView, canUndoClear: state.canUndoClear,
      objects: state.objects.map(objectView), edges: state.edges,
      workflow: { ...state.workflow, revisions: state.workflow.revisions.slice(-2) },
      runCount: state.runs.length,
      runs: listed.map(run => toolName === 'get_run' && run.id === selectedRunId
        ? { ...run, inputs: run.inputs ? { price: objectView(run.inputs.price), vault: objectView(run.inputs.vault) } : undefined }
        : runSummary(run)),
      activity: { status: state.activity.status }, capabilities: state.capabilities,
      ...(state.watch ? { watch: (({ snapshot, ...watch }) => watch)(state.watch) } : {}),
    },
  };
}
