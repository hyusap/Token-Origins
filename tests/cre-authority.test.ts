import { test, expect } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { legacyGraph, policyHash, type PolicyGraph } from "../cre/graph";
import { executeDispatchedPolicy, resolvePolicyTarget, type PolicyExecutorDependencies } from "../server/policy-executor";
import { CRE_UNAVAILABLE_PRODUCT_TOOLS, publicToolDefinitions, toolDefinitions } from "../server/schemas";
import { runtime } from "../server/runtime";

const solanaGraph: PolicyGraph = { ...legacyGraph(1, "SOL-USD"), action: {
  type: "solana-transfer", network: "devnet", recipient: "11111111111111111111111111111111", amountLamports: 1,
} };
const specification = (graph: PolicyGraph) => ({ version: 2 as const, runId: "authority_boundary", revision: 1,
  graph, policyHash: policyHash(graph), maxAgeSeconds: 60, broadcast: true });

test("product authority advertises only implemented CRE actions and excludes standalone utilities", () => {
  expect(runtime.supports.executionAuthority).toBe("chainlink-cre");
  expect(runtime.supports.actions).toEqual(["pause-vault"]);
  for (const name of CRE_UNAVAILABLE_PRODUCT_TOOLS) expect(publicToolDefinitions).not.toHaveProperty(name);
  expect(toolDefinitions.compose_graph.schema.safeParse({ expectedRevision: 0, graph: solanaGraph, operationId: "solana" }).success).toBe(false);
});

test("default engine rejects signing utilities before replaying historical cached success", async () => {
  const store = new StateStore(":memory:");
  const engine = new Engine(store);
  try {
    expect(engine.researchExecution).toBe(false);
    for (const name of ["transfer_solana_devnet", "copy_evm_swap", "activate_evm_trade_watch"]) {
      store.remember(name, "historical", { ok: true, summary: "Historical direct executor result", state: engine.context() });
      const result = await engine.invoke(name, { operationId: name });
      expect(result).toMatchObject({ ok: false, code: "CRE_EXECUTION_REQUIRED" });
      expect(result.duplicate).toBeUndefined();
    }
    expect(engine.state.runs).toHaveLength(0);
    expect(engine.monitors.list(engine.state.sessionId)).toHaveLength(0);
  } finally { engine.close(); }
});

test("default engine rejects direct graph composition even when caller bypasses public schema", async () => {
  const engine = new Engine(new StateStore(":memory:"));
  try {
    const result = await engine.invoke("compose_graph", { graph: solanaGraph, expectedRevision: 0, operationId: "bypass" });
    expect(result).toMatchObject({ ok: false, code: "CRE_EXECUTION_REQUIRED" });
    expect(engine.state.workflow.revision).toBe(0);
    expect(engine.state.runs).toHaveLength(0);
  } finally { engine.close(); }
});

test("persisted direct policy cannot be executed or restored through current product tools", async () => {
  const engine = new Engine(new StateStore(":memory:"));
  try {
    const workflow = engine.state.workflow;
    const historical = { ...workflow, revision: 1, graph: solanaGraph, policyHash: policyHash(solanaGraph), createdAt: new Date().toISOString(), reason: "Historical research policy" };
    workflow.revisions = [historical];
    Object.assign(workflow, historical, { revisions: [historical], created: true });
    expect(await engine.invoke("run_workflow", { expectedRevision: 1, operationId: "historical-run" }))
      .toMatchObject({ ok: false, code: "CRE_EXECUTION_REQUIRED" });
    expect(await engine.invoke("activate_policy", { expectedRevision: 1, intervalSeconds: 15, operationId: "historical-activate" }))
      .toMatchObject({ ok: false, code: "CRE_EXECUTION_REQUIRED" });
    workflow.revisions.push({ ...historical, revision: 2, graph: legacyGraph(1), policyHash: policyHash(legacyGraph(1)) });
    workflow.revision = 2;
    expect(await engine.invoke("undo_revision", { expectedRevision: 2, operationId: "historical-undo" }))
      .toMatchObject({ ok: false, code: "CRE_EXECUTION_REQUIRED" });
    expect(engine.state.runs).toHaveLength(0);
    expect(engine.monitors.list(engine.state.sessionId)).toHaveLength(0);
  } finally { engine.close(); }
});

test("default dispatcher rejects direct targets before deployment, source or signer calls", async () => {
  let calls = 0;
  const forbidden = async (): Promise<never> => { calls++; throw new Error("Boundary must reject before adapter access"); };
  const dependencies: PolicyExecutorDependencies = { deployment: forbidden, fetchExchange: forbidden,
    resolveFeed: forbidden, transfer: forbidden, solanaTarget: forbidden, executeEvm: forbidden };
  const targets = [
    { kind: "evm-vault", executor: "local-evm", chainId: 31337, address: "0x1111111111111111111111111111111111111111" },
    { kind: "evm-vault", executor: "testnet-evm", chainId: 11155111, address: "0x1111111111111111111111111111111111111111" },
    { kind: "solana-wallet", executor: "solana-devnet", network: "devnet", sender: "11111111111111111111111111111111", genesisHash: "research" },
  ] as const;
  for (const target of targets) {
    await expect(executeDispatchedPolicy(specification(legacyGraph(1)), target as any, undefined, dependencies))
      .rejects.toMatchObject({ code: "CRE_EXECUTION_REQUIRED" });
  }
  await expect(resolvePolicyTarget(solanaGraph, dependencies)).rejects.toMatchObject({ code: "CRE_EXECUTION_REQUIRED" });
  const creTarget = { kind: "evm-vault", executor: "cre", chainId: 11155111, address: "0x1111111111111111111111111111111111111111" } as const;
  await expect(executeDispatchedPolicy(specification(solanaGraph), creTarget, undefined, dependencies))
    .rejects.toMatchObject({ code: "CRE_EXECUTION_REQUIRED" });
  expect(calls).toBe(0);
});
