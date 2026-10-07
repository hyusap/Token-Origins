import type {EvmTradeWatch} from "../server/evm-trade-watch";
import type {ExecutionTarget} from "./execution-target";
import type {SolanaTransferReceipt} from "./solana-types";
import type { PolicyMonitor } from "../server/monitor";
import type { supportedPolicyCapabilities } from "./policy-capabilities";
import type { PolicyGraph, PolicyAction, Observation, ResultRole } from "../cre/graph";
import type { ReceiverEffects, FixtureEffects, SimulatedRebalance } from "../cre/runner";
export type { PolicyGraph, PolicyAction, Observation, ResultRole, ReceiverEffects, FixtureEffects, SimulatedRebalance };
export type Mode = "explore" | "compose" | "run";
export interface Provenance {
  source: string;
  url?: string;
  observedAt: string;
  fetchedAt: string;
  chainId?: number;
  address?: string;
  kind: "live" | "fixture" | "chain" | "derived";
  label: string;
}
export interface PricePoint {
  price: number;
  observedAt: string;
}
export interface GraphObject {
  id: string;
  /** reading: a contract-backed input that is not a price (Proof of Reserve, supply, lending rate). */
  kind: "price" | "vault" | "condition" | "action" | "source" | "feed" | "reading";
  label: string;
  data: Record<string, any>;
  provenance: Provenance;
  visible: boolean;
  pinned: boolean;
}
export interface WorkflowRevision {
  revision: number;
  threshold: number;
  maxAgeSeconds: number | null;
  skipPaused: boolean;
  createdAt: string;
  reason: string;
  /** Composed policy. Scalar edits synthesise the equivalent single-compare graph. */
  graph: PolicyGraph;
  target?: ExecutionTarget;
  /** Structural hash of graph; the receiver event carries the same value. */
  policyHash?: string;
  /** Set on a revision created by undo: the revision whose policy it restored. */
  restores?: number;
}
export interface Workflow {
  id: string;
  revision: number;
  threshold: number;
  maxAgeSeconds: number | null;
  skipPaused: boolean;
  summary: string;
  revisions: WorkflowRevision[];
  created: boolean;
  graph: PolicyGraph;
  policyHash?: string;
}
export interface RunDecision {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  /** Graph node this verdict came from; absent for legacy scalar runs. */
  nodeId?: string;
  /** node: an intermediate result; root: the policy verdict; guard: a mandatory execution gate. */
  role?: ResultRole;
}
export interface RunLog {
  at: string;
  stage: string;
  message: string;
}
export interface ExecutionRun {
  id: string;
  revision: number;
  snapshot: WorkflowRevision;
  status:
    | "queued"
    | "fetching"
    | "evaluating"
    | "reporting"
    | "confirmed"
    | "no-op"
    | "failed";
  startedAt: string;
  completedAt?: string;
  executionMode: string;
  /** Frozen read-only CRE invocation; never enables report submission. */
  evaluationOnly?: boolean;
  /** Hash of the frozen graph this run evaluated. */
  policyHash?: string;
  /** The action the frozen graph names. */
  action?: PolicyAction["type"];
  /** manual: run_workflow; watch: a standing policy's scheduled check. */
  trigger?: "manual" | "watch";
  /** Which check of the standing policy this run was. */
  watchCheck?: number;
  inputs?: { price?: GraphObject; vault?: GraphObject };
  /** Every source reading the decision used, with provider, network, address and timestamps. */
  observations?: Observation[];
  /** Why no action was taken, from the gate that actually stopped it. */
  noopReason?: string;
  /** Set after a restart interrupted this run, until the chain says whether its report landed. */
  uncertain?: boolean;
  submissionPossible?: boolean;
  /** Target frozen before execution so recovery never reads a replacement vault. */
  target?: ExecutionTarget;
  decisions: RunDecision[];
  logs: RunLog[];
  evidence?: {
    evaluationOnly?:true;
    solanaTransfer?: SolanaTransferReceipt & {genesisHash:string;verified:true};
    submittedSignature?:string;
    transactionHash?: string;
    blockNumber?: string;
    receiptStatus?: string;
    pausedAfter?: boolean;
    chainId?: number;
    contractAddress?: string;
    explorerUrl?: string;
    reportId?: string;
    /** Policy hash read back from the receiver event. */
    policyHash?: string;
    /** Fixture rehearsal: in-memory state only. */
    fixture?: boolean;
    /** The same decision on the Solana vault (sotto_vault program, devnet), verified from chain data. */
    solana?: { network: string; programId: string; vault: string; signature: string | null; verified: boolean; slot?: number; explorerUrl?: string; action?: "pause" | "sweep"; reserve?: string; sweptLamports?: number };
    /** Why an acting decision left the Solana vault unchanged. */
    solanaSkipped?: string;
    /** The Ethereum action verified but the Solana write did not; why. */
    solanaFailure?: string;
    /** Only the pause of a protective sweep or evacuation was sent, because nothing could move. */
    degradedReason?: string;
    /** The workflow the Keystone forwarder vouched for (CRE runs). */
    workflow?: { workflowId: string; workflowName: string; workflowOwner: string };
    /** What the receiver did, decoded from its events for this run: pause, sweep, payment, CCIP message. */
    effects?: ReceiverEffects;
    /** CCIP explorer link for an evacuation's cross-chain message. */
    ccipExplorerUrl?: string;
    /** Fixture rehearsal: what changed in the in-memory vault. */
    fixtureEffects?: FixtureEffects;
    /** Present only for a mock rebalance. Never a real order or asset movement. */
    simulatedRebalance?: SimulatedRebalance;
    verification?: string;
    /** Present only for a mock sell. Never a real order or asset movement. */
    simulatedOrder?: {
      simulated: true;
      venue: string;
      side: "sell";
      symbol: string;
      amount: number;
      referencePriceUsd: number;
      notionalUsd: number;
      referenceSource: string;
      observedAt: string;
      placedAt: string;
    };
  };
  error?: string;
}
/** A standing policy: one frozen revision re-checked on a schedule until it acts, is stopped, or runs out of checks. */
export interface WatchState {
  id: string;
  revision: number;
  /** The frozen revision every check evaluates, whatever the draft becomes. */
  snapshot: WorkflowRevision;
  policyHash?: string;
  everySeconds: number;
  maxChecks: number;
  checks: number;
  stopOnAction: boolean;
  status: "watching" | "stopped";
  startedAt: string;
  nextCheckAt?: string;
  lastRunId?: string;
  lastOutcome?: string;
  stopReason?: string;
  consecutiveFailures: number;
}
export interface ConversationEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
  source: string;
}
export interface CanvasState {
  /** Persisted state layout; see server/migrate.ts. */
  stateVersion?: number;
  sessionId: string;
  canUndoClear?: boolean;
  canvasView?: { action: "fit" | "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "pan_up" | "pan_down" | "focus"; sequence: number };
  seq: number;
  mode: Mode;
  focus: { objectId: string | null; label: string };
  previousFocus: string[];
  references: { name: string; objectId: string; at: string }[];
  objects: GraphObject[];
  edges: { id: string; from: string; to: string; label: string }[];
  workflow: Workflow;
  runs: ExecutionRun[];
  monitors?: PolicyMonitor[];
  tradeWatches?: EvmTradeWatch[];
  inspectedRunId?: string;
  conversation: ConversationEntry[];
  activity: {
    status:
      | "idle"
      | "listening"
      | "thinking"
      | "executing"
      | "speaking"
      | "error";
    prompt: string;
    summary: string;
  };
  latency: {
    operationId: string;
    tool: string;
    receivedAt: string;
    committedAt: string;
    commitMs: number;
    renderedAt?: string;
    renderMs?: number;
  }[];
  capabilities: {
    supported?: typeof supportedPolicyCapabilities;
    price: string;
    vault: string;
    execution: string;
    voice: string;
    mcp: string;
  };
  clarification?: { question: string; candidates: string[] };
  /** The standing policy, if one was started this session. */
  watch?: WatchState;
  /**
   * Fixture rehearsal's in-memory vault (no deployment). Persisted so a
   * restart or a cleared canvas keeps its balances, like a contract would.
   */
  fixtureTreasury?: FixtureTreasury;
}
export interface FixtureTreasury {
  balanceEth: number;
  tokens: number;
  reserveEth: number;
  /** Unix seconds of the last fixture payment / evacuation; 0 when none. */
  lastPaymentAt: number;
  lastEvacuationAt: number;
}
export interface ToolResult {
  data?: Record<string, unknown>;
  ok: boolean;
  summary: string;
  state: CanvasState;
  runId?: string;
  error?: string;
  code?: string;
  candidates?: string[];
  duplicate?: boolean;
}
