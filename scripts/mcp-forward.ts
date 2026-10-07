import { SEMANTIC_API_VERSION } from "../server/runtime";
import type { ToolResult } from "../shared/types";

/** Never let obsolete backends strip source networks or execute old policy semantics. */
export const VERSIONED_TOOLS = new Set([
  "discover_objects", "read_price_feed", "list_price_feeds", "compose_graph",
  "patch_workflow", "undo_revision", "run_workflow", "describe_policy", "navigate_canvas",
  "get_capabilities", "inspect_solana_wallet", "get_solana_devnet_wallet",
  "transfer_solana_devnet", "activate_policy", "deactivate_policy", "get_monitors", "reconcile_policy",
  "list_evm_trade_venues", "get_evm_trade_wallet", "inspect_evm_swap", "inspect_evm_wallet_swaps",
  "quote_evm_copy_swap", "copy_evm_swap", "reconcile_evm_copy_swap",
  "activate_evm_trade_watch", "get_evm_trade_watches", "deactivate_evm_trade_watch", "reconcile_evm_trade_watch",
  "list_sources", "read_source", "list_recipes", "apply_recipe", "watch_policy", "stop_watching",
]);

export async function forwardTool(backend: string, name: string, args: Record<string, unknown>, request = fetch): Promise<Omit<ToolResult, "state"> & { state?: ToolResult["state"] }> {
  if (VERSIONED_TOOLS.has(name)) {
    const response = await request(`${backend}/api/health`, { signal: AbortSignal.timeout(5000) });
    const health = await response.json() as any;
    if (response.ok && health.runtime?.semanticApiVersion === SEMANTIC_API_VERSION && name === "run_workflow" && args.evaluationOnly === true && health.runtime?.supports?.evaluationOnly !== true) {
      return { ok: false, code: "EVALUATION_ONLY_UNSUPPORTED", summary: "CRE evaluation was not started.",
        error: "Backend does not advertise immutable evaluation-only authority. Restart the backend; evaluationOnly must never be ignored or replaced with broadcast." };
    }
    if (!response.ok || health.runtime?.semanticApiVersion !== SEMANTIC_API_VERSION) {
      return { ok: false, code: "BACKEND_VERSION_MISMATCH", summary: `${name === "discover_objects" ? "Discovery" : name} was not performed.`,
        error: `Backend does not support semantic API ${SEMANTIC_API_VERSION} (reports ${health.runtime?.semanticApiVersion ?? "none"}). Restart the parent project's backend with bun run server; arguments must not be silently ignored.` };
    }
  }
  const response = await request(`${backend}/api/tools/${name}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
    // Real Solana confirmation can take 45 seconds before receipt inspection.
    signal: AbortSignal.timeout(["transfer_solana_devnet", "inspect_solana_wallet", "copy_evm_swap"].includes(name) ? 90000 : 30000),
  });
  return await response.json() as ToolResult;
}
