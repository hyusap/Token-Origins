import { expect, test } from "bun:test";
import { Keypair, SystemInstruction, Transaction } from "@solana/web3.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SOLANA_GENESIS, SolanaUtilities, solanaAddress, solToLamports } from "../server/solana";

test("SOL parsing rejects overspend, fractional lamports, unsupported notation, and invalid addresses",()=>{
  expect(solToLamports("0.000000001")).toBe(1);
  expect(solToLamports(0.000000001)).toBe(1);
  expect(solToLamports(0.001)).toBe(1_000_000);
  expect(solToLamports(1)).toBe(1_000_000_000);
  for(const amount of [0,-1,1.000000001,"0.0000000001","1e-3",NaN,Infinity,"2","0x1"]) expect(()=>solToLamports(amount)).toThrow();
  const address = Keypair.generate().publicKey.toBase58();
  expect(solanaAddress(address)).toBe(address);
  for(const address of ["0x123","abc","0".repeat(44),"1".repeat(44)]) expect(()=>solanaAddress(address)).toThrow();
});

// An explicit in-process RPC test double checks signed-byte handling and failure behavior.
// The separate verification script requires a real public devnet receipt.
function harness(genesis = SOLANA_GENESIS.devnet as string, scenario: {balance?:number;corruptReceipt?:boolean;loseSendResponse?:boolean} = {}) {
  const dir = mkdtempSync(join(tmpdir(),"origins-solana-")), recipient = Keypair.generate().publicKey.toBase58();
  let sends = 0, confirmed = false, raw: Transaction | undefined, signature: string | undefined;
  const confirmedSignatures = new Set<string>();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const control={hideChain:false,blockHeight:100,rpcUnavailable:false,chainFailure:null as unknown};
  const fetcher = (async (_url:any, options:any)=>{
    const {method,params} = JSON.parse(options.body);
    if(control.rpcUnavailable) throw new Error("RPC unavailable");
    let result: unknown;
    switch(method) {
      case "getGenesisHash": result=genesis; break;
      case "getBalance": result={context:{slot:100},value:params[0]===recipient ? (confirmed?1_000_000:0):(scenario.balance ?? 100_000_000)};break;
      case "getLatestBlockhash": result={value:{blockhash,lastValidBlockHeight:200}};break;
      case "getMinimumBalanceForRentExemption":result=890880;break;
      case "getFeeForMessage":result={value:5000};break;
      case "getBlockHeight":result=control.blockHeight;break;
      case "getSignatureStatuses":signature=params[0][0];result={value:[!control.hideChain && confirmedSignatures.has(signature!)?{err:control.chainFailure,confirmationStatus:"confirmed"}:null]};break;
      case "sendTransaction": {
        sends++;raw=Transaction.from(Buffer.from(params[0],"base64"));
        expect(raw.verifySignatures()).toBe(true);
        const transfer=SystemInstruction.decodeTransfer(raw.instructions[0]!);
        expect(transfer.toPubkey.toBase58()).toBe(recipient);
        expect(transfer.lamports).toBe(1_000_000n);
        confirmed=true;
        confirmedSignatures.add(signature!);
        if(scenario.loseSendResponse) throw new Error("connection lost after broadcast");
        result=signature;break;
      }
      case "getTransaction": {
        if(!confirmed || control.hideChain) {result=null;break;}
        const sender=raw!.feePayer!.toBase58();
        expect(params[1].maxSupportedTransactionVersion).toBe(1);
        result={slot:101,blockTime:1791320000,meta:{err:control.chainFailure,fee:5000,preBalances:[100_000_000,0],postBalances:[98_995_000,scenario.corruptReceipt?999_999:1_000_000]},
          transaction:{signatures:[signature],message:{accountKeys:[{pubkey:sender},{pubkey:recipient}],instructions:[{program:"system",parsed:{type:"transfer",info:{source:sender,destination:recipient,lamports:1_000_000}}}]}}};break;
      }
      default:throw new Error(`Unexpected RPC method ${method}`);
    }
    return Response.json({jsonrpc:"2.0",id:1,result});
  }) as typeof fetch;
  const options = {dataDir:dir,rpcUrls:{devnet:["https://test.example/rpc"]},fetch:fetcher};
  const utility = new SolanaUtilities(options);
  return {utility,options,recipient,control,dir,sends:()=>sends,cleanup:()=>{utility.close();rmSync(dir,{recursive:true,force:true});}};
}

