import React, { useState } from 'react';
import { AlertTriangle, Download, FileSearch, LockKeyhole } from 'lucide-react';
import { api } from './api.js';
import { Notice, TableRegion } from './components.jsx';
import { inventoryDossierCsv } from './inventory-dossier-csv.js';

const filters={
  all:'All physical product rows',
  identity_hold:'Held or ambiguous product identity',
  mapping_not_proposed:'Owner mapping proposal needed',
  mapping_investigation:'Owner mapping investigation open',
  sku_difference:'Proposed Woo option has different SKU',
  first_count_missing:'First count declaration missing',
  second_count_missing:'Independent second count missing',
  count_discrepancy:'Count declarations disagree',
  matching_count_unverified:'Matching counts — NOT witnessed',
  source_mismatch:'Review source count identity',
};
const issueLabels={
  source_evidence_unverified:'Source evidence unverified',
  unresolved_physical_identity:'Physical product identity unresolved',
  owner_mapping_proposal_missing:'No owner mapping proposal',
  owner_investigation_open:'Owner identity investigation open',
  proposed_sku_differs:'Proposed Woo SKU differs',
  first_count_missing:'First count missing',
  second_count_missing:'Second count missing',
  staff_count_discrepancy:'Count declarations disagree',
  matching_counts_not_witnessed:'Matching declarations not witnessed',
  count_identity_hold:'Count record is on identity hold',
  owner_followup_needs_recheck:'Owner follow-up needs recheck',
  independent_physical_witness_unverified:'No independent physical witness verified',
  woo_stock_reservation_unverified:'Woo stock reservation not verified',
};

