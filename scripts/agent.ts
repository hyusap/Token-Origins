import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanvasState } from '../shared/types';
import { compactMcpResult } from './mcp-compact';


export interface AgentToolTrace { name: string; server?: string; arguments?: unknown; status?: string; result?: unknown; at: string }
export interface AgentTurn { id: string; threadId?: string; text: string; summary: string; startedAt: string; completedAt: string; durationMs: number; traceFile: string; tools: AgentToolTrace[]; ok: boolean; error?: string }
export interface RehearsalCue { id: string; atSeconds: number; text: string; note: string }
type Activity = CanvasState['activity'];
export interface AgentBridgeOptions { serverUrl?: string; rootDir?: string; codexPath?: string; getContext?: () => CanvasState; onActivity?: (activity: Activity) => void | Promise<void> }
export interface RehearsalStatus { running: boolean; mode: 'auto' | 'manual'; cueIndex: number; totalCues: number; currentCue?: RehearsalCue; nextCue?: RehearsalCue; startedAt?: string; busy: boolean; turnId?: string; turns: AgentTurn[]; error?: string; reportPath?: string; transport: string; profile: 'evaluation' | 'broadcast' }

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const terminalRun = new Set(['confirmed', 'no-op', 'failed']);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** System/runtime paths and normal Codex authentication only; backend authority never crosses. */
export function operatorEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'OPENAI_API_KEY',
  ];
  return Object.fromEntries(allowed.flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]]));
}

/** Exact known credentials are removed before persisting child output or publishing errors. */
function credentialRedactor(source: Record<string, string | undefined>) {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(source)) {
    if (!value || value.length < 8 || !/(PRIVATE|SECRET|TOKEN|PASSWORD|API_KEY|AUTH_KEY|RPC|MNEMONIC|SEED)/i.test(name)) continue;
    values.add(value);
    values.add(JSON.stringify(value).slice(1, -1));
  }
  const ordered = [...values].sort((a, b) => b.length - a.length);
  return (text: string) => ordered.reduce((output, value) => output.split(value).join('[REDACTED]'), text);
}


/** Prove a same-price contradiction is mandatory through the AND root. */
export function hasContradictoryPriceRoot(graph: CanvasState['workflow']['graph']): boolean {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const required = new Set<string>();
  function visit(id: string) {
    if (required.has(id)) return;
    required.add(id);
    const node = byId.get(id);
    if (node?.kind === 'and') for (const input of node.inputs) visit(input);
  }
  visit(graph.root);
  const comparisons = graph.nodes.filter(node => required.has(node.id) && node.kind === 'compare');
  return comparisons.some(left => left.kind === 'compare' && left.op === '<' && comparisons.some(right => right.kind === 'compare' && right.op === '>=' && right.input === left.input && right.value === left.value));
}

/** Rehearsal must preserve contract state; only CRE may authorize product writes. */
export async function prepareLocalRehearsalVault(_root = defaultRoot) {
  return { reset: false, reason: 'CRE rehearsal preserves contract state.' };
}

