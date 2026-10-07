import { useEffect, useRef, useState } from "react";
import { LocalVoiceInput } from "./local-voice";

export type VoiceStatus = "off" | "checking" | "requesting" | "listening" | "transcribing" | "submitting" | "error" | "unavailable";
export interface VoiceSnapshot {
  supported: boolean;
  provider?: "browser" | "local" | "checking";
  analyser?: AnalyserNode | null;
  status: VoiceStatus;
  interimTranscript: string;
  finalTranscript: string;
  error: string;
}
export interface RecognitionResult {
  isFinal: boolean;
  [index: number]: { transcript: string };
}
export interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
/** Small interface so browser behavior can be exercised without capturing ambient audio in tests. */
export interface RecognitionSession {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
export interface VoiceHost {
  supported(): boolean;
  create(): RecognitionSession;
  interruptNarration(): void;
}
type RecognitionConstructor = new () => RecognitionSession;
const constructor = () => {
  if (typeof window === "undefined") return undefined;
  const browser = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
};
const browserHost: VoiceHost = {
  supported: () => !!constructor() && window.isSecureContext,
  create: () => { const Recognition = constructor(); if (!Recognition) throw new Error("Speech recognition is unavailable."); return new Recognition(); },
  interruptNarration: () => { if (typeof window !== "undefined") window.speechSynthesis?.cancel(); },
};
const unsupported = "Voice dictation is unavailable in this browser. Open this page in a browser with Web Speech recognition over HTTPS or localhost, or type your command.";
function recognitionError(code: string) {
  if (["not-allowed", "service-not-allowed"].includes(code)) return "Voice permission was denied or the browser speech service is disabled. Allow microphone access, or type your command.";
  if (code === "audio-capture") return "The microphone could not be opened. Check your microphone and browser permissions, or type your command.";
  if (code === "network") return "The browser speech service could not connect. Check your connection, or type your command. Nothing was submitted.";
  if (code === "no-speech") return "No speech was recognized. Try Mic again, or type your command. Nothing was submitted.";
  if (code === "language-not-supported") return "The browser speech service does not support English here. Type your command.";
  return `Voice recognition stopped (${code || "unknown error"}). Nothing was submitted; type your command or try Mic again.`;
}
export interface VoiceOptions {
  onCommand(text: string): Promise<boolean | void> | boolean | void;
  canStart?(): boolean;
  language?: string;
  timeoutMs?: number;
}

/** One explicit Mic gesture -> one utterance -> at most one semantic agent operation.
 * Audio is handled by the browser's real speech service (which may process it remotely).
 * Stop aborts dictation; it never claims to cancel an already submitted transaction.
 */
export class BrowserVoiceInput {
  snapshot: VoiceSnapshot;
  private generation = 0;
  private session: RecognitionSession | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  constructor(private changed: (value: VoiceSnapshot) => void, private options: VoiceOptions, private host: VoiceHost = browserHost) {
    const supported = host.supported();
    this.snapshot = { supported, provider: "browser", status: supported ? "off" : "unavailable", interimTranscript: "", finalTranscript: "", error: supported ? "" : unsupported };
  }
  private emit(update: Partial<VoiceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.changed(this.snapshot);
  }
  private detach(abort = true) {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.onstart = session.onresult = session.onerror = session.onend = null;
    if (abort) { try { session.abort(); } catch { /* Some browsers already disconnected. */ } }
  }
  stop() {
    this.host.interruptNarration();
    if (this.pending) return; // The agent operation continues, independently of audio capture.
    this.generation++;
    this.detach();
    this.emit({ status: this.snapshot.supported ? "off" : "unavailable", interimTranscript: "", finalTranscript: "", error: this.snapshot.supported ? "" : unsupported });
  }
  toggle() {
    if (["requesting", "listening"].includes(this.snapshot.status)) this.stop();
    else this.start();
  }
  start() {
    this.host.interruptNarration();
    if (this.pending || ["requesting", "listening"].includes(this.snapshot.status)) return;
    if (!this.snapshot.supported) { this.emit({ status: "unavailable", error: unsupported }); return; }
    if (this.options.canStart?.() === false) { this.emit({ status: "error", error: "An operation is still running. Wait for it to finish before dictating another command." }); return; }
    const token = ++this.generation;
    this.emit({ status: "requesting", interimTranscript: "", finalTranscript: "", error: "" });
    try {
      const session = this.host.create();
      this.session = session;
      session.lang = this.options.language || "en-US";
      session.continuous = false;
      session.interimResults = true;
      session.maxAlternatives = 1;
      const final = new Map<number, string>();
      session.onstart = () => { if (token === this.generation) this.emit({ status: "listening" }); };
      session.onresult = event => {
        if (token !== this.generation || this.session !== session) return;
        const interim: string[] = [];
        // Results contain the whole utterance. Indices, rather than text, identify repeated callbacks.
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result?.[0]?.transcript?.trim();
          if (!text) continue;
          if (result.isFinal) { if (!final.has(i)) final.set(i, text); }
          else if (!final.has(i)) interim.push(text);
        }
        this.emit({ interimTranscript: interim.join(" "), finalTranscript: [...final.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join(" ") });
      };
      session.onerror = event => {
        if (token !== this.generation) return;
        this.generation++;
        this.detach();
        this.emit({ status: "error", interimTranscript: "", error: recognitionError(event.error) });
      };
      session.onend = () => {
        if (token !== this.generation || this.session !== session) return;
        this.detach(false);
        const text = this.snapshot.finalTranscript.trim();
        if (!text) { this.emit({ status: "error", interimTranscript: "", error: recognitionError("no-speech") }); return; }
        if (this.options.canStart?.() === false) { this.emit({ status: "error", interimTranscript: "", error: "Another operation started while you spoke. Your transcript was kept; submit it as a typed command when ready." }); return; }
        this.pending = true;
        this.emit({ status: "submitting", interimTranscript: "" });
        void this.deliver(text, token);
      };
      this.deadline = setTimeout(() => {
        if (token !== this.generation || this.session !== session) return;
        this.generation++;
        this.detach();
        this.emit({ status: "error", interimTranscript: "", error: "Voice recognition timed out. Nothing was submitted. Check microphone permissions and try again, or type your command." });
      }, this.options.timeoutMs ?? 45000);
      session.start();
    } catch (error) {
      this.generation++;
      this.detach();
      this.emit({ status: "error", error: error instanceof Error ? error.message : "Voice recognition could not start. Type your command." });
    }
  }
  private async deliver(text: string, token: number) {
    try {
      const accepted = await this.options.onCommand(text);
      if (token === this.generation) this.emit(accepted === false
        ? { status: "error", error: "Your voice command could not be submitted. The transcript was kept; review the operation status before retrying." }
        : { status: "off", error: "" });
    } catch (error) {
      if (token === this.generation) this.emit({ status: "error", error: error instanceof Error ? error.message : "The command failed. Review its status before retrying." });
    } finally { this.pending = false; }
  }
  dispose() { this.generation++; this.detach(); }
}

export function useVoice(options: VoiceOptions) {
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<BrowserVoiceInput | LocalVoiceInput | null>(null);
  const callbacks: VoiceOptions = {
    onCommand: text => latest.current.onCommand(text),
    canStart: () => latest.current.canStart?.() !== false,
    language: options.language,
  };
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(() => {
    return { supported: false, provider: "checking", status: "checking", interimTranscript: "", finalTranscript: "", error: "" };
  });
  useEffect(() => {
    let removed = false;
    const cancellation = new AbortController();
    void (async () => {
      let local = false;
      const availabilityTimeout = setTimeout(() => cancellation.abort(), 5000);
      try {
        const response = await fetch("/api/voice/capabilities", { signal: cancellation.signal });
        const capabilities = response.ok ? await response.json() : null;
        local = capabilities?.available === true && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined" && typeof AudioContext !== "undefined";
      } catch { /* Native recognition remains an explicit browser-service fallback. */ }
      finally { clearTimeout(availabilityTimeout); }
      if (removed) return;
      controller.current = local
        ? new LocalVoiceInput(setSnapshot, callbacks)
        : new BrowserVoiceInput(setSnapshot, callbacks);
      setSnapshot(controller.current.snapshot);
    })();
    return () => { removed = true; cancellation.abort(); controller.current?.dispose(); controller.current = null; };
  }, []);
  return { ...snapshot, start: () => controller.current?.start(), stop: () => controller.current?.stop(), toggle: () => controller.current?.toggle() };
}
