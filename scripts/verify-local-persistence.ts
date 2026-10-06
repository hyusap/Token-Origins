import { resolve } from "node:path";
import {
  parseAbi,
  decodeEventLog,
  keccak256,
  toBytes,
  encodeFunctionData,
} from "viem";
import { snapshotLocalChain, localRpc } from "./snapshot-local";

const root = resolve(import.meta.dir, "..");
const isolatedRpc = "http://127.0.0.1:8546";
const vaultAbi = parseAbi([
  "function paused() view returns (bool)",
  "function processedRuns(bytes32) view returns (bool)",
  "event SpendingPaused(bytes32 indexed runId,uint256 indexed revision,uint256 priceUsdCents,uint256 thresholdUsdCents,uint256 observedAt)",
]);
type Candidate = {
  hash: string;
  source: string;
  runId?: string;
  revision?: number;
  blockNumber?: number;
};
const candidates: Candidate[] = [];
const hashPattern = /^0x[0-9a-fA-F]{64}$/;

async function isolatedCall<T = any>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await fetch(isolatedRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(2000),
  });
  const reply = (await response.json()) as any;
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}

// Never reuse or stop another process that already owns the validation port.
let occupied = false;
try {
  await isolatedCall("eth_chainId");
  occupied = true;
} catch {}
if (occupied)
  throw new Error("Port 8546 already belongs to a node; refusing to touch it");
const deployment = await Bun.file(
  resolve(root, "contracts/deployment.local.json"),
).json();
if (
  deployment.chainId !== 31337 ||
  deployment.rpcUrl !== "http://127.0.0.1:8545"
)
  throw new Error("Verification supports only this project local chain");

function collectRuns(value: any, source: string) {
  const runs = value?.runs ?? value?.finalState?.runs ?? [];
  for (const run of runs) {
    const evidence = run.evidence;
    if (
      run.status !== "confirmed" ||
      evidence?.chainId !== 31337 ||
      evidence.contractAddress?.toLowerCase() !==
        deployment.address.toLowerCase() ||
      !hashPattern.test(evidence.transactionHash ?? "")
    )
      continue;
    candidates.push({
      hash: evidence.transactionHash,
      source,
      runId: run.id,
      revision: run.revision,
      blockNumber: Number(evidence.blockNumber),
    });
  }
}
try {
  const response = await fetch("http://127.0.0.1:4318/api/state", {
    signal: AbortSignal.timeout(2000),
  });
  if (response.ok)
    collectRuns(await response.json(), "current local API state");
} catch {}
for (const path of [
  ".data/rehearsal-report.json",
  "demo/rehearsal-report.json",
]) {
  try {
    collectRuns(await Bun.file(resolve(root, path)).json(), path);
  } catch {}
}
try {
  const evidence = (
    await Bun.file(resolve(root, "contracts/evidence.local.json")).json()
  ).trueResult;
  if (
    evidence?.vault?.chainId === 31337 &&
    evidence.vault.address?.toLowerCase() ===
      deployment.address.toLowerCase() &&
    evidence.transaction?.status === "success" &&
    evidence.transaction.receiverConfirmed &&
    hashPattern.test(evidence.transaction.hash)
  ) {
    candidates.push({
      hash: evidence.transaction.hash,
      source: "contracts/evidence.local.json",
      runId: evidence.runId,
      revision: evidence.revision,
      blockNumber: Number(evidence.transaction.blockNumber),
    });
  }
} catch {}

const override = process.env.ORIGINS_VERIFY_TX_HASH;
if (override && !hashPattern.test(override))
  throw new Error(
    "ORIGINS_VERIFY_TX_HASH must be a public 32-byte transaction hash",
  );
const requested = override
  ? [
      candidates.find(
        (candidate) => candidate.hash.toLowerCase() === override.toLowerCase(),
      ) ?? { hash: override, source: "explicit public transaction hash" },
    ]
  : candidates.sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0));
let selected: Candidate | undefined;
let sourceReceipt: any;
let sourceEvent: ReturnType<typeof decodeEventLog<typeof vaultAbi>> | undefined;
for (const candidate of requested) {
  const receipt = await localRpc<any>("eth_getTransactionReceipt", [
    candidate.hash,
  ]);
  if (
    !receipt ||
    receipt.status !== "0x1" ||
    receipt.to?.toLowerCase() !== deployment.forwarder.toLowerCase()
  )
    continue;
  const log = receipt.logs.find(
    (entry: any) =>
      entry.address.toLowerCase() === deployment.address.toLowerCase() &&
      entry.transactionHash.toLowerCase() === candidate.hash.toLowerCase(),
  );
  if (!log) continue;
  try {
    const event = decodeEventLog({
      abi: vaultAbi,
      data: log.data,
      topics: log.topics,
    });
    if (
      event.eventName !== "SpendingPaused" ||
      event.args.revision <= 0n ||
      event.args.priceUsdCents >= event.args.thresholdUsdCents
    )
      continue;
    if (
      candidate.runId &&
      event.args.runId !== keccak256(toBytes(candidate.runId))
    )
      continue;
    if (
      candidate.revision &&
      event.args.revision !== BigInt(candidate.revision)
    )
      continue;
    const processed = await localRpc<string>("eth_call", [
      {
        to: deployment.address,
        data: encodeFunctionData({
          abi: vaultAbi,
          functionName: "processedRuns",
          args: [event.args.runId],
        }),
      },
      receipt.blockNumber,
    ]);
    if (BigInt(processed) !== 1n) continue;
    selected = candidate;
    sourceReceipt = receipt;
    sourceEvent = event;
    break;
  } catch {}
}
if (!selected || !sourceReceipt || !sourceEvent)
  throw new Error(
    "No confirmed local pause receipt found. Run a true policy version first, or set ORIGINS_VERIFY_TX_HASH to its public transaction hash.",
  );
