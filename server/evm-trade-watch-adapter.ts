import { readPredicateEvidence } from './predicate-reader';
import { EvmTradeUtilities, type EvmTradeNetwork, type EvmCopyReceipt } from './evm-trades';
import type { TradeWatchAdapter, TradeWatchExecution, FrozenTradeVenue } from './evm-trade-watch';

const base = (venue:FrozenTradeVenue,attempt:{operationId:string;source:{transactionHash:string;tokenIn:string;tokenOut:string};amountInRaw:string}):TradeWatchExecution => ({operationId:attempt.operationId,sourceTransactionHash:attempt.source.transactionHash,chainId:venue.chainId,signer:venue.signer,tokenIn:attempt.source.tokenIn,tokenOut:attempt.source.tokenOut,amountInRaw:attempt.amountInRaw,status:'uncertain'});
const confirmed = (venue:FrozenTradeVenue,attempt:{operationId:string;source:{transactionHash:string;tokenIn:string;tokenOut:string};amountInRaw:string},r:EvmCopyReceipt):TradeWatchExecution => ({...base(venue,attempt),status:'confirmed',transactionHash:r.transactionHash,blockNumber:r.blockNumber,amountOutRaw:r.amountOut});

/** Converts the real V2 journal into bounded watch operations. Its recovery path
 * only reads persisted signatures and canonical receipts; it never executes.
 */
export function evmTradeWatchAdapter(utilities:EvmTradeUtilities):TradeWatchAdapter {
  return {
    freeze:input=>utilities.freezeVenue(input),
    confirmedHead:venue=>utilities.confirmedHead(venue),
    blockHash:(venue,block)=>utilities.blockHash(venue,block),
    scan:async(venue,leader,fromBlock,toBlock)=>{
      await utilities.confirmedHead(venue);
      const found=await utilities.inspectWalletSwaps({network:venue.network as EvmTradeNetwork,venueId:venue.venueId,wallet:leader,fromBlock,toBlock});
      return found.swaps.map(t=>({transactionHash:t.transactionHash,blockNumber:t.blockNumber,blockHash:t.blockHash,logIndex:t.logIndex,leader:t.wallet,router:t.router,pair:t.pair,tokenIn:t.tokenIn,tokenOut:t.tokenOut,amountInRaw:t.amountIn}));
    },
    evaluatePredicate:async(predicate,venue)=>{
      await utilities.confirmedHead(venue);return readPredicateEvidence(predicate);
    },
    execute:async input=>{
      const attempt={operationId:input.operationId,source:input.trade,amountInRaw:input.amountInRaw};const result=base(input.venue,attempt);
      let copyStarted=false;try {
        await utilities.confirmedHead(input.venue);
        const source={network:input.venue.network as EvmTradeNetwork,venueId:input.venue.venueId,wallet:input.trade.leader,transactionHash:input.trade.transactionHash};
        const quote=await utilities.quoteCopySwap({...source,proportionBps:10000,maxAmountIn:input.amountInRaw,slippageBps:input.slippageBps});
        if(quote.source.blockHash!==input.trade.blockHash||quote.source.logIndex!==input.trade.logIndex||quote.source.tokenIn.toLowerCase()!==input.trade.tokenIn.toLowerCase()||quote.source.tokenOut.toLowerCase()!==input.trade.tokenOut.toLowerCase()||quote.amountIn!==input.amountInRaw)throw new Error('Fresh source/quote identity does not match reserved watch attempt');
        copyStarted=true;const receipt=await utilities.copySwap({...source,operationId:input.operationId,proportionBps:10000,maxAmountIn:input.amountInRaw,minAmountOut:quote.minAmountOut},{beforeSwap:async()=>{await utilities.confirmedHead(input.venue);return input.beforeBroadcast();}});
        return confirmed(input.venue,attempt,receipt);
      }catch(error){
        try {const recovered=await utilities.reconcileCopySwap(input.operationId);if(recovered.status==='confirmed')return confirmed(input.venue,attempt,recovered.receipt);if(recovered.status==='failed')return {...result,status:/Signed transaction reverted/.test(recovered.error)?'reverted':'not-submitted',error:recovered.error};return {...result,error:String(error)};}
        catch(recoveryError) {return {...result,status:!copyStarted||String(recoveryError).includes('Unknown copy operationId')?'not-submitted':'uncertain',error:String(error)};}
      }
    },
    reconcile:async({venue,attempt})=>{
      const result=base(venue,attempt);
      try {await utilities.confirmedHead(venue);const recovered=await utilities.reconcileCopySwap(attempt.operationId);if(recovered.status==='confirmed')return confirmed(venue,attempt,recovered.receipt);if(recovered.status==='failed')return {...result,status:/Signed transaction reverted/.test(recovered.error)?'reverted':'not-submitted',error:recovered.error};return {...result,error:'Journal has no final canonical receipt'};}
      catch(error){return {...result,error:String(error)};}
    },
  };
}
