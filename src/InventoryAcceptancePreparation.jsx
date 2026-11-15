import React, { useState } from 'react';
import { AlertTriangle, ClipboardList, LockKeyhole } from 'lucide-react';
import { api } from './api.js';
import { Notice, TableRegion } from './components.jsx';

const gates={
  all:'All historical physical rows',
  identity_resolution:'Unresolved product identity',
  owner_option_proposal:'Missing proposed Woo option',
  two_count_claims:'Missing or conflicting staff count claims',
  independent_physical_witness:'Independent witness evidence missing',
  formal_mapping_signoff:'Formal crosswalk signoff missing',
  live_woo_stock_and_payment_safety:'Live stock/payment safety not verified',
  historical_source_integrity:'Historical source integrity not verified',
};
const states={
  investigate:'Investigate identity',
  provisional:'Historical identity only',
  recorded_unverified:'Proposed only — not accepted',
  missing:'Missing',
  incomplete:'Incomplete',
  discrepant:'Claims disagree',
  matching_unwitnessed:'Counts match — not independently witnessed',
  not_verified:'Not verified',
  not_authorized:'Not authorized',
};
const mandatoryLabels={
  independent_witness_identity_and_signed_current_counts:
    'Independently witnessed current stock counts with verified staff identities',
  owner_approved_style_colour_size_variation_crosswalk:
    'Separately authenticated owner signoff for style, colour, size and Woo variation',
  verified_woo_stock_owner_and_last_unit_reservations:
    'Installed WooCommerce stock ownership and last-unit reservation safety',
  verified_pending_payment_retries_refunds_and_late_callbacks:
    'Payment retries, pending orders, refunds and late callback tests',
  off_host_recovery_and_supervised_trading_acceptance:
    'Off-host backup recovery and supervised production acceptance',
};

