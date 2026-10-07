import { z } from "zod";
import { CCIP_DESTINATION_IDS, PAYEE_PATTERN, LENDING_PROTOCOLS, fractionSchema, ethAmountSchema, thresholdSchema, timestampSchema, type PolicyGraphInput } from "../cre/graph";

/**
 * Policies modelled on what past Chainlink hackathon winners built, each
 * reduced to its core loop and expressed in the same allowlisted vocabulary
 * as any composed graph. A recipe only fills in a graph: validation, the
 * policy hash, mandatory guards, CRE execution and on-chain evidence are
 * exactly those of compose_graph. "Inspired by" credits the idea; these are
 * not the winners' code.
 */
export interface Recipe {
  id: string;
  title: string;
  inspiredBy: { project: string; event: string; award: string; built: string }[];
  /** What a user would say to ask for it. */
  sentence: string;
  /** Whether the action moves or freezes real funds, or is a local simulation. */
  execution: "real" | "simulated";
  params: z.AnyZodObject;
  build(params: any): PolicyGraphInput;
  /** Cadence to suggest for watch_policy, if the recipe is meant to run continuously. */
  watchSeconds?: number;
  note?: string;
}

// The graph's own parameter rules, so a recipe accepts exactly what compose_graph would.
const fraction = fractionSchema;
const usd = thresholdSchema.pipe(z.number().positive().max(1e7));
const eth = ethAmountSchema.pipe(z.number().max(1));
const payee = z.string().regex(PAYEE_PATTERN, 'a registered payee name such as "grantee"');
const ethFeed = (id: string) => ({ id, kind: "price" as const, source: { type: "chainlink-feed" as const, symbol: "ETH" as const } });
const nextWeek = () => new Date(Math.ceil((Date.now() + 7 * 86_400_000) / 3_600_000) * 3_600_000).toISOString().replace(".000Z", "Z");

