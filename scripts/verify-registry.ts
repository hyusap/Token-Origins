// Re-checks every address the policy vocabulary names, against the chains themselves:
// Chainlink price and Proof of Reserve feeds (description, decimals, a live round),
// the WBTC token, the Aave v3 pool and Compound v3 market, and Chainlink CCIP on Sepolia.
//   bun run verify:registry
// Read-only; needs RPC access (ORIGINS_MAINNET_RPC / ORIGINS_SEPOLIA_RPC override the public defaults).
import { createPublicClient, http, type Address } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { FEED_REGISTRY, FEED_DECIMALS, POR_REGISTRY, TOKEN_REGISTRY, LENDING_REGISTRY, CCIP_SEPOLIA, CCIP_DESTINATIONS, type Network } from "../cre/graph";
import { aggregatorAbi, erc20Abi, cometAbi, readChainSource } from "../cre/onchain-reads";
import { MAINNET_RPC, SEPOLIA_RPC } from "../server/chainlink";
import { parseAbi } from "viem";

const clients = { "ethereum-mainnet": createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC, { timeout: 15000 }) }), "ethereum-sepolia": createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC, { timeout: 15000 }) }) } as const;
const results: { item: string; ok: boolean; detail: string }[] = [];
async function check(item: string, work: () => Promise<string>) {
  try { results.push({ item, ok: true, detail: await work() }); }
  catch (error) { results.push({ item, ok: false, detail: error instanceof Error ? error.message.split("\n")[0]! : String(error) }); }
}
const feed = async (network: Network, address: Address, decimals: number, expect: RegExp) => {
  const client = clients[network];
  const [description, actual, round] = await Promise.all([
    client.readContract({ address, abi: aggregatorAbi, functionName: "description" }),
    client.readContract({ address, abi: aggregatorAbi, functionName: "decimals" }),
    client.readContract({ address, abi: aggregatorAbi, functionName: "latestRoundData" }),
  ]);
  if (Number(actual) !== decimals) throw new Error(`${description}: ${actual} decimals, registry says ${decimals}`);
  if (!expect.test(description)) throw new Error(`description "${description}" does not match ${expect}`);
  const ageHours = (Date.now() / 1000 - Number(round[3])) / 3600;
  return `${description}, ${Number(round[1]) / 10 ** decimals}, updated ${ageHours.toFixed(1)}h ago`;
};

for (const [network, feeds] of Object.entries(FEED_REGISTRY) as [Network, Record<string, Address>][])
  for (const [symbol, address] of Object.entries(feeds))
    await check(`feed ${symbol}/USD ${network}`, () => feed(network, address, FEED_DECIMALS, new RegExp(`^${symbol === "MATIC" ? "(MATIC|POL)" : symbol} / USD$`, "i")));
for (const [asset, entry] of Object.entries(POR_REGISTRY))
  await check(`Proof of Reserve ${asset}`, () => feed(entry.network, entry.address, entry.decimals, /reserve|por/i));
for (const [token, entry] of Object.entries(TOKEN_REGISTRY))
  await check(`token ${token}`, async () => {
    const client = clients[entry.network];
    const [symbol, decimals, supply] = await Promise.all([
      client.readContract({ address: entry.address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: entry.address, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: entry.address, abi: erc20Abi, functionName: "totalSupply" }),
    ]);
    if (symbol !== token || Number(decimals) !== entry.decimals) throw new Error(`${symbol}, ${decimals} decimals`);
    return `${symbol}, supply ${Number(supply) / 10 ** entry.decimals}`;
  });
for (const [protocol, entry] of Object.entries(LENDING_REGISTRY))
  for (const asset of Object.keys(entry.assets))
    await check(`${entry.label} ${asset} supply rate`, async () => {
      const client = clients[entry.network];
      if (protocol === "compound-v3") {
        const base = await client.readContract({ address: entry.address, abi: cometAbi, functionName: "baseToken" });
        if (base.toLowerCase() !== (entry.assets as Record<string, string>)[asset]!.toLowerCase()) throw new Error(`Comet base token is ${base}`);
      }
      const reading = await readChainSource({ type: "lending-rate", protocol: protocol as any, asset: asset as any }, async (call) => (await clients[call.network].call({ to: call.to, data: call.data })).data ?? "0x");
      if (!(reading.value > 0 && reading.value < 100)) throw new Error(`implausible APR ${reading.value}%`);
      return `${reading.value.toFixed(3)}% APR`;
    });
await check("CCIP router (Sepolia) supports Base Sepolia", async () => {
  const supported = await clients["ethereum-sepolia"].readContract({ address: CCIP_SEPOLIA.router, abi: parseAbi(["function isChainSupported(uint64) view returns (bool)"]), functionName: "isChainSupported", args: [BigInt(CCIP_DESTINATIONS["base-sepolia"].chainSelector)] });
  if (!supported) throw new Error("router does not list Base Sepolia");
  return "yes";
});
await check("CCIP-BnM (Sepolia)", async () => {
  const symbol = await clients["ethereum-sepolia"].readContract({ address: CCIP_SEPOLIA.bnm, abi: erc20Abi, functionName: "symbol" });
  if (symbol !== "CCIP-BnM") throw new Error(`symbol ${symbol}`);
  return symbol;
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.item.padEnd(44)} ${r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} registry entries verified on chain.`);
if (failed.length) process.exitCode = 1;
