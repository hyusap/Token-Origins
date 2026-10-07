import {test,expect} from 'bun:test';
import {Engine} from '../server/engine';
import {StateStore} from '../server/store';
import type {GraphObject} from '../shared/types';
const time=()=>new Date().toISOString();
const provenance=()=>({kind:'fixture' as const,source:'Explicit unit adapter',label:'Test only',observedAt:time(),fetchedAt:time()});
test('semantic show_draft selects the newly edited graph and get_run returns the unchanged frozen revision',async()=>{
  const e=new Engine(new StateStore(':memory:'),{
    fetchPrice:async():Promise<GraphObject>=>({id:'price:eth-usd',kind:'price',label:'ETH',data:{price:2500,productId:'ETH-USD'},provenance:provenance(),visible:true,pinned:false}),
    fetchVault:async():Promise<GraphObject>=>({id:'vault:grant',kind:'vault',label:'Test vault',data:{paused:false,fixture:true},provenance:provenance(),visible:true,pinned:false}),loadDeployment:async()=>null,
  });
  try {
    expect((await e.invoke('discover_objects',{operationId:'discover'})).ok).toBe(true);
    expect((await e.invoke('patch_workflow',{expectedRevision:0,patch:{threshold:3000},operationId:'draft-v1'})).ok).toBe(true);
    const snapshot=structuredClone(e.state.workflow.revisions[0]!);
    e.state.runs.unshift({id:'recorded-run',revision:1,snapshot,status:'no-op',evaluationOnly:true,startedAt:time(),completedAt:time(),executionMode:'Recorded evaluation',policyHash:snapshot.policyHash,action:'pause-vault',decisions:[],logs:[]});
    const frozen=JSON.stringify(e.state.runs[0]);
    expect((await e.invoke('get_run',{runId:'recorded-run',operationId:'inspect-v1'})).ok).toBe(true);
    expect(e.state.inspectedRunId).toBe('recorded-run');
    expect((await e.invoke('patch_workflow',{expectedRevision:1,patch:{threshold:2800},operationId:'draft-v2'})).ok).toBe(true);
    expect(e.state.workflow.revision).toBe(2);
    // Editing the draft does not silently replace an intentional historical inspection.
    expect(e.state.inspectedRunId).toBe('recorded-run');
    const before=e.state.canvasView?.sequence||0;
    const shown=await e.invoke('navigate_canvas',{action:'show_draft',operationId:'show-current-draft'});
    expect(shown.ok).toBe(true);expect(shown.summary).toContain('revision 2');expect(e.state.inspectedRunId).toBeUndefined();expect(e.state.focus.objectId).toBe(e.state.workflow.id);expect(e.state.focus.label).toContain('v02');expect(e.state.mode).toBe('compose');expect(e.state.canvasView).toEqual({action:'fit',sequence:before+1});expect(e.state.workflow.threshold).toBe(2800);expect(JSON.stringify(e.state.runs[0])).toBe(frozen);
    const restored=await e.invoke('get_run',{runId:'recorded-run',operationId:'return-frozen'});expect(restored.ok).toBe(true);expect(e.state.inspectedRunId).toBe('recorded-run');expect(e.state.focus.objectId).toBe('run:recorded-run');expect(e.state.runs[0]?.snapshot.threshold).toBe(3000);expect(e.state.workflow.threshold).toBe(2800);expect(JSON.stringify(e.state.runs[0])).toBe(frozen);
  } finally {e.close();}
});