test("confirmed transfer signs canonical instruction and durable replay never broadcasts twice",async()=>{
  const h=harness();
  try{
    const input={recipient:h.recipient,amountSol:0.001,idempotencyKey:"test-transfer"};
    const pending = h.utility.transferDevnet(input);
    await expect(h.utility.transferDevnet({...input,amountSol:0.002})).rejects.toThrow("different transfer");
    const [first,simultaneous]=await Promise.all([pending,h.utility.transferDevnet(input)]);
    expect(first.status).toBe("confirmed");expect(simultaneous.signature).toBe(first.signature);
    expect(first.recipientBalanceAfter-first.recipientBalanceBefore).toBe(1_000_000);
    expect(h.sends()).toBe(1);
    await expect(h.utility.transferDevnet({...input,amountSol:0.002})).rejects.toThrow("different transfer");
    h.utility.close();
    const restarted=new SolanaUtilities(h.options);
    const replay=await restarted.transferDevnet(input);
    expect(replay.replayed).toBe(true);expect(replay.signature).toBe(first.signature);expect(h.sends()).toBe(1);
    restarted.close();
  }finally{h.cleanup();}
});

test("mainnet endpoint cannot become a devnet signer even when URL says devnet",async()=>{
  const h=harness(SOLANA_GENESIS["mainnet-beta"]);
  try{
    await expect(h.utility.transferDevnet({recipient:h.recipient,amountSol:0.001,idempotencyKey:"wrong-network"})).rejects.toThrow("genesis does not match devnet");
    expect(h.sends()).toBe(0);
  }finally{h.cleanup();}
});

test("wallet inspection validates network and pagination bound before RPC",async()=>{
  const h=harness();
  try{
    await expect(h.utility.inspectWallet({address:h.recipient,limit:21})).rejects.toThrow("between 1 and 20");
    await expect(h.utility.inspectWallet({address:h.recipient,network:"testnet" as any})).rejects.toThrow("Unsupported Solana network");
    await expect(h.utility.transferDevnet({recipient:h.recipient,amountSol:0.001,idempotencyKey:""})).rejects.toThrow("idempotencyKey");
  }finally{h.cleanup();}
});

test("underfunded signer and below-rent recipient fail before any broadcast",async()=>{
  const h=harness(SOLANA_GENESIS.devnet,{balance:1});
  try{
    await expect(h.utility.transferDevnet({recipient:h.recipient,amountSol:0.001,idempotencyKey:"empty-wallet"})).rejects.toThrow("underfunded");
    await expect(h.utility.transferDevnet({recipient:h.recipient,amountSol:0.00001,idempotencyKey:"below-rent"})).rejects.toThrow("rent exemption");
    expect(h.sends()).toBe(0);
  }finally{h.cleanup();}
});

test("uncertain broadcast response recovers stored signature after restart without another transfer",async()=>{
  const h=harness(SOLANA_GENESIS.devnet,{loseSendResponse:true});
  try{
    const input={recipient:h.recipient,amountSol:0.001,idempotencyKey:"lost-response"};
    await expect(h.utility.transferDevnet(input)).rejects.toThrow("connection lost after broadcast");
    expect(h.sends()).toBe(1);
    h.utility.close();
    const restarted=new SolanaUtilities(h.options);
    const receipt=await restarted.transferDevnet(input);
    expect(receipt.status).toBe("confirmed");expect(h.sends()).toBe(1);
    expect((await restarted.transferDevnet(input)).replayed).toBe(true);
    restarted.close();
  }finally{h.cleanup();}
});

test("a status confirmation alone cannot pass a mismatched recipient balance receipt",async()=>{
  const h=harness(SOLANA_GENESIS.devnet,{corruptReceipt:true});
  try{
    await expect(h.utility.transferDevnet({recipient:h.recipient,amountSol:0.001,idempotencyKey:"bad-receipt"})).rejects.toThrow("does not match");
    expect(h.sends()).toBe(1);
  }finally{h.cleanup();}
});

