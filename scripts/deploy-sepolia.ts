// Deploys GrantVault (report v3) on Sepolia for CRE simulation with --broadcast:
// pause, sweep to a reserve, pay registered payees, and evacuate through CCIP.
//   CRE_ETH_PRIVATE_KEY=0x... bun run scripts/deploy-sepolia.ts
// The key must belong to a funded Sepolia test wallet; it becomes the vault owner
// (the only address that can resume spending or register payees). It is read from
// the environment only. Optional:
//   ORIGINS_RESERVE_ADDRESS   where sweeps and CCIP evacuations go (default: the owner)
//   ORIGINS_GRANTEE_ADDRESS   payee "grantee" (default: the owner)
//   ORIGINS_INSURED_ADDRESS   payee "insured" (default: the owner)
//   ORIGINS_VAULT_FUND_ETH    ETH sent to the vault at deploy (default 0.01)
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { REPORT_VERSION, NETWORKS, CCIP_SEPOLIA, CCIP_DESTINATIONS, payeeId } from "../cre/graph";

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
const account = privateKeyToAccount(key);
const pick = (name: string) => {
  const value = (process.env[name] || account.address) as Address;
  if (!isAddress(value)) throw new Error(`${name} is not an address`);
  return value;
};
const reserve = pick("ORIGINS_RESERVE_ADDRESS");
const payees = { grantee: pick("ORIGINS_GRANTEE_ADDRESS"), insured: pick("ORIGINS_INSURED_ADDRESS") };
const fund = parseEther(process.env.ORIGINS_VAULT_FUND_ETH || "0.01");
// Bounds every report is held to, fixed at deploy.
const limits = {
  reserve, maxSweepBps: 10_000n, maxPaymentWei: parseEther("0.002"), minPaymentInterval: 60n,
  ccipRouter: CCIP_SEPOLIA.router as Address, ccipToken: CCIP_SEPOLIA.bnm as Address, ccipDestination: BigInt(CCIP_DESTINATIONS["base-sepolia"].chainSelector),
};

const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
if ((await client.getChainId()) !== NETWORKS["ethereum-sepolia"].chainId) throw new Error("RPC is not Sepolia; refusing to deploy");
const balance = await client.getBalance({ address: account.address });
if (balance < fund + parseEther("0.006")) throw new Error(`Deployer ${account.address} has ${formatEther(balance)} Sepolia ETH; it needs about ${formatEther(fund + parseEther("0.006"))} (vault funding plus gas). Fund it from a faucet or set ORIGINS_VAULT_FUND_ETH lower.`);
for (const [name, address] of [["forwarder", forwarder], ["CCIP router", limits.ccipRouter], ["CCIP-BnM", limits.ccipToken]] as const) {
  const code = await client.getCode({ address });
  if (!code || code.length <= 2) throw new Error(`No contract code at the ${name} ${address} on Sepolia. Check the current Chainlink directory.`);
}
const routerAbi = parseAbi(["function isChainSupported(uint64) view returns (bool)"]);
if (!(await client.readContract({ address: limits.ccipRouter, abi: routerAbi, functionName: "isChainSupported", args: [limits.ccipDestination] })))
  throw new Error(`The Sepolia CCIP router does not support ${CCIP_DESTINATIONS["base-sepolia"].label}; check the CCIP directory.`);

