import { afterEach, beforeEach, expect, test } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import type { Deployment } from "../server/sources";
import type { GraphObject } from "../shared/types";
import type { ExecutionSpecification } from "../cre/spec";
import type { ExecutionEvidence } from "../cre/runner";
import { sourceIdentity, policyHash } from "../cre/graph";
import { Keypair } from "@solana/web3.js";
import { SOLANA_GENESIS } from "../server/solana";

const address = "0x1111111111111111111111111111111111111111" as const;
const engines: Engine[] = [];
let previousMode: string | undefined;
beforeEach(() => { previousMode = process.env.ORIGINS_EXECUTION_MODE; process.env.ORIGINS_EXECUTION_MODE = "cre"; });
afterEach(async () => {
  for (const e of engines.splice(0)) { e.monitors.close(); await Promise.resolve(); e.store.db.close(); }
  if (previousMode === undefined) delete process.env.ORIGINS_EXECUTION_MODE; else process.env.ORIGINS_EXECUTION_MODE = previousMode;
});
function price(): GraphObject {
  return { id: "price:sol-usd", kind: "price", label: "SOL / USD", data: { price: 150, productId: "SOL-USD", symbol: "SOL", history: [] },
    provenance: { kind: "fixture", source: "Test adapter", label: "Test only", observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString() }, visible: true, pinned: false };
}
function vault(): GraphObject {
  return { id: "vault:grant", kind: "vault", label: "Vault", data: { address, chainId: 11155111, paused: false, reportVersion: 2, balance: "0.1" },
    provenance: { kind: "chain", chainId: 11155111, address, source: "Injected test RPC", label: "Test only", observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString() }, visible: true, pinned: false };
}
function evidence(spec: ExecutionSpecification, act: boolean): ExecutionEvidence {
  return {
    runId: spec.runId, revision: spec.revision, policyHash: spec.policyHash, mode: "cre-local-simulation", action: "pause-vault",
    vault: { address, chainId: 11155111, paused: false, reportVersion: 2, balanceWei: "1" },
    observations: [{ ...sourceIdentity({ type: "exchange-trade", pair: "SOL-USD" }), usd: 150, raw: "150", fetchedAt: new Date().toISOString(), observedAt: new Date().toISOString() }],
    conditions: [], root: act, decision: act ? "act" : "noop", decidedAt: new Date().toISOString(), logs: [],
    ...(act && !spec.broadcast ? { dryRun: true } : {}),
    ...(act && spec.broadcast ? { transaction: { hash: "0xabc", status: "success", receiverConfirmed: true, pausedAfter: true, blockNumber: 12 } } : {}),
  };
}
async function setup(act = false) {
  let deployment: Deployment = { address, forwarder: "0x2222222222222222222222222222222222222222", chainId: 11155111, rpcUrl: "https://rpc.test.invalid" };
  const calls: ExecutionSpecification[] = [];
  const e = new Engine(new StateStore(":memory:"), {
    fetchPrice: async () => price(), fetchVault: async () => vault(), loadDeployment: async () => deployment,
    executeRun: async spec => { calls.push(structuredClone(spec)); return evidence(spec, act); },
  });
  engines.push(e);
  await e.invoke("discover_objects", { tokens: ["SOL"], operationId: "discover" });
  const composed = await e.invoke("patch_workflow", { expectedRevision: 0, patch: { priceReference: "SOL", threshold: 200 }, operationId: "compose" });
  expect(composed.ok).toBe(true);
  return { e, calls, drift: () => { deployment = { ...deployment, address: "0x3333333333333333333333333333333333333333" }; } };
}

