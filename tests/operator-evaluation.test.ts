import { expect, test } from "bun:test";
import { hasContradictoryPriceRoot } from "../scripts/agent";
import { evaluateGraph, policyGraphSchema, sourceKey, type PolicyGraph } from "../cre/graph";
import { Engine } from "../server/engine";
import { StateStore } from "../server/store";
import { toolDefinitions } from "../server/schemas";

const graph: PolicyGraph = {nodes:[
  {id:"price",kind:"price",source:{type:"exchange-trade",pair:"ETH-USD"}},
  {id:"below",kind:"compare",input:"price",op:"<",value:1},
  {id:"above",kind:"compare",input:"price",op:">=",value:1},
  {id:"root",kind:"and",inputs:["below","above"]},
],root:"root",action:{type:"pause-vault"}};

test("default demo contradiction is false across prices and cannot hide behind an OR branch", () => {
  expect(policyGraphSchema.safeParse(graph).success).toBe(true);
  expect(hasContradictoryPriceRoot(graph)).toBe(true);
  const observedAt = new Date().toISOString();
  for (const usd of [0.00000001,0.99,1,1.01,3000,10000000]) {
    const result=evaluateGraph(graph,{readings:{[sourceKey({type:"exchange-trade",pair:"ETH-USD"})]:{usd,observedAt}},vaultPaused:false,exchangeMaxAgeSeconds:60},Date.parse(observedAt));
    expect(result.root).toBe(false);expect(result.decision).toBe("noop");
  }
  expect(hasContradictoryPriceRoot({...graph,nodes:graph.nodes.map(node=>node.id==="root"?{id:"root",kind:"or",inputs:["below","above"]}:node)})).toBe(false);
});

test("evaluation authority is explicit and default demo requests no signing", async () => {
  expect(toolDefinitions.run_workflow.schema.parse({expectedRevision:1,evaluationOnly:true,operationId:"eval"}).evaluationOnly).toBe(true);
  expect(toolDefinitions.run_workflow.schema.safeParse({expectedRevision:1,evaluationOnly:"true",operationId:"eval"}).success).toBe(false);
  const script=await Bun.file(new URL("../demo/script.json",import.meta.url)).json();
  expect(script.profile).toBe("evaluation");
  expect(script.cues.find((cue:any)=>cue.id==="false-run").text).toContain("evaluationOnly:true");
  expect(script.cues.some((cue:any)=>cue.id==="broadcast")).toBe(false);
  const broadcast=await Bun.file(new URL("../demo/script.broadcast.json",import.meta.url)).json();
  expect(broadcast.cues.some((cue:any)=>cue.id==="broadcast")).toBe(true);
});

test("semantic capabilities preserve static vocabulary and expose safe current CRE readiness", async () => {
  const engine=new Engine(new StateStore(":memory:"));
  try {
    const result=await engine.invoke("get_capabilities",{});
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({executionAuthority:"Chainlink CRE only; no direct wallet signer fallback",actions:[{type:"pause-vault"}]});
    const readiness=result.data!.readiness as Record<string,unknown>;
    expect(readiness.executionAuthority).toBe("chainlink-cre");
    expect(typeof readiness.readyForEvaluation).toBe("boolean");
    expect(typeof readiness.broadcastConfigured).toBe("boolean");
    expect(readiness.authenticated === true || readiness.authenticated === false || readiness.authenticated === null).toBe(true);
    expect(Number.isFinite(Date.parse(String(readiness.checkedAt)))).toBe(true);
    expect(readiness).not.toHaveProperty("privateKey");expect(readiness).not.toHaveProperty("email");expect(readiness).not.toHaveProperty("account");
    expect(engine.state.runs).toHaveLength(0);
  } finally {engine.close();}
},15000);

test("show current draft is an explicit semantic navigation action", () => {
  expect(toolDefinitions.navigate_canvas.schema.parse({action:"show_draft",operationId:"view:draft"})).toEqual({action:"show_draft",operationId:"view:draft"});
});
