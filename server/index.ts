import { Engine } from "./engine";
import { toolDefinitions } from "./schemas";
import { command } from "./command";
import { requestAccess } from "./access";
import { resolve, sep } from "node:path";
const engine = new Engine();
let bridgePromise: Promise<any> | undefined;
async function bridge() {
  bridgePromise ??= import("../scripts/agent").then(({ createAgentBridge }) =>
    createAgentBridge({
      serverUrl: `http://127.0.0.1:${process.env.PORT || 4318}`,
      rootDir: process.cwd(),
    }),
  );
  return bridgePromise;
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 4318),
  idleTimeout: 120,
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
          sessionId: engine.state.sessionId,
          seq: engine.state.seq,
        });
      if (url.pathname === "/api/state") return json(engine.context());
      if (url.pathname === "/api/tools")
        return json(
          Object.fromEntries(
            Object.entries(toolDefinitions).map(([k, v]) => [k, v.description]),
          ),
        );
      if (url.pathname.startsWith("/api/tools/") && request.method === "POST") {
        const name = url.pathname.slice("/api/tools/".length);
        const definition =
          toolDefinitions[name as keyof typeof toolDefinitions];
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
