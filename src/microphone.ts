export type MicrophoneStatus = "off" | "requesting" | "live" | "error";
export interface MicrophoneSnapshot {
  status: MicrophoneStatus;
  analyser: AnalyserNode | null;
  error: string;
}
export interface MicrophoneHost {
  createContext(): AudioContext;
  getStream(): Promise<MediaStream>;
}
const browserHost: MicrophoneHost = {
  createContext: () => new AudioContext(),
  getStream: () => {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Microphone capture is unavailable here. Open the demo in Chrome or another browser with microphone support.");
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  },
};
const message = (error: unknown) => {
  const name = error instanceof Error ? error.name : "";
  if (["NotAllowedError", "SecurityError"].includes(name))
    return "Microphone permission was denied. Allow it in browser permissions, then try Mic again.";
  if (name === "NotFoundError") return "No microphone was found. Connect one, then try Mic again.";
  if (name === "NotReadableError") return "The microphone could not be opened. Check that another app is not blocking it.";
  return error instanceof Error ? error.message : "Microphone capture failed.";
};

/** Audio stays in the browser. No recorder, network destination or speaker connection. */
export class MicrophoneInput {
  snapshot: MicrophoneSnapshot = { status: "off", analyser: null, error: "" };
  private generation = 0;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private cancelRequest: (() => void) | null = null;
  constructor(private changed: (value: MicrophoneSnapshot) => void, private host = browserHost) {}
  private emit(status: MicrophoneStatus, analyser: AnalyserNode | null = null, error = "") {
    this.snapshot = { status, analyser, error };
    this.changed(this.snapshot);
  }
  private release() {
    this.source?.disconnect(); this.source = null;
    const stream = this.stream; this.stream = null;
    stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    const context = this.context; this.context = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }
  stop() {
    this.generation++;
    this.cancelRequest?.();
    this.cancelRequest = null;
    this.release();
    this.emit("off");
  }
  async start() {
    if (["live", "requesting"].includes(this.snapshot.status)) return;
    const token = ++this.generation;
    this.emit("requesting");
    let context: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new Error("Microphone request cancelled.")); });
    this.cancelRequest = cancel;
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("No microphone permission response yet. Allow the browser microphone prompt, then try Mic again.")), 30000); });
    try {
      // Resume on the user's click/key gesture, before the asynchronous permission prompt.
      context = this.host.createContext();
      this.context = context;
      const resumed = context.resume().then(() => null, error => error);
      const pendingStream = this.host.getStream().then(value => {
        if (token !== this.generation) value.getTracks().forEach(track => track.stop());
        return value;
      });
      stream = await Promise.race([pendingStream, cancelled, deadline]);
      if (token !== this.generation) {
        return;
      }
      this.stream = stream;
      const resumeError = await Promise.race([resumed, cancelled, deadline]);
      if (resumeError) throw resumeError;
      if (token !== this.generation) return;
      if (context.state !== "running") throw new Error("Browser audio is paused. Turn Mic off and on to resume it.");
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(analyser);
      stream.getAudioTracks().forEach(track => {
        track.onended = () => {
          if (token !== this.generation) return;
          this.generation++;
          this.release();
          this.emit("error", null, "Microphone disconnected. Turn Mic on again to reconnect.");
        };
      });
      this.emit("live", analyser);
    } catch (error) {
      if (token !== this.generation) return;
      this.generation++;
      this.release();
      this.emit("error", null, message(error));
    } finally {
      clearTimeout(timeout!);
      if (this.cancelRequest === cancel) this.cancelRequest = null;
    }
  }
}

export function microphoneLevels(samples: Float32Array, barCount = 65) {
  const levels = new Float32Array(barCount);
  let power = 0;
  for (const sample of samples) power += sample * sample;
  const rms = Math.sqrt(power / Math.max(1, samples.length));
  // A real silence frame must remain flat; no artificial movement or minimum pulse.
  if (rms < .002) return { rms, levels };
  for (let bar = 0; bar < barCount; bar++) {
    const start = Math.floor(bar * samples.length / barCount);
    const end = Math.max(start + 1, Math.floor((bar + 1) * samples.length / barCount));
    let energy = 0;
    for (let i = start; i < end && i < samples.length; i++) energy += samples[i] ** 2;
    levels[bar] = Math.min(1, Math.sqrt(energy / (end - start)) * 7);
  }
  return { rms, levels };
}
