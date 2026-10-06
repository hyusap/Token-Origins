import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolDefinitions } from "../server/schemas";
import { compactMcpResult } from "./mcp-compact";
import { forwardTool } from "./mcp-forward";
const backend = process.env.ORIGINS_BACKEND_URL || "http://127.0.0.1:4318";
const server = new McpServer({ name: "origins-canvas", version: "1.1.0" });
for (const [name, definition] of Object.entries(toolDefinitions)) {
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
              text: JSON.stringify({
                ok: result.ok,
                summary: result.summary,
                runId: result.runId,
                error: result.error,
                code: result.code,
                duplicate: result.duplicate,
              }),
            },
          ],
          structuredContent: result,
          isError: !result.ok,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Canvas backend unavailable: ${error instanceof Error ? error.message : String(error)}. Start bun run server before calling tools.`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
await server.connect(new StdioServerTransport());
