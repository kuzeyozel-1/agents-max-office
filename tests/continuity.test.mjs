import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, localDay, retryDelay } from '../lib/storage.mjs';
import { createWorkday } from '../lib/workday.mjs';

function fixture(t, initial, think, online = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = path.join(root, 'plan.json'); atomicWrite(plan, '{}');
  const rj = (f,d) => { try { return JSON.parse(fs.readFileSync(path.join(root,f))); } catch { return d; } };
  const wj = (f,v) => atomicWrite(path.join(root,f), JSON.stringify(v));
  wj('workday.json', initial);
  const w = createWorkday({think, pushEvent(){}, isOnline:()=>online, isLimited:()=>true, canRun:()=>online, rj,wj,dataDir:root,rosterSlugs:()=>[],planFile:plan,autoStart:false});
  return {w,root,rj};
}
const task = {id:'abc',slug:'writer',title:'Test',prompt:'Public test',status:'planned'};
const settle = () => new Promise(r=>setTimeout(r,25));
test('atomic replacement leaves a complete JSON file', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atomic-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state.json');atomicWrite(file,'{"v":1}');atomicWrite(file,'{"v":2}');
  assert.equal(JSON.parse(fs.readFileSync(file)).v,2);assert.deepEqual(fs.readdirSync(root),['state.json']);
});
test('Claude limit does not stop free work and output persists',async t=>{
  const {w,root,rj}=fixture(t,{date:localDay(),tasks:[task]},async()=>({ok:true,text:'saved output',via:'Fake'}));
  w.tick();await settle();assert.equal(w.fragment().tasks[0].status,'done');assert.equal(rj('workday.json').tasks[0].status,'done');assert.match(fs.readFileSync(path.join(root,'workday',`${localDay()}-abc.md`),'utf8'),/saved output/);
});
test('quota failure remains pending with bounded retry and no immediate loop',async t=>{
  let calls=0; const {w}=fixture(t,{date:localDay(),tasks:[task]},async()=>{calls++;return {ok:false,text:'quota'};});
  w.tick();await settle();const item=w.fragment().tasks[0];assert.equal(item.status,'planned');assert.ok(item.retryAt>Date.now());w.tick();await settle();assert.equal(calls,1);assert.equal(retryDelay(100),1800000);
});
test('unfinished tasks survive date rollover and old day is archived',async t=>{
  const {w,rj}=fixture(t,{date:'2026-01-01',tasks:[{...task,status:'working'}]},async()=>({ok:true}),false);
  w.tick();assert.equal(w.fragment().tasks[0].id,'abc');assert.equal(w.fragment().tasks[0].status,'planned');assert.equal(rj('workday-history/2026-01-01.json').tasks.length,1);
});
test('restart cannot replace an in-flight task',async t=>{
  let resolve;const {w}=fixture(t,{date:localDay(),tasks:[task]},()=>new Promise(r=>resolve=r));
  w.tick();w.restart();assert.equal(w.fragment().tasks[0].status,'working');resolve({ok:true,text:'done'});await settle();assert.equal(w.fragment().tasks[0].status,'done');
});
test('saved provider result is recovered without calling the API again',async t=>{
  let calls=0;const {w}=fixture(t,{date:localDay(),tasks:[{...task,status:'working',result:{ok:true,text:'checkpoint',via:'Fake'}}]},async()=>{calls++;return {ok:true};});
  w.tick();await settle();assert.equal(calls,0);assert.equal(w.fragment().tasks[0].status,'done');assert.match(w.output('abc'),/checkpoint/);
});
