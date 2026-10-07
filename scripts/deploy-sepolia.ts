// Deploys GrantVault (report v2) on Sepolia for CRE simulation with --broadcast.
//   CRE_ETH_PRIVATE_KEY=0x... bun run scripts/deploy-sepolia.ts
// The key must belong to a fresh, funded Sepolia test wallet; it becomes the vault owner
// (the only address that can resume spending). It is read from the environment only.
import { createPublicClient, createWalletClient, http, parseAbi, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { REPORT_VERSION, NETWORKS } from "../cre/graph";
import { mkdir } from "node:fs/promises";

/**
 * CRE's simulation MockForwarder on Sepolia. `cre workflow simulate --broadcast`
 * delivers reports through it, so the vault must trust exactly this address.
 * Confirm against the current Chainlink forwarder directory before deploying.
 */
export const SEPOLIA_SIMULATION_FORWARDER = "0x15fC6ae953E024d975e77382eEeC56A9101f9F88";
const key = process.env.CRE_ETH_PRIVATE_KEY as Hex | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Set CRE_ETH_PRIVATE_KEY to a funded Sepolia test wallet key (0x + 64 hex).");
const forwarder = (process.env.ORIGINS_SEPOLIA_FORWARDER || SEPOLIA_SIMULATION_FORWARDER) as Address;
if (!isAddress(forwarder)) throw new Error("ORIGINS_SEPOLIA_FORWARDER is not an address");
const rpcUrl = process.env.ORIGINS_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
// Long enough for CLI compile + simulation + inclusion; the contract caps it at 3600.
const maxReportAge = BigInt(process.env.ORIGINS_REPORT_AGE_SECONDS || 300);
if(maxReportAge<1n || maxReportAge>3600n) throw new Error("ORIGINS_REPORT_AGE_SECONDS must be 1–3600");

const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
if ((await client.getChainId()) !== NETWORKS["ethereum-sepolia"].chainId) throw new Error("RPC is not Sepolia; refusing to deploy");
const account = privateKeyToAccount(key);
const balance = await client.getBalance({ address: account.address });
if (balance < 5_000_000_000_000_000n) throw new Error(`Deployer ${account.address} has ${Number(balance) / 1e18} Sepolia ETH; fund it with at least 0.005 from a faucet.`);
const forwarderCode = await client.getCode({ address: forwarder });
if (!forwarderCode || forwarderCode.length <= 2) throw new Error(`No contract code at forwarder ${forwarder} on Sepolia. Check the current CRE forwarder directory and set ORIGINS_SEPOLIA_FORWARDER.`);

const build = Bun.spawn(["forge", "build", "--root", "contracts"], { stdout: "inherit", stderr: "inherit" });
if ((await build.exited) !== 0) throw new Error("Contract compilation failed (is Foundry installed?)");
const artifact = await Bun.file("contracts/out/GrantVault.sol/GrantVault.json").json();
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
console.log(`Deploying GrantVault from ${account.address} trusting forwarder ${forwarder}…`);
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [forwarder, maxReportAge] });
const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment failed: ${hash}`);
const address = receipt.contractAddress;
const abi = parseAbi(["function reportVersion() view returns (uint256)", "function forwarder() view returns (address)", "function owner() view returns (address)", "function paused() view returns (bool)"]);
const [version, trusted, owner, paused] = await Promise.all([
  client.readContract({ address, abi, functionName: "reportVersion" }),
  client.readContract({ address, abi, functionName: "forwarder" }),
  client.readContract({ address, abi, functionName: "owner" }),
  client.readContract({ address, abi, functionName: "paused" }),
]);
if (Number(version) !== REPORT_VERSION || trusted.toLowerCase() !== forwarder.toLowerCase() || owner.toLowerCase() !== account.address.toLowerCase() || paused)
  throw new Error("Deployed vault did not verify (version, forwarder, owner, or initial state)");
const deployment = {
  address, forwarder, owner, chainId: 11155111, rpcUrl, mode: "cre-sepolia", reportVersion: Number(version),
  maxReportAgeSeconds: Number(maxReportAge), deploymentHash: hash, blockNumber: Number(receipt.blockNumber),
  explorer: `${NETWORKS["ethereum-sepolia"].explorer}/address/${address}`, createdAt: new Date().toISOString(),
};
// Keep previous public receiver identities so archived receipts stay inspectable.
const manifestPath = "contracts/deployment.sepolia.json";
if (await Bun.file(manifestPath).exists()) {
  const previous = await Bun.file(manifestPath).json();
  if (!isAddress(previous.address)) throw new Error("Previous deployment manifest has no valid address; preserve it manually before replacing");
  await mkdir("contracts/deployments", { recursive: true });
  await Bun.write(`contracts/deployments/sepolia-${previous.address.toLowerCase()}.json`, JSON.stringify(previous, null, 2));
}
await Bun.write(manifestPath, JSON.stringify(deployment, null, 2));
console.log(JSON.stringify(deployment, null, 2));
console.log(`\nAdd to your .env:\nORIGINS_EXECUTION_MODE=cre\nORIGINS_SEPOLIA_VAULT=${address}`);
