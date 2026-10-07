// Explains what a CRE forwarder transaction delivered to the vault.
//   bun run scripts/diagnose-cre-tx.ts <txHash>
// Read-only: decodes the forwarder call, its event, the report it sliced out,
// and replays exactly those bytes into the vault to get the receiver's verdict.
import { createPublicClient, http, parseAbi, decodeFunctionData, decodeEventLog, decodeAbiParameters, parseAbiParameters, decodeErrorResult, encodeFunctionData, toHex, size, slice, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";

const hash = process.argv[2] as Hex | undefined;
if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Usage: bun run scripts/diagnose-cre-tx.ts <txHash>");
const vault = process.env.ORIGINS_SEPOLIA_VAULT as Address | undefined;
const client = createPublicClient({ chain: sepolia, transport: http(process.env.ORIGINS_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com") });

const forwarderAbi = parseAbi([
  "function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)",
  "event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)",
  "function getTransmissionInfo(address receiver, bytes32 workflowExecutionId, bytes2 reportId) view returns ((bytes32 transmissionId, uint8 state, address transmitter, bool invalidReceiver, bool success, uint80 gasLimit))",
  "function typeAndVersion() view returns (string)",
]);
const STATES = ["NOT_ATTEMPTED", "SUCCEEDED", "INVALID_RECEIVER", "FAILED"];
const vaultAbi = parseAbi([
  "function onReport(bytes metadata, bytes report)",
  "function forwarder() view returns (address)",
  "function supportsInterface(bytes4) view returns (bool)",
  "function reportVersion() view returns (uint256)",
  "function paused() view returns (bool)",
  "error Unauthorized()", "error InvalidReport()", "error UnsupportedReport()", "error WrongTarget()", "error UnsupportedAction()", "error StaleReport()",
]);
const out: Record<string, unknown> = {};
const show = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const revert = (error: any) => {
  for (let e = error; e; e = e.cause) {
    const data = typeof e.data === "string" ? e.data : e.data?.data;
    if (typeof data === "string" && data.startsWith("0x")) {
      try { return `reverts ${decodeErrorResult({ abi: vaultAbi, data: data as Hex }).errorName}`; } catch { return `reverts with data ${data}`; }
    }
  }
  return `fails: ${String(error?.shortMessage || error?.message || error).slice(0, 200)}`;
};

const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
const block = await client.getBlock({ blockNumber: receipt.blockNumber });
out.transaction = { to: tx.to, status: receipt.status, gasLimit: tx.gas, gasUsed: receipt.gasUsed, block: receipt.blockNumber, blockTimestamp: block.timestamp, inputBytes: size(tx.input), selector: slice(tx.input, 0, 4) };

let receiver: Address | undefined = vault;
let rawReport: Hex | undefined;
try {
  const call = decodeFunctionData({ abi: forwarderAbi, data: tx.input });
  if (call.functionName !== "report") throw new Error(`called ${call.functionName}`);
  receiver = call.args[0];
  rawReport = call.args[1];
  out.forwarderCall = { function: call.functionName, receiver, rawReportBytes: size(rawReport), reportContextBytes: size(call.args[2]), signatures: call.args[3].length };
} catch (error) {
  out.forwarderCall = `input is not report(address,bytes,bytes,bytes[]): ${String((error as Error).message).slice(0, 120)}`;
}

out.logs = receipt.logs.map((log) => {
  try { return { address: log.address, ...show(decodeEventLog({ abi: forwarderAbi, data: log.data, topics: log.topics })) }; }
  catch { return { address: log.address, topics: log.topics, data: log.data }; }
});

// The forwarder's own record of this delivery attempt.
for (const log of receipt.logs) {
  try {
    const event = decodeEventLog({ abi: forwarderAbi, data: log.data, topics: log.topics });
    if (event.eventName !== "ReportProcessed") continue;
    const info = await client.readContract({ address: log.address, abi: forwarderAbi, functionName: "getTransmissionInfo", args: [event.args.receiver, event.args.workflowExecutionId, event.args.reportId] });
    out.transmission = show({ forwarder: log.address, result: event.args.result, state: STATES[info.state] ?? info.state, invalidReceiver: info.invalidReceiver, gasLimitForReceiver: info.gasLimit, transmitter: info.transmitter });
    out.forwarderVersion = await client.readContract({ address: log.address, abi: forwarderAbi, functionName: "typeAndVersion" }).catch(() => "unknown");
  } catch {}
}

if (rawReport) {
  // Keystone metadata is 109 bytes; the receiver gets the rest.
  for (const offset of [109, 0]) {
    if (size(rawReport) <= offset) continue;
    const payload = slice(rawReport, offset);
    try {
      const [version, target, chainId, runId, revision, policyHash, action, decidedAt] = decodeAbiParameters(parseAbiParameters("uint256,address,uint256,bytes32,uint256,bytes32,uint256,uint256"), payload);
      out[`payloadAfter${offset}`] = show({ bytes: size(payload), version, target, chainId, runId, revision, policyHash, action, decidedAt, secondsBeforeBlock: block.timestamp - decidedAt });
    } catch {
      out[`payloadAfter${offset}`] = { bytes: size(payload), decodes: false, head: slice(payload, 0, Math.min(64, size(payload))) };
    }
  }
}

if (receiver) {
  const before = receipt.blockNumber - 1n;
  const read = async (fn: "forwarder" | "reportVersion" | "paused") => client.readContract({ address: receiver!, abi: vaultAbi, functionName: fn, blockNumber: before }).then(show, revert);
  out.receiver = {
    address: receiver,
    trustedForwarder: await read("forwarder"),
    reportVersion: await read("reportVersion"),
    pausedBefore: await read("paused"),
    erc165: await client.readContract({ address: receiver, abi: vaultAbi, functionName: "supportsInterface", args: ["0x01ffc9a7"], blockNumber: before }).catch(revert),
    erc165Invalid: await client.readContract({ address: receiver, abi: vaultAbi, functionName: "supportsInterface", args: ["0xffffffff"], blockNumber: before }).catch(revert),
    receiverInterface: await client.readContract({ address: receiver, abi: vaultAbi, functionName: "supportsInterface", args: ["0x805f2132"], blockNumber: before }).catch(revert),
  };
  if (rawReport && size(rawReport) > 109 && tx.to) {
    const replay = async (label: string, metadata: Hex, report: Hex, gas?: bigint) => {
      try {
        await client.call({ account: tx.to!, to: receiver!, data: encodeFunctionData({ abi: vaultAbi, functionName: "onReport", args: [metadata, report] }), blockNumber: before, ...(gas ? { gas } : {}) });
        return `${label}: succeeds`;
      } catch (error) { return `${label}: ${revert(error)}`; }
    };
    const metadata = slice(rawReport, 45, 109);
    const payload = slice(rawReport, 109);
    out.replays = [
      await replay("forwarder's exact bytes, unlimited gas", metadata, payload),
      await replay("forwarder's exact bytes, 100k gas", metadata, payload, 100_000n),
      await replay("forwarder's exact bytes, 60k gas", metadata, payload, 60_000n),
      await replay("whole rawReport as report", toHex(""), rawReport),
    ];
  }
}
console.log(JSON.stringify(show(out), null, 2));
