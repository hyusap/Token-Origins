import type {SolanaTransferReceipt} from '../shared/solana-types';
import {createPublicClient,createWalletClient,http,parseAbi,decodeEventLog,decodeErrorResult,encodeFunctionData,defineChain,type Address,type Hex,type PublicClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {sepolia} from 'viem/chains';
import {resolve} from 'node:path';
import {executionDeployment,creDeployment, SUPPORTED_TESTNETS} from './deployment';
import {testnetAccount} from './testnet-wallet';
import {specificationSchema,PRICE_URL,priceUrl,parsePrice,type ExecutionSpecification} from './spec';
import {joinEvidenceChunks,EVIDENCE_CHUNK_TAG} from './evidence-log';
import {
  evaluateGraph,collectSources,sourceKey,sourceIdentity,describeSource,readsVault,explainNoop,encodePauseReport,runIdHash,formatUsd,
  NETWORKS,REPORT_VERSION,type PriceSource,type FeedSource,type Observation,type ConditionEvidence,type PauseReport,type PriceReading,type PolicyAction,
} from './graph';

/** Supplied by the backend, which owns RPC access for each feed network. */
export type FeedResolver=(source:FeedSource)=>Promise<Observation>;
export type ExchangeFetcher=(source:Extract<PriceSource,{type:"exchange-trade"}>)=>Promise<Observation>;
export type ExecutionMode='cre-local-simulation'|'local-evm-rehearsal'|'fixture-rehearsal'|'testnet-evm'|'solana-devnet';
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
  action:PolicyAction['type'];
  noopReason?:string;
  decidedAt:string;
  dryRun?:boolean;
  transaction?:TransactionEvidence;
  solanaTransfer?:SolanaTransferReceipt & {genesisHash:string;verified:true};
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
  deliverSolanaTransfer?(action:Extract<PolicyAction,{type:'solana-transfer'}>,spec:ExecutionSpecification):Promise<NonNullable<ExecutionEvidence['solanaTransfer']>>;
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
  log(env.mode==='solana-devnet' ? 'Solana devnet · real System Program transfer · shared graph evaluator' : env.mode==='fixture-rehearsal'?'Fixture rehearsal · live inputs, in-memory vault, no transaction':'Local EVM rehearsal · shared graph evaluator · no CRE/DON claim');

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

  if(spec.broadcast===false) {evidence.dryRun=true;log('Policy passed; dry run, no report submitted');return evidence;}
  if(graph.action.type==='solana-transfer') {
    if(!env.deliverSolanaTransfer) throw new Error('This environment cannot execute a Solana transfer');
    log('Submitting immutable Solana devnet transfer');
    evidence.solanaTransfer=await env.deliverSolanaTransfer(graph.action,spec);
    const receipt=evidence.solanaTransfer;
    if(!receipt.verified||receipt.status!=='confirmed'||receipt.network!==graph.action.network||receipt.recipient!==graph.action.recipient||receipt.lamports!==graph.action.amountLamports) throw new Error('Solana receipt does not match the frozen action');
    log(`Confirmed Solana transfer ${receipt.signature} at slot ${receipt.slot}`);return evidence;
  }
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

export async function fetchExchangeTrade(source:Extract<PriceSource,{type:"exchange-trade"}>={type:"exchange-trade",pair:"ETH-USD"}):Promise<Observation> {
  const url=priceUrl(source.pair);
  const response=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});
  if(!response.ok) throw new Error(`Price source unavailable (${response.status}); action blocked`);
  const price=parsePrice(await response.json(),url);
  return {...sourceIdentity(source),usd:price.usd,raw:price.raw,observedAt:price.observedAt,fetchedAt:new Date().toISOString()};
}

export interface LocalDeployment {address:string;forwarder:string;chainId:number;rpcUrl:string;blockNumber?:number}
const isLocalRpc=(url:string)=>/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url);
const localChain=(rpcUrl:string)=>defineChain({id:31337,name:'Anvil',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}});

export async function loadLocalDeployment():Promise<LocalDeployment> {
  return executionDeployment();
}

