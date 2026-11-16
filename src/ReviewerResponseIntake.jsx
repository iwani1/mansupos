import React, { useRef, useState } from 'react';
import { ClipboardCheck, LockKeyhole, ShieldAlert } from 'lucide-react';
import { api, uuid } from './api.js';
import { Notice, TableRegion } from './components.jsx';

const states={
  all:'All historical source rows',
  request_missing:'No current review request',
  awaiting_external_response:'Requested, no response recorded',
  acknowledgement_unverified:'Owner reports acknowledgement (unverified)',
  reported_discrepancy_open:'Owner reports a review discrepancy (OPEN)',
  review_unavailable:'Review unavailable or declined',
  custody_or_source_hold:'Custody or source evidence incomplete',
};
const outcomes={
  acknowledgement_reported:'Owner reports an external acknowledgement',
  discrepancy_reported:'Owner reports an external evidence discrepancy',
  review_unavailable:'Owner reports review unavailable or declined',
};
const issues={
  document_hash_mismatch:'Original document checksum does not match',
  signature_missing:'Original document signature missing',
  count_numbers_conflict:'Physical count figures conflict',
  garment_variation_conflict:'Style, colour, size or variation mismatch',
  reviewer_identity_unconfirmed:'Reviewer identity not confirmed',
  other_evidence_issue:'Other unresolved evidence problem',
};

