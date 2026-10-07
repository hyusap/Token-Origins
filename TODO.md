# Woga readiness

Updated October 7, 2026. CRE is the sole product execution authority following the user's explicit scope requirement.

## Verified

- [x] Graph/report v2 with structural hashes, exact source identity and frozen run/receiver/revision.
- [x] Comparisons, AND/OR/NOT, freshness and vault-state predicates; exact Coinbase markets and registered Chainlink feeds.
- [x] Actual CRE HTTP/EVM capability workflow, report generation and Sepolia receiver delivery; direct signer fallback removed.
- [x] API 6 HTTP/MCP scope exposes only implemented CRE actions. Direct swap/copy/Solana tools and incompatible graphs are rejected.
- [x] CRE-only frozen monitors; archived direct jobs cannot reactivate. Restart pauses schedules; uncertain recovery remains read-only.
- [x] Submitted hash persistence, retry deduplication and receipt/event/historical state correlation.
- [x] Independent public Sepolia re-verification of the merged CRE simulation broadcast (18 proof checks).
- [x] Minimal responsive canvas, immutable run inspection, live CRE readiness, distinct historical proof and accessible prompt controls.
- [x] Real local Whisper installation and browser dictation→authenticated operator→live market reading E2E (9 checks, synthetic spoken input).
- [x] 266 application/CRE tests, TypeScript/frontend/WASM builds, 10 receiver tests; direct engineering test modules remain explicit research.
- [x] Real default-model operator refuses unsupported direct action requests without substituting a pause or writing anything.
- [x] Treasury actions through CRE (report v3): sweep to the deploy-time reserve, capped and rate-limited payments, CCIP evacuation to Base Sepolia, each verified on Sepolia ([evidence](demo/actions-evidence-2026-10-07T12-15-49-819Z.json)).
- [x] Contract readings as policy sources: Chainlink Proof of Reserve, ERC-20 supply, Aave v3 / Compound v3 rates, vault balance; math nodes with unit checking; deadlines.
- [x] Standing policies through the CRE workflow's cron trigger (`watch_policy`).
- [x] CRE Solana receiver: the `sotto_vault` Anchor program accepts reports only from its bound CRE forwarder; one CRE decision paused vaults on Sepolia and Solana devnet with the same policy hash ([evidence](demo/sepolia-evidence-2026-10-07T09-04-16-874Z.json)).
- [x] Vault safety: workflow identity lock, gas floor for pausing movements, guards that mirror the vault's own checks.

[CRE boundary](demo/cre-boundary-verification.json) · [Public proof](demo/sepolia-independent-proof-verification.json) · [Voice E2E](demo/voice-browser-e2e-verification.json).

## Required to complete current execution acceptance

- [x] Authenticate the CRE CLI through its standard login flow; actual status verified.
- [x] Fresh actual CRE frozen-policy monitor/stop/retry/restart acceptance: 10 checks passed ([evidence](demo/cre-acceptance-verification.json)).
- [x] Fund a fresh project test wallet, deploy an owned report-v2 Sepolia receiver, and verify a new CRE broadcast plus no-op/replay/refusal cases through two RPC providers.
- [x] Actual production browser→operator→CRE Sepolia delivery; 15 independent receipt checks passed. Read-only recovery verified without resubmission. Desktop/mobile visual proof saved.

## Explicitly deferred

- [ ] Deployed DON access, billing, workflow metadata authorization and actual deployed trigger execution. Simulation does not claim this.
- [ ] CRE copy-trading receiver/report/workflow and public-chain proof. Standalone copier is faded. [Requirements](docs/cre-copytrading-feasibility.md).
- [ ] Solana sweep on devnet: run `bun run solana:enable-sweep` (upgrades the program in place; needs about 2 devnet SOL, refunded) and re-run `bun run prove:actions`.
- [ ] Optional: `bun run lock:workflow` to bind the Sepolia vault to the CRE workflow identity from the recorded reports.
- [ ] Human microphone and user-started Codex desktop voice walkthrough; synthetic browser speech proof does not establish either.

Prior local/direct signer artifacts are preserved as historical research (`acceptedProductProof:false`). They are not advertised as CRE functionality.
