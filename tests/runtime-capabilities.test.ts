import {test,expect} from 'bun:test';
import {Engine,emptyState} from '../server/engine';
import {StateStore} from '../server/store';
import type {GraphObject} from '../shared/types';
test('loading an old product session refreshes current source/network labels while preserving archived local evidence',()=>{
  const store=new StateStore(':memory:'),saved=emptyState();
  saved.capabilities.price='Old mock quote';saved.capabilities.vault='Actual local contract · Anvil';saved.capabilities.execution='Direct local execution';
  const snapshot={...saved.workflow,revision:1,createdAt:new Date().toISOString(),reason:'Recorded historical policy'};
  saved.runs=[{id:'historical-local',revision:1,snapshot,status:'no-op',startedAt:new Date().toISOString(),executionMode:'Historical local rehearsal',decisions:[],logs:[],target:{address:'0x1111111111111111111111111111111111111111',chainId:31337}}];
  saved.objects=[{id:'vault:grant',kind:'vault',label:'Historical Anvil vault',data:{chainId:31337,address:'0x1111111111111111111111111111111111111111'},visible:false,pinned:false,provenance:{kind:'chain',source:'Recorded Anvil read',label:'Historical local contract',observedAt:new Date().toISOString(),fetchedAt:new Date().toISOString()}}];
  const archivedRuns=JSON.stringify(saved.runs),archivedObjects=JSON.stringify(saved.objects);store.save(saved);
  const e=new Engine(store);try {
    expect(e.state.capabilities.vault).toBe('CRE Sepolia receiver · live read required');expect(e.state.capabilities.price).toBe(emptyState().capabilities.price);expect(e.state.capabilities.execution).toBe('Chainlink CRE · sole product execution authority');expect(JSON.stringify(e.state.runs)).toBe(archivedRuns);expect(JSON.stringify(e.state.objects)).toBe(archivedObjects);
  } finally {e.close();}
});
test('explicit research adapters retain their recorded capability labels',()=>{
  const store=new StateStore(':memory:'),saved=emptyState();saved.capabilities.price='Research price';saved.capabilities.vault='Research local vault';store.save(saved);
  const e=new Engine(store,{fetchVault:async():Promise<GraphObject>=>{throw new Error('Not used by this research-state test');}});try {expect(e.state.capabilities.vault).toBe('Research local vault');expect(e.state.capabilities.price).toBe('Research price');}finally{e.close();}
});
