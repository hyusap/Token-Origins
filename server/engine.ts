import type {
  CanvasState,
  ExecutionRun,
  GraphObject,
  ToolResult,
  WorkflowRevision,
} from "../shared/types";
import { StateStore } from "./store";
import { buildExecutionPrice } from "./execution-price";
import { fetchPrice, fetchVault, loadDeployment } from "./sources";
import {
  fetchFeedPrice,
  listFeedSymbols,
  resolveFeedSymbol,
  feedId,
  CHAINLINK_FEEDS,
} from "./chainlink";
import {
  legacyGraph,
  describeGraph,
  validateGraph,
  collectSources,
  describeSource,
  isLegacyShape,
  type PolicyGraph,
} from "../cre/graph";
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
});
export function emptyState(): CanvasState {
  return {
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
      ...sources,
    };
    this.store = store;
    this.state = store.load() || emptyState();
    this.fixturePaused = Boolean(
      this.state.objects.find((x) => x.id === "vault:grant" && x.data.fixture)
        ?.data.paused,
    );
    let interruptedRun = false;
    for (const run of this.state.runs)
      if (!["confirmed", "failed", "no-op"].includes(run.status)) {
        interruptedRun = true;
        run.status = "failed";
        run.error =
          "Backend restarted during execution; inspect chain before retrying";
        run.completedAt = now();
      }
    this.state.activity = {
      ...this.state.activity,
      status: interruptedRun ? "error" : "idle",
      summary: interruptedRun
        ? "Backend restarted during execution; inspect chain before retrying"
        : this.state.activity.summary,
    };
    this.store.save(this.state);
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
        (x) => x.id === feedId(feed.symbol),
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
      this.object({
        id: "action:pause",
        kind: "action",
        label: "Pause spending",
        data: { target: "vault:grant" },
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
                : feedId(priceNode.source.symbol),
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
        label: "pauses",
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
          const symbols = listFeedSymbols();
          summary = `Chainlink mainnet feeds available: ${symbols
            .map((x) => `${x} (${CHAINLINK_FEEDS[x]!.name})`)
            .join(", ")}.`;
          break;
        }
        case "read_price_feed": {
          const requested = String(args.symbol ?? "").trim();
          const feed = resolveFeedSymbol(requested);
          if (!feed)
            throw new Error(
              `No Chainlink mainnet feed is configured for "${requested}". Available: ${listFeedSymbols().join(", ")}`,
            );
          const object = await this.sources.fetchFeedPrice(feed.symbol);
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
            )} per the Chainlink ${object.data.description} feed on Ethereum mainnet, ` +
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
              this.object(await this.sources.fetchFeedPrice(object.data.symbol));
            } else this.object(await this.sources.fetchVault(this.fixturePaused));
          const current = this.state.objects.find((x) => x.id === object.id)!;
          summary =
            current.kind === "feed"
              ? `${current.label}: $${current.data.price} from the Chainlink aggregator at ${current.data.feedAddress} on Ethereum mainnet, round ${current.data.roundId} written ${current.data.ageLabel}. On-chain oracle read; not the vault's execution price.`
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
          summary = `Revision ${w.revision}. ${describeGraph(w.graph)} Execution fetches ${sources.join(" and ")}, and always keeps the receiver freshness cap plus the already-paused no-op.`;
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
          // mistyped operands and any source outside the allowlist.
          const { graph } = validateGraph(args.graph);
          const threshold =
            graph.nodes.find(
              (node): node is Extract<PolicyGraph["nodes"][number], { kind: "compare" }> =>
                node.kind === "compare",
            )?.value ?? w.threshold;
          const revision: WorkflowRevision = {
            revision: w.revision + 1,
            threshold,
            maxAgeSeconds: w.maxAgeSeconds,
            skipPaused: w.skipPaused,
            createdAt: now(),
            reason: args.reason || "Composed condition graph",
            graph,
          };
          w.revisions.push(revision);
          Object.assign(w, revision, { created: true });
          this.state.mode = "compose";
          this.updateGraph();
          this.focus(w.id, "Treasury policy");
          const sources = collectSources(graph).map(describeSource);
          summary = `Revision ${w.revision}. ${describeGraph(graph)} Execution fetches ${sources.join(" and ")}.`;
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
          const prior = this.state.runs.find(
            (x) => x.revision === w.revision && x.status !== "failed",
          );
          if (prior) {
            runId = prior.id;
            this.selectRun(prior);
            summary = `Revision ${w.revision} already has run ${prior.id}; returning it without duplicate execution.`;
            break;
          }
          const snapshot = clone(w.revisions.at(-1)!);
          runId = `run-${crypto.randomUUID()}`;
          const run: ExecutionRun = {
            id: runId,
            revision: w.revision,
            snapshot,
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
          runId = run.id;
          this.selectRun(run);
          summary = `Run revision ${run.revision}: ${run.status}. ${run.error || run.logs.at(-1)?.message || ""}`;
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
          this.state = clone(archived);
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
    try {
      mark("fetching", "Fetching fresh execution inputs");
      const runnerFile = Bun.file(new URL("../cre/runner.ts", import.meta.url));
      const deployment = await this.sources.loadDeployment();
      if (deployment && (await runnerFile.exists())) {
        const { executeCreRun } = await import("../cre/runner");
        const result = await executeCreRun(
          {
            runId,
            revision: run.revision,
            thresholdUsd: run.snapshot.threshold,
            maxAgeSeconds: run.snapshot.maxAgeSeconds ?? 60,
            requireFresh: true,
            skipIfPaused: run.snapshot.skipPaused,
            broadcast: true,
            graph: run.snapshot.graph,
          },
          (event: any) => {
            const message =
              typeof event === "string"
                ? event
                : event.message || String(event);
            mark(
              /report|deliver|transaction|Confirmed/i.test(message)
                ? "reporting"
                : /PASS|STOP|condition|evaluat/i.test(message)
                  ? "evaluating"
                  : "fetching",
              message,
            );
          },
          async (symbol: string) => {
            const object = await this.sources.fetchFeedPrice(symbol);
            return {
              usd: Number(object.data.price),
              observedAt: object.provenance.observedAt,
            };
          },
        );
        run.executionMode =
          result.mode === "cre-local-simulation"
            ? deployment.chainId === 11155111
              ? "CRE local simulation · Sepolia broadcast"
              : "CRE local simulation · local EVM"
            : "Local EVM rehearsal · no CRE consensus";
        const priorPrice = this.state.objects.find(
          (x) => x.id === "price:eth-usd",
        )!;
        const priorVault = this.state.objects.find(
          (x) => x.id === "vault:grant",
        )!;
        const { input: executionPrice, canvas: price } = buildExecutionPrice(
          priorPrice,
          result.price,
          now(),
        );
        const executionVault: GraphObject = {
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
        let vault = clone(executionVault);
        if (result.transaction?.pausedAfter) vault.data.paused = true;
        run.inputs = { price: executionPrice, vault: executionVault };
        run.decisions = result.conditions.map((x: any) => ({
          id: x.kind,
          label: x.kind,
          passed: x.passed,
          detail: x.detail,
          nodeId: x.nodeId,
        }));
        if (result.transaction) {
          const tx = result.transaction;
          run.evidence = {
            transactionHash: tx.hash,
            blockNumber: String(tx.blockNumber),
            receiptStatus: tx.status,
            pausedAfter: tx.pausedAfter,
            chainId: result.vault.chainId,
            contractAddress: result.vault.address,
            verification: tx.receiverConfirmed
              ? "Receiver event and paused state confirmed"
              : "Receiver confirmation unavailable",
            ...(result.vault.chainId === 11155111
              ? { explorerUrl: `https://sepolia.etherscan.io/tx/${tx.hash}` }
              : {}),
          };
          if (
            !tx.receiverConfirmed ||
            !tx.pausedAfter ||
            !["success", "confirmed", 1, "0x1"].includes(tx.status as any)
          )
            throw new Error(
              "Report transaction did not verify receiver execution and paused state",
            );
          run.status = "confirmed";
        } else if (result.simulatedOrder) {
          // A mock sell produces no transaction by design. It is recorded as
          // evidence and labelled simulated wherever it is shown.
          run.evidence = {
            simulatedOrder: result.simulatedOrder,
            verification: "Simulated order; no transaction and no asset moved",
          };
          run.status = "confirmed";
        } else {
          if (result.decision === "pause")
            throw new Error(
              "Pause decision returned without verified report transaction",
            );
          run.status = "no-op";
        }
        for (const message of result.logs)
          run.logs.push({ at: now(), stage: "runner", message });
        if (result.transaction) {
          // Refresh display provenance independently of already verified execution.
          // A presentation refresh must never erase confirmed transaction evidence.
          try {
            vault = await this.sources.fetchVault(this.fixturePaused);
          } catch (error) {
            run.logs.push({
              at: now(),
              stage: "display",
              message: `Verified post-report state retained; display refresh unavailable: ${String(error)}`,
            });
          }
        }
        this.object(vault);
        this.object(price);
        this.state.capabilities.execution = run.executionMode;
        this.state.capabilities.vault = vault.provenance.label;
      } else {
        run.executionMode =
          "Local policy rehearsal · fixture vault · no transaction";
        const [price, vault] = await Promise.all([
          this.sources.fetchPrice(),
          this.sources.fetchVault(this.fixturePaused),
        ]);
        if (!vault.data.fixture)
          throw new Error(
            "Real contract configured but CRE runner is unavailable; execution prevented",
          );
        run.inputs = { price: clone(price), vault: clone(vault) };
        this.object(price);
        this.object(vault);
        mark(
          "evaluating",
          "Evaluating immutable rule against actual exchange trade and explicit fixture state",
        );
        const age =
          (Date.now() - Date.parse(price.provenance.observedAt)) / 1000;
        run.decisions = [
          {
            id: "threshold",
            label: "ETH below threshold",
            passed: price.data.price < run.snapshot.threshold,
            detail: `$${price.data.price} < $${run.snapshot.threshold}`,
          },
          {
            id: "freshness",
            label: "Observation fresh",
            passed: age >= 0 && age <= (run.snapshot.maxAgeSeconds ?? 60),
            detail: `${age.toFixed(1)} seconds old; maximum ${run.snapshot.maxAgeSeconds ?? 60}s (safety default)`,
          },
          {
            id: "unpaused",
            label: "Vault spending enabled",
            passed: !vault.data.paused,
            detail: vault.data.paused
              ? "Already paused: skip the action"
              : "Vault is not paused",
          },
        ];
        if (run.decisions.every((x) => x.passed)) {
          mark(
            "reporting",
            "Rehearsing pause in local fixture state; no report transaction",
          );
          this.fixturePaused = true;
          const updated = await this.sources.fetchVault(true);
          this.object(updated);
          run.status = "confirmed";
          run.evidence = {
            pausedAfter: true,
            verification:
              "Local fixture changed only · no deployed contract or transaction",
          };
          run.logs.push({
            at: now(),
            stage: "confirmed",
            message:
              "Fixture spending paused. No blockchain execution was performed.",
          });
        } else {
          run.status = "no-op";
          run.logs.push({
            at: now(),
            stage: "no-op",
            message: `No action. ${run.decisions
              .filter((x) => !x.passed)
              .map((x) => x.detail)
              .join("; ")}`,
          });
        }
      }
      run.completedAt = now();
      this.state.activity = {
        status: "idle",
        prompt: this.state.activity.prompt,
        summary:
          run.status === "confirmed"
            ? `Revision ${run.revision}: ${run.executionMode}`
            : `Revision ${run.revision}: no action`,
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
}