test("distinct transfer intents remain distinct on the same blockhash, with RPC credentials redacted",async()=>{
  const h=harness();
  try{
    const first=await h.utility.transferDevnet({recipient:h.recipient,amountSol:0.001,idempotencyKey:"distinct-one"});
    const second=await h.utility.transferDevnet({recipient:h.recipient,amountSol:0.001,idempotencyKey:"distinct-two"});
    expect(second.signature).not.toBe(first.signature);expect(h.sends()).toBe(2);
    const credentialed=new SolanaUtilities({...h.options,rpcUrls:{devnet:["https://user:password@test.example/api-secret?key=query-secret"]}});
    const wallet=await credentialed.getDevnetWallet();
    expect(wallet.rpcUrl).toBe("https://test.example/[configured-endpoint]");
    credentialed.close();
  }finally{h.cleanup();}
});

test("frozen signer and genesis guards apply to fresh submissions and cached confirmed receipts",async()=>{
  const h=harness();
  try {
    const target=await h.utility.getDevnetActionTarget();
    const input={recipient:h.recipient,amountSol:0.001,idempotencyKey:"frozen",expectedSender:target.sender,expectedGenesisHash:target.genesisHash};
    await expect(h.utility.transferDevnet({...input,expectedGenesisHash:SOLANA_GENESIS["mainnet-beta"]})).rejects.toThrow("expectedGenesisHash");
    await expect(h.utility.transferDevnet({...input,expectedSender:Keypair.generate().publicKey.toBase58()})).rejects.toThrow("signer changed");
    const receipt=await h.utility.transferDevnet(input);
    expect(receipt.sender).toBe(target.sender);
    const replacement=Keypair.generate();
    writeFileSync(join(h.dir,"devnet-wallet.json"),JSON.stringify({network:"devnet",address:replacement.publicKey.toBase58(),secretKey:Array.from(replacement.secretKey)}));
    await expect(h.utility.transferDevnet(input)).rejects.toThrow("signer changed");
    await expect(h.utility.reconcileDevnetTransfer(input)).rejects.toThrow("signer changed");
    await expect(h.utility.transferDevnet({...input,expectedSender:undefined})).rejects.toThrow("immutable task signer");
    expect(h.sends()).toBe(1);
  }finally {h.cleanup();}
});

test("prepared callback is a synchronous durable barrier; recovery cannot broadcast a prepared transaction",async()=>{
  const h=harness();
  try {
    const target=await h.utility.getDevnetActionTarget();
    const input={recipient:h.recipient,amountSol:0.001,idempotencyKey:"barrier",expectedSender:target.sender,expectedGenesisHash:target.genesisHash};
    let preparedSignature:string|undefined;
    await expect(h.utility.transferDevnet({...input,onPrepared:signature=>{preparedSignature=signature;expect(h.sends()).toBe(0);throw new Error("Persistence barrier rejected");}})).rejects.toThrow("Persistence barrier rejected");
    expect(preparedSignature).toBeDefined();expect(h.sends()).toBe(0);
    const pending=await h.utility.reconcileDevnetTransfer(input);
    expect(pending.status).toBe("pending");expect(pending.signature).toBe(preparedSignature);expect(h.sends()).toBe(0);
    h.control.blockHeight=201;
    const expired=await h.utility.reconcileDevnetTransfer(input);
    expect(expired.status).toBe("expired");expect(expired.currentBlockHeight).toBe(201);expect(h.sends()).toBe(0);
  }finally {h.cleanup();}
});

test("read-only recovery verifies an uncertain sent transaction and preserves uncertainty when chain reads vanish",async()=>{
  const h=harness(SOLANA_GENESIS.devnet,{loseSendResponse:true});
  try {
    const target=await h.utility.getDevnetActionTarget();
    const input={recipient:h.recipient,amountSol:0.001,idempotencyKey:"recover-sent",expectedSender:target.sender};
    await expect(h.utility.transferDevnet(input)).rejects.toThrow("connection lost");
    const recovered=await h.utility.reconcileDevnetTransfer(input);
    expect(recovered.status).toBe("confirmed");expect(recovered.receipt?.recipient).toBe(h.recipient);expect(h.sends()).toBe(1);
    h.control.hideChain=true;h.control.blockHeight=201;
    expect((await h.utility.reconcileDevnetTransfer(input)).status).toBe("uncertain");
    h.control.rpcUnavailable=true;
    expect((await h.utility.reconcileDevnetTransfer(input)).status).toBe("uncertain");expect(h.sends()).toBe(1);
  }finally {h.cleanup();}
});

