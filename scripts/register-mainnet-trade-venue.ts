// Public reads only. Official Ethereum V2 deployment identities are published at
// https://developers.uniswap.org/docs/protocols/v2/deployments . USDC/WETH token
// identities: https://developers.uniswap.org/docs/sdks/v3/guides/pool-data .
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, decodeFunctionData, http, keccak256, parseAbi, type Address } from 'viem';
import { EvmTradeUtilities, type EvmTradeVenue } from '../server/evm-trades';
const dataDir=process.env.ORIGINS_EVM_TRADE_DATA_DIR||'.data/evm-trades',registry=process.env.ORIGINS_EVM_TRADE_VENUES_FILE||join(dataDir,'venues.json');
const rpcUrl=process.env.ORIGINS_MAINNET_RPC||'https://ethereum-rpc.publicnode.com';
const p=createPublicClient({transport:http(rpcUrl,{timeout:12000,retryCount:1})});if(await p.getChainId()!==1)throw new Error('Public inspection RPC must be Ethereum mainnet');
const factory='0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',router='0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',token0='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',token1='0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const pair=await p.readContract({address:factory,abi:parseAbi(['function getPair(address,address) view returns(address)']),functionName:'getPair',args:[token0,token1]});if(pair==='0x0000000000000000000000000000000000000000')throw new Error('Canonical factory has no USDC/WETH pool');
const [factoryCode,routerCode,pairCode]=await Promise.all([factory,router,pair].map(address=>p.getCode({address:address as Address})));if(!factoryCode||!routerCode||!pairCode)throw new Error('Canonical venue has missing code');
const venue:EvmTradeVenue={id:'ethereum-usdc-weth-v2',label:'Uniswap V2 USDC/WETH · Ethereum read-only',network:'ethereum',rpcUrl,factory,router,pair,token0,token1,factoryCodeHash:keccak256(factoryCode),routerCodeHash:keccak256(routerCode),pairCodeHash:keccak256(pairCode),provenance:'Official Ethereum factory/router from https://developers.uniswap.org/docs/protocols/v2/deployments ; USDC/WETH identity from official Uniswap SDK docs. Pair resolved from canonical factory. Mainnet signing disabled.'};
const utility=new EvmTradeUtilities({dataDir,venues:[venue]});
try {
  const head=await p.getBlock(),confirmed=head.number-2n;const swapEvent=parseAbi(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)'])[0];
  const logs=await p.getLogs({address:pair,event:swapEvent,fromBlock:confirmed-999n,toBlock:confirmed});
  const method=parseAbi(['function swapExactTokensForTokens(uint amountIn,uint amountOutMin,address[] path,address to,uint deadline) returns(uint[] amounts)']);let observed;
  for(const hash of [...new Set(logs.map(l=>l.transactionHash))].reverse().slice(0,80)){
    if(!hash)continue;const tx=await p.getTransaction({hash});if(tx.to?.toLowerCase()!==router.toLowerCase())continue;
    let eligible=false;try{const decoded=decodeFunctionData({abi:method,data:tx.input});eligible=decoded.args[2].length===2&&decoded.args[3].toLowerCase()===tx.from.toLowerCase();}catch{continue;}if(!eligible)continue;
    observed=await utility.inspectSwap({network:'ethereum',venueId:venue.id,wallet:tx.from,transactionHash:hash});break;
  }
  mkdirSync(dataDir,{recursive:true});const existing:EvmTradeVenue[]=existsSync(registry)?JSON.parse(readFileSync(registry,'utf8')):[];if(!Array.isArray(existing))throw new Error('Venue registry is invalid');
  const prior=existing.find(v=>v.id===venue.id&&v.network===venue.network);if(prior&&(prior.router.toLowerCase()!==router.toLowerCase()||prior.pair.toLowerCase()!==pair.toLowerCase()||prior.routerCodeHash!==venue.routerCodeHash||prior.factoryCodeHash!==venue.factoryCodeHash||prior.pairCodeHash!==venue.pairCodeHash))throw new Error('Existing canonical venue identity changed; preserve registry for review');
  if(!prior)writeFileSync(registry,JSON.stringify([...existing,venue],null,2),{mode:0o600});
  const evidence={status:'verified-public-reads',network:'ethereum',chainId:1,signingEnabled:false,verifiedAt:new Date().toISOString(),headBlockNumber:head.number.toString(),headBlockHash:head.hash,venue:utility.listVenues()[0],source:observed??null,notice:'Public observation only. This module cannot sign or copy trades on Ethereum mainnet.'};
  await Bun.write('demo/copytrade-mainnet-observation.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{utility.close();}
