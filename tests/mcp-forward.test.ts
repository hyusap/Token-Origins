import { expect, test } from "bun:test";
import { forwardTool } from "../scripts/mcp-forward";
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
