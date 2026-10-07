import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseEther, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { EvmTradeUtilities, type EvmTradeVenue } from '../server/evm-trades';

/** Explicit, repeatable setup of valueless test assets beside the existing local
 * vault. It never resets chain state, uses a public development key only on a
 * loopback chain31337 RPC, and preserves every pre-existing venue/history. */
export async function setupLocalTrading(options:{rpcUrl?:string;dataDir?:string;venueId?:string}={}) {
  const dataDir=options.dataDir||process.env.ORIGINS_EVM_TRADE_DATA_DIR||'.data/evm-trades';
  const rpcUrl=options.rpcUrl||process.env.ORIGINS_LOCAL_RPC||'http://127.0.0.1:8545',venueId=options.venueId||'rehearsal-v2';
  const url=new URL(rpcUrl);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol))throw new Error('Local trading setup requires a loopback RPC');
  const p=createPublicClient({transport:http(rpcUrl,{timeout:12000})});if(await p.getChainId()!==31337)throw new Error('Local development key may only sign on chain31337');
  mkdirSync(dataDir,{recursive:true});const registry=process.env.ORIGINS_EVM_TRADE_VENUES_FILE||join(dataDir,'venues.json'),manifestPath=join(dataDir,`setup.${venueId}.json`);
  const venues:EvmTradeVenue[]=existsSync(registry)?JSON.parse(readFileSync(registry,'utf8')):[];if(!Array.isArray(venues))throw new Error('Existing trade venue registry is invalid');
  if(venues.some(v=>v.id===venueId&&v.network==='local')){
    const utility=new EvmTradeUtilities({dataDir,venues});try{await utility.freezeVenue({network:'local',venueId});if(!existsSync(manifestPath))throw new Error('Existing venue is valid but setup manifest is missing; preserve it and use another explicit venueId');return {...JSON.parse(readFileSync(manifestPath,'utf8')),reused:true};}finally{utility.close();}
  }
  const key='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const,deployer=privateKeyToAccount(key),dw=createWalletClient({account:deployer,transport:http(rpcUrl)});
  const leaderPath=join(dataDir,'leader.local.json');let leaderKey:Hex;
  if(existsSync(leaderPath))leaderKey=JSON.parse(readFileSync(leaderPath,'utf8')).privateKey;else{leaderKey=generatePrivateKey();writeFileSync(leaderPath,JSON.stringify({network:'local',privateKey:leaderKey,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});}
  const leader=privateKeyToAccount(leaderKey),lw=createWalletClient({account:leader,transport:http(rpcUrl)});
  const tx=async(work:Promise<Hex>)=>{const hash=await work,receipt=await p.waitForTransactionReceipt({hash,timeout:45000,pollingInterval:100});if(receipt.status!=='success')throw new Error(`Reverted setup transaction ${hash}`);return receipt;};
  const official=async(name:string,args:unknown[]=[])=>{const a=await Bun.file(`contracts/vendor/uniswap-v2/${name}.json`).json();return (await tx(dw.deployContract({abi:a.abi as Abi,bytecode:`0x${a.bytecode}` as Hex,args,chain:null}))).contractAddress!;};
  const build=Bun.spawn(['forge','build','--root','contracts'],{stdout:'ignore',stderr:'pipe'});if(await build.exited!==0)throw new Error(`Rehearsal token compilation failed: ${await new Response(build.stderr).text()}`);
  const token=await Bun.file('contracts/out/RehearsalTradeToken.sol/RehearsalTradeToken.json').json();
  const tokenA=(await tx(dw.deployContract({abi:token.abi,bytecode:token.bytecode.object,args:['Rehearsal Alpha','rALPHA'],chain:null}))).contractAddress!,tokenB=(await tx(dw.deployContract({abi:token.abi,bytecode:token.bytecode.object,args:['Rehearsal Beta','rBETA'],chain:null}))).contractAddress!;
  const factory=await official('UniswapV2Factory',[deployer.address]),weth=await official('WETH9'),router=await official('UniswapV2Router02',[factory,weth]);
  const ercAbi=parseAbi(['function mint(address,uint256)','function approve(address,uint256) returns(bool)']);
  for(const address of [tokenA,tokenB]){await tx(dw.writeContract({address,abi:ercAbi,functionName:'mint',args:[deployer.address,parseEther('1000000')],chain:null}));await tx(dw.writeContract({address,abi:ercAbi,functionName:'approve',args:[router,parseEther('100000')],chain:null}));}
  const routerAbi=parseAbi(['function addLiquidity(address,address,uint,uint,uint,uint,address,uint) returns(uint,uint,uint)','function swapExactTokensForTokens(uint,uint,address[],address,uint) returns(uint[])']);
  await tx(dw.writeContract({address:router,abi:routerAbi,functionName:'addLiquidity',args:[tokenA,tokenB,parseEther('100000'),parseEther('100000'),1n,1n,deployer.address,(await p.getBlock()).timestamp+300n],chain:null}));
  const pair=await p.readContract({address:factory,abi:parseAbi(['function getPair(address,address) view returns(address)']),functionName:'getPair',args:[tokenA,tokenB]});
  const pairAbi=parseAbi(['function token0() view returns(address)','function token1() view returns(address)']);const [token0,token1]=await Promise.all([p.readContract({address:pair,abi:pairAbi,functionName:'token0'}),p.readContract({address:pair,abi:pairAbi,functionName:'token1'})]);
  const venue:EvmTradeVenue={id:venueId,label:'Rehearsal Alpha/Beta · genuine Uniswap V2',network:'local',rpcUrl,factory,router,pair,token0,token1,factoryCodeHash:keccak256((await p.getCode({address:factory}))!),routerCodeHash:keccak256((await p.getCode({address:router}))!),pairCodeHash:keccak256((await p.getCode({address:pair}))!),provenance:'Unmodified @uniswap/v2-core@1.0.1 and @uniswap/v2-periphery@1.1.0-beta.0 artifacts. Rehearsal Alpha/Beta have no monetary value.'};
  const utility=new EvmTradeUtilities({dataDir,venues:[...venues,venue]});try{
    const follower=await utility.getWallet('local');for(const address of [leader.address,follower.address]){if(await p.getBalance({address})<parseEther('0.1'))await tx(dw.sendTransaction({to:address,value:parseEther('1'),chain:null}));await tx(dw.writeContract({address:tokenA,abi:ercAbi,functionName:'mint',args:[address,parseEther('1000')],chain:null}));}
    await tx(lw.writeContract({address:tokenA,abi:ercAbi,functionName:'approve',args:[router,parseEther('100')],chain:null}));
    const source=await tx(lw.writeContract({address:router,abi:routerAbi,functionName:'swapExactTokensForTokens',args:[parseEther('100'),1n,[tokenA,tokenB],leader.address,(await p.getBlock()).timestamp+300n],chain:null}));
    const observation=await utility.inspectSwap({network:'local',venueId,wallet:leader.address,transactionHash:source.transactionHash});
    const manifest={kind:'genuine-local-uniswap-v2-setup',chainId:31337,venueId,leader:leader.address,follower:follower.address,tokenIn:tokenA,tokenOut:tokenB,tokenDecimals:18,sourceTransactionHash:source.transactionHash,source:observation,createdAt:new Date().toISOString(),assetNotice:'Rehearsal Alpha/Beta are valueless test assets. Prices are pool ratios, not USD prices.',reused:false};
    // Registry publication is last: an incomplete setup cannot become a signing venue.
    writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});writeFileSync(registry,JSON.stringify([...venues,venue],null,2),{mode:0o600});return manifest;
  }finally{utility.close();}
}
if(import.meta.main)console.log(JSON.stringify(await setupLocalTrading({venueId:process.env.ORIGINS_LOCAL_TRADE_VENUE_ID}),null,2));
