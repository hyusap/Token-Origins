import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBridge } from "../scripts/agent";
import { emptyState } from "../server/engine";

test("transport supplies state and publishes captions only after the agent finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sotto-caption-"));
  const calls: { name: string; args: any }[] = [];
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const name = new URL(request.url).pathname.split("/").at(-1)!;
    const args = await request.json();
    calls.push({ name, args });
    if (name === "set_activity" && args.status === "thinking") begin();
    return Response.json({ ok: true, state: emptyState() });
  } });
  try {
    await mkdir(join(root, "operator"));
    await writeFile(join(root, "operator/AGENTS.md"), "Use the supplied canvas state.");
    const executable = join(root, "codex");
    await writeFile(executable, `#!${Bun.which("bun")}\nconst prompt = await Bun.stdin.text();\nawait Bun.write(${JSON.stringify(join(root, "prompt.txt"))}, prompt);\nawait Bun.sleep(80);\nconsole.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Bitcoin is $85,275."}}));\nconsole.log(JSON.stringify({type:"turn.completed"}));\n`);
    await chmod(executable, 0o755);
    const bridge = createAgentBridge({ rootDir: root, codexPath: executable, serverUrl: `http://127.0.0.1:${backend.port}`, getContext: emptyState });
    const pending = bridge.submitAgentPrompt("What about Bitcoin?");
    await started;
    expect(calls.some(call => call.name === "submit_utterance")).toBe(false);
    const turn = await pending;
    expect(turn.error).toBeUndefined();
    expect(turn.ok).toBe(true);
    expect(calls.map(call => call.name)).toEqual(["set_activity", "submit_utterance", "set_activity"]);
    expect(calls[1]!.args.text).toBe("What about Bitcoin?");
    expect(calls[2]!.args).toMatchObject({ status: "idle", summary: "Bitcoin is $85,275." });
    const prompt = await Bun.file(join(root, "prompt.txt")).text();
    expect(prompt).toContain("transport owns caption publication");
    expect(prompt).toContain('"revision":0');
    expect(prompt).toContain("do not refetch get_context");
    expect(calls.some(call => call.name === "get_context")).toBe(false);
  } finally {
    backend.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
