import { expect, test } from "bun:test";
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

test("composed mutually exclusive price comparisons always yield a no-op", () => {
  expect(policyGraphSchema.safeParse(graph).success).toBe(true);
  const observedAt = new Date().toISOString();
  for (const usd of [0.00000001,0.99,1,1.01,3000,10000000]) {
    const result=evaluateGraph(graph,{readings:{[sourceKey({type:"exchange-trade",pair:"ETH-USD"})]:{usd,observedAt}},vaultPaused:false,exchangeMaxAgeSeconds:60},Date.parse(observedAt));
    expect(result.root).toBe(false);expect(result.decision).toBe("noop");
  }
});

test("evaluation authority requires an explicit boolean", () => {
  expect(toolDefinitions.run_workflow.schema.parse({expectedRevision:1,evaluationOnly:true,operationId:"eval"}).evaluationOnly).toBe(true);
  expect(toolDefinitions.run_workflow.schema.safeParse({expectedRevision:1,evaluationOnly:"true",operationId:"eval"}).success).toBe(false);

});

test("semantic capabilities preserve static vocabulary and expose safe current CRE readiness", async () => {
  const engine=new Engine(new StateStore(":memory:"));
  try {
    const result=await engine.invoke("get_capabilities",{});
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({executionAuthority:"Chainlink CRE only; no direct wallet signer fallback",actions:[{type:"pause-vault"},{type:"sweep"},{type:"pay"},{type:"evacuate"}]});
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
