import { test, expect } from "bun:test";
import { MicrophoneInput, microphoneLevels } from "../src/microphone";
function harness(streamPromise?: Promise<MediaStream>) {
  const track = { onended: null as (() => void) | null, stops: 0, stop() { this.stops++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const analyser = { fftSize: 0 } as AnalyserNode;
  const source = { connections: [] as unknown[], connect(node: unknown) { this.connections.push(node); }, disconnect() {} };
  const context = { state: "running", closes: 0, async resume() {}, async close() { this.closes++; this.state = "closed"; }, createAnalyser: () => analyser, createMediaStreamSource: () => source };
  const changes: string[] = [];
  const mic = new MicrophoneInput(s => changes.push(s.status), {
    createContext: () => context as unknown as AudioContext,
    getStream: () => streamPromise || Promise.resolve(stream),
  });
  return { mic, changes, context, track, stream, source, analyser };
}
test("microphone opens an analyser without speaker output and releases all resources", async () => {
  const h = harness();
  await h.mic.start(); await h.mic.start();
  expect(h.changes).toEqual(["requesting", "live"]);
  expect(h.analyser.fftSize).toBe(2048);
  expect(h.source.connections).toEqual([h.analyser]);
  h.mic.stop();
  expect(h.track.stops).toBe(1); expect(h.context.closes).toBe(1);
  expect(h.mic.snapshot.analyser).toBeNull(); expect(h.mic.snapshot.status).toBe("off");
});
test("cancelled permission request stops a stream that arrives late", async () => {
  let resolve!: (stream: MediaStream) => void;
  const h = harness(new Promise(r => resolve = r));
  const pending = h.mic.start();
  h.mic.stop(); resolve(h.stream); await pending;
  expect(h.track.stops).toBe(1); expect(h.mic.snapshot.status).toBe("off");
  expect(h.changes).not.toContain("live");
});
test("denied permission closes context and reports a recoverable error", async () => {
  const h = harness(Promise.reject(new DOMException("denied", "NotAllowedError")));
  await h.mic.start();
  expect(h.mic.snapshot.status).toBe("error"); expect(h.mic.snapshot.error).toContain("permission was denied");
  expect(h.context.closes).toBe(1);
});
test("device disconnection stops capture instead of claiming live input", async () => {
  const h = harness(); await h.mic.start(); h.track.onended?.();
  expect(h.mic.snapshot.status).toBe("error"); expect(h.mic.snapshot.error).toContain("disconnected");
  expect(h.track.stops).toBe(1);
});
test("real sample levels are zero for silence and bounded for voiced/clipped input", () => {
  const silence = microphoneLevels(new Float32Array(2048));
  expect(silence.rms).toBe(0); expect([...silence.levels].every(n => n === 0)).toBe(true);
  const quiet = microphoneLevels(new Float32Array(2048).fill(.0001));
  expect([...quiet.levels].every(n => n === 0)).toBe(true);
  const voice = microphoneLevels(Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i * .2) * .12));
  expect(voice.rms).toBeGreaterThan(.08); expect(Math.max(...voice.levels)).toBeGreaterThan(.5);
  const clipped = microphoneLevels(new Float32Array(2048).fill(2));
  expect([...clipped.levels].every(n => n === 1)).toBe(true);
});
