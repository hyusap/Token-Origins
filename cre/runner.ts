import {createPublicClient,createWalletClient,http,parseAbi,encodeAbiParameters,parseAbiParameters,keccak256,toBytes,decodeEventLog,type Address,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {foundry,sepolia} from 'viem/chains';
import {resolve} from 'node:path';
import {specificationSchema,PRICE_URL,parsePrice,evaluate,type ExecutionSpecification,type PriceObservation,type ConditionEvidence} from './spec';
export type ExecutionEvidence={runId:string;revision:number;mode:'cre-local-simulation'|'local-evm-rehearsal';price:PriceObservation;vault:{address:string;chainId:number;balanceWei:string;paused:boolean};conditions:ConditionEvidence[];decision:'pause'|'noop';transaction?:{hash:string;blockNumber:number;status:string;receiverConfirmed:boolean;pausedAfter:boolean};logs:string[]};
const vaultAbi=parseAbi(['function paused() view returns (bool)','function processedRuns(bytes32) view returns (bool)','event SpendingPaused(bytes32 indexed runId,uint256 indexed revision,uint256 priceUsdCents,uint256 thresholdUsdCents,uint256 observedAt)']);
const forwarderAbi=parseAbi(['function deliver(address receiver,bytes report)']);
// Public Anvil development key; deliberately accepted only when chain ID is 31337.
const LOCAL_DEV_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const active=new Map<string,{spec:string;promise:Promise<ExecutionEvidence>}>();
const completed=new Map<string,{spec:string;evidence:ExecutionEvidence}>();
export async function executeCreRun(input:ExecutionSpecification,onProgress?:(message:string)=>void):Promise<ExecutionEvidence> {
  const spec=Object.freeze(specificationSchema.parse(input));
  const serialized=JSON.stringify(spec);
  const existing=completed.get(spec.runId);
  if(existing) {if(existing.spec!==serialized) throw new Error('Run ID reused with different immutable specification');return structuredClone(existing.evidence);}
  const underway=active.get(spec.runId);
  if(underway) {if(underway.spec!==serialized) throw new Error('Running version is immutable');return underway.promise;}
  const work=(async()=>{
    const mode=process.env.ORIGINS_EXECUTION_MODE==='cre'?'cre-local-simulation':'local-evm-rehearsal';
    const result=mode==='cre-local-simulation'?await executeThroughCre(spec,onProgress):await executeLocalRehearsal(spec,onProgress);
    completed.set(spec.runId,{spec:serialized,evidence:structuredClone(result)});return result;
  })();
  active.set(spec.runId,{spec:serialized,promise:work});
  try{return await work;}finally{active.delete(spec.runId);}
}
async function executeLocalRehearsal(spec:ExecutionSpecification,progress?:(message:string)=>void):Promise<ExecutionEvidence> {
  const logs:string[]=[];
  const log=(text:string)=>{logs.push(text);progress?.(text);};
  log('Local EVM rehearsal · isolated evaluator · no CRE/DON claim');
  const deployment=await Bun.file(resolve(import.meta.dir,'../contracts/deployment.local.json')).json();
  if(deployment.chainId!==31337||deployment.rpcUrl!=='http://127.0.0.1:8545') throw new Error('Local rehearsal supports only isolated localhost Anvil');
  const client=createPublicClient({chain:foundry,transport:http(deployment.rpcUrl)});
  if(await client.getChainId()!==31337) throw new Error('Refusing rehearsal action outside localhost development chain');
  log('Fetching fresh Coinbase ETH/USD ticker with source trade timestamp');
  const response=await fetch(PRICE_URL,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});
  if(!response.ok) throw new Error(`Price source unavailable (${response.status}); action blocked`);
  const price=parsePrice(await response.json());
  const address=deployment.address as Address;
  const [paused,balance]=await Promise.all([client.readContract({address,abi:vaultAbi,functionName:'paused'}),client.getBalance({address})]);
  log('Read vault state and balance directly from local EVM');
  const conditions=evaluate(spec,price,paused,Date.now());
  const evidence:ExecutionEvidence={runId:spec.runId,revision:spec.revision,mode:'local-evm-rehearsal',price,vault:{address,chainId:31337,balanceWei:balance.toString(),paused},conditions,decision:conditions.every(c=>c.passed)?'pause':'noop',logs};
  for(const c of conditions) log(`${c.passed?'PASS':'STOP'} ${c.kind}: ${c.detail}`);
  if(evidence.decision==='noop'){log('No report sent');return evidence;}
  if(spec.broadcast===false){log('All conditions passed; explicit dry run, no transaction submitted');return evidence;}
  const runId=keccak256(toBytes(spec.runId));
  if(await client.readContract({address,abi:vaultAbi,functionName:'processedRuns',args:[runId]})) {evidence.decision='noop';log('Run already processed on chain; replay suppressed');return evidence;}
  const report=encodeAbiParameters(parseAbiParameters('bytes32,uint256,uint256,uint256,uint256'),[runId,BigInt(spec.revision),BigInt(Math.round(price.usd*100)),BigInt(Math.round(spec.thresholdUsd*100)),BigInt(Math.floor(Date.parse(price.observedAt)/1000))]);
  const wallet=createWalletClient({account:privateKeyToAccount(LOCAL_DEV_KEY),chain:foundry,transport:http(deployment.rpcUrl)});
  log('Delivering ABI report through localhost rehearsal forwarder');
  const hash=await wallet.writeContract({address:deployment.forwarder,abi:forwarderAbi,functionName:'deliver',args:[address,report]});
  const receipt=await client.waitForTransactionReceipt({hash,timeout:30000});
  const pausedAfter=await client.readContract({address,abi:vaultAbi,functionName:'paused'});
  const receiverConfirmed=receipt.logs.some(entry=>{if(entry.address.toLowerCase()!==address.toLowerCase())return false;try{const event=decodeEventLog({abi:vaultAbi,data:entry.data,topics:entry.topics});return event.eventName==='SpendingPaused'&&event.args.runId===runId&&event.args.revision===BigInt(spec.revision);}catch{return false;}});
  evidence.transaction={hash,blockNumber:Number(receipt.blockNumber),status:receipt.status,receiverConfirmed,pausedAfter};
  if(receipt.status!=='success'||!receiverConfirmed||!pausedAfter) throw new Error('Transaction, receiver event, and fresh pause read did not all confirm');
  log(`Confirmed receipt + SpendingPaused event + fresh paused() read at block ${receipt.blockNumber}`);
  return evidence;
}
async function executeThroughCre(spec:ExecutionSpecification,progress?:(message:string)=>void):Promise<ExecutionEvidence> {
  if(!process.env.CRE_API_KEY) throw new Error('CRE mode requires an explicitly supplied fresh CRE_API_KEY. Existing desktop credentials are never inspected.');
  if(!process.env.ORIGINS_SEPOLIA_VAULT) throw new Error('CRE mode requires deployed Sepolia vault configuration');
  const root=resolve(import.meta.dir);
  const configPath=resolve(root,'workflow/config.runtime.json');
  await Bun.write(configPath,JSON.stringify({vaultAddress:process.env.ORIGINS_SEPOLIA_VAULT,chainSelector:'16015286601757825753',gasLimit:'350000'}));
  const args=[resolve(root,'bin/cre'),'workflow','simulate','./workflow','--project-root',root,'--target','staging-settings','--non-interactive','--trigger-index','0','--http-payload',JSON.stringify(spec),'--config',configPath];
  if(spec.broadcast!==false) args.push('--broadcast');
  progress?.('CRE CLI compiling and executing frozen HTTP-trigger specification');
  const proc=Bun.spawn(args,{cwd:root,env:{...process.env},stdout:'pipe',stderr:'pipe'});
  const timeout=setTimeout(()=>proc.kill(),120000);
  const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);clearTimeout(timeout);
  if(code!==0) {
    let safeError=stderr;
    for(const secret of [process.env.CRE_API_KEY,process.env.CRE_ETH_PRIVATE_KEY]) if(secret) safeError=safeError.split(secret).join('[redacted]');
    throw new Error(`CRE execution failed (${code}): ${safeError.replace(/0x[a-fA-F0-9]{64}/g,'[redacted]').slice(-1500)}`);
  }
  const cleanOutput=stdout.replace(/\u001b\[[0-9;]*m/g,'');
  const line=cleanOutput.split('\n').reverse().find(line=>line.includes('ORIGINS_EVIDENCE '));
  if(!line) throw new Error('CRE returned no correlated structured execution evidence');
  const evidence=JSON.parse(line.slice(line.indexOf('ORIGINS_EVIDENCE ')+17)) as ExecutionEvidence;
  if(evidence.runId!==spec.runId||evidence.revision!==spec.revision) throw new Error('CRE execution evidence correlation failed');
  evidence.logs=stdout.split('\n').filter(line=>line.includes('ORIGINS_'));
  if(evidence.transaction?.hash) {
    const client=createPublicClient({chain:sepolia,transport:http(process.env.ORIGINS_SEPOLIA_RPC||'https://ethereum-sepolia-rpc.publicnode.com')});
    const receipt=await client.waitForTransactionReceipt({hash:evidence.transaction.hash as Hex,timeout:60000});
    const pausedAfter=await client.readContract({address:process.env.ORIGINS_SEPOLIA_VAULT as Address,abi:vaultAbi,functionName:'paused'});
    const id=keccak256(toBytes(spec.runId));
    const confirmed=receipt.logs.some(entry=>{try{const event=decodeEventLog({abi:vaultAbi,data:entry.data,topics:entry.topics});return entry.address.toLowerCase()===process.env.ORIGINS_SEPOLIA_VAULT!.toLowerCase()&&event.eventName==='SpendingPaused'&&event.args.runId===id;}catch{return false;}});
    evidence.transaction={hash:evidence.transaction.hash,blockNumber:Number(receipt.blockNumber),status:receipt.status,receiverConfirmed:confirmed,pausedAfter};
    if(receipt.status!=='success'||!confirmed||!pausedAfter) throw new Error('CRE report lacks confirmed receipt, receiver event, or fresh paused() state');
  }
  return evidence;
}
