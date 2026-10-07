import { expect, test } from "bun:test";
import { LocalVoiceInput, voiceUploadForm, type LocalVoiceHost, type VoiceCapture } from "../src/local-voice";
import { voiceAudioFormat } from "../server/transcribe";
import type { VoiceOptions } from "../src/voice";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
test("real Bun multipart parsing preserves the browser Opus recording's supported format and bytes", async () => {
  for (const type of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]) {
    const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type });
    const request = new Request("http://127.0.0.1/api/voice/transcribe", { method: "POST", body: voiceUploadForm(audio) });
    const file = (await request.formData()).get("audio") as File;
    expect(file).toBeInstanceOf(File);
    expect(voiceAudioFormat(file.type)).toBe(type.includes("ogg") ? "ogg" : type.includes("mp4") ? "mov" : "matroska");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(file.name).toMatch(/\.(webm|ogg|mp4)$/);
  }
});
function harness(options: Partial<VoiceOptions> = {}) {
  const recording = deferred<Blob>(); const transcription = deferred<string>();
  const commands: string[] = []; const uploads: Blob[] = []; const signals: AbortSignal[] = [];
  let aborts = 0;
  const capture: VoiceCapture = { result: recording.promise, analyser: null, abort: () => { aborts++; } };
  const host: LocalVoiceHost = {
    capture: async signal => { signals.push(signal); return capture; },
    transcribe: async (audio, signal) => { uploads.push(audio); signals.push(signal); return transcription.promise; },
    interruptNarration: () => {},
  };
  const input = new LocalVoiceInput(() => {}, { onCommand: text => { commands.push(text); }, ...options }, host);
  return { input, recording, transcription, commands, uploads, signals, host, capture, aborts: () => aborts };
}

test("local voice sends actual captured blob to transcriber then one final transcript to semantic bridge", async () => {
  const h = harness(); h.input.start(); h.input.start(); await settle();
  expect(h.input.snapshot.provider).toBe("local"); expect(h.input.snapshot.status).toBe("listening"); expect(h.signals).toHaveLength(1);
  const audio = new Blob(["explicit unit adapter audio"], { type: "audio/webm" });
  h.recording.resolve(audio); await settle(); expect(h.input.snapshot.status).toBe("transcribing"); expect(h.uploads[0]).toBe(audio); expect(h.commands).toHaveLength(0);
  h.transcription.resolve("Show Solana prices"); await settle();
  expect(h.commands).toEqual(["Show Solana prices"]); expect(h.input.snapshot.finalTranscript).toBe("Show Solana prices"); expect(h.input.snapshot.status).toBe("off"); h.input.dispose();
});

test("local stop aborts transcription and late provider result cannot submit an operation", async () => {
  const h = harness(); h.input.start(); await settle(); h.recording.resolve(new Blob(["audio"])); await settle();
  h.input.stop(); expect(h.signals[1].aborted).toBeTrue(); h.transcription.resolve("Execute now"); await settle();
  expect(h.commands).toHaveLength(0); expect(h.input.snapshot.finalTranscript).toBe(""); expect(h.input.snapshot.status).toBe("off"); h.input.dispose();
});

test("late microphone permission resolution after stop releases stream instead of listening", async () => {
  const permission = deferred<VoiceCapture>(); const h = harness(); h.host.capture = async signal => { h.signals.push(signal); return permission.promise; };
  h.input.start(); h.input.stop(); permission.resolve(h.capture); await settle();
  expect(h.aborts()).toBe(1); expect(h.signals[0].aborted).toBeTrue(); expect(h.commands).toHaveLength(0); expect(h.input.snapshot.status).toBe("off"); h.input.dispose();
});

test("operation beginning during real transcription prevents queue and retains transcript", async () => {
  let available = true; const h = harness({ canStart: () => available }); h.input.start(); await settle(); h.recording.resolve(new Blob(["audio"])); await settle();
  available = false; h.transcription.resolve("Run policy"); await settle();
  expect(h.commands).toHaveLength(0); expect(h.input.snapshot.status).toBe("error"); expect(h.input.snapshot.finalTranscript).toBe("Run policy"); expect(h.input.snapshot.error).toContain("kept"); h.input.dispose();
});

test("local Stop cannot cancel a command already submitted or queue a second Mic operation", async () => {
  const bridge = deferred<void>(); const h = harness({ onCommand: () => bridge.promise }); h.input.start(); await settle(); h.recording.resolve(new Blob(["audio"])); await settle(); h.transcription.resolve("Run policy"); await settle();
  expect(h.input.snapshot.status).toBe("submitting"); h.input.stop(); h.input.start();
  expect(h.signals[0].aborted).toBeFalse(); expect(h.signals).toHaveLength(2); expect(h.input.snapshot.status).toBe("submitting");
  bridge.resolve(); await settle(); expect(h.input.snapshot.status).toBe("off"); h.input.dispose();
});

test("provider failure exposes error without fabricated transcript or semantic command", async () => {
  const h = harness(); h.input.start(); await settle(); h.recording.resolve(new Blob(["audio"])); await settle(); h.transcription.reject(new Error("Model unavailable")); await settle();
  expect(h.input.snapshot.status).toBe("error"); expect(h.input.snapshot.error).toBe("Model unavailable"); expect(h.input.snapshot.finalTranscript).toBe(""); expect(h.commands).toHaveLength(0); h.input.dispose();
});

test("stale capture failures cannot alter a replacement operation's submitting lock", async () => {
  const oldCapture = deferred<VoiceCapture>(); const currentCapture = deferred<VoiceCapture>(); const bridge = deferred<void>();
  const h = harness({ onCommand: () => bridge.promise }); let calls = 0;
  h.host.capture = async () => (++calls === 1 ? oldCapture.promise : currentCapture.promise);
  h.input.start(); h.input.stop(); h.input.start(); currentCapture.resolve(h.capture); await settle(); h.recording.resolve(new Blob(["audio"])); await settle(); h.transcription.resolve("Run"); await settle();
  oldCapture.reject(new Error("Late permission failure")); await settle(); h.input.start();
  expect(calls).toBe(2); expect(h.input.snapshot.status).toBe("submitting"); bridge.resolve(); await settle(); h.input.dispose();
});
