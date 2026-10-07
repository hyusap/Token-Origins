import type { GraphObject } from "./types";
import { MAX_SOURCES, MAX_EXCHANGE_AGE_SECONDS, MAX_FEED_AGE_SECONDS } from "../cre/graph";
export function observationOnlyForVault(object: GraphObject): boolean {
  return object.kind === "price" && !/^[A-Z0-9]+-USD$/.test(object.data.productId || object.id.slice(6).toUpperCase());
}
export const VAULT_TRIGGER_RESTRICTION = "Price triggers require an exact Coinbase USD market or a configured Chainlink feed. Every pause requires Chainlink CRE execution and a version 2 policy-report receiver; no direct-signer fallback.";

/** Product vocabulary; actual CRE readiness is reported independently at runtime. */
export const supportedPolicyCapabilities = {
  executionAuthority: "Chainlink CRE only; no direct wallet signer fallback",
  sources: [
    { type: "exchange-trade", provider: "Coinbase via CRE HTTP capability", market: "exact online SYMBOL-USD" },
    { type: "chainlink-feed", provider: "Chainlink Data Feeds via CRE EVM capability", market: "configured USD feed on explicitly selected Ethereum mainnet or Sepolia", freshness: "Mandatory 26-hour feed age cap; explicit freshness nodes may tighten it" },
    { type: "proof-of-reserve", provider: "Chainlink Proof of Reserve via CRE EVM capability", market: "registered reserve feeds (WBTC)" },
    { type: "token-supply", provider: "ERC-20 totalSupply via CRE EVM capability", market: "registered tokens (WBTC)" },
    { type: "lending-rate", provider: "Aave v3 and Compound v3 contracts via CRE EVM capability", market: "USDC supply APR" },
    { type: "vault-balance", provider: "The grant vault's own ETH balance via CRE EVM capability" },
  ],
  nodes: ["price", "reading", "math", "compare", "freshness", "vault-paused", "time", "and", "or", "not"],
  comparators: ["<", "<=", ">", ">="],
  actions: [
    { type: "pause-vault", effect: "CRE evaluates the frozen policy and delivers its bound report through CRE EVM write to the grant vault receiver (report v2 or v3); verified receipt/event and vault state required" },
    { type: "sweep", effect: "A share of the vault's ETH to the reserve fixed at deploy, optionally pausing in the same report (report v3)" },
    { type: "pay", effect: "A payee the vault owner registered, capped per payment and rate-limited on chain, never while paused (report v3)" },
    { type: "evacuate", effect: "The vault's CCIP-BnM to the reserve on Base Sepolia through Chainlink CCIP, fee capped, optionally pausing (report v3)" },
  ],
  solana: "When configured, the same CRE decision pauses (or sweeps) the Solana devnet vault through CRE's Solana write; the program accepts reports only from its bound CRE forwarder",
  utilities: [
    { name: "read_price_feed", network: "Ethereum mainnet or Sepolia", effect: "Chainlink oracle observation with exact feed/network identity and age; a read does not execute a policy" },
    { name: "list_price_feeds", network: "Ethereum mainnet and Sepolia", effect: "Configured Chainlink source discovery; availability is explicit" },
  ],
  limits: { nodes: 40, booleanInputs: 8, sourcesPerDiscovery: 12, thresholdMaxUsd: 10000000, executionSources: MAX_SOURCES, exchangeMaxAgeSeconds: MAX_EXCHANGE_AGE_SECONDS, feedMaxAgeSeconds: MAX_FEED_AGE_SECONDS, freshnessNodeMaxAgeSeconds: 86400 },
  triggers: "run_workflow evaluates once through CRE; watch_policy runs a standing policy through the CRE workflow's own cron trigger (every 30 seconds or slower); evaluationOnly:true freezes no-broadcast authority and never submits a report even when the root passes. activate_policy explicitly schedules repeated CRE evaluations of a frozen pause policy while the backend runs, stopping after one verified pause. This backend scheduler is not a deployed DON trigger; restarts pause or mark jobs uncertain.",
  monitoring: { activate: "activate_policy", deactivate: "deactivate_policy", inspect: "get_monitors", reconcile: "reconcile_policy", maxActiveMonitors: 8, maxConsecutiveObservationFailures: 5, defaultIntervalSeconds: 30, minIntervalSeconds: 15, maxIntervalSeconds: 3600, survivesRestart: "Persisted evidence; no automatic resumption" },
  safeguards: ["Mandatory provider-specific freshness gates for every source", "Already-paused no-op guard", "Immutable revision and bound policy report", "Operation-id deduplication", "CRE executor required before execution; direct signing forbidden"],
  receiver: "Version 2 binds run, revision, policy hash, target vault and chain; local CRE simulation, broadcast and actual DON execution must be described separately",
  unsupported: ["copy-trading without an implemented CRE receiver", "standalone EVM swaps or leader-following signers", "direct Solana transfers", "solana-transfer policies without a CRE receiver integration", "mainnet signing", "automatic asset or action substitution", "arbitrary code", "unconfigured chain/feed", "monitoring while backend is offline"],
} as const;
