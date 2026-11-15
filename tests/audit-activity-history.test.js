import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { audit } from '../server/db.js';

test('owner-only activity history supports safe server-side search, time filters and stable keyset pagination',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-activity-audit-'));
  const {app,db}=createApp({env:{POS_MODE:'demo',NODE_ENV:'test',POS_DATA_DIR:dir},
    api:{},logger:{debug(){},info(){},warn(){},error(){}}});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();
    fs.rmSync(dir,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+server.address().port+'/api';
  const signIn=await fetch(url+'/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(signIn.status,200);
  const {token}=await signIn.json();
  const get=async query=>{
    const response=await fetch(url+'/audit'+query,{headers:{Authorization:'Bearer '+token}});
    return {status:response.status,body:await response.json()};
  };
  const old=new Date(Date.now()-50*24*3600000).toISOString();
  // Append-only audit tables intentionally refuse UPDATE/DELETE. Create an
  // old fixture at INSERT time and preserve the immutable historical record.
  db.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES(?,?,?,?)')
    .run('demo-owner','staff.password_reset','MANAGEMENT_REVIEW_16',old);
  for(let i=0;i<16;i++) {
    const type=i%3===0?'auth.login':i%3===1?'staff.deactivated':'wholesale.quote_approved';
    audit(db,'demo-owner',type,'MANAGEMENT_REVIEW_'+i);
  }
  const rows=db.prepare("SELECT id,action,subject FROM audit WHERE subject LIKE 'MANAGEMENT_REVIEW_%' ORDER BY id DESC").all();
  assert.equal(rows.length,17);
  const oldId=rows.at(-1).id;

  const before=db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
  const first=await get('?limit=5&period=all');
  assert.equal(first.status,200);
  assert.equal(first.body.kind,'owner-local-pos-audit-history');
  assert.equal(first.body.source,'local-pos-ledger');
  assert.equal(first.body.readOnly,true);
  assert.equal(first.body.websiteAuditIncluded,false);
  assert.equal(first.body.events.length,5);
  assert.equal(first.body.hasMore,true);
  assert.ok(Number.isSafeInteger(first.body.nextCursor));
  assert.deepEqual(first.body.events.map(x=>x.id),rows.slice(0,5).map(x=>x.id));
  assert.ok(first.body.events.every(x=>x.actorName && x.action));

  // A new audit event arriving between pages must not shift prior results.
  audit(db,'demo-owner','auth.login','NEWER_LATE_ARRIVAL');
  const second=await get('?limit=5&period=all&cursor='+first.body.nextCursor);
  assert.equal(second.status,200);
  assert.deepEqual(second.body.events.map(x=>x.id),rows.slice(5,10).map(x=>x.id));
  const seen=new Set([...first.body.events,...second.body.events].map(x=>x.id));
  assert.equal(seen.size,10);
  const third=await get('?limit=500&period=all&cursor='+second.body.nextCursor);
  assert.equal(third.status,200);
  assert.ok(third.body.events.some(x=>x.id===oldId));
  assert.equal(third.body.hasMore,false);
  assert.equal(third.body.nextCursor,null);

  const authOnly=await get('?limit=100&period=all&category=auth');
  assert.equal(authOnly.status,200);
  assert.ok(authOnly.body.events.length>0);
  assert.ok(authOnly.body.events.every(x=>x.action.startsWith('auth.')));
  const bySubject=await get('?limit=100&period=all&search=MANAGEMENT_REVIEW_5');
  assert.equal(bySubject.status,200);
  assert.equal(bySubject.body.events.length,1);
  assert.equal(bySubject.body.events[0].subject,'MANAGEMENT_REVIEW_5');
  const byAction=await get('?limit=100&period=all&search=wholesale.quote_approved');
  assert.equal(byAction.status,200);
  assert.ok(byAction.body.events.length>=5);
  assert.ok(byAction.body.events.every(x=>x.action==='wholesale.quote_approved'));
  const limited=await get('?limit=500&period=7d&search=MANAGEMENT_REVIEW');
  assert.equal(limited.status,200);
  assert.ok(limited.body.events.every(x=>x.id!==oldId));
  const oldQuery=await get('?limit=100&period=all&search=MANAGEMENT_REVIEW_16');
  assert.equal(oldQuery.body.events.length,1);
  assert.equal(oldQuery.body.events[0].id,oldId);

  // Search is treated as plain text: no SQL syntax or % wildcard semantics.
  assert.equal((await get('?period=all&search='+encodeURIComponent("%"))).status,200);
  assert.equal((await get('?period=all&search='+encodeURIComponent("' OR 1=1 --"))).body.events.length,0);
  assert.equal((await get('?period=all&search='+encodeURIComponent("' OR 1=1 --"))).status,200);

  const unsafe=['?cursor=no','?cursor=0','?cursor=-1','?limit=0','?limit=501',
    '?period=tomorrow','?category=anything','?search='+encodeURIComponent('A'.repeat(81)),
    '?other=unexpected'];
  for(const q of unsafe)assert.equal((await get(q)).status,400,q);
  assert.equal((await fetch(url+'/audit')).status,401);
  db.prepare("UPDATE users SET role='manager' WHERE id='demo-owner'").run();
  assert.equal((await get('?limit=10')).status,403);
  db.prepare("UPDATE users SET role='cashier' WHERE id='demo-owner'").run();
  assert.equal((await get('?limit=10')).status,403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,before+1,
    'Only the explicit simulated late audit event may have been written');
});