// Owner-controlled intake only. No reviewer login or verification is asserted.
export default function ReviewerResponseIntake(){
  const [status,setStatus]=useState('all');
  const [search,setSearch]=useState('');
  const [report,setReport]=useState(null);
  const [busy,setBusy]=useState(false);
  const [posting,setPosting]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [selected,setSelected]=useState(null);
  const [reviewerCode,setReviewerCode]=useState('');
  const [outcome,setOutcome]=useState('discrepancy_reported');
  const [issueCode,setIssueCode]=useState('reviewer_identity_unconfirmed');
  const [note,setNote]=useState('');
  const retry=useRef({key:'',requestId:''});

  const clear=()=>{
    setReport(null);setSelected(null);setError('');setNotice('');
  };
  const load=async(page=1,expectedRef='')=>{
    setBusy(true);setReport(null);setSelected(null);setError('');
    try{
      const params=new URLSearchParams({
        page:String(page),pageSize:'25',status,search:search.trim(),
      });
      if(expectedRef)params.set('expectedRef',expectedRef);
      const x=await api('/stock-safety/reviewer-responses?'+params.toString());
      if(x?.kind!=='owner-reported-external-reviewer-intake'||
         x.auditOnly!==true||x.externalReviewerLoginAvailable!==false||
         x.reviewerIdentityVerified!==false||
         x.independentReviewConfirmed!==false||
         x.documentSignatureVerified!==false||
         x.independentWitnessVerified!==false||
         x.ownerApproved!==false||x.mappingApproved!==false||
         x.stockImportAuthorized!==false||
         x.sharedStockVerified!==false||x.checkoutAuthorized!==false||
         !/^[a-f0-9]{64}$/.test(x.snapshotRef||'')||
         !Array.isArray(x.items)||x.items.length>25||
         !x.stats||!Number.isSafeInteger(x.page)||
         !Number.isSafeInteger(x.pages)||!Number.isSafeInteger(x.total))
        throw new Error('Unverified review-response report failed safety checks.');
      setReport(x);
    }catch(err){setError(err?.message||'Could not read owner-reported review responses.');}
    finally{setBusy(false);}
  };
  const begin=(row)=>{
    setSelected(row);setError('');setNotice('');
    setReviewerCode(row.latestResponse?.reviewerCode||'');
    setOutcome('discrepancy_reported');
    setIssueCode('reviewer_identity_unconfirmed');
    setNote('');
    retry.current={key:'',requestId:''};
  };
  const submit=async(event)=>{
    event.preventDefault();
    if(!selected||!report||posting)return;
    const reviewer=reviewerCode.trim(),remark=note.trim();
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{3,47}$/.test(reviewer)){
      setError('Use a 4–48 character anonymous reviewer reference; no names.');return;
    }
    if(remark.length<12||remark.length>180||/[\r\n]/.test(remark)){
      setError('Enter a one-line evidence note of 12–180 characters, without personal details.');return;
    }
    const body={
      reportRow:selected.reportRow,
      expectedRef:report.snapshotRef,
      expectedLatestResponseId:selected.latestResponse?.id??null,
      custodyRequestId:selected.custodyRequestId,
      manifestId:selected.manifestId,
      fileSha256:selected.fileSha256,
      firstClaimId:selected.firstClaimId,
      secondClaimId:selected.secondClaimId,
      reviewerCode:reviewer,outcome,
      issueCode:outcome==='discrepancy_reported'?issueCode:null,
      note:remark,
    };
    const key=JSON.stringify(body);
    if(retry.current.key!==key)retry.current={key,requestId:uuid()};
    setPosting(true);setError('');setNotice('');
    try{
      const result=await api('/stock-safety/reviewer-responses',{
        method:'POST',body:{...body,requestId:retry.current.requestId},
      });
      if(result?.kind!=='unverified-owner-reported-reviewer-response'||
         result.recorded!==true||result.auditOnly!==true||
         result.reviewerIdentityVerified!==false||
         result.independentReviewConfirmed!==false||
         result.ownerApproved!==false||
         result.stockImportAuthorized!==false||result.checkoutAuthorized!==false)
        throw new Error('The response was not confirmed as an unverified owner report.');
      setSelected(null);setNote('');
      retry.current={key:'',requestId:''};
      setNotice('Owner report recorded, but the reviewer has not independently authenticated or acknowledged it in MansuPOS.');
      await load(report.page);
    }catch(err){
      setError(err?.message||'Could not confirm the reported response. Check previous entries before retrying.');
    }finally{setPosting(false);}
  };
  return <section className="surface records-surface" role="region"
    aria-label="External reviewer response intake">
    <div className="section-heading"><div>
      <span className="eyebrow">Owner / external evidence response preparation</span>
      <h3>Reported reviewer responses — NOT independently confirmed</h3>
      <p>Record a message allegedly received from an external reviewer and
        flag evidence discrepancies for separate investigation.</p>
    </div></div>
    <Notice tone="warning"><LockKeyhole size={16}/>
      <strong>This register contains Owner reports only.</strong> These entries
      are never authenticated reviewer responses. The separate reviewer-only
      portal below can log account responses, but neither workflow verifies
      a human identity, an original file, a signature or physical stock.
    </Notice>
    <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'end'}}>
      <label style={{flex:'1 1 220px'}}>Report status
        <select className="input" value={status} disabled={busy||posting}
          aria-label="Filter reported reviewer response"
          onChange={e=>{setStatus(e.target.value);clear();}}>
          {Object.entries(states).map(([id,label])=>
            <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 200px'}}>SKU, source row or reviewer code
        <input className="input" type="search" maxLength={64}
          aria-label="Search reported reviewer response" value={search}
          disabled={busy||posting} onChange={e=>{setSearch(e.target.value);clear();}}/>
      </label>
      <button className="button secondary" type="button" disabled={busy||posting}
        onClick={()=>load(1)}><ClipboardCheck size={16}/>
        {busy?'Loading…':'Open reviewer response register'}
      </button>
    </div>
    {error&&<Notice tone="error"><ShieldAlert size={16}/>{error}</Notice>}
    {notice&&<Notice tone="warning">{notice}</Notice>}
    {report&&!busy&&<>
      {!report.evidenceVerified&&<Notice tone="error">
        Signed physical source or Woo product identities are incomplete/stale.
        Recording is blocked.</Notice>}
      <div className="overview-metrics">
        <div className="overview-metric"><span className="eyebrow">Responses awaited</span>
          <strong>{report.stats.awaitingReports}</strong></div>
        <div className="overview-metric"><span className="eyebrow">Owner reports acknowledgement</span>
          <strong>{report.stats.ownerReportedAcknowledgements}</strong>
          <small>NOT reviewer-authenticated</small></div>
        <div className="overview-metric"><span className="eyebrow">Evidence discrepancies reported</span>
          <strong>{report.stats.reportedDiscrepancies}</strong>
          <small>Remain open</small></div>
        <div className="overview-metric"><span className="eyebrow">Staff count disputes</span>
          <strong>{report.stats.openStaffCountDiscrepancies}</strong>
          <small>Unaffected by response reports</small></div>
      </div>
      <p className="field-hint">{report.total} source rows ·
        Page {report.page} of {report.pages}. Independently authenticated reviewer accounts: 0.</p>
      {report.items.length>0?<TableRegion label="Reported reviewer response rows">
        <table className="responsive-table"><thead><tr>
          <th>Historical SKU / row</th><th>Reported review status</th>
          <th>Latest owner report</th><th>Owner action</th>
        </tr></thead><tbody>
        {report.items.map(row=><tr key={row.reportRow}>
          <td data-label="Historical SKU / row">
            <strong>{row.sku||'Missing SKU'}</strong> · row {row.reportRow}
            {row.countDiscrepancyOpen&&
              <p className="field-hint">Conflicting staff counts — OPEN</p>}
          </td>
          <td data-label="Reported review status">{states[row.status]||'Unverified'}</td>
          <td data-label="Latest owner report">
            {row.latestResponse?
              <><strong>{outcomes[row.latestResponse.outcome]}</strong>
                <small> · ref {row.latestResponse.reviewerCode}</small>
                {row.latestResponse.issueCode&&
                  <p>{issues[row.latestResponse.issueCode]||'Unresolved issue'}</p>}
                <p>{row.latestResponse.note}</p>
                {row.latestResponse.requiresRecheck&&
                  <p className="field-hint">Evidence changed — recheck report</p>}
              </>:'No reviewer response reported'}
          </td>
          <td data-label="Owner action"><button type="button"
            className="button secondary small"
            disabled={busy||posting||Boolean(selected)||!report.evidenceVerified||!row.mayReport}
            onClick={()=>begin(row)}>Record reported response</button>
          </td>
        </tr>)}
        </tbody></table>
      </TableRegion>:<p className="field-hint">No records match. This does not confirm any review.</p>}
      {selected&&<form className="form-stack" onSubmit={submit}
        aria-label="Record owner-reported reviewer response">
        <h4>Owner response report · source row {selected.reportRow}</h4>
        <p>Custody-review request #{selected.custodyRequestId} ·
          file manifest #{selected.manifestId} ·
          staff claims #{selected.firstClaimId} and #{selected.secondClaimId}.
          Reviewer independence remains unverified.</p>
        <label>Anonymous external reviewer code (not a name)
          <input className="input" required minLength={4} maxLength={48}
            aria-label="Anonymous reviewer reference"
            value={reviewerCode} disabled={posting}
            onChange={e=>setReviewerCode(e.target.value)}
            placeholder="e.g. EXTERNAL_REVIEW_01"/>
        </label>
        <label>Owner-reported outcome
          <select className="input" aria-label="Reported reviewer outcome"
            disabled={posting} value={outcome} onChange={e=>setOutcome(e.target.value)}>
            {Object.entries(outcomes).map(([id,label])=>
              <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        {outcome==='discrepancy_reported'&&<label>Reported discrepancy
          <select className="input" aria-label="Reported evidence discrepancy"
            disabled={posting} value={issueCode}
            onChange={e=>setIssueCode(e.target.value)}>
            {Object.entries(issues).map(([id,label])=>
              <option key={id} value={id}>{label}</option>)}
          </select>
        </label>}
        <label>Private note (12–180 characters, no personal details)
          <textarea className="input" required rows={2} maxLength={180}
            aria-label="Owner-reported reviewer note"
            value={note} disabled={posting}
            onChange={e=>setNote(e.target.value)}
            placeholder="Describe what was reported and what needs checking, not an approval."/>
        </label>
        <div style={{display:'flex',flexWrap:'wrap',gap:10}}>
          <button className="button secondary" type="submit"
            disabled={posting||!report.evidenceVerified}>
            <ClipboardCheck size={16}/>{posting?'Saving…':'Save unverified owner report'}
          </button>
          <button className="button secondary" type="button" disabled={posting}
            onClick={()=>{setSelected(null);setNote('');}}>Cancel</button>
        </div>
      </form>}
      <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:12}}>
        <button className="button secondary" type="button"
          disabled={busy||posting||Boolean(selected)||report.page<=1}
          onClick={()=>load(report.page-1,report.snapshotRef)}>Previous</button>
        <button className="button secondary" type="button"
          disabled={busy||posting||Boolean(selected)||!report.hasMore}
          onClick={()=>load(report.page+1,report.snapshotRef)}>Next</button>
      </div>
      <p className="report-scope">This records owner-reported messages only.
        It cannot confirm reviewer identity, signature, file delivery,
        a correct physical count, a resolved discrepancy, a signed SKU
        mapping, a stock import or checkout authorization.</p>
    </>}
  </section>;
}
