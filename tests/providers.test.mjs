import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('429 falls through, persists cooldown, and private context is not sent remotely',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'providers-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 process.env.FARM_DATA_DIR=root;process.env.FARM_CONFIG=path.join(root,'config.json');process.env.TEST_AI_KEY='dummy';
 fs.writeFileSync(process.env.FARM_CONFIG,JSON.stringify({providers:[{name:'First',baseUrl:'https://one.invalid',model:'test',keyEnv:'TEST_AI_KEY'},{name:'Second',baseUrl:'https://two.invalid',model:'test',keyEnv:'TEST_AI_KEY'}]}));
 const original=globalThis.fetch;const sent=[];t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return url.includes('one.invalid')?new Response('',{status:429,headers:{'retry-after':'3600'}}):Response.json({choices:[{message:{content:'OK'}}]});};
 const providers=await import('../lib/providers.mjs');const r=await providers.ask({full:'PRIVATE',safe:'PUBLIC'});
 assert.equal(r.provider,'Second');assert.equal(sent.length,2);assert.equal(sent[1].body.messages[0].content,'PUBLIC');
 const persisted=JSON.parse(fs.readFileSync(path.join(root,'provider-state.json')));assert.ok(persisted[0][1].cooldownUntil>Date.now());
 const restarted=await import('../lib/providers.mjs?restart');await restarted.ask({full:'PRIVATE',safe:'PUBLIC'});assert.equal(sent.length,3);assert.match(sent[2].url,/two.invalid/);
 await restarted.ask({full:'PRIVATE'});assert.equal(sent.length,3);
});
