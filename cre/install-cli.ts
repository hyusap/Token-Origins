/** Installs only the pinned official CRE binary into this repository. No login or user credentials. */
import {resolve} from 'node:path';
const platforms:Record<string,{name:string;hash:string;binary:string}>={
  'darwin-arm64':{name:'cre_darwin_arm64.zip',hash:'b72d94ca7b3a6a88dbb68205c6a00c2edfb107814fb3dab1c15264aebdb0a7a0',binary:'cre_v1.37.0_darwin_arm64'},
  'darwin-x64':{name:'cre_darwin_amd64.zip',hash:'6f1aa58a375cb8286f253ce867a1fae5d2b9aa0070e0960de4405fdf899d2cfc',binary:'cre_v1.37.0_darwin_amd64'},
};
const artifact=platforms[`${process.platform}-${process.arch}`];
if(!artifact)throw new Error('This pinned installer supports macOS. See official Chainlink CLI installation docs for Linux/Windows.');
const response=await fetch(`https://github.com/smartcontractkit/cre-cli/releases/download/v1.37.0/${artifact.name}`,{signal:AbortSignal.timeout(120000)});
if(!response.ok)throw new Error(`Official binary download failed (${response.status})`);
const bytes=await response.arrayBuffer();
const hash=new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
if(hash!==artifact.hash)throw new Error('Official release checksum mismatch; refusing to install');
const archive=resolve(import.meta.dir,'bin',artifact.name);
await Bun.write(archive,bytes);
const binDir=resolve(import.meta.dir,'bin');
for(const args of [['unzip','-o',archive,'-d',binDir],['mv',resolve(binDir,artifact.binary),resolve(binDir,'cre')],['chmod','+x',resolve(binDir,'cre')]]) {
  const proc=Bun.spawn(args,{stdout:'inherit',stderr:'inherit'});
  if(await proc.exited!==0)throw new Error(`CRE installation command failed: ${args[0]}`);
}
const proc=Bun.spawn([resolve(binDir,'cre'),'version'],{stdout:'inherit',stderr:'inherit'});
if(await proc.exited!==0)throw new Error('Installed CLI did not report version');
console.log('Installed pinned checksum-verified CRE CLI. No account authentication attempted.');