const receiptHash = selected.hash;
const receiptBlock = sourceReceipt.blockNumber;
const receiptBlockNumber = Number(BigInt(receiptBlock));
const checkpoint = await snapshotLocalChain({
  outputPath: ".data/anvil-validation-state.json",
  preserveHistoricalStates: true,
});
if (receiptBlockNumber > checkpoint.blockNumber)
  throw new Error("Receipt is newer than the captured snapshot");
const block = `0x${checkpoint.blockNumber.toString(16)}`;
const pausedCall = {
  to: deployment.address,
  data: encodeFunctionData({ abi: vaultAbi, functionName: "paused" }),
};
const source = [
  await localRpc("eth_getBalance", [deployment.address, block]),
  await localRpc("eth_call", [pausedCall, block]),
  await localRpc("eth_call", [pausedCall, receiptBlock]),
];
if (BigInt(source[2] as string) !== 1n)
  throw new Error("Selected receipt block does not show a paused vault");
const anvil = Bun.which("anvil");
if (!anvil) throw new Error("Foundry Anvil is required");
const child = Bun.spawn(
  [
    anvil,
    "--host",
    "127.0.0.1",
    "--port",
    "8546",
    "--chain-id",
    "31337",
    "--state",
    checkpoint.path,
    "--state-interval",
    "5",
    "--preserve-historical-states",
    "--no-cors",
    "--silent",
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
try {
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    await Bun.sleep(100);
    try {
      ready = (await isolatedCall("eth_chainId")) === "0x7a69";
    } catch {}
  }
  if (!ready) throw new Error("Isolated restored node did not become ready");
  const restoredHead = await isolatedCall("eth_getBlockByNumber", [
    block,
    false,
  ]);
  if (restoredHead.hash !== checkpoint.blockHash)
    throw new Error("Restored head block hash differs from checkpoint");
  const restoredReceipt = await isolatedCall("eth_getTransactionReceipt", [
    receiptHash,
  ]);
  if (
    !restoredReceipt ||
    restoredReceipt.status !== "0x1" ||
    restoredReceipt.blockNumber !== receiptBlock ||
    restoredReceipt.blockHash !== sourceReceipt.blockHash ||
    JSON.stringify(restoredReceipt.logs) !== JSON.stringify(sourceReceipt.logs)
  )
    throw new Error("Restored receipt/event evidence differs from source");
  const restoredTx = await isolatedCall("eth_getTransactionByHash", [
    receiptHash,
  ]);
  if (
    restoredTx?.hash.toLowerCase() !== receiptHash.toLowerCase() ||
    restoredTx.blockHash !== sourceReceipt.blockHash
  )
    throw new Error("Restored transaction lookup is missing");
  const restored = [
    await isolatedCall("eth_getBalance", [deployment.address, block]),
    await isolatedCall("eth_call", [pausedCall, block]),
    await isolatedCall("eth_call", [pausedCall, receiptBlock]),
  ];
  if (JSON.stringify(restored) !== JSON.stringify(source))
    throw new Error(
      "Restored latest and historical vault state differs from source",
    );
  if (
    BigInt(await isolatedCall("eth_blockNumber")) !==
    BigInt(checkpoint.blockNumber)
  )
    throw new Error("Restored current block differs from snapshot");
  const modifiedBefore = Bun.file(checkpoint.path).lastModified;
  await Bun.sleep(5500);
  const periodicState = await Bun.file(checkpoint.path).json();
  const periodicCheckpointSaved =
    Bun.file(checkpoint.path).lastModified > modifiedBefore &&
    periodicState.best_block_number === checkpoint.blockNumber;
  if (!periodicCheckpointSaved)
    throw new Error(
      "Periodic state persistence did not save the restored chain",
    );
  if (
    (await isolatedCall("eth_getTransactionReceipt", [receiptHash]))
      ?.blockHash !== sourceReceipt.blockHash
  )
    throw new Error("Receipt evidence disappeared after periodic checkpoint");
  const evidence = {
    periodicCheckpointSaved,
    verifiedAt: new Date().toISOString(),
    sourceChain: 31337,
    sourceRpc: "http://127.0.0.1:8545",
    validationRpc: isolatedRpc,
    checkpointBlock: checkpoint.blockNumber,
    checkpointHash: checkpoint.blockHash,
    selectedEvidenceSource: selected.source,
    restoredTransactionHash: receiptHash,
    restoredReceiptBlock: receiptBlockNumber,
    receiptStatus: "success",
    receiverLogsRestored: restoredReceipt.logs.length,
    correlatedReceiverEvent: {
      name: sourceEvent.eventName,
      runId: sourceEvent.args.runId,
      revision: Number(sourceEvent.args.revision),
    },
    transactionLookupRestored: true,
    balanceWei: BigInt(restored[0]).toString(),
    latestPaused: BigInt(restored[1]) === 1n,
    historicalReceiptBlockPaused: BigInt(restored[2]) === 1n,
    mainNodeMutated: false,
  };
  await Bun.write(
    resolve(root, ".data/anvil-persistence-verification.json"),
    JSON.stringify(evidence, null, 2),
  );
  await Bun.write(
    resolve(root, "demo/dynamic-persistence-verification.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  child.kill("SIGTERM");
  await child.exited;
}
