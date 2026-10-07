import type { VoiceOptions, VoiceSnapshot } from "./voice";

export interface VoiceCapture {
  result: Promise<Blob>;
  analyser: AnalyserNode | null;
  abort(): void;
}
export interface LocalVoiceHost {
  capture(signal: AbortSignal): Promise<VoiceCapture>;
  transcribe(audio: Blob, signal: AbortSignal): Promise<string>;
  interruptNarration(): void;
}

/** Capture starts only on an explicit Mic gesture; silence ends an utterance, never a synthetic transcript. */
export async function captureUtterance(signal: AbortSignal): Promise<VoiceCapture> {
  const context = new AudioContext();
  const resumed = context.resume().then(() => null, error => error);
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let rejectResult: ((error: Error) => void) | null = null;
  let finished = false;
  let rejectPermission: ((error: Error) => void) | null = null;
  let permissionTimer: ReturnType<typeof setTimeout> | null = null;
  const dispose = () => {
    if (poll) clearInterval(poll);
    if (permissionTimer) clearTimeout(permissionTimer);
    poll = null;
    stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    if (context.state !== "closed") void context.close().catch(() => {});
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    if (finished) return;
    finished = true;
    rejectPermission?.(new Error("Voice capture cancelled."));
    if (recorder?.state === "recording") recorder.stop();
    dispose();
    rejectResult?.(new Error("Voice capture cancelled."));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const permission = new Promise<never>((_, reject) => { rejectPermission = reject; });
    permissionTimer = setTimeout(() => rejectPermission?.(new Error("Microphone permission is still pending. Nothing was submitted; allow access and try Mic again.")), 30000);
    const requestedStream = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).then(value => {
      if (signal.aborted || finished) value.getTracks().forEach(track => track.stop());
      return value;
    });
    stream = await Promise.race([requestedStream, permission]);
    clearTimeout(permissionTimer); permissionTimer = null;
    if (signal.aborted) { dispose(); throw new Error("Voice capture cancelled."); }
    const resumeError = await resumed;
    if (resumeError) throw resumeError;
    if (signal.aborted) { dispose(); throw new Error("Voice capture cancelled."); }
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    const result = new Promise<Blob>((resolve, reject) => {
      rejectResult = reject;
      recorder!.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder!.onerror = () => { finished = true; dispose(); reject(new Error("Microphone recording failed. Nothing was submitted.")); };
      recorder!.onstop = () => {
        if (finished) return;
        finished = true;
        dispose();
        resolve(new Blob(chunks, { type: recorder!.mimeType || "audio/webm" }));
      };
    });
    // Attach a rejection handler immediately so a cancellation during initialization is never unhandled.
    void result.catch(() => {});
    const samples = new Float32Array(analyser.fftSize);
    const began = performance.now();
    let voicedAt = 0;
    let speechFrames = 0;
    recorder.start(200);
    stream.getAudioTracks().forEach(track => { track.onended = () => { rejectResult?.(new Error("Microphone disconnected. Nothing was submitted.")); abort(); }; });
    poll = setInterval(() => {
      if (finished || recorder?.state !== "recording") return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      const now = performance.now();
      if (rms > .008) { voicedAt = now; speechFrames++; }
      if (speechFrames >= 4 && now - voicedAt >= 1100 && now - began >= 1500) recorder.stop();
      else if (now - began >= (speechFrames >= 4 ? 28000 : 12000)) {
        if (speechFrames >= 4) recorder.stop();
        else { rejectResult?.(new Error("No speech was detected. Nothing was submitted; try Mic again or type your command.")); abort(); }
      }
    }, 50);
    return { analyser, result, abort };
  } catch (error) {
    finished = true;
    dispose();
    throw error;
  }
}

