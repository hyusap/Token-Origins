import type { CanvasState, ExecutionRun, GraphObject, ToolResult } from '../shared/types';

/** Model transport only. Canonical HTTP/WebSocket state retains every chart point, log, and timing. */
export function compactMcpResult(result: ToolResult, toolName: string, args: Record<string, unknown> = {}) {
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
      error: run.error,
      verification: run.evidence?.verification,
    };
  }
  const selectedRunId = typeof args.runId === 'string' ? args.runId : state.inspectedRunId ?? state.runs[0]?.id;
  return {
    ok: result.ok, summary: result.summary, runId: result.runId, error: result.error,
    code: result.code, candidates: result.candidates, duplicate: result.duplicate,
    state: {
      sessionId: state.sessionId, seq: state.seq, mode: state.mode, focus: state.focus,
      previousFocus: state.previousFocus.slice(-2), references: state.references.slice(-3),
      clarification: state.clarification, inspectedRunId: state.inspectedRunId,
      objects: state.objects.map(objectView), edges: state.edges,
      workflow: { ...state.workflow, revisions: state.workflow.revisions.slice(-2) },
      runs: state.runs.map(run => toolName === 'get_run' && run.id === selectedRunId
        ? { ...run, inputs: run.inputs ? { price: objectView(run.inputs.price), vault: objectView(run.inputs.vault) } : undefined }
        : runSummary(run)),
      activity: { status: state.activity.status }, capabilities: state.capabilities,
    },
  };
}
