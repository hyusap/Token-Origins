// Records the four CRE cases with real Sepolia broadcasts, then verifies them independently.
//   bun run scripts/prove-sepolia.ts [--feed-network ethereum-sepolia]
// Needs: `cre login` (or CRE_API_KEY), CRE_ETH_PRIVATE_KEY (funded Sepolia test wallet that
// deployed the vault), ORIGINS_SEPOLIA_VAULT. Writes demo/sepolia-evidence-<timestamp>.json.
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { executeCreRun } from "../cre/runner";
import { NETWORK_IDS, type Network } from "../cre/graph";
import { proveSequence } from "./prove-execution";
import { verifyEvidenceFile } from "./verify-evidence";

const flag = process.argv.indexOf("--feed-network");
const feedNetwork = (flag > 0 ? process.argv[flag + 1] : "ethereum-mainnet") as Network;
if (!NETWORK_IDS.includes(feedNetwork)) throw new Error(`--feed-network must be one of ${NETWORK_IDS.join(", ")}`);
process.env.ORIGINS_EXECUTION_MODE = "cre";
const vault = process.env.ORIGINS_SEPOLIA_VAULT as Address | undefined;
const key = process.env.CRE_ETH_PRIVATE_KEY as Hex | undefined;
if (!vault) throw new Error("Set ORIGINS_SEPOLIA_VAULT (printed by scripts/deploy-sepolia.ts)");
if (!key) throw new Error("Set CRE_ETH_PRIVATE_KEY (the funded Sepolia wallet that owns the vault)");
const rpcUrl = process.env.ORIGINS_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: sepolia, transport: http(rpcUrl) });
const abi = parseAbi(["function paused() view returns (bool)", "function resume()", "function owner() view returns (address)"]);
if ((await client.readContract({ address: vault, abi, functionName: "owner" })).toLowerCase() !== wallet.account.address.toLowerCase())
  throw new Error("CRE_ETH_PRIVATE_KEY is not the vault owner, so the proof could not resume the vault afterwards");

const proof = await proveSequence({
  label: "cre-simulation-sepolia-broadcast",
  feedNetwork,
  execute: (spec) => executeCreRun(spec, (message) => console.log(`  ${message}`)),
  isPaused: () => client.readContract({ address: vault, abi, functionName: "paused" }),
  resume: async () => {
    const hash = await wallet.writeContract({ address: vault, abi, functionName: "resume" });
    await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    return hash;
  },
});
const file = `demo/sepolia-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(file, JSON.stringify({
  claim: "CRE local simulation with real Sepolia broadcast through the CRE MockForwarder. Not deployed-DON execution.",
  chainId: 11155111, vault, rpcUrl, ...proof,
}, null, 2));
console.log(`\nEvidence written to ${file}. Verifying independently from chain data…`);
console.log(JSON.stringify(await verifyEvidenceFile(file), null, 2));
