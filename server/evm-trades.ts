import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseEventLogs, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { FrozenTradeVenue } from './evm-trade-watch';

export type EvmTradeNetwork = 'local' | 'sepolia' | 'base-sepolia' | 'monad-testnet' | 'ethereum';
export const EVM_TRADE_CHAINS: Record<EvmTradeNetwork, number> = {local:31337,sepolia:11155111,'base-sepolia':84532,'monad-testnet':10143,ethereum:1};
export interface EvmTradeVenue {
  id: string; label: string; network: EvmTradeNetwork; rpcUrl: string;
  router: Address; factory: Address; pair: Address; token0: Address; token1: Address;
  routerCodeHash: Hex; factoryCodeHash: Hex; pairCodeHash: Hex;
  /** A code allowlist is an identity check; only an independently vetted venue belongs here. */
  provenance: string;
}
export interface EvmSwapInput { network: EvmTradeNetwork; venueId: string; wallet: string; transactionHash: string }
export interface EvmCopyQuoteInput extends EvmSwapInput { proportionBps: number; maxAmountIn: string; slippageBps: number }
export interface EvmCopyInput extends EvmSwapInput { operationId: string; proportionBps: number; maxAmountIn: string; minAmountOut: string; deadlineSeconds?: number }
export interface EvmSwapObservation {
  kind: 'confirmed-uniswap-v2-swap'; network: EvmTradeNetwork; chainId: number; venueId: string;
  wallet: Address; transactionHash: Hex; blockNumber: string; blockHash: Hex; logIndex: number;
  router: Address; pair: Address; tokenIn: Address; tokenOut: Address; amountIn: string; amountOut: string;
  tokenInDecimals: number; tokenOutDecimals: number; observedAt: string; confirmations: string;
}
export interface EvmCopyReceipt {
  kind: 'confirmed-evm-copy-swap'; network: EvmTradeNetwork; chainId: number; venueId: string;
  operationId: string; source: EvmSwapObservation; signer: Address; transactionHash: Hex;
  approvalTransactionHashes: Hex[]; blockNumber: string; blockHash: Hex; logIndex: number;
  tokenIn: Address; tokenOut: Address; amountIn: string; amountOut: string; minAmountOut: string;
  inputBalanceBefore: string; inputBalanceAfter: string; outputBalanceBefore: string; outputBalanceAfter: string;
  replayed: boolean; explorerUrl: string | null; verifiedAt: string;
}
const routerAbi = parseAbi([
  'function factory() view returns(address)',
  'function swapExactTokensForTokens(uint amountIn,uint amountOutMin,address[] path,address to,uint deadline) returns(uint[] amounts)',
  'function getAmountsOut(uint amountIn,address[] path) view returns(uint[] amounts)',
]);
const factoryAbi = parseAbi(['function getPair(address,address) view returns(address)']);
const pairAbi = parseAbi([
  'function token0() view returns(address)','function token1() view returns(address)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
]);
const erc20Abi = parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function decimals() view returns(uint8)']);
const addr = (value:string) => getAddress(value);
const same = (a:string,b:string) => a.toLowerCase()===b.toLowerCase();
function hash(value:string): Hex { if(!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid transaction hash');return value.toLowerCase() as Hex; }
export function tradeUint(value:string, name='amount'): bigint { if(typeof value!=='string'||! /^(?:0|[1-9]\d{0,77})$/.test(value))throw new Error(`${name} must be a raw integer token amount`);const n=BigInt(value);if(n<1n||n>2n**256n-1n)throw new Error(`${name} must be positive uint256`);return n; }
function proportion(value:number) { if(!Number.isInteger(value)||value<1||value>10000) throw new Error('proportionBps must be an integer from 1 to 10000');return BigInt(value); }
function explorer(network:EvmTradeNetwork,tx:string) {const base={ethereum:'https://etherscan.io',sepolia:'https://sepolia.etherscan.io','base-sepolia':'https://sepolia.basescan.org','monad-testnet':'https://testnet.monadexplorer.com',local:null}[network];return base?`${base}/tx/${tx}`:null;}
interface SignedStep { raw: Hex; hash: Hex; status?: 'confirmed'; submissionAttempted?:boolean }
interface Plan {
  venue: EvmTradeVenue; signer: Address; source: EvmSwapObservation; amountIn: string; minAmountOut: string;
  deadlineSeconds: number; inputBalanceBefore: string; outputBalanceBefore: string;
  approvals: SignedStep[]; swap?: SignedStep; deadline?: string;
}
interface Journal { fingerprint:string; plan:string; receipt:string|null; terminalError:string|null }
class DefinitiveTradeFailure extends Error {}
class UnsupportedLeaderSwap extends Error {}

/** Bounded genuine swaps at explicitly identified V2 venues. Ethereum is read-only.
 * The raw signed bytes for every approval and swap survive response loss/restarts.
 * No receipt or balance is fabricated; reconciliation never broadcasts anything.
 */
export class EvmTradeUtilities {
  private db?:Database;
  private pending = new Map<string, {fingerprint:string; promise:Promise<EvmCopyReceipt>}>();
  constructor(private options:{dataDir?:string;venues?:EvmTradeVenue[];privateKey?:Hex;receiptTimeoutMs?:number}={}) {}
  private get dataDir() {return this.options.dataDir||process.env.ORIGINS_EVM_TRADE_DATA_DIR||'.data/evm-trades';}
  private database() {
    if(!this.db) {mkdirSync(this.dataDir,{recursive:true});this.db=new Database(join(this.dataDir,'journal.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS swaps(operationId TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,plan TEXT NOT NULL,receipt TEXT,terminalError TEXT); CREATE TABLE IF NOT EXISTS writer_lock(id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL);');}
    return this.db;
  }
  private venues():EvmTradeVenue[] {
    if(this.options.venues)return this.options.venues;
    const file=process.env.ORIGINS_EVM_TRADE_VENUES_FILE||join(this.dataDir,'venues.json');
    if(!existsSync(file))return [];
    const value=JSON.parse(readFileSync(file,'utf8'));
    if(!Array.isArray(value))throw new Error('EVM trade venue registry must be an array');return value;
  }
  listVenues() {return this.venues().map(v=>({id:v.id,label:v.label,network:v.network,chainId:EVM_TRADE_CHAINS[v.network],router:v.router,factory:v.factory,pair:v.pair,token0:v.token0,token1:v.token1,routerCodeHash:v.routerCodeHash,factoryCodeHash:v.factoryCodeHash,pairCodeHash:v.pairCodeHash,provenance:v.provenance,signingEnabled:v.network!=='ethereum',amountUnit:'raw-token-integer',supportedSwap:'single-hop swapExactTokensForTokens',quoteSafety:'Current pool quote; not an independent price oracle'}));}
  private venue(network:EvmTradeNetwork,id:string) {
    if(!Object.hasOwn(EVM_TRADE_CHAINS,network))throw new Error('Unsupported EVM trade network');
    const found=this.venues().filter(v=>v.id===id&&v.network===network);
    if(found.length!==1)throw new Error('No unique allowlisted venue for this network and venueId');
    const v=found[0];for(const a of [v.router,v.factory,v.pair,v.token0,v.token1])addr(a);
    for(const h of [v.routerCodeHash,v.factoryCodeHash,v.pairCodeHash])hash(h);
    const rpc=new URL(v.rpcUrl);if(network==='local'&&!['127.0.0.1','localhost','[::1]'].includes(rpc.hostname))throw new Error('Local signing requires a loopback RPC');
    if(!['http:','https:'].includes(rpc.protocol))throw new Error('Invalid RPC protocol');
    if(same(v.token0,v.token1)||!v.provenance)throw new Error('Invalid venue provenance/tokens');return v;
  }
  private transport(rpcUrl:string) {
    const base=http(rpcUrl,{timeout:12000,retryCount:1});
    return ((options:Parameters<typeof base>[0])=>{const t=base(options),request=t.request;return {...t,request:(async(args:Parameters<typeof request>[0])=>{
      try{return await request(args);}catch(error){const e=error as {shortMessage?:string;message?:string};const message=(e.shortMessage||e.message||String(error)).replaceAll(rpcUrl,'[configured RPC]').replace(/https?:\/\/[^\s"'<>]+/g,'[RPC endpoint]');throw new Error(`EVM RPC ${args.method}: ${message}`);}
    }) as typeof request};});
  }
  private client(v:EvmTradeVenue) {return createPublicClient({transport:this.transport(v.rpcUrl)});}
  private async checked(v:EvmTradeVenue) {
    const p=this.client(v);if(await p.getChainId()!==EVM_TRADE_CHAINS[v.network])throw new Error('Trade RPC chain identity does not match venue');
    const head=await p.getBlock();
    const [router,factory,pair,rf,fp,t0,t1]=await Promise.all([
      p.getCode({address:v.router,blockNumber:head.number}),p.getCode({address:v.factory,blockNumber:head.number}),p.getCode({address:v.pair,blockNumber:head.number}),
      p.readContract({address:v.router,abi:routerAbi,functionName:'factory',blockNumber:head.number}),
      p.readContract({address:v.factory,abi:factoryAbi,functionName:'getPair',args:[v.token0,v.token1],blockNumber:head.number}),
      p.readContract({address:v.pair,abi:pairAbi,functionName:'token0',blockNumber:head.number}),p.readContract({address:v.pair,abi:pairAbi,functionName:'token1',blockNumber:head.number})]);
    if(!router||!factory||!pair||keccak256(router)!==v.routerCodeHash||keccak256(factory)!==v.factoryCodeHash||keccak256(pair)!==v.pairCodeHash||!same(rf,v.factory)||!same(fp,v.pair)||!same(t0,v.token0)||!same(t1,v.token1))throw new Error('Allowlisted venue code/factory/pair identity changed');
    return {p,head};
  }
  private account(network:EvmTradeNetwork) {
    if(!Object.hasOwn(EVM_TRADE_CHAINS,network))throw new Error('Unsupported EVM trade network');
    if(network==='ethereum')throw new Error('Ethereum mainnet signing is disabled');
    mkdirSync(this.dataDir,{recursive:true});const file=join(this.dataDir,`wallet.${network}.json`);
    let key=this.options.privateKey;
    if(!key){if(existsSync(file))key=JSON.parse(readFileSync(file,'utf8')).privateKey;else{key=generatePrivateKey();writeFileSync(file,JSON.stringify({network,privateKey:key,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});}}
    return privateKeyToAccount(key!);
  }
  async getWallet(network:EvmTradeNetwork) {
    const account=this.account(network);const venues=this.venues().filter(v=>v.network===network);
    const balances=[];for(const v of venues){const {p}=await this.checked(v);balances.push({venueId:v.id,nativeBalanceWei:(await p.getBalance({address:account.address})).toString(),tokens:await Promise.all([v.token0,v.token1].map(async token=>({address:token,balance:(await p.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[account.address]})).toString(),decimals:await p.readContract({address:token,abi:erc20Abi,functionName:'decimals'})})))});}
    return {network,chainId:EVM_TRADE_CHAINS[network],address:account.address,taskWallet:true,signingEnabled:true,balances};
  }
  async freezeVenue(input:{network:string;venueId:string}):Promise<FrozenTradeVenue> {
    const v=this.venue(input.network as EvmTradeNetwork,input.venueId),signer=this.account(v.network).address;const {p,head}=await this.checked(v);const genesis=await p.getBlock({blockNumber:0n});
    return {network:v.network,venueId:v.id,chainId:EVM_TRADE_CHAINS[v.network],genesisHash:genesis.hash,signer:signer.toLowerCase(),router:v.router.toLowerCase(),factory:v.factory.toLowerCase(),pair:v.pair.toLowerCase(),token0:v.token0.toLowerCase(),token1:v.token1.toLowerCase(),routerCodeHash:v.routerCodeHash,factoryCodeHash:v.factoryCodeHash,pairCodeHash:v.pairCodeHash,headBlock:head.number.toString(),headBlockHash:head.hash};
  }
  private async verifyFrozen(frozen:FrozenTradeVenue) {
    const fresh=await this.freezeVenue({network:frozen.network,venueId:frozen.venueId});
    for(const key of ['network','venueId','chainId','genesisHash','signer','router','factory','pair','token0','token1','routerCodeHash','factoryCodeHash','pairCodeHash'] as const)if(fresh[key]!==frozen[key])throw new Error(`Frozen trade venue changed: ${key}`);
    return {v:this.venue(frozen.network as EvmTradeNetwork,frozen.venueId),fresh};
  }
  async confirmedHead(frozen:FrozenTradeVenue) {const {fresh}=await this.verifyFrozen(frozen);return (BigInt(fresh.headBlock)-(frozen.network==='local'?0n:2n)).toString();}
  async blockHash(frozen:FrozenTradeVenue,blockNumber:string) {if(!/^\d+$/.test(blockNumber))throw new Error('Block must be an integer string');const {v}=await this.verifyFrozen(frozen);return (await this.client(v).getBlock({blockNumber:BigInt(blockNumber)})).hash;}
  async inspectSwap(input:EvmSwapInput):Promise<EvmSwapObservation> {
    const v=this.venue(input.network,input.venueId),watched=addr(input.wallet),txHash=hash(input.transactionHash);const {p,head}=await this.checked(v);
    const [tx,receipt]=await Promise.all([p.getTransaction({hash:txHash}),p.getTransactionReceipt({hash:txHash})]);
    if(receipt.status!=='success'||!same(tx.from,watched)||!tx.to||!same(tx.to,v.router)||tx.value!==0n)throw new UnsupportedLeaderSwap('Source must be a successful watched-wallet token swap directly through the allowlisted router');
    const block=await p.getBlock({blockNumber:receipt.blockNumber});if(block.hash!==receipt.blockHash||tx.blockHash!==block.hash)throw new Error('Source swap is not canonical');
    const required=input.network==='local'?1n:3n;const confirmations=head.number-receipt.blockNumber+1n;if(confirmations<required)throw new Error(`Source needs ${required} confirmations`);
    let decoded:ReturnType<typeof decodeFunctionData<typeof routerAbi>>;try{decoded=decodeFunctionData({abi:routerAbi,data:tx.input});}catch{throw new UnsupportedLeaderSwap('Source calldata is not a supported router method');}if(decoded.functionName!=='swapExactTokensForTokens')throw new UnsupportedLeaderSwap('Only exact-input single-hop token swaps can be copied');
    const [amountIn,minOut,path,to]=decoded.args;if(path.length!==2||!same(to,watched)||!((same(path[0],v.token0)&&same(path[1],v.token1))||(same(path[0],v.token1)&&same(path[1],v.token0))))throw new UnsupportedLeaderSwap('Source path or recipient does not match the watched wallet and allowlisted pool');
    const logs=parseEventLogs({abi:pairAbi,eventName:'Swap',logs:receipt.logs.filter(l=>same(l.address,v.pair)),strict:true});if(logs.length!==1)throw new UnsupportedLeaderSwap('Expected exactly one correlated pool Swap event');
    const log=logs[0],a=log.args;const forward=same(path[0],v.token0);const actualIn=forward?a.amount0In:a.amount1In,actualOut=forward?a.amount1Out:a.amount0Out;
    if(!same(a.sender,v.router)||!same(a.to,watched)||actualIn!==amountIn||actualOut<minOut||actualOut<=0n||(forward?a.amount1In:a.amount0In)!==0n||(forward?a.amount0Out:a.amount1Out)!==0n)throw new UnsupportedLeaderSwap('Source Swap event disagrees with exact input, output, direction or recipient');
    const [tokenInDecimals,tokenOutDecimals]=await Promise.all(path.map(address=>p.readContract({address,abi:erc20Abi,functionName:'decimals',blockNumber:receipt.blockNumber})));
    return {kind:'confirmed-uniswap-v2-swap',network:input.network,chainId:EVM_TRADE_CHAINS[input.network],venueId:v.id,wallet:watched,transactionHash:txHash,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,logIndex:log.logIndex!,router:v.router,pair:v.pair,tokenIn:addr(path[0]),tokenOut:addr(path[1]),amountIn:actualIn.toString(),amountOut:actualOut.toString(),tokenInDecimals,tokenOutDecimals,observedAt:new Date().toISOString(),confirmations:confirmations.toString()};
  }
  async inspectWalletSwaps(input:{network:EvmTradeNetwork;venueId:string;wallet:string;fromBlock?:string;toBlock?:string}) {
    const v=this.venue(input.network,input.venueId);addr(input.wallet);if(input.fromBlock&&!/^\d+$/.test(input.fromBlock)||input.toBlock&&!/^\d+$/.test(input.toBlock))throw new Error('Blocks must be integer strings');const {p,head}=await this.checked(v);
    const to=input.toBlock?BigInt(input.toBlock):head.number-(input.network==='local'?0n:2n),from=input.fromBlock?BigInt(input.fromBlock):(to>1000n?to-1000n:0n);if(to<from)return {swaps:[],fromBlock:from.toString(),toBlock:to.toString(),headBlockNumber:head.number.toString(),headBlockHash:head.hash};if(to>head.number||to-from>1000n)throw new Error('Wallet scan is bounded to 1000 confirmed blocks');
    const logs=await p.getLogs({address:v.pair,event:pairAbi[2],fromBlock:from,toBlock:to});const swaps:EvmSwapObservation[]=[];
    for(const h of [...new Set(logs.map(l=>l.transactionHash))]){if(!h)continue;const tx=await p.getTransaction({hash:h});if(!same(tx.from,input.wallet))continue;try{swaps.push(await this.inspectSwap({...input,transactionHash:h}));}catch(error){if(!(error instanceof UnsupportedLeaderSwap))throw error;}}
    return {swaps,fromBlock:from.toString(),toBlock:to.toString(),headBlockNumber:head.number.toString(),headBlockHash:head.hash};
  }
  private amount(source:EvmSwapObservation,bps:number,max:string) {const cap=tradeUint(max,'maxAmountIn'),scaled=BigInt(source.amountIn)*proportion(bps)/10000n;const amount=scaled<cap?scaled:cap;if(amount<1n)throw new Error('Copy proportion rounds to zero token units');return amount;}
  async quoteCopySwap(input:EvmCopyQuoteInput) {
    if(!Number.isInteger(input.slippageBps)||input.slippageBps<1||input.slippageBps>500)throw new Error('slippageBps must be from 1 to 500');
    const source=await this.inspectSwap(input),amountIn=this.amount(source,input.proportionBps,input.maxAmountIn),v=this.venue(input.network,input.venueId);const {p,head}=await this.checked(v);
    const amounts=await p.readContract({address:v.router,abi:routerAbi,functionName:'getAmountsOut',args:[amountIn,[source.tokenIn,source.tokenOut]],blockNumber:head.number});
    const min=amounts[1]*BigInt(10000-input.slippageBps)/10000n;if(min<1n)throw new Error('Quote has zero bounded output');
    const [inputDecimals,outputDecimals]=await Promise.all([source.tokenIn,source.tokenOut].map(address=>p.readContract({address,abi:erc20Abi,functionName:'decimals',blockNumber:head.number})));
    return {source,amountIn:amountIn.toString(),quotedAmountOut:amounts[1].toString(),minAmountOut:min.toString(),slippageBps:input.slippageBps,inputDecimals,outputDecimals,quoteBlockNumber:head.number.toString(),quoteBlockHash:head.hash,quotedAt:new Date().toISOString(),quoteBasis:'current-allowlisted-pool-reserves',independentPriceOracle:false};
  }
  private row(id:string) {return this.database().query('SELECT fingerprint,plan,receipt,terminalError FROM swaps WHERE operationId=?').get(id) as Journal|null;}
  private save(id:string,plan:Plan) {this.database().query('UPDATE swaps SET plan=? WHERE operationId=?').run(JSON.stringify(plan),id);}
  private async canonicalSource(plan:Plan) {const {p}=await this.checked(plan.venue);const block=await p.getBlock({blockNumber:BigInt(plan.source.blockNumber)});if(block.hash!==plan.source.blockHash)throw new Error('Observed source swap was reorganized; refusing new execution');return p;}
  async copySwap(input:EvmCopyInput,hooks?:{beforeSwap?:()=>Promise<boolean|void>}):Promise<EvmCopyReceipt> {
    const v=this.venue(input.network,input.venueId);const account=this.account(input.network);const wallet=addr(input.wallet),tx=hash(input.transactionHash);proportion(input.proportionBps);tradeUint(input.maxAmountIn,'maxAmountIn');tradeUint(input.minAmountOut,'minAmountOut');
    const seconds=input.deadlineSeconds??120;if(!Number.isInteger(seconds)||seconds<30||seconds>300)throw new Error('deadlineSeconds must be from 30 to 300');if(!/^[\w:.-]{1,160}$/.test(input.operationId))throw new Error('operationId must be 1 to 160 safe identifier characters');
    const fingerprint=createHash('sha256').update(JSON.stringify({network:input.network,venueId:v.id,router:v.router.toLowerCase(),pair:v.pair.toLowerCase(),code:v.routerCodeHash,signer:account.address.toLowerCase(),wallet:wallet.toLowerCase(),tx,bps:input.proportionBps,max:input.maxAmountIn,min:input.minAmountOut,seconds})).digest('hex');
    const active=this.pending.get(input.operationId);if(active){if(active.fingerprint!==fingerprint)throw new Error('operationId already binds different copy parameters');return active.promise;}
    const promise=this.withWriter(async()=>{try{return await this.perform({...input,wallet,transactionHash:tx},v,fingerprint,hooks);}catch(error){
      const row=this.row(input.operationId);if(row&&row.fingerprint===fingerprint&&!row.receipt){const plan=JSON.parse(row.plan) as Plan;if(error instanceof DefinitiveTradeFailure||(!plan.swap&&plan.approvals.every(a=>a.status==='confirmed')))this.database().query('UPDATE swaps SET terminalError=? WHERE operationId=?').run(String(error),input.operationId);}
      throw error;
    }});this.pending.set(input.operationId,{fingerprint,promise});try{return await promise;}finally{this.pending.delete(input.operationId);}
  }
  private async withWriter<T>(work:()=>Promise<T>):Promise<T> {
    const db=this.database(),token=randomUUID();
    db.transaction(()=>{const lock=db.query('SELECT pid,token FROM writer_lock WHERE id=1').get() as {pid:number;token:string}|null;
      if(lock){let alive=true;try{process.kill(lock.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}if(alive)throw new Error('Another live process is submitting a trade; retry after it settles');db.query('DELETE FROM writer_lock WHERE id=1').run();}
      db.query('INSERT INTO writer_lock(id,pid,token) VALUES(1,?,?)').run(process.pid,token);
    })();
    try{return await work();}finally{db.query('DELETE FROM writer_lock WHERE id=1 AND token=?').run(token);}
  }
  private async perform(input:EvmCopyInput,v:EvmTradeVenue,fingerprint:string,hooks?:{beforeSwap?:()=>Promise<boolean|void>}):Promise<EvmCopyReceipt> {
    let row=this.row(input.operationId);if(row&&row.fingerprint!==fingerprint)throw new Error('operationId already binds different copy parameters');if(row?.receipt){const receipt=JSON.parse(row.receipt) as EvmCopyReceipt;await this.verifyCanonicalReceipt(receipt,v);return {...receipt,replayed:true};}if(row?.terminalError)throw new Error(row.terminalError);
    const account=this.account(input.network);let plan:Plan;
    if(row)plan=JSON.parse(row.plan);
    else {
      const source=await this.inspectSwap(input),amountIn=this.amount(source,input.proportionBps,input.maxAmountIn);const {p}=await this.checked(v);
      const [beforeIn,beforeOut]=await Promise.all([source.tokenIn,source.tokenOut].map(address=>p.readContract({address,abi:erc20Abi,functionName:'balanceOf',args:[account.address]})));if(beforeIn<amountIn)throw new Error('Task wallet has insufficient input tokens');
      plan={venue:v,signer:account.address,source,amountIn:amountIn.toString(),minAmountOut:input.minAmountOut,deadlineSeconds:input.deadlineSeconds??120,inputBalanceBefore:beforeIn.toString(),outputBalanceBefore:beforeOut.toString(),approvals:[]};
      const db=this.database();db.transaction(()=>{const old=this.row(input.operationId);if(old){if(old.fingerprint!==fingerprint)throw new Error('operationId already binds different copy parameters');plan=JSON.parse(old.plan);return;}const busy=db.query('SELECT operationId FROM swaps WHERE receipt IS NULL AND terminalError IS NULL LIMIT 1').get() as {operationId:string}|null;if(busy)throw new Error(`Another copy operation is unresolved: ${busy.operationId}. Reconcile or retry its identical operation first.`);db.query('INSERT INTO swaps(operationId,fingerprint,plan) VALUES(?,?,?)').run(input.operationId,fingerprint,JSON.stringify(plan));})();
      row=this.row(input.operationId)!;
    }
    if(!same(plan.signer,account.address)||plan.venue.routerCodeHash!==v.routerCodeHash||!same(plan.venue.router,v.router)||!same(plan.venue.pair,v.pair)||plan.venue.rpcUrl!==v.rpcUrl)throw new Error('Pending operation task signer/venue identity changed');
    const p=this.client(v);
    if(plan.swap)return await this.settle(input.operationId,plan,true,hooks);
    await this.canonicalSource(plan);
    // Exact, bounded approval. Existing nonzero allowances are reset with their own durable step.
    for(const step of plan.approvals)if(step.status!=='confirmed'){await this.broadcastAndWait(p,step,true,()=>{step.submissionAttempted=true;this.save(input.operationId,plan);});step.status='confirmed';this.save(input.operationId,plan);}
    let allowance=await p.readContract({address:plan.source.tokenIn,abi:erc20Abi,functionName:'allowance',args:[account.address,v.router]});
    for(const approvalAmount of allowance<BigInt(plan.amountIn)?(allowance>0n?[0n,BigInt(plan.amountIn)]:[BigInt(plan.amountIn)]):[]){
      await this.canonicalSource(plan);const data=encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[v.router,approvalAmount]});
      await p.call({account:account.address,to:plan.source.tokenIn,data});const step=await this.sign(p,account,plan.source.tokenIn,data);plan.approvals.push(step);this.save(input.operationId,plan);await this.broadcastAndWait(p,step,true,()=>{step.submissionAttempted=true;this.save(input.operationId,plan);});step.status='confirmed';this.save(input.operationId,plan);
    }
    await this.canonicalSource(plan);if(hooks?.beforeSwap&&await hooks.beforeSwap()===false)throw new Error('Fresh watch predicate no longer permits this swap; no swap was signed');const head=await p.getBlock();plan.deadline=(head.timestamp+BigInt(plan.deadlineSeconds)).toString();
    const data=encodeFunctionData({abi:routerAbi,functionName:'swapExactTokensForTokens',args:[BigInt(plan.amountIn),BigInt(plan.minAmountOut),[plan.source.tokenIn,plan.source.tokenOut],account.address,BigInt(plan.deadline)]});
    await p.call({account:account.address,to:v.router,data});
    plan.swap=await this.sign(p,account,v.router,data);this.save(input.operationId,plan);
    return await this.settle(input.operationId,plan,true,hooks);
  }
  private async sign(p:ReturnType<EvmTradeUtilities['client']>,account:ReturnType<typeof privateKeyToAccount>,to:Address,data:Hex):Promise<SignedStep> {
    const wallet=createWalletClient({account,transport:this.transport(p.transport.url!)});
    const request=await wallet.prepareTransactionRequest({account,to,data,value:0n,chain:null});const raw=await wallet.signTransaction({...request,chain:null});return {raw,hash:keccak256(raw)};
  }
  private async broadcastAndWait(p:ReturnType<EvmTradeUtilities['client']>,step:SignedStep,send=true,markAttempt?:()=>void) {
    let receipt=await p.getTransactionReceipt({hash:step.hash}).catch(()=>null);
    if(!receipt&&send){markAttempt?.();try {const returned=await p.sendRawTransaction({serializedTransaction:step.raw});if(returned!==step.hash)throw new Error('RPC returned a different transaction identity');}catch(error){if(!/already known|known transaction|nonce too low/i.test(String(error)))throw new Error(`Signed submission uncertain (${step.hash}); retry identical operation or reconcile: ${String(error)}`);}}
    if(!receipt&&send)receipt=await p.waitForTransactionReceipt({hash:step.hash,timeout:this.options.receiptTimeoutMs??45000,pollingInterval:500});
    if(!receipt)return null;if(receipt.status!=='success')throw new DefinitiveTradeFailure(`Signed transaction reverted: ${step.hash}`);const block=await p.getBlock({blockNumber:receipt.blockNumber});if(block.hash!==receipt.blockHash)throw new Error('Transaction receipt was reorganized');return receipt;
  }
  private async verifyCanonicalReceipt(receipt:EvmCopyReceipt,v:EvmTradeVenue) {const {p}=await this.checked(v);const [r,block,sourceBlock,sourceReceipt]=await Promise.all([p.getTransactionReceipt({hash:receipt.transactionHash}),p.getBlock({blockNumber:BigInt(receipt.blockNumber)}),p.getBlock({blockNumber:BigInt(receipt.source.blockNumber)}),p.getTransactionReceipt({hash:receipt.source.transactionHash})]);if(r.status!=='success'||r.blockHash!==receipt.blockHash||block.hash!==receipt.blockHash)throw new Error('Previously confirmed swap no longer has a canonical success receipt');if(sourceBlock.hash!==receipt.source.blockHash||sourceReceipt.blockHash!==receipt.source.blockHash||sourceReceipt.status!=='success')throw new Error('Copied swap has a destination receipt, but its original leader provenance is no longer canonical');}
  private async settle(id:string,plan:Plan,send:boolean,hooks?:{beforeSwap?:()=>Promise<boolean|void>}):Promise<EvmCopyReceipt> {
    if(!plan.swap)throw new Error('Operation has no signed swap yet');const {p}=await this.checked(plan.venue);
    if(send&&!await p.getTransactionReceipt({hash:plan.swap.hash}).catch(()=>null)){await this.canonicalSource(plan);if(hooks?.beforeSwap&&await hooks.beforeSwap()===false){if(!plan.swap.submissionAttempted)throw new DefinitiveTradeFailure('Fresh watch predicate blocked the prepared swap; no swap submission was attempted');throw new Error('Fresh watch predicate blocked rebroadcast; reconcile the earlier immutable submission');}}
    const receipt=await this.broadcastAndWait(p,plan.swap,send,()=>{plan.swap!.submissionAttempted=true;this.save(id,plan);});if(!receipt)throw new Error('No confirmed swap receipt yet; execution remains unresolved');
    const logs=parseEventLogs({abi:pairAbi,eventName:'Swap',logs:receipt.logs.filter(l=>same(l.address,plan.venue.pair)),strict:true});if(logs.length!==1)throw new Error('Copy receipt does not contain one matching pool Swap');const log=logs[0],a=log.args,forward=same(plan.source.tokenIn,plan.venue.token0),amountIn=forward?a.amount0In:a.amount1In,amountOut=forward?a.amount1Out:a.amount0Out;
    if(!same(a.sender,plan.venue.router)||!same(a.to,plan.signer)||amountIn!==BigInt(plan.amountIn)||amountOut<BigInt(plan.minAmountOut)||(forward?a.amount1In:a.amount0In)!==0n||(forward?a.amount0Out:a.amount1Out)!==0n)throw new Error('Copy Swap event identity/direction/amount does not match signed plan');
    const balances=await Promise.all([plan.source.tokenIn,plan.source.tokenOut].map(async address=>({before:await p.readContract({address,abi:erc20Abi,functionName:'balanceOf',args:[plan.signer],blockNumber:receipt.blockNumber-1n}),after:await p.readContract({address,abi:erc20Abi,functionName:'balanceOf',args:[plan.signer],blockNumber:receipt.blockNumber})})));
    if(balances[0].before-balances[0].after!==amountIn||balances[1].after-balances[1].before!==amountOut)throw new Error('Receipt-block token balance deltas do not prove the exact copied swap');
    const verified:EvmCopyReceipt={kind:'confirmed-evm-copy-swap',network:plan.venue.network,chainId:EVM_TRADE_CHAINS[plan.venue.network],venueId:plan.venue.id,operationId:id,source:plan.source,signer:plan.signer,transactionHash:plan.swap.hash,approvalTransactionHashes:plan.approvals.map(a=>a.hash),blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,logIndex:log.logIndex!,tokenIn:plan.source.tokenIn,tokenOut:plan.source.tokenOut,amountIn:amountIn.toString(),amountOut:amountOut.toString(),minAmountOut:plan.minAmountOut,inputBalanceBefore:balances[0].before.toString(),inputBalanceAfter:balances[0].after.toString(),outputBalanceBefore:balances[1].before.toString(),outputBalanceAfter:balances[1].after.toString(),replayed:!send,explorerUrl:explorer(plan.venue.network,plan.swap.hash),verifiedAt:new Date().toISOString()};
    this.database().query('UPDATE swaps SET receipt=? WHERE operationId=?').run(JSON.stringify(verified),id);return verified;
  }
  async reconcileCopySwap(operationId:string) {
    const row=this.row(operationId);if(!row)throw new Error('Unknown copy operationId');const plan=JSON.parse(row.plan) as Plan;
    if(row.terminalError)return {status:'failed' as const,operationId,error:row.terminalError,broadcast:false,reconciledAt:new Date().toISOString()};
    if(row.receipt){const receipt=JSON.parse(row.receipt) as EvmCopyReceipt;await this.verifyCanonicalReceipt(receipt,plan.venue);return {status:'confirmed' as const,receipt:{...receipt,replayed:true},reconciledAt:new Date().toISOString()};}
    if(!plan.swap)return {status:'pending-approval-or-preflight' as const,operationId,signer:plan.signer,approvalTransactionHashes:plan.approvals.map(a=>a.hash),broadcast:false,reconciledAt:new Date().toISOString()};
    try{return {status:'confirmed' as const,receipt:await this.settle(operationId,plan,false),reconciledAt:new Date().toISOString()};}catch(error){if(error instanceof DefinitiveTradeFailure){this.database().query('UPDATE swaps SET terminalError=? WHERE operationId=?').run(String(error),operationId);return {status:'failed' as const,operationId,error:String(error),broadcast:false,reconciledAt:new Date().toISOString()};}return {status:'unresolved' as const,operationId,transactionHash:plan.swap.hash,broadcast:false,error:String(error),reconciledAt:new Date().toISOString()};}
  }
  close(){this.db?.close();this.db=undefined;}
}