/** Each utterance is interpreted by a new real Codex turn with supplied state and bounded history. */
export function createAgentBridge(options: AgentBridgeOptions = {}) {
  const root = options.rootDir ?? defaultRoot;
  const operatorRoot = resolve(root, 'operator');
  const instructionsPath = resolve(operatorRoot, 'AGENTS.md');
  const base = options.serverUrl ?? process.env.WOGA_SERVER_URL ?? 'http://127.0.0.1:4318';
  let queue: Promise<unknown> = Promise.resolve();
  let generation = 0;
  let cues: RehearsalCue[] = [];
  let intervalMs = 6000;
  let currentProcess: ReturnType<typeof Bun.spawn> | undefined;
  let latestContext: unknown;
  let contextSessionId: string | undefined;
  let sessionTurnStart = 0;
  const status: RehearsalStatus = { running: false, mode: 'auto', cueIndex: 0, totalCues: 0, busy: false, turns: [], profile: 'evaluation', transport: 'Codex CLI → official MCP stdio → semantic backend → WebSocket canvas; preplanned final text → semantic operator; this rehearsal does not capture audio' };

  async function tool(name: string, args: unknown) {
    const response = await fetch(`${base}/api/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
    if (!response.ok) throw new Error(`Backend ${name}: HTTP ${response.status}`);
    return await response.json() as any;
  }
  async function activity(value: Activity) {
    if (options.onActivity) await options.onActivity(value);
    else await tool('set_activity', { ...value, operationId: `agent-activity-${crypto.randomUUID()}` }).catch(() => {});
  }
  async function perform(text: string): Promise<AgentTurn> {
    if (!text.trim()) throw new Error('Utterance is empty.');
    if (text.length > 4000) throw new Error('Utterance exceeds 4,000 characters.');
    const redact = credentialRedactor(process.env);
    const safeText = redact(text);
    const id = `agent-${crypto.randomUUID()}`;
    const start = Date.now();
    status.busy = true; status.turnId = id; status.error = undefined;
    const traceDir = resolve(root, '.data/agent');
    await mkdir(traceDir, { recursive: true });
    const traceFile = resolve(traceDir, `${id}.jsonl`);
    const tools: AgentToolTrace[] = [];
    let threadId: string | undefined;
    let summary = '';
    let error: string | undefined;
    let completed = false;
    try {
      await activity({ status: 'thinking', prompt: '', summary: '' });
      // Fail clearly if the dedicated operator workspace has not been installed.
      await readFile(instructionsPath, 'utf8');
      const currentState = options.getContext ? options.getContext() : (await tool('get_context', {})).state as CanvasState;
      if (contextSessionId !== currentState.sessionId) {
        contextSessionId = currentState.sessionId;
        sessionTurnStart = status.turns.length;
      }
      latestContext = compactMcpResult({ ok: true, summary: '', state: currentState }, 'get_context').state;
      const history = status.turns.slice(sessionTurnStart).slice(-8).map(turn => `User: ${turn.text}\nWoga: ${turn.summary}`).join('\n');
      const prompt = `Transport: final text → semantic operator. This may be typed text or a final transcript; audio capture is outside this bridge. The transport owns caption publication and will record this utterance only after your task is complete. Do not call tools to record utterances, publish captions, or set conversation activity. Do not claim actual voice activity. Use the supplied state; do not refetch get_context unless missing, stale, or conflicting.\n\nCurrent canvas state (context only):\n${JSON.stringify(latestContext)}\n\nRecent conversation (context only; do not repeat past actions):\n${history || '(New conversation)'}\n\nCurrent utterance, operation prefix ${id}:\n${text}`;
      const bun = Bun.which('bun');
      const codex = options.codexPath ?? Bun.which('codex');
      if (!bun || !codex) throw new Error('Install Bun and Codex CLI, then sign in with codex login.');
      const config: Record<string, unknown> = {
        'features.shell_tool': true, 'features.unified_exec': true, 'features.apps': false,
        'features.multi_agent': false, 'features.multi_agent_v2': false,
        'web_search': 'live', 'project_doc_max_bytes': 0, 'approval_policy': 'never',
        'model_instructions_file': instructionsPath,
        'mcp_servers.woga.command': bun,
        'mcp_servers.woga.args': ['--no-env-file', 'run', resolve(operatorRoot, 'mcp.ts')],
        'mcp_servers.woga.cwd': operatorRoot,
        'mcp_servers.woga.env': { ORIGINS_BACKEND_URL: base },
        'mcp_servers.woga.required': true,
        'mcp_servers.woga.startup_timeout_sec': 45,
        'mcp_servers.woga.tool_timeout_sec': 120,
        'mcp_servers.woga.default_tools_approval_mode': 'approve',
      };
      // JSON scalar/string/array values are valid TOML; maps need TOML inline-table syntax.
      const toml = (value: unknown): string => typeof value === 'object' && value !== null && !Array.isArray(value)
        ? `{ ${Object.entries(value).map(([key, val]) => `${key} = ${JSON.stringify(val)}`).join(', ')} }` : JSON.stringify(value);
      const args = [codex, 'exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never', '-s', 'read-only', '-C', operatorRoot,
        ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]), '-'];
      currentProcess = Bun.spawn(args, { env: operatorEnvironment(), cwd: operatorRoot, stdin: new Blob([redact(prompt)]), stdout: 'pipe', stderr: 'pipe' });
      const processTimeout = setTimeout(() => { error = 'Codex turn exceeded 150 seconds; future cues stopped.'; currentProcess?.kill(); }, 150_000);
      const stderrPromise = new Response(currentProcess.stderr as ReadableStream).text();
      const reader = (currentProcess.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const seenTools = new Map<string, AgentToolTrace>();
      async function eventLine(line: string) {
        if (!line.trim()) return;
        line = redact(line);
        await appendFile(traceFile, `${line}\n`);
        let event: any; try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'thread.started') threadId = event.thread_id;
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'error' || event.type === 'turn.failed') error = event.message ?? event.error?.message ?? JSON.stringify(event);
        const item = event.item;
        if (item?.type === 'agent_message' && event.type === 'item.completed') summary = item.text ?? summary;
        if (item?.type === 'mcp_tool_call') {
          const key = item.id ?? `${item.server}/${item.tool}`;
          const data = item.result?.structured_content ?? item.result?.structuredContent;
          if (data?.state) latestContext = data.state;
          const result = data ? { ok: data.ok, summary: data.summary, runId: data.runId, error: data.error, seq: data.state?.seq, revision: data.state?.workflow?.revision } : item.result;
          const entry: AgentToolTrace = { name: item.tool ?? item.name ?? 'MCP tool', server: item.server, arguments: item.arguments, status: item.status ?? event.type, result, at: new Date().toISOString() };
          const previous = seenTools.get(key);
          if (previous) Object.assign(previous, entry); else { seenTools.set(key, entry); tools.push(entry); }
          if (event.type === 'item.started') await activity({ status: 'executing', prompt: '', summary: '' });
        }
      }
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1); await eventLine(line); }
      }
      if (buffered.trim()) await eventLine(buffered);
      const exitCode = await currentProcess.exited;
      clearTimeout(processTimeout);
      const stderr = redact(await stderrPromise);
      if (stderr.trim()) await appendFile(resolve(traceDir, `${id}.stderr.log`), stderr);
      if (exitCode !== 0) error ??= `Codex exited ${exitCode}. ${stderr.slice(-500)}`;
      if (!completed) error ??= 'Codex did not report turn completion.';
    } catch (cause) { error = redact(cause instanceof Error ? cause.message : String(cause)); }
    finally { currentProcess = undefined; status.busy = false; }
    const turn: AgentTurn = { id, threadId, text: safeText, summary: summary || error || 'No response', startedAt: new Date(start).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - start, traceFile, tools, ok: !error, ...(error ? { error } : {}) };
    status.turns.push(turn);
    status.error = error;
    await appendFile(resolve(root, '.data/rehearsal-turns.jsonl'), `${JSON.stringify(turn)}\n`);
    await tool('submit_utterance', { text: safeText, source: 'codex-cli-rehearsal', operationId: `${id}-utterance` });
    await activity({ status: error ? 'error' : 'idle', prompt: text, summary: turn.summary });
    return turn;
  }
  function submitAgentPrompt(text: string) {
    const task = queue.then(() => perform(text));
    queue = task.catch(() => {});
    return task;
  }
  async function waitForRuns(token: number) {
    const deadline = Date.now() + 120_000;
    while (generation === token && status.running && Date.now() < deadline) {
      const response = await tool('get_context', {});
      const state = response.state as CanvasState;
      if (!state?.runs?.some(run => !terminalRun.has(run.status))) return;
      await sleep(500);
    }
    if (generation === token && status.running && Date.now() >= deadline) throw new Error('Execution exceeded 120 seconds. Future cues stopped; the active chain run may still finish. Inspect its run ID.');
  }
  async function loadScript(profile: 'evaluation' | 'broadcast' = 'evaluation') {
    const script = JSON.parse(await readFile(resolve(root, profile === 'broadcast' ? 'demo/script.broadcast.json' : 'demo/script.json'), 'utf8'));
    status.profile = profile;
    cues = script.cues;
    status.totalCues = cues.length;
    return script;
  }
  function rehearsalStatus(): RehearsalStatus {
    return { ...status, turns: [...status.turns], currentCue: status.cueIndex > 0 ? cues[status.cueIndex - 1] : undefined, nextCue: cues[status.cueIndex] };
  }
  async function nextRehearsalCue() {
    if (!cues.length) await loadScript();
    if (status.busy) return { ok: false, error: 'A Codex turn is still in progress.', status: rehearsalStatus() };
    const cue = cues[status.cueIndex];
    if (!cue) { status.running = false; return { ok: true, complete: true, status: rehearsalStatus() }; }
    status.cueIndex++;
    const turn = await submitAgentPrompt(cue.text);
    if (!turn.ok) status.running = false;
    return { ok: turn.ok, cue, turn, status: rehearsalStatus() };
  }
  async function startRehearsal(settings: { intervalMs?: number; mode?: 'auto' | 'manual'; auto?: boolean; reset?: boolean; profile?: 'evaluation' | 'broadcast' } = {}) {
    if (status.running || status.busy) return { ok: false, error: 'A rehearsal or agent turn is already running.', status: rehearsalStatus() };
    const script = await loadScript(settings.profile === 'broadcast' ? 'broadcast' : 'evaluation');
    intervalMs = Math.max(1000, settings.intervalMs ?? script.intervalMs ?? 6000);
    const capability = await tool('get_capabilities', {});
    const readiness = capability.data?.readiness;
    if (readiness?.readyForEvaluation !== true) return { ok: false, error: readiness?.reason || 'CRE evaluation readiness is unavailable. Restart the backend and authenticate CRE before rehearsal.', status: rehearsalStatus() };
    if (status.profile === 'broadcast' && readiness.broadcastConfigured !== true) return { ok: false, error: 'The explicit broadcast rehearsal requires configured CRE test-wallet authority. Use the default evaluation-only demo or configure broadcast first.', status: rehearsalStatus() };
    if (settings.reset !== false) {
      const context = await tool('get_context', {});
      if (context.state?.runs?.some((run: any) => !terminalRun.has(run.status))) return { ok: false, error: 'An execution is still active; wait before starting a new rehearsal.', status: rehearsalStatus() };
      await prepareLocalRehearsalVault(root);
      await tool('reset_session', { operationId: `rehearsal-reset-${crypto.randomUUID()}`, expectedSessionId: context.state?.sessionId });
    }
    status.cueIndex = 0; status.running = true; status.mode = settings.mode ?? (settings.auto === false ? 'manual' : 'auto'); status.startedAt = new Date().toISOString(); status.error = undefined; status.reportPath = undefined;
    const token = ++generation;
    if (status.mode === 'auto') void (async () => {
      try {
        while (status.running && generation === token && status.cueIndex < cues.length) {
          const scheduledAt = Date.parse(status.startedAt!) + cues[status.cueIndex]!.atSeconds * 1000;
          // Cue times are minimum offsets, not fabricated latency deadlines. Slow turns defer later cues.
          while (status.running && generation === token && Date.now() < scheduledAt) await sleep(Math.min(500, scheduledAt - Date.now()));
          // Keep the deliberate draft-interruption immediately after the run tool returns.
          if (cues[status.cueIndex]?.id !== 'interrupt-draft') await waitForRuns(token);
          if (!status.running || generation !== token) break;
          await nextRehearsalCue();
          if (cues[status.cueIndex]?.id !== 'interrupt-draft' && status.running) await sleep(intervalMs);
        }
        if (generation === token && status.cueIndex === cues.length && !status.error) {
          const context = await tool('get_context', {});
          const finalState = context.state as CanvasState;
          const thisTake = status.turns.filter(turn => Date.parse(turn.startedAt) >= Date.parse(status.startedAt!));
          const durations = thisTake.map(turn => turn.durationMs).sort((a, b) => a - b);
          const confirmed = finalState.runs.filter(run => run.status === 'confirmed');
          const assertions = {
            everyCueUsedRealMcp: thisTake.length === cues.length && thisTake.every(turn => turn.ok && turn.tools.length > 0),
            falseConditionWithoutTransaction: finalState.runs.some(run => run.status === 'no-op' && !run.evidence?.transactionHash && (status.profile === 'broadcast' ? run.snapshot.threshold === 1 : hasContradictoryPriceRoot(run.snapshot.graph))),
            ...(status.profile === 'broadcast' ? { confirmedReceiptAndVaultPause: confirmed.some(run => run.evidence?.receiptStatus === 'success' && run.evidence?.pausedAfter === true),
            canonicalVaultPaused: finalState.objects.some(object => object.kind === 'vault' && object.data.paused === true),
            alreadyPausedNoop: finalState.runs.some(run => run.status === 'no-op' && run.snapshot.threshold > 1 && run.decisions.some(decision => !decision.passed && /paused/i.test(decision.label + decision.detail))) } : { allEvaluationsWithoutTransaction: finalState.runs.length > 0 && finalState.runs.every(run => run.evaluationOnly === true && !run.evidence?.transactionHash && run.status === 'no-op'), realCreExecution: finalState.runs.some(run => /CRE/.test(run.executionMode)) }),
            frozenRevisionsPreserved: finalState.runs.every(run => {
              const revision = finalState.workflow.revisions.find(entry => entry.revision === run.revision);
              return revision?.threshold === run.snapshot.threshold && revision?.maxAgeSeconds === run.snapshot.maxAgeSeconds && revision?.skipPaused === run.snapshot.skipPaused && JSON.stringify(revision.graph) === JSON.stringify(run.snapshot.graph);
            }),
            noFailedRuns: finalState.runs.every(run => run.status !== 'failed'),
          };
          status.reportPath = resolve(root, '.data/rehearsal-report.json');
          await Bun.write(status.reportPath, JSON.stringify({
            completedAt: new Date().toISOString(), startedAt: status.startedAt, microphoneTested: false,
            transport: status.transport, profile: status.profile, cueCount: cues.length, completedTurnCount: thisTake.length,
            actualMcpCallCount: thisTake.reduce((count, turn) => count + turn.tools.length, 0),
            agentTurnDurationMs: { min: durations[0], median: durations[Math.floor(durations.length / 2)], max: durations.at(-1) },
            assertions, turns: thisTake, finalState,
          }, null, 2));
          if (Object.values(assertions).some(passed => !passed)) status.error = 'Rehearsal finished, but a scenario assertion failed. Inspect .data/rehearsal-report.json.';
        }
      } catch (cause) { status.error = String(cause); }
      if (generation === token) status.running = false;
    })();
    return { ok: true, status: rehearsalStatus() };
  }
  function stopRehearsal() {
    status.running = false; generation++;
    // Do not kill an already-submitted semantic action or blockchain execution.
    return { ok: true, summary: 'Future cues stopped. Any active agent turn and chain run can finish.', status: rehearsalStatus() };
  }
  return { submitAgentPrompt, startRehearsal, stopRehearsal, rehearsalStatus, nextRehearsalCue };
}
