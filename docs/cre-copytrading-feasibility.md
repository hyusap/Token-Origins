# CRE copy-trading feasibility

Reviewed 7 October 2026. Copy trading is **not a supported product action**. The isolated V2 proof demonstrates real AMM settlement, but its task-wallet signer is not a Chainlink execution path. It must not be advertised as CRE-powered or enabled in the product.

## What CRE actually supports

CRE EVM writes generate a signed report, submit it through the EVM Write capability to a KeystoneForwarder, and deliver the payload to an `IReceiver.onReport(metadata, report)` consumer. The report consumer executes application logic. The documented write path does not directly sign an arbitrary follower EOA's router transaction. [EVM capabilities](https://docs.chain.link/cre/capabilities/evm-read-write), [Writing data onchain](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/writing-data-onchain).

The locally installed `@chainlink/cre-sdk` version 1.23.0 exports `logTrigger`, `filterLogs`, `getTransactionByHash`, `getTransactionReceipt`, `headerByNumber`, `callContract`, and `writeReport` in its generated EVM client. These provide the required primitives to observe a pool event, verify the actual leader transaction and receipt, inspect state, and deliver a report. Their presence proves API availability, not that this repository has implemented or publicly executed such a workflow. [EVM log trigger guide](https://docs.chain.link/cre/guides/workflow/using-triggers/evm-log-trigger), [SDK EVM client reference](https://docs.chain.link/cre/reference/sdk/evm-client).

Current documented defaults include 15 EVM reads per execution, a 100-block historical log-query window, five addresses per EVM log filter, and a 10-million-gas write ceiling. A future implementation must count all transaction, receipt, header, pool, budget and oracle reads against the actual simulator/runtime quotas. [Service quotas](https://docs.chain.link/cre/service-quotas).

Deployed DON execution requires deployment approval. Local `cre workflow simulate` can perform real RPC reads and, with broadcast enabled and an appropriate funded simulation signer, real testnet writes. A simulation receipt is not proof of an activated production DON workflow. Private-registry deployment avoids gas for registry management but still requires access and does not fund execution assets. [Deploying workflows](https://docs.chain.link/cre/guides/operations/deploying-workflows).

## A genuine CRE implementation would need

1. A separate funded swap receiver that owns disposable test tokens, implements ERC165 and `IReceiver`, and trusts the correct Chainlink forwarder. Production also needs workflow-owner/ID authorization. Metadata decoding must accept the actual forwarder layout; the current docs describe 64-byte production metadata, rather than requiring exactly 62 bytes. [Consumer contracts](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts).
2. Owner-authorized, immutable trade configuration: source chain, watched leader, supported venue, pool, token direction, decimals, proportion, per-trade cap, total cap, number of trades, oracle deviation bound, minimum received, deadline and policy identity. Receiver-side budget and replay protection must survive workflow retries and backend restarts.
3. A genuine CRE trigger and handler that verifies the leader's canonical transaction and successful pool receipt. A V2 `Swap.sender` identifies the caller of the pool, often the router; it does not alone prove which wallet made the trade. Source transaction hash, block hash and log index must remain bound to the report.
4. Fresh source and oracle observations through CRE capabilities, composable predicate evaluation, and a report binding target receiver, target chain, policy, source identity, path, exact amount, minimum output and expiry. The existing pause report cannot safely be reused as a swap report.
5. Receiver-side exact approval and a real router swap, with confirmed forwarder delivery, receiver execution, correlated pool event, token transfers and actual receipt-block balances. A separate offchain approval/swap signer followed by a Chainlink price check would not satisfy the user's CRE requirement.
6. An actual funded public testnet deployment and `cre ... simulate --broadcast` proof, followed by deployed DON access and activation if autonomous DON monitoring is claimed. A local forwarder contract test proves receiver behavior only.

Uniswap's official integration guide requires an external price safety check. A fresh pool quote alone is not an independent oracle and can be manipulated. For canonical assets, appropriate Chainlink feeds and strict freshness/deviation checks can provide this additional constraint. Rehearsal Alpha/Beta have no monetary value or Chainlink USD feeds and must never be presented as real USD-priced assets. [Uniswap swap integration](https://developers.uniswap.org/docs/protocols/v2/guides/swapping).

## Repository state

The only implemented CRE handler currently supports `pause-vault`, and rejects unsupported actions before any read or write. There is no CRE swap receiver, swap report contract, log-trigger swap workflow, publicly verified CRE swap receipt, or activated autonomous CRE copy workflow.

Historical engineering files are `server/evm-trades.ts`, `server/evm-trade-watch.ts`, `server/evm-trade-watch-adapter.ts`, `scripts/verify-copytrade.ts`, `scripts/setup-trading.ts`, `scripts/register-mainnet-trade-venue.ts`, the rehearsal token, and pinned official V2 artifact files. The 24-check isolated proof is `demo/copytrade-isolated-verification.json`; it covers genuine local AMM trades, response-loss recovery, bounded watches and fresh predicate gating. It does not prove CRE execution and must remain outside the enabled product surface.

No setup was run against the primary local chain. The public-read registration probe was stopped after the user changed scope, and published no venue registry or mainnet observation artifact. No mainnet signing path exists in the engineering utility.

The current product should fade copy trading and explain that the available Chainlink execution action is pausing vault spending. Reintroducing copy trading requires the implementation and evidence above; interface polish, mocks, an EOA transaction, or an unverified roadmap are insufficient.
