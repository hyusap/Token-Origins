import { createInterface } from 'node:readline';

const base = process.env.WOGA_SERVER_URL ?? 'http://127.0.0.1:4318';
const auto = process.argv.includes('--auto');
const reset = !process.argv.includes('--no-reset');
async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json() as any;
  if (!response.ok || value.ok === false) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
console.log('WOGA / REAL CODEX + MCP REHEARSAL');
console.log('Preplanned text cues. Each cue is interpreted by Codex; this is not an audio test.');
try {
  await request('/api/rehearsal/start', { mode: auto ? 'auto' : 'manual', reset });
  process.on('SIGINT', async () => { await request('/api/rehearsal/stop', {}).catch(() => {}); process.exit(0); });
  if (auto) {
    console.log('Timed sequence started. Ctrl+C stops future cues; active chain runs continue.');
    let seen = 0;
    while (true) {
      const payload = await request('/api/rehearsal/status');
      const status = payload.status ?? payload;
      for (const turn of status.turns.slice(seen)) {
        console.log(`\n> ${turn.text}\n${turn.summary}\n${turn.tools.length} actual MCP calls · ${(turn.durationMs / 1000).toFixed(1)}s · ${turn.traceFile}`);
      }
      seen = status.turns.length;
      if (!status.running && !status.busy) {
        if (status.error) throw new Error(status.error);
        console.log(status.cueIndex >= status.totalCues ? '\nRehearsal complete. Inspect .data/rehearsal-turns.jsonl for measured evidence.' : `\nRehearsal stopped after ${status.cueIndex}/${status.totalCues} cues. Active chain runs may continue.`);
        break;
      }
      await Bun.sleep(750);
    }
  } else {
    console.log('Press Enter for the next cue. Type a custom utterance, or /quit to stop.');
    const lines = createInterface({ input: process.stdin, output: process.stdout });
    for await (const line of lines) {
      if (line === '/quit') { await request('/api/rehearsal/stop', {}); break; }
      const payload = await request(line.trim() ? '/api/agent' : '/api/rehearsal/next', line.trim() ? { text: line } : {});
      const turn = payload.turn ?? payload;
      if (turn.summary) console.log(turn.summary);
      const status = payload.status ?? await request('/api/rehearsal/status');
      if (payload.complete) break;
      if (status.nextCue) console.log(`Next: “${status.nextCue.text}”`);
    }
    lines.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error('Start the application with bun run dev. Verify Codex CLI can sign in with codex login.');
  process.exitCode = 1;
}
