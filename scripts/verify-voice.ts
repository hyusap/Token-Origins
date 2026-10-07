import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runVoiceProcess, transcribeAudio, VOICE_MODEL, type VoiceTranscript } from "../server/transcribe";

/** Explicit TTS fixture verifies a real recognizer; it does not claim human microphone evidence. */
export async function verifyVoice(options: { tts?: boolean; audioPath?: string; api?: string; outputPath?: string; multipartFilename?: string } = {}) {
  const root = resolve(".data/voice"); mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, "verify-")); chmodSync(dir, 0o700);
  try {
    let audio: Uint8Array;
    const expectedInstruction = "Show me the current price of Solana and Bitcoin.";
    if (options.tts) {
      await runVoiceProcess({ executable: "/usr/bin/say", args: ["-v", "Samantha", "-r", "155", "-o", join(dir, "fixture.aiff"), expectedInstruction], maxOutputBytes: 1024, timeoutMs: 30_000 });
      audio = await runVoiceProcess({ executable: Bun.which("ffmpeg") || "/opt/homebrew/bin/ffmpeg", args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", join(dir, "fixture.aiff"), "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"], maxOutputBytes: 5 * 1024 * 1024, timeoutMs: 15_000 });
    } else if (options.audioPath) audio = readFileSync(resolve(options.audioPath));
    else throw new Error("Specify --tts for labeled synthetic test input or --audio path.wav for a real audio file.");
    let result: VoiceTranscript;
    if (options.api) {
      const form = new FormData(); form.set("audio", new Blob([Uint8Array.from(audio).buffer], { type: "audio/wav" }), options.multipartFilename || "speech.wav");
      const response = await fetch(new URL("/api/voice/transcribe", options.api), { method: "POST", body: form, signal: AbortSignal.timeout(100_000) });
      if (!response.ok) throw new Error(`Voice API rejected real audio: ${response.status} ${await response.text()}`);
      const body = await response.json() as VoiceTranscript & { result?: VoiceTranscript };
      result = body.result || body;
    } else result = await transcribeAudio({ bytes: audio, mimeType: "audio/wav" });
    if (options.tts && (!/solana/i.test(result.transcript) || !/bitcoin/i.test(result.transcript))) throw new Error(`Recognizer failed to preserve both requested assets: ${result.transcript}`);
    const proof = { verifiedAt: new Date().toISOString(), status: "verified", kind: "real-local-recognizer", inputKind: options.tts ? "macOS-Samantha-TTS-fixture" : "provided-audio-file", humanMicrophoneVerified: false,
      pipeline: options.api ? "audio bytes → HTTP multipart → ffmpeg → whisper.cpp" : "audio bytes → ffmpeg → whisper.cpp", audioSha256: createHash("sha256").update(audio).digest("hex"), audioBytes: audio.length,
      ...(options.api ? { multipartFilename: options.multipartFilename || "speech.wav", declaredMimeType: "audio/wav" } : {}),
      ...(options.tts ? { fixtureInstruction: expectedInstruction } : {}), transcript: result.transcript, engine: result.engine, model: result.model, durationSeconds: result.durationSeconds, elapsedMs: result.elapsedMs,
      implementation: { version: VOICE_MODEL.version, commit: VOICE_MODEL.commit, modelSha256: VOICE_MODEL.sha256, repository: VOICE_MODEL.repository },
      operatorExecutionVerified: false, rawAudioRetained: false };
    const output = resolve(options.outputPath || "demo/voice-transcription-verification.json"); mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
    console.log(JSON.stringify(proof, null, 2)); return proof;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
export async function verifyVoiceApiBounds(api: string) {
  const checks: { name: string; status: number; code: string; passed: true }[] = [];
  async function check(name: string, body: Uint8Array, type: string, expected: number) {
    const response = await fetch(new URL("/api/voice/transcribe", api), { method: "POST", headers: { "content-type": type }, body: Uint8Array.from(body).buffer, signal: AbortSignal.timeout(20_000) });
    const reply = await response.json() as { code: string; error?: string };
    if (response.status !== expected) throw new Error(`${name}: expected HTTP ${expected}, got ${response.status}`);
    checks.push({ name, status: response.status, code: reply.code, passed: true });
  }
  await check("malformed WAV redacted", new Uint8Array([1, 2, 3]), "audio/wav", 422);
  await check("playlist MIME rejected", new TextEncoder().encode("#EXTM3U"), "application/vnd.apple.mpegurl", 415);
  await check("oversize raw rejected", new Uint8Array(5 * 1024 * 1024 + 1), "audio/wav", 413);
  await check("empty recording rejected", new Uint8Array(), "audio/wav", 400);
  for (const fixture of [
    { name: "overlength audio rejected", source: "sine=frequency=200:sample_rate=16000", seconds: 31, status: 413 },
    { name: "silent audio rejected", source: "anullsrc=r=16000:cl=mono", seconds: 1, status: 422 },
  ]) {
    const wav = await runVoiceProcess({ executable: Bun.which("ffmpeg") || "/opt/homebrew/bin/ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", fixture.source, "-t", String(fixture.seconds), "-f", "wav", "pipe:1"], timeoutMs: 10_000, maxOutputBytes: 1_100_000 });
    await check(fixture.name, wav, "audio/wav", fixture.status);
  }
  const proof = { verifiedAt: new Date().toISOString(), kind: "real-HTTP-decoder-validation", liveRecognizer: "whisper.cpp/base.en", checks };
  await Bun.write("demo/voice-api-validation.json", `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof, null, 2)); return proof;
}
if (import.meta.main) {
  const args = process.argv.slice(2), after = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  if (args.includes("--tts") || after("--audio") || !args.includes("--validate")) await verifyVoice({ tts: args.includes("--tts"), audioPath: after("--audio"), api: after("--api"), outputPath: after("--output"), multipartFilename: after("--filename") });
  if (args.includes("--validate")) {
    if (!after("--api")) throw new Error("--validate requires --api with a running local backend.");
    await verifyVoiceApiBounds(after("--api")!);
  }
}
