import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createApp} from '../server/app.js';
import {accraDay} from '../server/daily-operations.js';
import {weekMonday} from '../server/weekly-operations.js';

const silent={debug(){},info(){},warn(){},error(){}};
const dayOffset=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
async function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-weekly-scorecard-'));
  const instance=createApp({env:{POS_MODE:'demo',NODE_ENV:'test',POS_DATA_DIR:dir},api:{},logger:silent});
  const server=instance.app.listen(0,'127.0.0.1');
  await new Promise(done=>server.once('listening',done));
  t.after(async()=>{await new Promise(done=>server.close(done));instance.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port+'/api';
  const response=await fetch(base+'/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,200);
  const owner=(await response.json()).token;
  const db=instance.db;
  function staff(id,role){
    db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(id,id,id+' member',role,'unused-hash',new Date().toISOString());
    const token=randomBytes(32).toString('hex'),now=Date.now();
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,last_seen) VALUES(?,?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'),id,now+3600000,now);
    return token;
  }
  function history(actor,action,subject,date){
    db.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES(?,?,?,?)')
      .run(actor,action,JSON.stringify(subject),date+'T13:00:00.000Z');
  }
  async function call(path,token,method='GET',body){
    const response=await fetch(base+path,{method,headers:{
      'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})
    },...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,json:await response.json()};
  }
  return {owner,db,staff,history,call};
}

test('weekly scorecard counts assigned Mon–Sat days, newest staff reports and owner review evidence',async t=>{
  const {owner,db,staff,history,call}=await setup(t);
  const cashier=staff('sales-person','cashier');
  const manager=staff('packing-person','manager');
  const today=accraDay(),currentMonday=weekMonday(today);
  // On Monday/Tuesday this week's Wednesday is still in the future, so
  // exercise the latest completed working Wednesday instead.
  const monday=today<dayOffset(currentMonday,2)?
    dayOffset(currentMonday,-7):currentMonday;
  const wednesday=dayOffset(monday,2);
  history('demo-owner','operations.assignment',{staffId:'sales-person',lane:'sales'},dayOffset(monday,-1));
  history('demo-owner','operations.assignment',{staffId:'packing-person',lane:'fulfilment'},dayOffset(monday,-1));
  // Historic task/report events model declarations made on a working day, with
  // no Woo adapter, no price/stock writes and no invented live orders.
  history('sales-person','operations.task_done',{day:wednesday,lane:'sales',taskId:'sales.open'},wednesday);
  history('sales-person','operations.task_done',{day:wednesday,lane:'sales',taskId:'sales.followup'},wednesday);
  history('sales-person','operations.report',{day:wednesday,lane:'sales',first:5,second:1,issues:2,note:'Follow up required'},wednesday);
  history('sales-person','operations.report',{day:wednesday,lane:'sales',first:6,second:1,issues:1,note:'Revised counts'},wednesday);
  history('packing-person','operations.task_done',{day:wednesday,lane:'fulfilment',taskId:'fulfilment.qa'},wednesday);
  const beforeSales=db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  const first=await call('/operations/scorecard?week='+monday,owner);
  assert.equal(first.status,200);
  assert.equal(first.json.kind,'local-weekly-staff-scorecard');
  assert.equal(first.json.members.length,2);
  assert.equal(first.json.weekStart,monday);
  const sales=first.json.members.find(x=>x.id==='sales-person');
  const packing=first.json.members.find(x=>x.id==='packing-person');
  const businessDays=Math.min(6,Math.floor((Date.parse(today)-Date.parse(monday))/86400000)+1);
  assert.equal(sales.assignedDays,businessDays);
  assert.equal(sales.completedTasks,2);
  assert.equal(sales.expectedTasks,businessDays*5);
  assert.equal(sales.reportDays,1);
  assert.equal(sales.missingReports,businessDays-1);
  assert.equal(sales.issuesReported,1);
  assert.equal(packing.completedTasks,1);
  assert.equal(packing.reportDays,0);
  assert.equal(sales.days.find(d=>d.date===wednesday).reviewStatus,'unreviewed');
  assert.equal((await call('/operations/scorecard',manager)).status,200);
  assert.equal((await call('/operations/scorecard',cashier)).status,403);
  assert.equal((await call('/operations/scorecard',null)).status,401);
  assert.equal((await call('/operations/scorecard?other=1',owner)).status,400);

  // Managers and cashiers cannot attest that a report has been reviewed.
  const payload={staffId:'sales-person',day:wednesday,decision:'reviewed',note:'Rechecked original handover'};
  assert.equal((await call('/operations/review',manager,'POST',payload)).status,403);
  assert.equal((await call('/operations/review',cashier,'POST',payload)).status,403);
  assert.equal((await call('/operations/review',owner,'POST',{...payload,staffId:'demo-owner'})).status,404);
  assert.equal((await call('/operations/review',owner,'POST',{...payload,staffId:'packing-person'})).status,409,
    'Missing staff report cannot be marked owner reviewed');
  const reviewed=await call('/operations/review',owner,'POST',payload);
  assert.equal(reviewed.status,200);
  assert.equal(reviewed.json.decision,'reviewed');
  const following=(await call('/operations/scorecard?week='+monday,owner)).json;
  const updated=following.members.find(x=>x.id==='sales-person');
  assert.equal(updated.ownerReviewedDays,1);
  assert.equal(updated.days.find(d=>d.date===wednesday).reviewStatus,'reviewed');
  const trail=db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='operations.day_review'").get().n;
  assert.equal(trail,1);

  // Corrections arriving after an owner reviewed the day require fresh review.
  history('sales-person','operations.report',{day:wednesday,lane:'sales',first:7,second:2,issues:4,note:'Corrected later'},wednesday);
  const stale=(await call('/operations/scorecard?week='+monday,owner)).json.members.find(x=>x.id==='sales-person');
  assert.equal(stale.days.find(d=>d.date===wednesday).reviewStatus,'needs_recheck');
  assert.equal(stale.ownerReviewedDays,0);
  assert.equal(stale.recheckDays,1);
  assert.equal(stale.issuesReported,4);
  assert.equal((await call('/operations/review',owner,'POST',{...payload,decision:'follow_up',note:'Review counts'})).status,200);
  const follow=(await call('/operations/scorecard?week='+monday,owner)).json.members.find(x=>x.id==='sales-person');
  assert.equal(follow.followupDays,1);
  assert.equal(follow.days.find(d=>d.date===wednesday).reviewStatus,'follow_up');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,beforeSales);
  assert.throws(()=>db.prepare("UPDATE audit SET action='deleted' WHERE action='operations.day_review'").run(),/append-only/i);
  assert.throws(()=>db.prepare("DELETE FROM audit WHERE action='operations.day_review'").run(),/append-only/i);
});

test('weekly views reject out-of-window dates and do not count unassigned past days',async t=>{
  const {owner,staff,history,call}=await setup(t);
  staff('worker-week','cashier');
  const today=accraDay(),week=weekMonday(today),lastMonday=dayOffset(week,-7);
  for(const invalid of [dayOffset(week,1),dayOffset(week,7),dayOffset(week,-56),'2026-02-30','not-a-week']){
    assert.equal((await call('/operations/scorecard?week='+invalid,owner)).status,400,invalid);
  }
  const past=(await call('/operations/scorecard?week='+lastMonday,owner)).json;
  assert.equal(past.members.find(m=>m.id==='worker-week').assignedDays,0);
  assert.equal(past.members.find(m=>m.id==='worker-week').taskCompletionPercent,null);
  history('demo-owner','operations.assignment',{staffId:'worker-week',lane:'sales'},dayOffset(week,-1));
  const stillPast=(await call('/operations/scorecard?week='+lastMonday,owner)).json;
  assert.equal(stillPast.members.find(m=>m.id==='worker-week').assignedDays,0,
    'Later assignments must not be retroactive to historical weeks');
  assert.equal((await call('/operations/review',owner,'POST',{
    staffId:'worker-week',day:dayOffset(week,-2),decision:'follow_up',note:'Invalid day'
  })).status,409);
  for(const payload of [
    {staffId:'worker-week',day:today,decision:'unknown',note:''},
    {staffId:'worker-week',day:today,decision:'follow_up',note:'x'.repeat(161)},
    {staffId:'worker-week',day:today,decision:'follow_up',note:'line1\nline2'},
    {staffId:'worker-week',day:today,decision:'follow_up',note:'okay',extra:'unexpected'},
  ])assert.equal((await call('/operations/review',owner,'POST',payload)).status,400);
});

test('late owner reviews remain visible for an older week, without retroactive duty assignments',async t=>{
  const {owner,staff,history,call}=await setup(t);
  staff('historic-worker','cashier');
  const current=weekMonday(accraDay()),previous=dayOffset(current,-7),previousWed=dayOffset(previous,2);
  history('demo-owner','operations.assignment',{staffId:'historic-worker',lane:'fulfilment'},dayOffset(previous,-1));
  history('historic-worker','operations.report',{day:previousWed,lane:'fulfilment',first:2,second:1,issues:0,note:'Previous week'},previousWed);
  const before=(await call('/operations/scorecard?week='+previous,owner)).json;
  assert.equal(before.members.find(x=>x.id==='historic-worker').ownerReviewedDays,0);
  assert.equal((await call('/operations/review',owner,'POST',{
    staffId:'historic-worker',day:previousWed,decision:'reviewed',note:'Reviewed after the week ended'
  })).status,200);
  const after=(await call('/operations/scorecard?week='+previous,owner)).json;
  const member=after.members.find(x=>x.id==='historic-worker');
  assert.equal(member.ownerReviewedDays,1);
  assert.equal(member.days.find(d=>d.date===previousWed).reviewNote,'Reviewed after the week ended');

  history('demo-owner','operations.assignment',{staffId:'historic-worker',lane:'sales'},dayOffset(current,-1));
  const historical=(await call('/operations/scorecard?week='+previous,owner)).json;
  assert.equal(historical.members.find(x=>x.id==='historic-worker').days[0].lane,'fulfilment',
    'Workstream changes in later weeks must not rewrite prior-week history');
});