export const RECIPES: Recipe[] = [
  {
    id: "reserve-guardian",
    title: "Reserve guardian",
    inspiredBy: [{ project: "SentinelCRE", event: "Convergence 2026", award: "CRE & AI, 1st place", built: "checks every autonomous agent action against compliance limits and Proof of Reserve before it executes" }],
    sentence: "If WBTC's reserves fall below its supply or USDC depegs, sweep half the treasury to the reserve and pause spending.",
    execution: "real",
    params: z.object({ minCoverage: thresholdSchema.pipe(z.number().positive().max(10)).default(1), includeDepeg: z.boolean().default(true), depegFloor: thresholdSchema.pipe(z.number().positive().max(2)).default(0.98), sweepFraction: fraction.default(0.5), pause: z.boolean().default(true) }).strict(),
    build: (p) => {
      const coverage = [
        { id: "reserves", kind: "reading", source: { type: "proof-of-reserve", asset: "WBTC" } },
        { id: "supply", kind: "reading", source: { type: "token-supply", token: "WBTC" } },
        { id: "coverage", kind: "math", op: "/", left: "reserves", right: "supply" },
        { id: "undercollateralised", kind: "compare", input: "coverage", op: "<", value: p.minCoverage },
      ] as const;
      const action = { type: "sweep", fraction: p.sweepFraction, pause: p.pause } as const;
      // Without the depeg check it is the Proof of Reserve guard alone.
      if (!p.includeDepeg) return { nodes: [...coverage], root: "undercollateralised", action };
      return {
        nodes: [
          ...coverage,
          { id: "usdc", kind: "price", source: { type: "chainlink-feed", symbol: "USDC" } },
          { id: "depegged", kind: "compare", input: "usdc", op: "<", value: p.depegFloor },
          { id: "risk", kind: "or", inputs: ["undercollateralised", "depegged"] },
        ],
        root: "risk",
        action,
      };
    },
    watchSeconds: 60,
  },
  {
    id: "depeg-shield",
    title: "Stablecoin spread shield",
    inspiredBy: [{ project: "FlowVault", event: "Convergence 2026", award: "DeFi & Tokenization, 1st place", built: "scores stablecoin spreads and other market signals in CRE workflows and acts behind risk gates" }],
    sentence: "If USDC and USDT drift more than a cent apart, pause spending.",
    execution: "real",
    params: z.object({ maxSpread: thresholdSchema.pipe(z.number().positive().max(1)).default(0.01), action: z.enum(["pause", "sweep"]).default("pause"), sweepFraction: fraction.default(0.5) }).strict(),
    build: (p) => ({
      nodes: [
        { id: "usdc", kind: "price", source: { type: "chainlink-feed", symbol: "USDC" } },
        { id: "usdt", kind: "price", source: { type: "chainlink-feed", symbol: "USDT" } },
        { id: "spread", kind: "math", op: "-", left: "usdc", right: "usdt" },
        { id: "usdcRich", kind: "compare", input: "spread", op: ">", value: p.maxSpread },
        { id: "usdcCheap", kind: "compare", input: "spread", op: "<", value: -p.maxSpread },
        { id: "wide", kind: "or", inputs: ["usdcRich", "usdcCheap"] },
      ],
      root: "wide",
      action: p.action === "sweep" ? { type: "sweep", fraction: p.sweepFraction, pause: true } : { type: "pause-vault" },
    }),
    watchSeconds: 60,
  },
  {
    id: "yield-chaser",
    title: "Yield chaser",
    inspiredBy: [
      { project: "YieldCoin", event: "Chromion 2025", award: "Grand Prize", built: "moves stablecoins to whichever protocol and chain pays the most, using Functions, Automation and CCIP" },
      { project: "Copil", event: "Chromion 2025", award: "Onchain Finance, 2nd place", built: "designs and executes yield strategies across protocols" },
    ],
    sentence: "If Compound pays at least half a point more than Aave on USDC, move it to Compound.",
    execution: "simulated",
    params: z.object({ from: z.enum(LENDING_PROTOCOLS).default("aave-v3"), to: z.enum(LENDING_PROTOCOLS).default("compound-v3"), minEdgePercent: thresholdSchema.pipe(z.number().positive().max(100)).default(0.5), fraction: fraction.default(1) }).strict(),
    build: (p) => ({
      nodes: [
        { id: "current", kind: "reading", source: { type: "lending-rate", protocol: p.from, asset: "USDC" } },
        { id: "candidate", kind: "reading", source: { type: "lending-rate", protocol: p.to, asset: "USDC" } },
        { id: "edge", kind: "math", op: "-", left: "candidate", right: "current" },
        { id: "worthMoving", kind: "compare", input: "edge", op: ">", value: p.minEdgePercent },
      ],
      root: "worthMoving",
      action: { type: "rebalance", from: p.from, to: p.to, asset: "USDC", fraction: p.fraction },
    }),
    watchSeconds: 300,
    note: "The rates are real contract reads; the rebalance is a simulated order in local rehearsal (the vault holds test ETH, not USDC).",
  },
  {
    id: "runway-guard",
    title: "Treasury runway guard",
    inspiredBy: [{ project: "TokenIQ", event: "Chromion 2025", award: "Onchain Finance, 1st place", built: "acts as an autonomous CFO for DAO treasuries across tokens and chains" }],
    sentence: "If the treasury is worth less than a thousand dollars, pause grant spending.",
    execution: "real",
    params: z.object({ minUsd: usd.default(1000) }).strict(),
    build: (p) => ({
      nodes: [
        { id: "balance", kind: "reading", source: { type: "vault-balance" } },
        ethFeed("eth"),
        { id: "value", kind: "math", op: "*", left: "balance", right: "eth" },
        { id: "low", kind: "compare", input: "value", op: "<", value: p.minUsd },
      ],
      root: "low",
      action: { type: "pause-vault" },
    }),
    watchSeconds: 300,
    note: "The vault holds Sepolia test ETH, valued here at the mainnet Chainlink ETH/USD price.",
  },
  {
    id: "grant-stream",
    title: "Streaming grant",
    inspiredBy: [{ project: "InControl", event: "Convergence 2026", award: "Autonomous Agents, 1st place", built: "runs recurring executions such as dollar-cost averaging through CRE workflows" }],
    sentence: "Pay the grantee 0.001 ETH every minute while ETH stays above $1,000 and spending is active.",
    execution: "real",
    params: z.object({ amountEth: eth.default(0.001), ethFloor: usd.default(1000), payee: payee.default("grantee") }).strict(),
    build: (p) => ({
      nodes: [
        ethFeed("eth"),
        { id: "healthy", kind: "compare", input: "eth", op: ">", value: p.ethFloor },
        { id: "active", kind: "vault-paused", equals: false },
        { id: "ok", kind: "and", inputs: ["healthy", "active"] },
      ],
      root: "ok",
      action: { type: "pay", payee: p.payee, amountEth: p.amountEth },
    }),
    watchSeconds: 60,
    note: "Each check pays at most once; the vault also caps each payment (0.002 ETH on the demo vault) and enforces a minimum interval on chain. Watch it with stopOnAction false so it keeps paying.",
  },
  {
    id: "parametric-cover",
    title: "Parametric cover",
    inspiredBy: [
      { project: "Azurance", event: "Constellation 2023", award: "DeFi & Payments prize", built: "an on-chain insurance marketplace that pays out on verifiable conditions" },
      { project: "TAPL", event: "Convergence 2026", award: "Prediction Markets, 1st place", built: "settles time-bounded price predictions with oracle-verified outcomes" },
    ],
    sentence: "If ETH falls below $2,000 within the next week, pay the insured 0.002 ETH.",
    execution: "real",
    params: z.object({ strike: usd.default(2000), deadline: timestampSchema.optional(), amountEth: eth.default(0.002), payee: payee.default("insured") }).strict(),
    build: (p) => ({
      nodes: [
        ethFeed("eth"),
        { id: "struck", kind: "compare", input: "eth", op: "<", value: p.strike },
        { id: "inWindow", kind: "time", op: "before", at: p.deadline ?? nextWeek() },
        { id: "payout", kind: "and", inputs: ["struck", "inWindow"] },
      ],
      root: "payout",
      action: { type: "pay", payee: p.payee, amountEth: p.amountEth },
    }),
    watchSeconds: 300,
  },
  {
    id: "crash-evacuation",
    title: "Cross-chain evacuation",
    inspiredBy: [
      { project: "YieldCoin", event: "Chromion 2025", award: "Grand Prize", built: "moves treasury funds across chains with CCIP" },
      { project: "Chronomancer", event: "Block Magic 2024", award: "Cross-Chain Solutions, 1st place", built: "fast token transfers powered by CCIP" },
    ],
    sentence: "If ETH crashes below $2,000, bridge the treasury's tokens to the reserve on Base and pause spending.",
    execution: "real",
    params: z.object({ floor: usd.default(2000), fraction: fraction.default(1), pause: z.boolean().default(true), destination: z.enum(CCIP_DESTINATION_IDS).default("base-sepolia") }).strict(),
    build: (p) => ({
      nodes: [ethFeed("eth"), { id: "crashed", kind: "compare", input: "eth", op: "<", value: p.floor }],
      root: "crashed",
      action: { type: "evacuate", destination: p.destination, fraction: p.fraction, pause: p.pause },
    }),
    watchSeconds: 60,
    note: "Sends the vault's CCIP-BnM test token through Chainlink CCIP; delivery on Base Sepolia takes about 20 minutes.",
  },
];
export const RECIPE_IDS = RECIPES.map((recipe) => recipe.id) as [string, ...string[]];
export const recipeById = (id: string) => RECIPES.find((recipe) => recipe.id === id);

/** One line per recipe for the agent: what it does, who it credits, and how to call it. */
export function recipeCatalog(): string {
  return RECIPES.map((recipe) => {
    const credit = recipe.inspiredBy.map((x) => `${x.project} (${x.event}, ${x.award})`).join(" and ");
    const params = Object.entries(recipe.params.shape).map(([name, schema]) => {
      const fallback = (schema as z.ZodTypeAny)._def?.defaultValue?.();
      return fallback === undefined ? name : `${name}=${JSON.stringify(fallback)}`;
    }).join(", ");
    return `${recipe.id} — ${recipe.title}, inspired by ${credit}. "${recipe.sentence}" ${recipe.execution === "real" ? "Real on-chain action." : "Simulated action, real inputs."} Params: ${params}.${recipe.watchSeconds ? ` Suggested watch: every ${recipe.watchSeconds}s.` : ""}`;
  }).join("\n");
}
