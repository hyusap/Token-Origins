import {createPublicClient,createWalletClient,http,type PublicClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {deployLocalTreasury} from './local-deploy';
// Anvil's PUBLIC development key. Never use this key on a public network.
export const LOCAL_DEV_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const rpcUrl=process.env.ORIGINS_LOCAL_RPC||'http://127.0.0.1:8545';
const publicClient=createPublicClient({chain:foundry,transport:http(rpcUrl)}) as PublicClient;
if(await publicClient.getChainId()!==31337) throw new Error('Refusing local deployment on any other chain');
const account=privateKeyToAccount(LOCAL_DEV_KEY);
const wallet=createWalletClient({account,chain:foundry,transport:http(rpcUrl)});
const proc=Bun.spawn(['forge','build','--root','contracts'],{stdout:'inherit',stderr:'inherit'});
if(await proc.exited!==0) throw new Error('Contract compilation failed');
const treasury=await deployLocalTreasury(publicClient,wallet);
// Earlier vaults stay on chain with their receipts; keep their addresses so old evidence stays traceable.
const previous=await Bun.file('contracts/deployment.local.json').json().catch(()=>null);
const previousDeployments=previous?[...(previous.previousDeployments??[]),{address:previous.address,forwarder:previous.forwarder,reportVersion:previous.reportVersion??1,deploymentHash:previous.deploymentHash,blockNumber:previous.blockNumber,createdAt:previous.createdAt}]:[];
const deployment={...treasury,owner:account.address,chainId:31337,rpcUrl,mode:'local-evm-rehearsal',createdAt:new Date().toISOString(),previousDeployments};
await Bun.write('contracts/deployment.local.json',JSON.stringify(deployment,null,2));
await Bun.write('.data/deployment.json',JSON.stringify(deployment,null,2));
console.log(JSON.stringify(deployment,null,2));
