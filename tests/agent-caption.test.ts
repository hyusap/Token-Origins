import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBridge, prepareLocalRehearsalVault, operatorEnvironment } from "../scripts/agent";
import { emptyState } from "../server/engine";

test("transport supplies state and publishes captions only after the agent finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "woga-caption-"));
  const calls: { name: string; args: any }[] = [];
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const name = new URL(request.url).pathname.split("/").at(-1)!;
    const args = await request.json();
    calls.push({ name, args });
    if (name === "set_activity" && args.status === "thinking") begin();
    return Response.json({ ok: true, state: emptyState() });
  } });
  try {
    await mkdir(join(root, "operator"));
    await writeFile(join(root, "operator/AGENTS.md"), "Use the supplied canvas state.");
    const executable = join(root, "codex");
    await writeFile(executable, `#!${Bun.which("bun")}\nconst prompt = await Bun.stdin.text();\nawait Bun.write(${JSON.stringify(join(root, "argv.json"))}, JSON.stringify(Bun.argv.slice(2)));\nawait Bun.write(${JSON.stringify(join(root, "prompt.txt"))}, prompt);\nawait Bun.sleep(80);\nconsole.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Bitcoin is $85,275."}}));\nconsole.log(JSON.stringify({type:"turn.completed"}));\n`);
    await chmod(executable, 0o755);
    let state = emptyState();
    const bridge = createAgentBridge({ rootDir: root, codexPath: executable, serverUrl: `http://127.0.0.1:${backend.port}`, getContext: () => state });
    const pending = bridge.submitAgentPrompt("What about Bitcoin?");
    await started;
    expect(calls.some(call => call.name === "submit_utterance")).toBe(false);
    const turn = await pending;
    expect(turn.error).toBeUndefined();
    expect(turn.ok).toBe(true);
    expect(calls.map(call => call.name)).toEqual(["set_activity", "submit_utterance", "set_activity"]);
    expect(calls[1]!.args.text).toBe("What about Bitcoin?");
    expect(calls[2]!.args).toMatchObject({ status: "idle", summary: "Bitcoin is $85,275." });
    const argv = await Bun.file(join(root, "argv.json")).json() as string[];
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain("--ephemeral");
    expect(argv).not.toContain("--model");
    expect(argv).toContain("mcp_servers.woga.startup_timeout_sec=45");
    expect(argv).toContain("mcp_servers.woga.tool_timeout_sec=120");
    const prompt = await Bun.file(join(root, "prompt.txt")).text();
    expect(prompt).toContain("transport owns caption publication");
    expect(prompt).toContain('"revision":0');
    expect(prompt).toContain("do not refetch get_context");
    expect(calls.some(call => call.name === "get_context")).toBe(false);
    state.workflow.threshold = 1234;
    await bridge.submitAgentPrompt("Edit the rule");
    const editedPrompt = await Bun.file(join(root, "prompt.txt")).text();
    expect(editedPrompt).toContain('"threshold":1234');
    expect(editedPrompt).toContain("User: What about Bitcoin?");
    state = emptyState();
    await bridge.submitAgentPrompt("Add Ethereum");
    const freshPrompt = await Bun.file(join(root, "prompt.txt")).text();
    expect(freshPrompt).toContain("(New conversation)");
    expect(freshPrompt).not.toContain("What about Bitcoin?");
    expect(freshPrompt).not.toContain("Edit the rule");

  } finally {
    backend.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("rehearsal preparation preserves contract state without reading or signing", async () => {
  const result = await prepareLocalRehearsalVault("/nonexistent/no-deployment-required");
  expect(result).toEqual({reset:false,reason:"CRE rehearsal preserves contract state."});
});

test("rehearsal checks actual CRE readiness before clearing a canvas", async () => {
  const calls:string[]=[];
  const backend=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const name=new URL(request.url).pathname.split("/").at(-1)!;calls.push(name);
    return Response.json({ok:true,data:{readiness:{readyForEvaluation:false,reason:"Authenticate CRE"}}});
  }});
  try {
    const bridge=createAgentBridge({serverUrl:`http://127.0.0.1:${backend.port}`});
    const result=await bridge.startRehearsal({mode:"manual"});
    expect(result).toMatchObject({ok:false,error:"Authenticate CRE"});
    expect(bridge.rehearsalStatus().running).toBe(false);
    expect(calls).toEqual(["get_capabilities"]);
  } finally {backend.stop(true);}
});

