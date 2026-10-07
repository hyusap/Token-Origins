import { Engine } from "./engine";
import { publicToolDefinitions } from "./schemas";
import { command } from "./command";
import { requestAccess } from "./access";
import { resolve, sep } from "node:path";
import { runtime } from "./runtime";
import { voiceCapabilities, transcribeAudio, VoiceTranscriptionError } from "./transcribe";
import { creReadiness } from "./cre-status";
const engine = new Engine();
let bridgePromise: Promise<any> | undefined;
async function bridge() {
  bridgePromise ??= import("../scripts/agent").then(({ createAgentBridge }) =>
    createAgentBridge({
      serverUrl: `http://127.0.0.1:${process.env.PORT || 4318}`,
      rootDir: process.cwd(),
      getContext: () => engine.context(),
    }),
  );
  return bridgePromise;
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 4318),
  idleTimeout: 120,
  maxRequestBodySize: 6 * 1024 * 1024,
  async fetch(request, server) {
    const url = new URL(request.url);
    const access = requestAccess(request);
    if (!access.allowed)
      return Response.json(
        { ok: false, error: access.reason },
        { status: 403 },
      );
    const cors = access.corsHeaders;
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: cors });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === "/ws") {
        if (server.upgrade(request)) return;
        return json({ error: "WebSocket upgrade required" }, 400);
      }
      if (url.pathname === "/api/health")
        return json({
          ok: true,
          service: "Origins canvas",
          runtime,
          sessionId: engine.state.sessionId,
          seq: engine.state.seq,
        });
      if (url.pathname === "/api/state") return json(engine.context());
      if (url.pathname === "/api/cre/capabilities" && request.method === "GET")
        return json({ ok: true, ...await creReadiness() });
      if (url.pathname === "/api/voice/capabilities" && request.method === "GET")
        return json({ ok: true, ...await voiceCapabilities() });
      if (url.pathname === "/api/voice/transcribe" && request.method === "POST") {
        try {
          const maximum = 5 * 1024 * 1024;
          const length = Number(request.headers.get("content-length"));
          if (length > 6 * 1024 * 1024)
            return json({ ok: false, error: "Audio upload is too large.", code: "AUDIO_TOO_LARGE" }, 413);
          let bytes: Uint8Array, mimeType: string;
          const type = request.headers.get("content-type") || "";
          if (type.toLowerCase().startsWith("multipart/form-data")) {
            const audio = (await request.formData()).get("audio");
            if (!(audio instanceof File))
              return json({ ok: false, error: "An audio file is required.", code: "AUDIO_REQUIRED" }, 400);
            if (audio.size > maximum)
              return json({ ok: false, error: "Audio upload is too large.", code: "AUDIO_TOO_LARGE" }, 413);
            bytes = new Uint8Array(await audio.arrayBuffer());
            mimeType = audio.type;
          } else {
            const reader = request.body?.getReader();
            if (!reader) return json({ ok: false, error: "Audio is required.", code: "AUDIO_REQUIRED" }, 400);
            const chunks: Uint8Array[] = [];
            let size = 0;
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > maximum) {
                await reader.cancel();
                return json({ ok: false, error: "Audio upload is too large.", code: "AUDIO_TOO_LARGE" }, 413);
              }
              chunks.push(next.value);
            }
            bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            mimeType = type.split(";")[0].trim().toLowerCase();
          }
          return json({ ok: true, ...await transcribeAudio({ bytes, mimeType, signal: request.signal }) });
        } catch (error) {
          if (error instanceof VoiceTranscriptionError)
            return json({ ok: false, error: error.message, code: error.code }, error.status);
          throw error;
        }
      }
      if (url.pathname === "/api/proof" && request.method === "GET") {
        const latest = Bun.file(resolve("demo/sepolia-current-rpc-verification.json"));
        const file = await latest.exists() ? latest : Bun.file(resolve("demo/sepolia-independent-rpc-verification.json"));
        if (!(await file.exists())) return json({ ok: false, error: "No saved public-chain proof is available." }, 404);
        const evidence = await file.json();
        if (evidence.chainId !== 11155111 || evidence.status !== "success" ||
            !/^0x[0-9a-fA-F]{64}$/.test(evidence.transactionHash))
          return json({ ok: false, error: "Saved public-chain proof is invalid." }, 500);
        const source = evidence.evidenceFile || "sepolia-evidence-2026-10-07T07-28-49-635Z.json";
        if (!/^sepolia-evidence-[\dTZ-]+\.json$/.test(source))
          return json({ ok: false, error: "Saved proof source is invalid." }, 500);
        const original = await Bun.file(resolve("demo", source)).json();
        const correlated = original.label === "cre-simulation-sepolia-broadcast" &&
          original.chainId === evidence.chainId &&
          original.pause?.transactionHash?.toLowerCase() === evidence.transactionHash.toLowerCase();
        return json({ ok: true, kind: "saved-public-proof", evidence,
          ...(correlated ? { executionMode: "cre-local-simulation", provenance: "CRE local simulation with Sepolia broadcast; not deployed DON execution." } : {}),
          explorerUrl: `https://sepolia.etherscan.io/tx/${evidence.transactionHash}` });
      }
      if (url.pathname === "/api/tools")
        return json(
          Object.fromEntries(
            Object.entries(publicToolDefinitions).map(([k, v]) => [k, v.description]),
          ),
        );
      if (url.pathname.startsWith("/api/tools/") && request.method === "POST") {
        const name = url.pathname.slice("/api/tools/".length);
        const definition =
          publicToolDefinitions[name as keyof typeof publicToolDefinitions];
        if (!definition) return json({ ok: false, error: "Unknown tool" }, 404);
        const parsed = definition.schema.safeParse(await request.json());
        if (!parsed.success)
          return json(
            {
              ok: false,
              summary: "Invalid semantic tool arguments",
              error: parsed.error.message,
              state: engine.context(),
            },
            400,
          );
        const result = await engine.invoke(name, parsed.data);
        return json(
          result,
          result.ok ? 200 : result.code === "REVISION_CONFLICT" ? 409 : 400,
        );
      }
      if (url.pathname === "/api/command" && request.method === "POST") {
        const body = (await request.json()) as any;
        if (typeof body.text !== "string")
          return json({ ok: false, error: "Text required" }, 400);
        return json(await command(engine, body.text, body.operationId));
      }
      if (url.pathname === "/api/rendered" && request.method === "POST") {
        const body = (await request.json()) as any;
        const row = engine.state.latency.find(
          (x) => x.operationId === body.operationId,
        );
        if (row && !row.renderedAt) {
          row.renderedAt =
            typeof body.renderedAt === "string" &&
            Number.isFinite(Date.parse(body.renderedAt))
              ? body.renderedAt
              : new Date().toISOString();
          row.renderMs = Math.max(
            0,
            Date.parse(row.renderedAt!) - Date.parse(row.committedAt),
          );
          engine.store.save(engine.state);
        }
        return json({ ok: true });
      }
      if (url.pathname === "/api/canvas/clear" && request.method === "POST") {
        const status = (await bridge()).rehearsalStatus();
        if (status.busy || status.running)
          return json({ ok: false, error: "Stop the demo and let the active agent turn finish before clearing the canvas." }, 409);
        const name = "reset_session";
        const parsed = publicToolDefinitions[name].schema.safeParse(await request.json());
        if (!parsed.success) return json({ ok: false, error: "Invalid canvas operation." }, 400);
        const result = await engine.invoke(name, parsed.data);
        return json(result, result.ok ? 200 : 409);
      }
      if (url.pathname === "/api/agent" && request.method === "POST") {
        const body = (await request.json()) as any;
        if (typeof body.text !== "string" || !body.text.trim())
          return json({ ok: false, error: "Text required" }, 400);
        return json(await (await bridge()).submitAgentPrompt(body.text));
      }
      if (url.pathname === "/api/rehearsal/start" && request.method === "POST")
        return json(
          await (await bridge()).startRehearsal(await request.json()),
        );
      if (url.pathname === "/api/rehearsal/stop" && request.method === "POST")
        return json(await (await bridge()).stopRehearsal());
      if (url.pathname === "/api/rehearsal/next" && request.method === "POST")
        return json(await (await bridge()).nextRehearsalCue());
      if (url.pathname === "/api/rehearsal/status")
        return json(await (await bridge()).rehearsalStatus());
      if (url.pathname.startsWith("/api/"))
        return json({ ok: false, error: "API route not found" }, 404);
      const root = resolve("dist");
      const candidate = resolve(root, "." + decodeURIComponent(url.pathname));
      if (candidate === root || candidate.startsWith(root + sep)) {
        const file = Bun.file(candidate);
        if (await file.exists()) return new Response(file);
        const index = Bun.file(resolve(root, "index.html"));
        if (await index.exists()) return new Response(index);
      }
      return new Response(
        "Origins backend ready. Start the frontend with bun run dev.",
        { status: 200 },
      );
    } catch (error) {
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  },
  websocket: {
    open(ws) {
      ws.subscribe("canvas");
      ws.send(JSON.stringify({ type: "state", state: engine.context() }));
    },
    message(ws, message) {
      try {
        const body = JSON.parse(String(message));
        if (body.type === "ping")
          ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
      } catch {}
    },
    close() {},
  },
});
engine.listeners.add((state) =>
  server.publish("canvas", JSON.stringify({ type: "state", state })),
);
console.log(`Origins semantic canvas backend: http://127.0.0.1:${server.port}`);
