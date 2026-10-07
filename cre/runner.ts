import {createPublicClient,createWalletClient,http,parseAbi,decodeEventLog,defineChain,type Address,type Hex,type PublicClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {sepolia} from 'viem/chains';
import {resolve} from 'node:path';
import {specificationSchema,PRICE_URL,parsePrice,type ExecutionSpecification} from './spec';
import {joinEvidenceChunks,EVIDENCE_CHUNK_TAG} from './evidence-log';
import {
  evaluateGraph,collectSources,sourceKey,sourceIdentity,describeSource,readsVault,explainNoop,encodePauseReport,runIdHash,formatUsd,
  NETWORKS,REPORT_VERSION,type PriceSource,type FeedSource,type Observation,type ConditionEvidence,type PauseReport,type PriceReading,
} from './graph';

/** Supplied by the backend, which owns RPC access for each feed network. */
export type FeedResolver=(source:FeedSource)=>Promise<Observation>;
export type ExchangeFetcher=()=>Promise<Observation>;
export type ExecutionMode='cre-local-simulation'|'local-evm-rehearsal'|'fixture-rehearsal';
export type SimulatedOrder={simulated:true;venue:string;side:'sell';symbol:string;amount:number;referencePriceUsd:number;notionalUsd:number;referenceSource:string;observedAt:string;placedAt:string};
export interface VaultRead {address:string;chainId:number;paused:boolean;balanceWei:string;reportVersion:number|null}
export interface TransactionEvidence {hash:string;blockNumber:number;status:string;receiverConfirmed:boolean;pausedAfter:boolean}
export interface ExecutionEvidence {
  runId:string;revision:number;policyHash:string;mode:ExecutionMode;
  /** Every input the decision used, with source identity and timestamps. */
  observations:Observation[];
  vault:VaultRead|null;
  conditions:ConditionEvidence[];
  root:boolean;
  decision:'act'|'noop';
  action:'pause-vault'|'sell';
  noopReason?:string;
  decidedAt:string;
  dryRun?:boolean;
  transaction?:TransactionEvidence;
  simulatedOrder?:SimulatedOrder;
  /** Fixture rehearsal changed only in-memory vault state. */
  fixturePaused?:boolean;
  logs:string[];
}

/** What a runner needs from the world. Each mode supplies its own; the decision logic is shared. */
export interface PolicyEnvironment {
  mode:ExecutionMode;
  readVault():Promise<VaultRead>;
  readSource(source:PriceSource):Promise<Observation>;
  /** Reference price for a simulated sell whose asset the policy did not read. */
  referencePrice?(symbol:string):Promise<Observation>;
  /** True when this execution's report already landed on chain. */
  alreadyProcessed?(runId:string):Promise<boolean>;
  /** Submits a v2 report and returns verified receipt evidence. */
  deliverPause?(report:PauseReport):Promise<TransactionEvidence>;
  /** Fixture mode: pause the in-memory vault. Never a transaction. */
  fixturePause?():Promise<void>;
}

const vaultAbi=parseAbi([
  'function paused() view returns (bool)',
  'function reportVersion() view returns (uint256)',
  'function processedRuns(bytes32) view returns (bool)',
  'function resume()',
  'event SpendingPaused(bytes32 indexed runId,uint256 indexed revision,bytes32 indexed policyHash,uint256 decidedAt)',
]);
const forwarderAbi=parseAbi(['function deliver(address receiver,bytes report)']);
// Public Anvil development key; deliberately accepted only when chain ID is 31337.
const LOCAL_DEV_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

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
    vault=await env.readVault();
    log(`Read vault ${vault.paused?'paused':'active'} on chain ${vault.chainId}`);
    if(graph.action.type==='pause-vault'&&vault.reportVersion!==REPORT_VERSION)
      throw new Error(`Vault ${vault.address} accepts report ${vault.reportVersion?`v${vault.reportVersion}`:'v1'}, not v${REPORT_VERSION}; redeploy the vault before running. No report was sent.`);
  }
  const sources=collectSources(graph);
  for(const source of sources) log(`Fetching ${describeSource(source)}`);
  const observations=await Promise.all(sources.map(async source=>{
    const observation=await env.readSource(source);
    const expected=sourceIdentity(source);
    if(observation.key!==expected.key||(expected.address&&observation.address?.toLowerCase()!==expected.address.toLowerCase()))
      throw new Error(`Source identity mismatch for ${describeSource(source)}: got ${observation.key}${observation.address?` at ${observation.address}`:''}`);
    return observation;
  }));
  const readings:Record<string,PriceReading>=Object.fromEntries(observations.map(o=>[o.key,{usd:o.usd,observedAt:o.observedAt}]));
  const nowMs=Date.now();
  const result=evaluateGraph(graph,{readings,vaultPaused:vault?.paused??null,exchangeMaxAgeSeconds:spec.maxAgeSeconds},nowMs);
  const evidence:ExecutionEvidence={
    runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash,mode:env.mode,observations,vault,
    conditions:result.conditions,root:result.root,decision:result.decision,action:graph.action.type,decidedAt:new Date(nowMs).toISOString(),logs,
  };
  for(const c of result.conditions) log(`${c.passed?'PASS':'STOP'} ${c.role==='node'?c.nodeId:c.nodeId.replace(/^guard:/,'')}: ${c.detail}`);
  if(result.decision==='noop') {evidence.noopReason=explainNoop(result);log(`No action. ${evidence.noopReason}`);return evidence;}

  if(graph.action.type==='sell') {
    // A sell is a simulation: no contract, no counterparty, no asset movement.
    const action=graph.action;
    const reference=observations.find(o=>o.provider==='chainlink'&&o.key.endsWith(`:${action.symbol}`))
      ?? (action.symbol==='ETH'?observations.find(o=>o.provider==='coinbase'):undefined)
      ?? (env.referencePrice?await env.referencePrice(action.symbol):undefined);
    if(!reference) throw new Error(`Simulated sell needs a ${action.symbol} reference price but none is available`);
    evidence.simulatedOrder={simulated:true,venue:action.venue,side:'sell',symbol:action.symbol,amount:action.amount,referencePriceUsd:reference.usd,notionalUsd:Math.round(action.amount*reference.usd*100)/100,referenceSource:reference.label,observedAt:reference.observedAt,placedAt:new Date().toISOString()};
    log(`SIMULATED sell ${action.amount} ${action.symbol} at ${formatUsd(reference.usd)} reference (${action.venue}); no transaction, no asset moved`);
    return evidence;
  }
  if(spec.broadcast===false) {evidence.dryRun=true;log('Policy passed; dry run, no report submitted');return evidence;}
  if(env.fixturePause) {
    await env.fixturePause();
    evidence.fixturePaused=true;
    log('Fixture vault paused in memory. No blockchain execution was performed.');
    return evidence;
  }
  if(!env.deliverPause||!vault) throw new Error('This environment cannot deliver a pause report');
  if(env.alreadyProcessed&&await env.alreadyProcessed(spec.runId)) {
    evidence.decision='noop';evidence.noopReason='This execution already landed on chain; replay suppressed.';log(evidence.noopReason);return evidence;
  }
  log('Delivering report v2 bound to vault, chain, run, revision and policy hash');
  const tx=await env.deliverPause({target:vault.address as Address,chainId:vault.chainId,runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash as Hex,decidedAt:Math.floor(nowMs/1000)});
  evidence.transaction=tx;
  if(tx.status!=='success'||!tx.receiverConfirmed||!tx.pausedAfter) throw new Error('Transaction, receiver event, and fresh pause read did not all confirm');
  log(`Confirmed receipt + SpendingPaused(run, revision, policy hash) + fresh paused() read at block ${tx.blockNumber}`);
  return evidence;
}