// Owner-only, read-only prelaunch report. No approve, stock or Woo actions.
export default function InventoryEvidenceDossier(){
  const [focus,setFocus]=useState('all');
  const [search,setSearch]=useState('');
  const [report,setReport]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [exportError,setExportError]=useState('');
  const clear=()=>{setReport(null);setError('');setExportError('');};
  const load=async(page=1,expectedRef='')=>{
    setBusy(true);setReport(null);setError('');setExportError('');
    try{
      const query=new URLSearchParams({
        page:String(page),pageSize:'25',focus,search:search.trim(),
      });
      if(expectedRef)query.set('expectedRef',expectedRef);
      const data=await api('/stock-safety/inventory-dossier?'+query.toString());
      if(data?.kind!=='read-only-inventory-evidence-dossier'||
         data.auditOnly!==true||data.mappingApproved!==false||
         data.checkoutAuthorized!==false||data.stockImportAuthorized!==false||
         data.sharedStockVerified!==false||data.ownerApproved!==false||
         data.independentWitnessVerified!==false||
         !/^[a-f0-9]{64}$/.test(data.dossierRef||'')||
         !Array.isArray(data.items)||data.items.length>25||
         !Array.isArray(data.globalBlockers)||
         !data.focusCounts||!Number.isSafeInteger(data.total)||
         !Number.isSafeInteger(data.page)||!Number.isSafeInteger(data.pages)){
        throw new Error('Inventory evidence dossier failed its safety checks.');
      }
      setReport(data);
    }catch(failure){setError(failure?.message||'Could not read owner inventory dossier.');}
    finally{setBusy(false);}
  };
  const download=()=>{
    setExportError('');
    try{
      const csv=inventoryDossierCsv(report);
      const href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
      const a=document.createElement('a');
      a.href=href;
      a.download='MansuPOS-inventory-evidence-page-'+report.page+'-NOT-APPROVED.csv';
      document.body.appendChild(a);a.click();a.remove();
      window.setTimeout(()=>URL.revokeObjectURL(href),1000);
    }catch(failure){
      setExportError(failure?.message||'Could not generate the private investigation worksheet.');
    }
  };
  return <section className="surface records-surface" role="region"
    aria-label="Prelaunch inventory evidence dossier">
    <div className="section-heading"><div>
      <span className="eyebrow">Owner / pre-launch evidence</span>
      <h3>Inventory investigation dossier</h3>
      <p>One review queue combining physical SKU mapping, owner proposals,
        first/second count claims and unresolved witnessing evidence.</p>
    </div></div>
    <Notice tone="warning"><LockKeyhole size={16}/>
      <strong>NOT AN APPROVAL OR LIVE STOCK BALANCE.</strong>
      Every record still needs a separately verified physical identity and
      inventory control. This screen cannot import stock, enable checkout or
      authorize a WooCommerce sale.
    </Notice>
    <div style={{display:'flex',flexWrap:'wrap',gap:12,alignItems:'end'}}>
      <label style={{flex:'1 1 240px'}}>Outstanding review
        <select className="input" aria-label="Filter inventory dossier"
          value={focus} disabled={busy}
          onChange={event=>{setFocus(event.target.value);clear();}}>
          {Object.entries(filters).map(([id,label])=>
            <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 190px'}}>Historical SKU, source row or Woo ID
        <input className="input" type="search" aria-label="Search inventory dossier"
          value={search} maxLength={64} disabled={busy}
          onChange={event=>{setSearch(event.target.value);clear();}}
          placeholder="Find SKU or report row"/>
      </label>
      <button className="button secondary" type="button" disabled={busy}
        onClick={()=>load(1)}><FileSearch size={16}/>
        {busy?'Examining…':'Build investigation dossier'}
      </button>
    </div>
    {busy&&<p role="status" className="field-hint">
      Comparing local identity proposals and count claims with the same
      read-only website catalogue observation. No Woo writes.</p>}
    {error&&<Notice tone="error"><AlertTriangle size={16}/>{error}
      Reload from page one if a count or mapping note changed.</Notice>}
    {report&&!busy&&<>
      {!report.evidenceVerified&&<Notice tone="error">
        At least one signed physical source or published Woo catalogue
        observation is incomplete or stale. Do not rely on these findings.
      </Notice>}
      <div className="overview-metrics">
        <div className="overview-metric"><span className="eyebrow">Historical rows</span>
          <strong>{report.totalPhysical}</strong>
          <small>Not a fresh physical count</small></div>
        <div className="overview-metric"><span className="eyebrow">Identity holds</span>
          <strong>{report.focusCounts.identity_hold??0}</strong>
          <small>Blocked for product identity</small></div>
        <div className="overview-metric"><span className="eyebrow">Mapping proposals needed</span>
          <strong>{report.focusCounts.mapping_not_proposed??0}</strong>
          <small>Owner evidence not entered</small></div>
        <div className="overview-metric"><span className="eyebrow">Discrepant counts</span>
          <strong>{report.focusCounts.count_discrepancy??0}</strong>
          <small>Staff claims disagree and still need investigation</small></div>
      </div>
      <p className="field-hint">
        {report.total} product rows for this filter · Page {report.page} of {report.pages}.
        {report.historicalCountClaims>0&&
          ' '+report.historicalCountClaims+' older count claims are outside the current source snapshot.'}
      </p>
      {report.items.length>0?
        <TableRegion label="Prelaunch inventory investigation rows">
          <table className="responsive-table"><thead><tr>
            <th>Historical SKU / row</th><th>Owner mapping</th><th>Count stage</th>
            <th>Next review</th><th>Outstanding evidence</th>
          </tr></thead><tbody>
          {report.items.map(item=><tr key={item.reportRow}>
            <td data-label="Historical SKU / row">
              <strong>{item.sku||'Missing SKU'}</strong>
              <small> · Row {item.reportRow}</small>
            </td>
            <td data-label="Owner mapping">
              {item.proposedWooProductId?
                'Proposed Woo #'+item.proposedWooProductId+
                  (item.proposedWooVariationId?' / variation #'+item.proposedWooVariationId:''):
                item.ownerMappingDecision||'No owner proposal'}
              {item.proposedWooProductId&&
                <small>{item.proposedSkuMatch?' · SKU matches':' · SKU difference needs investigation'}</small>}
            </td>
            <td data-label="Count stage">{(item.countStage||'unverified').replaceAll('_',' ')}</td>
            <td data-label="Next review">{filters[item.nextReview]||'Owner investigation'}</td>
            <td data-label="Outstanding evidence">
              {item.blockers.map(x=>issueLabels[x]||x.replaceAll('_',' ')).join('; ')}
            </td>
          </tr>)}
          </tbody></table>
        </TableRegion>:
        <p className="field-hint">No cases match these filters. This does not
          demonstrate that the inventory is verified or ready to sell.</p>}
      <div style={{display:'flex',flexWrap:'wrap',justifyContent:'flex-end',gap:10,marginTop:12}}>
        <button className="button secondary" type="button"
          disabled={!report.evidenceVerified||report.items.length===0}
          onClick={download}><Download size={16}/>Download private investigation CSV (this page)</button>
        <button className="button secondary" type="button"
          disabled={report.page<=1} onClick={()=>load(report.page-1,report.dossierRef)}>Previous</button>
        <button className="button secondary" type="button"
          disabled={!report.hasMore} onClick={()=>load(report.page+1,report.dossierRef)}>Next</button>
      </div>
      {exportError&&<Notice tone="error">{exportError}</Notice>}
      <p className="report-scope">
        The downloaded CSV contains the currently displayed identifiers,
        issue codes and source checksum; no names, individual counted units,
        prices, payments or customers. Store it privately. Neither the
        report nor its CSV is a valid product mapping, witness certificate,
        stock import file, checkout gate or permission to release stock.
      </p>
    </>}
  </section>;
}