test("semantic activation freezes SOL policy and exposes actual monitor state", async () => {
  const { e, calls } = await setup();
  const activated = await e.invoke("activate_policy", { expectedRevision: 1, intervalSeconds: 15, operationId: "activate" });
  expect(activated.ok).toBe(true);
  const id = e.monitors.list()[0]!.id;
  await e.invoke("patch_workflow", { expectedRevision: 1, patch: { threshold: 100 }, operationId: "edit" });
  await e.monitors.tick();
  expect(calls[0]!.revision).toBe(1);
  expect(calls[0]!.graph.nodes.find(n => n.kind === "price")).toMatchObject({ source: { pair: "SOL-USD" } });
  expect(calls[0]!.graph.nodes.find(n => n.kind === "compare")).toMatchObject({ value: 200 });
  const read = await e.invoke("get_monitors", { monitorId: id });
  expect(read.ok).toBe(true);
  expect((read.data!.monitors as any[])[0].checks).toBe(1);
  expect(read.state.monitors?.[0]!.latestEvidence?.observations[0]!.usd).toBe(150);
  const cleared = await e.invoke("reset_session", { operationId: "clear" });
  expect(cleared.ok).toBe(false);
  expect(cleared.error).toContain("monitors");
  const stop = await e.invoke("deactivate_policy", { monitorId: id, operationId: "stop" });
  expect(stop.ok).toBe(true);
  expect(e.monitors.get(id).status).toBe("paused");
});

test("activation rejects stale revisions and mainnet targets through the semantic API", async () => {
  const { e } = await setup();
  const stale = await e.invoke("activate_policy", { expectedRevision: 0, operationId: "stale" });
  expect(stale.code).toBe("REVISION_CONFLICT");
  e.sources.loadDeployment = async () => ({ address, chainId: 1, rpcUrl: "https://example.com" });
  const unsupported = await e.invoke("activate_policy", { expectedRevision: 1, operationId: "mainnet" });
  expect(unsupported.ok).toBe(false);
  expect(unsupported.error).toContain("mainnet");
  expect(e.monitors.list()).toHaveLength(0);
});

test("deployment drift blocks monitor execution before any runner or write", async () => {
  const { e, calls, drift } = await setup();
  await e.invoke("activate_policy", { expectedRevision: 1, operationId: "activate" });
  drift();
  await e.monitors.tick();
  expect(calls).toHaveLength(0);
  const monitor = e.monitors.list()[0]!;
  expect(monitor.lastError).toContain("changed");
  expect(monitor.status).toBe("active");
  expect(monitor.nextCheckAt).toBeTruthy();
});

test("a completed monitor publishes its frozen verified receipt into the execution ledger", async () => {
  const { e, calls } = await setup(true);
  await e.invoke("activate_policy", { expectedRevision: 1, operationId: "activate" });
  await e.monitors.tick();
  // monitorChanged maps the verified runner evidence asynchronously onto canvas state.
  for (let i = 0; i < 20 && e.state.runs[0]?.status !== "confirmed"; i++) await Bun.sleep(5);
  expect(calls).toHaveLength(2);
  expect(e.monitors.list()[0]!.status).toBe("completed");
  expect(e.state.runs[0]!.status).toBe("confirmed");
  expect(e.state.runs[0]!.evidence!.transactionHash).toBe("0xabc");
  expect(e.state.runs[0]!.revision).toBe(1);
  expect(e.state.runs[0]!.observations![0]!.key).toBe("exchange-trade:SOL-USD");
});

test("semantic activation cannot resurrect a historical Solana action", async () => {
  const { e, calls } = await setup();
  const sender = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();
  let signerCalls = 0;
  const originalDependencies = e.policyDependencies.bind(e);
  e.policyDependencies = () => ({ ...originalDependencies(),
    solanaTarget: async () => ({ network: "devnet", sender, genesisHash: SOLANA_GENESIS.devnet }),
    transfer: async () => { signerCalls++; throw new Error("Archived actions must not sign"); },
  });
  // Seed a historical draft rather than installing a direct action through product composition.
  const graph = structuredClone(e.state.workflow.graph);
  graph.action = { type: "solana-transfer", network: "devnet", recipient, amountLamports: 1000 };
  e.state.workflow.graph = graph; e.state.workflow.policyHash = policyHash(graph);
  const revision = e.state.workflow.revisions.at(-1)!;
  revision.graph = graph; revision.policyHash = policyHash(graph);
  const activated = await e.invoke("activate_policy", { expectedRevision: 1, operationId: "activate-archive" });
  expect(activated.ok).toBe(false);
  expect(e.monitors.list()).toHaveLength(0);
  expect(signerCalls).toBe(0);
  expect(calls).toHaveLength(0);
});
