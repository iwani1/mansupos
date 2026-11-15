import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { accraDay } from '../server/daily-operations.js';

const silent={debug(){},info(){},warn(){},error(){}};
async function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-daily-ops-'));
  const instance=createApp({env:{POS_MODE:'demo',NODE_ENV:'test',POS_DATA_DIR:dir},api:{},logger:silent});
  const server=instance.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    instance.db.close();fs.rmSync(dir,{recursive:true,force:true});
  });
  const url='http://127.0.0.1:'+server.address().port+'/api';
  const ownerLogin=await fetch(url+'/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(ownerLogin.status,200);
  const owner=(await ownerLogin.json()).token;
  function addStaff(id,role,name){
    instance.db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(id,id,name,role,'not-used-in-fixture',new Date().toISOString());
    const token=randomBytes(32).toString('hex'), timestamp=Date.now();
    const hashed=createHash('sha256').update(token).digest('hex');
    instance.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,last_seen) VALUES(?,?,?,?)')
      .run(hashed,id,timestamp+3600000,timestamp);
    return token;
  }
  async function call(endpoint,token,method='GET',body){
    const response=await fetch(url+endpoint,{method,headers:{
      'Content-Type':'application/json',
      ...(token?{Authorization:'Bearer '+token}:{}),
    },...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  }
  return {db:instance.db,owner,addStaff,call};
}
const count=db=>db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'operations.%'").get().n;
const report={first:8,second:3,issues:1,note:'Two items need size confirmation'};

test('staff operations are owner-assigned, self-attested, append-only and role-scoped',async t=>{
  const {db,owner,addStaff,call}=await setup(t);
  const sales=addStaff('team-sales','cashier','Sales representative');
  const packing=addStaff('team-packing','manager','Fulfilment officer');
  const day=accraDay();

  assert.equal((await call('/operations/team',null)).status,401);
  assert.equal((await call('/operations/team',sales)).status,403);
  assert.equal((await call('/operations/assign',sales,'POST',{staffId:'team-sales',lane:'sales'})).status,403);
  const before=await call('/operations/day',sales);
  assert.equal(before.status,200);
  assert.equal(before.body.lane,null);
  assert.deepEqual(before.body.tasks,[]);
  assert.equal((await call('/operations/task',sales,'POST',{taskId:'sales.open',done:true})).status,403);

  assert.equal((await call('/operations/assign',owner,'POST',{staffId:'team-sales',lane:'sales'})).status,200);
  assert.equal((await call('/operations/assign',owner,'POST',{staffId:'team-packing',lane:'fulfilment'})).status,200);
  assert.equal((await call('/operations/assign',packing,'POST',{staffId:'team-sales',lane:'fulfilment'})).status,403);
  assert.equal((await call('/operations/assign',owner,'POST',{staffId:'demo-owner',lane:'sales'})).status,404);
  assert.equal(count(db),2);

  const own=await call('/operations/day?date='+day,sales);
  assert.equal(own.status,200);
  assert.equal(own.body.kind,'local-staff-self-report');
  assert.equal(own.body.tasks.length,5);
  assert.equal(own.body.done,0);
  assert.equal(own.body.name,'Sales representative');
  assert.equal((await call('/operations/day?userId=team-packing',sales)).status,400,
    'A caller cannot select another staff identity');

  const checked=await call('/operations/task',sales,'POST',{taskId:'sales.open',done:true});
  assert.equal(checked.status,200);
  assert.equal(checked.body.done,1);
  assert.equal(count(db),3);
  await call('/operations/task',sales,'POST',{taskId:'sales.open',done:true});
  assert.equal(count(db),3,'Duplicate task completion is idempotent');
  assert.equal((await call('/operations/task',sales,'POST',{taskId:'fulfilment.qa',done:true})).status,403);
  assert.equal((await call('/operations/task',sales,'POST',{taskId:'sales.open',done:'true'})).status,400);
  assert.equal((await call('/operations/task',owner,'POST',{taskId:'sales.open',done:true})).status,403);

  const reopen=await call('/operations/task',sales,'POST',{taskId:'sales.open',done:false});
  assert.equal(reopen.status,200);
  assert.equal(reopen.body.done,0);
  assert.equal(count(db),4);
  assert.equal((await call('/operations/report',packing,'POST',report)).status,200);
  assert.equal((await call('/operations/report',sales,'POST',report)).status,200);
  assert.equal((await call('/operations/report',sales,'POST',{...report,first:9})).status,200);
  assert.equal((await call('/operations/report',sales,'POST',{...report,issues:-5})).status,400);
  assert.equal((await call('/operations/report',sales,'POST',{...report,note:'x'.repeat(281)})).status,400);
  assert.equal((await call('/operations/report',sales,'POST',{...report,note:'line one\nline two'})).status,400);
  assert.equal((await call('/operations/report',sales,'POST',{...report,actor:'team-packing'})).status,400);
  const self=await call('/operations/day',sales);
  assert.equal(self.body.report.first,9);
  assert.equal(self.body.report.note,report.note);

  const team=await call('/operations/team?date='+day,owner);
  assert.equal(team.status,200);
  assert.equal(team.body.kind,'local-staff-operations-team');
  assert.equal(team.body.members.length,2);
  const salesView=team.body.members.find(m=>m.id==='team-sales');
  assert.equal(salesView.lane,'sales');
  assert.equal(salesView.done,0);
  assert.equal(salesView.report.first,9);
  assert.equal(salesView.report.issues,1);
  assert.equal(salesView.tasks,undefined,'Do not leak individual task detail via summary');
  assert.equal((await call('/operations/team',packing)).status,200);
  assert.equal((await call('/operations/team',sales)).status,403);
  assert.equal((await call('/operations/day',sales)).body.report.first,9);

  const history=db.prepare("SELECT action,subject FROM audit WHERE actor='team-sales' AND action LIKE 'operations.%' ORDER BY id").all();
  assert.deepEqual(history.map(x=>x.action),[
    'operations.task_done','operations.task_reopened','operations.report','operations.report'
  ],'Task reversals and corrected reports must preserve audit history');
  assert.throws(()=>db.prepare("UPDATE audit SET subject='erased' WHERE action='operations.report'").run(),/append-only/i);
  assert.throws(()=>db.prepare("DELETE FROM audit WHERE action='operations.report'").run(),/append-only/i);
  assert.equal((await call('/audit?category=operations&period=all',owner)).status,200);
});

test('operations limit dates, refuse malformed payloads and preserve old workstream history',async t=>{
  const {db,owner,addStaff,call}=await setup(t);
  const worker=addStaff('worker-test','cashier','Test worker');
  const today=accraDay();
  const dayOffset=days=>new Date(Date.parse(today+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
  for(const date of [dayOffset(-7),dayOffset(1),'2026-02-30','2026-13-01','not-a-date']){
    assert.equal((await call('/operations/day?date='+encodeURIComponent(date),worker)).status,400,date);
    assert.equal((await call('/operations/team?date='+encodeURIComponent(date),owner)).status,400,date);
  }
  const previous=await call('/operations/team?date='+dayOffset(-6),owner);
  assert.equal(previous.status,200);
  assert.equal(previous.body.date,dayOffset(-6));
  assert.equal((await call('/operations/assign',owner,'POST',{staffId:'worker-test',lane:'wrong'})).status,400);
  assert.equal((await call('/operations/assign',owner,'POST',{staffId:'missing',lane:'sales'})).status,404);
  await call('/operations/assign',owner,'POST',{staffId:'worker-test',lane:'sales'});
  await call('/operations/task',worker,'POST',{taskId:'sales.open',done:true});
  const markBefore=count(db);
  await call('/operations/assign',owner,'POST',{staffId:'worker-test',lane:'fulfilment'});
  assert.equal((await call('/operations/day',worker)).body.done,0);
  assert.equal((await call('/operations/task',worker,'POST',{taskId:'sales.open',done:true})).status,403);
  await call('/operations/assign',owner,'POST',{staffId:'worker-test',lane:null});
  assert.equal((await call('/operations/day',worker)).body.tasks.length,0);
  assert.equal((await call('/operations/report',worker,'POST',report)).status,403);
  assert.ok(count(db)>markBefore,'Assignment history recorded without removing old tasks');
  const ops=db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'operations.%'").get().n;
  assert.ok(ops>0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n>=0,true);
});
