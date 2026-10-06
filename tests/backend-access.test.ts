import { test, expect } from "bun:test";
import { requestAccess } from "../server/access";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";

test("HTTP boundary rejects hostile browser origins and hosts while allowing frontend and CLI semantic reads", async () => {
  const engine = new Engine(new StateStore(":memory:"));
  let semanticCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const access = requestAccess(request);
      if (!access.allowed)
        return Response.json({ error: access.reason }, { status: 403 });
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: access.corsHeaders });
      if (new URL(request.url).pathname === "/api/tools/get_context") {
        semanticCalls++;
        return Response.json(await engine.invoke("get_context"), {
          headers: access.corsHeaders,
        });
      }
      return Response.json(engine.context(), { headers: access.corsHeaders });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const hostile = await fetch(`${base}/api/tools/get_context`, {
      method: "POST",
      headers: { Origin: "https://unrelated.example" },
    });
    expect(hostile.status).toBe(403);
    expect(hostile.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(semanticCalls).toBe(0);
    const hostileSocket = await fetch(`${base}/ws`, {
      headers: { Origin: "https://unrelated.example" },
    });
    expect(hostileSocket.status).toBe(403);
    const rebinding = await fetch(`${base}/api/state`, {
      headers: { Host: "unrelated.example", Origin: "http://127.0.0.1:5173" },
    });
    expect(rebinding.status).toBe(403);
    const allowed = await fetch(`${base}/api/state`, {
      headers: { Origin: "http://127.0.0.1:5173" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://127.0.0.1:5173",
    );
    const preflight = await fetch(`${base}/api/tools/get_context`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
    const cli = await fetch(`${base}/api/tools/get_context`, {
      method: "POST",
    });
    expect(cli.status).toBe(200);
    expect((await cli.json()).ok).toBe(true);
    expect(semanticCalls).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("configured backend port is an allowed browser origin", () => {
  expect(
    requestAccess(
      new Request("http://127.0.0.1:4418/api/state", {
        headers: { Origin: "http://localhost:4418" },
      }),
      4418,
    ).allowed,
  ).toBe(true);
  expect(
    requestAccess(
      new Request("http://127.0.0.1:4418/api/state", {
        headers: { Origin: "http://localhost:9999" },
      }),
      4418,
    ).allowed,
  ).toBe(false);
});
