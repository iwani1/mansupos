import { z } from 'zod';
import { audit } from './db.js';
import { AppError } from './errors.js';
import { accraDay, LANES } from './daily-operations.js';

const MS=86400000;
const validISO=/^\d{4}-\d{2}-\d{2}$/;
const isoDay=milliseconds=>new Date(milliseconds).toISOString().slice(0,10);
const epoch=day=>Date.parse(day+'T00:00:00Z');
const shift=(day,amount)=>isoDay(epoch(day)+amount*MS);
function validDate(day){
  if(typeof day!=='string'||!validISO.test(day)||!Number.isFinite(epoch(day))||isoDay(epoch(day))!==day)
    throw new AppError('Enter a valid business date in YYYY-MM-DD format.',400);
  return day;
}
export function weekMonday(day){
  validDate(day);
  const diff=(new Date(epoch(day)).getUTCDay()+6)%7;
  return shift(day,-diff);
}
function validateWeek(week,today){
  const current=weekMonday(today),chosen=week?validDate(week):current;
  if(weekMonday(chosen)!==chosen)throw new AppError('Select a Monday to review a business week.',400);
  if(chosen>current||chosen<shift(current,-7*7))
    throw new AppError('Only the current and preceding seven weeks are available.',400);
  return chosen;
}
const reviewSchema=z.object({
  staffId:z.string().min(1).max(128),
  day:z.string(),
  decision:z.enum(['reviewed','follow_up']),
  note:z.string().trim().max(160).refine(s=>!/[\r\n]/.test(s),'Keep the review note to one short line'),
}).strict();
function readSubject(s){
  try{return JSON.parse(s);}catch{return null;}
}
function weeklyEvents(db,start,end){
  const startISO=start+'T00:00:00.000Z',endISO=shift(end,1)+'T00:00:00.000Z';
  const assignments=db.prepare(`SELECT id,actor,action,subject,created_at
    FROM audit WHERE action='operations.assignment' AND created_at < ?
    ORDER BY created_at ASC,id ASC`).all(endISO);
  const events=db.prepare(`SELECT id,actor,action,subject,created_at
    FROM audit WHERE
    (created_at>=? AND created_at<? AND action IN
      ('operations.task_done','operations.task_reopened','operations.report'))
    OR (created_at>=? AND action='operations.day_review')
    ORDER BY id ASC`).all(startISO,endISO,startISO);
  // Owner reviews are often entered days or weeks AFTER the staff workday.
  // Their event timestamp must not be clipped at the end of the reviewed week.
  return {assignments:assignments.map(event=>({...event,data:readSubject(event.subject)})),
    events:events.map(event=>({...event,data:readSubject(event.subject)}))};
}
function assignmentFor(assignments,staffId,day){
  const cutoff=shift(day,1)+'T00:00:00.000Z';
  let lane=null;
  for(const event of assignments){
    if(event.created_at>=cutoff)break;
    const data=event.data;
    if(data?.staffId===staffId&&(data.lane===null||LANES[data.lane]))lane=data.lane;
  }
  return lane;
}
function oneDay(events,staffId,day,lane){
  const done=new Set();
  let report=null,review=null;
  let lastActivityId=0;
  for(const event of events){
    const data=event.data;
    if(data?.day!==day)continue;
    if(event.action==='operations.day_review'){
      if(data.staffId===staffId&&['reviewed','follow_up'].includes(data.decision)){
        review={id:event.id,decision:data.decision,note:data.note||'',at:event.created_at};
      }
      continue;
    }
    if(event.actor!==staffId||data.lane!==lane)continue;
    if(event.action==='operations.task_done'&&LANES[lane].tasks.some(item=>item.id===data.taskId)){
      done.add(data.taskId); lastActivityId=Math.max(lastActivityId,event.id);
    }
    if(event.action==='operations.task_reopened'&&LANES[lane].tasks.some(item=>item.id===data.taskId)){
      done.delete(data.taskId); lastActivityId=Math.max(lastActivityId,event.id);
    }
    if(event.action==='operations.report'){
      report={first:data.first,second:data.second,issues:data.issues,
        submittedAt:event.created_at};lastActivityId=Math.max(lastActivityId,event.id);
    }
  }
  const status=review ? lastActivityId>review.id?'needs_recheck':review.decision : 'unreviewed';
  return {date:day,lane,completed:done.size,total:LANES[lane].tasks.length,
    reported:Boolean(report),issues:report?.issues??null,
    reportedAt:report?.submittedAt||null,reviewStatus:status,
    reviewedAt:review?.at||null,reviewNote:review?.note||''};
}
function scoreOne(member,week,today,{assignments,events}){
  const days=[];
  for(let i=0;i<6;i++){
    const date=shift(week,i);
    if(date>today)break;
    const lane=assignmentFor(assignments,member.id,date);
    if(!lane)continue;
    days.push(oneDay(events,member.id,date,lane));
  }
  const totals={
    assignedDays:days.length,reportDays:days.filter(d=>d.reported).length,
    missingReports:days.filter(d=>!d.reported).length,
    completedTasks:days.reduce((sum,d)=>sum+d.completed,0),
    expectedTasks:days.reduce((sum,d)=>sum+d.total,0),
    issuesReported:days.reduce((sum,d)=>sum+(d.issues||0),0),
    ownerReviewedDays:days.filter(d=>d.reviewStatus==='reviewed').length,
    followupDays:days.filter(d=>d.reviewStatus==='follow_up').length,
    recheckDays:days.filter(d=>d.reviewStatus==='needs_recheck').length,
  };
  return {
    id:member.id,name:member.name,role:member.role,active:Boolean(member.active),
    currentLane:assignmentFor(assignments,member.id,today),
    ...totals,
    taskCompletionPercent:totals.expectedTasks?Math.round(totals.completedTasks/totals.expectedTasks*100):null,
    reportCoveragePercent:totals.assignedDays?Math.round(totals.reportDays/totals.assignedDays*100):null,
    days,
  };
}

