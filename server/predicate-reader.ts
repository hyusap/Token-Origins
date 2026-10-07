import {createPublicClient,http} from 'viem';
import {validatePredicate,predicateHash,collectSources,sourceIdentity,evaluatePredicate,type PredicateGraph,type GraphInputs,type Observation} from '../cre/graph';
import {fetchExchangeTrade,readVaultState,type FeedResolver,type ExchangeFetcher} from '../cre/runner';
import {fetchFeedPrice,feedObservation} from './chainlink';
import {loadDeployment} from './sources';
/** Real source reader for action-independent gates; no signing or implicit vault. */
export async function readPredicateEvidence(input:{graph:PredicateGraph;exchangeMaxAgeSeconds:number;vaultTarget?:{chainId:number;address:string;rpcUrl?:string}},deps:{resolveFeed?:FeedResolver;fetchExchange?:ExchangeFetcher}={}) {
  const {graph}=validatePredicate(input.graph);
  const readsVault=graph.nodes.some(node=>node.kind==='vault-paused');
  let vaultPaused:boolean|null=null;
  if(readsVault) {
    if(!input.vaultTarget)throw new Error('Predicate requires an explicit frozen vault input');
    const deployment=input.vaultTarget.rpcUrl?input.vaultTarget:await loadDeployment();
    if(!deployment||deployment.chainId!==input.vaultTarget.chainId||deployment.address.toLowerCase()!==input.vaultTarget.address.toLowerCase())throw new Error('Frozen predicate vault configuration changed or is unavailable');
    const client=createPublicClient({transport:http(deployment.rpcUrl)});
    if(await client.getChainId()!==input.vaultTarget.chainId)throw new Error('Predicate vault RPC chain mismatch');
    vaultPaused=(await readVaultState(client as any,input.vaultTarget.address as `0x${string}`,input.vaultTarget.chainId)).paused;
  }
  const observations:Observation[]=await Promise.all(collectSources(graph).map(async source=>{
    const observed=source.type==='exchange-trade' ? await (deps.fetchExchange??fetchExchangeTrade)(source) : await (deps.resolveFeed??(async source=>feedObservation(await fetchFeedPrice(source.symbol,source.network),source)))(source);
    const identity=sourceIdentity(source);
    if(observed.key!==identity.key || identity.address&&observed.address?.toLowerCase()!==identity.address.toLowerCase())throw new Error('Predicate source identity mismatch');
    return observed;
  }));
  const inputs:GraphInputs={readings:Object.fromEntries(observations.map(o=>[o.key,{usd:o.usd,observedAt:o.observedAt}])),vaultPaused,exchangeMaxAgeSeconds:input.exchangeMaxAgeSeconds};
  const now=Date.now();return {predicateHash:predicateHash(graph),inputs,result:evaluatePredicate(graph,inputs,now),evaluatedAt:new Date(now).toISOString(),observations};
}
