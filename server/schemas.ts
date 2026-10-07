import { z } from "zod";
import { policyGraphSchema, predicateGraphSchema, NETWORK_IDS, DEFAULT_FEED_NETWORK } from "../cre/graph";
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
const evmReadNetwork = z.enum(["local", "sepolia", "base-sepolia", "monad-testnet", "ethereum"]);
const evmSignNetwork = z.enum(["local", "sepolia", "base-sepolia", "monad-testnet"]);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const transactionHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const rawUint = z.string().max(78).regex(/^[1-9][0-9]*$/).refine(value => /^[0-9]+$/.test(value) && BigInt(value) < 2n ** 256n, "Expected a positive uint256 raw token amount");
const blockNumber = z.string().max(78).regex(/^(?:0|[1-9][0-9]*)$/).refine(value => /^[0-9]+$/.test(value) && BigInt(value) < 2n ** 256n, "Expected a canonical block number");
const tradeOperation = op.max(160).regex(/^[\w:.-]+$/);
const swapSource = { network: evmReadNetwork, venueId: z.string().min(1).max(120), wallet: evmAddress.describe("Public leader wallet; task signer is separate"), transactionHash };
const proportionBps = z.number().int().min(1).max(10000);
const slippageBps = z.number().int().min(1).max(500);
const crePolicyGraphSchema = policyGraphSchema.innerType().extend({ action: z.object({ type: z.literal("pause-vault") }).strict() }).superRefine((graph, context) => {
  const validation = policyGraphSchema.safeParse(graph);
  if (!validation.success) for (const issue of validation.error.issues) context.addIssue(issue);
});
export const toolDefinitions = {
  get_context: {
    description:
      "Read persistent canvas, focus, current draft revision and immutable runs when no reliable state is available. Reuse state supplied by the transport or returned by prior tools; do not refetch every turn. Refresh after a session change, outside changes, or revision conflict.",
    schema: z.object({}),
  },
  get_capabilities: {
    description:
      "Read supported sources, condition nodes, comparisons, limits and actual Chainlink CRE execution readiness. The only product action is a grant-vault pause evaluated and reported through CRE. Direct wallet transfers, standalone copy-trading and signer-based swaps are unavailable because they do not use the implemented CRE authority path. A local CRE simulation is not DON deployment; inspect actual execution mode, receiver/version and receipt evidence.",
    schema: z.object({}).strict(),
  },
  discover_objects: {
    description:
      "Fetch real timestamped USD trades for specified tokens and grant vault state. tokens accepts exact asset names (Solana), symbols (SOL), or exchange-qualified IDs (coinbase:SOL-USD). Coverage is online Coinbase USD markets; ambiguous or unsupported assets fail honestly. Omitted tokens defaults to ETH. Multiple tokens create separate objects. Any exact USD market can be a policy source. Objects persist as workflow inputs. Vault reads require a deployed contract; provenance states the actual chain and address.",
    schema: z.object({
      objects: z.array(z.enum(["price", "vault"])).default(["price", "vault"]),
      tokens: z.array(z.string().trim().min(1).max(120)).min(1).max(12).optional(),
      operationId: op,
    }).strict(),
  },
  read_price_feed: {
    description:
      "Read a live Chainlink Data Feed price for an asset such as BTC, ETH, SOL or LINK. This is an on-chain oracle read from the explicitly selected network, default Ethereum mainnet. Accepts a ticker or a name (BTC, bitcoin, SOL). Feeds publish on a deviation threshold or heartbeat, so the answer can be minutes or hours old; the reported age is part of the answer and must not be described as the current spot price. Network identity is preserved in graph sources, policy hashes and evidence. CRE requires an RPC configured for each selected feed network; never substitute networks.",
    schema: z.object({
      symbol: z
        .string()
        .min(1)
        .max(40)
        .describe("Ticker or asset name, e.g. BTC, bitcoin, SOL, LINK."),
      network: z.enum(NETWORK_IDS).default(DEFAULT_FEED_NETWORK),
      operationId: op,
    }).strict(),
  },
  list_price_feeds: {
    description:
      "List configured Chainlink assets on the requested network; omitted network reports mainnet and Sepolia availability. Call before declaring a source unavailable. SOL has no configured Sepolia feed; preserve an explicit mainnet choice.",
    schema: z.object({ network: z.enum(NETWORK_IDS).optional() }).strict(),
  },
  inspect_solana_wallet: {
    description:
      "Inspect a public Solana wallet balance and recent confirmed signature activity using real RPC reads. Devnet is the default; mainnet-beta is read-only when explicitly requested. Activity alone is not enough to infer trades or profit and does not install copy-trading.",
    schema: z.object({
      address: z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/).describe("Public Solana wallet address; never a private key"),
      network: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
      limit: z.number().int().min(1).max(20).default(10),
      operationId: op,
    }).strict(),
  },
  get_solana_devnet_wallet: {
    description:
      "Read this application's generated devnet signing wallet public address, live balance and network identity. Signing keys are never returned. This wallet is separate from the EVM grant vault. No transfer is submitted by this read.",
    schema: z.object({}).strict(),
  },
  transfer_solana_devnet: {
    description:
      "Submit a real SOL transfer from the application's devnet wallet to an explicitly specified public recipient. Devnet only; no mainnet signing. Requires a positive amount and an authorized transfer request. Returns a confirmed RPC receipt/signature and explorer link; never claim success from an unverified signature. operationId is the durable idempotency key and must not be reused for a different recipient or amount. The same signer backs typed solana-transfer graphs; this direct utility evaluates no price condition and executes no exchange swap.",
    schema: z.object({
      recipient: z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/).describe("Explicit public Solana devnet recipient"),
      amountSol: z.number().positive().max(1).describe("SOL to transfer on devnet; maximum 1 SOL per request"),
      operationId: op,
    }).strict(),
  },
  list_evm_trade_venues: {
    description: "List the actually configured allowlisted V2 router/factory/pair identities, token addresses, networks, code hashes and provenance. Empty registry means trading is unavailable. Ethereum mainnet is read-only. A configured venue is a specific verified pair, not arbitrary router or token coverage.",
    schema: z.object({}).strict(),
  },
  get_evm_trade_wallet: {
    description: "Create or read this application's separate task signing wallet public address and fresh native/token balances at configured venues. Actual token decimals are returned for precise raw-unit conversion. Development/test networks only; no personal wallet or mainnet signing. This read does not fund the wallet, approve tokens or trade.",
    schema: z.object({ network: evmSignNetwork }).strict(),
  },
  inspect_evm_swap: {
    description: "Read and verify a public leader's actual confirmed single-hop swapExactTokensForTokens transaction at the exact configured V2 venue. Checks wallet, router/pair code identity, canonical source block, Swap log, path, input/output and token decimals. Returns immutable source transaction identity; no copy or watcher started. Unsupported routes fail rather than becoming another action.",
    schema: z.object(swapSource).strict(),
  },
  inspect_evm_wallet_swaps: {
    description: "Discover a public wallet's confirmed eligible swaps at a configured V2 pair over a maximum span of 1000 confirmed blocks. Omitted range uses a bounded recent confirmed window. Returns actual source transactions and scan head identity; history is partial, not every trade, token balance, position or profit. Does not authorize copying.",
    schema: z.object({ network: evmReadNetwork, venueId: z.string().min(1).max(120), wallet: evmAddress, fromBlock: blockNumber.optional(), toBlock: blockNumber.optional() }).strict(),
  },
  quote_evm_copy_swap: {
    description: "Inspect the exact confirmed leader swap and get a fresh configured-pool quote for its bounded proportion, capped by maxAmountIn in raw input token units. Returns actual decimals, chosen input, output, minAmountOut and quote block/hash. slippageBps is 1–500. Pool reserves are not an independent price oracle and do not guarantee fair value. No approval or swap submitted.",
    schema: z.object({ ...swapSource, proportionBps, maxAmountIn: rawUint, slippageBps }).strict(),
  },
  copy_evm_swap: {
    description: "Execute an explicitly authorized copy of one verified leader swap using the separate task wallet on an allowlisted development/test V2 venue. Source network, wallet and transaction must be exact; no cross-chain or asset substitution. Use fresh quote minAmountOut and positive raw-token input cap. Signed approval/swap bytes are journaled before broadcast; identical operationId retries recover the same action, never a new copy. Requires funded task wallet and actual receipt, correlated Swap event and token balance deltas before claiming confirmation. Mainnet signing, native-asset routes, multi-hop and generic arbitrary trades are unavailable.",
    schema: z.object({ ...swapSource, network: evmSignNetwork, proportionBps, maxAmountIn: rawUint, minAmountOut: rawUint, deadlineSeconds: z.number().int().min(30).max(300).default(120), operationId: tradeOperation }).strict(),
  },
  reconcile_evm_copy_swap: {
    description: "Read actual journal, canonical receipt and swap evidence for copyOperationId without signing or broadcasting. Distinguish confirmed, failed, unresolved and pending-approval-or-preflight. Recovery never invents a receipt or starts a second operation; same original copy parameters and ID are required for an authorized retry.",
    schema: z.object({ copyOperationId: tradeOperation }).strict(),
  },
  activate_evm_trade_watch: {
    description: "Explicitly activate bounded following of future confirmed leader swaps at one configured V2 pair and frozen token direction. Freeze network/genesis, router/code/pair and task signer. Require raw per-trade/cumulative input caps, proportion, slippage and maximum attempts; raw budgets apply only to the chosen input token. startBlock next starts after the observed head and does not silently backfill. Optional typed predicate reuses real price/oracle/boolean conditions and freshness; an explicit vault predicate needs its frozen target. Backend-local scheduler only; restarts pause jobs or mark unknown attempts uncertain. Reservations include attempts, not only successful trades; uncertain outcomes block new signing authority. Requires explicit user authorization to follow, not just inspect or draft.",
    schema: z.object({ network: evmSignNetwork, venueId: z.string().min(1).max(120), leader: evmAddress, tokenIn: evmAddress, tokenOut: evmAddress,
      startBlock: z.union([z.literal("next"), blockNumber]).default("next"), proportionBps,
      perTradeInputCapRaw: rawUint, cumulativeInputCapRaw: rawUint, slippageBps,
      maxTrades: z.number().int().min(1).max(100), intervalSeconds: z.number().int().min(15).max(3600).default(30),
      predicate: z.object({ graph: predicateGraphSchema, exchangeMaxAgeSeconds: z.number().int().min(1).max(120).default(60), vaultTarget: z.object({ chainId: z.union([z.literal(31337),z.literal(11155111),z.literal(84532),z.literal(10143)]), address: evmAddress }).strict().optional() }).strict().optional(), operationId: op,
    }).strict(),
  },
  get_evm_trade_watches: {
    description: "Read this session's actual persisted trade watch state, immutable leader/venue/token direction, caps, reservations, cursor/head identity, predicate hash and errors. A specified watchId also returns individual source/follower attempts and real gating/execution evidence. Active, paused, completed and uncertain are distinct claims.",
    schema: z.object({ watchId: z.string().min(1).max(200).optional() }).strict(),
  },
  deactivate_evm_trade_watch: {
    description: "Stop future checks and signing for the specified trade watch. Cannot cancel a broadcast or undo a completed swap; a pending attempt may settle and needs read-only reconciliation. Does not release uncertain authority or reset the cumulative raw budget.",
    schema: z.object({ watchId: z.string().min(1).max(200), operationId: op }).strict(),
  },
  reconcile_evm_trade_watch: {
    description: "Read-only recovery of an uncertain watch's recorded follower operation using its frozen venue/signer/source identity. Never signs, rebroadcasts or resumes the watch. Verified recovery settles its reservation; unavailable or mismatched proof remains uncertain. Another explicit bounded activation is required after safe recovery.",
    schema: z.object({ watchId: z.string().min(1).max(200), operationId: op }).strict(),
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
      "Compose or revise a single-source grant-vault policy. Set priceReference to the exact discovered market to select its trigger; source selection persists across revisions. thresholdAboveCurrent fetches real price then sets threshold 5% above it. Never edits running versions. Execution always retains an exchange freshness cap and an already-paused no-op guard, even after removing their optional graph nodes; disclose this when relevant.",
    schema: z.object({
      expectedRevision: revision,
      patch: z.object({
        priceReference: z.string().optional().describe("Exact discovered price object ID or asset name; omit to retain the current source."),
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
      "Replace the draft with a composed pause-vault condition graph. CRE fetches exact Coinbase USD trades through its HTTP capability or configured Chainlink feeds through its EVM capability, evaluates price/compare/freshness/vault-paused/and/or/not, and sends the bound report through its EVM write capability. Preserve each source and network; exchange age cap 120 seconds, oracle cap 26 hours plus tighter explicit freshness. Only pause-vault is supported by the deployed CRE receiver integration. Solana transfers and copy-trading have no implemented CRE receiver and must fail honestly, never be replaced with a pause. Draft edits do not execute. run_workflow evaluates once through CRE; activate_policy explicitly schedules repeated CRE evaluations while the backend runs. Simulation and DON execution are distinct modes.",
    schema: z.object({
      expectedRevision: revision,
      graph: crePolicyGraphSchema
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
      "Freeze the current pause-vault revision and evaluate it once through Chainlink CRE. Requires the CRE executor and deployed version 2 receiver; never falls back to a direct local signer. evaluationOnly:true freezes no-broadcast authority: real CRE source reads and evaluation, with no report submission or signing. The default permits CRE report broadcast when conditions pass and the wallet is configured. No ongoing watcher is installed. Returns run ID promptly; inspect get_run for actual execution mode and verified receipts. Reuse the original operation ID for retries. Unknown outcomes block resubmission.",
    schema: z.object({ expectedRevision: revision, evaluationOnly: z.boolean().optional().describe("Freeze CRE evaluation without report submission; true never broadcasts or signs"), operationId: op }).strict(),
  },
  activate_policy: {
    description:
      "Explicitly schedule repeated Chainlink CRE evaluations of the frozen pause-vault revision. Each check uses CRE source reads, evaluation and report/write authority; no direct signer fallback. Freeze graph, policy hash and vault target. Stop after verified receiver receipt/event and paused read. Later draft edits do not change monitoring. Requires ready CRE executor, version 2 receiver and explicit activation authorization. The backend scheduler is not a deployed DON trigger and stops while the backend is offline. Restart pauses jobs or marks interrupted checks uncertain; inspect and reconcile before explicit reactivation.",
    schema: z.object({
      expectedRevision: revision,
      intervalSeconds: z.number().int().min(15).max(3600).default(30),
      operationId: op,
    }).strict(),
  },
  deactivate_policy: {
    description:
      "Stop future checks for an explicitly identified monitor. Does not undo a pause, cancel a broadcast transaction or change the frozen policy. An in-flight check may still finish; inspect returned status/evidence.",
    schema: z.object({ monitorId: z.string().min(1).max(200), operationId: op }).strict(),
  },
  reconcile_policy: {
    description:
      "Recover an uncertain monitor by reading actual chain receipt and receiver evidence for its frozen run, revision, policy hash and target. Never sends a transaction or resumes polling. Verified matching action settlement becomes completed; definitive absence becomes paused and may be explicitly reactivated. Unavailable or mismatched evidence remains uncertain and blocks new actions. Return actual recovery status and evidence.",
    schema: z.object({ monitorId: z.string().min(1).max(200), operationId: op }).strict(),
  },
  get_monitors: {
    description:
      "Read persisted monitoring status, frozen revision and graph, frozen execution target, next check, failures, run IDs and actual execution evidence. Omitted monitorId lists monitors; explicit monitorId selects one. Paused after restart is not actively monitoring; uncertain outcomes require receipt inspection before reactivation.",
    schema: z.object({ monitorId: z.string().min(1).max(200).optional() }).strict(),
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
      prompt: z.string().optional(),
      summary: z.string().optional(),
      operationId: op,
    }),
  },
  navigate_canvas: {
    description: "Navigate the canvas. show_draft selects the current editable graph, clears frozen-run inspection and frames it; use it when asked to show the current/whole policy after composition. fit only reframes the current selection, which may still be a frozen run. get_run selects its immutable execution snapshot. Other actions zoom or pan. Does not change policy revisions or contract state.",
    schema: z.object({ action: z.enum(["show_draft", "fit", "zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"]), operationId: op }),
  },
  reset_session: {
    description:
      "Clear the canvas and conversation immediately. Does not change contract state. Running executions and active/checking/uncertain monitors prevent reset; stop or reconcile them first.",
    schema: z.object({ operationId: op, expectedSessionId: z.string().optional() }),
  },
} as const;

/** Standalone signer experiments are retained internally for archived diagnostics,
 * but are not product capabilities: execution authority belongs to CRE. */
export const CRE_UNAVAILABLE_PRODUCT_TOOLS = new Set([
  "inspect_solana_wallet", "get_solana_devnet_wallet", "transfer_solana_devnet",
  "list_evm_trade_venues", "get_evm_trade_wallet", "inspect_evm_swap", "inspect_evm_wallet_swaps",
  "quote_evm_copy_swap", "copy_evm_swap", "reconcile_evm_copy_swap",
  "activate_evm_trade_watch", "get_evm_trade_watches", "deactivate_evm_trade_watch", "reconcile_evm_trade_watch",
]);
export const publicToolDefinitions = Object.fromEntries(
  Object.entries(toolDefinitions).filter(([name]) => !CRE_UNAVAILABLE_PRODUCT_TOOLS.has(name)),
);
