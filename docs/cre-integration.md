# Chainlink CRE execution

CRE is the sole product execution authority. Semantic API 6 exposes the implemented `pause-vault` workflow and refuses standalone transfers, swaps, direct local/testnet runs and copy-trading. Missing authentication, funding or receiver readiness fails closed; there is no replacement signer.

## Execution path

```text
Spoken/typed intent → Codex → validated MCP graph → frozen revision/receiver
→ CRE HTTP/EVM observations → shared graph evaluator → runtime.report()
→ EVM writeReport() → Sepolia forwarder → GrantVault.onReport()
→ independent receipt/event/historical-state verification
```

Exchange sources are read through the CRE HTTP capability with field aggregation. Chainlink feeds bind exact registered network/address; vault state uses the CRE EVM capability. The workflow supports HTTP-trigger payloads assembled from typed graphs rather than arbitrary agent-generated code. Coinbase discovery previews do not substitute for a run's CRE readings.

The current path uses **CRE local simulation with public Sepolia broadcast**. It is not a deployed DON workflow or production oracle-consensus claim. Backend polling can invoke this workflow repeatedly, but is not a DON cron/log trigger. The Sepolia simulation forwarder is appropriate only for this explicit simulation proof.

## Verified public evidence

[Pause transaction](https://sepolia.etherscan.io/tx/0x82e480e1f08ce78253d4100ecd17795dd50c2b7714feda24192d01f77a29b4ec), block **11861492**, receiver `0x7f0d5e4c98ec1f2c7781e2ae60b0272e6d9a5aa1`.

The saved graph/hash/run/revision match the actual transaction and `SpendingPaused` event. Independent RPC reads establish paused state at that receipt block. A later owner resume is recorded separately; historical confirmation does not assert current spending state.

```sh
bun run verify:proof
```

[Fresh owned-receiver simulation evidence](../demo/sepolia-evidence-2026-10-07T09-06-03-441Z.json) · [Independent policy/receipt verification](../demo/sepolia-current-proof-verification.json) · [Second RPC verification](../demo/sepolia-current-alternate-rpc-verification.json).

The current owned receiver is `0x3bacbd3a15dabc479e9654e92273cfbb53499a73`. Deployment replaces the default manifest only after verification and archives the previous receiver identity in `contracts/deployments/`, preserving historical receipts.

## Setup

```sh
bun install --cwd cre
bun run --cwd cre install:cli
cre/bin/cre login
bun run --cwd cre typecheck
bun run --cwd cre build:wasm
```

Use the application's report-v2 deployment manifest, or deploy an owned receiver with `bun run sepolia:deploy` using a funded Sepolia test wallet. Supply `CRE_ETH_PRIVATE_KEY` privately for broadcast, and `CRE_API_KEY` only if using API-key authentication instead of normal CLI login. No personal credential files are opened. `ORIGINS_CRE_DEPLOYMENT_FILE` selects the manifest; explicit receiver overrides must remain consistent with the frozen target. The default manifest is `contracts/deployment.sepolia.json`.

`ORIGINS_CRE_GAS_LIMIT` defaults to 2,000,000. A past 350,000 budget allowed a forwarder transaction while receiver execution ran out of gas; independent event/state verification caught it. A transaction hash alone never establishes successful action delivery.

```sh
bun run test:boundary
# Authenticated real CLI evaluation; no signing or broadcast:
bun run test:e2e
# Explicit public write proof for a configured, funded, owned test receiver:
bun run sepolia:prove
bun run dev
```

The inspector reads `/api/cre/capabilities`: CLI installation/authentication, receiver configuration and signing-key presence are separate from verified funding. It never exposes account details or key values.

## Receiver and recovery

Report v2 binds version, receiver, chain, run hash, revision, policy hash, pause action and decision timestamp. The receiver authenticates its immutable forwarder and checks domain, expiry and replay protection. Submitted hashes are durably recorded before receipt waiting; uncertain outcomes reconcile read-only against the original target.

Monitors freeze the graph/target, use CRE dry evaluation before a fresh CRE write evaluation, and stop after verified settlement. Backend restart pauses checks. Archived direct/local/Solana jobs cannot reactivate or satisfy a CRE job's settlement requirement.

Production DON deployment requires deploy access, supported triggers, funded billing, real forwarder configuration, workflow metadata authorization and a verified deployed execution. These are remaining milestones, not implied by the saved simulation receipt.

## Deferred copy trading and Solana

CRE supports report delivery to appropriate EVM receivers and Solana programs. This product has neither a funded CRE swap receiver nor a deployed Solana `on_report` program. Its standalone direct signer experiments are disabled, hidden from HTTP/MCP discovery and absent from advertised actions. [Copy-trading requirements](cre-copytrading-feasibility.md).

## Primary references

- [CRE overview](https://docs.chain.link/cre)
- [HTTP simulation](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/testing-in-simulation)
- [Consumer contracts](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)
- [Submitting reports](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/submitting-reports-onchain)
- [Solana Write](https://docs.chain.link/cre/capabilities/solana-write)

See [execution contract](execution-contract.md) for graph and API invariants.

## Actual deploy-access check

On October 7, 2026, the authenticated CLI reported deployment access is not enabled for this organization. The account-access command unexpectedly submitted a request despite `--non-interactive`; submission succeeded, but approval is pending. Both private and onchain registries were listed as available registry types. Private registry management avoids mainnet registry gas, but still requires deploy approval. [Recorded CLI result](../demo/cre-deploy-access-verification.json). The app still needs a deployed-workflow gateway adapter, deployed forwarder/metadata authorization and live DON execution verification after approval.
