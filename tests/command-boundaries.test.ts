import { expect, test } from "bun:test";
import { command } from "../server/command";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import type { GraphObject } from "../shared/types";

function engine() {
  const price: GraphObject = {
    id: "price:eth-usd", kind: "price", label: "ETH / USD", visible: true, pinned: false,
    data: { symbol: "ETH", name: "Ethereum", price: 2500, productId: "ETH-USD" },
    provenance: { source: "test", kind: "fixture", label: "test", observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString() },
  };
  return new Engine(new StateStore(":memory:"), {
    fetchPrice: async () => price,
    fetchVault: async () => ({ ...price, id: "vault:grant", kind: "vault", label: "Grant vault", data: { paused: false } }),
    loadDeployment: async () => null,
  });
}

test("unsupported keyboard trading requests cannot silently become vault pause policies", async () => {
  const e = engine();
  await e.invoke("discover_objects", { operationId: "discover" });
  const before = structuredClone(e.state.workflow);
  for (const text of ["Copy trade this wallet", "If ETH is below $3000, sell 1 ETH", "If ETH drops 10%, pause the vault", "If ETH is below $3000 or above $4000, pause the vault", "If Solana is below $100, pause the vault", "Do not run", "BTC below $100, pause spending", "I don't want to run the rule"]) {
    const result = await command(e, text, crypto.randomUUID());
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_COMMAND");
    expect(e.state.workflow).toEqual(before);
    expect(e.state.runs).toHaveLength(0);
  }
});

test("explicit keyboard canvas clearing uses current session and ordinary threshold request still composes", async () => {
  const e = engine();
  await e.invoke("discover_objects", { operationId: "discover" });
  expect((await command(e, "If ETH is below $3000, pause the vault", "compose")).ok).toBe(true);
  expect(e.state.workflow.threshold).toBe(3000);
  const sessionId = e.state.sessionId;
  expect((await command(e, "Reset the threshold to 3100", "reset-threshold")).ok).toBe(true);
  expect(e.state.workflow.threshold).toBe(3100);
  expect(e.state.sessionId).toBe(sessionId);
  expect((await command(e, "Clear the canvas", "clear")).ok).toBe(true);
  expect(e.state.sessionId).not.toBe(sessionId);
  expect(e.state.objects).toHaveLength(0);
});
