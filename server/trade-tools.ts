import { toolDefinitions } from "./schemas";
import type { Database } from "bun:sqlite";
import { EvmTradeUtilities, type EvmTradeNetwork } from "./evm-trades";
import { EvmTradeWatchManager, type EvmTradeWatch, type TradeWatchAdapter } from "./evm-trade-watch";
import { evmTradeWatchAdapter } from "./evm-trade-watch-adapter";

export interface TradeToolResult { summary: string; data: Record<string, unknown> }
export interface TradeToolsOptions {
  db: Database;
  utilities?: EvmTradeUtilities;
  watchAdapter?: TradeWatchAdapter;
  onChange?: (watch: EvmTradeWatch) => void;
  scheduling?: boolean;
}

/** Archived signer diagnostics only. Product writes require CRE; scheduler is disabled. */
export function createTradeTools(options: TradeToolsOptions) {
  const utilities = options.utilities ?? new EvmTradeUtilities();
  const watches = new EvmTradeWatchManager(options.db, options.watchAdapter ?? evmTradeWatchAdapter(utilities), {
    onChange: options.onChange, scheduling: false,
  });
  async function invoke(name: string, args: Record<string, any>, sessionId: string): Promise<TradeToolResult | undefined> {
    switch (name) {
      case "list_evm_trade_venues": {
        const venues = utilities.listVenues();
        return { summary: venues.length ? `${venues.length} configured V2 venue(s). These are archived standalone signer experiments, not executable CRE product venues.` : "No archived EVM swap venues configured. Product copy-trading requires an implemented CRE receiver.", data: { venues } };
      }
      case "get_evm_trade_wallet": {
        const wallet = await utilities.getWallet(args.network as EvmTradeNetwork);
        return { summary: `Task wallet ${wallet.address} on ${wallet.network}; actual native and token balances are returned for each configured venue. No trade submitted.`, data: { ...wallet } };
      }
      case "inspect_evm_swap": {
        const swap = await utilities.inspectSwap(toolDefinitions.inspect_evm_swap.schema.parse(args));
        return { summary: `Verified the leader's confirmed single-hop swap on ${swap.network}, block ${swap.blockNumber}. ${swap.amountIn} raw input units exchanged for ${swap.amountOut} raw output units at the configured pair.`, data: { swap } };
      }
      case "inspect_evm_wallet_swaps": {
        const history = await utilities.inspectWalletSwaps(toolDefinitions.inspect_evm_wallet_swaps.schema.parse(args));
        return { summary: `Inspected ${history.swaps.length} confirmed eligible wallet swap(s) in the bounded block range ${history.fromBlock}–${history.toBlock}. This is a public read; no copy or watcher started.`, data: { ...history } };
      }
      case "quote_evm_copy_swap": {
        const quote = await utilities.quoteCopySwap(toolDefinitions.quote_evm_copy_swap.schema.parse(args));
        return { summary: `Fresh configured-pool quote at block ${quote.quoteBlockNumber}: input ${quote.amountIn}, output ${quote.quotedAmountOut}, minimum ${quote.minAmountOut}, all in raw token units. This quote uses pool reserves and is not an independent price oracle. No approval or swap submitted.`, data: { quote } };
      }
      case "copy_evm_swap":
      case "activate_evm_trade_watch":
        throw Object.assign(new Error("CRE_EXECUTION_REQUIRED: standalone signer swaps and copy watches have no implemented Chainlink CRE receiver integration."), { code: "CRE_EXECUTION_REQUIRED" });
      case "reconcile_evm_copy_swap": {
        const recovery = await utilities.reconcileCopySwap(String(args.copyOperationId));
        return { summary: `Copy operation ${args.copyOperationId}: ${recovery.status}. This recovery read did not sign or broadcast a transaction.`, data: { ...recovery } };
      }
      case "get_evm_trade_watches": {
        const selected = args.watchId ? [watches.get(String(args.watchId))] : watches.list(sessionId);
        if (selected.some(watch => watch.sessionId !== sessionId)) throw new Error("Trade watch belongs to another canvas session");
        return { summary: selected.length ? selected.map(watch => `${watch.id}: ${watch.status}; ${watch.reservedTrades} reserved attempt(s), ${watch.reservedInputRaw} raw input units reserved. ${watch.lastError ?? watch.stopReason ?? ""}`).join(" ") : "No trade watches in this session.", data: { watches: selected, ...(args.watchId ? { attempts: watches.attempts(String(args.watchId)) } : {}) } };
      }
      case "deactivate_evm_trade_watch": {
        const current = watches.get(String(args.watchId));
        if (current.sessionId !== sessionId) throw new Error("Trade watch belongs to another canvas session");
        const watch = watches.stop(current.id);
        return { summary: `Trade watch ${watch.id}: ${watch.status}. ${watch.stopReason ?? "Future checks stopped; submitted transactions may still complete."}`, data: { watch } };
      }
      case "reconcile_evm_trade_watch": {
        const current = watches.get(String(args.watchId));
        if (current.sessionId !== sessionId) throw new Error("Trade watch belongs to another canvas session");
        const watch = await watches.reconcile(current.id);
        return { summary: `Trade watch ${watch.id}: ${watch.status}. Read-only recovery; no new transaction or automatic monitoring resumption. ${watch.lastError ?? watch.stopReason ?? ""}`, data: { watch, attempts: watches.attempts(watch.id) } };
      }
      default: return undefined;
    }
  }
  return { invoke, listWatches: (sessionId?: string) => watches.list(sessionId), close: () => { watches.close(); utilities.close(); } };
}
