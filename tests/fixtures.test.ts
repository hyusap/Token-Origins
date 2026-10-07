import { test, expect } from "bun:test";
import { buildFixtures } from "../scripts/generate-fixtures";

// The committed fixture states are the UI/voice contract. If engine behaviour
// changes, regenerate them deliberately: bun run scripts/generate-fixtures.ts
test("committed fixture states match what the engine produces today", async () => {
  const built = await buildFixtures();
  expect(built.map((f) => f.name)).toEqual([
    "legacy-rule", "nested-and-or-not", "false-root-true-branch", "true-branch-in-passing-or",
    "guard-blocked-true-root", "unsupported-source", "mock-sell", "failed-write", "verified-pause",
    "reserve-guardian-sweep", "grant-stream-watching", "ccip-evacuation-verified", "yield-chase-simulated",
  ]);
  for (const fixture of built) {
    const committed = await Bun.file(`fixtures/states/${fixture.name}.json`).json();
    expect({ name: fixture.name, ...committed.expected }).toEqual({ name: fixture.name, ...fixture.expected });
  }
});

test("fixture outcomes encode the execution contract", async () => {
  const byName = Object.fromEntries((await buildFixtures()).map((f) => [f.name, f]));
  expect(byName["false-root-true-branch"]!.expected.blockedBy).toBe("guard:root");
  expect(byName["guard-blocked-true-root"]!.expected.blockedBy).toBe("guard:vault-active");
  expect(byName["true-branch-in-passing-or"]!.expected.runStatus).toBe("confirmed");
  expect(byName["mock-sell"]!.state.runs[0]!.evidence?.transactionHash).toBeUndefined();
  expect(byName["failed-write"]!.state.runs[0]!.evidence).toBeUndefined();
  expect(byName["verified-pause"]!.state.runs[0]!.evidence?.policyHash).toBe(byName["verified-pause"]!.expected.policyHash as string);
  expect(byName["unsupported-source"]!.state.workflow.revision).toBe(1);
  // Winner-inspired recipes: real effects only where something real moves, and said plainly.
  expect(byName["reserve-guardian-sweep"]!.state.runs[0]!.evidence?.fixtureEffects).toEqual({ sweptEth: 0.06, paused: true });
  expect(byName["grant-stream-watching"]!.state.watch).toMatchObject({ status: "watching", checks: 1 });
  expect(byName["grant-stream-watching"]!.state.runs[0]).toMatchObject({ trigger: "watch", watchCheck: 1, evidence: { fixtureEffects: { paidEth: 0.001, payee: "grantee" } } });
  expect(byName["ccip-evacuation-verified"]!.state.runs[0]!.evidence?.ccipExplorerUrl).toMatch(/^https:\/\/ccip\.chain\.link\/msg\/0x/);
  expect(byName["yield-chase-simulated"]!.state.runs[0]!.evidence).toMatchObject({ simulatedRebalance: { simulated: true, fromAprPercent: 3.1, toAprPercent: 3.9 } });
  expect(byName["yield-chase-simulated"]!.state.runs[0]!.evidence?.transactionHash).toBeUndefined();
});
