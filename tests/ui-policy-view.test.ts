import { test, expect } from "bun:test";
import { describeGraph as engineDescription, validateGraph } from "../cre/graph";
import { describeGraph, policyExpression, actionObjectId, describeAction, formatSol } from "../src/policy-language";
import { policyView, runOutcome, runProvenance, isEvaluationOnly, missingDecisionLabel, settledExecutionReply, decisionRole, vaultStateLabel } from "../src/policy-view";
import { canvasFlow } from "../src/flow-model";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import type { ExecutionRun } from "../shared/types";

const create = () => new Engine(new StateStore(":memory:")).state;
const graph = validateGraph({ nodes: [
  { id: "sol", kind: "price", source: { type: "exchange-trade", pair: "SOL-USD" } },
  { id: "low", kind: "compare", input: "sol", op: "<", value: 100 },
  { id: "high", kind: "compare", input: "sol", op: ">", value: 200 },
  { id: "either", kind: "or", inputs: ["low", "high"] },
  { id: "fresh", kind: "freshness", input: "sol", maxAgeSeconds: 60 },
  { id: "paused", kind: "vault-paused", equals: true },
  { id: "active", kind: "not", input: "paused" },
  { id: "root", kind: "and", inputs: ["either", "fresh", "active"] },
], root: "root", action: { type: "pause-vault" } }).graph;

test("empty canvas does not invent a configured default source observation", () => {
  const state = create();
  state.objects = [];
  expect(policyView(state).objects).toHaveLength(0);
  expect(canvasFlow(state).nodes).toHaveLength(0);
});

test("nested graph presentation keeps every operator, reused source and real edge", () => {
  const state = create();
  state.workflow.created = true;
  state.workflow.graph = graph;
  expect(describeGraph(graph)).toBe(engineDescription(graph));
  expect(policyExpression(graph)).toContain(" OR ");
  expect(policyExpression(graph)).toContain("NOT (vault is paused)");
  expect(policyExpression(graph).match(/Coinbase SOL-USD trade/g)).toHaveLength(3);
  const flow = canvasFlow(state);
  expect(flow.nodes.filter(node => node.data.graphNode).map(node => node.data.graphNode!.id).sort()).toEqual(graph.nodes.map(node => node.id).sort());
  expect(flow.edges.filter(edge => edge.target === "condition:either").map(edge => edge.source)).toEqual(["condition:low", "condition:high"]);
  expect(flow.edges.find(edge => edge.id === "graph:root-action")?.source).toBe("condition:root");
});

test("selected run never uses revised live market readings as archived inputs", () => {
  const state = create();
  state.workflow.created = true;
  state.workflow.graph = graph;
  const original = structuredClone(state.workflow.graph);
  const run: ExecutionRun = { id: "archived", revision: 7, snapshot: { ...state.workflow.revisions[0]!, graph: original }, status: "no-op", startedAt: "2026-10-07T00:00:00Z", executionMode: "local Anvil", observations: [], decisions: [], logs: [], noopReason: "Policy root is false." };
  state.runs = [run]; state.inspectedRunId = run.id;
  state.objects = [{ id: "price:sol-usd", kind: "price", visible: true, pinned: false, label: "SOL/USD", data: { price: 999 }, provenance: { source: "Coinbase", label: "Live", kind: "live", observedAt: "2026-10-07T01:00:00Z", fetchedAt: "2026-10-07T01:00:00Z" } }];
  state.workflow.graph = { nodes: [{ id: "paused", kind: "vault-paused", equals: false }], root: "paused", action: { type: "pause-vault" } };
  const before = JSON.stringify(state);
  const view = policyView(state);
  expect(view.graph).toEqual(original);
  expect(view.objects.find(object => object.id === "price:sol-usd")!.data.price).toBeUndefined();
  expect(view.objects.find(object => object.id === "price:sol-usd")!.provenance.label).toBe("Execution observation unavailable");
  expect(runOutcome(run)).toBe("Policy root is false.");
  expect(JSON.stringify(state)).toBe(before);
});

