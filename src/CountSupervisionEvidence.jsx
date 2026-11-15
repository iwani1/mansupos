import React, { useState, useRef } from 'react';
import { AlertTriangle, ClipboardCheck, LockKeyhole, Search } from 'lucide-react';
import { api, uuid } from './api.js';
import { Notice, TableRegion } from './components.jsx';

const states={
  all:'All physical source rows',
  identity_hold:'Identity on hold',
  waiting_for_two_counts:'Two staff declarations missing',
  count_discrepancy_open:'Count discrepancies (still open)',
  supervision_note_stale:'Earlier supervisor note needs recheck',
  supervision_note_unverified:'Supervisor note recorded, not verified',
  supervision_note_needed:'Supervisor note still needed',
};
const actions={
  observed_count_procedure:'Declare that I personally observed the counting procedure',
  request_signed_evidence:'Request signed independent evidence',
  flag_discrepancy:'Flag discrepant counts for investigation',
};

// Owner-only LOCAL observation declarations, not independent validation.
export default function CountSupervisionEvidence(){
  const [filter,setFilter]=useState('all');
  const [search,setSearch]=useState('');
  const [report,setReport]=useState(null);
  const [loading,setLoading]=useState(false);
  const [posting,setPosting]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [selected,setSelected]=useState(null);
  const [action,setAction]=useState('request_signed_evidence');
  const [documentCode,setDocumentCode]=useState('');
  const [note,setNote]=useState('');
  const retry=useRef({key:'',requestId:''});
  const clear=()=>{setReport(null);setSelected(null);setError('');setMessage('');};

  const load=async(page=1,expectedRef='')=>{
    setLoading(true);setReport(null);setError('');
    try{
      const params=new URLSearchParams({
        page:String(page),pageSize:'25',status:filter,search:search.trim(),
      });
      if(expectedRef)params.set('expectedRef',expectedRef);
      const data=await api('/stock-safety/count-supervision?'+params.toString());
      if(data?.kind!=='local-count-supervision-evidence'||
         data.auditOnly!==true||data.physicallyWitnessed!==false||
         data.independentWitnessVerified!==false||
         data.ownerApproved!==false||data.mappingApproved!==false||
         data.stockImportAuthorized!==false||data.sharedStockVerified!==false||
         data.checkoutAuthorized!==false||
         !/^[a-f0-9]{64}$/.test(data.snapshotRef||'')||
         !Array.isArray(data.items)||data.items.length>25||
         !data.totals||!Number.isSafeInteger(data.page)||
         !Number.isSafeInteger(data.pages)||!Number.isSafeInteger(data.total)){
        throw new Error('Unexpected count-supervision evidence response. No stock action is authorized.');
      }
      setReport(data);
    }catch(failure){
      setError(failure?.message||'Cannot read supervised count declarations.');
    }finally{setLoading(false);}
  };
  const begin=item=>{
    setSelected(item);setError('');setMessage('');
    setAction(item.countStage==='discrepant_claims'?
      'flag_discrepancy':'request_signed_evidence');
    setDocumentCode('');setNote('');
    retry.current={key:'',requestId:''};
  };
  const submit=async(event)=>{
    event.preventDefault();
    if(!selected||!report||posting)return;
    const remark=note.trim();
    const doc=documentCode.trim();
    if(remark.length<8||remark.length>180||/[\r\n]/.test(remark)){
      setError('Write a one-line supervisor note of 8–180 characters.');return;
    }
    if(doc&&!/^[A-Za-z0-9][A-Za-z0-9_-]{3,47}$/.test(doc)){
      setError('Use a private evidence code of 4–48 letters, digits, underscores or dashes.');return;
    }
    const payload={
      reportRow:selected.reportRow,expectedRef:report.snapshotRef,
      firstClaimId:selected.firstClaimId,secondClaimId:selected.secondClaimId,
      expectedLatestNoteId:selected.latestNote?.id??null,
      action,documentCode:doc||null,note:remark,
    };
    const key=JSON.stringify(payload);
    if(retry.current.key!==key)retry.current={key,requestId:uuid()};
    setPosting(true);setError('');setMessage('');
    try{
      const answer=await api('/stock-safety/count-supervision',{
        method:'POST',body:{...payload,requestId:retry.current.requestId},
      });
      if(answer?.kind!=='unverified-count-supervision-note'||
         answer.recorded!==true||answer.auditOnly!==true||
         answer.independentWitnessVerified!==false||
         answer.ownerApproved!==false||
         answer.stockImportAuthorized!==false||
         answer.checkoutAuthorized!==false)
        throw new Error('The local observation was not confirmed as an unverified note.');
      setSelected(null);setNote('');setDocumentCode('');
      retry.current={key:'',requestId:''};
      setMessage('Supervisor note recorded locally. No physical stock has been verified or approved.');
      await load(report.page);
    }catch(failure){
      setError(failure?.message||'Could not confirm the note. Inspect the journal before retrying.');
    }finally{setPosting(false);}
  };
  return <section className="surface records-surface" role="region"
    aria-label="Supervisor count evidence register">
    <div className="section-heading"><div>
      <span className="eyebrow">Owner / physical count observation records</span>
      <h3>Supervisor count evidence — declarations only</h3>
      <p>Link first and second staff declarations to an owner observation,
        follow-up reason or private paper-file reference.</p>
    </div></div>
    <Notice tone="warning"><LockKeyhole size={16}/>
      <strong>Not an independent witness certificate.</strong> A signed-in
      owner note does not authenticate another person, a photograph, or the
      actual garment. Discrepancies remain unresolved and checkout stays locked.
    </Notice>
    <div style={{display:'flex',flexWrap:'wrap',gap:12,alignItems:'end'}}>
      <label style={{flex:'1 1 210px'}}>Evidence-review status
        <select className="input" aria-label="Filter supervisor count evidence"
          disabled={loading||posting} value={filter}
          onChange={e=>{setFilter(e.target.value);clear();}}>
          {Object.entries(states).map(([code,label])=>
            <option key={code} value={code}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 180px'}}>Historical SKU or source row
        <input className="input" type="search" aria-label="Search count evidence"
          value={search} disabled={loading||posting} maxLength={64}
          placeholder="SKU or report row"
          onChange={e=>{setSearch(e.target.value);clear();}}/>
      </label>
      <button className="button secondary" type="button" disabled={loading||posting}
        onClick={()=>load(1)}><Search size={16}/>
        {loading?'Checking…':'Open supervisor evidence'}
      </button>
    </div>
    {loading&&<p role="status" className="field-hint">
      Reading signed-in account declarations; no product, payment or stock writes.</p>}
    {error&&<Notice tone="error"><AlertTriangle size={16}/>{error}</Notice>}
    {message&&<Notice tone="warning">{message}</Notice>}
    {report&&!loading&&<>
      {!report.evidenceVerified&&<Notice tone="error">
        The source or Woo product observation is incomplete/stale. Do not record an owner declaration.
      </Notice>}
      <div className="overview-metrics">
        <div className="overview-metric"><span className="eyebrow">Awaiting both staff counts</span>
          <strong>{report.totals.awaitingTwoCounts}</strong></div>
        <div className="overview-metric"><span className="eyebrow">Discrepancies open</span>
          <strong>{report.totals.openDiscrepancies}</strong></div>
        <div className="overview-metric"><span className="eyebrow">Owner notes recorded</span>
          <strong>{report.totals.unverifiedNotes}</strong>
          <small>Unverified observations</small></div>
        <div className="overview-metric"><span className="eyebrow">Physical witnesses verified</span>
          <strong>0</strong><small>Not supported in this phase</small></div>
      </div>
      <p className="field-hint">{report.total} rows · Page {report.page} of {report.pages}</p>
      {report.items.length>0?
        <TableRegion label="Supervisor physical count evidence rows">
          <table className="responsive-table"><thead><tr>
            <th>Source row / SKU</th><th>Counter accounts</th>
            <th>Count status</th><th>Latest owner observation</th><th>Record</th>
          </tr></thead><tbody>
          {report.items.map(item=><tr key={item.reportRow}>
            <td data-label="Source row / SKU">
              <strong>{item.sku||'Missing SKU'}</strong> · Row {item.reportRow}</td>
            <td data-label="Counter accounts">
              {item.firstCounterAccountId||'No first claim'}
              {' / '}{item.secondCounterAccountId||'No second claim'}</td>
            <td data-label="Count status">
              {states[item.status]||'Unverified count'}
            </td>
            <td data-label="Latest owner observation">
              {item.latestNote?
                <><strong>{actions[item.latestNote.action]}</strong>
                  {item.latestNote.requiresRecheck&&
                    <small> · Earlier note requires new review</small>}
                  <p>{item.latestNote.note}</p>
                  {item.latestNote.documentCode&&
                    <small>Private evidence code: {item.latestNote.documentCode}</small>}
                </>:'No owner observation'}
            </td>
            <td data-label="Record">
              <button className="button secondary small" type="button"
                disabled={loading||posting||Boolean(selected)||
                  !report.evidenceVerified||
                  !item.firstClaimId||!item.secondClaimId||
                  item.status==='identity_hold'}
                onClick={()=>begin(item)}>
                Record supervisor note
              </button>
            </td>
          </tr>)}
          </tbody></table>
        </TableRegion>:
        <p className="field-hint">No rows match this filter. This does not clear stock for trading.</p>}
      {selected&&<form className="form-stack" onSubmit={submit}
        aria-label="Record supervisor observation claim">
        <h3>Supervisor observation for row {selected.reportRow} — NOT VERIFIED</h3>
        <p>First claim #{selected.firstClaimId}, second claim #{selected.secondClaimId}.
          Both linked accounts must be distinct. No supervisor statement can
          resolve an inventory discrepancy or authorize stock.</p>
        <label>What is being recorded?
          <select className="input" aria-label="Choose supervisor evidence action"
            value={action} disabled={posting} onChange={e=>setAction(e.target.value)}>
            {Object.entries(actions).map(([key,label])=>
              <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label>Private paper-file reference code (optional; no personal data)
          <input className="input" maxLength={48} value={documentCode}
            aria-label="Private evidence reference code" disabled={posting}
            onChange={e=>setDocumentCode(e.target.value)}
            placeholder="e.g. COUNT_2026_NOV_01"/>
        </label>
        <label>Supervisor observation or follow-up note
          <textarea className="input" required rows={2} maxLength={180}
            aria-label="Supervisor count observation note"
            disabled={posting} value={note} onChange={e=>setNote(e.target.value)}
            placeholder="Describe the observed procedure or unresolved issue, not an approval."/>
        </label>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          <button className="button secondary" type="submit"
            disabled={posting||!report.evidenceVerified}>
            <ClipboardCheck size={16}/>{posting?'Saving…':'Save unverified supervisor note'}
          </button>
          <button className="button secondary" type="button" disabled={posting}
            onClick={()=>{setSelected(null);setNote('');}}>Cancel</button>
        </div>
      </form>}
      <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:12}}>
        <button className="button secondary" type="button"
          disabled={loading||posting||Boolean(selected)||report.page<=1}
          onClick={()=>load(report.page-1,report.snapshotRef)}>Previous</button>
        <button className="button secondary" type="button"
          disabled={loading||posting||Boolean(selected)||!report.hasMore}
          onClick={()=>load(report.page+1,report.snapshotRef)}>Next</button>
      </div>
      <p className="report-scope">This register holds unverified owner
        statements only; there is no document upload, independent witness
        identity check, signed-stock approval, Woo adjustment or checkout.</p>
    </>}
  </section>;
}
