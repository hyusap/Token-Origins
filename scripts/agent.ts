import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanvasState } from '../shared/types';
import { compactMcpResult } from './mcp-compact';


export interface AgentToolTrace { name: string; server?: string; arguments?: unknown; status?: string; result?: unknown; at: string }
export interface AgentTurn { id: string; threadId?: string; text: string; summary: string; startedAt: string; completedAt: string; durationMs: number; traceFile: string; tools: AgentToolTrace[]; ok: boolean; error?: string }
type Activity = CanvasState['activity'];
export interface AgentBridgeOptions { serverUrl?: string; rootDir?: string; codexPath?: string; getContext?: () => CanvasState; onActivity?: (activity: Activity) => void | Promise<void> }
export interface OperatorStatus { busy: boolean; turnId?: string; turns: AgentTurn[]; error?: string; transport: string }

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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


/** Each utterance is interpreted by a new real Codex turn with supplied state and bounded history. */
export function createAgentBridge(options: AgentBridgeOptions = {}) {
  const root = options.rootDir ?? defaultRoot;
  const operatorRoot = resolve(root, 'operator');
  const instructionsPath = resolve(operatorRoot, 'AGENTS.md');
  const base = options.serverUrl ?? process.env.WOGA_SERVER_URL ?? 'http://127.0.0.1:4318';
  let queue: Promise<unknown> = Promise.resolve();
  let currentProcess: ReturnType<typeof Bun.spawn> | undefined;
  let latestContext: unknown;
  let contextSessionId: string | undefined;
  let sessionTurnStart = 0;
  const status: OperatorStatus = { busy: false, turns: [], transport: 'Codex CLI → official MCP stdio → semantic backend → WebSocket canvas; typed text or final voice transcript → semantic operator' };

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
      const processTimeout = setTimeout(() => { error = 'Codex turn exceeded 150 seconds.'; currentProcess?.kill(); }, 150_000);
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
    await appendFile(resolve(root, '.data/agent-turns.jsonl'), `${JSON.stringify(turn)}\n`);
    await tool('submit_utterance', { text: safeText, source: 'codex-cli', operationId: `${id}-utterance` });
    await activity({ status: error ? 'error' : 'idle', prompt: text, summary: turn.summary });
    return turn;
  }
  function submitAgentPrompt(text: string) {
    const task = queue.then(() => perform(text));
    queue = task.catch(() => {});
    return task;
  }
  function operatorStatus(): OperatorStatus {
    return { ...status, turns: [...status.turns] };
  }
  return { submitAgentPrompt, operatorStatus };
}
