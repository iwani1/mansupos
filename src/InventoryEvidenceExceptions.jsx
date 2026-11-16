import React, {useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {Notice} from './components.jsx';

// Owner-only Phase 5.6. A follow-up note NEVER settles a count or authorizes
// mapping, stock import, sale or payment. All findings remain unverified.
const categories={
  all:'All unresolved evidence',
  count_disagreement:'Staff counts disagree',
  reviewer_evidence_issue:'Reviewer/file issue',
  handoff_action_needed:'Reviewer handoff needed',
  custody_or_source_hold:'Custody/source incomplete',
  other_unverified:'Other unverified evidence',
};
const nextSteps={
  request_independent_recount:'Request a new blind recount',
  inspect_original_outside_pos:'Inspect the original outside POS',
  investigate_sku_variation:'Investigate style / size / SKU identity',
  request_replacement_evidence:'Request replacement document evidence',
  verify_reviewer_identity_offline:'Check reviewer identity outside POS',
  escalate_for_independent_audit:'Escalate to an independent audit',
};
const flagLabels={
  staff_count_disagreement:'Staff physical count declarations disagree',
  custody_or_source_not_ready:'Source or custody documents not ready',
  owner_reported_discrepancy_unverified:'Owner-reported reviewer discrepancy (unverified)',
  owner_reported_review_unavailable:'Owner reports reviewer unavailable',
  authenticated_reviewer_missing:'No active account-assigned reviewer',
  reviewer_grant_revoked_or_stale:'Reviewer grant revoked or stale',
  reviewer_account_reported_issue:'Reviewer account raised an evidence issue',
  reviewer_account_unavailable:'Reviewer account could not review',
  handoff_not_confirmed:'Reviewer handoff not confirmed',
  file_not_available_reported:'Reviewer reported original file unavailable',
  fingerprint_mismatch_reported:'Reviewer-reported document hash mismatch',
  fingerprint_match_not_provenance:'Matching hash is not authenticity proof',
  independent_verification_missing:'Independent verification still required',
};
export default function InventoryEvidenceExceptions(){
  const [status,setStatus]=useState('all');
  const [search,setSearch]=useState('');
  const [page,setPage]=useState(1);
  const [report,setReport]=useState(null);
  const [selection,setSelection]=useState(null);
  const [action,setAction]=useState('request_independent_recount');
  const [note,setNote]=useState('');
  const [busy,setBusy]=useState(false);
  const [posting,setPosting]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const requestId=useRef(0);
  const load=useCallback(async()=>{
    const id=++requestId.current;
    setBusy(true);setError('');
    try{
      const q=new URLSearchParams({
        page:String(page),pageSize:'15',status,search:search.trim(),
      });
      const data=await api('/stock-safety/evidence-exceptions?'+q.toString());
      if(data?.kind!=='owner-inventory-evidence-exception-queue'||
        data.auditOnly!==true||data.caseClosed!==false||
        data.inventoryAccepted!==false||data.checkoutAuthorized!==false||
        data.stockImportAuthorized!==false||!Array.isArray(data.items))
        throw new Error('The server did not confirm an unapproved evidence queue.');
      if(id===requestId.current)setReport(data);
    }catch(e){if(id===requestId.current)setError(e.message||'Could not load evidence queue.');}
    finally{if(id===requestId.current)setBusy(false);}
  },[page,status,search]);
  useEffect(()=>{load();return()=>{requestId.current++;};},[load]);
  function begin(row){
    setSelection({...row,requestId:crypto.randomUUID()});
    setNote('');setAction('request_independent_recount');
    setError('');setNotice('');
  }
  async function submit(event){
    event.preventDefault();
    if(!selection||!report||note.trim().length<12)return;
    setPosting(true);setError('');setNotice('');
    try{
      const result=await api('/stock-safety/evidence-exceptions/followup',{
        method:'POST',body:{
          reportRow:selection.reportRow,
          expectedRef:report.snapshotRef,
          expectedCaseRef:selection.caseRef,
          expectedLatestEventId:selection.latestFollowup?.id??null,
          action,note:note.trim(),requestId:selection.requestId,
        },
      });
      if(result?.kind!=='owner-evidence-investigation-followup'||
        result.recorded!==true||result.caseClosed!==false||
        result.checkoutAuthorized!==false||result.stockImportAuthorized!==false)
        throw new Error('The POS did not confirm the non-approval follow-up record.');
      setSelection(null);setNote('');
      setNotice('Owner follow-up recorded. The evidence issue remains OPEN and no stock has been approved.');
      await load();
    }catch(e){
      setError(e.message||'Could not confirm recording. Refresh before trying again.');
    }finally{setPosting(false);}
  }
  return <section className="surface records-surface" role="region"
    aria-label="Inventory evidence exception register">
    <div className="section-heading">
      <div>
        <span className="eyebrow">Phase 5.6 · Owner investigation journal</span>
        <h3>Unresolved inventory evidence — no approvals</h3>
        <p>Combined staff count, custody, handoff and reviewer-account evidence.
          Every case remains unverified. Investigation notes do not close discrepancies.</p>
      </div>
    </div>
    <Notice tone="warning">
      <strong>Inventory acceptance is locked.</strong> This review page cannot update
      physical stock, import Woo stock, approve identity mappings, create sales,
      receive payments or authorize checkout.
    </Notice>
    {error&&<p role="alert" className="field-hint">{error}</p>}
    {notice&&<p role="status" className="field-hint">{notice}</p>}
    <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'end',marginTop:16}}>
      <label style={{flex:'1 1 210px'}}>Filter unresolved cases
        <select className="input" value={status} disabled={busy||posting}
          onChange={e=>{setStatus(e.target.value);setPage(1);setSelection(null);}}>
          {Object.entries(categories).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 170px'}}>SKU or source row
        <input className="input" type="search" maxLength={64} value={search}
          disabled={posting} onChange={e=>{setSearch(e.target.value);setPage(1);setSelection(null);}}/>
      </label>
      <button className="button secondary" type="button" disabled={busy||posting}
        onClick={load}>{busy?'Checking…':'Refresh evidence queue'}</button>
    </div>
    {report&&<div style={{marginTop:16}}>
      <p className="field-hint"><strong>{report.summary.totalCases}</strong> historical cases,
        {' '}<strong>{report.summary.staffCountDisagreements}</strong> count disagreements,
        {' '}<strong>{report.summary.reviewerEvidenceIssues}</strong> reviewer evidence issues.
        {' '}Independently verified: <strong>0</strong>. Approved: <strong>0</strong>.</p>
      <p className="field-hint">Page {report.page} of {report.pages} · {report.total} matching cases.</p>
      {report.items.length===0?<p>No historical source rows match this filter.</p>:
        <div style={{display:'grid',gap:12}}>
          {report.items.map(row=><article className="surface" key={row.reportRow}
            style={{padding:16}}>
            <h4>Source row {row.reportRow} · {row.sku}</h4>
            <p><strong>Hold classification:</strong> {categories[row.category]||row.category}
              {' · '}<strong>Case closed: NO</strong></p>
            <ul>
              {row.flags.map(flag=><li key={flag}>{flagLabels[flag]||flag.replaceAll('_',' ')}</li>)}
            </ul>
            {row.reviewerAssignments.length>0&&<p className="field-hint">
              Reviewer assignments: {row.reviewerAssignments.length}.
              {' '}Account responses and handoff receipts are claims, not independent proof.
            </p>}
            {row.latestFollowup&&<p className="field-hint">
              Last Owner follow-up: {nextSteps[row.latestFollowup.action]||
                row.latestFollowup.action}
              {' · '}{row.latestFollowup.recordedAt}
              {' — '}{row.latestFollowup.note}
              {' (still OPEN)'}
            </p>}
            <button className="button secondary" type="button" disabled={posting}
              onClick={()=>begin(row)}>Record investigation follow-up</button>
          </article>)}
        </div>}
      <div style={{display:'flex',gap:12,justifyContent:'flex-end',marginTop:18}}>
        <button className="button secondary" type="button" disabled={page<=1||busy||posting}
          onClick={()=>{setPage(x=>x-1);setSelection(null);}}>Previous page</button>
        <button className="button secondary" type="button"
          disabled={page>=report.pages||busy||posting}
          onClick={()=>{setPage(x=>x+1);setSelection(null);}}>Next page</button>
      </div>
    </div>}
    {selection&&<form className="surface" style={{padding:18,marginTop:20}}
      aria-label="Owner inventory evidence investigation follow-up" onSubmit={submit}>
      <h4>Plan further investigation · row {selection.reportRow}</h4>
      <p>There is deliberately no Resolve, Accept, Approve or Override action.
        This records only what the Owner intends to investigate next.</p>
      <label>Next investigation step
        <select className="input" value={action}
          onChange={e=>setAction(e.target.value)} disabled={posting}>
          {Object.entries(nextSteps).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label>Factual note, 12–180 characters (no customer information)
        <textarea className="input" rows={3} minLength={12} maxLength={180}
          value={note} disabled={posting} required
          onChange={e=>setNote(e.target.value)}/>
      </label>
      <div style={{display:'flex',gap:12,marginTop:12}}>
        <button className="button primary" disabled={posting}>
          {posting?'Recording…':'Record open follow-up'}
        </button>
        <button className="button secondary" type="button" disabled={posting}
          onClick={()=>{setSelection(null);setNote('');}}>Cancel</button>
      </div>
    </form>}
  </section>;
}
