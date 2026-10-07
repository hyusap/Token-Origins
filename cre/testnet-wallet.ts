import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { resolve } from 'node:path';
const walletPath = () => resolve(import.meta.dir, '../.data/testnet-wallet.json');
/** Dedicated, newly generated test wallet; never reads the user's wallet or desktop credentials. */
export async function testnetAccount(create = false) {
  const path = walletPath();
  const file = Bun.file(path);
  if (!await file.exists()) {
    if (!create) throw new Error('No task testnet wallet. Run bun cre/deploy-testnet.ts --prepare first.');
    await Bun.write(path, JSON.stringify({privateKey:generatePrivateKey(), purpose:'Origins testnet only', createdAt:new Date().toISOString()}), {mode:0o600,createPath:true});
  }
  const raw = await file.json();
  if (raw.purpose !== 'Origins testnet only' || !/^0x[a-fA-F0-9]{64}$/.test(raw.privateKey)) throw new Error('Invalid task testnet wallet');
  return privateKeyToAccount(raw.privateKey);
}
