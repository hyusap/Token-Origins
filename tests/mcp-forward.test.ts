import { expect, test } from "bun:test";
import { forwardTool, VERSIONED_TOOLS } from "../scripts/mcp-forward";
import { SEMANTIC_API_VERSION } from "../server/runtime";
import { emptyState } from "../server/engine";

test("discovery refuses an old runtime before posting arguments that it would strip", async () => {
  const calls: string[] = [];
  const request = (async (url: any) => {
    calls.push(String(url));
    return Response.json({ ok: true, service: "Origins canvas" });
  }) as typeof fetch;
  const result = await forwardTool("http://backend", "discover_objects", { tokens: ["Solana", "Bitcoin"], operationId: "old" }, request);
  expect(result.ok).toBe(false);
  expect(result.code).toBe("BACKEND_VERSION_MISMATCH");
  expect(result.summary).toBe("Discovery was not performed.");
  expect(calls).toEqual(["http://backend/api/health"]);
});

test("graph-changing tools refuse an old backend before posting", async () => {
  for (const name of ["compose_graph", "run_workflow", "patch_workflow"]) {
    const calls: string[] = [];
    const request = (async (url: any) => {
      calls.push(String(url));
      return Response.json({ ok: true, runtime: { semanticApiVersion: SEMANTIC_API_VERSION - 1 } });
    }) as typeof fetch;
    const result = await forwardTool("http://backend", name, { expectedRevision: 0, operationId: "old" }, request);
    expect(result.code).toBe("BACKEND_VERSION_MISMATCH");
    expect(calls).toEqual(["http://backend/api/health"]);
  }
});

test("read-only focus tools forward without a version round trip", async () => {
  const calls: string[] = [];
  const request = (async (url: any) => { calls.push(String(url)); return Response.json({ ok: true, summary: "Focused", state: emptyState() }); }) as typeof fetch;
  await forwardTool("http://backend", "focus_object", { reference: "price", operationId: "f" }, request);
  expect(calls).toEqual(["http://backend/api/tools/focus_object"]);
});

test("MCP forwards names, symbols, qualified IDs and omitted-token default unchanged", async () => {
  for (const tokens of [["Solana", "Bitcoin"], ["SOL", "BTC"], ["coinbase:SOL-USD", "coinbase:BTC-USD"], undefined]) {
    const args = { objects: ["price"], ...(tokens ? { tokens } : {}), operationId: "forward" };
    const calls: string[] = [];
    const request = (async (url: any, options: any) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/health")) return Response.json({ runtime: { semanticApiVersion: SEMANTIC_API_VERSION } });
      expect(JSON.parse(options.body)).toEqual(args);
      return Response.json({ ok: true, summary: "Discovered requested prices.", state: emptyState() });
    }) as typeof fetch;
    expect((await forwardTool("http://backend", "discover_objects", args, request)).ok).toBe(true);
    expect(calls).toEqual(["http://backend/api/health", "http://backend/api/tools/discover_objects"]);
  }
});


test("policy, source, utility and monitoring tools refuse obsolete semantic runtimes before any write", async () => {
  for (const name of VERSIONED_TOOLS) {
    const calls: string[] = [];
    const request = (async (url: any) => { calls.push(String(url)); return Response.json({ runtime: { semanticApiVersion: SEMANTIC_API_VERSION - 1 } }); }) as typeof fetch;
    const result = await forwardTool("http://backend", name, { network: "ethereum-sepolia", operationId: "obsolete" }, request);
    expect(result.code).toBe("BACKEND_VERSION_MISMATCH");
    expect(result.ok).toBe(false);
    expect(calls).toEqual(["http://backend/api/health"]);
  }
});

test("evaluation-only never reaches a same-version backend that would silently broadcast", async () => {
  let posts = 0;
  let supported = false;
  const request = async (_input: any, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; expect(JSON.parse(String(init.body)).evaluationOnly).toBe(true); return Response.json({ok:true,summary:"evaluation queued"}); }
    return Response.json({runtime:{semanticApiVersion:SEMANTIC_API_VERSION,supports:{evaluationOnly:supported}}});
  };
  const args = {expectedRevision:1,evaluationOnly:true,operationId:"evaluation:immutable"};
  const rejected = await forwardTool("http://backend", "run_workflow", args, request as typeof fetch);
  expect(rejected).toMatchObject({ok:false,code:"EVALUATION_ONLY_UNSUPPORTED"});
  expect(posts).toBe(0);
  supported = true;
  expect((await forwardTool("http://backend","run_workflow",args,request as typeof fetch)).ok).toBe(true);
  expect(posts).toBe(1);
});