// No checkbox is a proxy for an approval; this is a read-only gap register.
export default function InventoryAcceptancePreparation(){
  const [gate,setGate]=useState('all');
  const [search,setSearch]=useState('');
  const [report,setReport]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const clear=()=>{setReport(null);setError('');};
  const load=async(page=1,expectedRef='')=>{
    setBusy(true);setReport(null);setError('');
    try{
      const q=new URLSearchParams({page:String(page),pageSize:'25',gate,search:search.trim()});
      if(expectedRef)q.set('expectedRef',expectedRef);
      const result=await api('/stock-safety/acceptance-preparation?'+q.toString());
      if(result?.kind!=='read-only-inventory-acceptance-preparation'||
         result.auditOnly!==true||result.ownerApproved!==false||
         result.mappingApproved!==false||result.stockImportAuthorized!==false||
         result.sharedStockVerified!==false||result.checkoutAuthorized!==false||
         result.independentWitnessVerified!==false||
         result.acceptanceCertificateIssued!==false||
         !/^[a-f0-9]{64}$/.test(result.preparationRef||'')||
         !Array.isArray(result.items)||result.items.length>25||
         !Array.isArray(result.mandatoryGlobalEvidence)||
         !result.observations||!Number.isSafeInteger(result.page)||
         !Number.isSafeInteger(result.total)||!Number.isSafeInteger(result.pages)){
        throw new Error('Unverified acceptance checklist response. Do not use it to release stock.');
      }
      setReport(result);
    }catch(failure){setError(failure?.message||'The acceptance preparation report was unavailable.');}
    finally{setBusy(false);}
  };
  return <section className="surface records-surface" role="region"
    aria-label="Inventory acceptance preparation checklist">
    <div className="section-heading"><div>
      <span className="eyebrow">Owner / planned cutover requirements</span>
      <h3>Inventory acceptance preparation — missing evidence</h3>
      <p>Identify what must be independently verified before any physical-store
        inventory migration can be considered.</p>
    </div></div>
    <Notice tone="warning"><LockKeyhole size={16}/>
      <strong>All stock import and checkout approval gates remain CLOSED.</strong>
      Staff count claims and proposed product mappings are observations,
      not proof. This checklist cannot record signoff or create an acceptance certificate.
    </Notice>
    <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'end'}}>
      <label style={{flex:'1 1 240px'}}>Review requirement
        <select className="input" aria-label="Filter acceptance evidence gate"
          value={gate} disabled={busy} onChange={e=>{setGate(e.target.value);clear();}}>
          {Object.entries(gates).map(([id,name])=><option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 210px'}}>Source row or historical SKU
        <input className="input" type="search" aria-label="Search acceptance preparation"
          value={search} disabled={busy} maxLength={64} placeholder="SKU or source row"
          onChange={e=>{setSearch(e.target.value);clear();}}/>
      </label>
      <button className="button secondary" type="button" disabled={busy}
        onClick={()=>load(1)}><ClipboardList size={16}/>
        {busy?'Checking requirements…':'Prepare evidence checklist'}
      </button>
    </div>
    {busy&&<p role="status" className="field-hint">Evaluating source-bound
      observations. No stock, WooCommerce or payment changes.</p>}
    {error&&<Notice tone="error"><AlertTriangle size={16}/>{error}
      Restart on page one if evidence changed during review.</Notice>}
    {report&&!busy&&<>
      {!report.historicalSourceVerified&&<Notice tone="error">
        The signed historical source or published Woo catalogue evidence
        is incomplete/stale. Do not rely on any apparent progress.</Notice>}
      <div className="overview-metrics">
        <div className="overview-metric"><span className="eyebrow">Historical source rows</span>
          <strong>{report.observations.totalHistoricalRows}</strong>
          <small>Not current or approved inventory</small></div>
        <div className="overview-metric"><span className="eyebrow">Identity holds</span>
          <strong>{report.observations.identityHolds}</strong></div>
        <div className="overview-metric"><span className="eyebrow">Owner proposals</span>
          <strong>{report.observations.provisionalOwnerProposals}</strong>
          <small>Unapproved links</small></div>
        <div className="overview-metric"><span className="eyebrow">Matching count declarations</span>
          <strong>{report.observations.matchingStaffDeclarations}</strong>
          <small>Not witnessed or accepted</small></div>
      </div>
      <div className="section-heading"><div>
        <h4>Global requirements still outstanding</h4>
        <p>These are not automatically satisfied by any local checklist entry.</p>
        <ul className="field-hint">
          {report.mandatoryGlobalEvidence.map(item=><li key={item}>
            {mandatoryLabels[item]||item.replaceAll('_',' ')}</li>)}
        </ul>
      </div></div>
      <p className="field-hint">{report.total} rows for selected requirement ·
        Page {report.page} of {report.pages}. Every listed row remains blocked from trading.</p>
      {report.items.length>0?
        <TableRegion label="Unverified inventory acceptance checklist">
          <table className="responsive-table"><thead><tr>
            <th>Historic SKU / row</th><th>Product identity</th>
            <th>Owner mapping</th><th>Two count claims</th><th>Further verification</th>
          </tr></thead><tbody>
          {report.items.map(item=><tr key={item.reportRow}>
            <td data-label="Historic SKU / row">
              <strong>{item.sku||'Missing SKU'}</strong> · Row {item.reportRow}</td>
            <td data-label="Product identity">
              {states[item.checks.find(c=>c.gate==='identity_resolution')?.state]||'Unknown'}</td>
            <td data-label="Owner mapping">
              {states[item.checks.find(c=>c.gate==='owner_option_proposal')?.state]||'Missing'}</td>
            <td data-label="Two count claims">
              {states[item.checks.find(c=>c.gate==='two_count_claims')?.state]||'Missing'}</td>
            <td data-label="Further verification">
              {item.checks.filter(c=>['independent_physical_witness',
                'formal_mapping_signoff','live_woo_stock_and_payment_safety'].includes(c.gate))
                .map(c=>c.detail).join('; ')}</td>
          </tr>)}
          </tbody></table>
        </TableRegion>:
        <p className="field-hint">No source rows match this requirement and filter.
          This is not proof of stock verification or launch readiness.</p>}
      <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:12}}>
        <button className="button secondary" type="button"
          disabled={report.page<=1} onClick={()=>load(report.page-1,report.preparationRef)}>
          Previous</button>
        <button className="button secondary" type="button"
          disabled={!report.hasMore} onClick={()=>load(report.page+1,report.preparationRef)}>
          Next</button>
      </div>
      <p className="report-scope">
        This is a non-executing evidence-gap checklist. It never stores a new
        verification, marks an item accepted, imports inventory, creates an
        invoice or enables payment. Product and count identities are historical.
      </p>
    </>}
  </section>;
}
