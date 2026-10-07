import { creReadiness } from "./cre-status";
import {createTradeTools} from './trade-tools';
import {resolvePolicyTarget,executeDispatchedPolicy,recoverSolanaPolicy,recoveredSolanaEvidence,type PolicyExecutorDependencies} from './policy-executor';
import {isEvmTarget,isSolanaTarget,sameExecutionTarget,assertSolanaSettlement,type ExecutionTarget} from '../shared/execution-target';
import type {
  CanvasState,
  ExecutionRun,
  FixtureTreasury,
  GraphObject,
  ToolResult,
  WatchState,
  WorkflowRevision,
} from "../shared/types";
import {inspectSolanaWallet,getSolanaDevnetWallet,getSolanaDevnetActionTarget,transferSolanaDevnet,reconcileSolanaDevnetTransfer} from "./solana";
import {PolicyMonitorManager,type PolicyMonitor} from "./monitor";
import { StateStore } from "./store";
import { migrateState, STATE_VERSION } from "./migrate";
import { supportedPolicyCapabilities, VAULT_TRIGGER_RESTRICTION } from "../shared/policy-capabilities";
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
  DEFAULT_EXCHANGE_MAX_AGE_SECONDS,
  MAX_FEED_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  describeGraph,
  describeAction,
  phraseCondition,
  validateGraph,
  collectSources,
  readsVault,
  describeSource,
  isLegacyShape,
  isSourceNode,
  isSimulatedAction,
  actionPauses,
  isVaultAction,
  reportedThreshold,
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
  type VaultTerms,
  payeeId,
  ZERO_ADDRESS,
} from "../cre/graph";
import { LOCAL_PAYEES } from "../cre/local-deploy";
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
const CURRENT_PRICE_CAPABILITY="Coinbase USD markets by exact token name/symbol; ETH also has Kraken fallback";
const CURRENT_VAULT_CAPABILITY="CRE Sepolia receiver · live read required";
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
/** Runs kept in the live state; older ones stay in the executions archive (get_run still finds them). */
export const MAX_LIVE_RUNS = 50;
/** The fixture vault's deploy-time limits, matching the Sepolia vault scripts/deploy-sepolia.ts deploys. */
export const FIXTURE_LIMITS = {
  payees: LOCAL_PAYEES as Record<string, string>,
  maxPaymentEth: 0.002,
  minPaymentIntervalSeconds: 60,
  maxCcipFeeEth: 0.005,
  minEvacuationIntervalSeconds: 300,
};
const defaultFixtureTreasury = (): FixtureTreasury => ({ balanceEth: 0.12, tokens: 2, reserveEth: 0, lastPaymentAt: 0, lastEvacuationAt: 0 });
/** Inside a run, every watch check and the fixture treasury share these. */
const round9 = (value: number) => Math.round(value * 1e9) / 1e9;
const toWei = (eth: number) => (BigInt(Math.round(eth * 1e9)) * 1_000_000_000n).toString();
const READ_ONLY_TOOLS = ["get_context", "get_run", "describe_policy", "list_price_feeds", "list_sources", "list_recipes", "navigate_canvas"];
/** Archive form of an exchange trade object. */
export function exchangeObservation(object: GraphObject): Observation {
  return {
    ...sourceIdentity({ type: "exchange-trade", pair: object.data.productId || object.id.slice(6).toUpperCase() }),
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
      price: CURRENT_PRICE_CAPABILITY,
      vault: CURRENT_VAULT_CAPABILITY,
      execution: "Chainlink CRE · sole execution authority · awaiting a verified run",
      voice: "Browser mic → local Whisper dictation → semantic operator; Codex desktop voice separate/unverified",
      mcp: "Semantic tools · official MCP stdio transport",
      supported: supportedPolicyCapabilities,
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
  solanaTarget:typeof getSolanaDevnetActionTarget;
  solanaTransfer:typeof transferSolanaDevnet;
  solanaRecovery:typeof reconcileSolanaDevnetTransfer;
}
export class Engine {
  state: CanvasState;
  store: StateStore;
  queue: Promise<unknown> = Promise.resolve();
  listeners = new Set<(state: CanvasState) => void>();
  fixturePaused = false;
  /** Fixture treasury: in-memory balances that fixture sweeps, payments and evacuations change. */
  get fixtureTreasury(): FixtureTreasury { return (this.state.fixtureTreasury ??= defaultFixtureTreasury()); }
  get fixtureBalanceEth() { return this.fixtureTreasury.balanceEth; }
  set fixtureBalanceEth(value: number) { this.fixtureTreasury.balanceEth = value; }
  get fixtureTokens() { return this.fixtureTreasury.tokens; }
  set fixtureTokens(value: number) { this.fixtureTreasury.tokens = value; }
  get fixtureReserveEth() { return this.fixtureTreasury.reserveEth; }
  set fixtureReserveEth(value: number) { this.fixtureTreasury.reserveEth = value; }
  /** One execution at a time, whatever started it: a manual run never overlaps a watch check. */
  executions: Promise<unknown> = Promise.resolve();
  cancelWatch?: () => void;
  sources: EngineSources;
  monitors: PolicyMonitorManager;
  tradeTools:ReturnType<typeof createTradeTools>;
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
      solanaTarget:getSolanaDevnetActionTarget,solanaTransfer:transferSolanaDevnet,solanaRecovery:reconcileSolanaDevnetTransfer,
      ...sources,
    };
    this.store = store;
    this.state = migrateState(store.load() as CanvasState) || emptyState();
    this.state.capabilities ??= emptyState().capabilities;
    this.state.capabilities.supported = supportedPolicyCapabilities;
    this.state.capabilities.voice = "Browser mic → local Whisper dictation → semantic operator; Codex desktop voice separate/unverified";
    if(!this.researchExecution) {
      this.state.capabilities.execution="Chainlink CRE · sole product execution authority";
      this.state.capabilities.vault=CURRENT_VAULT_CAPABILITY;
      this.state.capabilities.price=CURRENT_PRICE_CAPABILITY;
    }
    this.fixturePaused = Boolean(
      this.state.objects.find((x) => x.id === "vault:grant" && x.data.fixture)
        ?.data.paused,
    );
    let interruptedRun = false;
    for (const run of this.state.runs) {
      // Older builds could fail after a durable submission while replaying later source logs.
      // Recover that journal read-only even when the last visible stage was fetching/failed.
      if(run.status==='failed'&&!run.evaluationOnly&&run.target&&run.evidence?.receiptStatus==='pending'&&(run.submissionPossible||run.evidence.transactionHash||run.evidence.submittedSignature)) {
        run.uncertain=true;
        run.submissionPossible=true;
        interruptedRun=true;
      }
      if (!TERMINAL.includes(run.status)) {
        // The report may or may not have landed. Never resubmit blindly:
        // hold new runs until the chain answers.
        interruptedRun = true;
        if(run.status === "reporting"&&!run.evaluationOnly) run.submissionPossible=true;
        run.status = "failed";
        run.uncertain = !run.evaluationOnly;
        if(run.evaluationOnly)run.submissionPossible=false;
        run.error = run.evaluationOnly ? "Backend restarted during a CRE evaluation; broadcast was disabled and no report was permitted." : "Backend restarted during execution; checking the chain before allowing a retry";
        run.completedAt = now();
        run.logs.push({ at: now(), stage: "failed", message: run.error });
      }
    }
    const interruptedWrite=this.state.runs.some(run=>run.uncertain);
    // A standing policy never resumes on its own after a restart.
    if (this.state.watch?.status === "watching")
      Object.assign(this.state.watch, { status: "stopped", stopReason: "The backend restarted; call watch_policy again to resume.", nextCheckAt: undefined });
    this.state.activity = {
      ...this.state.activity,
      status: interruptedRun ? "error" : "idle",
      summary: interruptedRun
        ? interruptedWrite ? "Backend restarted during execution; checking the chain before allowing a retry" : "CRE evaluation interrupted; broadcast was disabled"
        : this.state.activity.summary,
    };
    this.store.save(this.state);
    if (interruptedWrite) this.reconcileQueued();
    this.monitors = new PolicyMonitorManager(this.store.db, async (spec,target,progress) => {
      return executeDispatchedPolicy(spec,target,progress,this.policyDependencies());
    },{onChange:monitor => {queueMicrotask(()=>void this.monitorChanged(monitor));}});
    this.state.monitors = this.monitors.list(this.state.sessionId);
    this.tradeTools=createTradeTools({db:this.store.db,onChange:()=>queueMicrotask(()=>{
      if(!this.tradeTools)return;this.state.tradeWatches=this.tradeTools.listWatches(this.state.sessionId);this.commit();
    })});
    this.state.tradeWatches=this.tradeTools.listWatches(this.state.sessionId);
  }
  close(){this.monitors.close();this.tradeTools.close();this.store.db.close();}
  get researchExecution(){return this.sources.fetchVault!==fetchVault||this.sources.executeRun!==executeCreRun||this.sources.solanaTransfer!==transferSolanaDevnet||this.sources.solanaTarget!==getSolanaDevnetActionTarget;}
  policyDependencies():PolicyExecutorDependencies {
    return {research:this.researchExecution,deployment:()=>this.sources.loadDeployment(),resolveFeed:source=>this.readFeed(source),resolveSource:source=>this.readChainSource(source),fetchExchange:async source=>{
      const price=await this.sources.fetchPrice(source.pair);this.observePrice(price);return exchangeObservation(price);
    },executeEvm:this.sources.executeRun,solanaTarget:this.sources.solanaTarget,transfer:this.sources.solanaTransfer,reconcileTransfer:this.sources.solanaRecovery};
  }
  async frozenTarget(graph:PolicyGraph,prior?:ExecutionTarget):Promise<ExecutionTarget> {
    const current=await resolvePolicyTarget(graph,this.policyDependencies());
    if(prior&&!sameExecutionTarget(prior,current))throw new Error('The frozen execution authority or vault input changed; compose a new explicit revision before running');
    return prior??current;
  }
  async monitorChanged(monitor: PolicyMonitor) {
    if (!this.monitors || monitor.sessionId !== this.state.sessionId) return;
    this.state.monitors = this.monitors.list(this.state.sessionId);
    const result = monitor.latestEvidence;
    if (monitor.status === "completed" && (result?.transaction || result?.solanaTransfer) && !this.state.runs.some(run=>run.id===result.runId)) {
      const snapshot = this.state.workflow.revisions.find(revision=>revision.policyHash===monitor.spec.policyHash && revision.revision===monitor.spec.revision);
      if (snapshot) {
        const run: ExecutionRun = {id:result.runId,revision:result.revision,snapshot:clone(snapshot),policyHash:result.policyHash,target:monitor.target,
          action:result.action,status:"reporting",startedAt:monitor.updatedAt,completedAt:now(),executionMode:"Policy monitor",decisions:[],logs:monitor.logs.map(log=>({...log,stage:"monitor"}))};
        this.state.runs.unshift(run);
        try {await this.applyResult(run,result,await this.sources.loadDeployment());}
        catch(error) {run.status="failed";run.error=String(error);}
        this.say(`Monitor ${monitor.id}: ${this.completionSummary(run)}`);
      }
    }
    this.commit();
  }
  /** Settles every interrupted run from chain state, inside the operation queue. */
  reconcileQueued() {
    const work = this.queue.then(() => this.reconcileAll());
    this.queue = work.catch(() => {});
    return work;
  }
  async reconcileAll() {
    let changed = false;
    const recovered=new Set<string>();
    for (const run of this.state.runs.filter((x) => x.uncertain)) {
      const updated=await this.reconcile(run);
      if(updated)recovered.add(run.id);
      changed = updated || changed;
    }
    const selected=this.state.inspectedRunId ? this.state.runs.find(run=>run.id===this.state.inspectedRunId) : this.state.runs[0];
    if(selected&&recovered.has(selected.id)&&!selected.uncertain&&['confirmed','no-op'].includes(selected.status)) {
      this.state.activity={...this.state.activity,status:'idle',summary:this.completionSummary(selected)};
    }
    if (changed) this.commit();
  }
  async reconcile(run: ExecutionRun): Promise<boolean> {
    if (!run.uncertain) return false;
    const record = (message: string) =>
      run.logs.push({ at: now(), stage: "recovery", message });
    try {
      if(run.target&&isSolanaTarget(run.target)) {
        const recovered=await recoverSolanaPolicy(this.specFor(run),run.target,this.policyDependencies());
        if(recovered.status==='confirmed'&&recovered.receipt) {
          await this.applyResult(run,recoveredSolanaEvidence(this.specFor(run),run.target,recovered.receipt,{
            vault:run.inputs?.vault ? {address:run.inputs.vault.data.address,chainId:run.inputs.vault.data.chainId,paused:run.inputs.vault.data.paused,balanceWei:run.inputs.vault.data.balanceWei,reportVersion:run.inputs.vault.data.reportVersion??null}:null,
            observations:run.observations??[],conditions:run.decisions.filter(d=>d.nodeId&&d.role).map(d=>({nodeId:d.nodeId!,kind:d.id,role:d.role!,passed:d.passed,detail:d.detail})),
          }),null);
          run.uncertain=false;delete run.error;record(`Recovered exact Solana transfer ${recovered.receipt.signature}`);return true;
        }
        if(['not-submitted','expired','failed'].includes(recovered.status)) {
          run.uncertain=false;run.status='failed';run.error=recovered.reason;record(recovered.reason);return true;
        }
        throw new Error(recovered.reason);
      }
      const deployment = await this.sources.loadDeployment();
      if (!deployment) {
        if (this.sources.fetchVault === fetchVault) throw new Error("Execution deployment is unavailable; chain outcome remains unknown");
        run.uncertain = false;
        run.error = "Backend restarted during a fixture rehearsal; nothing reached a chain. Safe to run again.";
        record(run.error);
        return true;
      }
      const target = run.target || (run.evidence?.contractAddress && run.evidence.chainId ? {address:run.evidence.contractAddress,chainId:run.evidence.chainId} : undefined);
      if (target && isEvmTarget(target) && (target.address.toLowerCase() !== deployment.address.toLowerCase() || target.chainId !== deployment.chainId))
        throw new Error("Execution target changed; restore this run's recorded chain and vault before recovery");
      const found = await this.sources.findSubmittedPause(run.id, deployment, {revision:run.revision,policyHash:run.snapshot.policyHash || policyHash(run.snapshot.graph)},run.evidence?.transactionHash);
      run.uncertain = false;
      if (found.landed && found.transactionHash) {
        run.status = "confirmed";
        if(run.target&&isEvmTarget(run.target)&&run.target.executor==='cre')run.executionMode='CRE local simulation · Sepolia broadcast · recovered receipt';
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
        if(run.submissionPossible && !found.submissionSettled) {run.uncertain=true;throw new Error("No landed report found yet; an unconfirmed submission may still exist, so a new action remains blocked");}
        if(found.submissionSettled) {run.submissionPossible=false;if(run.evidence)run.evidence.receiptStatus='not-landed';}
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
    // Everything saved above is archived; the live state keeps the recent runs plus any still open.
    if (this.state.runs.length > MAX_LIVE_RUNS)
      this.state.runs = this.state.runs.filter((run, i) => i < MAX_LIVE_RUNS || !TERMINAL.includes(run.status) || run.uncertain || run.id === this.state.inspectedRunId);
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
    const pair = collectSources(w.graph).find(s => s.type === "exchange-trade");
    const priceId = pair?.type === "exchange-trade" ? "price:" + pair.pair.toLowerCase() : "";
    const sourceId = priceId === "price:eth-usd" ? "source:coinbase" : "source:" + priceId;
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
      const actionId = action.type === "solana-transfer" ? "action:solana-transfer" : "action:pause";
      this.state.objects = this.state.objects.filter((x) => !x.id.startsWith("action:") || x.id === actionId);
      this.object({
        id: actionId,
        kind: "action",
        label: describeAction(action),
        data: isSimulatedAction(action) ? { ...action, simulated: true } : action.type === "solana-transfer" ? { ...action, target: action.recipient } : { ...action, target: "vault:grant" },
        visible: true,
        pinned: false,
        provenance,
      });
      w.summary = describeGraph(graph);
      const edges: CanvasState["edges"] = [];
      for (const source of collectSources(graph)) {
        if (source.type !== "exchange-trade") continue;
        const priceId = readingObjectId(source);
        const observed = this.state.objects.find((o) => o.id === priceId);
        edges.push({ id: `observes-${priceId}`, from: observed?.data.sourceObjectId ?? "source:coinbase", to: priceId, label: "observes" });
      }
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
      edges.push({ id: "out-root", from: `condition:${graph.root}`, to: actionId, label: "if true" });
      // A direct Solana transfer (research only) has no vault edge.
      if (action.type !== "solana-transfer") edges.push({
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
      ? `When ${pair?.type === "exchange-trade" ? pair.pair.replace("-", " / ") : "Price"} is below $${w.threshold.toLocaleString("en-US", { maximumFractionDigits: 2 })}${w.maxAgeSeconds !== null ? `, the observation is no more than ${w.maxAgeSeconds} seconds old` : ""}${w.skipPaused ? ", and the grant vault is not already paused" : ""}, pause grant vault spending.`
      : describeGraph(w.graph);
    this.state.edges = [
      {
        id: "e1",
        from: sourceId,
        to: priceId,
        label: "observes",
      },
      {
        id: "e2",
        from: priceId,
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
          from: priceId,
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
    if(!this.researchExecution&&['transfer_solana_devnet','copy_evm_swap','activate_evm_trade_watch'].includes(tool))return {ok:false,code:'CRE_EXECUTION_REQUIRED',summary:'This direct-signing action has no implemented CRE workflow and is disabled. All product writes require Chainlink CRE.',error:'CRE execution required',state:this.context()};
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
      if(tool==='copy_evm_swap'&&existing.result.ok) {
        try {
          const recovered=await this.tradeTools.invoke('reconcile_evm_copy_swap',{copyOperationId:operationId},this.state.sessionId);
          if(recovered?.data.status!=='confirmed')throw new Error(recovered?.summary || 'Original copy receipt is not currently confirmed');
          return {...existing.result,data:{receipt:recovered.data.receipt},summary:`Reverified the same canonical copy receipt for operation ${operationId}. No new transaction was sent.`,state:this.context(),duplicate:true};
        }catch(error){const message=String(error);return {ok:false,summary:message,error:message,code:'COPY_RECEIPT_UNVERIFIED',state:this.context(),duplicate:true};}
      }
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
    let data: Record<string, unknown> | undefined;
    try {
      switch (tool) {
        case "activate_policy": {
          const workflow=this.state.workflow;
          if (!workflow.created) throw new Error("Compose a policy before activating it");
          if(args.expectedRevision!==workflow.revision) throw Object.assign(new Error("Draft changed; activate the explicit current revision"),{code:"REVISION_CONFLICT"});
          const snapshot=clone(workflow.revisions.at(-1)!);
          const target=await this.frozenTarget(snapshot.graph,snapshot.target);
          const spec: ExecutionSpecification={version:2,runId:`monitor_${crypto.randomUUID().replaceAll("-","")}`,revision:snapshot.revision,graph:snapshot.graph,policyHash:snapshot.policyHash || policyHash(snapshot.graph),maxAgeSeconds:snapshot.maxAgeSeconds ?? 60,broadcast:true};
          const monitor=this.monitors.activate({spec,target,activationId:operationId,sessionId:this.state.sessionId,intervalSeconds:args.intervalSeconds});
          this.state.monitors=this.monitors.list(this.state.sessionId);
          data={monitor};
          summary=`Revision ${workflow.revision} is watching live inputs every ${monitor.intervalSeconds}s while this backend runs. Monitor ${monitor.id}; it stops after one verified action. Draft edits do not change its frozen rule.`;
          break;
        }
        case "deactivate_policy": {
          const monitor=this.monitors.get(String(args.monitorId));
          if(monitor.sessionId!==this.state.sessionId) throw new Error("This monitor belongs to another canvas session");
          const stopped=this.monitors.deactivate(monitor.id);
          this.state.monitors=this.monitors.list(this.state.sessionId);
          data={monitor:stopped};summary=`Monitor ${monitor.id}: ${stopped.status}. ${stopped.stopReason || "No further checks will run."}`;
          break;
        }
        case "reconcile_policy": {
          const original=this.monitors.get(String(args.monitorId));
          if(original.sessionId!==this.state.sessionId) throw new Error("Monitor belongs to another canvas session");
          const monitor=await this.monitors.reconcile(original.id,async frozen=>{
            if(isSolanaTarget(frozen.target)) {
              const spec={...frozen.spec,runId:frozen.lastRunId!};
              const recovery=await recoverSolanaPolicy(spec,frozen.target,this.policyDependencies());
              if(recovery.status==='confirmed'&&recovery.receipt)return {state:'confirmed' as const,evidence:recoveredSolanaEvidence(spec,frozen.target,recovery.receipt,frozen.latestEvidence)};
              const identity={runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash,target:frozen.target,checkedAt:recovery.checkedAt,journalVerified:true as const,chainVerified:true as const};
              if(recovery.status==='not-submitted')return {state:'not-submitted' as const,...identity,processed:false as const};
              if(recovery.status==='expired'&&recovery.signature)return {state:'expired' as const,...identity,signature:recovery.signature,lastValidBlockHeight:recovery.lastValidBlockHeight,blockHeight:recovery.currentBlockHeight};
              if(recovery.status==='failed'&&recovery.signature)return {state:'failed' as const,...identity,signature:recovery.signature,transactionError:JSON.stringify(recovery.chainError)};
              return {state:'unknown' as const,reason:recovery.reason};
            }
            const deployment=await this.sources.loadDeployment();
            if(!deployment || deployment.chainId!==frozen.target.chainId || deployment.address.toLowerCase()!==frozen.target.address.toLowerCase())
              return {state:"unknown" as const,reason:"Restore the monitor's original chain and vault before recovery"};
            const found=await this.sources.findSubmittedPause(frozen.lastRunId!,deployment,{revision:frozen.spec.revision,policyHash:frozen.spec.policyHash},(frozen as any).submittedHash);
            if(!found.landed && found.submissionSettled)
              return {state:"not-submitted" as const,runId:frozen.lastRunId!,revision:frozen.spec.revision,policyHash:frozen.spec.policyHash,target:frozen.target,checkedAt:now(),processed:false as const};
            if(!found.landed || !found.transactionHash || found.blockNumber===undefined || found.balanceWei===undefined || !found.decidedAt)
              return {state:"unknown" as const,reason:"No matching confirmed pause event found yet; an in-flight report cannot be ruled out. No transaction was sent."};
            const evidence:ExecutionEvidence={runId:frozen.lastRunId!,revision:frozen.spec.revision,policyHash:frozen.spec.policyHash,
              mode:deployment.chainId===31337 ? "local-evm-rehearsal" : "cre-local-simulation",observations:[],conditions:[],root:true,decision:"act",action:"pause-vault",decidedAt:found.decidedAt,
              vault:{address:deployment.address,chainId:deployment.chainId,paused:true,balanceWei:found.balanceWei,reportVersion:2},
              transaction:{hash:found.transactionHash,blockNumber:found.blockNumber,status:"success",receiverConfirmed:true,pausedAfter:found.paused},
              logs:["Recovered receiver receipt only; exact action observations were not recovered."]};
            return {state:"confirmed" as const,evidence};
          });
          this.state.monitors=this.monitors.list(this.state.sessionId);
          data={monitor};summary=`Monitor ${monitor.id}: ${monitor.status}. ${monitor.lastError || monitor.stopReason || "Recovery complete."}`;
          break;
        }
        case "get_monitors": {
          const monitors=args.monitorId ? [this.monitors.get(String(args.monitorId))] : this.monitors.list(this.state.sessionId);
          if(monitors.some(monitor=>monitor.sessionId!==this.state.sessionId)) throw new Error("Monitor belongs to another canvas session");
          return {ok:true,summary:monitors.length ? monitors.map(monitor=>`${monitor.id}: ${monitor.status}, ${monitor.checks} checks. ${monitor.lastError || monitor.stopReason || "Watching live inputs."}`).join(" ") : "No active policy monitors.",data:{monitors,...(args.monitorId ? {checks:this.monitors.checks(String(args.monitorId))} : {})},state:this.context()};
        }

        case "inspect_solana_wallet": {
          const wallet = await inspectSolanaWallet({address:String(args.address),network:args.network,limit:args.limit});
          data = {...wallet};
          summary = `${wallet.address}: ${wallet.balanceSol} SOL on ${wallet.network}; ${wallet.activity.length} confirmed recent transactions inspected. ${wallet.explorerUrl}`;
          break;
        }
        case "get_solana_devnet_wallet": {
          const wallet = await getSolanaDevnetWallet();
          return {ok:true,summary:`Task devnet wallet ${wallet.address}: ${wallet.balanceSol} SOL.`,data:{...wallet},state:this.context()};
        }
        case "transfer_solana_devnet": {
          const receipt = await transferSolanaDevnet({recipient:String(args.recipient),amountSol:args.amountSol,idempotencyKey:operationId});
          data = {...receipt};
          summary = `Confirmed ${receipt.amountSol} SOL to ${receipt.recipient} on Solana devnet at slot ${receipt.slot}. ${receipt.explorerUrl}`;
          break;
        }

        case "get_capabilities": {
          const readiness = await creReadiness();
          return {
            ok: true,
            summary: `Chainlink CRE is the sole product execution authority. ${readiness.reason} This application supports CRE-backed vault pauses; no direct signer fallback.`,
            data: { ...supportedPolicyCapabilities, readiness },
            state: this.context(),
          };
        }
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
          if (args.network) {
            const network = args.network as Network;
            if (!NETWORKS[network]) throw new Error("Unsupported feed network");
            summary = `Chainlink feeds on ${NETWORKS[network].label}: ${Object.entries(feedsOn(network)).map(([symbol,feed]) => `${symbol} (${feed.name})`).join(", ")}.`;
            break;
          }
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
          if (!NETWORKS[network]) throw new Error("Unsupported feed network");
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
          const existingSource = collectSources(current.graph).find(source => source.type === "exchange-trade");
          const selected = patch.priceReference ? this.resolve(patch.priceReference) :
            !current.created ? this.state.objects.find(x => x.id === this.state.focus.objectId && x.kind === "price") ||
              (this.state.objects.filter(x => x.kind === "price").length === 1 ? this.state.objects.find(x => x.kind === "price") : undefined) : undefined;
          if (patch.priceReference && selected?.kind !== "price") throw new Error("Select a discovered exchange price observation");
          if (!current.created && !selected && this.state.objects.filter(x => x.kind === "price").length > 1 && !patch.priceReference) throw new Error("Multiple price observations: specify priceReference to select the trigger");
          const pair = selected ? (selected.data.productId || selected.id.slice(6).toUpperCase()) :
            existingSource?.type === "exchange-trade" ? existingSource.pair : "ETH-USD";
          let threshold = patch.threshold ?? current.threshold;
          if (patch.thresholdAboveCurrent) {
            const price = await this.sources.fetchPrice(pair);
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
            scalar && !this.state.objects.some((x) => x.id === "price:" + pair.toLowerCase()) && `the Coinbase ${pair} price (discover_objects with tokens ["${pair.slice(0, -4)}"])`,
            (scalar || readsVault(current.graph)) && !this.state.objects.some((x) => x.kind === "vault") && 'the grant vault (discover_objects with objects ["vault"])',
          ].filter(Boolean);
          if (needs.length) throw new Error(`Discover ${needs.join(" and ")} before editing this policy`);
          // A scalar edit can only express the single-compare shape. Against a
          // composed graph it refuses, so branches the speaker added are never
          // discarded by a stray threshold tweak.
          if (patch.threshold !== undefined || patch.thresholdAboveCurrent || patch.priceReference)
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
              ? legacyGraph(threshold, pair)
              : clone(current.graph),
          };
          if(this.sources.fetchVault===fetchVault)revision.target=await this.frozenTarget(revision.graph);
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
          summary = await this.composeRevision(graph, args.reason || "Composed condition graph", args.maxAgeSeconds);
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
          const parsed = recipe.params.safeParse(args.params ?? {});
          if (!parsed.success) {
            const issue = parsed.error.issues[0]!;
            const name = issue.path.join(".") || "params";
            const known = Object.keys(recipe.params.shape).join(", ");
            throw new Error(issue.code === "unrecognized_keys"
              ? `Recipe ${recipe.id} has no parameter ${issue.keys.map((k) => `"${k.slice(0, 40)}"`).join(", ")}; its parameters are ${known}.`
              : `Recipe ${recipe.id} parameter ${name}: ${issue.message}. Its parameters are ${known}.`);
          }
          const params = parsed.data;
          const { graph } = validateGraph(recipe.build(params));
          const credit = recipe.inspiredBy.map((x) => `${x.project} (${x.event}, ${x.award})`).join(" and ");
          summary = `${await this.composeRevision(graph, args.reason || `Recipe: ${recipe.title}`, args.maxAgeSeconds)} ${recipe.title}, inspired by ${credit}.${recipe.note ? ` ${recipe.note}` : ""}${recipe.watchSeconds ? ` To keep it running, call watch_policy with everySeconds ${recipe.watchSeconds}.` : ""}`;
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
          if(!this.researchExecution&&!isVaultAction(target.graph.action))throw Object.assign(new Error("This historical action is not executable through the current CRE product workflow"),{code:"CRE_EXECUTION_REQUIRED"});
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
          if(args.evaluationOnly!==undefined&&typeof args.evaluationOnly!=='boolean')throw new Error('evaluationOnly must be boolean');
          const evaluationOnly=args.evaluationOnly===true;
          const inflight = this.state.runs.find(
            (x) => x.revision === w.revision && !TERMINAL.includes(x.status),
          );
          if(inflight&&Boolean(inflight.evaluationOnly)!==evaluationOnly)throw Object.assign(new Error('This revision has an in-flight run with a different evaluation/broadcast mode; wait for it to complete'),{code:'EXECUTION_MODE_CONFLICT'});
          if (inflight) {
            runId = inflight.id;
            this.selectRun(inflight);
            summary = `Revision ${w.revision} is already executing as run ${inflight.id}; joined it without starting a duplicate.`;
            break;
          }
          const run = await this.startRun(w.revisions.at(-1)!, { trigger: "manual", prompt: "Run this version", evaluationOnly });
          runId = run.id;
          this.selectRun(run);
          const sessionId = this.state.sessionId;
          const waiting = this.state.runs.some((x) => x.id !== run.id && !TERMINAL.includes(x.status));
          setTimeout(() => void this.executeInTurn(run.id, sessionId), 10);
          summary = `Run ${runId} started against immutable revision ${w.revision}${evaluationOnly ? "; evaluation only, no report can be submitted" : ""}.${waiting ? " It starts after the run already executing finishes." : ""}`;
          break;
        }
        case "get_run": {
          const run = args.runId
            ? this.state.runs.find((x) => x.id === args.runId)
            : this.state.runs[0];
          const archived = !run && args.runId ? this.store.execution(args.runId) : null;
          if (archived) {
            runId = archived.id;
            summary = `Run revision ${archived.revision} (archived): ${archived.status}. ${archived.error || archived.noopReason || archived.logs.at(-1)?.message || ""}`;
            break;
          }
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
          if(args.action==='show_draft') {
            delete this.state.inspectedRunId;
            this.state.mode=this.state.workflow.created ? 'compose' : 'explore';
            this.focus(this.state.workflow.id,this.state.workflow.created ? `Editable policy v${String(this.state.workflow.revision).padStart(2,'0')}` : 'Editable policy draft');
            this.state.canvasView={action:'fit',sequence:(this.state.canvasView?.sequence||0)+1};
            summary=this.state.workflow.created ? `Showing editable policy revision ${this.state.workflow.revision}.` : 'Showing the editable policy draft.';
            break;
          }
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
          if (this.monitors.list(this.state.sessionId).some(monitor=>["active","checking","uncertain"].includes(monitor.status))) throw new Error("Stop or reconcile policy monitors before clearing their canvas session");
          if(this.tradeTools.listWatches(this.state.sessionId).some(watch=>["active","checking","uncertain"].includes(watch.status)||watch.pendingAttemptId))throw new Error("Stop or reconcile trade watches before clearing their canvas session");;
          this.stopWatch("Canvas cleared");
          if (!this.isBlank()) this.store.archiveSession(this.state);
          const seq = this.state.seq;
          const capabilities = clone(this.state.capabilities);
          const treasury = this.state.fixtureTreasury;
          const watched = this.state.watch?.stopReason === "Canvas cleared";
          this.state = emptyState();
          this.state.seq = seq;
          this.state.capabilities = capabilities;
          if (treasury) this.state.fixtureTreasury = treasury;
          summary = `Canvas cleared.${watched ? " The standing policy stopped." : ""} Contract state is unchanged.`;
          break;
        }
        case "restore_session": {
          if (args.expectedSessionId && args.expectedSessionId !== this.state.sessionId)
            throw new Error("The session changed. Refresh before undoing clear.");
          if (!this.isBlank()) throw new Error("Undo clear is available only before starting a new canvas session.");
          const archived = this.store.latestClearedSession();
          if (!archived) throw new Error("There is no cleared session to restore.");
          const treasury = this.state.fixtureTreasury;
          const seq = this.state.seq;
          this.state = migrateState(clone(archived));
          this.state.seq = seq;
          // The vault did not go back in time with the canvas.
          if (treasury) this.state.fixtureTreasury = treasury;
          this.state.sessionId = crypto.randomUUID();
          this.state.activity = { status: "idle", prompt: "", summary: "Canvas restored." };
          this.fixturePaused = Boolean(this.state.objects.find(x => x.id === "vault:grant" && x.data.fixture)?.data.paused);
          summary = "Canvas restored. Contract state is unchanged.";
          break;
        }
        default: {
          const result=await this.tradeTools.invoke(tool,args,this.state.sessionId);
          if(!result)throw new Error(`Unknown semantic tool: ${tool}`);
          summary=result.summary;data=result.data;this.state.tradeWatches=this.tradeTools.listWatches(this.state.sessionId);break;
        }
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
        ...(data ? {data} : {}),
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
  async composeRevision(graph: PolicyGraph, reason: string, maxAgeSeconds?: number | null): Promise<string> {
    const w = this.state.workflow;
    // The product writes only through CRE: simulated and direct-signer actions are research paths.
    if (!this.researchExecution && !isVaultAction(graph.action))
      throw Object.assign(new Error(graph.action.type === "solana-transfer"
        ? "Only vault actions have an implemented CRE receiver workflow; direct Solana execution is disabled"
        : `A simulated ${graph.action.type} has no CRE receiver; the product executes only pause, sweep, pay and evacuate through Chainlink CRE`), { code: "CRE_EXECUTION_REQUIRED" });
    // Require only what this policy uses: the vault when it acts on or reads
    // it, and the Coinbase trade when a branch uses it. Feeds and contract
    // readings are read at execution and shown as configured inputs until then.
    const missing = [
      readsVault(graph) && !this.state.objects.some((x) => x.kind === "vault") && 'the grant vault (discover_objects with objects ["vault"])',
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
    if (this.sources.fetchVault === fetchVault) revision.target = await this.frozenTarget(graph);
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
  /** The fixture vault's answer to terms(payeeId): the same fields a GrantVault v3 returns. */
  fixtureTerms(payee: string | undefined): VaultTerms {
    const treasury = this.fixtureTreasury;
    return {
      payee: (payee && FIXTURE_LIMITS.payees[payee]) || ZERO_ADDRESS,
      maxPaymentWei: toWei(FIXTURE_LIMITS.maxPaymentEth),
      nextPaymentAt: treasury.lastPaymentAt ? treasury.lastPaymentAt + FIXTURE_LIMITS.minPaymentIntervalSeconds : 0,
      ccipConfigured: true,
      tokenBalance: toWei(this.fixtureTokens),
      maxCcipFeeWei: toWei(FIXTURE_LIMITS.maxCcipFeeEth),
      nextEvacuationAt: treasury.lastEvacuationAt ? treasury.lastEvacuationAt + FIXTURE_LIMITS.minEvacuationIntervalSeconds : 0,
    };
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
  async startRun(revision: WorkflowRevision, options: { trigger: "manual" | "watch"; watchCheck?: number; prompt: string; evaluationOnly?: boolean }): Promise<ExecutionRun> {
    const snapshot = clone(revision);
    // Freeze the execution authority with the run: CRE against the Sepolia receiver in the product.
    const deployment = readsVault(snapshot.graph) ? await this.sources.loadDeployment() : null;
    const target = snapshot.graph.action.type === "solana-transfer" || deployment ? await this.frozenTarget(snapshot.graph, snapshot.target) : undefined;
    if (!target && this.sources.fetchVault === fetchVault) throw new Error("Execution requires its real chain target");
    snapshot.policyHash ??= policyHash(snapshot.graph, snapshot.maxAgeSeconds ?? DEFAULT_EXCHANGE_MAX_AGE_SECONDS);
    const evaluationOnly = options.evaluationOnly === true;
    const run: ExecutionRun = {
      id: `run-${crypto.randomUUID()}`,
      revision: snapshot.revision,
      snapshot,
      policyHash: snapshot.policyHash,
      action: snapshot.graph.action.type,
      ...(target ? { target } : {}),
      evaluationOnly,
      trigger: options.trigger,
      ...(options.watchCheck ? { watchCheck: options.watchCheck } : {}),
      status: "queued",
      startedAt: now(),
      executionMode: "Preparing execution",
      decisions: [],
      logs: [{ at: now(), stage: "queued", message: `${options.trigger === "watch" ? `Watch check ${options.watchCheck}: frozen revision ${snapshot.revision}` : `Frozen draft revision ${snapshot.revision}`}${evaluationOnly ? " · evaluation only; broadcast disabled" : ""}` }],
    };
    this.state.runs.unshift(run);
    this.state.activity = { status: "executing", prompt: options.prompt, summary: `Running revision ${snapshot.revision}` };
    return run;
  }
  /** Executes a run after any execution already underway, so two runs never move the same funds at once. */
  executeInTurn(runId: string, sessionId: string, options: Parameters<Engine["execute"]>[2] = {}) {
    const work = this.executions.then(() => this.execute(runId, sessionId, options));
    this.executions = work.catch(() => {});
    return work;
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
    const started = await this.enqueue(async () => {
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
      const run = await this.startRun(watch.snapshot, { trigger: "watch", watchCheck: watch.checks, prompt: `Watch check ${watch.checks} of ${watch.maxChecks}` });
      watch.lastRunId = run.id;
      watch.nextCheckAt = undefined;
      this.commit();
      return { run, sessionId: this.state.sessionId, watch };
    });
    if (!started) return undefined;
    await this.executeInTurn(started.run.id, started.sessionId, { quiet: true, cron: { schedule: cronEvery(started.watch.everySeconds) } });
    return this.enqueue(() => {
      const watch = this.state.watch;
      const run = this.state.runs.find((x) => x.id === started.run.id);
      if (!run || this.state.sessionId !== started.sessionId) return run;
      if (!watch || watch.id !== started.watch.id || watch.status !== "watching") {
        // The watch was stopped or replaced while this check ran; its outcome is still reported.
        const outcome = run.status === "confirmed" ? this.completionSummary(run) : run.status === "no-op" ? `no action: ${run.noopReason ?? "nothing to do"}` : `failed: ${run.error}`;
        if (run.status !== "no-op") this.say(`The check that was running when the watch stopped finished: ${outcome}`);
        if (!this.state.runs.some((x) => !TERMINAL.includes(x.status)))
          this.state.activity = { status: run.status === "failed" ? "error" : "idle", prompt: this.state.activity.prompt, summary: `Last watch check: ${outcome}` };
        this.commit();
        return run;
      }
      const outcome = run.status === "confirmed" ? this.completionSummary(run) : run.status === "no-op" ? `no action: ${run.noopReason ?? "nothing to do"}` : `failed: ${run.error}`;
      watch.lastOutcome = outcome;
      watch.consecutiveFailures = run.status === "failed" ? watch.consecutiveFailures + 1 : 0;
      const stop = run.evidence?.solanaFailure ? `stopped on check ${watch.checks}: the Ethereum action verified but the Solana leg failed, so the two vaults disagree. ${outcome}`
        : run.status === "confirmed" && watch.stopOnAction ? `acted on check ${watch.checks}. ${outcome}`
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
      broadcast: !run.evaluationOnly,
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
    if (this.sources.fetchVault === fetchVault) throw new Error("Execution requires a deployed vault; no fixture is substituted.");
    return {
      mode: "fixture-rehearsal",
      readVault: async (options) => {
        const vault = this.fixtureVault(await this.sources.fetchVault(this.fixturePaused));
        if (!vault.data.fixture)
          throw new Error("Real contract configured but no runner deployment is available; execution prevented");
        this.object(vault);
        const terms = options?.terms ? this.fixtureTerms(options.terms.payee) : undefined;
        return {
          address: "fixture", chainId: 0, paused: Boolean(vault.data.paused), balanceWei: toWei(this.fixtureBalanceEth), reportVersion: REPORT_VERSION,
          ...(terms ? { terms, tokenBalance: terms.tokenBalance } : {}),
        };
      },
      readSource: async (source) => {
        if (source.type !== "exchange-trade") return this.readChainSource(source);
        const price = await this.sources.fetchPrice(source.pair);
        this.observePrice(price);
        return exchangeObservation(price);
      },
      referencePrice: (symbol) =>
        this.readFeed({ type: "chainlink-feed", symbol: symbol as FeedSource["symbol"], network: DEFAULT_FEED_NETWORK }),
      fixtureAct: async (action: VaultAction) => {
        const effects: FixtureEffects = {};
        const treasury = this.fixtureTreasury;
        const nowSeconds = Math.floor(Date.now() / 1000);
        // The same checks GrantVault makes, against the state at the moment of acting.
        if (action.type === "pay") {
          if (this.fixturePaused) throw new Error("Fixture vault spending is paused; no payment");
          if (!FIXTURE_LIMITS.payees[action.payee]) throw new Error(`No payee named "${action.payee}" is registered on the fixture vault`);
          if (action.amountEth > FIXTURE_LIMITS.maxPaymentEth) throw new Error(`The fixture vault caps payments at ${FIXTURE_LIMITS.maxPaymentEth} ETH`);
          if (treasury.lastPaymentAt && nowSeconds < treasury.lastPaymentAt + FIXTURE_LIMITS.minPaymentIntervalSeconds) throw new Error("The fixture vault paid too recently");
          if (round9(this.fixtureBalanceEth - action.amountEth) < 0) throw new Error(`The fixture vault holds ${round9(this.fixtureBalanceEth)} ETH, less than the ${action.amountEth} ETH payment`);
          this.fixtureBalanceEth = round9(this.fixtureBalanceEth - action.amountEth);
          treasury.lastPaymentAt = nowSeconds;
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
          treasury.lastEvacuationAt = nowSeconds;
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
    const progress = (message: string) => {
      if(message.startsWith("ORIGINS_SUBMITTED ")) {
        if(run.evaluationOnly)throw new Error("Evaluation-only run emitted submission evidence; broadcast was disabled");
        const submitted=JSON.parse(message.slice(18));
        if(submitted.runId!==run.id || submitted.revision!==run.revision || submitted.policyHash!==run.snapshot.policyHash || !/^0x[a-fA-F0-9]{64}$/.test(submitted.hash)) throw new Error("Submission evidence does not match frozen execution");
        run.submissionPossible=true;
        run.evidence={...run.evidence,transactionHash:submitted.hash,contractAddress:(run.target&&isEvmTarget(run.target)?run.target.address:undefined),chainId:(run.target&&isEvmTarget(run.target)?run.target.chainId:undefined),receiptStatus:"pending",verification:"Submitted; awaiting receiver receipt verification"};
      }
      if(message.startsWith('ORIGINS_SOLANA_SUBMITTED ')) {
        const submitted=JSON.parse(message.slice('ORIGINS_SOLANA_SUBMITTED '.length));
        if(submitted.runId!==run.id||submitted.revision!==run.revision||submitted.policyHash!==run.snapshot.policyHash||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(submitted.signature))throw new Error('Solana submission does not match frozen policy');
        run.submissionPossible=true;run.evidence={...run.evidence,submittedSignature:submitted.signature,receiptStatus:'pending',verification:'Signed transfer journaled; awaiting verified Solana receipt'};
      }
      mark(
        /report|deliver|transaction|Submitting|ORIGINS_SUBMITTED|ORIGINS_SOLANA_SUBMITTED|Confirmed|SIMULATED|Fixture vault paused/i.test(message)
          ? "reporting"
          : /PASS|STOP|No action|evaluat/i.test(message)
            ? "evaluating"
            : "fetching",
        message,
      );
    };
    try {
      mark("fetching", "Fetching fresh execution inputs");
      const spec = this.specFor(run);
      const deployment=readsVault(spec.graph)?await this.sources.loadDeployment():null;
      const result=run.target
        ? await executeDispatchedPolicy(spec,run.target,progress,this.policyDependencies(),options.cron ? { trigger: "cron", schedule: options.cron.schedule } : {})
        : await executePolicy(spec,this.fixtureEnvironment(),progress);
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
      const mayHaveSubmitted=!run.evaluationOnly && Boolean(run.target) && Boolean(run.submissionPossible||run.evidence?.transactionHash||run.evidence?.submittedSignature||run.status === "reporting");
      run.status = "failed";
      if(mayHaveSubmitted) {run.uncertain=true;run.submissionPossible=true;}
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
      if(run.uncertain) void this.reconcileQueued();
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
      const only = evidence.degradedReason ? ` Only the pause was sent: ${evidence.degradedReason}.` : "";
      return parts.length === 1 && parts[0] === "paused" ? `${v}: fixture vault paused in memory; no transaction.${only}` : `${v}: fixture vault ${parts.join(" and ")} in memory; no transaction.${only}`;
    }
    if (evidence?.solanaTransfer) return `${v}: transferred ${evidence.solanaTransfer.amountSol} SOL on devnet; verified signature ${evidence.solanaTransfer.signature}.`;
    if (evidence?.transactionHash) {
      const effects = evidence.effects;
      const block = `at block ${evidence.blockNumber}`;
      const solana = evidence.solanaFailure ? ` The Ethereum action is verified, but the Solana leg failed: ${evidence.solanaFailure.split("\n")[0]}`
        : evidence.solana?.verified ? evidence.solana.action === "sweep" ? " The Solana vault swept to its reserve in the same decision." : " The Solana vault was paused by the same decision." : "";
      if (evidence.degradedReason) return `${v}: vault paused ${block}, verified by receipt, receiver event and a fresh read. Only the pause was sent: ${evidence.degradedReason}.${solana}`;
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
    if (result.runId !== run.id || result.revision !== run.revision || result.policyHash !== (run.snapshot.policyHash ?? run.policyHash) || result.action!==run.snapshot.graph.action.type)
      throw new Error("Runner evidence does not match this run's identity and policy hash");
    if(run.evaluationOnly&&(result.transaction||result.solanaTransfer||result.fixturePaused))throw new Error("Evaluation-only run returned action evidence; no submission was permitted");
    run.executionMode = result.mode==='solana-devnet' ? (result.solanaTransfer ? "Solana devnet · verified on-chain transfer" : "Solana devnet · live policy evaluation") :
      result.mode === "cre-local-simulation"
        ? run.evaluationOnly || result.dryRun ? "CRE local simulation · evaluation only · no report submitted" : result.transaction
          ? deployment?.chainId === 11155111 ? "CRE local simulation · Sepolia broadcast" : "CRE local simulation · local EVM"
          : "CRE local simulation · live policy evaluation"
        : result.mode === "testnet-evm" ? `${deployment?.name || "Public testnet"} · on-chain execution · no CRE consensus` : result.mode === "local-evm-rehearsal"
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
    if (result.trigger === "cron") run.logs.push({ at: now(), stage: "evaluating", message: "Evaluated by the CRE workflow's cron trigger" });
    const priorVault = this.state.objects.find((x) => x.id === "vault:grant");
    let executionPrice: GraphObject | undefined;
    for (const observation of result.observations) {
      const source = collectSources(run.snapshot.graph).find(source=>sourceIdentity(source).key===observation.key);
      if (!source) throw new Error("Runner observation is outside the frozen policy sources");
      // Contract readings refresh their own cards when execution reads them.
      if (source.type!=="exchange-trade"&&source.type!=="chainlink-feed") continue;
      const objectId=readingObjectId(source);
      const prior=this.state.objects.find(object=>object.id===objectId);
      if (!prior) continue;
      if (source.type==="exchange-trade") {
        const {input,canvas}=buildExecutionPrice(prior,{usd:observation.usd??observation.value!,observedAt:observation.observedAt,source:observation.url || observation.label},observation.fetchedAt);
        executionPrice ??=input;
        this.object(canvas);
      } else {
        const refreshed=clone(prior);
        refreshed.data={...refreshed.data,price:observation.usd??observation.value,raw:observation.raw,roundId:observation.roundId,ageSeconds:Math.max(0,(Date.now()-Date.parse(observation.observedAt))/1000)};
        refreshed.provenance={...refreshed.provenance,kind:"chain",source:observation.label,observedAt:observation.observedAt,fetchedAt:observation.fetchedAt,address:observation.address,chainId:observation.chainId};
        this.object(refreshed);
      }
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
                reportVersion:result.vault.reportVersion,
              },
              provenance: {
                ...priorVault.provenance,
                address: result.vault.address,
                chainId: result.vault.chainId,
                fetchedAt: now(),
              },
            };
    }
    if(executionVault||executionPrice)run.inputs={...(executionPrice?{price:executionPrice}:{}),...(executionVault?{vault:executionVault}:{})};
    if(result.solanaTransfer) {
      const receipt=result.solanaTransfer,action=run.snapshot.graph.action;
      if(!run.target||result.mode!=='solana-devnet'||result.transaction)throw new Error('Solana settlement requires its frozen devnet authority');
      assertSolanaSettlement(run.target,action,run.id,result.policyHash,receipt);
      run.evidence={solanaTransfer:receipt,submittedSignature:receipt.signature,receiptStatus:'confirmed',policyHash:result.policyHash,explorerUrl:receipt.explorerUrl,verification:'Parsed System Program transfer and exact recipient balance delta verified on Solana devnet'};
      run.status='confirmed';
    } else if (result.transaction) {
      if(run.snapshot.graph.action.type==='solana-transfer'||run.target&&isSolanaTarget(run.target))throw new Error('EVM receipt cannot settle a Solana action');
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
      if (result.solanaFailure) run.evidence.solanaFailure = result.solanaFailure;
      if (result.degradedReason) run.evidence.degradedReason = result.degradedReason;
      if (result.workflow) run.evidence.workflow = result.workflow;
      // Verify what was sent: the action, or only its pause when nothing could move.
      const failures = effectFailures(result.effectiveAction ?? (run.snapshot.graph.action as VaultAction), tx);
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
        ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
        verification: "Local fixture changed only · no deployed contract or transaction",
      };
      run.status = "confirmed";
    } else if (result.dryRun) {
      run.noopReason = "CRE evaluation: the policy passed; broadcast was disabled and no report was submitted.";
      run.evidence={evaluationOnly:true,verification:"CRE evaluated the frozen policy with fresh source reads; broadcast disabled"};
      run.status = "no-op";
    } else {
      if (result.decision === "act") throw new Error("Action decision returned without verified evidence");
      run.status = "no-op";
      if(run.evaluationOnly)run.evidence={evaluationOnly:true,verification:"CRE evaluated the frozen policy with fresh source reads; broadcast disabled"};
    }
    if (executionVault && result.mode !== "fixture-rehearsal" && !result.transaction) this.object(executionVault);
    this.state.capabilities.execution = this.researchExecution ? run.executionMode : "Chainlink CRE · sole product execution authority";
    const vaultObject = this.state.objects.find((x) => x.id === "vault:grant");
    if (vaultObject) this.state.capabilities.vault = vaultObject.provenance.label;
  }
}
