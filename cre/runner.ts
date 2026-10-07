import {createPublicClient,createWalletClient,http,parseAbi,decodeEventLog,decodeErrorResult,encodeFunctionData,defineChain,type Address,type Hex,type PublicClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {sepolia} from 'viem/chains';
import {resolve} from 'node:path';
import {specificationSchema,PRICE_URL,parsePrice,type ExecutionSpecification} from './spec';
import {joinEvidenceChunks,EVIDENCE_CHUNK_TAG} from './evidence-log';
import {
  evaluateGraph,collectSources,sourceIdentity,describeSource,readsVault,explainNoop,encodeReportFor,reportRefusal,actionTerms,actionPauses,isSimulatedAction,runIdHash,payeeId,formatUsd,toBps,
  NETWORKS,CCIP_DESTINATIONS,LENDING_REGISTRY,ccipExplorer,
  type Source,type FeedSource,type ChainSource,type Observation,type ConditionEvidence,type PauseReport,type Reading,type VaultAction,type PolicyAction,
} from './graph';

/** Supplied by the backend, which owns RPC access for each source network. */
export type FeedResolver=(source:FeedSource)=>Promise<Observation>;
export type SourceResolver=(source:ChainSource)=>Promise<Observation>;
export type ExchangeFetcher=()=>Promise<Observation>;
export type ExecutionMode='cre-local-simulation'|'local-evm-rehearsal'|'fixture-rehearsal';
export type SimulatedOrder={simulated:true;venue:string;side:'sell';symbol:string;amount:number;referencePriceUsd:number;notionalUsd:number;referenceSource:string;observedAt:string;placedAt:string};
export type SimulatedRebalance={simulated:true;venue:'mock-venue';asset:string;from:string;to:string;fraction:number;fromAprPercent?:number;toAprPercent?:number;placedAt:string};
export interface VaultRead {address:string;chainId:number;paused:boolean;balanceWei:string;reportVersion:number|null;tokenBalance?:string}
/** What the receiver did for this run, decoded from its own events. */
export interface ReceiverEffects {paused?:boolean;sweptWei?:string;reserve?:string;paidWei?:string;payee?:string;payeeId?:string;ccipMessageId?:string;ccipAmount?:string;ccipFee?:string;destinationChainSelector?:string;ccipExplorerUrl?:string}
export interface TransactionEvidence {hash:string;blockNumber:number;status:string;receiverConfirmed:boolean;pausedAfter:boolean;effects?:ReceiverEffects}
/** Fixture rehearsal: in-memory effects only. */
export interface FixtureEffects {paused?:boolean;sweptEth?:number;paidEth?:number;payee?:string;evacuatedTokens?:number}
export interface ExecutionEvidence {
  runId:string;revision:number;policyHash:string;mode:ExecutionMode;
  /** CRE trigger that ran this check: one HTTP request, or the standing policy's cron schedule. */
  trigger?:'http'|'cron';
  /** Every input the decision used, with source identity and timestamps. */
  observations:Observation[];
  vault:VaultRead|null;
  conditions:ConditionEvidence[];
  root:boolean;
  decision:'act'|'noop';
  action:PolicyAction['type'];
  noopReason?:string;
  decidedAt:string;
  dryRun?:boolean;
  /** Terms of the report sent: layout version and what the receiver was asked to do. */
  report?:{version:number|null;action:number;flags:number;payeeId:string;amount:string;destinationChainSelector:string};
  transaction?:TransactionEvidence;
  simulatedOrder?:SimulatedOrder;
  simulatedRebalance?:SimulatedRebalance;
  /** Fixture rehearsal changed only in-memory vault state. */
  fixturePaused?:boolean;
  fixture?:FixtureEffects;
  /** The same decision on the sotto_vault program on Solana (CRE mode with ORIGINS_SOLANA_VAULT). */
  solana?:{network:string;programId:string;vault:string;forwarderProgram:string;signature:string|null;status:string;error?:string;verified?:boolean;slot?:number;explorerUrl?:string;action?:'pause'|'sweep';pauses?:boolean;reserve?:string;bps?:number;sweptLamports?:number};
  /** Why the Solana vault was left unchanged by an acting decision. */
  solanaSkipped?:string;
  logs:string[];
}

/** What a runner needs from the world. Each mode supplies its own; the decision logic is shared. */
export interface PolicyEnvironment {
  mode:ExecutionMode;
  readVault(options?:{tokenBalance?:boolean}):Promise<VaultRead>;
  readSource(source:Exclude<Source,{type:'vault-balance'}>):Promise<Observation>;
  /** Reference price for a simulated sell whose asset the policy did not read. */
  referencePrice?(symbol:string):Promise<Observation>;
  /** True when this execution's report already landed on chain. */
  alreadyProcessed?(runId:string):Promise<boolean>;
  /** Submits the report this vault accepts for the action and returns receipt evidence with decoded effects. */
  deliverReport?(request:{action:VaultAction;report:PauseReport;reportVersion:number|null}):Promise<TransactionEvidence>;
  /** Fixture mode: apply the action to the in-memory vault. Never a transaction. */
  fixtureAct?(action:VaultAction):Promise<FixtureEffects>;
}

const vaultAbi=parseAbi([
  'function paused() view returns (bool)',
  'function reportVersion() view returns (uint256)',
  'function processedRuns(bytes32) view returns (bool)',
  'function ccipToken() view returns (address)',
  'function resume()',
  'event SpendingPaused(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,uint256 decidedAt)',
  'event ReserveSwept(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,address reserve,uint256 amount)',
  'event GrantStreamed(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,bytes32 payeeId,address payee,uint256 amount)',
  'event TreasuryEvacuated(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,bytes32 messageId,uint64 destinationChainSelector,address token,uint256 amount,uint256 fee)',
]);
const erc20BalanceAbi=parseAbi(['function balanceOf(address) view returns (uint256)']);
const forwarderAbi=parseAbi(['function deliver(address receiver,bytes report)']);
// Public Anvil development key; deliberately accepted only when chain ID is 31337.
const LOCAL_DEV_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SIMULATED_REFUSAL='Simulated sells run only in local rehearsal (as do simulated rebalances); CRE delivers only real vault actions. Nothing was submitted.';

/** Observation of the vault's own ETH balance, from the vault read the run already made. */
function vaultBalanceObservation(vault:VaultRead):Observation {
  const at=new Date().toISOString();
  return {...sourceIdentity({type:'vault-balance'}),value:Number(BigInt(vault.balanceWei))/1e18,raw:vault.balanceWei,observedAt:at,fetchedAt:at};
}

/**
 * The one decision path. Fixture, local EVM and (through the same graph
 * module) the CRE handler all read inputs, evaluate the validated graph with
 * the same mandatory guards, and only then act.
 */
export async function executePolicy(input:ExecutionSpecification,env:PolicyEnvironment,progress?:(message:string)=>void):Promise<ExecutionEvidence> {
  const spec=specificationSchema.parse(input);
  const graph=spec.graph;
  const logs:string[]=[];
  const log=(text:string)=>{logs.push(text);progress?.(text);};
  log(env.mode==='fixture-rehearsal'?'Fixture rehearsal · live inputs, in-memory vault, no transaction':'Local EVM rehearsal · shared graph evaluator · no CRE/DON claim');

  let vault:VaultRead|null=null;
  if(readsVault(graph)) {
    vault=await env.readVault({tokenBalance:graph.action.type==='evacuate'});
    log(`Read vault ${vault.paused?'paused':'active'} on chain ${vault.chainId}`);
    if(!isSimulatedAction(graph.action)) {
      const refusal=reportRefusal(vault.reportVersion,graph.action.type);
      if(refusal) throw new Error(`Vault ${vault.address}: ${refusal}`);
    }
  }
  const sources=collectSources(graph);
  for(const source of sources) log(`Fetching ${describeSource(source)}`);
  const observations=await Promise.all(sources.map(async source=>{
    if(source.type==='vault-balance') return vaultBalanceObservation(vault!);
    const observation=await env.readSource(source);
    const expected=sourceIdentity(source);
    if(observation.key!==expected.key||(expected.address&&observation.address?.toLowerCase()!==expected.address.toLowerCase()))
      throw new Error(`Source identity mismatch for ${describeSource(source)}: got ${observation.key}${observation.address?` at ${observation.address}`:''}`);
    return observation;
  }));
  const readings:Record<string,Reading>=Object.fromEntries(observations.map(o=>[o.key,{value:o.value??o.usd,observedAt:o.observedAt}]));
  const nowMs=Date.now();
  const result=evaluateGraph(graph,{
    readings,vaultPaused:vault?.paused??null,vaultBalanceEth:vault?Number(BigInt(vault.balanceWei))/1e18:null,
    vaultTokenBalance:vault?.tokenBalance!==undefined?Number(BigInt(vault.tokenBalance))/1e18:null,exchangeMaxAgeSeconds:spec.maxAgeSeconds,
  },nowMs);
  const evidence:ExecutionEvidence={
    runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash,mode:env.mode,observations,vault,
    conditions:result.conditions,root:result.root,decision:result.decision,action:graph.action.type,decidedAt:new Date(nowMs).toISOString(),logs,
  };
  for(const c of result.conditions) log(`${c.passed?'PASS':'STOP'} ${c.role==='node'?c.nodeId:c.nodeId.replace(/^guard:/,'')}: ${c.detail}`);
  if(result.decision==='noop') {evidence.noopReason=explainNoop(result);log(`No action. ${evidence.noopReason}`);return evidence;}

  if(graph.action.type==='sell') {
    // A sell is a simulation: no contract, no counterparty, no asset movement.
    const action=graph.action;
    const reference=observations.find(o=>o.provider==='chainlink'&&o.unit==='USD'&&o.key.endsWith(`:${action.symbol}`))
      ?? (action.symbol==='ETH'?observations.find(o=>o.provider==='coinbase'):undefined)
      ?? (env.referencePrice?await env.referencePrice(action.symbol):undefined);
    if(!reference) throw new Error(`Simulated sell needs a ${action.symbol} reference price but none is available`);
    const usd=reference.value??reference.usd!;
    evidence.simulatedOrder={simulated:true,venue:action.venue,side:'sell',symbol:action.symbol,amount:action.amount,referencePriceUsd:usd,notionalUsd:Math.round(action.amount*usd*100)/100,referenceSource:reference.label,observedAt:reference.observedAt,placedAt:new Date().toISOString()};
    log(`SIMULATED sell ${action.amount} ${action.symbol} at ${formatUsd(usd)} reference (${action.venue}); no transaction, no asset moved`);
    return evidence;
  }
  if(graph.action.type==='rebalance') {
    const action=graph.action;
    const rate=(protocol:string)=>observations.find(o=>o.key===`lending-rate:ethereum-mainnet:${protocol}:${action.asset}`)?.value;
    evidence.simulatedRebalance={simulated:true,venue:'mock-venue',asset:action.asset,from:action.from,to:action.to,fraction:action.fraction,
      ...(rate(action.from)!==undefined?{fromAprPercent:rate(action.from)}:{}),...(rate(action.to)!==undefined?{toAprPercent:rate(action.to)}:{}),placedAt:new Date().toISOString()};
    log(`SIMULATED rebalance of ${toBps(action.fraction)/100}% ${action.asset} from ${LENDING_REGISTRY[action.from].label} to ${LENDING_REGISTRY[action.to].label}; no transaction, no asset moved`);
    return evidence;
  }
  const action=graph.action;
  if(spec.broadcast===false) {evidence.dryRun=true;log('Policy passed; dry run, no report submitted');return evidence;}
  if(env.fixtureAct) {
    const effects=await env.fixtureAct(action);
    evidence.fixture=effects;
    if(effects.paused) evidence.fixturePaused=true;
    log(`Fixture vault changed in memory (${describeFixture(effects)}). No blockchain execution was performed.`);
    return evidence;
  }
  if(!env.deliverReport||!vault) throw new Error('This environment cannot deliver a vault report');
  if(env.alreadyProcessed&&await env.alreadyProcessed(spec.runId)) {
    evidence.decision='noop';evidence.noopReason='This execution already landed on chain; replay suppressed.';log(evidence.noopReason);return evidence;
  }
  log(`Delivering report v${vault.reportVersion} (${action.type}) bound to vault, chain, run, revision and policy hash`);
  const tx=await env.deliverReport({action,reportVersion:vault.reportVersion,report:{target:vault.address as Address,chainId:vault.chainId,runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash as Hex,decidedAt:Math.floor(nowMs/1000)}});
  evidence.transaction=tx;
  const failures=effectFailures(action,tx);
  if(failures.length) throw new Error(`Transaction, receiver events, and fresh state did not all confirm: ${failures.join('; ')}`);
  log(`Confirmed receipt + receiver events (run, revision, policy hash) + fresh state at block ${tx.blockNumber}: ${describeEffects(tx.effects)}`);
  return evidence;
}

const describeFixture=(effects:FixtureEffects)=>[
  effects.paused&&'paused',effects.sweptEth!==undefined&&`${effects.sweptEth} ETH swept to the reserve`,
  effects.paidEth!==undefined&&`${effects.paidEth} ETH paid to the ${effects.payee}`,effects.evacuatedTokens!==undefined&&`${effects.evacuatedTokens} CCIP-BnM queued for CCIP`,
].filter(Boolean).join(', ')||'no change';
export const describeEffects=(effects:ReceiverEffects|undefined)=>!effects?'no receiver effects decoded':[
  effects.paused&&'spending paused',effects.sweptWei&&`${Number(effects.sweptWei)/1e18} ETH swept to reserve ${effects.reserve}`,
  effects.paidWei&&`${Number(effects.paidWei)/1e18} ETH paid to ${effects.payee}`,effects.ccipMessageId&&`CCIP message ${effects.ccipMessageId}`,
].filter(Boolean).join(', ')||'no change';

/** What must be true of a delivered report for the action to count as done. */
export function effectFailures(action:VaultAction,tx:TransactionEvidence):string[] {
  const effects=tx.effects??{};
  const terms=actionTerms(action);
  const failures:string[]=[];
  if(!['success','confirmed',1,'0x1'].includes(tx.status as any)) failures.push(`receipt status ${tx.status}`);
  if(!tx.receiverConfirmed) failures.push('the receiver did not record this run');
  if(actionPauses(action)&&!tx.pausedAfter) failures.push('vault not paused afterwards');
  // Evidence from runners that predate decoded effects carried the pause match in receiverConfirmed.
  if(action.type==='pause-vault'&&!(tx.effects===undefined||effects.paused)) failures.push('no SpendingPaused event for this run, revision and policy hash');
  if(action.type==='sweep'&&!(effects.sweptWei&&BigInt(effects.sweptWei)>0n)) failures.push('no ReserveSwept event for this run');
  if(action.type==='pay'&&(effects.paidWei!==terms.amount.toString()||effects.payeeId?.toLowerCase()!==payeeId(action.payee).toLowerCase())) failures.push('no GrantStreamed event paying this payee this amount');
  if(action.type==='evacuate'&&!effects.ccipMessageId) failures.push('no TreasuryEvacuated event with a CCIP message ID');
  return failures;
}

/** Decodes the vault's events for one execution, checking every bound field. */
export function receiverEffects(logs:readonly {address:string;data:Hex;topics:readonly Hex[]}[],vault:string,runId:string,revision:number,policyHash:string):ReceiverEffects&{matched:boolean} {
  const id=runIdHash(runId);
  const effects:ReceiverEffects&{matched:boolean}={matched:false};
  for(const entry of logs) {
    if(entry.address.toLowerCase()!==vault.toLowerCase()) continue;
    let event;
    try{event=decodeEventLog({abi:vaultAbi,data:entry.data,topics:entry.topics as [Hex,...Hex[]]});}catch{continue;}
    const args=event.args as any;
    if(!('runId' in args)||args.runId!==id||args.revision!==BigInt(revision)||String(args.policyHash).toLowerCase()!==policyHash.toLowerCase()) continue;
    effects.matched=true;
    if(event.eventName==='SpendingPaused') effects.paused=true;
    if(event.eventName==='ReserveSwept') {effects.sweptWei=args.amount.toString();effects.reserve=args.reserve;}
    if(event.eventName==='GrantStreamed') {effects.paidWei=args.amount.toString();effects.payee=args.payee;effects.payeeId=args.payeeId;}
    if(event.eventName==='TreasuryEvacuated') {
      effects.ccipMessageId=args.messageId;effects.ccipAmount=args.amount.toString();effects.ccipFee=args.fee.toString();
      effects.destinationChainSelector=args.destinationChainSelector.toString();effects.ccipExplorerUrl=ccipExplorer(args.messageId);
    }
  }
  return effects;
}
/** Finds the pause event for one execution in a receipt, checking every bound field. */
export function matchPauseEvent(logs:readonly {address:string;data:Hex;topics:readonly Hex[]}[],vault:string,runId:string,revision:number,policyHash:string):boolean {
  return Boolean(receiverEffects(logs,vault,runId,revision,policyHash).paused);
}
/**
 * Receipt evidence for one delivered report: decoded effects, whether the
 * receiver recorded this run, and paused() at the receipt block.
 */
async function receiptEvidence(client:PublicClient,vault:Address,receipt:{transactionHash:Hex;blockNumber:bigint;status:string;logs:readonly {address:string;data:Hex;topics:readonly Hex[]}[]},runId:string,revision:number,policyHash:string):Promise<TransactionEvidence> {
  const {matched,...effects}=receiverEffects(receipt.logs,vault,runId,revision,policyHash);
  const [pausedAfter,processed]=await Promise.all([
    pausedAt(client,vault,receipt.blockNumber),
    client.readContract({address:vault,abi:vaultAbi,functionName:'processedRuns',args:[runIdHash(runId)],blockNumber:receipt.blockNumber}).catch(()=>matched),
  ]);
  return {hash:receipt.transactionHash,blockNumber:Number(receipt.blockNumber),status:receipt.status,receiverConfirmed:Boolean(processed),pausedAfter,effects};
}

export async function readVaultState(client:PublicClient,address:Address,chainId:number,options:{tokenBalance?:boolean}={}):Promise<VaultRead> {
  const [paused,balance,reportVersion]=await Promise.all([
    client.readContract({address,abi:vaultAbi,functionName:'paused'}),
    client.getBalance({address}),
    client.readContract({address,abi:vaultAbi,functionName:'reportVersion'}).then(Number).catch(()=>null),
  ]);
  let tokenBalance:string|undefined;
  if(options.tokenBalance) {
    const token=await client.readContract({address,abi:vaultAbi,functionName:'ccipToken'}).catch(()=>null);
    tokenBalance=token&&token!=='0x0000000000000000000000000000000000000000'?(await client.readContract({address:token,abi:erc20BalanceAbi,functionName:'balanceOf',args:[address]})).toString():'0';
  }
  return {address,chainId,paused,balanceWei:balance.toString(),reportVersion,...(tokenBalance!==undefined?{tokenBalance}:{})};
}

export async function fetchExchangeTrade():Promise<Observation> {
  const response=await fetch(PRICE_URL,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});
  if(!response.ok) throw new Error(`Price source unavailable (${response.status}); action blocked`);
  const price=parsePrice(await response.json());
  return {...sourceIdentity({type:'exchange-trade',pair:'ETH-USD'}),value:price.usd,usd:price.usd,raw:price.raw,observedAt:price.observedAt,fetchedAt:new Date().toISOString()};
}

