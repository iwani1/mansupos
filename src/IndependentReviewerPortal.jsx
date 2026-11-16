import React, {useCallback, useEffect, useState} from 'react';
import {api} from './api.js';

// A reviewer can see ONLY evidence metadata assigned by the Owner. No
// original document bytes, counts, pricing or customer information.
const outcomes={
  review_request_seen:'I have seen this review request',
  evidence_issue_reported:'Report a discrepancy requiring investigation',
  unable_to_review:'I cannot review this request',
};
const issues={
  document_hash_mismatch:'File fingerprint does not match',
  signature_missing:'Signature is missing',
  count_numbers_conflict:'Count declarations conflict',
  garment_variation_conflict:'Garment variation is incorrect',
  reviewer_identity_unconfirmed:'Reviewer identity is not established',
  other_evidence_issue:'Other evidence issue',
};
export default function IndependentReviewerPortal({user,logout}){
  const [data,setData]=useState(null);
  const [selected,setSelected]=useState(null);
  const [outcome,setOutcome]=useState('review_request_seen');
  const [issueCode,setIssueCode]=useState('signature_missing');
  const [note,setNote]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const load=useCallback(async()=>{
    const result=await api('/reviewer/cases');
    if(result?.kind!=='reviewer-assigned-request-metadata'||
       result.reviewerAccountAuthenticated!==true||
       result.stockImportAuthorized!==false||result.checkoutAuthorized!==false||
       !Array.isArray(result.cases))
      throw new Error('Reviewer access did not return the restricted evidence contract.');
    setData(result);
  },[]);
  useEffect(()=>{load().catch(e=>setError(e.message));},[load]);
  async function submit(event){
    event.preventDefault();
    if(!selected||note.trim().length<12)return;
    setBusy(true);setError('');setSuccess('');
    try{
      const result=await api('/reviewer/acknowledgements',{method:'POST',body:{
        grantId:selected.grantId,expectedRef:data.snapshotRef,
        outcome,issueCode:outcome==='evidence_issue_reported'?issueCode:null,
        note:note.trim(),requestId:crypto.randomUUID(),
      }});
      if(result?.kind!=='account-authenticated-reviewer-response'||
         result.stockImportAuthorized!==false||result.checkoutAuthorized!==false||
         result.reviewerHumanIdentityVerified!==false)
        throw new Error('Could not confirm the non-approval evidence contract.');
      setSelected(null);setNote('');
      setSuccess('Your account-authenticated response was logged. This is not an approval or independent physical count.');
      await load();
    }catch(e){setError(e.message||'Unable to record this response.');}
    finally{setBusy(false);}
  }
  return <main className="sales-page" style={{maxWidth:940,margin:'30px auto',padding:'24px'}}>
    <section className="surface records-surface" aria-label="Restricted reviewer workspace">
      <header style={{display:'flex',justifyContent:'space-between',gap:16,alignItems:'center',flexWrap:'wrap'}}>
        <div><span className="eyebrow">MANSUTRENDZGH · restricted evidence review</span>
          <h1>Independent reviewer workspace</h1><p>Signed in as {user.username}</p></div>
        <button type="button" className="button secondary" onClick={logout}>Sign out</button>
      </header>
      <div className="notice notice-warning" role="note" style={{padding:16}}>
        <strong>Request metadata only.</strong> This login authenticates a POS account, not the human reviewer or their independence.
        No original document is sent through this page. Seeing a request cannot verify a signature,
        physical stock count, garment variation, mapping, sale or checkout.
      </div>
      {error&&<p role="alert" className="field-hint">{error}</p>}
      {success&&<p role="status" className="field-hint">{success}</p>}
      <button type="button" className="button secondary" onClick={()=>{setError('');load().catch(e=>setError(e.message));}}>Refresh assigned requests</button>
      {!data?<p>Loading assigned request metadata…</p>:
        !data.cases.length?<p>No case has been assigned to this account.</p>:
        <div style={{display:'grid',gap:16,marginTop:20}}>
          {data.cases.map(row=><article className="surface" style={{padding:16}} key={row.grantId}>
            <h2>Assigned source row {row.reportRow}</h2>
            <p><strong>Status:</strong> {row.status.replaceAll('_',' ')}</p>
            {row.sku&&<p><strong>SKU:</strong> {row.sku}</p>}
            <p><strong>Private document SHA-256:</strong> <code style={{overflowWrap:'anywhere'}}>{row.fileSha256}</code></p>
            <p><strong>Custody request:</strong> #{row.custodyRequestId} ·
              <strong> Manifest:</strong> #{row.manifestId} ·
              <strong> Count declarations:</strong> #{row.firstClaimId} / #{row.secondClaimId}</p>
            {row.countDiscrepancyOpen&&<p role="note"><strong>Staff count discrepancy is still OPEN.</strong></p>}
            {row.latestAcknowledgement&&<p>Previous account response: {row.latestAcknowledgement.outcome.replaceAll('_',' ')}
              {' · '}{row.latestAcknowledgement.recordedAt}</p>}
            <p className="field-hint">Original file not delivered in POS. Human identity and physical count remain unverified.</p>
            {row.mayAcknowledge&&<button className="button primary" type="button" onClick={()=>{
              setSelected(row);setOutcome('review_request_seen');setNote('');setError('');setSuccess('');
            }}>Record my response</button>}
          </article>)}
        </div>}
      {selected&&<form className="surface" style={{padding:20,marginTop:24}} aria-label="Reviewer acknowledgement" onSubmit={submit}>
        <h2>Respond to assigned row {selected.reportRow}</h2>
        <p>The response is tied to this login and the exact current document metadata.
          Do not claim that you verified an original file unless separately evidenced outside this system.</p>
        <label>Response category
          <select className="input" value={outcome} onChange={e=>setOutcome(e.target.value)}>
            {Object.entries(outcomes).map(([key,value])=><option value={key} key={key}>{value}</option>)}
          </select>
        </label>
        {outcome==='evidence_issue_reported'&&<label>Discrepancy
          <select className="input" value={issueCode} onChange={e=>setIssueCode(e.target.value)}>
            {Object.entries(issues).map(([key,value])=><option value={key} key={key}>{value}</option>)}
          </select>
        </label>}
        <label>Short factual note (12–180 characters)
          <textarea className="input" minLength={12} maxLength={180} rows={3}
            required value={note} onChange={e=>setNote(e.target.value)}/>
        </label>
        <div style={{display:'flex',gap:12,marginTop:12}}>
          <button type="submit" className="button primary" disabled={busy}>{busy?'Recording…':'Record response'}</button>
          <button type="button" className="button secondary" onClick={()=>setSelected(null)}>Cancel</button>
        </div>
      </form>}
    </section>
  </main>;
}