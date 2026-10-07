import { z } from "zod";
import { NETWORK_IDS } from "../cre/graph";
const op = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Stable operation ID. Reuse only to retry the exact same operation.",
  );
const revision = z
  .number()
  .int()
  .nonnegative()
  .describe(
    "Current draft revision from get_context. Delayed writes are rejected.",
  );
export const toolDefinitions = {
  get_context: {
    description:
      "Read persistent canvas, focus, current draft revision and immutable runs when no reliable state is available. Reuse state supplied by the transport or returned by prior tools; do not refetch every turn. Refresh after a session change, outside changes, or revision conflict.",
    schema: z.object({}),
  },
  discover_objects: {
    description:
      "Fetch real timestamped USD trades for specified tokens and grant vault state. tokens accepts exact asset names (Solana), symbols (SOL), or exchange-qualified IDs (coinbase:SOL-USD). Coverage is online Coinbase USD markets; ambiguous or unsupported assets fail honestly. Omitted tokens defaults to ETH. Multiple tokens create separate objects. The grant-vault policy remains explicitly ETH/USD. Objects persist as workflow inputs. Vault provenance states actual chain or fixture.",
    schema: z.object({
      objects: z.array(z.enum(["price", "vault"])).default(["price", "vault"]),
      tokens: z.array(z.string().trim().min(1).max(120)).min(1).max(12).optional(),
      operationId: op,
    }).strict(),
  },
  read_price_feed: {
    description:
      "Read a live Chainlink Data Feed price for an asset such as BTC, ETH, SOL or LINK. This is an on-chain oracle read (Ethereum mainnet by default, or Sepolia), not a web search and not an exchange API. Accepts a ticker or a name (BTC, bitcoin, SOL). Feeds publish on a deviation threshold or heartbeat, so the answer can be minutes or hours old; the reported age is part of the answer and must not be described as the current spot price. A composed policy can use the same feed as a condition input.",
    schema: z.object({
      symbol: z
        .string()
        .min(1)
        .max(40)
        .describe("Ticker or asset name, e.g. BTC, bitcoin, SOL, LINK."),
      network: z.enum(NETWORK_IDS).optional().describe("ethereum-mainnet (default) or ethereum-sepolia."),
      operationId: op,
    }),
  },
  list_price_feeds: {
    description:
      "List every asset with a configured Chainlink feed, on mainnet and on Sepolia. Call this before telling anyone an asset is unavailable.",
    schema: z.object({}),
  },
  focus_object: {
    description:
      "Set semantic conversational focus. this/it resolves to current focused object. reference accepts price, vault, source, workflow, back, object IDs, condition, run:<runId>, or a raw run ID. Existing runs are focused without executing again. pin keeps object visible.",
    schema: z.object({
      reference: z.string().max(200),
      pin: z.boolean().optional(),
      operationId: op,
    }),
  },
  inspect_object: {
    description:
      "Inspect a named or focused object. Refresh fetches actual live data. Use reference workflow to frame the whole readable rule.",
    schema: z.object({
      reference: z.string().max(200).default("this"),
      refresh: z.boolean().optional(),
      operationId: op,
    }),
  },
  patch_workflow: {
    description:
      "Compose or revise the ETH/USD grant-vault policy using persistent ETH price and vault inputs. Other discovered token prices are independent observations, not this policy’s trigger. thresholdAboveCurrent fetches real price then sets threshold 5% above it. Never edits running versions. Execution always retains a freshness cap and an already-paused no-op guard, even after removing their optional graph nodes; disclose this when relevant.",
    schema: z.object({
      expectedRevision: revision,
      patch: z.object({
        threshold: z.number().positive().max(1e7).optional(),
        thresholdAboveCurrent: z.boolean().optional(),
        maxAgeSeconds: z.number().int().min(1).max(120).nullable().optional(),
        skipPaused: z.boolean().optional(),
      }),
      reason: z.string().max(500).optional(),
      operationId: op,
    }),
  },
  compose_graph: {
    description:
      "Replace the policy with a composed condition graph, as a new revision. Nodes are an allowlisted vocabulary: price (the Coinbase ETH-USD trade, or a Chainlink feed with an optional network, default ethereum-mainnet), compare, freshness, vault-paused, and and/or/not. Every node must be connected to the root, and a policy may read at most 5 distinct sources. Use this for any rule a single threshold cannot express, such as combining two assets or nesting AND/OR/NOT. Node ids and order do not matter: the revision gets a structural policy hash that the on-chain pause event repeats. Execution always enforces each source's own freshness limit (exchange trade ≤ 120s, feeds within their heartbeat) and, for a pause, the already-paused no-op, whether or not the graph expresses them. Actions: pause-vault (real, on-chain), or sell, which is a simulated order that never moves assets and runs only in local rehearsal.",
    schema: z.object({
      expectedRevision: revision,
      graph: z
        .object({
          nodes: z.array(z.record(z.any())).min(1).max(40),
          root: z.string().min(1),
          action: z.record(z.any()),
        })
        .describe(
          'Example: {"nodes":[{"id":"eth","kind":"price","source":{"type":"exchange-trade","pair":"ETH-USD"}},{"id":"btc","kind":"price","source":{"type":"chainlink-feed","symbol":"BTC"}},{"id":"a","kind":"compare","input":"eth","op":"<","value":3000},{"id":"b","kind":"compare","input":"btc","op":"<","value":90000},{"id":"both","kind":"and","inputs":["a","b"]}],"root":"both","action":{"type":"pause-vault"}}',
        ),
      reason: z.string().max(500).optional(),
      operationId: op,
    }),
  },
  describe_policy: {
    description:
      "Read the current policy as one readable sentence plus the sources its execution will fetch. Call before revising so an edit builds on what is actually composed.",
    schema: z.object({}),
  },
  undo_revision: {
    description:
      "Restore the previous composed policy as a new revision. Preserve execution snapshots.",
    schema: z.object({ expectedRevision: revision, operationId: op }),
  },
  run_workflow: {
    description:
      "Freeze current revision and start execution asynchronously. Returns run ID promptly. Retrying with the same operationId returns the original result. While this revision is still executing, a new request joins that run. After it finishes, an explicit new request starts a fresh run with fresh inputs; the vault's already-paused guard still prevents a second pause. Refused while a run interrupted by a restart has an unknown outcome.",
    schema: z.object({ expectedRevision: revision, operationId: op }),
  },
  get_run: {
    description:
      "Inspect execution inputs, decisions, logs and verified transaction evidence. Missing runId returns latest run.",
    schema: z.object({ runId: z.string().optional() }),
  },
  submit_utterance: {
    description:
      "Record the user's actual utterance as a visible caption only after completing their requested task. This does not interpret text, change activity, or mutate the workflow. Do not call while still working; skip when the transport owns caption publication.",
    schema: z.object({
      text: z.string().min(1).max(2000),
      source: z.string().optional(),
      operationId: op,
    }),
  },
  set_activity: {
    description:
      "Update conversation activity caption. Do not claim actual voice verification; planned utterance simulation is explicit.",
    schema: z.object({
      status: z.enum([
        "idle",
        "listening",
        "thinking",
        "executing",
        "speaking",
        "error",
      ]),
      prompt: z.string().max(2000).optional(),
      summary: z.string().max(2000).optional(),
      operationId: op,
    }),
  },
  navigate_canvas: {
    description: "Navigate the React Flow spatial canvas by semantic actions: fit the whole rule, zoom in/out, or pan left/right/up/down. Does not change workflow or contract state.",
    schema: z.object({ action: z.enum(["fit", "zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"]), operationId: op }),
  },
  reset_session: {
    description:
      "Clear visible canvas and conversation, saving a restorable session. Does not change contract state. Running executions prevent reset.",
    schema: z.object({ operationId: op, expectedSessionId: z.string().optional() }),
  },
  restore_session: {
    description: "Undo clearing the canvas by restoring the most recent saved session. Only available while the new canvas remains empty; does not execute any workflow or change contract state.",
    schema: z.object({ operationId: op, expectedSessionId: z.string().optional() }),
  },
} as const;
