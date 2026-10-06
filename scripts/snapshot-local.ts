import { resolve, dirname } from "node:path";
import { rename } from "node:fs/promises";
const root = resolve(import.meta.dir, "..");
const rpcUrl = "http://127.0.0.1:8545";
const dataRoot = resolve(root, ".data");
export const localStatePath = resolve(dataRoot, "anvil-state.json");
export async function localRpc<T = unknown>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const reply = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!reply.ok) throw new Error(`Local Anvil RPC failed (${reply.status})`);
  const body = (await reply.json()) as {
    result: T;
    error?: { message: string };
  };
  if (body.error)
    throw new Error(`Local Anvil ${method}: ${body.error.message}`);
  return body.result;
}
export async function validateLocalStateFile(
  path = localStatePath,
): Promise<void> {
  const state = await Bun.file(path).json();
  const metadata = await Bun.file(`${path}.metadata.json`).json();
  const deployment = await Bun.file(
    resolve(root, "contracts/deployment.local.json"),
  ).json();
  if (
    metadata.chainId !== 31337 ||
    metadata.sourceRpc !== rpcUrl ||
    deployment.chainId !== 31337 ||
    deployment.rpcUrl !== rpcUrl
  )
    throw new Error(
      "Snapshot and deployment must belong to this localhost chain 31337",
    );
  if (
    metadata.vaultAddress.toLowerCase() !== deployment.address.toLowerCase() ||
    metadata.forwarderAddress.toLowerCase() !==
      deployment.forwarder.toLowerCase()
  )
    throw new Error("Snapshot belongs to a different local deployment");
  for (const address of [deployment.address, deployment.forwarder]) {
    const account = state.accounts?.[address.toLowerCase()];
    if (!account || typeof account.code !== "string" || account.code === "0x")
      throw new Error("Snapshot is missing deployed vault/forwarder code");
  }
  if (
    !Array.isArray(state.blocks) ||
    !Array.isArray(state.transactions) ||
    !Number.isSafeInteger(state.best_block_number) ||
    state.best_block_number < deployment.blockNumber
  )
    throw new Error("Snapshot is missing block or transaction history");
}
export async function snapshotLocalChain(
  options: { outputPath?: string; preserveHistoricalStates?: boolean } = {},
): Promise<{
  path: string;
  chainId: number;
  blockNumber: number;
  blockHash: string;
  transactions: number;
  historicalStates: number;
  sha256: string;
}> {
  const path = resolve(root, options.outputPath ?? localStatePath);
  if (
    dirname(path) !== dataRoot ||
    !/^anvil(?:-[a-z]+)*-state\.json$/.test(path.split("/").at(-1)!)
  )
    throw new Error(
      "Snapshot output must be this project .data/anvil*-state.json",
    );
  const deployment = await Bun.file(
    resolve(root, "contracts/deployment.local.json"),
  ).json();
  if (deployment.chainId !== 31337 || deployment.rpcUrl !== rpcUrl)
    throw new Error("Refusing snapshot of any nonlocal deployment");
  if ((await localRpc("eth_chainId")) !== "0x7a69")
    throw new Error(
      "Refusing snapshot of any chain other than localhost 31337",
    );
  const preserveHistoricalStates = options.preserveHistoricalStates !== false;
  const encoded = await localRpc<string>("anvil_dumpState", [
    preserveHistoricalStates,
  ]);
  if (
    typeof encoded !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(encoded) ||
    encoded.length % 2 !== 0
  )
    throw new Error("Invalid Anvil compressed state encoding");
  const bytes = Buffer.from(encoded.slice(2), "hex");
  const decoded =
    bytes[0] === 0x1f && bytes[1] === 0x8b ? Bun.gunzipSync(bytes) : bytes;
  const state = JSON.parse(new TextDecoder().decode(decoded));
  if (
    !Number.isSafeInteger(state.best_block_number) ||
    !Array.isArray(state.blocks) ||
    !Array.isArray(state.transactions)
  )
    throw new Error(
      "Anvil did not supply complete state/block/transaction data",
    );
  for (const address of [deployment.address, deployment.forwarder]) {
    const account = state.accounts?.[address.toLowerCase()];
    if (!account || account.code === "0x")
      throw new Error("Snapshot lacks the expected local contracts");
    const liveCode = await localRpc<string>("eth_getCode", [
      address,
      `0x${state.best_block_number.toString(16)}`,
    ]);
    if (account.code.toLowerCase() !== liveCode.toLowerCase())
      throw new Error(
        "Snapshot contract code differs from deployment on source chain",
      );
  }
  const block = await localRpc<{ hash: string }>("eth_getBlockByNumber", [
    `0x${state.best_block_number.toString(16)}`,
    false,
  ]);
  if (!block?.hash)
    throw new Error("Snapshot head block is not available on source chain");
  const text = JSON.stringify(state);
  const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const summary = {
    path,
    chainId: 31337,
    blockNumber: state.best_block_number,
    blockHash: block.hash,
    transactions: state.transactions.length,
    historicalStates: state.historical_states?.length ?? 0,
    sha256,
  };
  const metadata = {
    ...summary,
    sourceRpc: rpcUrl,
    vaultAddress: deployment.address,
    forwarderAddress: deployment.forwarder,
    preserveHistoricalStates,
    exportedAt: new Date().toISOString(),
    note: "Export digest describes this checkpoint. Anvil periodic persistence legitimately updates the state file afterward.",
  };
  await Bun.write(`${path}.tmp`, text);
  await Bun.write(
    `${path}.metadata.json.tmp`,
    JSON.stringify(metadata, null, 2),
  );
  await rename(`${path}.tmp`, path);
  await rename(`${path}.metadata.json.tmp`, `${path}.metadata.json`);
  await validateLocalStateFile(path);
  return summary;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--no-history"))
    throw new Error("Usage: bun run scripts/snapshot-local.ts [--no-history]");
  console.log(
    JSON.stringify(
      await snapshotLocalChain({
        preserveHistoricalStates: !args.includes("--no-history"),
      }),
      null,
      2,
    ),
  );
}