/** Finds the receiver event for one execution in a receipt, checking every bound field. */
export function matchPauseEvent(logs:readonly {address:string;data:Hex;topics:readonly Hex[]}[],vault:string,runId:string,revision:number,policyHash:string):boolean {
  const id=runIdHash(runId);
  return logs.some(entry=>{
    if(entry.address.toLowerCase()!==vault.toLowerCase())return false;
    try{const event=decodeEventLog({abi:vaultAbi,data:entry.data,topics:entry.topics as [Hex,...Hex[]]});return event.eventName==='SpendingPaused'&&event.args.runId===id&&event.args.revision===BigInt(revision)&&event.args.policyHash.toLowerCase()===policyHash.toLowerCase();}catch{return false;}
  });
}

export async function readVaultState(client:PublicClient,address:Address,chainId:number):Promise<VaultRead> {
  const [paused,balance,reportVersion]=await Promise.all([
    client.readContract({address,abi:vaultAbi,functionName:'paused'}),
    client.getBalance({address}),
    client.readContract({address,abi:vaultAbi,functionName:'reportVersion'}).then(Number).catch(()=>null),
  ]);
  return {address,chainId,paused,balanceWei:balance.toString(),reportVersion};
}

export async function fetchExchangeTrade():Promise<Observation> {
  const response=await fetch(PRICE_URL,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});
  if(!response.ok) throw new Error(`Price source unavailable (${response.status}); action blocked`);
  const price=parsePrice(await response.json());
  return {...sourceIdentity({type:'exchange-trade',pair:'ETH-USD'}),usd:price.usd,raw:price.raw,observedAt:price.observedAt,fetchedAt:new Date().toISOString()};
}

