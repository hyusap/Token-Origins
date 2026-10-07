import {createPublicClient,createWalletClient,http,parseAbi,type Address} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {resolve} from 'node:path';
import {executionDeployment,isLocalRpc} from './deployment';
// Public Anvil development wallet. Accepted ONLY by this isolated chain.
const LOCAL_DEV_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const abi=parseAbi(['function paused() view returns (bool)','function resume()']);
export async function resetLocalVault():Promise<{paused:boolean;hash?:string}> {
  const deployment=await executionDeployment();
  if(!isLocalRpc(deployment.rpcUrl)||deployment.chainId!==31337) throw new Error('Reset supports only local isolated Anvil');
  const publicClient=createPublicClient({chain:foundry,transport:http(deployment.rpcUrl)});
  if(await publicClient.getChainId()!==31337) throw new Error('Refusing reset on another chain');
  const address=deployment.address as Address;
  if(!await publicClient.readContract({address,abi,functionName:'paused'}))return {paused:false};
  const wallet=createWalletClient({account:privateKeyToAccount(LOCAL_DEV_KEY),chain:foundry,transport:http(deployment.rpcUrl)});
  const hash=await wallet.writeContract({address,abi,functionName:'resume'});
  const receipt=await publicClient.waitForTransactionReceipt({hash,timeout:30000});
  const paused=await publicClient.readContract({address,abi,functionName:'paused'});
  if(receipt.status!=='success'||paused) throw new Error('Local vault reset was not confirmed');
  return {paused,hash};
}
