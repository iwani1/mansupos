import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { api, dateTime } from './api.js';
import { Badge, Empty, Notice, PageHeading, Spinner } from './components.jsx';

const MS=86400000;
const iso=stamp=>new Date(stamp).toISOString().slice(0,10);
const monday=day=>{
  const stamp=Date.parse(day+'T00:00:00Z');
  const weekday=(new Date(stamp).getUTCDay()+6)%7;
  return iso(stamp-weekday*MS);
};
function accraDay(){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Accra',year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(new Date());
  const value=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function weeks(){
  const current=monday(accraDay());
  return Array.from({length:8},(_,i)=>{
    const date=iso(Date.parse(current+'T00:00:00Z')-i*7*MS);
    const end=iso(Date.parse(date+'T00:00:00Z')+6*MS);
    return {value:date,label:`${date} to ${end}`};
  });
}
const statuses={
  reviewed:{label:'Owner reviewed',tone:'green'},
  follow_up:{label:'Follow-up required',tone:'red'},
  needs_recheck:{label:'Correction after review',tone:'amber'},
  unreviewed:{label:'Not yet reviewed',tone:'neutral'},
};

export default function WeeklyScorecard({user}){
  const [week,setWeek]=useState(()=>monday(accraDay()));
  const [data,setData]=useState(null);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState('');
  const [notes,setNotes]=useState({});
  const [loading,setLoading]=useState(true);
  const requestId=useRef(0);

  const load=useCallback(async()=> {
    const current=++requestId.current;
    setLoading(true);setData(null);setError('');setMessage('');
    try {
      const result=await api('/operations/scorecard?week='+encodeURIComponent(week));
      if(result?.kind!=='local-weekly-staff-scorecard'||result.weekStart!==week||!Array.isArray(result.members)){
        throw new Error('The weekly source could not be verified.');
      }
      if(current===requestId.current)setData(result);
    }catch(problem){if(current===requestId.current)setError(problem.message||'Weekly records could not be loaded.');}
    finally{if(current===requestId.current)setLoading(false);}
  },[week]);
  useEffect(()=>{void load();},[load]);

  async function review(memberId,day,decision){
    const key=memberId+':'+day;
    setBusy(key);setError('');setMessage('');
    try{
      const note=(notes[key]||'').trim();
      await api('/operations/review',{method:'POST',body:{staffId:memberId,day,decision,note}});
      const refreshed=await api('/operations/scorecard?week='+encodeURIComponent(week));
      if(refreshed?.kind!=='local-weekly-staff-scorecard'||refreshed.weekStart!==week){
        throw new Error('The review was saved, but the scorecard could not be verified. Refresh before further review.');
      }
      setData(refreshed);
      setMessage(decision==='reviewed'?'Owner review recorded in the audit history.':'Follow-up recorded in the audit history.');
    }catch(problem){setError(problem.message||'Owner review could not be saved.');}
    finally{setBusy('');}
  }
  return <div className="weekly-scorecard-page">
    <PageHeading eyebrow="Operations / management review" title="Weekly staff scorecard"
      description="Compare staff checklist completion, reporting consistency, issues and your review follow-ups.">
      <button className="button secondary" onClick={()=>load()} disabled={loading||Boolean(busy)}>
        <RefreshCw size={16}/>Refresh
      </button>
    </PageHeading>
    <Notice tone="warning">This scorecard is derived from self-reported POS checklists and reports.
      Completion percentages are not employee attendance ratings or independent proof of orders,
      stock, money, packaging or delivery. Verify exceptions with original records.</Notice>
    <section className="surface weekly-scorecard-toolbar">
      <label>Review week (Monday–Sunday)
        <select className="input" aria-label="Scorecard week" value={week} onChange={e=>setWeek(e.target.value)}
          disabled={loading||Boolean(busy)}>
          {weeks().map(item=><option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <span>Working-day summaries use Monday–Saturday. Sunday and days not assigned are excluded from task targets.</span>
    </section>
    {error&&<Notice tone="error">{error}</Notice>}
    {message&&<Notice tone="success">{message}</Notice>}
    {loading?<Spinner label="Reading staff scorecards…"/>:data&&<>
      <section className="weekly-scorecard-summary">
        <div><small>Team members</small><strong>{data.members.length}</strong></div>
        <div><small>Reports submitted</small><strong>{data.members.reduce((n,m)=>n+m.reportDays,0)}</strong></div>
        <div><small>Outstanding issues reported</small><strong>{data.members.reduce((n,m)=>n+m.issuesReported,0)}</strong></div>
        <div><small>Owner follow-ups</small><strong>{data.members.reduce((n,m)=>n+m.followupDays+m.recheckDays,0)}</strong></div>
      </section>
      {!data.members.length?<Empty icon={Users} title="No staff accounts">
        Add staff under Staff &amp; permissions, then assign a duty workstream in Daily staff operations.</Empty>:
        <div className="weekly-scorecard-list">{data.members.map(member=>
          <section className="surface weekly-scorecard-person" key={member.id}>
            <div className="section-heading"><div><span className="eyebrow">{member.active?'Active account':'Inactive account'}</span>
              <h2>{member.name}</h2>
              <p>{member.role} · {member.currentLane==='sales'?'Sales representative':member.currentLane==='fulfilment'?
                'Fulfilment officer':'No current workstream'}</p>
            </div><Badge tone={member.missingReports||member.followupDays||member.recheckDays?'amber':'neutral'}>
              {member.assignedDays} assigned {member.assignedDays===1?'day':'days'}
            </Badge></div>
            <div className="weekly-scorecard-metrics">
              <div><small>Checklist completion</small><strong>{member.taskCompletionPercent===null?'—':member.taskCompletionPercent+'%'}</strong>
                <span>{member.completedTasks}/{member.expectedTasks} staff ticks</span></div>
              <div><small>Reports submitted</small><strong>{member.reportDays}/{member.assignedDays}</strong>
                <span>{member.missingReports} missing</span></div>
              <div><small>Reported issues</small><strong>{member.issuesReported}</strong>
                <span>Self-reported, not reconciled</span></div>
              <div><small>Owner-reviewed days</small><strong>{member.ownerReviewedDays}/{member.assignedDays}</strong>
                <span>{member.followupDays+member.recheckDays} follow-up / recheck</span></div>
            </div>
            {member.days.length?<details className="weekly-scorecard-detail">
              <summary>Inspect daily history and owner review</summary>
              <div className="weekly-scorecard-days">{member.days.map(day=>{
                const key=member.id+':'+day.date;
                const tag=statuses[day.reviewStatus]||statuses.unreviewed;
                return <article key={key} className="weekly-scorecard-day">
                  <div className="weekly-scorecard-day-head">
                    <strong>{day.date}</strong><Badge tone={tag.tone}>{tag.label}</Badge>
                  </div>
                  <p>{day.lane==='sales'?'Sales':'Fulfilment'} · {day.completed}/{day.total} tasks marked done
                    · {day.reported?'Staff report submitted':'No staff report'}
                    · {day.issues===null?'Issues not reported':day.issues+' issues reported'}</p>
                  {day.reportedAt&&<small>Latest staff report: {dateTime(day.reportedAt)}</small>}
                  {day.reviewedAt&&<small>Last owner review: {dateTime(day.reviewedAt)}</small>}
                  {day.reviewNote&&<p className="weekly-scorecard-owner-note">Owner note: {day.reviewNote}</p>}
                  {user.role==='owner'&&<div className="weekly-scorecard-review">
                    <label>Owner note (no private customer data)
                      <input className="input" maxLength={160} value={notes[key]||''}
                        onChange={e=>setNotes(prev=>({...prev,[key]:e.target.value}))}
                        disabled={Boolean(busy)} placeholder="e.g. Check disputed pack count"/>
                    </label>
                    <div>
                      <button className="button secondary small" disabled={Boolean(busy)||!day.reported}
                        onClick={()=>review(member.id,day.date,'reviewed')}>Mark reviewed</button>
                      <button className="button secondary small" disabled={Boolean(busy)}
                        onClick={()=>review(member.id,day.date,'follow_up')}>Flag follow-up</button>
                    </div>
                  </div>}
                </article>;
              })}</div>
            </details>:<div className="weekly-scorecard-none"><ClipboardCheck size={18}/>
              No assigned days in this week. Rates are not calculated.</div>}
          </section>
        )}</div>}
      <p className="report-scope"><ShieldCheck size={14}/> This page does not independently verify
        staff attendance, dispatch handover, WooCommerce stock, payment, physical cash or customer delivery.</p>
    </>}
  </div>;
}
