import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createCodex} from '../lib/codex.mjs';
import {routeAI} from '../lib/ai-router.mjs';

function fakeProcess(events, code=0, check=()=>{}) {
 return (_bin,args,options)=>{
  check(args,options);const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdin=new EventEmitter();
  p.stdin.end=()=>queueMicrotask(()=>{for(const e of events)p.stdout.emit('data',JSON.stringify(e)+'\n');p.emit('close',code);});p.kill=()=>p.emit('close',1);return p;
 };
}
function setup(t,spawnProcess){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,c:createCodex({dataDir:dir,enabled:true,binary:process.execPath,checkLogin:async()=>true,spawnProcess})};}
test('Claude limit routes to Codex before remote free provider',async()=>{
 const seen=[];const r=await routeAI({mode:'oto',claudeReady:false,codexReady:true,claude:async()=>{throw Error('must not call');},codex:async()=>{seen.push('codex');return {ok:true};},free:async()=>{seen.push('free');return {ok:true};}});assert.equal(r.ok,true);assert.deepEqual(seen,['codex']);
});
test('free task quota spills to Codex, never Claude',async()=>{
 const seen=[];await routeAI({mode:'oto',noClaude:true,claudeReady:true,codexReady:true,free:async()=>{seen.push('free');return {ok:false};},codex:async()=>{seen.push('codex');return {ok:true};},claude:async()=>{throw Error('must not call');}});assert.deepEqual(seen,['free','codex']);
});
test('Codex failure falls through and explicit Claude mode remains explicit',async()=>{
 let n=0;const options={mode:'oto',claudeReady:false,codexReady:true,codex:async()=>({ok:false}),free:async()=>{n++;return {ok:true};}};
 assert.equal((await routeAI(options)).ok,true);assert.equal(n,1);assert.equal((await routeAI({...options,mode:'claude'})).ok,false);assert.equal(n,1);
});
test('Codex result persists and runner requests read-only isolation',async t=>{
 const {dir,c}=setup(t,fakeProcess([{type:'item.completed',item:{type:'agent_message',text:'Taslak'}}],0,(args,opts)=>{assert.equal(args[args.indexOf('--sandbox')+1],'read-only');assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('features.shell_tool=false'));assert.ok(path.isAbsolute(opts.cwd));}));
 await c.refreshAuth();const r=await c.ask('public test');assert.equal(r.text,'Taslak');assert.equal(c.status().busy,false);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'codex-state.json'))).lastText,'Taslak');
});
test('Codex quota persists cooldown across restart',async t=>{
 const {dir,c}=setup(t,fakeProcess([{type:'turn.failed',error:{message:'usage limit reached'}}],1));await c.refreshAuth();assert.equal((await c.ask('test')).ok,false);assert.equal(c.status().state,'beklemede');
 const restart=createCodex({dataDir:dir,enabled:true,binary:process.execPath,checkLogin:async()=>true});await restart.refreshAuth();assert.equal(restart.ready(),false);
});
test('timeout closes runner without leaving it busy',async t=>{
 const {dir}=setup(t,()=>{});const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdin=new EventEmitter();p.stdin.end=()=>{};p.kill=()=>{p.emit('close',1);};
 const c=createCodex({dataDir:dir,enabled:true,binary:process.execPath,checkLogin:async()=>true,spawnProcess:()=>p,timeoutMs:10});await c.refreshAuth();assert.equal((await c.ask('test')).ok,false);assert.equal(c.status().busy,false);assert.match(c.status().error,/zaman aşımı/);
});
