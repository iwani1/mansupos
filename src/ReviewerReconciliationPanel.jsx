import React,{useCallback,useEffect,useState} from 'react';
import {api} from './api.js';

// Reviewer-only metadata and evidence-ISSUE report. The Owner's provisional
// count, private note, pricing, customers and files are never returned here.
const findings={
  requires_independent_recount:'A truly independent new physical recount is required',
  original_document_unavailable:'I cannot inspect the original count document',
  product_variation_uncertain:'Style, colour, size or Woo variation is uncertain',
  witness_identity_not_proven:'Human reviewer identity / independence is not proven',
  other_evidence_problem:'Another evidence problem requires investigation',
};
const intents={
  request_blind_recount:'New blind physical recount requested',
  inspect_original_count_document:'Original count-sheet inspection requested',
  investigate_product_variation:'Variation identity investigation requested',
  prepare_provisional_count:'Owner reported a provisional count (private, unverified)',
};
export default function ReviewerReconciliationPanel(){
  const [register,setRegister]=useState(null);
  const [selection,setSelection]=useState(null);
  const [finding,setFinding]=useState('requires_independent_recount');
  const [note,setNote]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{
    const result=await api('/reviewer/reconciliation-packets');
    if(result?.kind!=='reviewer-provisional-reconciliation-metadata'||
      result.provisionalOnly!==true||result.inventoryAccepted!==false||
      result.reconciliationApproved!==false||
      result.checkoutAuthorized!==false||result.stockImportAuthorized!==false||
      !Array.isArray(result.items))
      throw new Error('The server did not return restricted, unapproved metadata.');
    // Defense in depth: response should never expose private proposed units.
    if(result.items.some(row=>'proposedUnits' in row||'note' in row||
      'ownerNote' in row||'originalFile' in row))
      throw new Error('Reviewer packet incorrectly exposed private evidence.');
    setRegister(result);
  },[]);
  useEffect(()=>{load().catch(e=>setError(e.message));},[load]);
  async function submit(event){
    event.preventDefault();
    if(!selection||note.trim().length<12||!register)return;
    setBusy(true);setError('');setNotice('');
    try{
      const result=await api('/reviewer/reconciliation-packets/response',{
        method:'POST',body:{
          packetId:selection.packetId,
          expectedReviewerRef:register.reviewerRef,
          finding,note:note.trim(),requestId:crypto.randomUUID(),
        },
      });
      if(result?.kind!=='reviewer-provisional-reconciliation-objection'||
        result.inventoryAccepted!==false||result.reconciliationApproved!==false||
        result.checkoutAuthorized!==false||result.stockImportAuthorized!==false)
        throw new Error('The reviewer issue was not confirmed as non-approving.');
      setSelection(null);setNote('');
      setNotice('Your POS account issue report was recorded. It does not prove independent witnessing or close any stock discrepancy.');
      await load();
    }catch(e){setError(e.message||'Could not record the proposed-packet issue.');}
    finally{setBusy(false);}
  }
  return <section className="surface records-surface" role="region"
    aria-label="Assigned provisional reconciliation packet issues"
    style={{padding:18,marginTop:20}}>
    <h2>Provisional reconciliation requests — report issues only</h2>
    <p>These are Owner planning requests, NOT approved count quantities.
      Your restricted account can report an evidence problem. It cannot
      certify physical stock or authenticate your real-world identity.</p>
    {error&&<p role="alert" className="field-hint">{error}</p>}
    {notice&&<p role="status" className="field-hint">{notice}</p>}
    <button type="button" className="button secondary"
      onClick={()=>load().catch(e=>setError(e.message))}>Refresh my assigned proposals</button>
    {!register?<p>Loading case metadata…</p>:
      register.items.length===0?<p>No current reconciliation proposal is assigned to this account.</p>:
      <div style={{display:'grid',gap:12,marginTop:16}}>
        {register.items.map(x=><article key={x.packetId}
          className="surface" style={{padding:14}}>
          <h3>Source row {x.reportRow} · packet #{x.packetId}</h3>
          <p><strong>Owner intent:</strong> {intents[x.intent]||x.intent}</p>
          <p><strong>State:</strong> {x.status.replaceAll('_',' ')} ·
            physical stock UNVERIFIED</p>
          {x.latestResponse&&<p className="field-hint">
            Your account report: {findings[x.latestResponse.finding]}
            {' · '}{x.latestResponse.recordedAt}</p>}
          {!x.latestResponse&&<button className="button secondary"
            type="button" onClick={()=>{
              setSelection(x);setFinding('requires_independent_recount');
              setNote('');setError('');setNotice('');
            }}>Report an unresolved evidence issue</button>}
        </article>)}
      </div>}
    {selection&&<form className="surface" style={{padding:16,marginTop:20}}
      aria-label="Review provisional reconciliation packet issue" onSubmit={submit}>
      <h3>Report issue · packet #{selection.packetId}</h3>
      <label>Evidence concern
        <select className="input" value={finding}
          onChange={e=>setFinding(e.target.value)}>
          {Object.entries(findings).map(([key,label])=>
            <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label>Factual explanation (12–180 characters; no private identity documents)
        <textarea className="input" minLength={12} maxLength={180}
          required rows={3} value={note} onChange={e=>setNote(e.target.value)}/>
      </label>
      <div style={{display:'flex',gap:12,marginTop:12}}>
        <button className="button primary" disabled={busy}>
          {busy?'Recording…':'Record issue — NOT approval'}</button>
        <button type="button" className="button secondary" disabled={busy}
          onClick={()=>setSelection(null)}>Cancel</button>
      </div>
    </form>}
  </section>;
}