test("false intermediate branch remains distinct from an execution guard", () => {
  expect(decisionRole({ id: "low", nodeId: "low", label: "compare", passed: false, detail: "False OR branch" })).toBe("node");
  expect(decisionRole({ id: "guard", nodeId: "guard:source:sol", label: "freshness", passed: false, detail: "Stale" })).toBe("guard");
});

test("CRE local evaluation and confirmed public settlement are independent provenance claims", () => {
  const state = create();
  const run: ExecutionRun = { id: "cre-proof", revision: 1, snapshot: { ...state.workflow.revisions[0]!, graph }, status: "confirmed", startedAt: "2026-10-07T00:00:00Z", executionMode: "CRE local simulation · Sepolia broadcast", decisions: [], logs: [], evidence: { chainId: 11155111, transactionHash: "0x123", pausedAfter: true } };
  expect(runProvenance(run).detail).toContain("verified Sepolia transaction");
  expect(runProvenance(run).detail).toContain("not a production DON execution");
  expect(runProvenance({ ...run, status: "reporting" }).detail).not.toContain("produced a verified");
  expect(runProvenance({ ...run, evidence: undefined }).detail).not.toContain("produced a verified");
  expect(runProvenance({ ...run, executionMode: "Public testnet · on-chain execution · no CRE consensus" }).detail).toContain("does not establish CRE");
  expect(runProvenance({ ...run, executionMode: "Local EVM rehearsal · no CRE consensus" }).detail).toContain("does not establish CRE");
});

test("new draft reusing node IDs never borrows prior revision verdict, observations or receipt", () => {
  const state = create();
  const original = structuredClone(graph);
  const run: ExecutionRun = { id: "old-confirmed-run", revision: 2, policyHash: "old-hash", snapshot: { ...state.workflow.revisions[0]!, graph: original, policyHash: "old-hash", revision: 2 }, status: "confirmed", startedAt: "2026-10-07T00:00:00Z", executionMode: "Local EVM rehearsal · no CRE consensus", decisions: [{ id: "root", nodeId: "root", passed: true, detail: "Old root passed", label: "and" }], logs: [], evidence: { transactionHash: "old-tx", pausedAfter: true } };
  state.runs = [run]; state.workflow.created = true; state.workflow.revision = 3;
  state.workflow.graph = { ...structuredClone(graph), nodes: graph.nodes.map(node => node.kind === "compare" ? { ...node, value: node.value + 5000 } : structuredClone(node)) };
  state.inspectedRunId = undefined; state.focus = { objectId: null, label: "Draft policy" };
  state.conversation = [{ id: "new-prompt", role: "user", text: "Compose a revised draft", at: "2026-10-07T00:01:00Z", source: "test" }];
  const before = JSON.stringify(state), draft = policyView(state), flow = canvasFlow(state);
  expect(draft.run).toBeUndefined();
  expect(draft.graph).toEqual(state.workflow.graph);
  expect(flow.nodes.some(node => node.data.kind === "run")).toBe(false);
  expect(flow.edges.some(edge => edge.id.startsWith("evidence:"))).toBe(false);
  expect(flow.edges.find(edge => edge.id === "graph:root-action")?.label).toBe("if root passes");
  expect(settledExecutionReply(state, "Preparing execution")).toBeNull();
  expect(JSON.stringify(state)).toBe(before);
  state.inspectedRunId = run.id;
  const frozen = canvasFlow(state);
  expect(policyView(state).graph).toEqual(original);
  expect(frozen.nodes.find(node => node.id === `run:${run.id}`)?.data.run).toBe(run);
  expect(frozen.edges.find(edge => edge.id === `evidence:${run.id}`)?.target).toBe(`run:${run.id}`);
  expect(frozen.edges.find(edge => edge.id === "graph:root-action")?.label).toBe("root evaluated: true");
});

