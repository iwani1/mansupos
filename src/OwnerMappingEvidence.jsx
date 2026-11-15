import React, { useRef, useState } from 'react';
import { AlertTriangle, ClipboardCheck, LockKeyhole, Search } from 'lucide-react';
import { api, uuid } from './api.js';
import { Notice, TableRegion } from './components.jsx';

const choices={
  propose_option:'Record a proposed Woo product or size/colour option',
  investigate_identity:'Request an identity or SKU investigation',
  retain_hold:'Keep this product on review/hold',
};
const rowNames={
  provisional_match:'Unique SKU candidate — not approved',
  missing_on_website:'Not found by published Woo SKU',
  parent_sku_only:'Only variable parent SKU matches',
  held:'Quarantined historical source row',
  missing_physical_sku:'Physical SKU missing',
  duplicate_physical_sku:'Duplicate physical source SKU',
  ambiguous_website_identity:'Ambiguous Woo product/variation identity',
};
const statuses={
  all:'All source rows',not_reviewed:'Not yet reviewed',
  proposed:'Proposed Woo option — unverified',
  investigation:'Identity investigation requested',
  hold:'Owner hold note recorded',
};

// Only owner notes; this UI NEVER sends approved stock, imports, or payments.
export default function OwnerMappingEvidence(){
  const [status,setStatus]=useState('all');
  const [search,setSearch]=useState('');
  const [report,setReport]=useState(null);
  const [busy,setBusy]=useState(false);
  const [posting,setPosting]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [selected,setSelected]=useState(null);
  const [choice,setChoice]=useState('investigate_identity');
  const [productId,setProductId]=useState('');
  const [variationId,setVariationId]=useState('');
  const [note,setNote]=useState('');
  const retry=useRef({key:'',requestId:''});

  const clear=()=>{setReport(null);setSelected(null);setError('');setNotice('');};
  const load=async(page=1,expectedRef='')=>{
    setBusy(true);setError('');setReport(null);
    try{
      const params=new URLSearchParams({
        page:String(page),pageSize:'25',status,search:search.trim(),
      });
      if(expectedRef)params.set('expectedRef',expectedRef);
      const data=await api('/stock-safety/owner-mapping-evidence?'+params.toString());
      if(data?.kind!=='local-owner-mapping-evidence-review'||
         data.auditOnly!==true||data.checkoutAuthorized!==false||
         data.stockImportAuthorized!==false||data.mappingApproved!==false||
         data.sharedStockVerified!==false||
         !/^[a-f0-9]{64}$/.test(data.identityRef||'')||
         !Array.isArray(data.items)||data.items.length>25||
         !data.counts||!Number.isSafeInteger(data.page)||
         !Number.isSafeInteger(data.total)||!Number.isSafeInteger(data.pages)){
        throw new Error('Unverified owner-mapping report. No stock change is permitted.');
      }
      setReport(data);
    }catch(err){setError(err?.message||'Owner mapping evidence could not be loaded.');}
    finally{setBusy(false);}
  };
  const start=row=>{
    setSelected(row);setError('');setNotice('');
    const decision=row.classification==='held'?'retain_hold':
      row.classification==='provisional_match'?'propose_option':'investigate_identity';
    setChoice(decision);
    setProductId(row.latestReview?.proposedProductId?.toString()||
      row.initialProductId?.toString()||'');
    setVariationId(row.latestReview?.proposedVariationId?.toString()||
      row.initialVariationId?.toString()||'');
    setNote('');retry.current={key:'',requestId:''};
  };
  const submit=async(event)=>{
    event.preventDefault();
    if(!report||!selected||posting)return;
    const trimmed=note.trim();
    if(trimmed.length<8||trimmed.length>240||/[\r\n]/.test(trimmed)){
      setError('Enter a single-line investigation note of 8–240 characters.');return;
    }
    const number=value=>/^\d+$/.test(value.trim())&&
      Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
    const p=choice==='propose_option'?number(productId):null;
    const v=choice==='propose_option'&&variationId.trim()?number(variationId):null;
    if(choice==='propose_option'&&(!p||(variationId.trim()&&!v))){
      setError('Enter a valid published Woo product ID and optional variation ID.');return;
    }
    const payload={
      reportRow:selected.reportRow,expectedRef:report.identityRef,
      expectedLatestReviewId:selected.latestReview?.id??null,
      decision:choice,proposedProductId:p,proposedVariationId:v,note:trimmed,
    };
    const key=JSON.stringify(payload);
    if(retry.current.key!==key)retry.current={key,requestId:uuid()};
    setPosting(true);setError('');setNotice('');
    try{
      const response=await api('/stock-safety/owner-mapping-evidence',{
        method:'POST',body:{...payload,requestId:retry.current.requestId},
      });
      if(response?.kind!=='local-unverified-owner-mapping-proposal'||
         response.recorded!==true||response.auditOnly!==true||
         response.mappingApproved!==false||
         response.stockImportAuthorized!==false||
         response.checkoutAuthorized!==false){
        throw new Error('Owner note was not safely confirmed. No stock action was taken.');
      }
      setSelected(null);setNote('');retry.current={key:'',requestId:''};
      setNotice('Owner mapping evidence saved locally. Proposed identity remains unverified; no Woo or stock update occurred.');
      await load(report.page);
    }catch(err){setError(err?.message||'Could not record mapping evidence; review history before retrying.');}
    finally{setPosting(false);}
  };
  return <section className="surface records-surface" role="region"
    aria-label="Owner product mapping evidence">
    <div className="section-heading"><div>
      <span className="eyebrow">Owner review · historical stock identities</span>
      <h3>Product mapping evidence — proposals only</h3>
      <p>Document the Woo product or size/colour variation you believe belongs to
        a physical row. This is not a mapping approval, stock adjustment or import.</p>
    </div></div>
    <Notice tone="warning"><LockKeyhole size={16}/>
      A proposed link remains <strong>unverified</strong> until original garment
      details, independent counts, true Woo stock ownership and required
      witnessed evidence have been checked separately.
    </Notice>
    <div style={{display:'flex',flexWrap:'wrap',gap:12,alignItems:'end'}}>
      <label style={{flex:'1 1 180px'}}>Review status
        <select className="input" aria-label="Filter owner mapping evidence"
          disabled={busy||posting} value={status}
          onChange={event=>{setStatus(event.target.value);clear();}}>
          {Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 190px'}}>Historical SKU, row or proposed Woo ID
        <input className="input" type="search" maxLength={64}
          aria-label="Search owner mapping evidence" value={search} disabled={busy||posting}
          onChange={event=>{setSearch(event.target.value);clear();}}
          placeholder="SKU / source row / ID"/>
      </label>
      <button className="button secondary" type="button" disabled={busy||posting}
        onClick={()=>load(1)}><Search size={16}/>{busy?'Loading…':'Open owner mapping review'}</button>
    </div>
    {busy&&<p role="status" className="field-hint">
      Inspecting pinned historical identities and authenticated Woo product GETs only.</p>}
    {error&&<Notice tone="error"><AlertTriangle size={16}/>{error}</Notice>}
    {notice&&<Notice tone="warning"><ClipboardCheck size={16}/>{notice}</Notice>}
    {report&&!busy&&<>
      {!report.evidenceVerified&&<Notice tone="error">
        Signed source or Woo catalogue evidence is stale or incomplete. New owner notes are disabled.
      </Notice>}
      <div className="overview-metrics">
        <div className="overview-metric"><span className="eyebrow">Not reviewed</span>
          <strong>{report.counts.notReviewed??0}</strong></div>
        <div className="overview-metric"><span className="eyebrow">Proposed (not approved)</span>
          <strong>{report.counts.proposed??0}</strong></div>
        <div className="overview-metric"><span className="eyebrow">Investigations</span>
          <strong>{report.counts.investigation??0}</strong></div>
        <div className="overview-metric"><span className="eyebrow">Hold notes</span>
          <strong>{report.counts.hold??0}</strong></div>
      </div>
      <p className="field-hint">{report.total} rows for this filter ·
        Page {report.page} of {report.pages}. Historical source and Woo option
        identity changes invalidate the current review snapshot.</p>
      {report.items.length>0?
        <TableRegion label="Owner product identity proposals">
          <table className="responsive-table"><thead><tr>
            <th>Source row</th><th>SKU / initial status</th>
            <th>Latest owner note</th><th>Review</th>
          </tr></thead><tbody>
          {report.items.map(item=><tr key={item.reportRow}>
            <td data-label="Source row">{item.reportRow}</td>
            <td data-label="SKU / initial status">
              <strong>{item.sku||'Missing SKU'}</strong>
              <small> · {rowNames[item.classification]||'Needs investigation'}</small>
            </td>
            <td data-label="Latest owner note">
              {item.latestReview?<>
                <span>{choices[item.latestReview.decision]||'Investigation'}</span>
                {item.latestReview.decision==='propose_option'&&
                  <small> · Woo #{item.latestReview.proposedProductId}
                    {item.latestReview.proposedVariationId?' / variation #'+item.latestReview.proposedVariationId:''}
                    {item.latestReview.exactSkuMatch?' · SKU matches':' · SKU DIFFERENCE: investigate'}
                  </small>}
                <p>{item.latestReview.note}</p>
              </>:'Not reviewed'}
            </td>
            <td data-label="Review"><button className="button secondary small"
              type="button" disabled={busy||posting||!report.evidenceVerified||Boolean(selected)}
              onClick={()=>start(item)}>
              {item.latestReview?'Add new investigation note':'Review identity'}
            </button></td>
          </tr>)}
          </tbody></table>
        </TableRegion>:
        <p className="field-hint">No records match these filters. This never proves stock is ready.</p>}
      {selected&&<form className="form-stack" onSubmit={submit}
        aria-label="Record owner mapping proposal">
        <h3>Record owner mapping evidence — row {selected.reportRow}</h3>
        <p>SKU {selected.sku||'missing'} · {rowNames[selected.classification]||'Needs review'}.
          Your entry will never count as stock approval.</p>
        <label>Review outcome
          <select className="input" aria-label="Choose mapping review action"
            value={choice} disabled={posting}
            onChange={event=>setChoice(event.target.value)}>
            {Object.entries(choices).map(([key,label])=>
              <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        {choice==='propose_option'&&<>
          <label>Published WooCommerce product ID
            <input className="input" type="number" min="1" max="9007199254740991"
              step="1" required value={productId} disabled={posting}
              onChange={event=>setProductId(event.target.value)}/>
          </label>
          <label>WooCommerce variation ID (blank for a simple product)
            <input className="input" type="number" min="1" max="9007199254740991"
              step="1" value={variationId} disabled={posting}
              onChange={event=>setVariationId(event.target.value)}/>
          </label>
          <p className="field-hint">The server checks the published Woo product/
            variation ID and prevents duplicate proposals to the same option.
            Parent-only or held identities cannot be approved here.</p>
        </>}
        <label>Investigation note (8–240 characters; no customer details)
          <textarea className="input" rows={2} required maxLength={240}
            aria-label="Owner mapping investigation note"
            value={note} disabled={posting}
            onChange={event=>setNote(event.target.value)}
            placeholder="e.g. Verify blue UK 14 variation against the physical garment before mapping."/>
        </label>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          <button className="button secondary" type="submit" disabled={posting||!report.evidenceVerified}>
            <ClipboardCheck size={16}/>{posting?'Recording…':'Save proposal / investigation only'}
          </button>
          <button className="button secondary" type="button" disabled={posting}
            onClick={()=>{setSelected(null);setNote('');}}>Cancel</button>
        </div>
      </form>}
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:12}}>
        <button className="button secondary" type="button"
          disabled={busy||posting||report.page<=1||Boolean(selected)}
          onClick={()=>load(report.page-1,report.identityRef)}>Previous</button>
        <button className="button secondary" type="button"
          disabled={busy||posting||!report.hasMore||Boolean(selected)}
          onClick={()=>load(report.page+1,report.identityRef)}>Next</button>
      </div>
      <p className="report-scope">These are owner assertions, not independent
        evidence of style, colour, size, stock availability, witnessing, Woo stock
        ownership or acceptance for real transactions. The POS does not alter
        any Woo inventory, orders or financial ledger through this screen.</p>
    </>}
  </section>;
}