const build = Bun.spawn(["forge", "build", "--root", "contracts"], { stdout: "inherit", stderr: "inherit" });
if ((await build.exited) !== 0) throw new Error("Contract compilation failed (is Foundry installed?)");
const artifact = await Bun.file("contracts/out/GrantVault.sol/GrantVault.json").json();
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
console.log(`Deploying GrantVault v${REPORT_VERSION} from ${account.address} trusting forwarder ${forwarder}, reserve ${reserve}, funded with ${formatEther(fund)} ETH…`);
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [forwarder, maxReportAge, limits], value: fund });
const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Deployment failed: ${hash}`);
const address = receipt.contractAddress;
const vaultAbi = parseAbi([
  "function reportVersion() view returns (uint256)", "function forwarder() view returns (address)", "function owner() view returns (address)", "function paused() view returns (bool)",
  "function reserve() view returns (address)", "function ccipRouter() view returns (address)", "function setPayee(bytes32,address)", "function payees(bytes32) view returns (address)",
]);
for (const [name, payee] of Object.entries(payees)) {
  const tx = await wallet.writeContract({ address, abi: vaultAbi, functionName: "setPayee", args: [payeeId(name), payee] });
  await client.waitForTransactionReceipt({ hash: tx, timeout: 180_000 });
  console.log(`Registered payee "${name}" → ${payee}`);
}
// Two CCIP-BnM test tokens for the evacuation demo; drip() mints one per call to anyone.
const bnmAbi = parseAbi(["function drip(address)", "function balanceOf(address) view returns (uint256)"]);
for (let i = 0; i < 2; i++) await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: limits.ccipToken, abi: bnmAbi, functionName: "drip", args: [address] }), timeout: 180_000 });
const [version, trusted, owner, paused, configuredReserve, router, tokens] = await Promise.all([
  client.readContract({ address, abi: vaultAbi, functionName: "reportVersion" }),
  client.readContract({ address, abi: vaultAbi, functionName: "forwarder" }),
  client.readContract({ address, abi: vaultAbi, functionName: "owner" }),
  client.readContract({ address, abi: vaultAbi, functionName: "paused" }),
  client.readContract({ address, abi: vaultAbi, functionName: "reserve" }),
  client.readContract({ address, abi: vaultAbi, functionName: "ccipRouter" }),
  client.readContract({ address: limits.ccipToken, abi: bnmAbi, functionName: "balanceOf", args: [address] }),
]);
if (Number(version) !== REPORT_VERSION || trusted.toLowerCase() !== forwarder.toLowerCase() || owner.toLowerCase() !== account.address.toLowerCase() || paused
  || configuredReserve.toLowerCase() !== reserve.toLowerCase() || router.toLowerCase() !== limits.ccipRouter.toLowerCase())
  throw new Error("Deployed vault did not verify (version, forwarder, owner, reserve, router, or initial state)");
const previous = await Bun.file("contracts/deployment.sepolia.json").json().catch(() => null);
const deployment = {
  address, forwarder, owner, chainId: 11155111, rpcUrl, mode: "cre-sepolia", reportVersion: Number(version),
  maxReportAgeSeconds: Number(maxReportAge), reserve, payees, maxSweepBps: Number(limits.maxSweepBps), maxPaymentWei: limits.maxPaymentWei.toString(),
  minPaymentIntervalSeconds: Number(limits.minPaymentInterval), ccip: { router: limits.ccipRouter, token: limits.ccipToken, destination: "base-sepolia", destinationChainSelector: limits.ccipDestination.toString(), tokenBalance: tokens.toString() },
  fundedWei: fund.toString(), deploymentHash: hash, blockNumber: Number(receipt.blockNumber),
  explorer: `${NETWORKS["ethereum-sepolia"].explorer}/address/${address}`, createdAt: new Date().toISOString(),
  // Earlier vaults stay on chain with their receipts; recorded evidence keeps pointing at them.
  previousDeployments: previous ? [...(previous.previousDeployments ?? []), { address: previous.address, reportVersion: previous.reportVersion, deploymentHash: previous.deploymentHash, blockNumber: previous.blockNumber, createdAt: previous.createdAt }] : [],
};
await Bun.write("contracts/deployment.sepolia.json", JSON.stringify(deployment, null, 2));
console.log(JSON.stringify(deployment, null, 2));
console.log(`\nUpdate your .env:\nORIGINS_EXECUTION_MODE=cre\nORIGINS_SEPOLIA_VAULT=${address}`);
