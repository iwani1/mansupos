import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {Notice} from './components.jsx';

// Phase 5.7: Owner-visible gap analysis only. No approval form, upload,
// document verification, stock import, payment or trading operation.
const focusLabels={
  all:'Every historical source row',
  count_disputes:'Disputed counts',
  identity_holds:'Held / ambiguous SKU identities',
  document_problems:'Missing or conflicting documents',
  reviewer_handoff:'Reviewer handoff missing',
  other_missing:'Remaining unverified cases',
};
const criteriaLabels={
  source_sku_identity:'Historical SKU identity',
  owner_variation_proposal:'Product / variation proposal',
  two_staff_declarations:'Two staff count declarations',
  private_original_custody:'Private original and custody',
  reviewer_handoff_account:'Reviewer handoff evidence',
  reported_file_fingerprint:'Reported document SHA-256',
  independent_witness_identity:'Independently proven human witness',
  signed_current_count_reconciliation:'Signed current physical recount',
  formal_owner_mapping_acceptance:'Formal Owner variation signoff',
};
const stateLabels={
  held:'On identity hold',observed_unverified:'Recorded · not verified',
  conflicting:'Conflicting · investigate',missing:'Not recorded',
  not_verified:'Independent proof missing',not_authorized:'Approval not authorized',
};
export default function InventoryVerificationReadiness(){
  const [report,setReport]=useState(null);
  const [focus,setFocus]=useState('all');
  const [search,setSearch]=useState('');
  const [page,setPage]=useState(1);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const request=useRef(0);
  const load=useCallback(async(expectedRef='')=>{
    const seq=++request.current;
    setBusy(true);setError('');
    try{
      const params=new URLSearchParams({page:String(page),pageSize:'10',
        focus,search:search.trim()});
      if(expectedRef)params.set('expectedRef',expectedRef);
      const value=await api('/stock-safety/verification-readiness?'+params);
      if(value?.kind!=='owner-inventory-verification-readiness'||
        value.auditOnly!==true||value.releaseReady!==false||
        value.stockImportAuthorized!==false||value.checkoutAuthorized!==false||
        value.inventoryAccepted!==false||value.acceptanceCertificateIssued!==false||
        !Array.isArray(value.items)||!Array.isArray(value.globalRequirements)||
        !value.summary||!value.readinessRef)
        throw new Error('Inventory-readiness endpoint did not return a locked evidence report.');
      if(seq===request.current)setReport(value);
    }catch(e){if(seq===request.current)setError(e.message||'Unable to verify current readiness evidence.');}
    finally{if(seq===request.current)setBusy(false);}
  },[focus,page,search]);
  useEffect(()=>{const current=request;void load();return()=>{current.current++;};},[load]);
  const nextPage=n=>{
    if(!report||n<1||n>report.pages)return;
    setPage(n);
  };
  return <section className="surface records-surface" role="region"
    aria-label="Inventory verification readiness analysis">
    <header>
      <span className="eyebrow">Phase 5.7 · Owner acceptance-readiness matrix</span>
      <h3>Stock readiness: evidence required before launch</h3>
      <p>Cross-checks physical-count declarations, identity proposals, private
        custody, reviewer responses and exception notes. It records what has
        been observed but cannot certify, accept or release stock.</p>
    </header>
    <Notice tone="warning">
      <strong>All stock remains blocked.</strong> A matching file hash,
      matching staff count or recorded reviewer response is not independent
      witnessing or formal Owner approval. Do not import stock, release
      garments, enable checkout or accept payments based on this report.
    </Notice>
    {error&&<p role="alert" className="field-hint">{error}</p>}
    <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'end',marginTop:16}}>
      <label style={{flex:'1 1 230px'}}>Review priority
        <select className="input" value={focus}
          onChange={e=>{setFocus(e.target.value);setPage(1);}}>
          {Object.entries(focusLabels).map(([key,label])=>
            <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 180px'}}>SKU or historical source row
        <input className="input" type="search" maxLength={64}
          value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/>
      </label>
      <button type="button" className="button secondary" disabled={busy}
        onClick={()=>load()}>{busy?'Checking…':'Refresh readiness analysis'}</button>
    </div>
    {report&&<div style={{marginTop:18}}>
      <div className="surface" style={{padding:16}}>
        <h4>Current evidence summary · not approvals</h4>
        <p><strong>{report.summary.totalHistoricalRows}</strong> historical rows
          {' · '}<strong>{report.summary.countDisputes}</strong> disputed counts
          {' · '}<strong>{report.summary.ownerProposalsRecorded}</strong> Owner mapping proposals
          {' · '}<strong>{report.summary.matchingStaffClaimsUnverified}</strong> matching staff declarations (unverified)</p>
        <p><strong>0 independently verified rows · 0 accepted rows · 0 approved for import.</strong></p>
        <p className="field-hint">This report is bound to the current historical-source,
          Woo GET, count, mapping and reviewer/exception evidence snapshots.</p>
      </div>
      <div className="surface" style={{padding:16,marginTop:16}}>
        <h4>Mandatory evidence still required for the whole system</h4>
        <ol>
          {report.globalRequirements.map(r=><li key={r.id}>
            <strong>{r.required}</strong>
            <span className="field-hint"> · Independent verification: NOT established</span>
          </li>)}
        </ol>
      </div>
      <h4 style={{marginTop:22}}>Item-level verification requirements</h4>
      <p className="field-hint">Showing {report.total} matching rows · page {report.page}
        {' of '}{report.pages}. Each row stays blocked regardless of any preliminary evidence.</p>
      {!report.items.length?<p>No source rows match this filter.</p>:
        <div style={{display:'grid',gap:12}}>
          {report.items.map(row=><article key={row.reportRow}
            className="surface" style={{padding:16}}>
            <h4>Row {row.reportRow} · {row.sku}</h4>
            <p><strong>STATUS: BLOCKED</strong> · {focusLabels[row.priority]||row.priority}</p>
            <p className="field-hint">Staff discrepancy: {row.staffCountDiscrepancyOpen?'OPEN':'Not independently verified'}
              {' · '}Reviewer handoff claim: {row.localHandoffClaimRecorded?'Recorded, unverified':'Missing'}
              {' · '}Reported fingerprint match: {row.reportedFileFingerprintMatch?'Yes, unverified':'No'}</p>
            <details>
              <summary>Inspect the nine evidence requirements</summary>
              <div style={{display:'grid',gap:10,marginTop:12}}>
                {row.criteria.map(check=><div key={check.id}
                  style={{borderBottom:'1px solid var(--border, #ddd)',paddingBottom:8}}>
                  <strong>{criteriaLabels[check.id]||check.id}</strong>
                  <p className="field-hint">Status: {stateLabels[check.state]||check.state}
                    {' · '}{check.evidence}</p>
                  <p className="field-hint">Needed: {check.required}</p>
                </div>)}
              </div>
            </details>
          </article>)}
        </div>}
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:16}}>
        <button type="button" className="button secondary" disabled={busy||page<=1}
          onClick={()=>nextPage(page-1)}>Previous</button>
        <button type="button" className="button secondary"
          disabled={busy||page>=report.pages}
          onClick={()=>nextPage(page+1)}>Next</button>
      </div>
      <p className="field-hint">There is intentionally no accept, waive,
        resolve, sync, certify or enable-checkout control.</p>
    </div>}
  </section>;
}