/** Real transactions on an isolated localhost chain, through the explicitly named rehearsal forwarder. */
export function localEvmEnvironment(deployment:LocalDeployment,deps:{resolveFeed?:FeedResolver;fetchExchange?:ExchangeFetcher;onSubmission?:(hash:string)=>void}={}):PolicyEnvironment {
  const testnet=process.env.ORIGINS_EXECUTION_MODE==='testnet';
  if(testnet ? !SUPPORTED_TESTNETS[deployment.chainId] || isLocalRpc(deployment.rpcUrl) : deployment.chainId!==31337||!isLocalRpc(deployment.rpcUrl)) throw new Error('Execution deployment is outside the selected development/test network');
  const chain=testnet ? {...localChain(deployment.rpcUrl),id:deployment.chainId,name:SUPPORTED_TESTNETS[deployment.chainId]!.name} : localChain(deployment.rpcUrl);
  const client=createPublicClient({chain,transport:http(deployment.rpcUrl)}) as PublicClient;
  const address=deployment.address as Address;
  const guardChain=async()=>{if(await client.getChainId()!==deployment.chainId) throw new Error('Refusing rehearsal action outside localhost development chain');};
  return {
    mode:testnet ? 'testnet-evm' : 'local-evm-rehearsal',
    async readVault(){await guardChain();return readVaultState(client,address,deployment.chainId);},
    async readSource(source){
      if(source.type==='exchange-trade') return (deps.fetchExchange??fetchExchangeTrade)(source);
      if(!deps.resolveFeed) throw new Error(`Policy references ${describeSource(source)} but no feed resolver was supplied`);
      return deps.resolveFeed(source);
    },
    async referencePrice(symbol){
      if(!deps.resolveFeed) throw new Error('No feed resolver for a sell reference price');
      return deps.resolveFeed({type:'chainlink-feed',symbol:symbol as FeedSource['symbol'],network:'ethereum-mainnet'});
    },
    async alreadyProcessed(runId){return client.readContract({address,abi:vaultAbi,functionName:'processedRuns',args:[runIdHash(runId)]});},
    async deliverPause(report){
      if(!/^0x[0-9a-fA-F]{40}$/.test(deployment.forwarder))throw new Error('EVM report delivery requires a real configured forwarder');
      await guardChain();
      const wallet=createWalletClient({account:testnet ? await testnetAccount() : privateKeyToAccount(LOCAL_DEV_KEY),chain,transport:http(deployment.rpcUrl)});
      const hash=await wallet.writeContract({address:deployment.forwarder as Address,abi:forwarderAbi,functionName:'deliver',args:[address,encodePauseReport(report)]});
      deps.onSubmission?.(hash);
      const receipt=await client.waitForTransactionReceipt({hash,timeout:30000});
      const pausedAfter=await client.readContract({address,abi:vaultAbi,functionName:'paused'});
      return {hash,blockNumber:Number(receipt.blockNumber),status:receipt.status,receiverConfirmed:matchPauseEvent(receipt.logs,address,report.runId,report.revision,report.policyHash),pausedAfter};
    },
  };
}

export interface RunnerDeps {resolveFeed?:FeedResolver;fetchExchange?:ExchangeFetcher;deployment?:LocalDeployment}
let executionQueue:Promise<unknown>=Promise.resolve();
const active=new Map<string,{spec:string;promise:Promise<ExecutionEvidence>}>();
const completed=new Map<string,{spec:string;evidence:ExecutionEvidence}>();
/** Runs a frozen specification once per run ID in this process; the chain dedupes across processes. */
export async function executeCreRun(input:ExecutionSpecification,onProgress?:(message:string)=>void,deps:RunnerDeps={}):Promise<ExecutionEvidence> {
  return cachedExecution(input,'cre',onProgress,deps);
}
/** Explicit isolated research helper. Never selected by the product dispatcher. */
export async function executeRehearsalRun(input:ExecutionSpecification,onProgress?:(message:string)=>void,deps:RunnerDeps={}):Promise<ExecutionEvidence> {
  return cachedExecution(input,'research',onProgress,deps);
}
async function cachedExecution(input:ExecutionSpecification,authority:'cre'|'research',onProgress:((message:string)=>void)|undefined,deps:RunnerDeps):Promise<ExecutionEvidence> {
  const spec=Object.freeze(specificationSchema.parse(input));
  if(spec.graph.action.type!=='pause-vault') throw new Error('CRE/EVM runner only supports pause-vault; select the Solana dispatcher. Nothing was submitted.');
  const serialized=JSON.stringify(spec);
  const key=authority+':'+spec.runId;
  const existing=completed.get(key);
  if(existing) {if(existing.spec!==serialized) throw new Error('Run ID reused with different immutable specification');return structuredClone(existing.evidence);}
  const underway=active.get(key);
  if(underway) {if(underway.spec!==serialized) throw new Error('Running version is immutable');return underway.promise;}
  const work=executionQueue.then(async()=>{
    const result=authority==='cre'
      ?await executeThroughCre(spec,onProgress,deps.deployment)
      :await executePolicy(spec,localEvmEnvironment(deps.deployment??await loadLocalDeployment(),{...deps,onSubmission:hash=>onProgress?.("ORIGINS_SUBMITTED "+JSON.stringify({hash,runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash}))}),onProgress);
    completed.set(key,{spec:serialized,evidence:structuredClone(result)});return result;
  });
  executionQueue=work.catch(()=>{});
  active.set(key,{spec:serialized,promise:work});
  try{return await work;}finally{active.delete(key);}
}

