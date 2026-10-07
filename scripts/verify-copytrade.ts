// A disposable, genuine Uniswap V2 deployment. All settlement occurs on EVM;
// this harness has no fabricated swap receipt, runtime adapter, or price fixture.
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseEther, parseTransaction, type Abi, type Address, type Hex } from 'viem';
import { Database } from 'bun:sqlite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { EvmTradeUtilities, type EvmTradeVenue } from '../server/evm-trades';
import { EvmTradeWatchManager } from '../server/evm-trade-watch';
import { evmTradeWatchAdapter } from '../server/evm-trade-watch-adapter';
const LOCAL_DEV_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const temporary=mkdtempSync(join(tmpdir(),'woga-copytrade-'));
const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));
const rpcUrl=`http://127.0.0.1:${port}`,statePath=join(temporary,'anvil-state.json');const anvil=Bun.spawn(['anvil','--host','127.0.0.1','--port',String(port),'--silent','--state',statePath,'--preserve-historical-states'],{stdout:Bun.file(join(temporary,'anvil.log')),stderr:Bun.file(join(temporary,'anvil.error.log'))});
const p=createPublicClient({transport:http(rpcUrl,{retryCount:0,timeout:5000})});
const deployer=privateKeyToAccount(LOCAL_DEV_KEY),leader=privateKeyToAccount(generatePrivateKey());const dw=createWalletClient({account:deployer,transport:http(rpcUrl)}),lw=createWalletClient({account:leader,transport:http(rpcUrl)});
const ercAbi=parseAbi(['function mint(address,uint256)','function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)']);
const routerAbi=parseAbi(['function addLiquidity(address,address,uint,uint,uint,uint,address,uint) returns(uint,uint,uint)','function swapExactTokensForTokens(uint,uint,address[],address,uint) returns(uint[])']);
const factoryAbi=parseAbi(['function getPair(address,address) view returns(address)']);const pairAbi=parseAbi(['function token0() view returns(address)','function token1() view returns(address)']);
const checks:{name:string;passed:boolean;detail?:unknown}[]=[];function assert(ok:unknown,name:string,detail?:unknown){checks.push({name,passed:Boolean(ok),detail});if(!ok)throw new Error(name);console.log(`PASS ${name}`);}
async function tx(work:Promise<Hex>){const hash=await work;const r=await p.waitForTransactionReceipt({hash,timeout:10000,pollingInterval:20});if(r.status!=='success')throw new Error(`Reverted ${hash}`);return r;}
async function official(name:string,args:unknown[]=[]){const artifact=await Bun.file(`contracts/vendor/uniswap-v2/${name}.json`).json();return (await tx(dw.deployContract({abi:artifact.abi as Abi,bytecode:`0x${artifact.bytecode}` as Hex,args,chain:null}))).contractAddress!;}
let utilities:EvmTradeUtilities|undefined;
let proxy:ReturnType<typeof Bun.serve>|undefined,watch:EvmTradeWatchManager|undefined,watchDb:Database|undefined;
try {
  for(let attempt=0;;attempt++){try{if(await p.getChainId()!==31337)throw new Error('Wrong chain');break;}catch(e){if(attempt>50)throw e;await Bun.sleep(100);}}
  const compilation=Bun.spawn(['forge','build','--root','contracts'],{stdout:'ignore',stderr:'inherit'});if(await compilation.exited!==0)throw new Error('Token compile failed');
  const tokenArtifact=await Bun.file('contracts/out/RehearsalTradeToken.sol/RehearsalTradeToken.json').json();
  const tokenA=(await tx(dw.deployContract({abi:tokenArtifact.abi,bytecode:tokenArtifact.bytecode.object,args:['Disposable Alpha','dALPHA'],chain:null}))).contractAddress!;
  const tokenB=(await tx(dw.deployContract({abi:tokenArtifact.abi,bytecode:tokenArtifact.bytecode.object,args:['Disposable Beta','dBETA'],chain:null}))).contractAddress!;
  const factory=await official('UniswapV2Factory',[deployer.address]),weth=await official('WETH9'),router=await official('UniswapV2Router02',[factory,weth]);
  for(const token of [tokenA,tokenB]){await tx(dw.writeContract({address:token,abi:ercAbi,functionName:'mint',args:[deployer.address,parseEther('1000000')],chain:null}));await tx(dw.writeContract({address:token,abi:ercAbi,functionName:'approve',args:[router,parseEther('100000')],chain:null}));}
  await tx(dw.writeContract({address:router,abi:routerAbi,functionName:'addLiquidity',args:[tokenA,tokenB,parseEther('100000'),parseEther('100000'),1n,1n,deployer.address,(await p.getBlock()).timestamp+300n],chain:null}));
  const pair=await p.readContract({address:factory,abi:factoryAbi,functionName:'getPair',args:[tokenA,tokenB]});
  const token0=await p.readContract({address:pair,abi:pairAbi,functionName:'token0'}),token1=await p.readContract({address:pair,abi:pairAbi,functionName:'token1'});
  const venue:EvmTradeVenue={id:'disposable-uniswap-v2',label:'Official Uniswap V2 · disposable EVM assets',network:'local',rpcUrl,factory,router,pair,token0,token1,factoryCodeHash:keccak256((await p.getCode({address:factory}))!),routerCodeHash:keccak256((await p.getCode({address:router}))!),pairCodeHash:keccak256((await p.getCode({address:pair}))!),provenance:'Unmodified @uniswap/v2-core@1.0.1 and @uniswap/v2-periphery@1.1.0-beta.0 artifacts; new disposable tokens on isolated Anvil'};
  utilities=new EvmTradeUtilities({dataDir:join(temporary,'follower'),venues:[venue],receiptTimeoutMs:10000});const follower=await utilities.getWallet('local');
  for(const wallet of [leader.address,follower.address]){await tx(dw.sendTransaction({to:wallet,value:parseEther('1'),chain:null}));await tx(dw.writeContract({address:tokenA,abi:ercAbi,functionName:'mint',args:[wallet,parseEther('1000')],chain:null}));}
  await tx(lw.writeContract({address:tokenA,abi:ercAbi,functionName:'approve',args:[router,parseEther('100')],chain:null}));
  const sourceReceipt=await tx(lw.writeContract({address:router,abi:routerAbi,functionName:'swapExactTokensForTokens',args:[parseEther('100'),1n,[tokenA,tokenB],leader.address,(await p.getBlock()).timestamp+300n],chain:null}));
  const input={network:'local' as const,venueId:venue.id,wallet:leader.address,transactionHash:sourceReceipt.transactionHash};
  const source=await utilities.inspectSwap(input);assert(source.amountIn===parseEther('100').toString()&&source.amountOut!=='0','Confirmed leader swap decoded from real V2 receipt');
  const quote=await utilities.quoteCopySwap({...input,proportionBps:2500,maxAmountIn:parseEther('20').toString(),slippageBps:100});assert(quote.amountIn===parseEther('20').toString()&&quote.independentPriceOracle===false,'Fresh bounded quote uses current reserves and exact raw cap');
  const operation={...input,operationId:'isolated-copy-1',proportionBps:2500,maxAmountIn:parseEther('20').toString(),minAmountOut:quote.minAmountOut};
  const receipt=await utilities.copySwap(operation);assert(receipt.amountIn===parseEther('20').toString()&&BigInt(receipt.amountOut)>=BigInt(quote.minAmountOut),'Follower performed actual proportional capped token swap');
  assert(BigInt(receipt.inputBalanceBefore)-BigInt(receipt.inputBalanceAfter)===BigInt(receipt.amountIn)&&BigInt(receipt.outputBalanceAfter)-BigInt(receipt.outputBalanceBefore)===BigInt(receipt.amountOut),'Receipt-block token balance deltas prove input and output');
  assert(receipt.source.transactionHash===sourceReceipt.transactionHash&&receipt.transactionHash!==sourceReceipt.transactionHash&&receipt.approvalTransactionHashes.length===1,'Source and follower transaction identities remain distinct and correlated');
  assert(await p.readContract({address:tokenA,abi:ercAbi,functionName:'allowance',args:[follower.address,router]})===0n,'Only exact input was approved and allowance consumed');
  const beforeReplay=await p.getTransactionCount({address:follower.address});const replay=await utilities.copySwap(operation);assert(replay.transactionHash===receipt.transactionHash&&replay.replayed&&await p.getTransactionCount({address:follower.address})===beforeReplay,'Same operation replays canonical receipt without another trade');
  let conflict=false;try{await utilities.copySwap({...operation,maxAmountIn:parseEther('21').toString()});}catch{conflict=true;}assert(conflict,'Changed spend cap cannot reuse the same operation identity');
  let wrongWallet=false;try{await utilities.inspectSwap({...input,wallet:deployer.address});}catch{wrongWallet=true;}assert(wrongWallet,'Receipt from a different wallet cannot masquerade as a watched trade');
  let wrongEvent=false;try{await utilities.inspectSwap({...input,transactionHash:receipt.approvalTransactionHashes[0]});}catch{wrongEvent=true;}assert(wrongEvent,'A token approval cannot masquerade as a swap');
  utilities.close();utilities=new EvmTradeUtilities({dataDir:join(temporary,'follower'),venues:[venue]});const recovered=await utilities.reconcileCopySwap(operation.operationId);assert(recovered.status==='confirmed'&&recovered.receipt?.transactionHash===receipt.transactionHash,'Read-only recovery survives process restart');
  let mainnetBlocked=false;try{await utilities.getWallet('ethereum');}catch{mainnetBlocked=true;}assert(mainnetBlocked,'Mainnet signing is unavailable');
  // The proxy broadcasts to real Anvil before discarding its HTTP response.
  // This injects transport failure only; every receipt/state remains real.
  let dropTarget:Address|null=null,dropped=0;
  proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.text();const response=await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body});const actual=await response.text();const payload=JSON.parse(body);if(payload.method==='eth_sendRawTransaction'&&dropTarget){const parsed=parseTransaction(payload.params[0]);if(parsed.to?.toLowerCase()===dropTarget.toLowerCase()){dropped++;return new Response('Response deliberately lost after real broadcast',{status:503});}}return new Response(actual,{status:response.status,headers:{'Content-Type':'application/json'}});}});
  const proxyVenue={...venue,rpcUrl:`http://127.0.0.1:${proxy.port}`};utilities.close();utilities=new EvmTradeUtilities({dataDir:join(temporary,'follower'),venues:[proxyVenue],receiptTimeoutMs:10000});
  const faultReceipts=[];
  for(const [stage,target] of [['approval',tokenA],['swap',router]] as const){
    const freshQuote=await utilities.quoteCopySwap({...input,proportionBps:1000,maxAmountIn:parseEther('5').toString(),slippageBps:100});const faultInput={...input,operationId:`lost-${stage}-response`,proportionBps:1000,maxAmountIn:parseEther('5').toString(),minAmountOut:freshQuote.minAmountOut};
    const nonceBefore=await p.getTransactionCount({address:follower.address});dropTarget=target;let lost=false;try{await utilities.copySwap(faultInput);}catch{lost=true;}dropTarget=null;
    assert(lost&&dropped>0,`Real ${stage} broadcast survives a deliberately lost HTTP response`);
    const readonly=await utilities.reconcileCopySwap(faultInput.operationId);const nonceAfterFailure=await p.getTransactionCount({address:follower.address});
    assert(await p.getTransactionCount({address:follower.address})===nonceAfterFailure,`Read-only ${stage} reconciliation broadcasts nothing`);
    utilities.close();utilities=new EvmTradeUtilities({dataDir:join(temporary,'follower'),venues:[proxyVenue],receiptTimeoutMs:10000});const retry=await utilities.copySwap(faultInput);
    assert(await p.getTransactionCount({address:follower.address})===nonceBefore+2&&retry.amountIn===parseEther('5').toString(),`Restart retry of lost ${stage} uses one original approval and one swap`);
    if(stage==='swap')assert(readonly.status==='confirmed'&&readonly.receipt.transactionHash===retry.transactionHash,'Lost swap response resolves to the exact already-mined swap identity');
    faultReceipts.push({stage,receipt:retry});
  }
  utilities.close();utilities=new EvmTradeUtilities({dataDir:join(temporary,'follower'),venues:[venue]});
  const changedQuote=await utilities.quoteCopySwap({...input,proportionBps:1000,maxAmountIn:parseEther('3').toString(),slippageBps:100});const predicateOperation={...input,operationId:'fresh-guard-after-approval',proportionBps:1000,maxAmountIn:parseEther('3').toString(),minAmountOut:changedQuote.minAmountOut};
  const guardNonce=await p.getTransactionCount({address:follower.address});let guarded=false;try{await utilities.copySwap(predicateOperation,{beforeSwap:async()=>false});}catch{guarded=true;}
  const blocked=await utilities.reconcileCopySwap(predicateOperation.operationId);assert(guarded&&blocked.status==='failed'&&await p.getTransactionCount({address:follower.address})===guardNonce+1,'A fresh false predicate after real approval prevents signing or broadcasting the swap');
  watchDb=new Database(join(temporary,'watch.sqlite'));watch=new EvmTradeWatchManager(watchDb,evmTradeWatchAdapter(utilities),{scheduling:false});
  const predicate=(op:'<'|'>')=>({graph:{nodes:[{id:'eth',kind:'price' as const,source:{type:'exchange-trade' as const,pair:'ETH-USD'}},{id:'condition',kind:'compare' as const,input:'eth',op,value:1}],root:'condition'},exchangeMaxAgeSeconds:120});
  const baseWatch={sessionId:'genuine-integration',network:'local',venueId:venue.id,leader:leader.address,startBlock:'next' as const,tokenIn:tokenA,tokenOut:tokenB,proportionBps:2500,perTradeInputCapRaw:parseEther('2').toString(),cumulativeInputCapRaw:parseEther('2').toString(),slippageBps:100,maxTrades:1,intervalSeconds:15};
  const emitLeader=async()=>{await tx(lw.writeContract({address:tokenA,abi:ercAbi,functionName:'approve',args:[router,parseEther('10')],chain:null}));return await tx(lw.writeContract({address:router,abi:routerAbi,functionName:'swapExactTokensForTokens',args:[parseEther('10'),1n,[tokenA,tokenB],leader.address,(await p.getBlock()).timestamp+300n],chain:null}));};
  const falseWatch=await watch.activate({...baseWatch,activationId:'watch-false',predicate:predicate('<')});const falseSource=await emitLeader();const falseNonce=await p.getTransactionCount({address:follower.address});await watch.tick();const falseResult=watch.get(falseWatch.id);
  assert(falseResult.skippedEvents.some(e=>e.sourceTransactionHash===falseSource.transactionHash)&&watch.attempts(falseWatch.id).length===0&&await p.getTransactionCount({address:follower.address})===falseNonce,'A real live-price false predicate archives the new leader swap and creates no follower transaction');watch.stop(falseWatch.id);
  const trueWatch=await watch.activate({...baseWatch,activationId:'watch-true',predicate:predicate('>')});const trueSource=await emitLeader();const trueNonce=await p.getTransactionCount({address:follower.address});const priorAllowance=await p.readContract({address:tokenA,abi:ercAbi,functionName:'allowance',args:[follower.address,router]});const expectedTransactions=priorAllowance>=parseEther('2')?1:priorAllowance>0n?3:2;await watch.tick();const trueResult=watch.get(trueWatch.id),attempts=watch.attempts(trueWatch.id);
  assert(trueResult.status==='completed'&&attempts.length===1&&attempts[0].execution?.sourceTransactionHash===trueSource.transactionHash&&attempts[0].execution.status==='confirmed','An explicitly activated live-price watch copies the next confirmed leader swap with a real receipt');
  assert(attempts[0].execution?.amountInRaw===parseEther('2').toString()&&await p.getTransactionCount({address:follower.address})===trueNonce+expectedTransactions,'Watch enforces the frozen per-trade and cumulative input cap without duplicate submissions');
  await watch.tick();assert(watch.attempts(trueWatch.id).length===1&&await p.getTransactionCount({address:follower.address})===trueNonce+expectedTransactions,'Completed watch cannot copy the same source again or exceed one authorized trade');
  const watchProof={falseWatch:falseResult,trueWatch:trueResult,attempts};
  const evidence={status:'verified',kind:'isolated-genuine-uniswap-v2-copytrade',createdAt:new Date().toISOString(),chainId:31337,rpcUrl,temporaryDirectory:temporary,statePath,preserveHistoricalStates:true,venue:{...venue,rpcUrl:undefined},leader:leader.address,follower:follower.address,source,quote,receipt,faultReceipts,watchProof,checks,limitations:['Disposable local chain and valueless test assets; this is real AMM settlement, not public-network execution.','Only allowlisted direct single-hop exact-input token swaps are supported.','Pool quotes are not independent price oracles.']};
  mkdirSync('demo',{recursive:true});await Bun.write('demo/copytrade-isolated-verification.json',JSON.stringify(evidence,null,2));console.log(`Verified ${checks.length} checks; demo/copytrade-isolated-verification.json`);
}finally{watch?.close();watchDb?.close();utilities?.close();proxy?.stop(true);anvil.kill('SIGTERM');await anvil.exited;}