export interface LocalDeployment {address:string;forwarder:string;chainId:number;rpcUrl:string;blockNumber?:number}
const isLocalRpc=(url:string)=>/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url);
const localChain=(rpcUrl:string)=>defineChain({id:31337,name:'Anvil',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}});

export async function loadLocalDeployment():Promise<LocalDeployment> {
  return await Bun.file(resolve(import.meta.dir,'../contracts/deployment.local.json')).json();
}

/** Real transactions on an isolated localhost chain, through the explicitly named rehearsal forwarder. */
export function localEvmEnvironment(deployment:LocalDeployment,deps:{resolveFeed?:FeedResolver;resolveSource?:SourceResolver;fetchExchange?:ExchangeFetcher}={}):PolicyEnvironment {
  if(deployment.chainId!==31337||!isLocalRpc(deployment.rpcUrl)) throw new Error('Local rehearsal supports only isolated localhost Anvil (chain 31337)');
  const chain=localChain(deployment.rpcUrl);
  const client=createPublicClient({chain,transport:http(deployment.rpcUrl)}) as PublicClient;
  const address=deployment.address as Address;
  const guardChain=async()=>{if(await client.getChainId()!==31337) throw new Error('Refusing rehearsal action outside localhost development chain');};
  return {
    mode:'local-evm-rehearsal',
    async readVault(options){await guardChain();return readVaultState(client,address,31337,options);},
    async readSource(source){
      if(source.type==='exchange-trade') return (deps.fetchExchange??fetchExchangeTrade)();
      if(source.type==='chainlink-feed'&&deps.resolveFeed) return deps.resolveFeed(source);
      if(!deps.resolveSource) throw new Error(`Policy references ${describeSource(source)} but no resolver for it was supplied`);
      return deps.resolveSource(source);
    },
    async referencePrice(symbol){
      const source={type:'chainlink-feed' as const,symbol:symbol as FeedSource['symbol'],network:'ethereum-mainnet' as const};
      const resolver=deps.resolveFeed??deps.resolveSource;
      if(!resolver) throw new Error('No feed resolver for a sell reference price');
      return resolver(source);
    },
    async alreadyProcessed(runId){return client.readContract({address,abi:vaultAbi,functionName:'processedRuns',args:[runIdHash(runId)]});},
    async deliverReport({action,report,reportVersion}){
      await guardChain();
      const wallet=createWalletClient({account:privateKeyToAccount(LOCAL_DEV_KEY),chain,transport:http(deployment.rpcUrl)});
      const hash=await wallet.writeContract({address:deployment.forwarder as Address,abi:forwarderAbi,functionName:'deliver',args:[address,encodeReportFor(reportVersion,action,report)]});
      const receipt=await client.waitForTransactionReceipt({hash,timeout:30000});
      return receiptEvidence(client,address,receipt,report.runId,report.revision,report.policyHash);
    },
  };
}

