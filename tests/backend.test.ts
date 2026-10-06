import { test, expect } from "bun:test";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import type { GraphObject } from "../shared/types";
const price = (): GraphObject => ({
  id: "price:eth-usd",
  kind: "price",
  label: "ETH / USD",
  data: { price: 2500, history: [] },
  provenance: {
    source: "Test adapter",
    kind: "fixture",
    label: "Test input",
    observedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  },
  visible: true,
  pinned: false,
});
const vault = (paused = false): GraphObject => ({
  id: "vault:grant",
  kind: "vault",
  label: "Grant vault",
  data: { paused, balance: "0.12", fixture: true },
  provenance: {
    source: "Fixture",
    kind: "fixture",
    label: "Test fixture",
    observedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  },
  visible: true,
  pinned: false,
});
const create = (overrides: any = {}) =>
  new Engine(new StateStore(":memory:"), {
    fetchPrice: async () => price(),
    fetchVault: async (paused = false) => vault(paused),
    loadDeployment: async () => null,
    ...overrides,
  });
async function composed(engine: Engine) {
  await engine.invoke("discover_objects", { operationId: "discover" });
  return engine.invoke("patch_workflow", {
    expectedRevision: 0,
    patch: { threshold: 3000, maxAgeSeconds: 60, skipPaused: true },
    operationId: "compose",
  });
}
async function complete(engine: Engine) {
  for (let i = 0; i < 100; i++) {
    if (
      ["confirmed", "no-op", "failed"].includes(
        engine.state.runs[0]?.status || "",
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Run did not complete");
}

test("semantic focus resolves this and reports ambiguity", async () => {
  const e = create();
  await e.invoke("discover_objects", { operationId: "d" });
  await e.invoke("focus_object", { reference: "vault", operationId: "f" });
  const r = await e.invoke("inspect_object", {
    reference: "this",
    operationId: "i",
  });
  expect(r.summary).toContain("Grant vault");
  await composed(create());
  e.state.objects.push({ ...price(), id: "price:btc-usd", label: "BTC / USD" });
  const ambiguous = await e.invoke("focus_object", {
    reference: "USD",
    operationId: "a",
  });
  expect(ambiguous.state.clarification?.candidates).toHaveLength(2);
  expect(ambiguous.state.focus.objectId).toBe("vault:grant");
});

test("optimistic revisions prevent delayed patch overwrites", async () => {
  const e = create();
  await composed(e);
  const r = await e.invoke("patch_workflow", {
    expectedRevision: 0,
    patch: { threshold: 99 },
    operationId: "stale",
  });
  expect(r.ok).toBe(false);
  expect(r.code).toBe("REVISION_CONFLICT");
  expect(e.state.workflow.threshold).toBe(3000);
});

test("operation dedup prevents duplicate revisions and rejects conflicting reuse", async () => {
  const e = create();
  await composed(e);
  const args = {
    expectedRevision: 1,
    patch: { threshold: 2800 },
    operationId: "same",
  };
  await e.invoke("patch_workflow", args);
  const repeated = await e.invoke("patch_workflow", args);
  expect(repeated.duplicate).toBe(true);
  expect(e.state.workflow.revision).toBe(2);
  const conflict = await e.invoke("patch_workflow", {
    ...args,
    patch: { threshold: 2700 },
  });
  expect(conflict.code).toBe("OPERATION_CONFLICT");
});

test("running snapshot immutable; repeated run command does not duplicate action", async () => {
  const e = create();
  await composed(e);
  const first = await e.invoke("run_workflow", {
    expectedRevision: 1,
    operationId: "run1",
  });
  const second = await e.invoke("run_workflow", {
    expectedRevision: 1,
    operationId: "run2",
  });
  expect(second.runId).toBe(first.runId);
  await e.invoke("patch_workflow", {
    expectedRevision: 1,
    patch: { threshold: 1000 },
    operationId: "revise",
  });
  await complete(e);
  expect(e.state.runs).toHaveLength(1);
  expect(e.state.runs[0]!.snapshot.threshold).toBe(3000);
  expect(e.state.workflow.threshold).toBe(1000);
  expect(e.state.runs[0]!.status).toBe("confirmed");
  expect(e.state.runs[0]!.evidence?.transactionHash).toBeUndefined();
  expect(e.state.runs[0]!.executionMode).toContain("fixture");
});

test("stale and future price data cannot pause; paused vault is clear no-op", async () => {
  for (const observedAt of [
    new Date(Date.now() - 120000).toISOString(),
    new Date(Date.now() + 60000).toISOString(),
  ]) {
    const e = create({
      fetchPrice: async () => ({
        ...price(),
        provenance: { ...price().provenance, observedAt },
      }),
    });
    await composed(e);
    await e.invoke("run_workflow", { expectedRevision: 1, operationId: "run" });
    await complete(e);
    expect(e.state.runs[0]!.status).toBe("no-op");
    expect(e.fixturePaused).toBe(false);
  }
  const e = create({ fetchVault: async () => vault(true) });
  await composed(e);
  await e.invoke("run_workflow", { expectedRevision: 1, operationId: "run" });
  await complete(e);
  expect(e.state.runs[0]!.status).toBe("no-op");
  expect(
    e.state.runs[0]!.decisions.find((x) => x.id === "unpaused")?.passed,
  ).toBe(false);
});

test("run fetching errors remain visible and produce no success evidence", async () => {
  let calls = 0;
  const e = create({
    fetchPrice: async () => {
      if (calls++ > 0) throw new Error("Source unavailable");
      return price();
    },
  });
  await composed(e);
  await e.invoke("run_workflow", { expectedRevision: 1, operationId: "r" });
  await complete(e);
  expect(e.state.runs[0]!.status).toBe("failed");
  expect(e.state.runs[0]!.error).toContain("Source unavailable");
  expect(e.state.runs[0]!.evidence).toBeUndefined();
});

test("persistent draft and operation dedup survive engine reconstruction", async () => {
  const store = new StateStore(":memory:");
  const sources = {
    fetchPrice: async () => price(),
    fetchVault: async (paused = false) => vault(paused),
    loadDeployment: async () => null,
  };
  const first = new Engine(store, sources);
  await composed(first);
  const args = {
    expectedRevision: 1,
    patch: { threshold: 2900 },
    operationId: "persisted-edit",
  };
  await first.invoke("patch_workflow", args);
  const restored = new Engine(store, sources);
  expect(restored.state.workflow.revision).toBe(2);
  expect(restored.state.workflow.threshold).toBe(2900);
  expect((await restored.invoke("patch_workflow", args)).duplicate).toBe(true);
  expect(restored.state.workflow.revision).toBe(2);
});

test("single-source discovery failure remains a visible failure", async () => {
  const e = create({
    fetchPrice: async () => {
      throw new Error("Exchange unavailable");
    },
  });
  const result = await e.invoke("discover_objects", {
    objects: ["price"],
    operationId: "single-source",
  });
  expect(result.ok).toBe(false);
  expect(result.state.activity.status).toBe("error");
  expect(result.summary).toContain("Exchange unavailable");
  expect(result.state.objects).toHaveLength(0);
});

test("explicit inspection selects older immutable run without changing drafts or ordering", async () => {
  const e = create();
  await composed(e);
  await e.invoke("run_workflow", {
    expectedRevision: 1,
    operationId: "inspect-run-first",
  });
  await complete(e);
  const older = e.state.runs[0]!;
  await e.invoke("patch_workflow", {
    expectedRevision: 1,
    patch: { threshold: 1 },
    operationId: "inspect-revise",
  });
  await e.invoke("run_workflow", {
    expectedRevision: 2,
    operationId: "inspect-run-latest",
  });
  await complete(e);
  const latest = e.state.runs[0]!;
  expect(e.state.inspectedRunId).toBe(latest.id);
  const beforeDraft = structuredClone(e.state.workflow);
  const beforeRuns = structuredClone(e.state.runs);
  const inspected = await e.invoke("get_run", {
    runId: older.id,
    operationId: "inspect-older",
  });
  expect(inspected.runId).toBe(older.id);
  expect(e.state.inspectedRunId).toBe(older.id);
  expect(e.state.focus.label).toBe("Execution v01");
  expect(e.state.mode).toBe("run");
  expect(e.state.workflow).toEqual(beforeDraft);
  expect(e.state.runs).toEqual(beforeRuns);
  // Returning a previously executed current version selects it, without duplicate execution.
  await e.invoke("run_workflow", {
    expectedRevision: 2,
    operationId: "inspect-return-latest",
  });
  expect(e.state.inspectedRunId).toBe(latest.id);
  expect(e.state.runs).toHaveLength(2);
});

test("back restores workflow and selected run contexts while skipping removed conditions", async () => {
  const e = create();
  await composed(e);
  await e.invoke("focus_object", {
    reference: "price",
    operationId: "back-price",
  });
  await e.invoke("focus_object", {
    reference: "source",
    operationId: "back-source",
  });
  await e.invoke("focus_object", {
    reference: "back",
    operationId: "back-to-price",
  });
  expect(e.state.focus.objectId).toBe("price:eth-usd");
  expect(e.state.mode).toBe("explore");
  await e.invoke("focus_object", {
    reference: "back",
    operationId: "back-to-rule",
  });
  expect(e.state.focus.objectId).toBe(e.state.workflow.id);
  expect(e.state.focus.label).toBe("Treasury policy");
  expect(e.state.mode).toBe("compose");
  await e.invoke("run_workflow", {
    expectedRevision: 1,
    operationId: "back-execute",
  });
  await complete(e);
  const run = e.state.runs[0]!;
  await e.invoke("focus_object", {
    reference: "source",
    operationId: "back-leave-run",
  });
  await e.invoke("focus_object", {
    reference: "back",
    operationId: "back-to-run",
  });
  expect(e.state.mode).toBe("run");
  expect(e.state.inspectedRunId).toBe(run.id);
  expect(e.state.focus.label).toBe("Execution v01");
  await e.invoke("focus_object", {
    reference: "freshness",
    operationId: "back-condition",
  });
  await e.invoke("patch_workflow", {
    expectedRevision: 1,
    patch: { maxAgeSeconds: null },
    operationId: "back-remove-condition",
  });
  await e.invoke("focus_object", {
    reference: "vault",
    operationId: "back-vault",
  });
  await e.invoke("focus_object", {
    reference: "back",
    operationId: "back-current-draft",
  });
  const recovered = await e.invoke("focus_object", {
    reference: "back",
    operationId: "back-skip-deleted",
  });
  expect(recovered.ok).toBe(true);
  expect(e.state.mode).toBe("run");
  expect(e.state.inspectedRunId).toBe(run.id);
  expect(e.state.focus.objectId).toBe(`run:${run.id}`);
  expect(e.state.workflow.revision).toBe(2);
  expect(e.state.workflow.maxAgeSeconds).toBeNull();
  expect(run.snapshot.maxAgeSeconds).toBe(60);
});

test("direct run focus accepts semantic and raw run IDs without execution or snapshot changes", async () => {
  const e = create();
  await composed(e);
  await e.invoke("run_workflow", {
    expectedRevision: 1,
    operationId: "direct-focus-create",
  });
  await complete(e);
  const run = e.state.runs[0]!;
  const beforeRuns = structuredClone(e.state.runs);
  const beforeDraft = structuredClone(e.state.workflow);
  await e.invoke("focus_object", {
    reference: "source",
    operationId: "direct-focus-leave",
  });
  const focused = await e.invoke("focus_object", {
    reference: `run:${run.id}`,
    operationId: "direct-focus-semantic",
  });
  expect(focused.ok).toBe(true);
  expect(focused.runId).toBe(run.id);
  expect(e.state.mode).toBe("run");
  expect(e.state.inspectedRunId).toBe(run.id);
  expect(e.state.focus.label).toBe("Execution v01");
  const raw = await e.invoke("focus_object", {
    reference: run.id,
    operationId: "direct-focus-raw",
  });
  expect(raw.ok).toBe(true);
  const current = await e.invoke("focus_object", {
    reference: "this",
    operationId: "direct-focus-this",
  });
  expect(current.runId).toBe(run.id);
  const unknown = await e.invoke("focus_object", {
    reference: "run:run-missing",
    operationId: "direct-focus-missing",
  });
  expect(unknown.ok).toBe(false);
  expect(unknown.summary).toContain("No execution run matches");
  expect(e.state.inspectedRunId).toBe(run.id);
  expect(e.state.runs).toEqual(beforeRuns);
  expect(e.state.workflow).toEqual(beforeDraft);
});
