import type {
  CanvasState,
  ExecutionRun,
  GraphObject,
  ToolResult,
  WatchState,
  WorkflowRevision,
} from "../shared/types";
import { StateStore } from "./store";
import { migrateState, STATE_VERSION } from "./migrate";
import { buildExecutionPrice } from "./execution-price";
import { fetchPrice, fetchVault, loadDeployment, type Deployment } from "./sources";
import {
  fetchFeedPrice,
  listFeedSymbols,
  resolveFeedSymbol,
  feedObjectId,
  feedObservation,
  feedsOn,
} from "./chainlink";
import {
  legacyGraph,
  readsVault,
  DEFAULT_EXCHANGE_MAX_AGE_SECONDS,
  MAX_FEED_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  describeGraph,
  describeAction,
  phraseCondition,
  validateGraph,
  collectSources,
  describeSource,
  isLegacyShape,
  isSourceNode,
  isSimulatedAction,
  actionPauses,
  policyHash,
  sourceIdentity,
  sourceSchema,
  toBps,
  NETWORKS,
  CCIP_DESTINATIONS,
  DEFAULT_FEED_NETWORK,
  REPORT_VERSION,
  type ChainSource,
  type FeedSource,
  type Network,
  type Observation,
  type PolicyGraph,
  type VaultAction,
} from "../cre/graph";
import type { ExecutionSpecification } from "../cre/spec";
import { ZodError } from "zod";
import {
  executeCreRun,
  executePolicy,
  findSubmittedPause,
  effectFailures,
  describeEffects,
  cronEvery,
  type ExecutionEvidence,
  type FixtureEffects,
  type PolicyEnvironment,
} from "../cre/runner";
import { fetchReading, readingObservation, readingObjectId, readingCatalog, type ReadingSource } from "./onchain";
import { RECIPES, recipeById, recipeCatalog } from "./recipes";
import { MIN_WATCH_SECONDS } from "./schemas";
export { MIN_WATCH_SECONDS };
const now = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);
const baseRevision = (): WorkflowRevision => ({
  revision: 0,
  threshold: 3000,
  maxAgeSeconds: null,
  skipPaused: false,
  createdAt: now(),
  reason: "Initial policy",
  graph: legacyGraph(3000),
  policyHash: policyHash(legacyGraph(3000)),
});
const TERMINAL = ["confirmed", "no-op", "failed"];
/** Inside a run, every watch check and the fixture treasury share these. */
const round9 = (value: number) => Math.round(value * 1e9) / 1e9;
const toWei = (eth: number) => (BigInt(Math.round(eth * 1e9)) * 1_000_000_000n).toString();
const READ_ONLY_TOOLS = ["get_context", "get_run", "describe_policy", "list_price_feeds", "list_sources", "list_recipes", "navigate_canvas"];
/** Archive form of an exchange trade object. */
export function exchangeObservation(object: GraphObject): Observation {
  return {
    ...sourceIdentity({ type: "exchange-trade", pair: "ETH-USD" }),
    value: Number(object.data.price),
    usd: Number(object.data.price),
    raw: String(object.data.price),
    observedAt: object.provenance.observedAt,
    fetchedAt: object.provenance.fetchedAt,
  };
}
export function emptyState(): CanvasState {
  return {
    stateVersion: STATE_VERSION,
    sessionId: crypto.randomUUID(),
    seq: 0,
    mode: "explore",
    focus: { objectId: null, label: "Nothing yet" },
    previousFocus: [],
    references: [],
    objects: [],
    edges: [],
    workflow: {
      id: "workflow:treasury",
      ...baseRevision(),
      summary: "No rule yet.",
      revisions: [],
      created: false,
    },
    runs: [],
    conversation: [],
    activity: {
      status: "idle",
      prompt: "",
      summary: "Ready for your first instruction",
    },
    latency: [],
    capabilities: {
      price: "Coinbase USD markets by exact token name/symbol; ETH also has Kraken fallback",
      vault: "Fixture until local contract is deployed",
      execution: "Local policy rehearsal · no blockchain evidence yet",
      voice: "Planned utterances · actual desktop voice unverified",
      mcp: "Semantic tools · official MCP stdio transport",
    },
  };
}
export interface EngineSources {
  fetchPrice: typeof fetchPrice;
  fetchVault: typeof fetchVault;
  loadDeployment: typeof loadDeployment;
  fetchFeedPrice: typeof fetchFeedPrice;
  /** Runs a frozen spec against a deployed vault (local EVM or CRE). */
  executeRun: typeof executeCreRun;
  /** Reads the chain to learn whether an interrupted run's report landed. */
  findSubmittedPause: typeof findSubmittedPause;
  /** Reads a contract-backed source (Proof of Reserve, supply, lending rate). */
  fetchReading: typeof fetchReading;
  /** Schedules a standing policy's next check; returns a cancel function. */
  schedule: (callback: () => void, ms: number) => () => void;
}
export class Engine {
  state: CanvasState;
  store: StateStore;
  queue: Promise<unknown> = Promise.resolve();
  listeners = new Set<(state: CanvasState) => void>();
  fixturePaused = false;
  /** Fixture treasury: in-memory balances that fixture sweeps, payments and evacuations change. */
  fixtureBalanceEth = 0.12;
  fixtureTokens = 2;
  fixtureReserveEth = 0;
  cancelWatch?: () => void;
  sources: EngineSources;
  constructor(store = new StateStore(), sources: Partial<EngineSources> = {}) {
    this.sources = {
      fetchPrice,
      fetchVault,
      loadDeployment,
      fetchFeedPrice,
      executeRun: executeCreRun,
      findSubmittedPause,
      fetchReading,
      schedule: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
      ...sources,
    };
    this.store = store;
    this.state = migrateState(store.load() as CanvasState) || emptyState();
    this.fixturePaused = Boolean(
      this.state.objects.find((x) => x.id === "vault:grant" && x.data.fixture)
        ?.data.paused,
    );
    let interruptedRun = false;
    for (const run of this.state.runs)
      if (!TERMINAL.includes(run.status)) {
        // The report may or may not have landed. Never resubmit blindly:
        // hold new runs until the chain answers.
        interruptedRun = true;
        run.status = "failed";
        run.uncertain = true;
        run.error =
          "Backend restarted during execution; checking the chain before allowing a retry";
        run.completedAt = now();
        run.logs.push({ at: now(), stage: "failed", message: run.error });
      }
    // A standing policy never resumes on its own after a restart.
    if (this.state.watch?.status === "watching")
      Object.assign(this.state.watch, { status: "stopped", stopReason: "The backend restarted; call watch_policy again to resume.", nextCheckAt: undefined });
    this.state.activity = {
      ...this.state.activity,
      status: interruptedRun ? "error" : "idle",
      summary: interruptedRun
        ? "Backend restarted during execution; checking the chain before allowing a retry"
        : this.state.activity.summary,
    };
    this.store.save(this.state);
    if (interruptedRun) this.reconcileQueued();
  }
  /** Settles every interrupted run from chain state, inside the operation queue. */
  reconcileQueued() {
    const work = this.queue.then(() => this.reconcileAll());
    this.queue = work.catch(() => {});
    return work;
  }
  async reconcileAll() {
    let changed = false;
    for (const run of this.state.runs.filter((x) => x.uncertain))
      changed = (await this.reconcile(run)) || changed;
    if (changed) this.commit();
  }
  async reconcile(run: ExecutionRun): Promise<boolean> {
    if (!run.uncertain) return false;
    const record = (message: string) =>
      run.logs.push({ at: now(), stage: "recovery", message });
    try {
      const deployment = await this.sources.loadDeployment();
      if (!deployment) {
        run.uncertain = false;
        run.error = "Backend restarted during a fixture rehearsal; nothing reached a chain. Safe to run again.";
        record(run.error);
        return true;
      }
      const found = await this.sources.findSubmittedPause(run.id, deployment);
      run.uncertain = false;
      if (found.landed && found.transactionHash) {
        run.status = "confirmed";
        delete run.error;
        run.evidence = {
          ...run.evidence,
          transactionHash: found.transactionHash,
          blockNumber: String(found.blockNumber),
          receiptStatus: "success",
          pausedAfter: found.paused,
          chainId: deployment.chainId,
          contractAddress: deployment.address,
          policyHash: run.policyHash ?? run.snapshot.policyHash,
          verification: "Recovered after restart from the receiver event for this run",
          ...(deployment.chainId === 11155111
            ? { explorerUrl: `https://sepolia.etherscan.io/tx/${found.transactionHash}` }
            : {}),
        };
        record(`Recovered after restart: this run's report landed at block ${found.blockNumber}`);
      } else if (found.landed) {
        run.status = "no-op";
        delete run.error;
        run.noopReason = "This run's report landed before the restart, but no pause event was found for it; the vault was likely already paused.";
        record(run.noopReason);
      } else {
        run.error = "Backend restarted before this run's report landed; nothing reached the chain. Safe to run again.";
        record(run.error);
      }
      return true;
    } catch (error) {
      run.error = `Outcome unknown after restart (${error instanceof Error ? error.message : String(error)}); inspect the chain before retrying.`;
      return true;
    }
  }
  context() {
    const state = clone(this.state);
    const exists = new Set(state.objects.map((x) => x.id));
    state.edges = state.edges.filter((edge) => exists.has(edge.from) && exists.has(edge.to));
    state.canUndoClear = this.isBlank() && !!this.store.latestClearedSession();
    return state;
  }
  isBlank() {
    return !this.state.objects.length && !this.state.runs.length && !this.state.workflow.created && !this.state.conversation.some(c => c.role === "user");
  }
  commit() {
    this.state.seq++;
    this.store.save(this.state);
    const state = this.context();
    for (const listener of this.listeners) listener(state);
  }
  say(
    text: string,
    role: "user" | "assistant" | "system" = "assistant",
    source = "mcp",
  ) {
    this.state.conversation.push({
      id: crypto.randomUUID(),
      role,
      text,
      at: now(),
      source,
    });
    this.state.conversation = this.state.conversation.slice(-80);
  }
  resolve(reference: string): GraphObject | null {
    const ref = reference.toLowerCase().trim();
    if (["this", "it", "that", "current", "focused"].includes(ref))
      return (
        this.state.objects.find((x) => x.id === this.state.focus.objectId) ||
        null
      );
    // A pending clarification is answered by naming one of its candidates
    // ("the bitcoin one" after "which condition?").
    const pending = this.state.clarification;
    if (pending) {
      const bare = ref.replace(/\b(the|one|condition|please|that|this|with|on)\b/g, " ").replace(/\s+/g, " ").trim();
      const symbol = bare ? resolveFeedSymbol(bare)?.symbol.toLowerCase() : undefined;
      const words = [bare, symbol].filter((word): word is string => Boolean(word));
      const matches = pending.candidates
        .map((id) => this.state.objects.find((x) => x.id === id))
        .filter((x): x is GraphObject => Boolean(x))
        .filter((x) => { const text = `${x.id} ${x.label} ${JSON.stringify(x.data)}`.toLowerCase(); return words.length > 0 && words.some((word) => text.includes(word)); });
      if (matches.length === 1) return matches[0]!;
    }
    // "BTC feed", "chainlink BTC", "coinbase BTC": the provider decides which object.
    const provider = /\b(feed|chainlink|oracle)\b/.test(ref) ? "feed" : /\b(coinbase|trade|exchange)\b/.test(ref) ? "price" : null;
    if (provider) {
      const bare = ref.replace(/\b(feed|chainlink|oracle|coinbase|trade|exchange|price|the|sepolia|mainnet)\b/g, " ").replace(/\s+/g, " ").trim();
      if (bare) {
        const symbol = (resolveFeedSymbol(bare)?.symbol ?? bare).toUpperCase();
        const network = /\bsepolia\b/.test(ref) ? "ethereum-sepolia" : DEFAULT_FEED_NETWORK;
        const match = this.state.objects.find((x) => x.kind === provider && String(x.data.symbol ?? "").toUpperCase() === symbol &&
          (provider === "price" || (x.data.network ?? DEFAULT_FEED_NETWORK) === network));
        if (match) return match;
      }
    }
    const aliases: Record<string, string> = {
      eth: "price:eth-usd",
      "eth price": "price:eth-usd",
      vault: "vault:grant",
      treasury: "vault:grant",
      "grant vault": "vault:grant",
      threshold: "condition:threshold",
      freshness: "condition:freshness",
      action: "action:pause",
    };
    if (ref === "source") {
      const focused = this.state.objects.find(x => x.id === this.state.focus.objectId);
      const source = focused?.kind === "price" ? this.state.objects.find(x => x.id === (focused.data.sourceObjectId || (focused.id === "price:eth-usd" ? "source:coinbase" : `source:${focused.id}`))) : null;
      if (source) return source;
    }
    const exact = this.state.objects.find(
      (x) =>
        x.id === reference ||
        x.label.toLowerCase() === ref ||
        x.id === aliases[ref] ||
        (x.kind === "price" && [x.data.symbol, x.data.name, x.data.token, `${x.data.symbol} price`].some(v => typeof v === "string" && v.toLowerCase() === ref)),
    );
    if (exact) return exact;
    const feed = resolveFeedSymbol(ref);
    if (feed) {
      const object = this.state.objects.find(
        (x) => x.kind === "feed" && x.data.symbol === feed.symbol,
      );
      if (object) return object;
    }
    const candidates = this.state.objects.filter(
      (x) => ["price", "source", "vault", "condition", "action"].includes(ref) ? x.kind === ref && !(ref === "condition" && (x.data.logic || x.data.math)) : x.label.toLowerCase().includes(ref) || x.kind === ref ||
        (x.kind === "price" && [x.data.symbol, x.data.name, x.data.token, `${x.data.symbol} price`].some(v => typeof v === "string" && v.toLowerCase() === ref)),
    );
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1)
      this.state.clarification = {
        question: `Which ${ref}: ${candidates.map((x) => x.label).join(" or ")}?`,
        candidates: candidates.map((x) => x.id),
      };
    return null;
  }
  object(object: GraphObject) {
    const i = this.state.objects.findIndex((x) => x.id === object.id);
    if (i < 0) this.state.objects.push(object);
    else
      this.state.objects[i] = {
        ...object,
        pinned: this.state.objects[i]!.pinned,
        visible: true,
      };
  }
  observePrice(price: GraphObject) {
    const sourceId = price.id === "price:eth-usd" ? "source:coinbase" : `source:${price.id}`;
    price.data.sourceObjectId = sourceId;
    const previousSource = this.state.objects.find(x => x.id === sourceId);
    const wasVisible = previousSource?.visible || false;
    this.object({
      id: sourceId, kind: "source",
      label: price.id === "price:eth-usd" ? price.provenance.source : `${price.data.symbol} · ${price.provenance.source}`,
      data: { url: price.provenance.url, token: price.data.token, priceObjectId: price.id },
      provenance: price.provenance, visible: false, pinned: false,
    });
    // Keep source visibility stable across observation refreshes.
    const source = this.state.objects.find(x => x.id === sourceId)!;
    source.visible = wasVisible || source.pinned || this.state.focus.objectId === sourceId;
    this.object(price);
  }
  focus(objectId: string, label: string) {
    if (this.state.focus.objectId && this.state.focus.objectId !== objectId)
      this.state.previousFocus.push(this.state.focus.objectId);
    this.state.previousFocus = this.state.previousFocus.slice(-16);
    this.state.focus = { objectId, label };
    this.state.references.push({ name: label, objectId, at: now() });
    delete this.state.clarification;
  }
  selectRun(run: ExecutionRun) {
    this.state.inspectedRunId = run.id;
    this.state.mode = "run";
    this.focus(
      `run:${run.id}`,
      `Execution v${String(run.revision).padStart(2, "0")}`,
    );
  }
  updateGraph() {
    const w = this.state.workflow;
    if (!w.created) return;
    const provenance = {
      source: "Policy composition",
      observedAt: now(),
      fetchedAt: now(),
      kind: "derived" as const,
      label: `Draft revision ${w.revision}`,
    };
    // A composed graph gets one condition object per node, so individual
    // branches are focusable and inspectable by name. The fixed scalar trio
    // below only describes the single-compare shape.
    if (!isLegacyShape(w.graph)) {
      // Every non-source node gets a focusable condition object, logic and
      // math nodes included, and edges follow the graph's own input
      // references: inputs → values → comparisons → AND/OR/NOT → root → action.
      const graph = w.graph;
      const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
      const inputObject = (nodeId: string) => {
        const node = byId.get(nodeId)!;
        return isSourceNode(node) ? readingObjectId(node.source) : `condition:${node.id}`;
      };
      const labels = new Map<string, string>();
      const labelOf = (nodeId: string): string => {
        const known = labels.get(nodeId);
        if (known) return known;
        const node = byId.get(nodeId)!;
        const label =
          node.kind === "freshness" ? `${phraseCondition(graph, node.input)} within ${node.maxAgeSeconds}s`
          : node.kind === "vault-paused" ? `Vault ${node.equals ? "paused" : "active"}`
          : node.kind === "not" ? `Not (${labelOf(node.input)})`
          : node.kind === "and" ? `All of ${node.inputs.length} conditions`
          : node.kind === "or" ? `Any of ${node.inputs.length} conditions`
          : phraseCondition(graph, node.id);
        labels.set(nodeId, label);
        return label;
      };
      const live = new Set<string>();
      for (const node of graph.nodes) {
        if (isSourceNode(node)) continue;
        const id = `condition:${node.id}`;
        live.add(id);
        const logic = node.kind === "and" || node.kind === "or" || node.kind === "not";
        const role = logic ? { logic: true }
          : node.kind === "math" ? { math: true }
          : node.kind === "vault-paused" ? { source: "vault:grant" }
          : node.kind === "time" ? { source: "decision time" }
          : { source: phraseCondition(graph, node.input) };
        this.object({
          id,
          kind: "condition",
          label: labelOf(node.id),
          data: { ...node, ...role, root: node.id === graph.root },
          visible: true,
          pinned: false,
          provenance,
        });
      }
      this.state.objects = this.state.objects.filter(
        (x) => !x.id.startsWith("condition:") || live.has(x.id),
      );
      // The id stays stable for the canvas; the label and data name the actual action.
      const action = graph.action;
      this.object({
        id: "action:pause",
        kind: "action",
        label: describeAction(action),
        data: isSimulatedAction(action) ? { ...action, simulated: true } : { ...action, target: "vault:grant" },
        visible: true,
        pinned: false,
        provenance,
      });
      w.summary = describeGraph(graph);
      const edges: CanvasState["edges"] = [];
      if (collectSources(graph).some((source) => source.type === "exchange-trade"))
        edges.push({ id: "e1", from: "source:coinbase", to: "price:eth-usd", label: "observes" });
      for (const node of graph.nodes) {
        if (isSourceNode(node)) continue;
        const to = `condition:${node.id}`;
        if (node.kind === "vault-paused") edges.push({ id: `in-${node.id}`, from: "vault:grant", to, label: "state" });
        else if (node.kind === "compare" || node.kind === "freshness")
          edges.push({ id: `in-${node.id}`, from: inputObject(node.input), to, label: node.kind === "compare" ? "compares" : "timestamp" });
        else if (node.kind === "math")
          [node.left, node.right].forEach((input, i) => edges.push({ id: `in-${node.id}-${i}`, from: inputObject(input), to, label: i === 0 ? `${node.op} left` : `${node.op} right` }));
        else if (node.kind === "and" || node.kind === "or" || node.kind === "not")
          (node.kind === "not" ? [node.input] : node.inputs).forEach((input, i) =>
            edges.push({ id: `in-${node.id}-${i}`, from: inputObject(input), to, label: node.kind === "not" ? "negates" : node.kind }));
      }
      edges.push({ id: "out-root", from: `condition:${graph.root}`, to: "action:pause", label: "if true" });
      edges.push({
        id: "e-act",
        from: "action:pause",
        to: "vault:grant",
        label: isSimulatedAction(action) ? "simulated · vault unchanged"
          : action.type === "sweep" ? "sweeps to reserve"
          : action.type === "pay" ? `pays ${action.payee}`
          : action.type === "evacuate" ? "bridges via CCIP"
          : "pauses",
      });
      // Edges to inputs not read yet (an unfetched feed) are kept here and
      // hidden by context() until that object exists.
      this.state.edges = edges;
      return;
    }
    // Returning to the scalar shape removes every condition a composed graph left behind.
    this.state.objects = this.state.objects.filter(
      (x) => !x.id.startsWith("condition:") || ["condition:threshold", "condition:freshness", "condition:unpaused"].includes(x.id),
    );
    this.object({
      id: "condition:threshold",
      kind: "condition",
      label: "Price threshold",
      data: { threshold: w.threshold, operator: "<", unit: "USD" },
      visible: true,
      pinned: false,
      provenance,
    });
    this.object({
      id: "action:pause",
      kind: "action",
      label: "Pause spending",
      data: { target: "vault:grant" },
      visible: true,
      pinned: false,
      provenance,
    });
    if (w.maxAgeSeconds !== null)
      this.object({
        id: "condition:freshness",
        kind: "condition",
        label: "Fresh observation",
        data: { maxAgeSeconds: w.maxAgeSeconds },
        visible: true,
        pinned: false,
        provenance,
      });
    else
      this.state.objects = this.state.objects.filter(
        (x) => x.id !== "condition:freshness",
      );
    if (w.skipPaused)
      this.object({
        id: "condition:unpaused",
        kind: "condition",
        label: "Vault is unpaused",
        data: { expected: false },
        visible: true,
        pinned: false,
        provenance,
      });
    else
      this.state.objects = this.state.objects.filter(
        (x) => x.id !== "condition:unpaused",
      );
    // A composed graph describes itself; the scalar sentence only fits the
    // single-compare shape it was written for.
    w.summary = isLegacyShape(w.graph)
      ? `When ETH / USD is below $${w.threshold.toLocaleString("en-US", { maximumFractionDigits: 2 })}${w.maxAgeSeconds !== null ? `, the observation is no more than ${w.maxAgeSeconds} seconds old` : ""}${w.skipPaused ? ", and the grant vault is not already paused" : ""}, pause grant vault spending.`
      : describeGraph(w.graph);
    this.state.edges = [
      {
        id: "e1",
        from: "source:coinbase",
        to: "price:eth-usd",
        label: "observes",
      },
      {
        id: "e2",
        from: "price:eth-usd",
        to: "condition:threshold",
        label: "compares",
      },
      {
        id: "e3",
        from: "condition:threshold",
        to: "action:pause",
        label: "if true",
      },
      { id: "e4", from: "action:pause", to: "vault:grant", label: "pauses" },
    ];
    if (w.maxAgeSeconds !== null)
      this.state.edges.push(
        {
          id: "e5",
          from: "price:eth-usd",
          to: "condition:freshness",
          label: "timestamp",
        },
        {
          id: "e6",
          from: "condition:freshness",
          to: "action:pause",
          label: "and",
        },
      );
    if (w.skipPaused)
      this.state.edges.push(
        {
          id: "e7",
          from: "vault:grant",
          to: "condition:unpaused",
          label: "state",
        },
        {
          id: "e8",
          from: "condition:unpaused",
          to: "action:pause",
          label: "and",
        },
      );
  }
  async invoke(
    tool: string,
    args: Record<string, any> = {},
  ): Promise<ToolResult> {
    const execute = () => this.perform(tool, args);
    const result = this.queue.then(execute, execute);
    this.queue = result.catch(() => {});
    return result;
  }
  async perform(tool: string, args: Record<string, any>): Promise<ToolResult> {
    const started = performance.now();
    const receivedAt = now();
    const operationId = args.operationId || crypto.randomUUID();
    const signature = JSON.stringify({
      tool,
      args: Object.fromEntries(
        Object.entries(args).filter(([k]) => k !== "operationId"),
      ),
    });
    const existing = this.store.operation(operationId);
    if (existing) {
      if (existing.signature !== signature)
        return {
          ok: false,
          summary: "Operation ID was reused for a different instruction; send this one with a new operationId",
          code: "OPERATION_CONFLICT",
          state: this.context(),
        };
      const run = existing.result.runId ? this.state.runs.find((x) => x.id === existing.result.runId) : undefined;
      return {
        ...existing.result,
        ...(run ? { summary: `Same request as before (no new execution). Run ${run.id} for revision ${run.revision} is ${run.status}${run.noopReason ? `: ${run.noopReason}` : run.error ? `: ${run.error}` : ""}.` } : {}),
        state: this.context(),
        duplicate: true,
      };
    }
    let summary = "";
    let runId: string | undefined;
    try {
      switch (tool) {
        case "get_context":
          return {
            ok: true,
            summary: this.state.workflow.created
              ? this.state.workflow.summary
              : "The canvas is ready for discovery.",
            state: this.context(),
          };
        case "discover_objects": {
          const requested = (args.objects || ["price", "vault"]) as string[];
          const tokens: string[] = args.tokens || ["ETH"];
          const settled = await Promise.allSettled([
            ...(requested.includes("price") ? tokens.map(token => this.sources.fetchPrice(token)) : []),
            ...(requested.includes("vault") ? [this.sources.fetchVault(this.fixturePaused).then((vault) => this.fixtureVault(vault))] : []),
          ]);
          const errors: string[] = [];
          const discovered: GraphObject[] = [];
          for (const r of settled) {
            if (r.status === "fulfilled") {
              const object = r.value;
              if (object.kind === "price") this.observePrice(object);
              else this.object(object);
              discovered.push(object);
            } else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
          }
          if (!discovered.length) throw new Error(errors.join("; ") || "No objects requested");
          this.state.mode = "explore";
          this.state.capabilities.vault =
            this.state.objects.find((x) => x.id === "vault:grant")?.provenance
              .label || this.state.capabilities.vault;
          const observations = discovered.map(x => x.kind === "price" ? `${x.label}: $${x.data.price} (${x.provenance.source}, observed ${x.provenance.observedAt})` : x.label).join("; ");
          summary = errors.length
            ? `Discovery partly succeeded. Discovered ${observations}. Failed: ${errors.join("; ")}`
            : `Discovered ${observations}.`;
          break;
        }
        case "list_price_feeds": {
          const mainnetFeeds = feedsOn("ethereum-mainnet");
          summary = `Chainlink mainnet feeds available: ${listFeedSymbols()
            .map((x) => `${x} (${mainnetFeeds[x]!.name})`)
            .join(", ")}. Sepolia feeds: ${Object.keys(feedsOn("ethereum-sepolia")).join(", ")}.`;
          break;
        }
        case "list_sources": {
          summary = `Chainlink price feeds on mainnet: ${listFeedSymbols().join(", ")}; on Sepolia: ${Object.keys(feedsOn("ethereum-sepolia")).join(", ")}. ` +
            `Contract readings: ${readingCatalog().join("; ")}. The Coinbase ETH-USD trade is the one exchange source. ` +
            `Combine readings with math nodes (-, /, *) and compare; a policy reads at most 5 sources.`;
          break;
        }
        case "read_source": {
          const source = sourceSchema.parse(args.source);
          let object: GraphObject;
          if (source.type === "exchange-trade") {
            object = await this.sources.fetchPrice("ETH");
            this.observePrice(object);
          } else if (source.type === "chainlink-feed") {
            object = await this.sources.fetchFeedPrice(source.symbol, source.network);
            this.object(object);
          } else if (source.type === "vault-balance") {
            object = this.fixtureVault(await this.sources.fetchVault(this.fixturePaused));
            this.object(object);
          } else {
            object = await this.sources.fetchReading(source);
            this.object(object);
          }
          object = this.state.objects.find((x) => x.id === object.id) ?? object;
          this.focus(object.id, object.label);
          summary = this.describeObject(object);
          break;
        }
        case "read_price_feed": {
          const requested = String(args.symbol ?? "").trim();
          const network: Network = args.network ?? DEFAULT_FEED_NETWORK;
          const feed = resolveFeedSymbol(requested);
          if (!feed || !feedsOn(network)[feed.symbol])
            throw new Error(
              `No Chainlink feed is configured for "${requested}" on ${NETWORKS[network].label}. Available: ${Object.keys(feedsOn(network)).join(", ")}`,
            );
          const object = await this.sources.fetchFeedPrice(feed.symbol, network);
          this.object(object);
          this.focus(object.id, object.label);
          // The aggregator's own write time, not our fetch time. Feeds publish
          // on deviation or heartbeat, so this is routinely minutes old and the
          // caption has to carry that rather than imply a spot quote.
          summary =
            `${feed.name} is $${Number(object.data.price).toLocaleString(
              "en-US",
              {
                maximumFractionDigits: Number(object.data.price) < 10 ? 6 : 2,
              },
            )} per the Chainlink ${object.data.description} feed on ${NETWORKS[network].label}, ` +
            `last written ${object.data.ageLabel}. This is an on-chain oracle read, not the vault's execution price.`;
          break;
        }
        case "focus_object": {
          const reference = args.objectId || args.reference || "this";
          const runReference = [
            "this",
            "it",
            "that",
            "current",
            "focused",
          ].includes(reference)
            ? this.state.focus.objectId
            : reference;
          const knownRun = this.state.runs.find(
            (x) => runReference === x.id || runReference === `run:${x.id}`,
          );
          if (knownRun) {
            this.selectRun(knownRun);
            runId = knownRun.id;
            summary = `Focused: ${this.state.focus.label}. Immutable revision ${knownRun.revision}: ${knownRun.status}.`;
            break;
          }
          if (
            typeof runReference === "string" &&
            (runReference.startsWith("run:") || runReference.startsWith("run-"))
          )
            throw new Error(`No execution run matches ${runReference}`);
          if (args.reference === "back") {
            let restored = false;
            while (this.state.previousFocus.length && !restored) {
              const previous = this.state.previousFocus.pop()!;
              const object = this.state.objects.find((x) => x.id === previous);
              const run = this.state.runs.find(
                (x) => previous === x.id || previous === `run:${x.id}`,
              );
              if (previous === this.state.workflow.id) {
                this.state.mode = "compose";
                this.state.focus = {
                  objectId: previous,
                  label: "Treasury policy",
                };
              } else if (run) {
                this.state.mode = "run";
                this.state.inspectedRunId = run.id;
                this.state.focus = {
                  objectId: `run:${run.id}`,
                  label: `Execution v${String(run.revision).padStart(2, "0")}`,
                };
              } else if (object) {
                object.visible = true;
                this.state.mode = ["condition", "action"].includes(object.kind)
                  ? "compose"
                  : "explore";
                this.state.focus = { objectId: object.id, label: object.label };
              } else continue;
              restored = true;
              this.state.references.push({
                name: this.state.focus.label,
                objectId: this.state.focus.objectId!,
                at: now(),
              });
              delete this.state.clarification;
            }
            if (!restored) throw new Error("No previous focus remains");
            summary = `Focused: ${this.state.focus.label}`;
            break;
          }
          if (
            ["workflow", "whole rule", "rule"].includes(args.reference) ||
            (["this", "it", "that"].includes(args.reference) &&
              this.state.focus.objectId === this.state.workflow.id)
          ) {
            this.state.mode = "compose";
            this.focus(this.state.workflow.id, "Treasury policy");
            summary = this.state.workflow.summary;
            break;
          }
          const object = this.resolve(
            args.objectId || args.reference || "this",
          );
          if (!object) {
            if (this.state.clarification) {
              summary = this.state.clarification.question;
              break;
            }
            throw new Error(`Nothing on the canvas matches "${args.objectId || args.reference}". Visible objects: ${this.state.objects.filter((x) => x.visible).map((x) => x.label).join(", ") || "none yet; discover objects first"}`);
          }
          object.visible = true;
          if (args.pin) object.pinned = true;
          this.focus(object.id, object.label);
          summary = `Focused: ${object.label}.`;
          break;
        }
        case "inspect_object": {
          const ref = args.objectId || args.reference || "this";
          const focusedRun = ["this", "it", "that"].includes(ref) && this.state.focus.objectId?.startsWith("run:")
            ? this.state.runs.find((x) => `run:${x.id}` === this.state.focus.objectId) : undefined;
          if (focusedRun) {
            runId = focusedRun.id;
            summary = `Run ${focusedRun.id}, revision ${focusedRun.revision}: ${focusedRun.status}. ${focusedRun.noopReason || focusedRun.error || focusedRun.evidence?.verification || focusedRun.logs.at(-1)?.message || ""}`.trim();
            break;
          }
          if (
            ["workflow", "rule"].includes(ref) ||
            (["this", "it", "that"].includes(ref) &&
              this.state.focus.objectId === this.state.workflow.id)
          ) {
            summary = this.state.workflow.summary;
            this.state.mode = "compose";
            break;
          }
          const object = this.resolve(ref);
          if (!object) {
            if (this.state.clarification) {
              summary = this.state.clarification.question;
              break;
            }
            throw new Error(`Nothing on the canvas matches "${ref}". Visible objects: ${this.state.objects.filter((x) => x.visible).map((x) => x.label).join(", ") || "none yet; discover objects first"}`);
          }
          if (
            args.refresh &&
            (object.kind === "price" ||
              object.kind === "vault" ||
              object.kind === "feed")
          )
            if (object.kind === "price") {
              this.observePrice(await this.sources.fetchPrice(object.data.token || object.data.symbol ||
                (object.id === "price:eth-usd" ? "ETH" : object.label.split(" / ")[0])));
            } else if (object.kind === "feed") {
              this.object(await this.sources.fetchFeedPrice(object.data.symbol, object.data.network ?? DEFAULT_FEED_NETWORK));
            } else this.object(this.fixtureVault(await this.sources.fetchVault(this.fixturePaused)));
          else if (args.refresh && object.kind === "reading" && object.data.source)
            this.object(await this.sources.fetchReading(object.data.source as ReadingSource));
          const current = this.state.objects.find((x) => x.id === object.id)!;
          summary = this.describeObject(current);
          this.focus(current.id, current.label);
          break;
        }
        case "patch_workflow": {
          if (args.expectedRevision !== this.state.workflow.revision)
            throw Object.assign(
              new Error(
                `Draft is now revision ${this.state.workflow.revision}; refresh context before editing.`,
              ),
              { code: "REVISION_CONFLICT" },
            );
          const patch = args.patch || {};
          const current = this.state.workflow;
          let threshold = patch.threshold ?? current.threshold;
          if (patch.thresholdAboveCurrent) {
            const price = await this.sources.fetchPrice();
            this.object(price);
            threshold = Math.ceil(price.data.price * 1.05 * 100) / 100;
          }
          const maxAge =
            patch.maxAgeSeconds === undefined
              ? current.maxAgeSeconds
              : patch.maxAgeSeconds;
          const skip =
            patch.skipPaused === undefined
              ? current.skipPaused
              : patch.skipPaused;
          if (
            typeof threshold !== "number" ||
            !Number.isFinite(threshold) ||
            threshold <= 0 ||
            threshold > 1e7
          )
            throw new Error("Threshold must be a positive finite USD amount");
          if (
            maxAge !== null &&
            (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 120)
          )
            throw new Error("Freshness must be 1–120 whole seconds");
          if (typeof skip !== "boolean")
            throw new Error("skipPaused must be boolean");
          // The scalar rule reads the Coinbase ETH trade and pauses the vault; a
          // composed graph only needs what it reads (a cap or guard edit).
          const scalar = isLegacyShape(current.graph);
          const needs = [
            scalar && !this.state.objects.some((x) => x.id === "price:eth-usd") && 'the Coinbase ETH/USD price (discover_objects with tokens ["ETH"])',
            (scalar || readsVault(current.graph)) && !this.state.objects.some((x) => x.kind === "vault") && 'the grant vault (discover_objects with objects ["vault"])',
          ].filter(Boolean);
          if (needs.length) throw new Error(`Discover ${needs.join(" and ")} before editing this policy`);
          // A scalar edit can only express the single-compare shape. Against a
          // composed graph it refuses, so branches the speaker added are never
          // discarded by a stray threshold tweak.
          if (patch.threshold !== undefined || patch.thresholdAboveCurrent)
            if (!isLegacyShape(current.graph))
              throw new Error(
                "This policy is a composed graph; revise it with compose_graph rather than a scalar threshold",
              );
          const revision: WorkflowRevision = {
            revision: current.revision + 1,
            threshold,
            maxAgeSeconds: maxAge,
            skipPaused: skip,
            createdAt: now(),
            reason: args.reason || "Voice policy revision",
            graph: isLegacyShape(current.graph)
              ? legacyGraph(threshold)
              : clone(current.graph),
          };
          revision.policyHash = policyHash(revision.graph, revision.maxAgeSeconds ?? DEFAULT_EXCHANGE_MAX_AGE_SECONDS);
          current.revisions.push(revision);
          Object.assign(current, revision, { created: true });
          this.state.mode = "compose";
          this.updateGraph();
          this.focus(current.id, "Treasury policy");
          summary = `Revision ${current.revision}. ${current.summary}`;
          break;
        }
        case "describe_policy": {
          const w = this.state.workflow;
          if (!w.created) {
            summary = "No policy composed yet.";
            break;
          }
          const all = collectSources(w.graph);
          const sources = all.map(describeSource);
          const caps = [
            all.some((source) => source.type === "exchange-trade") && `the Coinbase trade must be at most ${w.maxAgeSeconds ?? DEFAULT_EXCHANGE_MAX_AGE_SECONDS}s old`,
            all.some((source) => source.type === "chainlink-feed" || source.type === "proof-of-reserve") && `each Chainlink feed at most ${MAX_FEED_AGE_SECONDS / 3600}h old`,
            all.some((source) => ["token-supply", "lending-rate", "vault-balance"].includes(source.type)) && `contract state is read during the run (at most ${MAX_STATE_AGE_SECONDS}s old)`,
          ].filter(Boolean).join(" and ");
          const guard = w.graph.action.type === "pause-vault" ? ", and an already-paused vault is never paused again"
            : w.graph.action.type === "pay" ? ", and a paused or underfunded vault never pays"
            : w.graph.action.type === "sweep" ? ", and an empty vault is never swept"
            : w.graph.action.type === "evacuate" ? ", and a vault without CCIP-BnM never sends a message" : "";
          summary = `Revision ${w.revision}. ${describeGraph(w.graph)} Execution fetches ${sources.join(" and ")}; ${caps}${guard}.${this.watchSentence()}`;
          break;
        }
        case "compose_graph": {
          const w = this.state.workflow;
          if (args.expectedRevision !== w.revision)
            throw Object.assign(
              new Error(
                `Draft is now revision ${w.revision}; refresh context before composing.`,
              ),
              { code: "REVISION_CONFLICT" },
            );
          // validateGraph rejects unknown node kinds, dangling edges, cycles,
          // mistyped operands and mismatched units, orphan nodes, unregistered
          // sources and oversized fetch plans. Nothing about execution depends
          // on node order: the receiver gets the structural policy hash.
          const { graph } = validateGraph(args.graph);
          summary = this.composeRevision(graph, args.reason || "Composed condition graph", args.maxAgeSeconds);
          break;
        }
        case "list_recipes": {
          summary = `Policies modelled on past Chainlink hackathon winners (each becomes an ordinary revision with its own policy hash):\n${recipeCatalog()}`;
          break;
        }
        case "apply_recipe": {
          const w = this.state.workflow;
          if (args.expectedRevision !== w.revision)
            throw Object.assign(new Error(`Draft is now revision ${w.revision}; refresh context before applying a recipe.`), { code: "REVISION_CONFLICT" });
          const recipe = recipeById(String(args.recipe));
          if (!recipe) throw new Error(`Unknown recipe "${args.recipe}". Available: ${RECIPES.map((x) => x.id).join(", ")}`);
          const params = recipe.params.parse(args.params ?? {});
          const { graph } = validateGraph(recipe.build(params));
          const credit = recipe.inspiredBy.map((x) => `${x.project} (${x.event}, ${x.award})`).join(" and ");
          summary = `${this.composeRevision(graph, args.reason || `Recipe: ${recipe.title}`, args.maxAgeSeconds)} ${recipe.title}, inspired by ${credit}.${recipe.note ? ` ${recipe.note}` : ""}${recipe.watchSeconds ? ` To keep it running, call watch_policy with everySeconds ${recipe.watchSeconds}.` : ""}`;
          break;
        }
        case "undo_revision": {
          const w = this.state.workflow;
          if (args.expectedRevision !== w.revision)
            throw Object.assign(
              new Error(`Draft is now revision ${w.revision}; undo with expectedRevision ${w.revision} if that is the version to step back from`),
              { code: "REVISION_CONFLICT" },
            );
          // An undo records which revision it restored, so the next undo steps
          // further back instead of toggling between the last two.
          const latest = w.revisions.at(-1);
          const effective = latest?.restores ?? latest?.revision;
          const index = w.revisions.findIndex((x) => x.revision === effective);
          const target = index > 0 ? w.revisions[index - 1] : undefined;
          if (!target) throw new Error("No earlier revision to restore");
          const revision: WorkflowRevision = {
            ...target,
            revision: w.revision + 1,
            createdAt: now(),
            reason: `Restore revision ${target.revision}`,
            restores: target.revision,
          };
          w.revisions.push(revision);
          Object.assign(w, revision);
          this.updateGraph();
          summary = `Restored revision ${target.revision} as revision ${revision.revision}. ${w.summary}`;
          break;
        }
        case "run_workflow": {
          const w = this.state.workflow;
          if (!w.created) throw new Error("Compose a policy first");
          if (args.expectedRevision !== w.revision)
            throw Object.assign(
              new Error(`Draft is now revision ${w.revision}; run it with expectedRevision ${w.revision} if that is the version the user wants`),
              { code: "REVISION_CONFLICT" },
            );
          // A retried request reuses its operationId and gets the stored
          // result. A new request while this revision is still executing
          // joins that run. Once it has finished, an explicit run is a fresh
          // execution with fresh inputs and a new run ID.
          const unsettled = this.state.runs.find((x) => x.uncertain);
          if (unsettled)
            throw new Error(
              `Run ${unsettled.id} was interrupted by a restart and its outcome is still unknown; inspect it with get_run before running again.`,
            );
          const inflight = this.state.runs.find(
            (x) => x.revision === w.revision && !TERMINAL.includes(x.status),
          );
          if (inflight) {
            runId = inflight.id;
            this.selectRun(inflight);
            summary = `Revision ${w.revision} is already executing as run ${inflight.id}; joined it without starting a duplicate.`;
            break;
          }
          const run = this.startRun(w.revisions.at(-1)!, { trigger: "manual", prompt: "Run this version" });
          runId = run.id;
          this.selectRun(run);
          const sessionId = this.state.sessionId;
          setTimeout(() => void this.execute(run.id, sessionId), 10);
          summary = `Run ${runId} started against immutable revision ${w.revision}.`;
          break;
        }
        case "get_run": {
          const run = args.runId
            ? this.state.runs.find((x) => x.id === args.runId)
            : this.state.runs[0];
          if (!run) throw new Error(args.runId
            ? `No run ${args.runId}. Recent runs: ${this.state.runs.slice(0, 5).map((x) => `${x.id} (revision ${x.revision}, ${x.status})`).join(", ") || "none yet"}`
            : "No run yet; run_workflow starts one");
          if (run.uncertain) await this.reconcile(run);
          runId = run.id;
          this.selectRun(run);
          summary = `Run revision ${run.revision}: ${run.status}${run.uncertain ? " (outcome unknown)" : ""}. ${run.error || run.noopReason || run.logs.at(-1)?.message || ""}`;
          this.state.mode = "run";
          break;
        }
        case "watch_policy": {
          const w = this.state.workflow;
          if (!w.created) throw new Error("Compose a policy first");
          if (args.expectedRevision !== w.revision)
            throw Object.assign(new Error(`Draft is now revision ${w.revision}; watch it with expectedRevision ${w.revision} if that is the version the user wants`), { code: "REVISION_CONFLICT" });
          const unsettled = this.state.runs.find((x) => x.uncertain);
          if (unsettled) throw new Error(`Run ${unsettled.id} was interrupted by a restart and its outcome is still unknown; inspect it with get_run before watching.`);
          const everySeconds = args.everySeconds ?? 60;
          const maxChecks = args.maxChecks ?? 20;
          const stopOnAction = args.stopOnAction ?? true;
          if (!Number.isInteger(everySeconds) || everySeconds < MIN_WATCH_SECONDS || everySeconds > 3600)
            throw new Error(`everySeconds must be a whole number from ${MIN_WATCH_SECONDS} (the fastest CRE cron schedule) to 3600`);
          if (!Number.isInteger(maxChecks) || maxChecks < 1 || maxChecks > 200) throw new Error("maxChecks must be a whole number from 1 to 200");
          if (typeof stopOnAction !== "boolean") throw new Error("stopOnAction must be true or false");
          const previous = this.state.watch?.status === "watching" ? this.state.watch : undefined;
          this.stopWatch(`Replaced by a watch on revision ${w.revision}`);
          const snapshot = clone(w.revisions.at(-1)!);
          snapshot.policyHash ??= policyHash(snapshot.graph, snapshot.maxAgeSeconds ?? DEFAULT_EXCHANGE_MAX_AGE_SECONDS);
          this.state.watch = {
            id: `watch-${crypto.randomUUID()}`, revision: w.revision, snapshot, policyHash: snapshot.policyHash,
            everySeconds, maxChecks, checks: 0, stopOnAction, status: "watching", startedAt: now(), consecutiveFailures: 0,
          };
          this.scheduleWatch(10);
          const cre = process.env.ORIGINS_EXECUTION_MODE === "cre";
          summary = `Watching revision ${w.revision} every ${everySeconds}s for up to ${maxChecks} check${maxChecks === 1 ? "" : "s"}${stopOnAction ? "; it stops after the first time it acts" : ""}. ${describeGraph(snapshot.graph)} ` +
            `Each check is a fresh run with fresh inputs${cre ? " through the CRE workflow's cron trigger" : ""}; checks that find nothing to do stay quiet.${previous ? ` Replaced the watch on revision ${previous.revision}.` : ""}`;
          break;
        }
        case "stop_watching": {
          const watch = this.state.watch;
          if (!watch || watch.status !== "watching") throw new Error("No policy is being watched");
          this.stopWatch("Stopped on request");
          summary = `Stopped watching revision ${watch.revision} after ${watch.checks} check${watch.checks === 1 ? "" : "s"}. A check already running finishes normally.`;
          break;
        }
        case "submit_utterance": {
          if (typeof args.text !== "string" || !args.text.trim())
            throw new Error("Caption text required");
          this.say(args.text, "user", args.source || "planned prompt");
          summary = "Utterance recorded.";
          break;
        }
        case "set_activity": {
          if (
            ![
              "idle",
              "listening",
              "thinking",
              "executing",
              "speaking",
              "error",
            ].includes(args.status)
          )
            throw new Error("Invalid activity");
          this.state.activity = {
            status: args.status,
            prompt: args.prompt || this.state.activity.prompt,
            summary: args.summary || "",
          };
          summary = args.summary || "Activity updated";
          break;
        }
        case "navigate_canvas": {
          if (!["fit", "zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"].includes(args.action)) throw new Error("Unknown canvas navigation action.");
          this.state.canvasView = { action: args.action, sequence: (this.state.canvasView?.sequence || 0) + 1 };
          summary = args.action === "fit" ? "Framed the whole canvas." : `Canvas ${args.action.replaceAll("_", " ")}.`;
          break;
        }
        case "reset_session": {
          if (args.expectedSessionId && args.expectedSessionId !== this.state.sessionId)
            throw new Error("The session changed. Refresh before clearing the canvas.");
          if (this.state.runs.some(x => !["confirmed", "no-op", "failed"].includes(x.status)))
            throw new Error("A run is still executing; wait for completion before clearing the canvas.");
          this.stopWatch("Canvas cleared");
          if (!this.isBlank()) this.store.archiveSession(this.state);
          const capabilities = clone(this.state.capabilities);
          this.state = emptyState();
          this.state.capabilities = capabilities;
          summary = "Canvas cleared. Contract state is unchanged.";
          break;
        }
        case "restore_session": {
          if (args.expectedSessionId && args.expectedSessionId !== this.state.sessionId)
            throw new Error("The session changed. Refresh before undoing clear.");
          if (!this.isBlank()) throw new Error("Undo clear is available only before starting a new canvas session.");
          const archived = this.store.latestClearedSession();
          if (!archived) throw new Error("There is no cleared session to restore.");
          this.state = migrateState(clone(archived));
          this.state.sessionId = crypto.randomUUID();
          this.state.activity = { status: "idle", prompt: "", summary: "Canvas restored." };
          this.fixturePaused = Boolean(this.state.objects.find(x => x.id === "vault:grant" && x.data.fixture)?.data.paused);
          summary = "Canvas restored. Contract state is unchanged.";
          break;
        }
        default:
          throw new Error(`Unknown semantic tool: ${tool}`);
      }
      if (["focus_object", "inspect_object", "get_run"].includes(tool)) {
        const frameRule = ["workflow", "whole rule", "whole workflow", "treasury policy"].includes(String(args.reference || "").toLowerCase());
        this.state.canvasView = { action: frameRule ? "fit" : "focus", sequence: (this.state.canvasView?.sequence || 0) + 1 };
      }
      const readOnly = READ_ONLY_TOOLS.includes(tool);
      const executing = this.state.runs.some((x) => !TERMINAL.includes(x.status));
      if (!["set_activity", "submit_utterance"].includes(tool) && !readOnly)
        this.say(summary);
      // While a run executes, only the run itself reports activity.
      if (!["run_workflow", "submit_utterance", "set_activity"].includes(tool) && !executing)
        this.state.activity = {
          ...this.state.activity,
          status: "idle",
          summary,
        };
      // A clarification answers the next focus or inspect; any other step moves on from it.
      if (!["focus_object", "inspect_object", "get_context"].includes(tool))
        delete this.state.clarification;
      this.state.latency.push({
        operationId,
        tool,
        receivedAt,
        committedAt: now(),
        commitMs: Math.round((performance.now() - started) * 100) / 100,
      });
      this.state.latency = this.state.latency.slice(-100);
      this.commit();
      const result = {
        ok: true,
        summary,
        state: this.context(),
        ...(runId ? { runId } : {}),
      };
      this.store.remember(operationId, signature, result);
      return result;
    } catch (error) {
      // cre/ resolves its own zod copy, so match ZodError by shape rather than by class.
      const issues = error instanceof ZodError || (error instanceof Error && error.name === "ZodError" && Array.isArray((error as ZodError).issues))
        ? (error as ZodError).issues : undefined;
      summary = issues
        ? `Invalid ${tool} arguments: ${issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`
        : error instanceof Error ? error.message : String(error);
      this.state.activity = {
        ...this.state.activity,
        status: "error",
        summary,
      };
      this.say(summary);
      this.commit();
      return {
        ok: false,
        summary,
        error: summary,
        code: (error as any)?.code || "TOOL_ERROR",
        state: this.context(),
      };
    }
  }
  /** Validated graph → new draft revision. Shared by compose_graph and apply_recipe. */
  composeRevision(graph: PolicyGraph, reason: string, maxAgeSeconds?: number | null): string {
    const w = this.state.workflow;
    // Require only what this policy uses: the vault when it acts on or reads
    // it, and the Coinbase trade when a branch uses it. Feeds and contract
    // readings are read at execution and shown as configured inputs until then.
    const missing = [
      readsVault(graph) && !this.state.objects.some((x) => x.kind === "vault") && 'the grant vault (discover_objects with objects ["vault"])',
      collectSources(graph).some((source) => source.type === "exchange-trade") && !this.state.objects.some((x) => x.id === "price:eth-usd") && 'the Coinbase ETH/USD price (discover_objects with tokens ["ETH"])',
    ].filter(Boolean);
    if (missing.length) throw new Error(`Discover ${missing.join(" and ")} before composing this policy`);
    const inherited = maxAgeSeconds === undefined;
    const cap = inherited ? w.maxAgeSeconds : maxAgeSeconds;
    const compare = graph.nodes.find((node) => node.id === graph.root);
    const revision: WorkflowRevision = {
      revision: w.revision + 1,
      // The scalar field only describes the legacy single-compare shape.
      threshold: isLegacyShape(graph) && compare?.kind === "compare" ? compare.value : w.threshold,
      maxAgeSeconds: cap,
      skipPaused: w.skipPaused,
      createdAt: now(),
      reason,
      graph,
      policyHash: policyHash(graph, cap ?? DEFAULT_EXCHANGE_MAX_AGE_SECONDS),
    };
    w.revisions.push(revision);
    Object.assign(w, revision, { created: true });
    this.state.mode = "compose";
    this.updateGraph();
    this.focus(w.id, "Treasury policy");
    return `Revision ${w.revision}. ${describeGraph(graph)} ${this.executionNotes(graph, cap, inherited)}`;
  }
  /** What execution will fetch and what the action can and cannot do, in one or two sentences. */
  executionNotes(graph: PolicyGraph, cap: number | null, inherited: boolean): string {
    const notes = [`Execution fetches ${collectSources(graph).map(describeSource).join(" and ")}.`];
    if (collectSources(graph).some((source) => source.type === "exchange-trade") && cap !== null && cap !== DEFAULT_EXCHANGE_MAX_AGE_SECONDS)
      notes.push(`The Coinbase trade must be at most ${cap}s old${inherited ? " (kept from the previous revision; pass maxAgeSeconds to change it)" : ""}.`);
    const action = graph.action;
    if (action.type === "sell") notes.push("The sell is simulated and runs only in local rehearsal; no asset moves.");
    if (action.type === "rebalance") notes.push("The rebalance is simulated and runs only in local rehearsal; no asset moves.");
    if (action.type === "sweep") notes.push(`Sweeps go only to the reserve fixed when the vault was deployed${action.pause ? ", and spending pauses in the same report" : ""}.`);
    if (action.type === "pay") notes.push(`The vault pays only payees its owner registered ("${action.payee}" must be one), within a per-payment cap and minimum interval enforced on chain; paused spending blocks it.`);
    if (action.type === "evacuate") notes.push(`Bridges the vault's CCIP-BnM through Chainlink CCIP to the reserve on ${CCIP_DESTINATIONS[action.destination].label}${action.pause ? " and pauses spending" : ""}; delivery takes about 20 minutes.`);
    return notes.join(" ");
  }
  /** A readable sentence for any canvas object, used by inspect and read_source. */
  describeObject(object: GraphObject): string {
    const w = this.state.workflow;
    switch (object.kind) {
      case "feed":
        return `${object.label}: $${object.data.price} from the Chainlink aggregator at ${object.data.feedAddress} on ${NETWORKS[(object.data.network ?? DEFAULT_FEED_NETWORK) as Network].label}, round ${object.data.roundId} written ${object.data.ageLabel}. On-chain oracle read; not the vault's execution price.`;
      case "price":
        return `${object.label}: $${object.data.price}. ${object.provenance.label}. Observed ${object.provenance.observedAt}.`;
      case "vault":
        return `${object.label}: ${object.data.paused ? "paused" : "spending enabled"}, ${object.data.balance} ETH${object.data.ccipTokens !== undefined ? `, ${object.data.ccipTokens} CCIP-BnM` : ""}. ${object.provenance.label}.`;
      case "reading":
        return `${object.label}: ${object.data.display}, ${object.data.ageLabel}, from ${object.data.address} on ${NETWORKS[(object.data.network ?? DEFAULT_FEED_NETWORK) as Network].label}. On-chain read; execution reads it again.`;
      case "condition":
        return `${object.label}${object.data.root ? " is the policy's root condition" : object.data.logic ? " combines the conditions under it" : object.data.math ? " is a computed value" : ""}. Part of revision ${w.revision}: ${w.summary}`;
      case "action":
        return `${object.label}. ${w.created ? this.executionNotes(w.graph, w.maxAgeSeconds, false) : ""}`.trim();
      default:
        return `${object.label}: ${object.provenance.label}${object.provenance.url ? ` (${object.provenance.url})` : ""}.`;
    }
  }
  /** Fixture vault cards carry the in-memory treasury balances that fixture actions change. */
  fixtureVault(vault: GraphObject): GraphObject {
    if (!vault.data.fixture) return vault;
    return { ...vault, data: { ...vault.data, balance: String(round9(this.fixtureBalanceEth)), balanceEth: round9(this.fixtureBalanceEth), ccipTokens: round9(this.fixtureTokens), reserveEth: round9(this.fixtureReserveEth) } };
  }
  watchSentence(): string {
    const watch = this.state.watch;
    if (!watch) return "";
    if (watch.status === "watching")
      return ` Watching revision ${watch.revision} every ${watch.everySeconds}s: check ${watch.checks} of ${watch.maxChecks}${watch.lastOutcome ? `, last ${watch.lastOutcome}` : ""}.`;
    return ` The last watch (revision ${watch.revision}) stopped: ${watch.stopReason ?? "stopped"}.`;
  }
  /** Freezes a revision into a new queued run. */
  startRun(revision: WorkflowRevision, options: { trigger: "manual" | "watch"; watchCheck?: number; prompt: string }): ExecutionRun {
    const snapshot = clone(revision);
    snapshot.policyHash ??= policyHash(snapshot.graph, snapshot.maxAgeSeconds ?? DEFAULT_EXCHANGE_MAX_AGE_SECONDS);
    const run: ExecutionRun = {
      id: `run-${crypto.randomUUID()}`,
      revision: snapshot.revision,
      snapshot,
      policyHash: snapshot.policyHash,
      action: snapshot.graph.action.type,
      trigger: options.trigger,
      ...(options.watchCheck ? { watchCheck: options.watchCheck } : {}),
      status: "queued",
      startedAt: now(),
      executionMode: "Preparing execution",
      decisions: [],
      logs: [{ at: now(), stage: "queued", message: options.trigger === "watch" ? `Watch check ${options.watchCheck}: frozen revision ${snapshot.revision}` : `Frozen draft revision ${snapshot.revision}` }],
    };
    this.state.runs.unshift(run);
    this.state.activity = { status: "executing", prompt: options.prompt, summary: `Running revision ${snapshot.revision}` };
    return run;
  }
  /** Runs work inside the operation queue, after anything already queued. */
  enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => {});
    return result;
  }
  stopWatch(reason: string) {
    this.cancelWatch?.();
    this.cancelWatch = undefined;
    const watch = this.state.watch;
    if (watch?.status === "watching") Object.assign(watch, { status: "stopped", stopReason: reason, nextCheckAt: undefined });
  }
  scheduleWatch(ms: number) {
    this.cancelWatch?.();
    const watch = this.state.watch;
    if (!watch || watch.status !== "watching") return;
    watch.nextCheckAt = new Date(Date.now() + ms).toISOString();
    const id = watch.id;
    this.cancelWatch = this.sources.schedule(() => void this.tickWatch(id), ms);
  }
  /**
   * One check of the standing policy: a fresh run of its frozen revision.
   * Checks never overlap a running execution; the watch stops after it acts
   * (unless told not to), after three failures in a row, or after its last check.
   */
  async tickWatch(watchId = this.state.watch?.id): Promise<ExecutionRun | undefined> {
    const started = await this.enqueue(() => {
      const watch = this.state.watch;
      if (!watch || watch.id !== watchId || watch.status !== "watching") return undefined;
      if (this.state.runs.some((x) => x.uncertain)) {
        this.stopWatch("A restart left a run's outcome unknown; inspect it with get_run before watching again");
        this.commit();
        return undefined;
      }
      if (this.state.runs.some((x) => !TERMINAL.includes(x.status))) {
        this.scheduleWatch(Math.min(5000, watch.everySeconds * 1000));
        return undefined;
      }
      watch.checks++;
      const run = this.startRun(watch.snapshot, { trigger: "watch", watchCheck: watch.checks, prompt: `Watch check ${watch.checks} of ${watch.maxChecks}` });
      watch.lastRunId = run.id;
      watch.nextCheckAt = undefined;
      this.commit();
      return { run, sessionId: this.state.sessionId, watch };
    });
    if (!started) return undefined;
    await this.execute(started.run.id, started.sessionId, { quiet: true, cron: { schedule: cronEvery(started.watch.everySeconds) } });
    return this.enqueue(() => {
      const watch = this.state.watch;
      const run = this.state.runs.find((x) => x.id === started.run.id);
      if (!watch || watch.id !== started.watch.id || watch.status !== "watching" || !run || this.state.sessionId !== started.sessionId) return run;
      const outcome = run.status === "confirmed" ? this.completionSummary(run) : run.status === "no-op" ? `no action: ${run.noopReason ?? "nothing to do"}` : `failed: ${run.error}`;
      watch.lastOutcome = outcome;
      watch.consecutiveFailures = run.status === "failed" ? watch.consecutiveFailures + 1 : 0;
      const stop = run.status === "confirmed" && watch.stopOnAction ? `acted on check ${watch.checks}. ${outcome}`
        : watch.consecutiveFailures >= 3 ? `stopped after 3 failed checks in a row; last ${outcome}`
        : watch.checks >= watch.maxChecks ? `finished all ${watch.maxChecks} checks; last ${outcome}`
        : undefined;
      if (stop) {
        this.stopWatch(stop);
        this.say(`Watch on revision ${watch.revision} ${stop}`);
        this.state.activity = { status: run.status === "failed" ? "error" : "idle", prompt: this.state.activity.prompt, summary: `Watch on revision ${watch.revision} ${stop}` };
      } else {
        this.scheduleWatch(watch.everySeconds * 1000);
        // Quiet checks stay out of the conversation; actions and failures are said.
        if (run.status !== "no-op") this.say(`Watch check ${watch.checks}: ${outcome}`);
        this.state.activity = { status: "idle", prompt: this.state.activity.prompt, summary: `Watching revision ${watch.revision}: check ${watch.checks} of ${watch.maxChecks}, ${outcome}. Next check in ${watch.everySeconds}s.` };
      }
      this.commit();
      return run;
    });
  }
  /** Reads any contract-backed source for execution and refreshes its canvas card with the same read. */
  async readChainSource(source: ChainSource): Promise<Observation> {
    if (source.type === "chainlink-feed") return this.readFeed(source);
    const object = await this.sources.fetchReading(source);
    this.object(object);
    return readingObservation(object, source);
  }
  /** The frozen request every runner receives for this run. */
  specFor(run: ExecutionRun): ExecutionSpecification {
    const graph = run.snapshot.graph;
    return {
      version: 2,
      runId: run.id,
      revision: run.revision,
      graph,
      policyHash: run.snapshot.policyHash ?? policyHash(graph, run.snapshot.maxAgeSeconds ?? DEFAULT_EXCHANGE_MAX_AGE_SECONDS),
      maxAgeSeconds: run.snapshot.maxAgeSeconds ?? 60,
      broadcast: true,
    };
  }
  /** Reads a feed for execution and refreshes its canvas card with the same read. */
  async readFeed(source: FeedSource): Promise<Observation> {
    const object = await this.sources.fetchFeedPrice(source.symbol, source.network);
    this.object(object);
    return feedObservation(object, source);
  }
  /** No deployed vault: live inputs, the shared evaluator, and an in-memory vault. */
  fixtureEnvironment(): PolicyEnvironment {
    return {
      mode: "fixture-rehearsal",
      readVault: async (options) => {
        const vault = this.fixtureVault(await this.sources.fetchVault(this.fixturePaused));
        if (!vault.data.fixture)
          throw new Error("Real contract configured but no runner deployment is available; execution prevented");
        this.object(vault);
        return {
          address: "fixture", chainId: 0, paused: Boolean(vault.data.paused), balanceWei: toWei(this.fixtureBalanceEth), reportVersion: REPORT_VERSION,
          ...(options?.tokenBalance ? { tokenBalance: toWei(this.fixtureTokens) } : {}),
        };
      },
      readSource: async (source) => {
        if (source.type !== "exchange-trade") return this.readChainSource(source);
        const price = await this.sources.fetchPrice("ETH");
        this.observePrice(price);
        return exchangeObservation(price);
      },
      referencePrice: (symbol) =>
        this.readFeed({ type: "chainlink-feed", symbol: symbol as FeedSource["symbol"], network: DEFAULT_FEED_NETWORK }),
      fixtureAct: async (action: VaultAction) => {
        const effects: FixtureEffects = {};
        if (action.type === "pay") {
          if (this.fixturePaused) throw new Error("Fixture vault spending is paused; no payment");
          this.fixtureBalanceEth = round9(this.fixtureBalanceEth - action.amountEth);
          Object.assign(effects, { paidEth: action.amountEth, payee: action.payee });
        }
        if (actionPauses(action)) {
          this.fixturePaused = true;
          effects.paused = true;
        }
        if (action.type === "sweep") {
          const moved = round9(this.fixtureBalanceEth * toBps(action.fraction) / 10_000);
          this.fixtureBalanceEth = round9(this.fixtureBalanceEth - moved);
          this.fixtureReserveEth = round9(this.fixtureReserveEth + moved);
          effects.sweptEth = moved;
        }
        if (action.type === "evacuate") {
          const moved = round9(this.fixtureTokens * toBps(action.fraction) / 10_000);
          this.fixtureTokens = round9(this.fixtureTokens - moved);
          effects.evacuatedTokens = moved;
        }
        this.object(this.fixtureVault(await this.sources.fetchVault(this.fixturePaused)));
        return effects;
      },
    };
  }
  async execute(runId: string, sessionId: string, options: { quiet?: boolean; cron?: { schedule: string } } = {}) {
    const run = this.state.runs.find((x) => x.id === runId);
    if (!run || this.state.sessionId !== sessionId) return;
    const mark = (stage: ExecutionRun["status"], message: string) => {
      if (this.state.sessionId !== sessionId) return;
      run.status = stage;
      run.logs.push({ at: now(), stage, message });
      this.state.activity = {
        status: "executing",
        prompt: "Run this version",
        summary: message,
      };
      this.commit();
    };
    const progress = (message: string) =>
      mark(
        /report|deliver|transaction|Confirmed|SIMULATED|Fixture vault paused/i.test(message)
          ? "reporting"
          : /PASS|STOP|No action|evaluat/i.test(message)
            ? "evaluating"
            : "fetching",
        message,
      );
    try {
      mark("fetching", "Fetching fresh execution inputs");
      const spec = this.specFor(run);
      const deployment = await this.sources.loadDeployment();
      const result = deployment
        ? await this.sources.executeRun(spec, progress, {
            resolveFeed: (source) => this.readFeed(source),
            resolveSource: (source) => this.readChainSource(source),
            ...(options.cron ? { trigger: "cron" as const, schedule: options.cron.schedule } : {}),
          })
        : await executePolicy(spec, this.fixtureEnvironment(), progress);
      await this.applyResult(run, result, deployment);
      run.completedAt = now();
      if (!options.quiet) {
        this.state.activity = {
          status: "idle",
          prompt: this.state.activity.prompt,
          summary: this.completionSummary(run),
        };
        this.say(this.state.activity.summary);
      }
      this.commit();
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = now();
      if (run.executionMode === "Preparing execution") run.executionMode = "Not executed";
      run.logs.push({ at: now(), stage: "failed", message: run.error });
      if (!options.quiet) {
        this.state.activity = {
          status: "error",
          prompt: this.state.activity.prompt,
          summary: run.error,
        };
        this.say(`Execution failed: ${run.error}`);
      }
      this.commit();
    }
  }
  completionSummary(run: ExecutionRun): string {
    const v = `Revision ${run.revision}`;
    if (run.status === "no-op") return `${v}: no action. ${run.noopReason ?? ""}`.trim();
    const evidence = run.evidence;
    if (evidence?.simulatedOrder)
      return `${v}: simulated sell of ${evidence.simulatedOrder.amount} ${evidence.simulatedOrder.symbol}; no transaction, no asset moved.`;
    if (evidence?.simulatedRebalance)
      return `${v}: simulated rebalance of ${toBps(evidence.simulatedRebalance.fraction) / 100}% ${evidence.simulatedRebalance.asset} from ${evidence.simulatedRebalance.from} to ${evidence.simulatedRebalance.to}; no transaction, no asset moved.`;
    if (evidence?.fixture) {
      const effects = evidence.fixtureEffects;
      const parts = [
        effects?.sweptEth !== undefined && `swept ${effects.sweptEth} ETH to the reserve`,
        effects?.paidEth !== undefined && `paid ${effects.paidEth} ETH to the ${effects.payee}`,
        effects?.evacuatedTokens !== undefined && `queued ${effects.evacuatedTokens} CCIP-BnM for CCIP`,
        (effects?.paused ?? evidence.pausedAfter) && "paused",
      ].filter(Boolean);
      return parts.length === 1 && parts[0] === "paused" ? `${v}: fixture vault paused in memory; no transaction.` : `${v}: fixture vault ${parts.join(" and ")} in memory; no transaction.`;
    }
    if (evidence?.transactionHash) {
      const effects = evidence.effects;
      const block = `at block ${evidence.blockNumber}`;
      const solana = evidence.solana?.verified ? evidence.solana.action === "sweep" ? " The Solana vault swept to its reserve in the same decision." : " The Solana vault was paused by the same decision." : "";
      const paused = effects?.paused ? " and paused spending" : "";
      if (run.action === "sweep" && effects?.sweptWei)
        return `${v}: swept ${Number(effects.sweptWei) / 1e18} ETH to the reserve${paused} ${block}, verified by receipt, ReserveSwept event and a fresh read.${solana}`;
      if (run.action === "pay" && effects?.paidWei)
        return `${v}: paid ${Number(effects.paidWei) / 1e18} ETH to ${effects.payee} ${block}, verified by receipt and GrantStreamed event.`;
      if (run.action === "evacuate" && effects?.ccipMessageId)
        return `${v}: sent ${Number(effects.ccipAmount) / 1e18} CCIP-BnM to the reserve via CCIP${paused} ${block} (message ${effects.ccipMessageId}); delivery on the destination takes about 20 minutes.${solana}`;
      return `${v}: vault paused ${block}, verified by receipt, receiver event and a fresh read.${solana}`;
    }
    return `${v}: ${run.executionMode}`;
  }
  /** Maps runner evidence onto the run record and the canvas. Throws if a claimed action is not verified. */
  async applyResult(run: ExecutionRun, result: ExecutionEvidence, deployment: Deployment | null) {
    if (result.runId !== run.id || result.revision !== run.revision || result.policyHash !== (run.snapshot.policyHash ?? run.policyHash))
      throw new Error("Runner evidence does not match this run's identity and policy hash");
    run.executionMode =
      result.mode === "cre-local-simulation"
        ? deployment?.chainId === 11155111
          ? "CRE local simulation · Sepolia broadcast"
          : "CRE local simulation · local EVM"
        : result.mode === "local-evm-rehearsal"
          ? "Local EVM rehearsal · no CRE consensus"
          : "Local policy rehearsal · fixture vault · no transaction";
    run.policyHash = result.policyHash;
    run.action = result.action;
    run.observations = result.observations;
    run.decisions = result.conditions.map((c) => ({
      id: c.kind,
      label: c.kind,
      passed: c.passed,
      detail: c.detail,
      nodeId: c.nodeId,
      role: c.role,
    }));
    if (result.noopReason) run.noopReason = result.noopReason;
    // Canvas compatibility: the exchange trade and vault as runner inputs.
    const exchange = result.observations.find((o) => o.provider === "coinbase");
    if (result.trigger === "cron") run.logs.push({ at: now(), stage: "evaluating", message: "Evaluated by the CRE workflow's cron trigger" });
    const priorPrice = this.state.objects.find((x) => x.id === "price:eth-usd");
    const priorVault = this.state.objects.find((x) => x.id === "vault:grant");
    let executionPrice: GraphObject | undefined;
    if (exchange && priorPrice) {
      const { input, canvas } = buildExecutionPrice(
        priorPrice,
        { usd: exchange.usd ?? exchange.value, observedAt: exchange.observedAt, source: exchange.url ?? exchange.label },
        now(),
      );
      executionPrice = input;
      this.object(canvas);
    }
    let executionVault: GraphObject | undefined;
    if (priorVault && result.vault) {
      executionVault =
        result.mode === "fixture-rehearsal"
          ? clone(priorVault)
          : {
              ...clone(priorVault),
              data: {
                ...clone(priorVault.data),
                paused: result.vault.paused,
                balanceWei: result.vault.balanceWei,
                address: result.vault.address,
                chainId: result.vault.chainId,
              },
              provenance: {
                ...priorVault.provenance,
                address: result.vault.address,
                chainId: result.vault.chainId,
                fetchedAt: now(),
              },
            };
    }
    if (executionPrice && executionVault) run.inputs = { price: executionPrice, vault: executionVault };
    if (result.transaction) {
      const tx = result.transaction;
      run.evidence = {
        transactionHash: tx.hash,
        blockNumber: String(tx.blockNumber),
        receiptStatus: tx.status,
        pausedAfter: tx.pausedAfter,
        chainId: result.vault?.chainId,
        contractAddress: result.vault?.address,
        policyHash: result.policyHash,
        ...(tx.effects ? { effects: tx.effects } : {}),
        ...(tx.effects?.ccipExplorerUrl ? { ccipExplorerUrl: tx.effects.ccipExplorerUrl } : {}),
        verification: tx.effects
          ? `Receipt, receiver events (run, revision, policy hash) and fresh state confirmed: ${describeEffects(tx.effects)}`
          : tx.receiverConfirmed
            ? "Receipt, receiver event (run, revision, policy hash) and fresh paused() read confirmed"
            : "Receiver confirmation unavailable",
        ...(result.vault?.chainId === 11155111
          ? { explorerUrl: `${NETWORKS["ethereum-sepolia"].explorer}/tx/${tx.hash}` }
          : {}),
      };
      if (result.solana)
        run.evidence.solana = {
          network: result.solana.network, programId: result.solana.programId, vault: result.solana.vault,
          signature: result.solana.signature, verified: Boolean(result.solana.verified),
          ...(result.solana.slot !== undefined ? { slot: result.solana.slot } : {}),
          ...(result.solana.explorerUrl ? { explorerUrl: result.solana.explorerUrl } : {}),
          ...(result.solana.action ? { action: result.solana.action } : {}),
          ...(result.solana.reserve ? { reserve: result.solana.reserve } : {}),
          ...(result.solana.sweptLamports !== undefined ? { sweptLamports: result.solana.sweptLamports } : {}),
        };
      if (result.solanaSkipped) run.evidence.solanaSkipped = result.solanaSkipped;
      const failures = effectFailures(run.snapshot.graph.action as VaultAction, tx);
      if (failures.length)
        throw new Error(`Report transaction did not verify: ${failures.join("; ")}`);
      run.status = "confirmed";
      // Refresh display provenance independently of already verified execution.
      try {
        this.object(this.fixtureVault(await this.sources.fetchVault(this.fixturePaused)));
      } catch (error) {
        run.logs.push({ at: now(), stage: "display", message: `Verified post-report state retained; display refresh unavailable: ${String(error)}` });
      }
    } else if (result.simulatedOrder) {
      // A mock sell produces no transaction by design, and says so.
      run.evidence = {
        simulatedOrder: result.simulatedOrder,
        verification: "Simulated order; no transaction and no asset moved",
      };
      run.status = "confirmed";
    } else if (result.simulatedRebalance) {
      run.evidence = {
        simulatedRebalance: result.simulatedRebalance,
        verification: "Simulated rebalance; no transaction and no asset moved",
      };
      run.status = "confirmed";
    } else if (result.fixture || result.fixturePaused) {
      run.evidence = {
        pausedAfter: Boolean(result.fixture?.paused ?? result.fixturePaused) || this.fixturePaused,
        fixture: true,
        ...(result.fixture ? { fixtureEffects: result.fixture } : {}),
        verification: "Local fixture changed only · no deployed contract or transaction",
      };
      run.status = "confirmed";
    } else if (result.dryRun) {
      run.noopReason = "Dry run: the policy passed; no report was submitted.";
      run.status = "no-op";
    } else {
      if (result.decision === "act") throw new Error("Action decision returned without verified evidence");
      run.status = "no-op";
    }
    if (executionVault && result.mode !== "fixture-rehearsal" && !result.transaction) this.object(executionVault);
    this.state.capabilities.execution = run.executionMode;
    const vaultObject = this.state.objects.find((x) => x.id === "vault:grant");
    if (vaultObject) this.state.capabilities.vault = vaultObject.provenance.label;
  }
}
