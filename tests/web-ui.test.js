import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { mountProductionUi } from '../server/web-ui.js';
import { createApp } from '../server/app.js';

async function fixture(t,mode='live'){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-web-root-'));
  // The actual deployed candidate lives inside a hidden .candidate-* worktree.
  const dir=path.join(temp,'.candidate-web-test','dist');
  fs.mkdirSync(path.join(dir,'assets'),{recursive:true});
  fs.mkdirSync(path.join(dir,'demo'));
  fs.writeFileSync(path.join(dir,'index.html'),'<html><body><div id="root">MansuPOS</div></body></html>');
  fs.writeFileSync(path.join(dir,'assets','test.js'),'console.log("ok");');
  fs.writeFileSync(path.join(dir,'demo','test.txt'),'Do not expose');
  const app=express();
  app.get('/api/health',(_req,res)=>res.json({ok:true,mode}));
  app.use('/api',(_req,res)=>res.status(404).json({error:'API endpoint not found'}));
  mountProductionUi(app,{dist:dir,mode});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{force:true,recursive:true});
  });
  return 'http://127.0.0.1:'+server.address().port;
}

test('production POS returns the HTML app at / and at /index.html',async t=>{
  const base=await fixture(t);
  for(const path of ['/','/index.html','/operations','/weekly-scorecard']){
    const response=await fetch(base+path);
    assert.equal(response.status,200,path);
    assert.match(response.headers.get('content-type'),/^text\/html/,path);
    assert.match(await response.text(),/id="root"/,path);
    assert.match(response.headers.get('cache-control'),/no-cache/,path);
  }
});

test('production POS API and asset privacy remain separate from the SPA fallback',async t=>{
  const base=await fixture(t);
  const health=await fetch(base+'/api/health');
  assert.equal(health.status,200);
  assert.equal((await health.json()).mode,'live');
  const unknown=await fetch(base+'/api/nonexistent');
  assert.equal(unknown.status,404,'An unknown API URL must not serve the HTML app.');
  assert.match(unknown.headers.get('content-type'),/application\/json/);
  const asset=await fetch(base+'/assets/test.js');
  assert.equal(asset.status,200);
  assert.match(asset.headers.get('cache-control'),/immutable/);
  const hidden=await fetch(base+'/demo/test.txt');
  assert.equal(hidden.status,404,'The public live POS must not serve demo files.');
  const body=await hidden.text();
  assert.doesNotMatch(body,/Do not expose/);
  assert.doesNotMatch(body,/id="root"/);
});

test('isolated demo can still serve its own bundled samples',async t=>{
  const base=await fixture(t,'demo');
  const response=await fetch(base+'/demo/test.txt');
  assert.equal(response.status,200);
  assert.equal(await response.text(),'Do not expose');
});

test('complete production app serves homepage from a dot-prefixed candidate worktree',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-web-full-'));
  const dist=path.join(temp,'.candidate-c56a7f27','dist');
  fs.mkdirSync(dist,{recursive:true});
  fs.writeFileSync(path.join(dist,'index.html'),'<html><body><div id="root">Full POS</div></body></html>');
  const env={
    NODE_ENV:'production',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',
    POS_ALLOW_LIVE_WRITES:'false',
    POS_ONLINE_BRIDGE_LIVE_ENABLED:'false',POS_INSTORE_CASH_APPROVED:'false',
    WOO_BASE_URL:'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY:'ck_synthetic_diagnostic',WOO_CONSUMER_SECRET:'cs_synthetic_diagnostic',
    POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com',
    POS_DATA_DIR:path.join(temp,'isolated-ledger'),
  };
  let db;
  let server;
  t.after(async()=>{
    if(server)await new Promise(resolve=>server.close(resolve));
    db?.close();
    fs.rmSync(temp,{recursive:true,force:true});
  });
  const instance=createApp({env});
  db=instance.db;
  mountProductionUi(instance.app,{dist,mode:instance.config.mode});
  server=instance.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  for(const page of ['/','/index.html','/operations']){
    const response=await fetch(base+page);
    assert.equal(response.status,200,page+' must work in hidden candidate worktrees');
    assert.match(await response.text(),/Full POS/,page);
  }
  const health=await (await fetch(base+'/api/health')).json();
  assert.equal(health.ok,true);
  assert.equal(health.mode,'live');
  assert.equal(health.liveReadOnly,true);
  assert.equal((await fetch(base+'/api/unknown')).status,404);
});
