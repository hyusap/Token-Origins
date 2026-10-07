import type { PolicyGraph, Observation, ResultRole } from "../cre/graph";
export type { PolicyGraph, Observation, ResultRole };
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
  kind: "price" | "vault" | "condition" | "action" | "source" | "feed";
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
  /** Hash of the frozen graph this run evaluated. */
  policyHash?: string;
  /** The action the frozen graph names. */
  action?: "pause-vault" | "sell";
  inputs?: { price: GraphObject; vault: GraphObject };
  /** Every source reading the decision used, with provider, network, address and timestamps. */
  observations?: Observation[];
  /** Why no action was taken, from the gate that actually stopped it. */
  noopReason?: string;
  /** Set after a restart interrupted this run, until the chain says whether its report landed. */
  uncertain?: boolean;
  decisions: RunDecision[];
  logs: RunLog[];
  evidence?: {
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
    solana?: { network: string; programId: string; vault: string; signature: string | null; verified: boolean; slot?: number; explorerUrl?: string };
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
    price: string;
    vault: string;
    execution: string;
    voice: string;
    mcp: string;
  };
  clarification?: { question: string; candidates: string[] };
}
export interface ToolResult {
  ok: boolean;
  summary: string;
  state: CanvasState;
  runId?: string;
  error?: string;
  code?: string;
  candidates?: string[];
  duplicate?: boolean;
}