export interface RunnerDeps {resolveFeed?:FeedResolver;resolveSource?:SourceResolver;fetchExchange?:ExchangeFetcher;deployment?:LocalDeployment;
  /** A standing policy's scheduled check: in CRE mode it runs through the workflow's cron trigger. */
  trigger?:'http'|'cron';schedule?:string}
const active=new Map<string,{spec:string;promise:Promise<ExecutionEvidence>}>();
const completed=new Map<string,{spec:string;evidence:ExecutionEvidence}>();
/** Runs a frozen specification once per run ID in this process; the chain dedupes across processes. */
export async function executeCreRun(input:ExecutionSpecification,onProgress?:(message:string)=>void,deps:RunnerDeps={}):Promise<ExecutionEvidence> {
  const spec=Object.freeze(specificationSchema.parse(input));
  const serialized=JSON.stringify(spec);
  const existing=completed.get(spec.runId);
  if(existing) {if(existing.spec!==serialized) throw new Error('Run ID reused with different immutable specification');return structuredClone(existing.evidence);}
  const underway=active.get(spec.runId);
  if(underway) {if(underway.spec!==serialized) throw new Error('Running version is immutable');return underway.promise;}
  const work=(async()=>{
    const result=process.env.ORIGINS_EXECUTION_MODE==='cre'
      ?await executeThroughCre(spec,onProgress,deps)
      :await executePolicy(spec,localEvmEnvironment(deps.deployment??await loadLocalDeployment(),deps),onProgress);
    completed.set(spec.runId,{spec:serialized,evidence:structuredClone(result)});return result;
  })();
  active.set(spec.runId,{spec:serialized,promise:work});
  try{return await work;}finally{active.delete(spec.runId);}
}

