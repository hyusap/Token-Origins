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
      "Fetch real timestamped USD trades for specified tokens and grant vault state. tokens accepts exact asset names (Solana), symbols (SOL), or exchange-qualified IDs (coinbase:SOL-USD). Coverage is online Coinbase USD markets; ambiguous or unsupported assets fail honestly. Omitted tokens defaults to ETH. Multiple tokens create separate objects. The grant-vault policy remains explicitly ETH/USD. Objects persist as workflow inputs. Vault provenance states actual chain or fixture.",
    schema: z.object({
      objects: z.array(z.enum(["price", "vault"])).default(["price", "vault"]),
      tokens: z.array(z.string().trim().min(1).max(120)).min(1).max(12).optional(),
      operationId: op,
    }),
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
      "Compose or revise the ETH/USD grant-vault policy using persistent ETH price and vault inputs. Other discovered token prices are independent observations, not this policy’s trigger. thresholdAboveCurrent fetches real price then sets threshold 5% above it. Never edits running versions. Execution always retains a freshness cap and an already-paused no-op guard, even after removing their optional graph nodes; disclose this when relevant.",
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
