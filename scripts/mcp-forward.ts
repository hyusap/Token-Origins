import { SEMANTIC_API_VERSION } from "../server/runtime";
import type { ToolResult } from "../shared/types";

export async function forwardTool(backend: string, name: string, args: Record<string, unknown>, request = fetch): Promise<Omit<ToolResult, "state"> & { state?: ToolResult["state"] }> {
  // An old backend's Zod schema silently strips tokens. Detect that before any discovery.
  if (name === "discover_objects") {
    const response = await request(`${backend}/api/health`, { signal: AbortSignal.timeout(5000) });
    const health = await response.json() as any;
    if (!response.ok || health.runtime?.semanticApiVersion !== SEMANTIC_API_VERSION) {
      return { ok: false, code: "BACKEND_VERSION_MISMATCH", summary: "Discovery was not performed.",
        error: `Backend does not support semantic API ${SEMANTIC_API_VERSION}. Restart the parent project's backend with bun run server; token arguments must not be silently ignored.` };
    }
  }
  const response = await request(`${backend}/api/tools/${name}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(args), signal: AbortSignal.timeout(30000),
  });
  return await response.json() as ToolResult;
}