test("true CRE evaluation-only verdict remains a no-report outcome", () => {
  const state = create();
  const run: ExecutionRun = { id: "evaluation-only", revision: 1, snapshot: { ...state.workflow.revisions[0]!, graph }, status: "no-op", evaluationOnly: true, startedAt: "2026-10-07T00:00:00Z", executionMode: "CRE local simulation · evaluation only · no report submitted", decisions: [{ id: "root", nodeId: "root", passed: true, detail: "Policy root passed", label: "and" }], logs: [], evidence: { evaluationOnly: true }, noopReason: "CRE evaluation: policy passed; broadcast disabled no report" };
  expect(isEvaluationOnly(run)).toBe(true);
  expect(runOutcome(run)).toBe(run.noopReason!);
  expect(runProvenance(run).detail).toContain("No report was submitted and no action was executed");
  expect(runProvenance(run).detail).not.toContain("verified Sepolia transaction");
  expect(run.evidence?.transactionHash).toBeUndefined();
});

test("recovered confirmed receipt exposes only its archived vault state, never stale live balance or readings", () => {
  const state = create();
  state.workflow.created = true; state.workflow.graph = graph;
  const run: ExecutionRun = { id: "recovered", revision: 1, snapshot: { ...state.workflow.revisions[0]!, graph }, status: "confirmed", startedAt: "2026-10-07T00:00:00Z", executionMode: "CRE local simulation · Sepolia broadcast · recovered receipt", decisions: [], logs: [], evidence: { transactionHash: "verified-recovered-tx", blockNumber: "11862058", pausedAfter: true, chainId: 11155111, contractAddress: "verified-receiver", verification: "Recovered after restart from the receiver event for this run" } };
  state.runs = [run]; state.inspectedRunId = run.id;
  state.objects = [{ id: "vault:grant", kind: "vault", visible: true, pinned: false, label: "Grant vault", data: { paused: false, balanceEth: 99 }, provenance: { source: "Old preread", kind: "chain", label: "Live", address: "old-receiver", chainId: 31337, observedAt: "2026-10-07T01:00:00Z", fetchedAt: "2026-10-07T01:00:00Z" } }];
  const before = JSON.stringify(state), vault = policyView(state).objects.find(object => object.kind === "vault")!;
  expect(vault.data.paused).toBe(true);
  expect(vault.data.blockNumber).toBe("11862058");
  expect(vault.data.balanceEth).toBeUndefined();
  expect(vault.provenance.address).toBe("verified-receiver");
  expect(vault.provenance.chainId).toBe(11155111);
  expect(vault.provenance.observedAt).toBe("");
  expect(vaultStateLabel(state, vault)).toBe("Spending at receipt");
  expect(policyView(state).objects.find(object => object.kind === "price")?.data.price).toBeUndefined();
  expect(missingDecisionLabel(run)).toBe("Receipt recovered; archived condition readings unavailable.");
  expect(missingDecisionLabel({ ...run, status: "fetching" })).toBe("Fetching fresh execution inputs.");
  expect(JSON.stringify(state)).toBe(before);
});

test("archived vault state explicitly describes the preread rather than present spending", () => {
  const state = create();
  const vault = { id: "vault:grant", kind: "vault" as const, visible: true, pinned: false, label: "Grant vault", data: { paused: true, blockNumber: 8 }, provenance: { source: "Anvil", label: "Chain read", kind: "chain" as const, observedAt: "2026-10-07T08:00:01Z", fetchedAt: "2026-10-07T08:00:01Z" } };
  state.objects = [vault];
  const run: ExecutionRun = { id: "confirmed", revision: 1, snapshot: { ...state.workflow.revisions[0]!, graph }, status: "confirmed", startedAt: "2026-10-07T08:00:00Z", executionMode: "Anvil", inputs: { vault: { ...vault, data: { paused: false, blockNumber: 6 } } }, decisions: [], logs: [], evidence: { pausedAfter: true, blockNumber: "7", transactionHash: "0x123" } };
  state.runs = [run]; state.inspectedRunId = run.id;
  const archived = policyView(state).objects.find(object => object.id === vault.id)!;
  expect(archived.data.paused).toBe(false);
  expect(vaultStateLabel(state, archived)).toBe("Spending before run");
  expect(state.objects[0]!.data.paused).toBe(true);
  state.inspectedRunId = undefined;
  expect(vaultStateLabel(state, vault)).toBe("Spending");
});

