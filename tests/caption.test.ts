import { expect, test } from "bun:test";
import { displayReply } from "../src/display-reply";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";

test("completion caption records actual words without restarting activity or changing task evidence", async () => {
  const engine = new Engine(new StateStore(":memory:"));
  await engine.invoke("set_activity", { status: "idle", summary: "Bitcoin is $85,275.", operationId: "done" });
  const activity = structuredClone(engine.state.activity);
  const workflow = structuredClone(engine.state.workflow);
  await engine.invoke("submit_utterance", { text: "What about Bitcoin?", operationId: "caption" });
  expect(engine.state.activity).toEqual(activity);
  expect(engine.state.workflow).toEqual(workflow);
  expect(engine.state.conversation.at(-1)?.text).toBe("What about Bitcoin?");
});

test("price captions are readable while errors, partial discoveries and natural replies stay honest", () => {
  expect(displayReply("Discovered BTC / USD: $85275 (Coinbase Exchange, observed 2026-10-06T06:33:54Z).")).toBe("Bitcoin is $85,275.00.");
  expect(displayReply("Discovered SOL / USD: $119.46 (Coinbase Exchange, observed 2026-10-06T06:29:53Z); BTC / USD: $85241.31 (Coinbase Exchange, observed 2026-10-06T06:29:57Z).")).toBe("Solana is $119.46. Bitcoin is $85,241.31.");
  for (const text of ["Unsupported token XYZ", "Discovery partly succeeded. Failed: Unsupported token XYZ", "Discovered Grant vault.", "Bitcoin is $85,275."]) expect(displayReply(text)).toBe(text);
});
