import { z } from "zod";
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
      "Read persistent canvas, conversational focus, current draft revision and immutable runs. Call before editing or resolving ambiguous references.",
    schema: z.object({}),
  },
  discover_objects: {
    description:
      "Fetch real timestamped ETH/USD trades and grant vault state. Objects persist as workflow inputs. Vault provenance states actual chain or fixture.",
    schema: z.object({
      objects: z.array(z.enum(["price", "vault"])).default(["price", "vault"]),
      operationId: op,
    }),
  },
  read_price_feed: {
    description:
      "Read a live Chainlink Data Feed price for an asset such as BTC, ETH, SOL or LINK. This is an on-chain oracle read from Ethereum mainnet, not a web search and not an exchange API. Accepts a ticker or a name (BTC, bitcoin, SOL). Feeds publish on a deviation threshold or heartbeat, so the answer can be minutes or hours old; the reported age is part of the answer and must not be described as the current spot price. Reference only: the vault's execution price stays on the live Coinbase ETH/USD trade source.",
    schema: z.object({
      symbol: z
        .string()
        .min(1)
        .max(40)
        .describe("Ticker or asset name, e.g. BTC, bitcoin, SOL, LINK."),
      operationId: op,
    }),
  },
  list_price_feeds: {
    description:
      "List every asset with a configured Chainlink mainnet feed. Call this before telling anyone an asset is unavailable.",
    schema: z.object({}),
  },
  focus_object: {
    description:
      "Set semantic conversational focus. this/it resolves to current focused object. reference accepts price, vault, source, workflow, back, object IDs, condition, run:<runId>, or a raw run ID. Existing runs are focused without executing again. pin keeps object visible.",
    schema: z.object({
      reference: z.string(),
      pin: z.boolean().optional(),
      operationId: op,
    }),
  },
  inspect_object: {
    description:
      "Inspect a named or focused object. Refresh fetches actual live data. Use reference workflow to frame the whole readable rule.",
    schema: z.object({
      reference: z.string().default("this"),
      refresh: z.boolean().optional(),
      operationId: op,
    }),
  },
  patch_workflow: {
    description:
      "Compose or revise bounded policy using persistent price and vault inputs. thresholdAboveCurrent fetches real price then sets threshold 5% above it. Never edits running versions. Execution always retains a freshness cap and an already-paused no-op guard, even after removing their optional graph nodes; disclose this when relevant.",
    schema: z.object({
      expectedRevision: revision,
      patch: z.object({
        threshold: z.number().positive().max(1e7).optional(),
        thresholdAboveCurrent: z.boolean().optional(),
        maxAgeSeconds: z.number().int().min(1).max(120).nullable().optional(),
        skipPaused: z.boolean().optional(),
      }),
      reason: z.string().optional(),
      operationId: op,
    }),
  },
  compose_graph: {
    description:
      "Replace the policy with a composed condition graph, as a new revision. Nodes are an allowlisted vocabulary: price (an exchange trade or a Chainlink feed), compare, freshness, vault-paused, and and/or/not. Use this for any rule a single threshold cannot express, such as combining two assets. The reported on-chain observation is always the exchange trade, so a Chainlink feed branch may decide a policy even when that feed is older than the receiver's freshness cap. Execution still retains that cap and the already-paused no-op whether or not the graph expresses them, and the only action remains pausing the vault.",
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
      reason: z.string().optional(),
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
      "Freeze current revision and start execution asynchronously. Returns run ID promptly. Repeated execution of a revision returns original run; no duplicate action.",
    schema: z.object({ expectedRevision: revision, operationId: op }),
  },
  get_run: {
    description:
      "Inspect execution inputs, decisions, logs and verified transaction evidence. Missing runId returns latest run.",
    schema: z.object({ runId: z.string().optional() }),
  },
  submit_utterance: {
    description:
      "Record the planned or spoken utterance as a visible caption. This does not interpret text or mutate the workflow; use semantic tools next.",
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
      prompt: z.string().optional(),
      summary: z.string().optional(),
      operationId: op,
    }),
  },
  reset_session: {
    description:
      "Clear visible canvas and conversation. Does not change actual contract state. Running executions prevent reset.",
    schema: z.object({ operationId: op }),
  },
} as const;
