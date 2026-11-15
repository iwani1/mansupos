import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ClipboardCheck, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { api, dateTime } from './api.js';
import { Badge, Empty, Notice, PageHeading, Spinner } from './components.jsx';

function accraDay(){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Accra',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const fields=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function lastSeven(today){
  const epoch=Date.parse(today+'T00:00:00Z');
  return Array.from({length:7},(_,index)=>{
    const day=new Date(epoch-index*86400000).toISOString().slice(0,10);
    return {day,label:new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'numeric',month:'short',
      timeZone:'Africa/Accra'}).format(new Date(day+'T12:00:00Z'))};
  });
}
const emptyReport={first:0,second:0,issues:0,note:''};
const roleLabels={sales:'Sales representative',fulfilment:'Fulfilment officer'};

export default function DailyOperations({user}){
  const [day,setDay]=useState(accraDay);
  const [self,setSelf]=useState(null);
  const [team,setTeam]=useState(null);
  const [report,setReport]=useState(emptyReport);
  const [assignDraft,setAssignDraft]=useState({});
  const [busy,setBusy]=useState('');
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const requestId=useRef(0);
  const canReview=user.role==='owner'||user.role==='manager';

  const load=useCallback(async(date)=>{
    const id=++requestId.current;
    setLoading(true);setError('');setSuccess('');setSelf(null);setTeam(null);
    try{
      const path='?date='+encodeURIComponent(date);
      const [mine,others]=await Promise.all([
        api('/operations/day'+path),canReview?api('/operations/team'+path):Promise.resolve(null),
      ]);
      if(mine.kind!=='local-staff-self-report'||mine.date!==date ||
          !Array.isArray(mine.tasks)||others && (others.kind!=='local-staff-operations-team'||others.date!==date||!Array.isArray(others.members))){
        throw new Error('The staff operations records could not be verified.');
      }
      if(id!==requestId.current)return;
      setSelf(mine);setTeam(others);
      setReport(mine.report?{first:mine.report.first,second:mine.report.second,
        issues:mine.report.issues,note:mine.report.note}:emptyReport);
      if(others)setAssignDraft(Object.fromEntries(others.members.map(member=>[member.id,member.lane||''])));
    }catch(failure){
      if(id===requestId.current)setError(failure.message||'Staff operations could not be loaded.');
    }finally{if(id===requestId.current)setLoading(false);}
  },[canReview]);
  useEffect(()=>{void load(day);return()=>{requestId.current++;};},[day,load]);

  async function changeTask(taskId,done){
    setBusy('task:'+taskId);setError('');setSuccess('');
    try{
      const updated=await api('/operations/task',{method:'POST',body:{taskId,done}});
      if(updated.kind!=='local-staff-self-report')throw new Error('Unverified task response.');
      setSelf(updated);
      if(canReview){
        const updatedTeam=await api('/operations/team?date='+encodeURIComponent(day));
        if(updatedTeam.kind!=='local-staff-operations-team')throw new Error('Team refresh could not be verified.');
        setTeam(updatedTeam);
      }
      setSuccess(done?'Task marked complete.':'Task reopened; the change remains in the activity history.');
    }catch(failure){setError(failure.message||'Task could not be saved.');}
    finally{setBusy('');}
  }
  async function submitReport(event){
    event.preventDefault();setBusy('report');setError('');setSuccess('');
    try{
      const updated=await api('/operations/report',{method:'POST',body:{
        first:Number(report.first),second:Number(report.second),
        issues:Number(report.issues),note:report.note.trim(),
      }});
      if(updated.kind!=='local-staff-self-report')throw new Error('Unverified report response.');
      setSelf(updated);
      if(canReview){
        const updatedTeam=await api('/operations/team?date='+encodeURIComponent(day));
        if(updatedTeam.kind!=='local-staff-operations-team')throw new Error('Team refresh could not be verified.');
        setTeam(updatedTeam);
      }
      setSuccess('Daily report submitted. Earlier submissions remain recorded.');
    }catch(failure){setError(failure.message||'Report could not be submitted.');}
    finally{setBusy('');}
  }
  async function assign(staffId){
    setBusy('assign:'+staffId);setError('');setSuccess('');
    try{
      await api('/operations/assign',{method:'POST',body:{
        staffId,lane:assignDraft[staffId]||null,
      }});
      const updated=await api('/operations/team?date='+encodeURIComponent(day));
      if(updated.kind!=='local-staff-operations-team')throw new Error('Team refresh could not be verified.');
      setTeam(updated);
      setSuccess('Duty assignment saved to the POS activity history.');
    }catch(failure){setError(failure.message||'Assignment could not be saved.');}
    finally{setBusy('');}
  }

  const options=useMemo(()=>lastSeven(self?.today||accraDay()),[self?.today]);
  const isToday=Boolean(self&&day===self.today);
  const isAssigned=Boolean(self?.lane);
  return <div className="daily-operations-page">
    <PageHeading eyebrow="Operations / staff accountability" title="Daily staff operations"
      description="Self-reported opening duties, sales follow-ups and fulfilment handovers — visible to the manager and owner.">
      <button type="button" className="button secondary" onClick={()=>load(day)} disabled={loading||Boolean(busy)}>
        <RefreshCw size={16}/>Refresh
      </button>
    </PageHeading>
    <Notice tone="warning">Checklist ticks and daily figures are staff declarations, not verified order fulfilment,
      live stock, cash balances or WooCommerce payments. Do not include customer names, phone numbers or payment details in notes.</Notice>
    <section className="surface daily-operations-toolbar">
      <label>Business day · Accra time
        <select className="input" value={day} onChange={event=>setDay(event.target.value)} disabled={Boolean(busy)}>
          {options.map(option=><option key={option.day} value={option.day}>{option.label} · {option.day}</option>)}
        </select>
      </label>
      <span className="muted">{day===accraDay()?'Current business day':'Historical review · changes disabled'}</span>
    </section>
    {error&&<Notice tone="error">{error}</Notice>}
    {success&&<Notice tone="success">{success}</Notice>}
    {loading?<Spinner label="Loading local staff records…"/>:self&&<>
      {user.role!=='owner'&&<div className="daily-operations-grid">
        <section className="surface daily-operations-panel">
          <div className="section-heading"><div><span className="eyebrow">My assigned duties</span>
            <h2>{self.laneLabel||'No duty assignment yet'}</h2>
            <p>{isAssigned?`${self.done} of ${self.total} tasks marked complete`:
              'The owner must assign Sales Representative or Fulfilment Officer duties.'}</p>
          </div><Badge tone={self.done===self.total&&self.total?'green':'amber'}>{self.done}/{self.total}</Badge></div>
          {isAssigned?<div className="daily-operations-tasks">{self.tasks.map(task=>
            <label className="daily-operations-task" key={task.id}>
              <input type="checkbox" checked={task.done} disabled={!isToday||Boolean(busy)}
                onChange={event=>changeTask(task.id,event.target.checked)}/>
              <span><strong>{task.label}</strong><small>{task.detail}</small></span>
            </label>)}</div>:
            <Empty icon={ClipboardCheck} title="Waiting for assignment">Ask the owner to assign your workstream in this dashboard.</Empty>}
        </section>
        <section className="surface daily-operations-panel">
          <div className="section-heading"><div><span className="eyebrow">End-of-day handover</span><h2>My daily report</h2>
            <p>Enter activity counts only. Submitting a correction preserves the prior report in the journal.</p>
          </div></div>
          {isAssigned?<form className="daily-operations-form" onSubmit={submitReport}>
            <label>{self.counts[0]}<input className="input" type="number" min="0" max="10000" step="1" required
              value={report.first} disabled={!isToday||Boolean(busy)}
              onChange={event=>setReport(previous=>({...previous,first:event.target.value}))}/></label>
            <label>{self.counts[1]}<input className="input" type="number" min="0" max="10000" step="1" required
              value={report.second} disabled={!isToday||Boolean(busy)}
              onChange={event=>setReport(previous=>({...previous,second:event.target.value}))}/></label>
            <label>Issues needing owner/manager review<input className="input" type="number" min="0" max="10000" step="1" required
              value={report.issues} disabled={!isToday||Boolean(busy)}
              onChange={event=>setReport(previous=>({...previous,issues:event.target.value}))}/></label>
            <label>Short handover note (no customer details)<textarea className="input" rows="3" maxLength={280}
              value={report.note} disabled={!isToday||Boolean(busy)}
              onChange={event=>setReport(previous=>({...previous,note:event.target.value}))}
              placeholder="e.g. Two orders need size confirmation."/></label>
            {self.report&&<small>Latest saved report: {dateTime(self.report.submittedAt)}</small>}
            {isToday&&<button type="submit" className="button primary" disabled={Boolean(busy)}>
              <CheckCircle2 size={16}/>{busy==='report'?'Saving…':self.report?'Submit corrected report':'Submit daily report'}
            </button>}
          </form>:<p className="daily-operations-empty">Your report becomes available after a duty assignment.</p>}
        </section>
      </div>}
      {canReview&&<section className="surface daily-operations-panel">
        <div className="section-heading"><div><span className="eyebrow">Team review · POS ledger</span>
          <h2>Staff accountability</h2>
          <p>Review each account's assigned workstream, reported completion, and outstanding issues.</p>
        </div><Users size={19} aria-hidden="true"/></div>
        {!team?.members.length?<Empty icon={Users} title="No staff accounts yet">
          Staff accounts are created under Staff &amp; permissions. No task or report has been verified.</Empty>:
          <div className="daily-operations-team">{team.members.map(member=>
            <article className="daily-operations-member" key={member.id}>
              <div className="daily-operations-member-header">
                <div><strong>{member.name}</strong><small>{member.role} · {member.active?'Active':'Inactive'}</small></div>
                <Badge tone={member.report?'green':member.lane?'amber':'neutral'}>
                  {member.report?'Report submitted':member.lane?'Report missing':'Not assigned'}
                </Badge>
              </div>
              {user.role==='owner'&&<div className="daily-operations-assign">
                <label>Workstream
                  <select className="input" aria-label={`Duty for ${member.name}`} value={assignDraft[member.id]??member.lane??''}
                    disabled={!member.active||Boolean(busy)}
                    onChange={event=>setAssignDraft(previous=>({...previous,[member.id]:event.target.value}))}>
                    <option value="">Unassigned</option>
                    <option value="sales">Sales representative</option>
                    <option value="fulfilment">Fulfilment officer</option>
                  </select>
                </label>
                <button type="button" className="button secondary small" onClick={()=>assign(member.id)}
                  disabled={!member.active||Boolean(busy)||(assignDraft[member.id]??member.lane??'')===(member.lane||'')}>
                  Save
                </button>
              </div>}
              {member.lane&&<>
                <div className="daily-operations-progress"><span>{roleLabels[member.lane]}</span>
                  <strong>{member.done}/{member.total} completed</strong></div>
                <div className="daily-operations-track" aria-label={`${member.done} of ${member.total} tasks completed`}>
                  <span style={{width:`${member.total?100*member.done/member.total:0}%`}}/></div>
              </>}
              {member.report&&<div className="daily-operations-report">
                <span>{member.lane==='sales'?'Customer follow-ups':'Orders packed'}: <strong>{member.report.first}</strong></span>
                <span>{member.lane==='sales'?'Orders escalated':'Dispatch handovers'}: <strong>{member.report.second}</strong></span>
                <span>Issues: <strong>{member.report.issues}</strong></span>
                {member.report.note&&<p>{member.report.note}</p>}
                <small>Staff-submitted: {dateTime(member.report.submittedAt)}</small>
              </div>}
            </article>)}</div>}
      </section>}
      <p className="report-scope"><ShieldCheck size={14} aria-hidden="true"/> Local POS self-attestation only. This view does not
        verify live sales, physical stock, courier delivery, independent audit evidence or customer payments.</p>
    </>}
  </div>;
}