test("Solana policy keeps exact amount and recipient and never invents a vault target", () => {
  const state = create();
  const recipient = "11111111111111111111111111111111";
  const transfer = validateGraph({ ...graph, nodes: graph.nodes.filter(node => ["sol", "low"].includes(node.id)), root: "low", action: { type: "solana-transfer", network: "devnet", recipient, amountLamports: 1 } }).graph;
  state.workflow.created = true; state.workflow.graph = transfer;
  expect(describeAction(transfer.action)).toBe(`Transfer 0.000000001 SOL to ${recipient} on devnet`);
  expect(formatSol(1)).toBe("0.000000001");
  expect(actionObjectId(transfer.action)).toBe("action:solana-transfer");
  expect(describeGraph(transfer)).toContain(recipient);
  const flow = canvasFlow(state);
  expect(flow.nodes.some(node => node.id === "action:solana-transfer")).toBe(true);
  expect(flow.nodes.some(node => node.id === "action:pause" || node.data.kind === "vault")).toBe(false);
  expect(flow.edges.find(edge => edge.id === "graph:root-action")?.target).toBe("action:solana-transfer");
  expect(flow.edges.some(edge => edge.id === "graph:action-vault")).toBe(false);
});

test("frozen Solana action and confirmed receipt stay Solana after draft changes to a pause", () => {
  const state = create();
  const recipient = "11111111111111111111111111111111";
  const transfer = validateGraph({ ...graph, nodes: graph.nodes.filter(node => ["sol", "low"].includes(node.id)), root: "low", action: { type: "solana-transfer", network: "devnet", recipient, amountLamports: 1000000 } }).graph;
  const run: ExecutionRun = { id: "transfer-run", revision: 2, snapshot: { ...state.workflow.revisions[0]!, graph: transfer }, status: "confirmed", startedAt: "2026-10-07T08:00:00Z", executionMode: "Solana devnet", inputs: {}, observations: [], decisions: [], logs: [], evidence: { solanaTransfer: { network: "devnet", status: "confirmed", signature: "archived-signature", sender: "sender-address", recipient, lamports: 1000000, amountSol: .001, slot: 123, feeLamports: 5000, blockTime: "2026-10-07T08:00:01Z", explorerUrl: "https://explorer.solana.com/tx/archived-signature?cluster=devnet", recipientBalanceBefore: 0, recipientBalanceAfter: 1000000, idempotencyKey: "immutable-key", replayed: false, genesisHash: "frozen-devnet-genesis", verified: true } } };
  state.runs = [run]; state.inspectedRunId = run.id; state.workflow.created = true;
  state.workflow.graph = graph;
  state.objects = [{ id: "vault:grant", kind: "vault", visible: true, pinned: false, label: "Grant vault", data: { paused: true }, provenance: { source: "Anvil", label: "Live vault", kind: "chain", observedAt: "2026-10-07T09:00:00Z", fetchedAt: "2026-10-07T09:00:00Z" } }];
  const before = JSON.stringify(state);
  const view = policyView(state), flow = canvasFlow(state);
  expect(view.graph.action).toEqual(transfer.action);
  expect(view.action).toContain("0.001 SOL");
  expect(flow.nodes.some(node => node.data.kind === "vault")).toBe(false);
  expect(flow.edges.find(edge => edge.id === "evidence:transfer-run")?.source).toBe("action:solana-transfer");
  expect(runOutcome(run)).toContain("0.001 SOL transfer confirmed on Solana devnet at slot 123");
  expect(runOutcome(run)).not.toMatch(/vault|pause|EVM/i);
  expect(JSON.stringify(state)).toBe(before);
});
