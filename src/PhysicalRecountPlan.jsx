import React, { useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, ClipboardList, Download, LockKeyhole } from 'lucide-react';
import { api, dateTime } from './api.js';
import { blankPhysicalRecountCsv } from './blank-recount-csv.js';
import { Notice, TableRegion } from './components.jsx';

const actions={
  all:'All next actions',
  investigate_quarantined_item:'Investigate held stock',
  identify_and_label_physical_item:'Identify and label missing SKU',
  resolve_duplicate_physical_skus:'Resolve duplicate physical SKUs',
  resolve_ambiguous_woo_identity:'Verify ambiguous Woo identity',
  verify_exact_size_colour_variation:'Verify size/colour variation',
  review_missing_website_product:'Review missing website product',
  verify_candidate_style_size_and_stock_owner:'Check matched style, size and Woo stock owner',
};
const priorities={all:'All priorities',P0:'P0 — resolve before stock preparation',
  P1:'P1 — identity needs review',P2:'P2 — candidate, requires recount'};

// Planning and paper preparation only: no local database writes, no Woo writes,
// no count submission and no automatic mapping or checkout authorization.
export default function PhysicalRecountPlan(){
  const [priority,setPriority]=useState('all');
  const [action,setAction]=useState('all');
  const [search,setSearch]=useState('');
  const [result,setResult]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [downloadError,setDownloadError]=useState('');
  const clear=()=>{setResult(null);setError('');setDownloadError('');};

  const load=async(page=1,expectedRef='')=>{
    setBusy(true);
    clear();
    try{
      const params=new URLSearchParams({
        page:String(page),pageSize:'25',priority,action,search:search.trim(),
      });
      if(expectedRef) params.set('expectedRef',expectedRef);
      const data=await api('/stock-safety/recount-plan?'+params.toString());
      if(data?.kind!=='read-only-physical-recount-plan'||
         data.auditOnly!==true||data.checkoutAuthorized!==false||
         data.sharedStockVerified!==false||data.mappingApproved!==false||
         data.stockImportAuthorized!==false||data.freshPhysicalCountVerified!==false||
         data.independentWitnessVerified!==false||
         !/^[a-f0-9]{64}$/.test(data.snapshotRef||'')||
         !Array.isArray(data.tasks)||data.tasks.length>25||
         !Number.isSafeInteger(data.totalPhysical)||
         !Number.isSafeInteger(data.total)||
         !Number.isSafeInteger(data.page)||!Number.isSafeInteger(data.pages)||
         !data.priorityCounts||typeof data.priorityCounts!=='object'){
        throw new Error('Unexpected recount plan response. Nothing may be counted or imported from this result.');
      }
      setResult(data);
    }catch(failure){
      setError(failure?.message||'The stock-count preparation report could not be read.');
    }finally{
      setBusy(false);
    }
  };

  const saveBlankPage=()=>{
    setDownloadError('');
    try{
      if(!result||!result.evidenceVerified){
        throw new Error('Check the historical source and Woo catalogue evidence before printing a worksheet.');
      }
      const csv=blankPhysicalRecountCsv(result);
      const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
      const link=document.createElement('a');
      link.href=url;
      link.download='MansuPOS-blank-recount-page-'+result.page+'-NOT-APPROVED.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(failure){
      setDownloadError(failure?.message||'Could not create the private blank worksheet.');
    }
  };

  return <section className="surface records-surface" aria-label="Physical stock recount preparation">
    <div className="section-heading"><div>
      <span className="eyebrow">Inventory cutover / pre-launch evidence</span>
      <h3>Physical stock-count preparation</h3>
      <p>Organize the first and independent second physical counts before any
        WooCommerce stock migration. Historical balances are not current stock.</p>
    </div></div>
    <Notice tone="warning"><LockKeyhole size={16}/>
      <strong>Planning only.</strong> Every source row needs verified, fresh physical
      evidence before trading. A blank worksheet is not a completed count,
      staff identity verification, stock import or owner approval.
    </Notice>
    <div style={{display:'flex',flexWrap:'wrap',gap:12,alignItems:'end'}}>
      <label style={{flex:'1 1 175px'}}>Review priority
        <select className="input" aria-label="Filter recount priority"
          value={priority} disabled={busy}
          onChange={event=>{setPriority(event.target.value);clear();}}>
          {Object.entries(priorities).map(([key,label])=>
            <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 200px'}}>Required action
        <select className="input" aria-label="Filter recount action" value={action}
          disabled={busy} onChange={event=>{setAction(event.target.value);clear();}}>
          {Object.entries(actions).map(([key,label])=>
            <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 180px'}}>SKU, source row or Woo ID
        <input className="input" aria-label="Search recount tasks" type="search"
          maxLength={64} value={search} disabled={busy}
          onChange={event=>{setSearch(event.target.value);clear();}}
          placeholder="Find product or row"/>
      </label>
      <button className="button secondary" type="button" disabled={busy}
        onClick={()=>load(1)}><ClipboardList size={16}/>
        {busy?'Checking plan…':'Build recount task list'}
      </button>
    </div>
    {busy&&<p role="status" className="field-hint">Creating a read-only plan from the pinned historic source and published Woo product codes. No sale or stock write.</p>}
    {error&&<Notice tone="error"><AlertTriangle size={16}/>{error} Restart from page one if the source changed.</Notice>}
    {result&&!busy&&<>
      {!result.evidenceVerified&&<Notice tone="error">
        Source validation is incomplete, stale or unverified. Do not print or rely on count worksheets from this observation.
      </Notice>}
      <div className="overview-metrics">
        <div className="overview-metric"><span className="eyebrow">Source items needing review</span>
          <strong>{result.totalPhysical}</strong><small>All historical records require fresh evidence</small></div>
        <div className="overview-metric"><span className="eyebrow">P0 / held or ambiguous</span>
          <strong>{result.priorityCounts.P0}</strong><small>Resolve identity or quarantine first</small></div>
        <div className="overview-metric"><span className="eyebrow">P1 / mapping gaps</span>
          <strong>{result.priorityCounts.P1}</strong><small>Verify Woo product and variation IDs</small></div>
        <div className="overview-metric"><span className="eyebrow">P2 / potential matches</span>
          <strong>{result.priorityCounts.P2}</strong><small>Still require independent physical counts</small></div>
      </div>
      <p className="field-hint">{result.total} tasks for this filter · Page {result.page} of {result.pages}
        · Woo observation {dateTime(result.websiteFetchedAt)}.</p>
      {result.tasks.length>0 ?
        <TableRegion label="Physical recount review tasks">
          <table className="responsive-table"><thead><tr>
            <th>Historic row</th><th>SKU</th><th>Priority</th><th>Next manual action</th><th>Provisional Woo ID</th>
          </tr></thead><tbody>
          {result.tasks.map((item,index)=><tr key={result.page+'-'+index}>
            <td data-label="Historic row">{item.reportRow}</td>
            <td data-label="SKU">{item.sku||'Missing SKU'}</td>
            <td data-label="Priority">{item.priority}</td>
            <td data-label="Next manual action">{actions[item.nextAction]||'Owner review needed'}</td>
            <td data-label="Provisional Woo ID">
              {item.candidateWooProductId?'#'+item.candidateWooProductId+
               (item.candidateWooVariationId?' / #'+item.candidateWooVariationId:''):'Not verified'}
            </td>
          </tr>)}
          </tbody></table>
        </TableRegion> :
        <p className="field-hint">No tasks match this filter. This is not evidence that stock counts are complete.</p>}
      <div style={{display:'flex',flexWrap:'wrap',gap:10,justifyContent:'flex-end',marginTop:12}}>
        <button type="button" className="button secondary"
          onClick={saveBlankPage}
          disabled={!result.evidenceVerified||result.tasks.length===0}>
          <Download size={16}/>Download blank worksheet (this page)
        </button>
        <button type="button" className="button secondary"
          disabled={result.page<=1} onClick={()=>load(result.page-1,result.snapshotRef)}>
          <ChevronLeft size={16}/>Previous
        </button>
        <button type="button" className="button secondary"
          disabled={!result.hasMore} onClick={()=>load(result.page+1,result.snapshotRef)}>
          Next<ChevronRight size={16}/>
        </button>
      </div>
      {downloadError&&<Notice tone="error"><AlertTriangle size={16}/>{downloadError}</Notice>}
      <p className="report-scope">
        The CSV contains only the currently shown source rows and empty fields
        for physical counts, counters, witnesses and owner decisions. Store it
        privately; never upload it to public GitHub or use it as an automatic
        inventory import. This POS does not collect or save completed counts.
      </p>
    </>}
  </section>;
}
