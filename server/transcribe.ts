import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const VOICE_MODEL = {
  engine: "whisper.cpp", version: "v1.8.7", commit: "48f628a84833905ee4a0658ee6d4a5c915ce1997", name: "base.en",
  repository: "https://github.com/ggml-org/whisper.cpp",
  modelUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin",
  sha1: "137c40403d78fd54d454da0f9bd998f78703390c",
  sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
} as const;
export const VOICE_MAX_BYTES = 5 * 1024 * 1024;
export const VOICE_MAX_DURATION_SECONDS = 30;
export class VoiceTranscriptionError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); this.name = "VoiceTranscriptionError"; }
}
export interface VoiceTranscript { transcript: string; engine: "whisper.cpp"; model: "base.en"; durationSeconds: number; elapsedMs: number }
export interface VoiceCapabilities { available: boolean; engine: "whisper.cpp"; model: "base.en"; maxBytes: number; maxDurationSeconds: number; reason?: string }
export interface VoiceProcessInput { executable: string; args: string[]; input?: Uint8Array; maxOutputBytes: number; timeoutMs: number; signal?: AbortSignal }
export type VoiceProcessRunner = (input: VoiceProcessInput) => Promise<Uint8Array>;

/** Bounded argv-only child processes; raw recognizer stderr never reaches the client. */
export const runVoiceProcess: VoiceProcessRunner = async (input) => {
  if (input.signal?.aborted) throw new VoiceTranscriptionError("cancelled", 499, "Voice transcription was cancelled.");
  return new Promise((done, fail) => {
    const child = spawn(input.executable, input.args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "en_US.UTF-8", OMP_NUM_THREADS: "2" } });
    const chunks: Buffer[] = [];
    let bytes = 0, settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
      if (error) { child.kill("SIGKILL"); fail(error); } else done(Buffer.concat(chunks));
    };
    const abort = () => finish(new VoiceTranscriptionError("cancelled", 499, "Voice transcription was cancelled."));
    const timer = setTimeout(() => finish(new VoiceTranscriptionError("timeout", 504, "Voice transcription took too long. Try a shorter recording.")), input.timeoutMs);
    input.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(new VoiceTranscriptionError("process-unavailable", 503, "The local voice recognizer is unavailable.")));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > input.maxOutputBytes) finish(new VoiceTranscriptionError("output-limit", 422, "The recording exceeds the voice processing limit."));
      else chunks.push(chunk);
    });
    child.stderr.on("data", () => {}); // Drain diagnostics without retaining audio, paths, or raw stderr.
    child.stdin.on("error", () => {}); // Decoder failures can close stdin while it is being written.
    child.on("close", (code) => finish(code === 0 ? undefined : new VoiceTranscriptionError("invalid-audio", 422, "The recording could not be transcribed. Try recording again.")));
    child.stdin.end(input.input);
    if (input.signal?.aborted) abort();
  });
};

export function voiceAudioFormat(mimeType: string, bytes?: Uint8Array): string {
  let mime = mimeType.toLowerCase().split(";", 1)[0].trim();
  // Bun can discard a multipart part's declared MIME when its filename has no extension.
  // Recover only a known container signature; the fixed demuxer still validates all bytes.
  if ((!mime || mime === "application/octet-stream") && bytes) {
    const prefix = (text: string, offset = 0) => bytes.length >= offset + text.length && [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) mime = "audio/webm";
    else if (prefix("RIFF") && prefix("WAVE", 8)) mime = "audio/wav";
    else if (prefix("OggS")) mime = "audio/ogg";
    else if (prefix("fLaC")) mime = "audio/flac";
    else if (prefix("ftyp", 4)) mime = "audio/mp4";
    else if (prefix("ID3") || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) mime = "audio/mpeg";
  }
  const formats: Record<string, string> = { "audio/webm": "matroska", "video/webm": "matroska", "audio/ogg": "ogg", "application/ogg": "ogg", "audio/wav": "wav", "audio/wave": "wav", "audio/x-wav": "wav", "audio/mp4": "mov", "video/mp4": "mov", "audio/mpeg": "mp3", "audio/flac": "flac" };
  if (!formats[mime]) throw new VoiceTranscriptionError("unsupported-audio", 415, "Record audio as WebM, Ogg, WAV, MP4, MP3, or FLAC.");
  return formats[mime];
}
export function voicePcmToWav(pcm: Uint8Array): Uint8Array {
  const seconds = pcm.length / 32000;
  if (pcm.length % 2 || seconds < .15) throw new VoiceTranscriptionError("empty-audio", 422, "The recording is too short. Speak a complete instruction.");
  if (seconds > VOICE_MAX_DURATION_SECONDS) throw new VoiceTranscriptionError("duration-limit", 413, "Voice recordings must be 30 seconds or shorter.");
  const data = Buffer.from(pcm), samples = data.length / 2;
  let energy = 0;
  for (let i = 0; i < data.length; i += 2) energy += (data.readInt16LE(i) / 32768) ** 2;
  if (Math.sqrt(energy / samples) < .001) throw new VoiceTranscriptionError("no-speech", 422, "No speech was detected. Try speaking closer to the microphone.");
  const wav = Buffer.alloc(44 + data.length);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + data.length, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(data.length, 40); data.copy(wav, 44);
  return wav;
}

