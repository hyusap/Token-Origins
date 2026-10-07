// Real local Anvil sequence: false → verified pause → no duplicate → sell refused to write.
// Run with the dev chain up (bun run dev), outside an active demo. Leaves the vault active.
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { executeCreRun, loadLocalDeployment } from "../cre/runner";
import { fetchFeedPrice, feedObservation } from "../server/chainlink";
import { proveSequence } from "./prove-execution";

if (process.env.ORIGINS_EXECUTION_MODE === "cre") throw new Error("verify-local proves the local Anvil path; use scripts/prove-sepolia.ts for CRE.");
const deployment = await loadLocalDeployment();
const client = createPublicClient({ chain: foundry, transport: http(deployment.rpcUrl) });
if ((await client.getChainId()) !== 31337) throw new Error("Only localhost Anvil allowed");
const wallet = createWalletClient({ chain: foundry, transport: http(deployment.rpcUrl), account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") });
const abi = parseAbi(["function paused() view returns (bool)", "function resume()"]);
const address = deployment.address as Address;

const proof = await proveSequence({
  label: "local-anvil",
  feedNetwork: "ethereum-mainnet",
  execute: (spec) => executeCreRun(spec, undefined, { deployment, resolveFeed: async (source) => feedObservation(await fetchFeedPrice(source.symbol, source.network), source) }),
  isPaused: () => client.readContract({ address, abi, functionName: "paused" }),
  resume: async () => {
    const hash = await wallet.writeContract({ address, abi, functionName: "resume" });
    await client.waitForTransactionReceipt({ hash });
    return hash;
  },
});
await Bun.write("contracts/evidence.local.json", JSON.stringify({ verifiedAt: new Date().toISOString(), chainId: 31337, vault: address, ...proof }, null, 2));
console.log(JSON.stringify({ verified: true, pause: proof.pause, resumeHash: proof.resumeTransactionHash, evidence: "contracts/evidence.local.json" }, null, 2));