/** Chain names this CRE project has RPCs for; a graph needing any other network is refused before simulation. */
export async function configuredCreChains(projectFile=resolve(import.meta.dir,'project.yaml')):Promise<string[]> {
  const text=await Bun.file(projectFile).text();
  return [...text.matchAll(/chain-name:\s*([a-z0-9-]+)/g)].map(m=>m[1]!);
}
/** Throws before any side effect when CRE cannot execute this graph as written. */
export async function assertCreSupports(spec:ExecutionSpecification,chains?:string[]) {
  if(isSimulatedAction(spec.graph.action)) throw new Error(SIMULATED_REFUSAL);
  const available=chains??await configuredCreChains();
  for(const source of collectSources(spec.graph)) {
    const network=sourceIdentity(source).network;
    if(!network) continue;
    const chain=NETWORKS[network].creChainName;
    if(!available.includes(chain)) throw new Error(`${describeSource(source)} needs an RPC for ${chain} in cre/project.yaml; CRE will not substitute another network. Nothing was submitted.`);
  }
  if(!available.includes(NETWORKS['ethereum-sepolia'].creChainName)) throw new Error('cre/project.yaml has no Sepolia RPC for the vault');
  if(process.env.ORIGINS_SOLANA_VAULT&&!available.includes('solana-devnet')) throw new Error('ORIGINS_SOLANA_VAULT is set but cre/project.yaml has no solana-devnet RPC');
}
/** The Solana treasury CRE should also steer, when configured. Uses CRE's simulation forwarder on devnet. */
async function solanaTarget() {
  const vault=process.env.ORIGINS_SOLANA_VAULT;
  if(!vault) return undefined;
  const {SOTTO_VAULT_PROGRAM_ID,SIMULATION_FORWARDER,SOLANA_DEVNET_RPC,readTreasuryConfig,treasuryPda}=await import('./solana-vault');
  const {Connection,PublicKey}=await import('@solana/web3.js');
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(vault)) throw new Error('ORIGINS_SOLANA_VAULT must be a base58 Solana address');
  if(!process.env.CRE_SOLANA_PRIVATE_KEY) throw new Error('Solana writes need CRE_SOLANA_PRIVATE_KEY (a funded devnet key) for the CRE CLI to submit the transaction');
  // A configured reserve (program v3) lets the Solana vault sweep too; without one it only pauses.
  const reserve=await readTreasuryConfig(new Connection(SOLANA_DEVNET_RPC,'confirmed'),new PublicKey(vault)).catch(()=>null);
  return {chainSelectorName:'solana-devnet' as const,receiverProgramId:SOTTO_VAULT_PROGRAM_ID.toBase58(),forwarderProgramId:SIMULATION_FORWARDER.program.toBase58(),forwarderState:SIMULATION_FORWARDER.state.toBase58(),vault,
    ...(reserve?{sweep:{treasury:treasuryPda(new PublicKey(vault)).toBase58(),reserve:reserve.reserve}}:{})};
}
const creBinary=async()=>{
  const local=resolve(import.meta.dir,'bin/cre');
  if(await Bun.file(local).exists()) return local;
  const found=Bun.which('cre');
  if(!found) throw new Error('CRE CLI not found. Run bun run --cwd cre install:cli, then cre login.');
  return found;
};
/** Six-field cron (seconds first) for a check every N seconds, as CRE schedules it. */
export function cronEvery(seconds:number):string {
  if(seconds%3600===0) return `0 0 */${seconds/3600} * * *`;
  if(seconds%60===0) return `0 */${seconds/60} * * * *`;
  return `*/${seconds} * * * * *`;
}
async function executeThroughCre(spec:ExecutionSpecification,progress?:(message:string)=>void,deps:RunnerDeps={}):Promise<ExecutionEvidence> {
  await assertCreSupports(spec);
  const vault=process.env.ORIGINS_SEPOLIA_VAULT;
  if(!vault||!/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error('CRE mode requires ORIGINS_SEPOLIA_VAULT (run scripts/deploy-sepolia.ts)');
  const root=resolve(import.meta.dir);
  const configPath=resolve(root,'workflow/config.runtime.json');
  // Covers the forwarder's bookkeeping plus the vault's storage writes (and a CCIP send) under current
  // Sepolia gas pricing; 350k ran a pause out of gas (traced OutOfGas at ~198k inside onReport).
  const gasLimit=process.env.ORIGINS_CRE_GAS_LIMIT||'2000000';
  if(!/^\d+$/.test(gasLimit)||Number(gasLimit)>10_000_000) throw new Error('ORIGINS_CRE_GAS_LIMIT must be a whole number up to the CRE limit of 10,000,000');
  const solana=await solanaTarget();
  const cron=deps.trigger==='cron';
  await Bun.write(configPath,JSON.stringify({vaultAddress:vault,chainSelector:NETWORKS['ethereum-sepolia'].chainSelector,gasLimit,...(solana?{solana}:{}),
    ...(cron?{watch:{schedule:deps.schedule??cronEvery(60),spec}}:{})}));
  // The CLI authenticates itself from `cre login` or CRE_API_KEY; this process never reads those credentials.
  const args=[await creBinary(),'workflow','simulate','./workflow','--project-root',root,'--target','staging-settings','--non-interactive','--config',configPath,
    ...(cron?['--trigger-index','1']:['--trigger-index','0','--http-payload',JSON.stringify(spec)])];
  if(spec.broadcast!==false) args.push('--broadcast');
  progress?.(cron?'CRE CLI running the standing policy through the workflow cron trigger':'CRE CLI compiling and executing the frozen HTTP-trigger specification');
  const proc=Bun.spawn(args,{cwd:root,env:{...process.env},stdout:'pipe',stderr:'pipe'});
  const timeout=setTimeout(()=>proc.kill(),240000);
  const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);clearTimeout(timeout);
  // Error output may echo key material; drop every secret and every 32-byte hex string.
  const redact=(text:string)=>{for(const secret of [process.env.CRE_API_KEY,process.env.CRE_ETH_PRIVATE_KEY,process.env.CRE_SOLANA_PRIVATE_KEY]) if(secret) text=text.split(secret).join('[redacted]');return text.replace(/(0x)?[a-fA-F0-9]{64}/g,'[redacted]');};
  if(code!==0) throw new Error(`CRE execution failed (${code}): ${redact(stderr||stdout).slice(-1500)}`);
  const cleanOutput=stdout.replace(/\u001b\[[0-9;]*m/g,'');
  // Keep the last CLI transcript (secrets removed) for diagnosis.
  let transcript=cleanOutput;
  for(const secret of [process.env.CRE_API_KEY,process.env.CRE_ETH_PRIVATE_KEY,process.env.CRE_SOLANA_PRIVATE_KEY]) if(secret) transcript=transcript.split(secret).join('[redacted]');
  await Bun.write(resolve(root,'../.data/cre-last-run.log'),transcript).catch(()=>{});
  let evidence:ExecutionEvidence;
  try {evidence=JSON.parse(joinEvidenceChunks(cleanOutput)) as ExecutionEvidence;}
  catch(error) {throw new Error(`${error instanceof Error?error.message:String(error)}; the CLI transcript is in .data/cre-last-run.log`);}
  if(evidence.runId!==spec.runId||evidence.revision!==spec.revision||evidence.policyHash!==spec.policyHash) throw new Error('CRE execution evidence correlation failed');
  evidence.logs=cleanOutput.split('\n').filter(line=>line.includes('ORIGINS_')&&!line.includes(EVIDENCE_CHUNK_TAG)).map(line=>line.slice(line.indexOf('ORIGINS_')));
  for(const message of evidence.logs) progress?.(message.length>240?`${message.slice(0,240)}…`:message);
  const action=spec.graph.action as VaultAction;
  if(evidence.transaction?.hash) {
    const client=createPublicClient({chain:sepolia,transport:http(process.env.ORIGINS_SEPOLIA_RPC||'https://ethereum-sepolia-rpc.publicnode.com')});
    const receipt=await client.waitForTransactionReceipt({hash:evidence.transaction.hash as Hex,timeout:90000});
    evidence.transaction=await receiptEvidence(client as PublicClient,vault as Address,receipt,spec.runId,spec.revision,spec.policyHash);
    const failed=effectFailures(action,evidence.transaction);
    if(failed.length) {
      const notes=await diagnoseReport(client as PublicClient,vault as Address,receipt,spec,evidence).catch(error=>[`diagnosis unavailable: ${error instanceof Error?error.message:String(error)}`]);
      await Bun.write(resolve(root,'../.data/cre-last-run.log'),`${transcript}\n\nVERIFICATION FAILED: ${failed.join('; ')}\n${notes.join('\n')}\n`).catch(()=>{});
      throw new Error(`CRE report did not verify (${failed.join('; ')}).\n  ${notes.join('\n  ')}\n  ${NETWORKS['ethereum-sepolia'].explorer}/tx/${receipt.transactionHash}`);
    }
  }
  if(solana&&evidence.decision==='act'&&spec.broadcast!==false&&!evidence.solanaSkipped) await verifySolanaLeg(evidence,spec);
  return evidence;
}

/** Confirms the Solana write from chain data: success, matching events, vault state recording this run. */
async function verifySolanaLeg(evidence:ExecutionEvidence,spec:ExecutionSpecification) {
  const {verifySolanaPause,solanaExplorer,SOLANA_DEVNET_RPC}=await import('./solana-vault');
  const {Connection,PublicKey}=await import('@solana/web3.js');
  const leg=evidence.solana;
  if(!leg) throw new Error('The policy acted but CRE returned no Solana write evidence');
  if(leg.status!=='success'||!leg.signature) throw new Error(`Solana write failed: ${leg.error??leg.status}. The Ethereum action is verified; the Solana vault was not changed.`);
  const expectation={pause:leg.pauses??true,sweep:leg.action==='sweep'};
  const check=await verifySolanaPause(new Connection(SOLANA_DEVNET_RPC,'confirmed'),leg.signature,new PublicKey(leg.vault),spec.runId,spec.revision,spec.policyHash,expectation);
  leg.verified=check.succeeded&&check.event&&check.pausedAfter&&check.lastRunMatches;
  leg.slot=check.slot;
  leg.explorerUrl=solanaExplorer(leg.signature);
  if(check.swept) leg.sweptLamports=check.swept.lamports;
  if(!leg.verified) throw new Error(`Solana ${leg.action??'pause'} did not verify (${[!check.succeeded&&`transaction failed ${check.error??''}`,!check.event&&`no matching ${expectation.sweep?'ReserveSwept/':''}SpendingPaused event`,!check.pausedAfter&&'vault not paused',!check.lastRunMatches&&'vault did not record this run'].filter(Boolean).join('; ')}).\n  ${check.logs.slice(-12).join('\n  ')}\n  ${leg.explorerUrl}`);
}

/** paused() as of a given block, retrying while a load-balanced RPC catches up to it. */
async function pausedAt(client:PublicClient,address:Address,blockNumber:bigint):Promise<boolean> {
  let lastError:unknown;
  for(let attempt=0;attempt<6;attempt++) {
    try {return await client.readContract({address,abi:vaultAbi,functionName:'paused',blockNumber});}
    catch(error) {lastError=error;await Bun.sleep(2000);}
  }
  throw lastError;
}

const diagnosticAbi=parseAbi([
  'function onReport(bytes metadata,bytes report)',
  'function forwarder() view returns (address)',
  'error Unauthorized()','error InvalidReport()','error UnsupportedReport()','error WrongTarget()','error UnsupportedAction()','error StaleReport()',
  'error SpendingIsPaused()','error InvalidAmount()','error NothingToMove()','error UnknownPayee()','error PaymentTooSoon()','error EvacuationDisabled()','error WrongDestination()','error InsufficientFee()','error TransferFailed()',
]);
const revertData=(error:any):Hex|undefined=>{
  for(let e=error;e;e=e.cause) {
    if(typeof e.data==='string'&&e.data.startsWith('0x')) return e.data as Hex;
    if(typeof e.data?.data==='string') return e.data.data as Hex;
  }
  return undefined;
};

/**
 * Explains a report that did not verify: what the receipt holds, which
 * forwarder sent it versus the one the vault trusts, and what the vault says
 * when this exact report is replayed against chain state just before it.
 */
export async function diagnoseReport(client:PublicClient,vault:Address,receipt:{transactionHash:string;status:string;blockNumber:bigint;to:string|null;logs:readonly {address:string;data:Hex;topics:readonly Hex[]}[]},spec:ExecutionSpecification,evidence:ExecutionEvidence):Promise<string[]> {
  const notes=[`transaction status ${receipt.status} in block ${receipt.blockNumber}, sent to ${receipt.to}`];
  const fromVault=receipt.logs.filter(log=>log.address.toLowerCase()===vault.toLowerCase());
  notes.push(`${receipt.logs.length} log(s) from ${[...new Set(receipt.logs.map(log=>log.address))].join(', ')||'nobody'}; ${fromVault.length} from the vault`);
  for(const log of fromVault) {
    try {const event=decodeEventLog({abi:vaultAbi,data:log.data,topics:log.topics as [Hex,...Hex[]]});notes.push(`vault emitted ${event.eventName} ${JSON.stringify(event.args,(_,v)=>typeof v==='bigint'?v.toString():v)}`);}
    catch {notes.push('vault emitted an event this runner does not recognise');}
  }
  const trusted=await client.readContract({address:vault,abi:diagnosticAbi,functionName:'forwarder'});
  notes.push(`vault trusts forwarder ${trusted}${receipt.to&&receipt.to.toLowerCase()!==trusted.toLowerCase()?` — but the CRE transaction went to ${receipt.to}; redeploy with ORIGINS_SEPOLIA_FORWARDER=${receipt.to}`:''}`);
  const version=evidence.vault?.reportVersion??await client.readContract({address:vault,abi:vaultAbi,functionName:'reportVersion'}).then(Number).catch(()=>null);
  const report=encodeReportFor(version,spec.graph.action as VaultAction,{target:vault,chainId:NETWORKS['ethereum-sepolia'].chainId,runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash as Hex,decidedAt:Math.floor(Date.parse(evidence.decidedAt)/1000)});
  for(const sender of [...new Set([trusted,receipt.to].filter(Boolean) as string[])]) {
    try {
      await client.call({account:sender as Address,to:vault,data:encodeFunctionData({abi:diagnosticAbi,functionName:'onReport',args:['0x',report]}),blockNumber:receipt.blockNumber-1n});
      notes.push(`replaying this report from ${sender} before that block succeeds`);
    } catch(error) {
      const data=revertData(error);
      let reason='reverted';
      if(data) try {reason=`reverts ${decodeErrorResult({abi:diagnosticAbi,data}).errorName}`;} catch {reason=`reverts with data ${data.slice(0,10)}`;}
      notes.push(`replaying this report from ${sender} before that block ${reason}`);
    }
  }
  return notes;
}
/** @deprecated name kept for scripts written before every action could be diagnosed. */
export const diagnosePause=diagnoseReport;

/**
 * After a restart, decides what happened to a submission whose outcome was
 * unknown, from the chain alone. Never resubmits.
 */
export async function findSubmittedPause(runId:string,deployment:{address:string;chainId:number;rpcUrl:string;blockNumber?:number}):Promise<{landed:boolean;transactionHash?:string;blockNumber?:number;paused:boolean}> {
  const client=createPublicClient({transport:http(deployment.rpcUrl,{timeout:10000})}) as PublicClient;
  if(await client.getChainId()!==deployment.chainId) throw new Error('RPC chain does not match the vault deployment');
  const address=deployment.address as Address;
  const id=runIdHash(runId);
  const [landed,paused]=await Promise.all([
    client.readContract({address,abi:vaultAbi,functionName:'processedRuns',args:[id]}),
    client.readContract({address,abi:vaultAbi,functionName:'paused'}),
  ]);
  if(!landed) return {landed:false,paused};
  try {
    // Any event this vault emits for the run proves which transaction carried it.
    for(const name of ['SpendingPaused','ReserveSwept','GrantStreamed','TreasuryEvacuated'] as const) {
      const event=vaultAbi.find(x=>x.type==='event'&&x.name===name)!;
      const logs=await client.getLogs({address,event:event as any,args:{runId:id} as any,fromBlock:BigInt(deployment.blockNumber??0),toBlock:'latest'});
      const log=logs[0];
      if(log) return {landed:true,paused,transactionHash:log.transactionHash!,blockNumber:Number(log.blockNumber)};
    }
    return {landed:true,paused};
  } catch {
    // Some public RPCs cap log ranges; processedRuns alone still proves the report landed.
    return {landed:true,paused};
  }
}
export {CCIP_DESTINATIONS};
