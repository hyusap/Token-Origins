import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { publicToolDefinitions } from "../server/schemas";
import { compactMcpResult } from "./mcp-compact";
import { forwardTool } from "./mcp-forward";
const backend = process.env.ORIGINS_BACKEND_URL || "http://127.0.0.1:4318";
const server = new McpServer({ name: "origins-canvas", version: "1.3.0" });
for (const [name, definition] of Object.entries(publicToolDefinitions)) {
  // Caption publication belongs to the transport, not the semantic agent.
  if (name === "submit_utterance" || name === "set_activity") continue;
  server.registerTool(
    name,
    {
      description: definition.description,
      inputSchema: definition.schema.shape,
    },
    async (args: Record<string, unknown>) => {
      try {
        const result = compactMcpResult(await forwardTool(backend, name, args), name, args);
        return {
          content: [
            {
              type: "text" as const,
              // Text-only MCP clients must receive the same authoritative state as
              // structured-content clients, including revisions and evidence.
              text: JSON.stringify(result),
            },
          ],
          structuredContent: result,
          isError: !result.ok,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const recovery = name === "copy_evm_swap"
          ? `The copy outcome may be unknown. Read reconcile_evm_copy_swap with copyOperationId ${args.operationId}. Never create a new operation ID or change the original parameters to recover this request.`
          : name === "transfer_solana_devnet"
          ? `The transfer outcome may be unknown. Recover only by retrying the identical recipient and amount with operationId ${args.operationId}; never create a new transfer to recover this request.`
          : "Start bun run server, then retry the same operation ID if this was a mutation.";
        return {
          content: [
            {
              type: "text" as const,
              text: `Canvas backend unavailable: ${detail}. ${recovery}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
await server.connect(new StdioServerTransport());