export interface LocalDeployment {address:string;forwarder:string;chainId:number;rpcUrl:string;blockNumber?:number}
const isLocalRpc=(url:string)=>/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url);
const localChain=(rpcUrl:string)=>defineChain({id:31337,name:'Anvil',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}});

export async function loadLocalDeployment():Promise<LocalDeployment> {
  return await Bun.file(resolve(import.meta.dir,'../contracts/deployment.local.json')).json();
}

/** Real transactions on an isolated localhost chain, through the explicitly named rehearsal forwarder. */
export function localEvmEnvironment(deployment:LocalDeployment,deps:{resolveFeed?:FeedResolver;fetchExchange?:ExchangeFetcher}={}):PolicyEnvironment {
  if(deployment.chainId!==31337||!isLocalRpc(deployment.rpcUrl)) throw new Error('Local rehearsal supports only isolated localhost Anvil (chain 31337)');
  const chain=localChain(deployment.rpcUrl);
  const client=createPublicClient({chain,transport:http(deployment.rpcUrl)}) as PublicClient;
  const address=deployment.address as Address;
  const guardChain=async()=>{if(await client.getChainId()!==31337) throw new Error('Refusing rehearsal action outside localhost development chain');};
  return {
    mode:'local-evm-rehearsal',
    async readVault(){await guardChain();return readVaultState(client,address,31337);},
    async readSource(source){
      if(source.type==='exchange-trade') return (deps.fetchExchange??fetchExchangeTrade)();
      if(!deps.resolveFeed) throw new Error(`Policy references ${describeSource(source)} but no feed resolver was supplied`);
      return deps.resolveFeed(source);
    },
    async referencePrice(symbol){
      if(!deps.resolveFeed) throw new Error('No feed resolver for a sell reference price');
      return deps.resolveFeed({type:'chainlink-feed',symbol:symbol as FeedSource['symbol'],network:'ethereum-mainnet'});
    },
    async alreadyProcessed(runId){return client.readContract({address,abi:vaultAbi,functionName:'processedRuns',args:[runIdHash(runId)]});},
    async deliverPause(report){
      await guardChain();
      const wallet=createWalletClient({account:privateKeyToAccount(LOCAL_DEV_KEY),chain,transport:http(deployment.rpcUrl)});
      const hash=await wallet.writeContract({address:deployment.forwarder as Address,abi:forwarderAbi,functionName:'deliver',args:[address,encodePauseReport(report)]});
      const receipt=await client.waitForTransactionReceipt({hash,timeout:30000});
      const pausedAfter=await client.readContract({address,abi:vaultAbi,functionName:'paused'});
      return {hash,blockNumber:Number(receipt.blockNumber),status:receipt.status,receiverConfirmed:matchPauseEvent(receipt.logs,address,report.runId,report.revision,report.policyHash),pausedAfter};
    },
  };
}

