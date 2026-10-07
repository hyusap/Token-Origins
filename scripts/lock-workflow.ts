// Locks the Sepolia vault to your CRE workflow: reports through the (signature-free) simulation
// forwarder are then accepted only when they carry your workflow's owner and name.
//   bun run lock:workflow [txHash]   (default: the latest CRE report tx recorded in demo/actions-evidence-*.json)
// Needs CRE_ETH_PRIVATE_KEY (the vault owner) and ORIGINS_SEPOLIA_VAULT.
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { readdir } from "node:fs/promises";
import { decodeDeliveredReport } from "../cre/runner";

const vault = process.env.ORIGINS_SEPOLIA_VAULT as Address | undefined;
const key = process.env.CRE_ETH_PRIVATE_KEY as Hex | undefined;
if (!vault || !key) throw new Error("Set ORIGINS_SEPOLIA_VAULT and CRE_ETH_PRIVATE_KEY");
const rpcUrl = process.env.ORIGINS_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: sepolia, transport: http(rpcUrl) });
const abi = parseAbi(["function setWorkflowIdentity(address,bytes10)", "function workflowOwner() view returns (address)", "function workflowName() view returns (bytes10)", "function forwarder() view returns (address)"]);

let hash = process.argv[2] as Hex | undefined;
if (!hash) {
  const files = (await readdir("demo")).filter((f) => f.startsWith("actions-evidence-")).sort().reverse();
  for (const file of files) {
    const proof = await Bun.file(`demo/${file}`).json();
    if (proof.vault?.toLowerCase() !== vault.toLowerCase()) continue;
    hash = Object.values<any>(proof.cases).find((c) => c.evidence?.transaction?.hash)?.evidence.transaction.hash;
    if (hash) break;
  }
}
if (!hash) throw new Error("No CRE report transaction for this vault yet; run bun run prove:actions first or pass a tx hash");
const tx = await client.getTransaction({ hash });
const forwarder = await client.readContract({ address: vault, abi, functionName: "forwarder" });
if (tx.to?.toLowerCase() !== forwarder.toLowerCase()) throw new Error(`Transaction ${hash} was not sent to the vault's forwarder ${forwarder}`);
const { receiver, metadata } = decodeDeliveredReport(tx.input);
if (receiver.toLowerCase() !== vault.toLowerCase() || !metadata) throw new Error("That transaction did not deliver a Keystone report to this vault");
if (/^0x0+$/.test(metadata.workflowOwner)) throw new Error("These reports carry no workflow owner, so there is nothing to lock to");
console.log(`Locking ${vault} to workflow owner ${metadata.workflowOwner}, name ${metadata.workflowName}…`);
await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: vault, abi, functionName: "setWorkflowIdentity", args: [metadata.workflowOwner, metadata.workflowName] }) });
const [owner, name] = await Promise.all([client.readContract({ address: vault, abi, functionName: "workflowOwner" }), client.readContract({ address: vault, abi, functionName: "workflowName" })]);
if (owner.toLowerCase() !== metadata.workflowOwner.toLowerCase() || name !== metadata.workflowName) throw new Error("Lock did not verify");
console.log("Locked. Reports from any other workflow are now refused (UnauthorizedWorkflow).");