export class WeeklyOperations {
  constructor(db){this.db=db;}
  scorecard(weekInput){
    const today=accraDay(),weekStart=validateWeek(weekInput,today);
    const weekEnd=shift(weekStart,6),through=weekEnd<today?weekEnd:today;
    const data=weeklyEvents(this.db,weekStart,through);
    const members=this.db.prepare(`SELECT id,name,role,active FROM users
      WHERE role IN ('manager','cashier') ORDER BY name,id`).all()
      .map(member=>scoreOne(member,weekStart,today,data));
    return {kind:'local-weekly-staff-scorecard',weekStart,weekEnd,today,
      daysShown:Math.min(6,Math.max(0,Math.floor((epoch(today)-epoch(weekStart))/MS)+1)),
      members,scope:'Staff self-reports and owner review annotations in the local POS audit journal. No verified attendance, stock, payment, dispatch, website order, or independently corroborated performance.'};
  }
  review(user,input){
    if(user.role!=='owner')throw new AppError('Only the owner can record a daily review.',403);
    const values=reviewSchema.parse(input);
    const today=accraDay(),current=weekMonday(today);
    const date=validDate(values.day);
    if(date>today || date<shift(current,-49) || new Date(epoch(date)).getUTCDay()===0){
      throw new AppError('Review a past or current working day within the last eight weeks.',400);
    }
    const member=this.db.prepare(`SELECT id,name,role,active FROM users WHERE id=?`).get(values.staffId);
    if(!member||member.role==='owner')throw new AppError('Staff member not found.',404);
    const week=weekMonday(date);
    const read=this.scorecard(week).members.find(item=>item.id===member.id);
    const day=read?.days.find(item=>item.date===date);
    if(!day)throw new AppError('This staff member had no assigned workstream that day.',409);
    if(values.decision==='reviewed'&&!day.reported)
      throw new AppError('A missing staff report requires follow-up, not a completed review.',409);
    // Every review remains append-only. A later task/report correction makes
    // the old review stale and requires an owner's fresh examination.
    audit(this.db,user.id,'operations.day_review',JSON.stringify(values));
    return {ok:true,day:date,staffId:values.staffId,decision:values.decision};
  }
}
