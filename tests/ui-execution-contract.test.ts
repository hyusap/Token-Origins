import { test, expect } from "bun:test";
import { canvasFlow } from "../src/flow-model";
import { selectedRun, policyView, graphInputs, runOutcome, decisionRole, isLegacyPolicy, settledExecutionReply } from "../src/policy-view";
import { describeGraph } from "../cre/graph";
import type { CanvasState } from "../shared/types";

const names = ["legacy-rule","nested-and-or-not","false-root-true-branch","true-branch-in-passing-or",
  "guard-blocked-true-root","unsupported-source","mock-sell","failed-write","verified-pause",
  "reserve-guardian-sweep","grant-stream-watching","ccip-evacuation-verified","yield-chase-simulated"];
async function fixture(name:string) {
  return await Bun.file(new URL(`../fixtures/states/${name}.json`,import.meta.url)).json() as {state:CanvasState;expected:any};
}
for (const name of names) test(`UI and voice honor the real engine fixture: ${name}`,async()=>{
  const {state,expected} = await fixture(name);
  const before = JSON.stringify(state);
  const view = policyView(state);
  expect(describeGraph(view.graph)).toBe(expected.policySentence);
  expect(view.summary).toBe(view.run ? expected.policySentence : state.workflow.summary);
  const flow = canvasFlow(state);
  const graphNodes = flow.nodes.filter(n=>n.data.graphNode);
  expect(graphNodes.map(n=>n.data.graphNode!.id).sort()).toEqual(view.graph.nodes.map(n=>n.id).sort());
  const ids = new Set(flow.nodes.map(n=>n.id));
  expect(flow.edges.every(e=>ids.has(e.source)&&ids.has(e.target))).toBe(true);
  const expectedEdges = expected.structure.nodes.flatMap((n:any)=>n.inputs.map((input:string)=>`graph:${input}:${n.id}`));
  expect(flow.edges.filter(e=>e.id.startsWith("graph:") && e.id!=="graph:root-action" && e.id!=="graph:action-vault").map(e=>e.id).sort()).toEqual(expectedEdges.sort());
  const run = state.runs[0];
  if (run) {
    expect(view.graph).toEqual(run.snapshot.graph);
    if (run.status==="no-op") expect(runOutcome(run)).toBe(run.noopReason!);
    if (run.status==="failed") expect(runOutcome(run)).toContain(run.error!);
    if (run.evidence?.simulatedOrder) {
      expect(runOutcome(run)).toMatch(/simulated (sell|order)/i);
      expect(runOutcome(run)).toMatch(/no asset moved/i);
      expect(runOutcome(run)).not.toMatch(/block|pause verified/i);
    }
    // Text/voice settling shares the same authoritative result vocabulary.
    const speaking = structuredClone(state);
    speaking.conversation.push({id:"voice-fixture",role:"user",text:expected.utterance,at:new Date(Date.parse(run.startedAt)+1000).toISOString(),source:"transcribed fixture"});
    // The settled reply speaks only for the run the user selected (a quiet watch check is not selected).
    expect(settledExecutionReply(speaking,"Run queued; preparing")).toBe(selectedRun(speaking)?.id===run.id ? runOutcome(run) : null);
  }
  expect(JSON.stringify(state)).toBe(before);
});

test("nested graphs and two-node sells never masquerade as legacy threshold rules",async()=>{
  expect(isLegacyPolicy((await fixture("legacy-rule")).state.workflow.graph)).toBe(true);
  expect(isLegacyPolicy((await fixture("nested-and-or-not")).state.workflow.graph)).toBe(false);
  expect(isLegacyPolicy((await fixture("mock-sell")).state.workflow.graph)).toBe(false);
  expect(isLegacyPolicy(undefined)).toBe(false);
});
test("a false intermediate in a passing OR stays neutral in UI and narration",async()=>{
  const {state}=await fixture("true-branch-in-passing-or");
  const run=state.runs[0]!;
  expect(run.decisions.some(d=>decisionRole(d)==="node"&&!d.passed)).toBe(true);
  expect(run.decisions.filter(d=>decisionRole(d)!=="node").every(d=>d.passed)).toBe(true);
  expect(runOutcome(run)).not.toContain("failed");
  expect(runOutcome(run)).toContain("Fixture");
});
test("an old selected run preserves its graph and all source identities after the draft and live markets change",async()=>{
  const {state}=await fixture("verified-pause");
  const run=state.runs[0]!;
  state.inspectedRunId=run.id;
  state.workflow.graph=(await fixture("mock-sell")).state.workflow.graph;
  state.workflow.summary="Different draft";
  for(const object of state.objects) if(object.kind==="price"||object.kind==="feed") object.data.price=999999;
  const view=policyView(state);
  expect(view.graph).toEqual(run.snapshot.graph);
  expect(view.summary).toBe(describeGraph(run.snapshot.graph));
  expect(view.action).toBe("Pause grant vault spending");
  for(const observation of run.observations!) {
    const object=view.objects.find(o=>o.provenance.observedAt===observation.observedAt&&o.data.price===observation.usd)!;
    expect(object).toBeDefined();
    expect(object.provenance.address).toBe(observation.address);
    expect(object.data.network).toBe(observation.network);
    expect(object.data.raw).toBe(observation.raw);
  }
  expect(canvasFlow(state).nodes.find(n=>n.id==="action:pause")!.data.state.workflow.summary).toBe("Different draft");
});
test("missing historical observations never display a current market as the frozen execution input",async()=>{
  const {state}=await fixture("verified-pause");
  const run=state.runs[0]!;
  run.observations=[];
  state.inspectedRunId=run.id;
  const view=policyView(state);
  expect(view.objects.filter(o=>o.provenance.label==="Execution observation unavailable").length).toBeGreaterThan(0);
});

test("pre-graph historical runs use their archived threshold rather than the current draft",async()=>{
  const {state}=await fixture("verified-pause");
  const run=state.runs[0]!;
  delete (run.snapshot as any).graph;
  run.snapshot.threshold=1234;
  state.inspectedRunId=run.id;
  state.workflow.graph=(await fixture("mock-sell")).state.workflow.graph;
  const view=policyView(state);
  expect(view.summary).toContain("$1,234");
  expect(view.graph.action.type).toBe("pause-vault");
  expect(view.summary).not.toContain("simulated sell");
});
