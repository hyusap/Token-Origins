import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toolDefinitions } from "../server/schemas";
import { SEMANTIC_API_VERSION } from "../server/runtime";
import { emptyState } from "../server/engine";

test("official MCP stdio schema and HTTP forwarding preserve tokens and refuse obsolete backends", async () => {
  let compatible = false;
  const forwarded: unknown[] = [];
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/health")
      return Response.json({ ok: true, ...(compatible ? { runtime: { semanticApiVersion: SEMANTIC_API_VERSION } } : {}) });
    const args = toolDefinitions.discover_objects.schema.parse(await request.json());
    forwarded.push(args);
    return Response.json({ ok: true, summary: "Discovered requested prices.", state: emptyState() });
  } });
  const transport = new StdioClientTransport({
    command: Bun.which("bun")!, args: [new URL("../scripts/mcp.ts", import.meta.url).pathname],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), ORIGINS_BACKEND_URL: `http://127.0.0.1:${backend.port}` },
    stderr: "pipe",
  });
  const client = new Client({ name: "discovery-regression", version: "1" });
  try {
    await client.connect(transport);
    const definition = (await client.listTools()).tools.find(tool => tool.name === "discover_objects")!;
    expect(definition.inputSchema.properties).toHaveProperty("tokens");
    const rejected = await client.callTool({ name: "discover_objects", arguments: { objects: ["price"], tokens: ["Solana", "Bitcoin"], operationId: "old" } });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({ code: "BACKEND_VERSION_MISMATCH" });
    expect(forwarded).toHaveLength(0);
    compatible = true;
    for (const tokens of [["Solana", "Bitcoin"], ["SOL", "BTC"], ["coinbase:SOL-USD", "coinbase:BTC-USD"], undefined]) {
      const args = { objects: ["price"], ...(tokens ? { tokens } : {}), operationId: crypto.randomUUID() };
      const result = await client.callTool({ name: "discover_objects", arguments: args });
      expect(result.isError).toBe(false);
      expect(forwarded.at(-1)).toEqual(args);
    }
  } finally {
    await client.close();
    backend.stop(true);
  }
}, 15000);
