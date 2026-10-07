import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalVoiceTranscriber, runVoiceProcess, voiceAudioFormat, voicePcmToWav, VOICE_MAX_BYTES, type VoiceProcessInput } from "../server/transcribe";

function spokenPcm(seconds = 1): Uint8Array {
  const pcm = Buffer.alloc(seconds * 32000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * .09) * 3000), i * 2);
  return pcm;
}
function harness(run?: (input: VoiceProcessInput, call: number) => Promise<Uint8Array>) {
  const dir = mkdtempSync(join(tmpdir(), "woga-voice-test-")), calls: VoiceProcessInput[] = [];
  const provider = new LocalVoiceTranscriber({ dataDir: dir, testAdapter: { available: true, run: async input => {
    calls.push(input);
    if (run) return run(input, calls.length);
    if (calls.length % 2 === 1) return spokenPcm();
    writeFileSync(`${input.args[input.args.indexOf("-of") + 1]}.txt`, "Show the current Solana price.");
    return new Uint8Array();
  } } });
  return { dir, calls, provider, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test("voice format whitelist rejects playlists, filenames, and disguised demuxer hints", () => {
  expect(voiceAudioFormat("audio/webm;codecs=opus")).toBe("matroska");
  expect(voiceAudioFormat("audio/mp4")).toBe("mov");
  expect(() => voiceAudioFormat("application/vnd.apple.mpegurl")).toThrow();
  expect(() => voiceAudioFormat("../../etc/passwd")).toThrow();
});
test("lost multipart MIME uses known container bytes without opening playlist or arbitrary format support", () => {
  expect(voiceAudioFormat("", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe("matroska");
  expect(voiceAudioFormat("application/octet-stream", new TextEncoder().encode("RIFFxxxxWAVE"))).toBe("wav");
  expect(voiceAudioFormat(" AUDIO/WEBM; codecs=opus ")).toBe("matroska");
  expect(() => voiceAudioFormat("", new TextEncoder().encode("#EXTM3U\nfile:///etc/passwd"))).toThrow();
  expect(() => voiceAudioFormat("application/vnd.apple.mpegurl", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toThrow();
});
test("decoded audio duration and speech energy are validated before recognizer inference", () => {
  expect(() => voicePcmToWav(spokenPcm(31))).toThrow("30 seconds");
  expect(() => voicePcmToWav(new Uint8Array(32000))).toThrow("No speech");
  expect(() => voicePcmToWav(new Uint8Array(2))).toThrow("too short");
  const wav = Buffer.from(voicePcmToWav(spokenPcm()));
  expect(wav.subarray(0, 4).toString()).toBe("RIFF");
  expect(wav.readUInt32LE(24)).toBe(16000); expect(wav.length).toBe(32044);
});
test("bounded byte upload rejects empty and oversized recordings without subprocess work", async () => {
  const h = harness();
  try {
    await expect(h.provider.transcribe({ bytes: new Uint8Array(), mimeType: "audio/wav" })).rejects.toThrow("empty");
    await expect(h.provider.transcribe({ bytes: new Uint8Array(VOICE_MAX_BYTES + 1), mimeType: "audio/wav" })).rejects.toThrow("5 MiB");
    expect(h.calls).toHaveLength(0);
  } finally { h.cleanup(); }
});
test("transcription returns recognizer output and provenance then removes every runtime clip", async () => {
  const h = harness();
  try {
    const receipt = await h.provider.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/webm;codecs=opus" });
    expect(receipt.transcript).toBe("Show the current Solana price."); expect(receipt.engine).toBe("whisper.cpp");
    expect(receipt.model).toBe("base.en"); expect(receipt.durationSeconds).toBe(1);
    expect(h.calls[0].args).toContain("pipe"); expect(h.calls[0].args).toContain("matroska");
    expect(h.calls[1].args).toContain("-ng"); expect(h.calls[1].args).not.toContain("--prompt");
    expect(readdirSync(join(h.dir, "clips"))).toEqual([]);
  } finally { h.cleanup(); }
});
test("capacity one rejects concurrent inference and releases capacity after decoder failure", async () => {
  let release!: (data: Uint8Array) => void;
  const pending = new Promise<Uint8Array>(resolve => { release = resolve; });
  const h = harness(async (_, call) => call === 1 ? pending : Promise.reject(new Error("deliberate test failure")));
  try {
    const first = h.provider.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav" });
    await expect(h.provider.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav" })).rejects.toThrow("already being");
    release(spokenPcm()); await expect(first).rejects.toThrow("could not be transcribed");
    expect(readdirSync(join(h.dir, "clips"))).toEqual([]);
    await expect(h.provider.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav" })).rejects.toThrow("could not be transcribed");
  } finally { h.cleanup(); }
});
test("uninstalled capabilities remain unavailable and cannot silently substitute mock speech", async () => {
  const dir = mkdtempSync(join(tmpdir(), "woga-voice-missing-"));
  try {
    const provider = new LocalVoiceTranscriber({ dataDir: dir });
    expect(provider.capabilities().available).toBe(false);
    await expect(provider.transcribe({ bytes: new Uint8Array([1]), mimeType: "audio/wav" })).rejects.toThrow("not installed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("actual subprocess cancellation kills inference and reports only safe diagnostics", async () => {
  const controller = new AbortController();
  const work = runVoiceProcess({ executable: process.execPath, args: ["-e", "console.error('private/path');setTimeout(()=>{},10000)"], maxOutputBytes: 1024, timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await expect(work).rejects.toThrow("cancelled");
  await expect(runVoiceProcess({ executable: process.execPath, args: ["-e", "console.error('private/path');process.exit(1)"], maxOutputBytes: 1024, timeoutMs: 5000 })).rejects.toThrow("could not be transcribed");
});
test("actual subprocess output and elapsed time are bounded", async () => {
  await expect(runVoiceProcess({ executable: process.execPath, args: ["-e", "console.log('x'.repeat(2048))"], maxOutputBytes: 1024, timeoutMs: 5000 })).rejects.toThrow("processing limit");
  await expect(runVoiceProcess({ executable: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"], maxOutputBytes: 1024, timeoutMs: 50 })).rejects.toThrow("too long");
});