/** Test adapters require explicit construction and are never wired to the HTTP provider. */
export class LocalVoiceTranscriber {
  private busy = false;
  private modelStamp?: string;
  private modelValid = false;
  constructor(private options: { dataDir?: string; ffmpegPath?: string; testAdapter?: { available: boolean; run: VoiceProcessRunner } } = {}) {}
  private get dataDir() { return resolve(this.options.dataDir || process.env.ORIGINS_VOICE_DATA_DIR || ".data/voice"); }
  private get executable() { return join(this.dataDir, "whisper.cpp/build/bin/whisper-cli"); }
  private get model() { return join(this.dataDir, "ggml-base.en.bin"); }
  private get ffmpeg() { return this.options.ffmpegPath || process.env.ORIGINS_FFMPEG_PATH || Bun.which("ffmpeg") || "/opt/homebrew/bin/ffmpeg"; }
  capabilities(): VoiceCapabilities {
    const base: VoiceCapabilities = { available: false, engine: VOICE_MODEL.engine, model: VOICE_MODEL.name, maxBytes: VOICE_MAX_BYTES, maxDurationSeconds: VOICE_MAX_DURATION_SECONDS };
    if (this.options.testAdapter) return { ...base, available: this.options.testAdapter.available, ...(this.options.testAdapter.available ? {} : { reason: "Local voice transcription is unavailable." }) };
    try {
      accessSync(this.executable, constants.X_OK); accessSync(this.ffmpeg, constants.X_OK);
      const info = statSync(this.model), stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (stamp !== this.modelStamp) {
        this.modelStamp = stamp;
        this.modelValid = info.size === 147964211 && createHash("sha256").update(readFileSync(this.model)).digest("hex") === VOICE_MODEL.sha256;
      }
      if (!this.modelValid) return { ...base, reason: "Local voice model verification failed. Run bun run scripts/setup-voice.ts." };
      return { ...base, available: true };
    } catch { return { ...base, reason: "Install local voice transcription with bun run scripts/setup-voice.ts." }; }
  }
  async transcribe(input: { bytes: Uint8Array; mimeType: string; signal?: AbortSignal }): Promise<VoiceTranscript> {
    if (!input.bytes.length) throw new VoiceTranscriptionError("empty-audio", 422, "The recording is empty.");
    if (input.bytes.length > VOICE_MAX_BYTES) throw new VoiceTranscriptionError("size-limit", 413, "Voice recordings must be smaller than 5 MiB.");
    const format = voiceAudioFormat(input.mimeType, input.bytes);
    if (input.signal?.aborted) throw new VoiceTranscriptionError("cancelled", 499, "Voice transcription was cancelled.");
    if (!this.capabilities().available) throw new VoiceTranscriptionError("unavailable", 503, "Local voice transcription is not installed.");
    if (this.busy) throw new VoiceTranscriptionError("busy", 429, "A voice recording is already being transcribed. Try again shortly.");
    this.busy = true;
    let dir: string | undefined;
    const started = performance.now(), run = this.options.testAdapter?.run || runVoiceProcess;
    try {
      mkdirSync(join(this.dataDir, "clips"), { recursive: true, mode: 0o700 }); chmodSync(join(this.dataDir, "clips"), 0o700);
      dir = mkdtempSync(join(this.dataDir, "clips", "recording-")); chmodSync(dir, 0o700);
      // A fixed demuxer prevents uploaded playlists from dereferencing URLs or local files.
      const pcm = await run({ executable: this.ffmpeg, args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "2", "-protocol_whitelist", "pipe", "-f", format, "-i", "pipe:0", "-map", "0:a:0", "-vn", "-t", "31", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], input: input.bytes, timeoutMs: 15_000, maxOutputBytes: 31 * 32000 + 1024, signal: input.signal });
      const wav = voicePcmToWav(pcm), path = join(dir, "speech.wav"), output = join(dir, "transcript");
      writeFileSync(path, wav, { mode: 0o600 });
      await run({ executable: this.executable, args: ["-m", this.model, "-f", path, "-l", "en", "-t", "2", "-ng", "-nt", "-otxt", "-of", output], maxOutputBytes: 64 * 1024, timeoutMs: 90_000, signal: input.signal });
      if (input.signal?.aborted) throw new VoiceTranscriptionError("cancelled", 499, "Voice transcription was cancelled.");
      const transcript = readFileSync(`${output}.txt`, "utf8").trim().replace(/\s+/g, " ");
      if (!transcript || transcript.length > 4000 || /^\s*(?:\[[^\]]*\]|\([^)]*\)|[.\s])+\s*$/.test(transcript)) throw new VoiceTranscriptionError("no-speech", 422, "No clear speech was detected. Try recording again.");
      return { transcript, engine: VOICE_MODEL.engine, model: VOICE_MODEL.name, durationSeconds: pcm.length / 32000, elapsedMs: Math.round(performance.now() - started) };
    } catch (error) {
      if (error instanceof VoiceTranscriptionError) throw error;
      throw new VoiceTranscriptionError("recognizer-failed", 422, "The recording could not be transcribed. Try recording again.");
    } finally { if (dir) rmSync(dir, { recursive: true, force: true }); this.busy = false; }
  }
}
const provider = new LocalVoiceTranscriber();
export const voiceCapabilities = () => provider.capabilities();
export const transcribeAudio = (input: Parameters<LocalVoiceTranscriber["transcribe"]>[0]) => provider.transcribe(input);