test("reconciliation never creates a missing task wallet; an existing target with no journal is definitively not submitted",async()=>{
  const h=harness();
  try {
    const input={recipient:h.recipient,amountSol:0.001,idempotencyKey:"never-prepared"};
    expect(existsSync(join(h.dir,"devnet-wallet.json"))).toBe(false);
    await expect(h.utility.reconcileDevnetTransfer(input)).rejects.toThrow();
    expect(existsSync(join(h.dir,"devnet-wallet.json"))).toBe(false);
    const target=await h.utility.getDevnetActionTarget();
    const result=await h.utility.reconcileDevnetTransfer({...input,expectedSender:target.sender});
    expect(result.status).toBe("not-submitted");expect(result.fingerprint).toHaveLength(64);expect(h.sends()).toBe(0);
  }finally {h.cleanup();}
});

test("durable intent reservation prevents false absence during pre-signing and freezes caller inputs",async()=>{
  const h=harness();
  try {
    const target=await h.utility.getDevnetActionTarget();
    const input={recipient:h.recipient,amountSol:0.001,idempotencyKey:"preparing",expectedSender:target.sender};
    const work=h.utility.transferDevnet(input);
    input.recipient=Keypair.generate().publicKey.toBase58();input.amountSol=0.002;
    const recovery=await h.utility.reconcileDevnetTransfer({...input,recipient:h.recipient,amountSol:0.001});
    expect(recovery.status).toBe("pending");
    const receipt=await work;
    expect(receipt.recipient).toBe(h.recipient);expect(receipt.lamports).toBe(1_000_000);expect(h.sends()).toBe(1);
  }finally {h.cleanup();}
});

test("failed preparation retains immutable intent across restart without inventing absent chain proof",async()=>{
  const h=harness(SOLANA_GENESIS.devnet,{balance:1});
  try {
    const input={recipient:h.recipient,amountSol:0.001,idempotencyKey:"durable-preparation"};
    await expect(h.utility.transferDevnet(input)).rejects.toThrow("underfunded");
    h.utility.close();
    const restarted=new SolanaUtilities(h.options);
    expect((await restarted.reconcileDevnetTransfer(input)).status).toBe("uncertain");
    await expect(restarted.transferDevnet({...input,amountSol:0.002})).rejects.toThrow("different transfer intent");
    expect(h.sends()).toBe(0);restarted.close();
  }finally {h.cleanup();}
});

test("read-only recovery distinguishes confirmed chain failure from mismatched receipt uncertainty",async()=>{
  const h=harness(SOLANA_GENESIS.devnet,{loseSendResponse:true});
  const mismatch=harness(SOLANA_GENESIS.devnet,{corruptReceipt:true});
  try {
    const input={recipient:h.recipient,amountSol:0.001,idempotencyKey:"chain-failure"};
    await expect(h.utility.transferDevnet(input)).rejects.toThrow("connection lost");
    h.control.chainFailure={InstructionError:[0,"InsufficientFunds"]};
    const failed=await h.utility.reconcileDevnetTransfer(input);
    expect(failed.status).toBe("failed");expect(failed.chainError).toEqual(h.control.chainFailure);expect(h.sends()).toBe(1);
    const bad={recipient:mismatch.recipient,amountSol:0.001,idempotencyKey:"mismatch-recovery"};
    await expect(mismatch.utility.transferDevnet(bad)).rejects.toThrow("does not match");
    expect((await mismatch.utility.reconcileDevnetTransfer(bad)).status).toBe("uncertain");expect(mismatch.sends()).toBe(1);
  }finally {h.cleanup();mismatch.cleanup();}
});

test("journal raw bytes from another operation cannot masquerade as this policy's settlement",async()=>{
  const h=harness();
  try {
    const first={recipient:h.recipient,amountSol:0.001,idempotencyKey:"memo-correlated-first"};
    const second={...first,idempotencyKey:"memo-correlated-second"};
    await h.utility.transferDevnet(first);await h.utility.transferDevnet(second);
    const db=new Database(join(h.dir,"operations.sqlite"));
    const other=db.query("SELECT payload FROM transfers WHERE operation_id = ?").get(second.idempotencyKey) as {payload:string};
    db.query("UPDATE transfers SET payload = ?, receipt = NULL WHERE operation_id = ?").run(other.payload,first.idempotencyKey);
    db.close();
    await expect(h.utility.transferDevnet(first)).rejects.toThrow("operation memo");
    await expect(h.utility.reconcileDevnetTransfer(first)).rejects.toThrow("operation memo");
    expect(h.sends()).toBe(2);
  }finally {h.cleanup();}
});