export function voiceUploadForm(audio: Blob) {
    if (!audio.size) throw new Error("No audio was recorded. Nothing was submitted.");
    if (audio.size > 5242880) throw new Error("Voice audio exceeds 5 MB. Try a shorter command.");
    const mimeType = audio.type.toLowerCase().split(";", 1)[0].trim() || "audio/webm";
    const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : mimeType.includes("wav") ? "wav" : "webm";
    const body = new FormData();
    // A canonical media type and extension also survive Bun's multipart File normalization.
    body.append("audio", new Blob([audio], { type: mimeType }), `utterance.${extension}`);
    return body;
}
const browserHost: LocalVoiceHost = {
  capture: captureUtterance,
  transcribe: async (audio, signal) => {
    const body = voiceUploadForm(audio);
    const response = await fetch("/api/voice/transcribe", { method: "POST", body, signal });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || "Local speech recognition failed. Nothing was submitted.");
    if (typeof data.transcript !== "string" || !data.transcript.trim()) throw new Error("No speech was recognized. Nothing was submitted.");
    return data.transcript.trim();
  },
  interruptNarration: () => window.speechSynthesis?.cancel(),
};

export class LocalVoiceInput {
  snapshot: VoiceSnapshot = { supported: true, provider: "local", status: "off", interimTranscript: "", finalTranscript: "", analyser: null, error: "" };
  private generation = 0;
  private abortController: AbortController | null = null;
  private pendingAgent = false;
  private pendingAgentToken: number | null = null;
  constructor(private changed: (value: VoiceSnapshot) => void, private options: VoiceOptions, private host: LocalVoiceHost = browserHost) {}
  private emit(update: Partial<VoiceSnapshot>) { this.snapshot = { ...this.snapshot, ...update }; this.changed(this.snapshot); }
  stop() {
    this.host.interruptNarration();
    if (this.pendingAgent) return;
    this.generation++;
    this.abortController?.abort(); this.abortController = null;
    this.emit({ status: "off", analyser: null, interimTranscript: "", finalTranscript: "", error: "" });
  }
  toggle() { ["requesting", "listening", "transcribing"].includes(this.snapshot.status) ? this.stop() : this.start(); }
  start() {
    this.host.interruptNarration();
    if (this.pendingAgent || ["requesting", "listening", "transcribing"].includes(this.snapshot.status)) return;
    if (this.options.canStart?.() === false) { this.emit({ status: "error", error: "An operation is still running. Wait for it to finish before dictating another command." }); return; }
    const token = ++this.generation;
    const cancellation = new AbortController();
    this.abortController = cancellation;
    this.emit({ status: "requesting", interimTranscript: "", finalTranscript: "", analyser: null, error: "" });
    void this.run(token, cancellation);
  }
  private async run(token: number, cancellation: AbortController) {
    try {
      const capture = await this.host.capture(cancellation.signal);
      if (token !== this.generation) { capture.abort(); return; }
      this.emit({ status: "listening", analyser: capture.analyser });
      const audio = await capture.result;
      if (token !== this.generation) return;
      this.emit({ status: "transcribing", analyser: null });
      const text = await this.host.transcribe(audio, cancellation.signal);
      if (token !== this.generation) return;
      this.emit({ finalTranscript: text });
      if (this.options.canStart?.() === false) throw new Error("Another operation started while you spoke. Your transcript was kept; submit it as a typed command when ready.");
      this.pendingAgent = true;
      this.pendingAgentToken = token;
      this.emit({ status: "submitting" });
      const accepted = await this.options.onCommand(text);
      if (token === this.generation) this.emit(accepted === false
        ? { status: "error", error: "Your voice command could not be submitted. The transcript was kept; review the operation status before retrying." }
        : { status: "off", error: "" });
    } catch (error) {
      if (token !== this.generation) return;
      const name = error instanceof Error ? error.name : "";
      const message = ["NotAllowedError", "SecurityError"].includes(name)
        ? "Microphone permission was denied. Allow microphone access, or type your command. Nothing was submitted."
        : name === "NotFoundError" ? "No microphone was found. Connect one or type your command."
        : name === "NotReadableError" ? "The microphone could not be opened. Check that another app is not blocking it, or type your command."
        : error instanceof Error ? error.message : "Voice recognition failed. Nothing was submitted.";
      this.emit({ status: "error", analyser: null, error: message });
    } finally {
      if (this.abortController === cancellation) this.abortController = null;
      if (this.pendingAgentToken === token) { this.pendingAgent = false; this.pendingAgentToken = null; }
    }
  }
  dispose() { this.generation++; this.abortController?.abort(); this.abortController = null; }
}