export interface RunnerDeps {resolveFeed?:FeedResolver;fetchExchange?:ExchangeFetcher;deployment?:LocalDeployment}
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
      ?await executeThroughCre(spec,onProgress)
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
  if(spec.graph.action.type!=='pause-vault') throw new Error('Simulated sells run only in local rehearsal; CRE delivers only pause-vault reports. Nothing was submitted.');
  const available=chains??await configuredCreChains();
  for(const source of collectSources(spec.graph)) {
    if(source.type!=='chainlink-feed') continue;
    const chain=NETWORKS[source.network].creChainName;
    if(!available.includes(chain)) throw new Error(`${describeSource(source)} needs an RPC for ${chain} in cre/project.yaml; CRE will not substitute another network. Nothing was submitted.`);
  }
  if(!available.includes(NETWORKS['ethereum-sepolia'].creChainName)) throw new Error('cre/project.yaml has no Sepolia RPC for the vault');
}
const creBinary=async()=>{
  const local=resolve(import.meta.dir,'bin/cre');
  if(await Bun.file(local).exists()) return local;
  const found=Bun.which('cre');
  if(!found) throw new Error('CRE CLI not found. Run bun run --cwd cre install:cli, then cre login.');
  return found;
};
async function executeThroughCre(spec:ExecutionSpecification,progress?:(message:string)=>void):Promise<ExecutionEvidence> {
  await assertCreSupports(spec);
  const vault=process.env.ORIGINS_SEPOLIA_VAULT;
  if(!vault||!/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error('CRE mode requires ORIGINS_SEPOLIA_VAULT (run scripts/deploy-sepolia.ts)');
  const root=resolve(import.meta.dir);
  const configPath=resolve(root,'workflow/config.runtime.json');
  await Bun.write(configPath,JSON.stringify({vaultAddress:vault,chainSelector:NETWORKS['ethereum-sepolia'].chainSelector,gasLimit:'350000'}));
  // The CLI authenticates itself from `cre login` or CRE_API_KEY; this process never reads those credentials.
  const args=[await creBinary(),'workflow','simulate','./workflow','--project-root',root,'--target','staging-settings','--non-interactive','--trigger-index','0','--http-payload',JSON.stringify(spec),'--config',configPath];
  if(spec.broadcast!==false) args.push('--broadcast');
  progress?.('CRE CLI compiling and executing the frozen HTTP-trigger specification');
  const proc=Bun.spawn(args,{cwd:root,env:{...process.env},stdout:'pipe',stderr:'pipe'});
  const timeout=setTimeout(()=>proc.kill(),240000);
  const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);clearTimeout(timeout);
  // Error output may echo key material; drop every secret and every 32-byte hex string.
  const redact=(text:string)=>{for(const secret of [process.env.CRE_API_KEY,process.env.CRE_ETH_PRIVATE_KEY]) if(secret) text=text.split(secret).join('[redacted]');return text.replace(/(0x)?[a-fA-F0-9]{64}/g,'[redacted]');};
  if(code!==0) throw new Error(`CRE execution failed (${code}): ${redact(stderr||stdout).slice(-1500)}`);
  const cleanOutput=stdout.replace(/\u001b\[[0-9;]*m/g,'');
  // Keep the last CLI transcript (secrets removed) for diagnosis.
  let transcript=cleanOutput;
  for(const secret of [process.env.CRE_API_KEY,process.env.CRE_ETH_PRIVATE_KEY]) if(secret) transcript=transcript.split(secret).join('[redacted]');
  await Bun.write(resolve(root,'../.data/cre-last-run.log'),transcript).catch(()=>{});
  let evidence:ExecutionEvidence;
  try {evidence=JSON.parse(joinEvidenceChunks(cleanOutput)) as ExecutionEvidence;}
  catch(error) {throw new Error(`${error instanceof Error?error.message:String(error)}; the CLI transcript is in .data/cre-last-run.log`);}
  if(evidence.runId!==spec.runId||evidence.revision!==spec.revision||evidence.policyHash!==spec.policyHash) throw new Error('CRE execution evidence correlation failed');
  evidence.logs=cleanOutput.split('\n').filter(line=>line.includes('ORIGINS_')&&!line.includes(EVIDENCE_CHUNK_TAG)).map(line=>line.slice(line.indexOf('ORIGINS_')));
  for(const message of evidence.logs) progress?.(message.length>240?`${message.slice(0,240)}…`:message);
  if(evidence.transaction?.hash) {
    const client=createPublicClient({chain:sepolia,transport:http(process.env.ORIGINS_SEPOLIA_RPC||'https://ethereum-sepolia-rpc.publicnode.com')});
    const receipt=await client.waitForTransactionReceipt({hash:evidence.transaction.hash as Hex,timeout:90000});
    const pausedAfter=await client.readContract({address:vault as Address,abi:vaultAbi,functionName:'paused'});
    const confirmed=matchPauseEvent(receipt.logs,vault,spec.runId,spec.revision,spec.policyHash);
    evidence.transaction={hash:evidence.transaction.hash,blockNumber:Number(receipt.blockNumber),status:receipt.status,receiverConfirmed:confirmed,pausedAfter};
    if(receipt.status!=='success'||!confirmed||!pausedAfter) throw new Error('CRE report lacks confirmed receipt, matching receiver event, or fresh paused() state');
  }
  return evidence;
}

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
    const event=vaultAbi.find(x=>x.type==='event'&&x.name==='SpendingPaused')!;
    const logs=await client.getLogs({address,event:event as any,args:{runId:id} as any,fromBlock:BigInt(deployment.blockNumber??0),toBlock:'latest'});
    const log=logs[0];
    return {landed:true,paused,...(log?{transactionHash:log.transactionHash!,blockNumber:Number(log.blockNumber)}:{})};
  } catch {
    // Some public RPCs cap log ranges; processedRuns alone still proves the report landed.
    return {landed:true,paused};
  }
}
