import type {
  CanvasState,
  ExecutionRun,
  GraphObject,
  ToolResult,
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
  describeGraph,
  describeAction,
  validateGraph,
  collectSources,
  describeSource,
  isLegacyShape,
  policyHash,
  sourceIdentity,
  NETWORKS,
  DEFAULT_FEED_NETWORK,
  REPORT_VERSION,
  type FeedSource,
  type Network,
  type Observation,
  type PolicyGraph,
} from "../cre/graph";
import type { ExecutionSpecification } from "../cre/spec";
import {
  executeCreRun,
  executePolicy,
  findSubmittedPause,
  type ExecutionEvidence,
  type PolicyEnvironment,
} from "../cre/runner";
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
/** Archive form of an exchange trade object. */
export function exchangeObservation(object: GraphObject): Observation {
  return {
    ...sourceIdentity({ type: "exchange-trade", pair: "ETH-USD" }),
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
}
export class Engine {
  state: CanvasState;
  store: StateStore;
  queue: Promise<unknown> = Promise.resolve();
  listeners = new Set<(state: CanvasState) => void>();
  fixturePaused = false;
  sources: EngineSources;
  constructor(store = new StateStore(), sources: Partial<EngineSources> = {}) {
    this.sources = {
      fetchPrice,
      fetchVault,
      loadDeployment,
      fetchFeedPrice,
      executeRun: executeCreRun,
      findSubmittedPause,
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
      (x) => ["price", "source", "vault", "condition", "action"].includes(ref) ? x.kind === ref : x.label.toLowerCase().includes(ref) || x.kind === ref ||
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
      const live = new Set<string>();
      for (const node of w.graph.nodes) {
        if (
          node.kind !== "compare" &&
          node.kind !== "freshness" &&
          node.kind !== "vault-paused"
        )
          continue;
        const id = `condition:${node.id}`;
        live.add(id);
        const source =
          node.kind === "vault-paused"
            ? "vault:grant"
            : describeSource(
                (
                  w.graph.nodes.find(
                    (x) => x.id === (node as { input: string }).input,
                  ) as Extract<PolicyGraph["nodes"][number], { kind: "price" }>
                ).source,
              );
        this.object({
          id,
          kind: "condition",
          label:
            node.kind === "compare"
              ? `${source} ${node.op} $${node.value.toLocaleString("en-US")}`
              : node.kind === "freshness"
                ? `${source} within ${node.maxAgeSeconds}s`
                : `Vault ${node.equals ? "paused" : "active"}`,
          data: { ...node, source },
          visible: true,
          pinned: false,
          provenance,
        });
      }
      this.state.objects = this.state.objects.filter(
        (x) => !x.id.startsWith("condition:") || live.has(x.id),
      );
      // The id stays stable for the canvas; the label and data name the actual action.
      this.object({
        id: "action:pause",
        kind: "action",
        label: describeAction(w.graph.action),
        data: w.graph.action.type === "sell"
          ? { ...w.graph.action, simulated: true }
          : { type: "pause-vault", target: "vault:grant" },
        visible: true,
        pinned: false,
        provenance,
      });
      w.summary = describeGraph(w.graph);
      // Edges describe the composed graph rather than the fixed scalar chain,
      // so none of them point at condition nodes that no longer exist.
      const edges: CanvasState["edges"] = [
        {
          id: "e1",
          from: "source:coinbase",
          to: "price:eth-usd",
          label: "observes",
        },
      ];
      for (const id of live) {
        const node = w.graph.nodes.find((x) => `condition:${x.id}` === id)!;
        if (node.kind !== "vault-paused") {
          const priceNode = w.graph.nodes.find(
            (x) => x.id === (node as { input: string }).input,
          ) as Extract<PolicyGraph["nodes"][number], { kind: "price" }>;
          edges.push({
            id: `in-${node.id}`,
            from:
              priceNode.source.type === "exchange-trade"
                ? "price:eth-usd"
                : feedObjectId(priceNode.source),
            to: id,
            label: node.kind === "compare" ? "compares" : "timestamp",
          });
        }
        edges.push({
          id: `out-${node.id}`,
          from: id,
          to: "action:pause",
          label: "if true",
        });
      }
      edges.push({
        id: "e-act",
        from: "action:pause",
        to: "vault:grant",
        label: w.graph.action.type === "sell" ? "simulated · vault unchanged" : "pauses",
      });
      this.state.edges = edges;
      return;
    }
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
          summary: "Operation ID was reused for a different instruction",
          code: "OPERATION_CONFLICT",
          state: this.context(),
        };
      return { ...existing.result, state: this.context(), duplicate: true };
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
            ...(requested.includes("vault") ? [this.sources.fetchVault(this.fixturePaused)] : []),
          ]);
          const errors: string[] = [];
          const discovered: GraphObject[] = [];
          for (const r of settled) {
            if (r.status === "fulfilled") {
              const object = r.value;
              if (object.kind === "price") this.observePrice(object);
              else this.object(object);
              discovered.push(object);
            } else errors.push(String(r.reason));
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
            throw new Error("That object has not been discovered yet");
          }
          object.visible = true;
          if (args.pin) object.pinned = true;
          this.focus(object.id, object.label);
          summary = `Focused: ${object.label}.`;
          break;
        }
        case "inspect_object": {
          const ref = args.objectId || args.reference || "this";
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
            throw new Error("No focused object to inspect");
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
            } else this.object(await this.sources.fetchVault(this.fixturePaused));
          const current = this.state.objects.find((x) => x.id === object.id)!;
          summary =
            current.kind === "feed"
              ? `${current.label}: $${current.data.price} from the Chainlink aggregator at ${current.data.feedAddress} on ${NETWORKS[(current.data.network ?? DEFAULT_FEED_NETWORK) as Network].label}, round ${current.data.roundId} written ${current.data.ageLabel}. On-chain oracle read; not the vault's execution price.`
              : current.kind === "price"
                ? `${current.label}: $${current.data.price}. ${current.provenance.label}. Observed ${current.provenance.observedAt}.`
                : current.kind === "vault"
                  ? `${current.label}: ${current.data.paused ? "paused" : "spending enabled"}, ${current.data.balance} ETH. ${current.provenance.label}.`
                  : `${current.label}: ${JSON.stringify(current.data)}`;
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
          if (
            !this.state.objects.some((x) => x.id === "price:eth-usd") ||
            !this.state.objects.some((x) => x.kind === "vault")
          )
            throw new Error(
              "Discover ETH/USD price and vault before composing the ETH policy",
            );
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
          revision.policyHash = policyHash(revision.graph);
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
          const sources = collectSources(w.graph).map(describeSource);
          summary = `Revision ${w.revision}. ${describeGraph(w.graph)} Execution fetches ${sources.join(" and ")}, and always enforces each source's freshness cap${w.graph.action.type === "pause-vault" ? " plus the already-paused no-op" : ""}.`;
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
          if (
            !this.state.objects.some((x) => x.kind === "price") ||
            !this.state.objects.some((x) => x.kind === "vault")
          )
            throw new Error(
              "Discover price and vault before composing a policy",
            );
          // validateGraph rejects unknown node kinds, dangling edges, cycles,
          // mistyped operands, orphan nodes, unregistered feeds and oversized
          // fetch plans. Nothing about execution depends on node order: the
          // receiver gets the structural policy hash, not a picked threshold.
          const { graph } = validateGraph(args.graph);
          const compare = graph.nodes.find((node) => node.id === graph.root);
          const revision: WorkflowRevision = {
            revision: w.revision + 1,
            // The scalar field only describes the legacy single-compare shape.
            threshold: isLegacyShape(graph) && compare?.kind === "compare" ? compare.value : w.threshold,
            maxAgeSeconds: w.maxAgeSeconds,
            skipPaused: w.skipPaused,
            createdAt: now(),
            reason: args.reason || "Composed condition graph",
            graph,
            policyHash: policyHash(graph),
          };
          w.revisions.push(revision);
          Object.assign(w, revision, { created: true });
          this.state.mode = "compose";
          this.updateGraph();
          this.focus(w.id, "Treasury policy");
          const sources = collectSources(graph).map(describeSource);
          summary = `Revision ${w.revision}. ${describeGraph(graph)} Execution fetches ${sources.join(" and ")}.${graph.action.type === "sell" ? " The sell is simulated and runs only in local rehearsal; no asset moves." : ""}`;
          break;
        }
        case "undo_revision": {
          const w = this.state.workflow;
          if (args.expectedRevision !== w.revision)
            throw Object.assign(
              new Error("Draft changed; refresh context before undoing"),
              { code: "REVISION_CONFLICT" },
            );
          if (w.revisions.length < 2)
            throw new Error("No prior composed revision to restore");
          const target = w.revisions.at(-2)!;
          const revision = {
            ...target,
            revision: w.revision + 1,
            createdAt: now(),
            reason: `Restore revision ${target.revision}`,
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
              new Error("Draft changed; run the explicit current revision"),
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
          const snapshot = clone(w.revisions.at(-1)!);
          snapshot.policyHash ??= policyHash(snapshot.graph);
          runId = `run-${crypto.randomUUID()}`;
          const run: ExecutionRun = {
            id: runId,
            revision: w.revision,
            snapshot,
            policyHash: snapshot.policyHash,
            action: snapshot.graph.action.type,
            status: "queued",
            startedAt: now(),
            executionMode: "Preparing execution",
            decisions: [],
            logs: [
              {
                at: now(),
                stage: "queued",
                message: `Frozen draft revision ${w.revision}`,
              },
            ],
          };
          this.state.runs.unshift(run);
          this.selectRun(run);
          this.state.activity = {
            status: "executing",
            prompt: "Run this version",
            summary: `Running revision ${w.revision}`,
          };
          const sessionId = this.state.sessionId;
          setTimeout(() => void this.execute(runId!, sessionId), 10);
          summary = `Run ${runId} started against immutable revision ${w.revision}.`;
          break;
        }
        case "get_run": {
          const run = args.runId
            ? this.state.runs.find((x) => x.id === args.runId)
            : this.state.runs[0];
          if (!run) throw new Error("No run found");
          if (run.uncertain) await this.reconcile(run);
          runId = run.id;
          this.selectRun(run);
          summary = `Run revision ${run.revision}: ${run.status}${run.uncertain ? " (outcome unknown)" : ""}. ${run.error || run.noopReason || run.logs.at(-1)?.message || ""}`;
          this.state.mode = "run";
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
          if (!this.isBlank()) this.store.archiveSession(this.state);
          const capabilities = clone(this.state.capabilities);
          this.state = emptyState();
          this.state.capabilities = capabilities;
          this.fixturePaused = false;
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
      if (!["set_activity", "submit_utterance"].includes(tool))
        this.say(summary);
      if (!["run_workflow", "submit_utterance", "set_activity"].includes(tool))
        this.state.activity = {
          ...this.state.activity,
          status: "idle",
          summary,
        };
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
      summary = error instanceof Error ? error.message : String(error);
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
  /** The frozen request every runner receives for this run. */
  specFor(run: ExecutionRun): ExecutionSpecification {
    const graph = run.snapshot.graph;
    return {
      version: 2,
      runId: run.id,
      revision: run.revision,
      graph,
      policyHash: run.snapshot.policyHash ?? policyHash(graph),
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
      readVault: async () => {
        const vault = await this.sources.fetchVault(this.fixturePaused);
        if (!vault.data.fixture)
          throw new Error("Real contract configured but no runner deployment is available; execution prevented");
        this.object(vault);
        return { address: "fixture", chainId: 0, paused: Boolean(vault.data.paused), balanceWei: "0", reportVersion: REPORT_VERSION };
      },
      readSource: async (source) => {
        if (source.type === "chainlink-feed") return this.readFeed(source);
        const price = await this.sources.fetchPrice("ETH");
        this.observePrice(price);
        return exchangeObservation(price);
      },
      referencePrice: (symbol) =>
        this.readFeed({ type: "chainlink-feed", symbol: symbol as FeedSource["symbol"], network: DEFAULT_FEED_NETWORK }),
      fixturePause: async () => {
        this.fixturePaused = true;
        this.object(await this.sources.fetchVault(true));
      },
    };
  }
  async execute(runId: string, sessionId: string) {
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
        ? await this.sources.executeRun(spec, progress, { resolveFeed: (source) => this.readFeed(source) })
        : await executePolicy(spec, this.fixtureEnvironment(), progress);
      await this.applyResult(run, result, deployment);
      run.completedAt = now();
      this.state.activity = {
        status: "idle",
        prompt: this.state.activity.prompt,
        summary: this.completionSummary(run),
      };
      this.say(this.state.activity.summary);
      this.commit();
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = now();
      run.logs.push({ at: now(), stage: "failed", message: run.error });
      this.state.activity = {
        status: "error",
        prompt: this.state.activity.prompt,
        summary: run.error,
      };
      this.say(`Execution failed: ${run.error}`);
      this.commit();
    }
  }
  completionSummary(run: ExecutionRun): string {
    const v = `Revision ${run.revision}`;
    if (run.status === "no-op") return `${v}: no action. ${run.noopReason ?? ""}`.trim();
    if (run.evidence?.simulatedOrder)
      return `${v}: simulated sell of ${run.evidence.simulatedOrder.amount} ${run.evidence.simulatedOrder.symbol}; no transaction, no asset moved.`;
    if (run.evidence?.fixture) return `${v}: fixture vault paused in memory; no transaction.`;
    if (run.evidence?.transactionHash)
      return `${v}: vault paused at block ${run.evidence.blockNumber}, verified by receipt, receiver event and a fresh read.${run.evidence.solana?.verified ? " The Solana vault was paused by the same decision." : ""}`;
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
    const priorPrice = this.state.objects.find((x) => x.id === "price:eth-usd");
    const priorVault = this.state.objects.find((x) => x.id === "vault:grant");
    let executionPrice: GraphObject | undefined;
    if (exchange && priorPrice) {
      const { input, canvas } = buildExecutionPrice(
        priorPrice,
        { usd: exchange.usd, observedAt: exchange.observedAt, source: exchange.url ?? exchange.label },
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
        verification: tx.receiverConfirmed
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
        };
      if (!tx.receiverConfirmed || !tx.pausedAfter || !["success", "confirmed", 1, "0x1"].includes(tx.status as any))
        throw new Error("Report transaction did not verify receiver execution and paused state");
      run.status = "confirmed";
      // Refresh display provenance independently of already verified execution.
      try {
        this.object(await this.sources.fetchVault(this.fixturePaused));
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
    } else if (result.fixturePaused) {
      run.evidence = {
        pausedAfter: true,
        fixture: true,
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
