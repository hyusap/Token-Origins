import {parseAbi,parseEther,type Address,type PublicClient,type WalletClient,type Chain,type Account} from 'viem';
import {resolve} from 'node:path';
import {payeeId,CCIP_DESTINATIONS,REPORT_VERSION} from './graph';

/** Anvil's public accounts #1–#3: the rehearsal reserve and two payees. Never use these keys anywhere real. */
export const LOCAL_RESERVE='0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
export const LOCAL_PAYEES={grantee:'0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',insured:'0x90F79bf6EB2c4f870365E785982E1f101E93b906'} as const;
/** Fixed fee the rehearsal CCIP router charges, in wei. */
export const LOCAL_CCIP_FEE=parseEther('0.001');

export interface LocalTreasury {
  address:Address;forwarder:Address;reserve:Address;payees:Record<string,Address>;
  ccipRouter:Address;ccipToken:Address;ccipDestination:string;maxSweepBps:number;maxPaymentWei:string;minPaymentIntervalSeconds:number;
  reportVersion:number;deploymentHash:string;blockNumber:number;
}
const artifact=(name:string)=>Bun.file(resolve(import.meta.dir,`../contracts/out/${name}.sol/${name}.json`)).json();
const routerArtifact=(name:string)=>Bun.file(resolve(import.meta.dir,`../contracts/out/LocalCcipRouter.sol/${name}.json`)).json();

/**
 * Deploys the isolated rehearsal treasury on a localhost chain: the rehearsal
 * forwarder, a GrantVault v3 with a reserve and two registered payees, and a
 * stand-in CCIP router and token (not CCIP; nothing crosses a chain). The vault
 * is funded with ETH and two tokens so every action has something to move.
 */
export async function deployLocalTreasury(client:PublicClient,wallet:WalletClient<any,Chain,Account>,options:{fundEth?:string;reportAgeSeconds?:bigint;minPaymentIntervalSeconds?:number}={}):Promise<LocalTreasury> {
  const deploy=async(json:any,args:unknown[]=[],value?:bigint)=>{
    const hash=await wallet.deployContract({abi:json.abi,bytecode:json.bytecode.object,args,...(value?{value}:{})} as any);
    const receipt=await client.waitForTransactionReceipt({hash});
    if(receipt.status!=='success'||!receipt.contractAddress) throw new Error('Local deployment failed');
    return {address:receipt.contractAddress,hash,blockNumber:Number(receipt.blockNumber)};
  };
  const forwarder=await deploy(await artifact('LocalRehearsalForwarder'));
  const router=await deploy(await routerArtifact('LocalCcipRouter'),[LOCAL_CCIP_FEE]);
  const token=await deploy(await routerArtifact('LocalBnM'));
  const limits={reserve:LOCAL_RESERVE,maxSweepBps:10_000n,maxPaymentWei:parseEther('0.05'),minPaymentInterval:BigInt(options.minPaymentIntervalSeconds??0),
    ccipRouter:router.address,ccipToken:token.address,ccipDestination:BigInt(CCIP_DESTINATIONS['base-sepolia'].chainSelector)};
  const vault=await deploy(await artifact('GrantVault'),[forwarder.address,options.reportAgeSeconds??120n,limits],parseEther(options.fundEth??'1.2049'));
  const vaultAbi=parseAbi(['function setPayee(bytes32,address)','function reportVersion() view returns (uint256)']);
  for(const [name,address] of Object.entries(LOCAL_PAYEES))
    await client.waitForTransactionReceipt({hash:await wallet.writeContract({address:vault.address,abi:vaultAbi,functionName:'setPayee',args:[payeeId(name),address]} as any)});
  const drip=parseAbi(['function drip(address)']);
  for(let i=0;i<2;i++) await client.waitForTransactionReceipt({hash:await wallet.writeContract({address:token.address,abi:drip,functionName:'drip',args:[vault.address]} as any)});
  const version=Number(await client.readContract({address:vault.address,abi:vaultAbi,functionName:'reportVersion'}));
  if(version!==REPORT_VERSION) throw new Error(`Deployed vault reports v${version}, expected v${REPORT_VERSION}`);
  return {address:vault.address,forwarder:forwarder.address,reserve:LOCAL_RESERVE,payees:{...LOCAL_PAYEES},ccipRouter:router.address,ccipToken:token.address,
    ccipDestination:CCIP_DESTINATIONS['base-sepolia'].chainSelector,maxSweepBps:10_000,maxPaymentWei:limits.maxPaymentWei.toString(),minPaymentIntervalSeconds:Number(limits.minPaymentInterval),
    reportVersion:version,deploymentHash:vault.hash,blockNumber:vault.blockNumber};
}
