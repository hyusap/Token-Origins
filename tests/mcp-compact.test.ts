import { expect, test } from 'bun:test';
import { emptyState } from '../server/engine';
import { compactMcpResult } from '../scripts/mcp-compact';
import type { ExecutionRun, GraphObject, ToolResult } from '../shared/types';
import { legacyGraph } from '../cre/graph';

function fixture(): ToolResult {
  const state = emptyState();
  const price: GraphObject = { id: 'price:eth-usd', kind: 'price', label: 'ETH / USD', visible: true, pinned: false,
    data: { price: 2500, unit: 'USD', history: Array.from({ length: 1000 }, () => ({ price: 2500, observedAt: '2026-10-06T01:00:00Z' })) },
    provenance: { source: 'Test source', kind: 'fixture', label: 'Test', observedAt: '2026-10-06T01:00:00Z', fetchedAt: '2026-10-06T01:00:03Z' } };
  const vault: GraphObject = { ...price, id: 'vault:grant', kind: 'vault', label: 'Grant vault', data: { paused: true, chainId: 31337, address: '0x123', blockNumber: '5' },
    provenance: { ...price.provenance, observedAt: '2026-10-06T00:50:00Z', fetchedAt: '2026-10-06T01:00:05Z' } };
  const run = (id: string, revision: number): ExecutionRun => ({ id, revision, snapshot: { revision, threshold: 3000, maxAgeSeconds: 60, skipPaused: true, reason: 'Test', createdAt: '2026-10-06T01:00:00Z', graph: legacyGraph(3000) }, status: 'confirmed', executionMode: 'Test fixture', startedAt: '2026-10-06T01:00:00Z', completedAt: '2026-10-06T01:00:06Z', inputs: { price, vault }, decisions: [{ id: 'freshness', label: 'Fresh observation', passed: true, detail: 'Test observation age 3s' }], logs: Array.from({ length: 300 }, (_, i) => ({ at: '2026-10-06T01:00:00Z', stage: 'test', message: `Observed stage ${i}` })), evidence: { transactionHash: '0xtest', receiptStatus: 'success', pausedAfter: true, blockNumber: '5', verification: 'Test evidence' } });
  state.objects = [price, vault]; state.runs = [run('newest', 3), run('older', 2)]; state.inspectedRunId = 'newest';
  state.focus = { objectId: price.id, label: price.label };
  state.clarification = { question: 'Which condition?', candidates: ['threshold', 'freshness'] };
  state.conversation = Array.from({ length: 50 }, (_, i) => ({ id: String(i), role: 'user' as const, text: 'Large previous conversation '.repeat(100), at: '2026-10-06T01:00:00Z', source: 'test' }));
  return { ok: true, summary: 'Test state', state };
}

test('ordinary tool results retain authoritative references and run summaries without repeating execution bodies', () => {
  const canonical = fixture(); const before = JSON.stringify(canonical);
  const view = compactMcpResult(canonical, 'patch_workflow');
  expect(JSON.stringify(canonical)).toBe(before);
  expect(JSON.stringify(view).length).toBeLessThan(before.length / 10);
  expect(view.state!.focus).toEqual(canonical.state.focus);
  expect(view.state!.clarification).toEqual(canonical.state.clarification);
  expect(view.state!.workflow.revision).toBe(canonical.state.workflow.revision);
  expect(view.state!.runs.map(run => run.id)).toEqual(['newest', 'older']);
  expect('inputs' in view.state!.runs[0]!).toBe(false);
  expect('logs' in view.state!.runs[0]!).toBe(false);
  expect('latency' in view.state!).toBe(false);
  expect('conversation' in view.state!).toBe(false);
  expect(view.state!.objects[1]!.provenance.observedAt).toBe('2026-10-06T00:50:00Z');
  expect(view.state!.objects[1]!.provenance.fetchedAt).toBe('2026-10-06T01:00:05Z');
});

test('get_run retains complete selected evidence and resolves an explicit older run ahead of current selection', () => {
  const canonical = fixture(); const view = compactMcpResult(canonical, 'get_run', { runId: 'older' });
  const selected = view.state!.runs.find(run => run.id === 'older')!;
  expect('inputs' in selected && selected.inputs?.price.data.price).toBe(2500);
  expect('decisions' in selected && selected.decisions).toEqual(canonical.state.runs[1]!.decisions);
  expect('logs' in selected && selected.logs).toEqual(canonical.state.runs[1]!.logs);
  expect('evidence' in selected && selected.evidence).toEqual(canonical.state.runs[1]!.evidence);
  expect('logs' in view.state!.runs[0]!).toBe(false);
  expect(canonical.state.runs[1]!.inputs!.price.data.history).toHaveLength(1000);
});

test('compaction preserves actionable stale-revision errors and ambiguity candidates', () => {
  const canonical = { ...fixture(), ok: false, code: 'REVISION_CONFLICT', error: 'Expected current revision', candidates: ['price:eth-usd', 'vault:grant'] };
  const view = compactMcpResult(canonical, 'patch_workflow');
  expect(view.ok).toBe(false); expect(view.code).toBe('REVISION_CONFLICT');
  expect(view.error).toBe(canonical.error); expect(view.candidates).toEqual(canonical.candidates);
});
