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
    const definitions = (await client.listTools()).tools;
    expect(definitions.some(tool => tool.name === "get_capabilities")).toBe(true);
    expect(definitions.some(tool => tool.name === "activate_policy")).toBe(true);
    expect(definitions.some(tool => tool.name === "reconcile_policy")).toBe(true);
    expect(definitions.find(tool => tool.name === "read_price_feed")!.inputSchema.properties).toHaveProperty("network");
    expect(definitions.some(tool => tool.name === "inspect_solana_wallet")).toBe(false);
    expect(definitions.some(tool => tool.name === "transfer_solana_devnet")).toBe(false);
    expect(definitions.some(tool => tool.name === "copy_evm_swap")).toBe(false);
    expect(definitions.some(tool => tool.name === "activate_evm_trade_watch")).toBe(false);
    const graphSchema = definitions.find(tool => tool.name === "compose_graph")!.inputSchema.properties?.graph as Record<string, any>;
    expect(graphSchema.properties.nodes.items).toHaveProperty("anyOf");
    expect(JSON.stringify(graphSchema)).not.toContain("mock-venue");
    expect(JSON.stringify(graphSchema)).not.toContain("solana-transfer");
    const definition = definitions.find(tool => tool.name === "discover_objects")!;
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
      const textResult = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
      expect(textResult.state.workflow.revision).toBe(0);
      expect(textResult).toEqual(result.structuredContent);
      expect(forwarded.at(-1)).toEqual(args);
    }
  } finally {
    await client.close();
    backend.stop(true);
  }
}, 15000);
