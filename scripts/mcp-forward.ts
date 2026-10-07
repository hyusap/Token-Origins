import { SEMANTIC_API_VERSION } from "../server/runtime";
import type { ToolResult } from "../shared/types";

/**
 * Tools whose arguments or meaning changed across semantic versions. An older
 * backend's Zod schema would silently strip new fields (tokens, feed networks)
 * or execute with old run semantics, so these check the backend first.
 */
export const VERSIONED_TOOLS = new Set(["discover_objects", "read_price_feed", "compose_graph", "patch_workflow", "undo_revision", "run_workflow", "describe_policy",
  "list_sources", "read_source", "list_recipes", "apply_recipe", "watch_policy", "stop_watching"]);

export async function forwardTool(backend: string, name: string, args: Record<string, unknown>, request = fetch): Promise<Omit<ToolResult, "state"> & { state?: ToolResult["state"] }> {
  if (VERSIONED_TOOLS.has(name)) {
    const response = await request(`${backend}/api/health`, { signal: AbortSignal.timeout(5000) });
    const health = await response.json() as any;
    if (!response.ok || health.runtime?.semanticApiVersion !== SEMANTIC_API_VERSION) {
      const action = name === "discover_objects" ? "Discovery" : `${name}`;
      return { ok: false, code: "BACKEND_VERSION_MISMATCH", summary: `${action} was not performed.`,
        error: `Backend does not support semantic API ${SEMANTIC_API_VERSION} (it reports ${health.runtime?.semanticApiVersion ?? "none"}). Restart the parent project's backend with bun run server; arguments must not be silently ignored.` };
    }
  }
  const response = await request(`${backend}/api/tools/${name}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(args), signal: AbortSignal.timeout(30000),
  });
  return await response.json() as ToolResult;
}