test("explicit broadcast demo fails before reset when broadcast authority is absent", async () => {
  const calls:string[]=[];
  const backend=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const name=new URL(request.url).pathname.split("/").at(-1)!;calls.push(name);
    return Response.json({ok:true,data:{readiness:{readyForEvaluation:true,broadcastConfigured:false}}});
  }});
  try {
    const bridge=createAgentBridge({serverUrl:`http://127.0.0.1:${backend.port}`});
    const result=await bridge.startRehearsal({mode:"manual",profile:"broadcast"});
    expect(result.ok).toBe(false);expect(result.error).toContain("broadcast rehearsal");
    expect(calls).toEqual(["get_capabilities"]);
  } finally {backend.stop(true);}
});

test("operator inherits normal runtime paths and auth but no backend wallet, CRE or RPC credentials", () => {
  const env=operatorEnvironment({HOME:"/normal/home",PATH:"/normal/bin",CODEX_HOME:"/normal/codex",OPENAI_API_KEY:"normal-cli-auth",
    CRE_ETH_PRIVATE_KEY:"blocked-signer",CRE_API_KEY:"blocked-cre",ORIGINS_PRIVATE_KEY:"blocked-wallet",ORIGINS_SEPOLIA_RPC:"blocked-rpc",ALCHEMY_API_KEY:"blocked-provider",CUSTOM_WALLET_SEED:"blocked-seed",ORIGINS_BACKEND_URL:"blocked-inherited-target",BUN_OPTIONS:"blocked-injection"});
  expect(env).toEqual({HOME:"/normal/home",PATH:"/normal/bin",CODEX_HOME:"/normal/codex",OPENAI_API_KEY:"normal-cli-auth"});
});

test("spawned operator and its logs never inherit or persist backend authority", async () => {
  const root=await mkdtemp(join(tmpdir(),"woga-env-boundary-"));
  const protectedVars={CRE_ETH_PRIVATE_KEY:"fixture-cre-signer-do-not-persist",CRE_API_KEY:"fixture-cre-auth-do-not-persist",ORIGINS_PRIVATE_KEY:"fixture-wallet-do-not-persist",ORIGINS_SEPOLIA_RPC:"https://fixture-rpc.example/private-token",ALCHEMY_API_KEY:"fixture-rpc-auth-do-not-persist"};
  const previous=Object.fromEntries(Object.keys(protectedVars).map(key=>[key,process.env[key]]));
  const calls:any[]=[];
  const backend=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){calls.push(await request.json());return Response.json({ok:true,state:emptyState()});}});
  try {
    for(const [key,value] of Object.entries(protectedVars))process.env[key]=value;
    await mkdir(join(root,"operator"));await writeFile(join(root,"operator/AGENTS.md"),"Use the supplied canvas state.");
    const executable=join(root,"codex");
    await writeFile(executable,`#!${Bun.which("bun")} --no-env-file
await Bun.stdin.text();
await Bun.write(${JSON.stringify(join(root,"child-env.json"))},JSON.stringify({HOME:process.env.HOME,PATH:process.env.PATH,...Object.fromEntries(${JSON.stringify(Object.keys(protectedVars))}.map(key=>[key,process.env[key]??null])),args:Bun.argv.slice(2)}));
console.error(${JSON.stringify(protectedVars.CRE_API_KEY)});
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:${JSON.stringify('Known credential '+protectedVars.CRE_ETH_PRIVATE_KEY+' withheld.')}}}));
console.log(JSON.stringify({type:"turn.completed"}));
`);
    await chmod(executable,0o755);
    const bridge=createAgentBridge({rootDir:root,codexPath:executable,serverUrl:`http://127.0.0.1:${backend.port}`,getContext:()=>emptyState()});
    const turn=await bridge.submitAgentPrompt("Inspect readiness only.");
    expect(turn.ok).toBe(true);
    const child=await Bun.file(join(root,"child-env.json")).json();
    expect(child.HOME).toBe(process.env.HOME);expect(child.PATH).toBe(process.env.PATH);
    for(const key of Object.keys(protectedVars))expect(child[key]).toBeNull();
    expect(child.args.some((arg:string)=>arg.includes('mcp_servers.woga.args=')&&arg.includes('--no-env-file'))).toBe(true);
    expect(child.args.some((arg:string)=>arg.includes('mcp_servers.woga.env=')&&arg.includes('ORIGINS_BACKEND_URL'))).toBe(true);
    const trace=await Bun.file(turn.traceFile).text();
    const stderr=await Bun.file(turn.traceFile.replace('.jsonl','.stderr.log')).text();
    const archived=await Bun.file(join(root,".data/rehearsal-turns.jsonl")).text();
    for(const secret of Object.values(protectedVars)) {expect(trace).not.toContain(secret);expect(stderr).not.toContain(secret);expect(archived).not.toContain(secret);expect(JSON.stringify(calls)).not.toContain(secret);}
    expect(turn.summary).toContain("[REDACTED]");expect(stderr).toContain("[REDACTED]");
  } finally {
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
    backend.stop(true);await rm(root,{recursive:true,force:true});
  }
},15000);
