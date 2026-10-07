import { policyGraphSchema, policyHash, describeGraph, type Network, type PolicyGraph } from "../cre/graph";
import type { ExecutionSpecification } from "../cre/spec";
import type { ExecutionEvidence } from "../cre/runner";

/** Freezes a graph into the request every runner accepts. */
export function specOf(graphInput: unknown, runId: string, revision: number, maxAgeSeconds = 60): ExecutionSpecification {
  const graph = policyGraphSchema.parse(graphInput);
  return { version: 2, runId, revision, graph, policyHash: policyHash(graph), maxAgeSeconds, broadcast: true };
}

/** "Pause when ETH trades below X and the Chainlink BTC/USD feed is live": two providers, one AND. */
export function composedPause(ethBelowUsd: number, feedNetwork: Network): PolicyGraph {
  return policyGraphSchema.parse({
    nodes: [
      { id: "eth", kind: "price", source: { type: "exchange-trade", pair: "ETH-USD" } },
      { id: "btc", kind: "price", source: { type: "chainlink-feed", symbol: "BTC", network: feedNetwork } },
      { id: "ethBelow", kind: "compare", input: "eth", op: "<", value: ethBelowUsd },
      { id: "btcLive", kind: "compare", input: "btc", op: ">", value: 1 },
      { id: "both", kind: "and", inputs: ["ethBelow", "btcLive"] },
    ],
    root: "both",
    action: { type: "pause-vault" },
  });
}

export interface ProofOptions {
  label: string;
  feedNetwork: Network;
  execute: (spec: ExecutionSpecification) => Promise<ExecutionEvidence>;
  isPaused: () => Promise<boolean>;
  resume: () => Promise<string>;
  log?: (message: string) => void;
}
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(`Proof failed: ${message}`); };
const summarize = (spec: ExecutionSpecification, evidence: ExecutionEvidence) => ({
  policy: describeGraph(spec.graph), spec, evidence,
});

/**
 * The four cases the plan asks for, against one deployed vault:
 * false → no write; true → verified pause; duplicate → no second action;
 * unsupported action → refused with zero writes. Leaves the vault active.
 */
export async function proveSequence(options: ProofOptions) {
  const log = options.log ?? console.log;
  const suffix = Date.now().toString(36);
  const startedAt = new Date().toISOString();
  if (await options.isPaused()) log(`Vault was paused; resumed first (${await options.resume()})`);

  log("1/4 False condition: ETH below $1");
  const falseSpec = specOf(composedPause(1, options.feedNetwork), `prove-false-${suffix}`, 1);
  const falseResult = await options.execute(falseSpec);
  check(falseResult.decision === "noop" && !falseResult.transaction, "false condition must not write");
  const eth = falseResult.observations.find((o) => o.provider === "coinbase");
  check(eth, "false run must archive the exchange trade it read");

  const threshold = Math.ceil(eth!.usd * 1.1);
  log(`2/4 True condition: ETH below $${threshold} (10% above the trade just read) and BTC feed live`);
  const trueSpec = specOf(composedPause(threshold, options.feedNetwork), `prove-true-${suffix}`, 2);
  const trueResult = await options.execute(trueSpec);
  const tx = trueResult.transaction;
  check(tx?.status === "success" && tx.receiverConfirmed && tx.pausedAfter, "true condition must produce receipt + matching event + paused read");
  check(trueResult.policyHash === trueSpec.policyHash, "evidence must carry the frozen policy hash");

  log("3/4 Duplicate: same run replayed, then a new run of the same policy");
  const replay = await options.execute(trueSpec);
  check(replay.transaction?.hash === tx!.hash, "replaying a run must return its original evidence");
  const again = await options.execute({ ...trueSpec, runId: `prove-again-${suffix}` });
  check(again.decision === "noop" && !again.transaction, "a paused vault must not receive a second pause");

  log("4/4 Unsupported action: simulated sell must never write");
  const sellSpec = specOf({ ...composedPause(threshold, options.feedNetwork), action: { type: "sell", symbol: "ETH", amount: 1, venue: "mock-venue" } }, `prove-sell-${suffix}`, 3);
  let sell: { refused?: string; evidence?: ExecutionEvidence };
  try {
    const evidence = await options.execute(sellSpec);
    check(!evidence.transaction && evidence.simulatedOrder?.simulated, "a sell may only produce simulated evidence");
    sell = { evidence };
  } catch (error) {
    sell = { refused: error instanceof Error ? error.message : String(error) };
    check(/Simulated sells/.test(sell.refused!), `unexpected sell failure: ${sell.refused}`);
  }

  const resumeHash = await options.resume();
  log(`Vault resumed for the next demo (${resumeHash})`);
  return {
    label: options.label,
    startedAt,
    completedAt: new Date().toISOString(),
    feedNetwork: options.feedNetwork,
    cases: {
      falseCondition: summarize(falseSpec, falseResult),
      trueCondition: summarize(trueSpec, trueResult),
      duplicate: { replayReturnedSameHash: true, newRunOnPausedVault: summarize({ ...trueSpec, runId: `prove-again-${suffix}` }, again) },
      unsupportedAction: { spec: sellSpec, ...sell },
    },
    pause: { transactionHash: tx!.hash, blockNumber: tx!.blockNumber, policyHash: trueSpec.policyHash, runId: trueSpec.runId, revision: trueSpec.revision },
    resumeTransactionHash: resumeHash,
  };
}
