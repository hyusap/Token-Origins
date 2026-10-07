import { expect, test } from "bun:test";
import { BrowserVoiceInput, type RecognitionEvent, type RecognitionSession, type VoiceOptions } from "../src/voice";

class Recognizer implements RecognitionSession {
  lang = ""; continuous = true; interimResults = false; maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  starts = 0; aborts = 0;
  start() { this.starts++; }
  abort() { this.aborts++; }
  result(entries: Array<[string, boolean]>) {
    this.onresult?.({ resultIndex: 0, results: entries.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
  }
}
function harness(options: Partial<VoiceOptions> = {}, supported = true) {
  const sessions: Recognizer[] = [];
  const commands: string[] = [];
  let interruptions = 0;
  const input = new BrowserVoiceInput(() => {}, { onCommand: text => { commands.push(text); }, ...options }, {
    supported: () => supported,
    create: () => { const session = new Recognizer(); sessions.push(session); return session; },
    interruptNarration: () => { interruptions++; },
  });
  return { input, sessions, commands, interruptions: () => interruptions };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("voice uses single utterance with visible interim and submits merged final indices once on normal end", async () => {
  const h = harness(); h.input.start(); h.input.start();
  const s = h.sessions[0];
  expect(h.sessions).toHaveLength(1); expect(s.continuous).toBeFalse(); expect(s.interimResults).toBeTrue(); expect(s.lang).toBe("en-US");
  s.onstart?.(); expect(h.input.snapshot.status).toBe("listening");
  s.result([["Show SOL", false]]);
  expect(h.input.snapshot.interimTranscript).toBe("Show SOL"); expect(h.commands).toHaveLength(0);
  s.result([["Show SOL", true], ["and ETH prices", false]]);
  s.result([["Show SOL", true], ["and ETH prices", true]]);
  s.result([["Show SOL", true], ["and ETH prices", true]]);
  const duplicateEnd = s.onend!;
  duplicateEnd(); duplicateEnd(); await settle();
  expect(h.commands).toEqual(["Show SOL and ETH prices"]);
  expect(h.input.snapshot.status).toBe("off"); expect(h.input.snapshot.finalTranscript).toBe("Show SOL and ETH prices");
  expect(s.onresult).toBeNull(); h.input.dispose();
});

test("stopping dictation discards even a final transcript and stale callbacks cannot submit", async () => {
  const h = harness(); h.input.start(); const s = h.sessions[0];
  s.result([["Pause spending", true]]);
  const staleEnd = s.onend!; const staleResult = s.onresult!;
  h.input.stop(); staleEnd(); staleResult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "execute" } }] });
  await settle(); expect(h.commands).toHaveLength(0); expect(s.aborts).toBe(1); expect(h.input.snapshot.status).toBe("off"); expect(h.input.snapshot.finalTranscript).toBe("");
  h.input.start(); h.sessions[1].result([["Show Bitcoin", true]]); h.sessions[1].onend?.(); await settle();
  expect(h.commands).toEqual(["Show Bitcoin"]); h.input.dispose();
});

test("stop and new Mic cannot queue another command or cancel an agent operation already pending", async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const commands: string[] = [];
  const h = harness({ onCommand: text => { commands.push(text); return pending; } });
  h.input.start(); h.sessions[0].result([["Run the policy", true]]); h.sessions[0].onend?.();
  expect(h.input.snapshot.status).toBe("submitting");
  h.input.stop(); h.input.start(); h.input.toggle();
  expect(h.sessions).toHaveLength(1); expect(commands).toEqual(["Run the policy"]); expect(h.input.snapshot.status).toBe("submitting");
  release(); await settle(); expect(h.input.snapshot.status).toBe("off"); h.input.dispose();
});

test("permission/network failure does not submit finalized text or pretend capture continues", async () => {
  for (const error of ["not-allowed", "network", "audio-capture", "no-speech"]) {
    const h = harness(); h.input.start(); const s = h.sessions[0]; const oldEnd = s.onend!;
    s.result([["Execute", true]]); s.onerror?.({ error }); oldEnd(); await settle();
    expect(h.commands).toHaveLength(0); expect(h.input.snapshot.status).toBe("error"); expect(h.input.snapshot.error).not.toBeEmpty(); expect(s.aborts).toBe(1); h.input.dispose();
  }
});

test("interim-only end and unavailable browser never invent or submit transcripts", () => {
  const h = harness(); h.input.start(); h.sessions[0].result([["Maybe execute", false]]); h.sessions[0].onend?.();
  expect(h.input.snapshot.status).toBe("error"); expect(h.input.snapshot.finalTranscript).toBe(""); expect(h.commands).toHaveLength(0);
  const unavailable = harness({}, false); unavailable.input.start();
  expect(unavailable.input.snapshot.status).toBe("unavailable"); expect(unavailable.sessions).toHaveLength(0); h.input.dispose();
});

test("busy changes during dictation retain transcript and do not enqueue or silently discard it", () => {
  let available = true; const h = harness({ canStart: () => available });
  h.input.start(); h.sessions[0].result([["Show prices", true]]); available = false; h.sessions[0].onend?.();
  expect(h.commands).toHaveLength(0); expect(h.input.snapshot.finalTranscript).toBe("Show prices"); expect(h.input.snapshot.error).toContain("kept");
  h.input.start(); expect(h.sessions).toHaveLength(1); h.input.dispose();
});

test("callback rejection keeps transcript and surfaces error without automatic retries", async () => {
  const h = harness({ onCommand: async () => { throw new Error("Receipt uncertain; inspect history."); } });
  h.input.start(); h.sessions[0].result([["Run policy", true]]); h.sessions[0].onend?.(); await settle();
  expect(h.input.snapshot.status).toBe("error"); expect(h.input.snapshot.finalTranscript).toBe("Run policy"); expect(h.input.snapshot.error).toContain("Receipt uncertain"); expect(h.sessions).toHaveLength(1); h.input.dispose();
});

test("recognition timeout aborts listening without submitting a partial or restarting", async () => {
  const h = harness({ timeoutMs: 5 }); h.input.start(); h.sessions[0].result([["Part of a rule", false]]);
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(h.input.snapshot.status).toBe("error"); expect(h.input.snapshot.error).toContain("timed out"); expect(h.sessions[0].aborts).toBe(1); expect(h.commands).toHaveLength(0); h.input.dispose();
});

test("dispose prevents late results and late async completion from changing a removed UI", async () => {
  const h = harness(); h.input.start(); const end = h.sessions[0].onend!;
  h.sessions[0].result([["Execute", true]]); h.input.dispose(); end(); await settle(); expect(h.commands).toHaveLength(0);
});