/** Chain names this CRE project has RPCs for; a graph needing any other network is refused before simulation. */
export async function configuredCreChains(projectFile=resolve(import.meta.dir,'project.yaml')):Promise<string[]> {
  const text=await Bun.file(projectFile).text();
  return [...text.matchAll(/chain-name:\s*([a-z0-9-]+)/g)].map(m=>m[1]!);
}
/** Throws before any side effect when CRE cannot execute this graph as written. */
export async function assertCreSupports(spec:ExecutionSpecification,chains?:string[]) {
  if(spec.graph.action.type!=='pause-vault') throw new Error('CRE delivers only pause-vault reports; Solana actions require the Solana devnet dispatcher. Nothing was submitted.');
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
/** Machine progress carries durable transaction correlation; never clip its JSON payload. */
export function replayCreProgress(logs:readonly string[],progress?:(message:string)=>void):void {
  for(const message of logs) progress?.(message.startsWith('ORIGINS_')||message.length<=240?message:`${message.slice(0,240)}…`);
}
async function executeThroughCre(spec:ExecutionSpecification,progress?: (message:string)=>void,frozen?:LocalDeployment):Promise<ExecutionEvidence> {
  await assertCreSupports(spec);
  const configured=await creDeployment();
  if(frozen&&(frozen.chainId!==11155111||frozen.address.toLowerCase()!==configured.address.toLowerCase()||frozen.forwarder&&frozen.forwarder.toLowerCase()!==configured.forwarder.toLowerCase()))throw new Error('CRE receiver configuration differs from the frozen execution target; nothing was submitted');
  const vault=frozen?.address??configured.address;
  const root=resolve(import.meta.dir);
  const configPath=resolve(root,'workflow/config.runtime.json');
  // Covers the forwarder's bookkeeping plus the vault's storage writes under current Sepolia gas
  // pricing; 350k ran the receiver out of gas (traced OutOfGas at ~198k inside onReport).
  const gasLimit=process.env.ORIGINS_CRE_GAS_LIMIT||'2000000';
  if(!/^\d+$/.test(gasLimit)||Number(gasLimit)>10_000_000) throw new Error('ORIGINS_CRE_GAS_LIMIT must be a whole number up to the CRE limit of 10,000,000');
  await Bun.write(configPath,JSON.stringify({vaultAddress:vault,chainSelector:NETWORKS['ethereum-sepolia'].chainSelector,gasLimit}));
  // The CLI authenticates itself from `cre login` or CRE_API_KEY; this process never reads those credentials.
  const args=[await creBinary(),'workflow','simulate','./workflow','--project-root',root,'--target','staging-settings','--non-interactive','--trigger-index','0','--http-payload',JSON.stringify(spec),'--config',configPath];
  if(spec.broadcast!==false) args.push('--broadcast');
  progress?.('CRE CLI compiling and executing the frozen HTTP-trigger specification');
  const proc=Bun.spawn(args,{cwd:root,env:{...process.env},stdout:'pipe',stderr:'pipe'});
  const timeout=setTimeout(()=>proc.kill(),240000);
  const readOutput=async()=>{
    const reader=proc.stdout.getReader();const decoder=new TextDecoder();let output='',pending='';
    while(true){const {value,done}=await reader.read();if(done)break;const chunk=decoder.decode(value,{stream:true});output+=chunk;pending+=chunk;
      const lines=pending.split('\n');pending=lines.pop() || '';
      for(const line of lines){const start=line.indexOf('ORIGINS_SUBMITTED ');if(start>=0)progress?.(line.slice(start).replace(/\u001b\[[0-9;]*m/g,''));}
    }
    return output;
  };
  const [stdout,stderr,code]=await Promise.all([readOutput(),new Response(proc.stderr).text(),proc.exited]);clearTimeout(timeout);
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
  replayCreProgress(evidence.logs,progress);
  if(evidence.transaction?.hash) {
    const client=createPublicClient({chain:sepolia,transport:http(process.env.ORIGINS_SEPOLIA_RPC||'https://ethereum-sepolia-rpc.publicnode.com')});
    const receipt=await client.waitForTransactionReceipt({hash:evidence.transaction.hash as Hex,timeout:90000});
    const confirmed=matchPauseEvent(receipt.logs,vault,spec.runId,spec.revision,spec.policyHash);
    const pausedAfter=await pausedAt(client as PublicClient,vault as Address,receipt.blockNumber);
    evidence.transaction={hash:evidence.transaction.hash,blockNumber:Number(receipt.blockNumber),status:receipt.status,receiverConfirmed:confirmed,pausedAfter};
    const failed=[receipt.status!=='success'&&`receipt status ${receipt.status}`,!confirmed&&'no SpendingPaused event matching this run, revision and policy hash',!pausedAfter&&'vault not paused at the receipt block'].filter(Boolean);
    if(failed.length) {
      const notes=await diagnosePause(client as PublicClient,vault as Address,receipt,spec,evidence).catch(error=>[`diagnosis unavailable: ${error instanceof Error?error.message:String(error)}`]);
      await Bun.write(resolve(root,'../.data/cre-last-run.log'),`${transcript}\n\nVERIFICATION FAILED: ${failed.join('; ')}\n${notes.join('\n')}\n`).catch(()=>{});
      throw new Error(`CRE report did not verify (${failed.join('; ')}).\n  ${notes.join('\n  ')}\n  ${NETWORKS['ethereum-sepolia'].explorer}/tx/${receipt.transactionHash}`);
    }
  }
  return evidence;
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
]);
const revertData=(error:any):Hex|undefined=>{
  for(let e=error;e;e=e.cause) {
    if(typeof e.data==='string'&&e.data.startsWith('0x')) return e.data as Hex;
    if(typeof e.data?.data==='string') return e.data.data as Hex;
  }
  return undefined;
};

/**
 * Explains a pause that did not verify: what the receipt holds, which
 * forwarder sent it versus the one the vault trusts, and what the vault says
 * when this exact report is replayed against chain state just before it.
 */
export async function diagnosePause(client:PublicClient,vault:Address,receipt:{transactionHash:string;status:string;blockNumber:bigint;to:string|null;logs:readonly {address:string;data:Hex;topics:readonly Hex[]}[]},spec:ExecutionSpecification,evidence:ExecutionEvidence):Promise<string[]> {
  const notes=[`transaction status ${receipt.status} in block ${receipt.blockNumber}, sent to ${receipt.to}`];
  const fromVault=receipt.logs.filter(log=>log.address.toLowerCase()===vault.toLowerCase());
  notes.push(`${receipt.logs.length} log(s) from ${[...new Set(receipt.logs.map(log=>log.address))].join(', ')||'nobody'}; ${fromVault.length} from the vault`);
  for(const log of fromVault) {
    try {const event=decodeEventLog({abi:vaultAbi,data:log.data,topics:log.topics as [Hex,...Hex[]]});notes.push(`vault emitted ${event.eventName} ${JSON.stringify(event.args,(_,v)=>typeof v==='bigint'?v.toString():v)}`);}
    catch {notes.push('vault emitted an event this runner does not recognise');}
  }
  const trusted=await client.readContract({address:vault,abi:diagnosticAbi,functionName:'forwarder'});
  notes.push(`vault trusts forwarder ${trusted}${receipt.to&&receipt.to.toLowerCase()!==trusted.toLowerCase()?` — but the CRE transaction went to ${receipt.to}; redeploy with ORIGINS_SEPOLIA_FORWARDER=${receipt.to}`:''}`);
  const report=encodePauseReport({target:vault,chainId:NETWORKS['ethereum-sepolia'].chainId,runId:spec.runId,revision:spec.revision,policyHash:spec.policyHash as Hex,decidedAt:Math.floor(Date.parse(evidence.decidedAt)/1000)});
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

/**
 * After a restart, decides what happened to a submission whose outcome was
 * unknown, from the chain alone. Never resubmits.
 */
export async function findSubmittedPause(runId:string,deployment:{address:string;chainId:number;rpcUrl:string;blockNumber?:number},expected?:{revision:number;policyHash:string},submittedHash?:string):Promise<{landed:boolean;transactionHash?:string;blockNumber?:number;paused:boolean;balanceWei?:string;decidedAt?:string;submissionSettled?:boolean}> {
  const client=createPublicClient({transport:http(deployment.rpcUrl,{timeout:10000})}) as PublicClient;
  if(await client.getChainId()!==deployment.chainId) throw new Error('RPC chain does not match the vault deployment');
  const address=deployment.address as Address;
  const id=runIdHash(runId);
  const [landed,paused]=await Promise.all([
    client.readContract({address,abi:vaultAbi,functionName:'processedRuns',args:[id]}),
    client.readContract({address,abi:vaultAbi,functionName:'paused'}),
  ]);
  let knownReceipt: Awaited<ReturnType<typeof client.getTransactionReceipt>> | undefined;
  if(submittedHash && /^0x[a-fA-F0-9]{64}$/.test(submittedHash)) {
    try {knownReceipt=await client.getTransactionReceipt({hash:submittedHash as Hex});} catch { /* Pending or unavailable stays uncertain. */ }
    if(knownReceipt) {
      const trusted=await client.readContract({address,abi:parseAbi(['function forwarder() view returns (address)']),functionName:'forwarder'});
      if(knownReceipt.to?.toLowerCase()!==trusted.toLowerCase()) throw new Error('Recorded submission did not target the receiver trusted forwarder');
      if(knownReceipt.status!=='success' || (expected && !matchPauseEvent(knownReceipt.logs,address,runId,expected.revision,expected.policyHash)))
        return {landed,paused,submissionSettled:true};
    }
  }
  if(!landed) return {landed:false,paused};
  try {
    const event=vaultAbi.find(x=>x.type==='event'&&x.name==='SpendingPaused')!;
    const logs=await client.getLogs({address,event:event as any,args:{runId:id} as any,fromBlock:BigInt(deployment.blockNumber??0),toBlock:'latest'});
    const log=logs[0];
    if(!log) return {landed:true,paused};
    const receipt=await client.getTransactionReceipt({hash:log.transactionHash!});
    if(expected && !matchPauseEvent(receipt.logs,address,runId,expected.revision,expected.policyHash)) throw new Error('Recovered event does not match this execution revision and policy hash');
    const pausedAfter=await pausedAt(client,address,receipt.blockNumber);
    if(receipt.status!=='success'||!pausedAfter) throw new Error('Recovered pause receipt or receipt-block vault state did not verify');
    const balance=await client.getBalance({address,blockNumber:receipt.blockNumber});
    const recoveredEvent=receipt.logs.filter(entry=>entry.address.toLowerCase()===address.toLowerCase()).map(entry=>{try{return decodeEventLog({abi:vaultAbi,data:entry.data,topics:entry.topics as [Hex,...Hex[]]});}catch{return null;}}).find(event=>event?.eventName==='SpendingPaused' && event.args.runId===id);
    const decidedAt=recoveredEvent?.eventName==='SpendingPaused' ? new Date(Number(recoveredEvent.args.decidedAt)*1000).toISOString() : undefined;
    return {landed:true,paused:pausedAfter,transactionHash:log.transactionHash!,blockNumber:Number(log.blockNumber),balanceWei:balance.toString(),decidedAt};
  } catch(error) {
    if(expected) throw error;
    return {landed:true,paused};
  }

}
