import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ClipboardCheck, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, dateTime, uuid } from './api.js';
import { Notice, PageHeading, TableRegion } from './components.jsx';

const stages={
  identity_hold:'Identity/hold review required',
  first_needed:'First count not recorded',
  second_needed:'Independent second count required',
  matching_claims_unverified:'Count claims agree · NOT VERIFIED',
  discrepant_claims:'Count claims disagree · owner review',
};

// Purely local claim journal. This page never handles Woo checkout or stock
// and must not be presented as authenticated physical witnessing.
export default function PhysicalCountWorkspace({ user }) {
  const owner=user.role==='owner';
  const [result,setResult]=useState(null);
  const [search,setSearch]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [loading,setLoading]=useState(false);
  const [selection,setSelection]=useState(null);
  const [units,setUnits]=useState('');
  const [posting,setPosting]=useState(false);
  const retry=useRef({key:'',requestId:''});
  const requestId=useRef(0);
  const endpoint=owner?'/stock-safety/count-claims-review':'/stock-safety/count-worklist';

  const load=useCallback(async(page=1,expectedRef='')=>{
    const id=++requestId.current;
    setLoading(true);setError('');setResult(null);
    try {
      const params=new URLSearchParams({page:String(page),pageSize:'25',search:search.trim()});
      if(expectedRef)params.set('expectedRef',expectedRef);
      const data=await api(endpoint+'?'+params.toString());
      const kind=owner?'local-unverified-physical-count-owner-review':
        'local-unverified-physical-count-worklist';
      if(data?.kind!==kind||data.auditOnly!==true||
         data.checkoutAuthorized!==false||data.stockImportAuthorized!==false||
         data.ownerApproved!==false||data.independentWitnessVerified!==false||
         !/^[a-f0-9]{64}$/.test(data.snapshotRef||'')||
         !Array.isArray(data.items)||data.items.length>25||
         !Number.isSafeInteger(data.page)||!Number.isSafeInteger(data.pages)){
        throw new Error('Count claim evidence did not meet the read-only review contract.');
      }
      if(id===requestId.current)setResult(data);
    }catch(failure){if(id===requestId.current)setError(failure?.message||'Could not load physical count claims.');}
    finally{if(id===requestId.current)setLoading(false);}
  },[endpoint,owner,search]);

  useEffect(()=>{void load(1);return()=>{requestId.current++;};},[load]);
  const begin=row=>{
    setNotice('');setError('');
    if(!row.canSubmit)return;
    setSelection({reportRow:row.reportRow,sku:row.sku,
      stage:row.stage==='first_needed'?'first':'second'});
    setUnits('');
    retry.current={key:'',requestId:''};
  };
  const submit=async event=>{
    event.preventDefault();
    if(!selection||!result||posting)return;
    const number=Number(units);
    if(!/^\d+$/.test(units.trim())||!Number.isSafeInteger(number)||number<0||number>1000000){
      setError('Enter a whole number between 0 and 1,000,000.');return;
    }
    const key=[selection.reportRow,selection.stage,number,result.snapshotRef].join(':');
    if(retry.current.key!==key)retry.current={key,requestId:uuid()};
    setPosting(true);setError('');setNotice('');
    try{
      const saved=await api('/stock-safety/count-claim',{method:'POST',body:{
        reportRow:selection.reportRow,units:number,stage:selection.stage,
        expectedRef:result.snapshotRef,requestId:retry.current.requestId,
      }});
      if(saved?.kind!=='local-unverified-physical-count-claim'||saved.recorded!==true||
         saved.checkoutAuthorized!==false||saved.stockImportAuthorized!==false||
         saved.ownerApproved!==false||saved.independentWitnessVerified!==false){
        throw new Error('The POS did not confirm a safe local count claim.');
      }
      setSelection(null);setUnits('');
      retry.current={key:'',requestId:''};
      setNotice('Count claim recorded locally. This does NOT verify physical stock or approve a Woo adjustment.');
      void load(result.page);
    }catch(failure){setError(failure?.message||'The count claim could not be recorded. Do not repeat without checking its status.');}
    finally{setPosting(false);}
  };

  return <div className="sales-page" aria-label="Physical count claims workspace">
    <PageHeading eyebrow="Physical inventory / count declarations"
      title={owner?'Owner physical count review':'Physical stock count entry'}
      description="Claims from individual POS staff accounts only. Never use this information to release stock or take payment.">
      <button className="button secondary" type="button" disabled={loading||posting}
        onClick={()=>load(1)}><RefreshCw size={16}/>{loading?'Checking…':'Refresh claims'}</button>
    </PageHeading>
    <Notice tone="warning"><LockKeyhole size={16}/>
      <strong>Not a verified inventory count.</strong> Separate logins and matching numbers
      do not prove the garments were physically witnessed. WooCommerce stock,
      POS checkout, payments and inventory imports remain locked.
    </Notice>
    <section className="surface records-surface">
      <div className="section-heading"><div>
        <h2>{owner?'Recount claim discrepancies':'Your count tasks'}</h2>
        <p>{owner?
          'Review first and second staff declarations; there is no approve, release or stock-import action.':
          'Record a first or blind second count only for eligible historical source rows. You will not see the other counter’s quantity.'}</p>
      </div></div>
      <div style={{display:'flex',flexWrap:'wrap',alignItems:'end',gap:12}}>
        <label style={{flex:'1 1 240px'}}>Historical SKU or report row
          <input className="input" type="search" aria-label="Search count claims"
            value={search} maxLength={64} disabled={loading||posting}
            placeholder="Find source row or SKU"
            onChange={event=>{setSearch(event.target.value);setSelection(null);}}/>
        </label>
      </div>
      {error&&<Notice tone="error"><AlertTriangle size={16}/>{error}</Notice>}
      {notice&&<Notice tone="warning"><ShieldCheck size={16}/>{notice}</Notice>}
      {loading&&<p role="status" className="field-hint">Checking the source-bound local claim journal; no WooCommerce changes.</p>}
      {result&&!loading&&<>
        {!result.evidenceVerified&&<Notice tone="error">
          The source evidence is incomplete or stale. Do not submit another physical-count claim.
        </Notice>}
        {owner&&<div className="overview-metrics">
          <div className="overview-metric"><span className="eyebrow">Awaiting first count</span>
            <strong>{result.totals?.firstNeeded??0}</strong></div>
          <div className="overview-metric"><span className="eyebrow">Awaiting second account</span>
            <strong>{result.totals?.secondNeeded??0}</strong></div>
          <div className="overview-metric"><span className="eyebrow">Matching claims (unverified)</span>
            <strong>{result.totals?.matchingUnverified??0}</strong></div>
          <div className="overview-metric"><span className="eyebrow">Discrepant claims</span>
            <strong>{result.totals?.discrepancies??0}</strong></div>
        </div>}
        {owner&&(result.staleClaimEvents>0)&&<Notice tone="warning">
          {result.staleClaimEvents} count declarations belong to an older source or website observation.
          They remain in the historical journal but do not count as current claims.
        </Notice>}
        <p className="field-hint">{result.total} source rows · Page {result.page} of {result.pages}
          · All quantities remain provisional until independent offline evidence checks.</p>
        {result.items.length>0?
          <TableRegion label="Source-bound physical count claims">
            <table className="responsive-table"><thead><tr>
              <th>Report row</th><th>SKU</th><th>Review state</th>
              {owner?<><th>Count 1</th><th>Count 2</th></>:<th>Recording</th>}
            </tr></thead><tbody>
              {result.items.map(item=><tr key={item.reportRow}>
                <td data-label="Report row">{item.reportRow}</td>
                <td data-label="SKU">{item.sku||'Not identified'}</td>
                <td data-label="Review state">{stages[item.stage]||'Needs review'}</td>
                {owner?<><td data-label="Count 1">{item.firstUnits??'—'}</td>
                  <td data-label="Count 2">{item.secondUnits??'—'}</td></>:
                  <td data-label="Recording"><button type="button" className="button secondary small"
                    disabled={!item.canSubmit||!result.evidenceVerified||Boolean(selection)||posting}
                    onClick={()=>begin(item)}>
                    {item.stage==='second_needed'?'Record blind second count':'Record first count'}
                  </button></td>}
              </tr>)}
            </tbody></table>
          </TableRegion>:<p className="field-hint">No count tasks match this filter.</p>}
        {!owner&&selection&&<form onSubmit={submit} className="form-stack"
          aria-label="Submit a physical-count declaration">
          <h3>{selection.stage==='first'?'First':'Independent second'} count declaration</h3>
          <p>Source row {selection.reportRow} · SKU {selection.sku}. Enter only what
            you personally counted. No other employee’s quantity is shown.</p>
          <label>Units physically observed (claim)
            <input className="input" type="number" required min="0" max="1000000" step="1"
              value={units} disabled={posting}
              onChange={event=>setUnits(event.target.value)}/>
          </label>
          <div style={{display:'flex',gap:10}}>
            <button className="button primary" type="submit" disabled={posting||!result.evidenceVerified}>
              <ClipboardCheck size={16}/>{posting?'Recording…':'Record count declaration'}
            </button>
            <button type="button" className="button secondary" disabled={posting}
              onClick={()=>{setSelection(null);setUnits('');}}>Cancel</button>
          </div>
        </form>}
        <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:12}}>
          <button className="button secondary" type="button"
            disabled={loading||posting||result.page<=1}
            onClick={()=>load(result.page-1,result.snapshotRef)}>Previous</button>
          <button className="button secondary" type="button"
            disabled={loading||posting||!result.hasMore}
            onClick={()=>load(result.page+1,result.snapshotRef)}>Next</button>
        </div>
        <p className="report-scope">
          The POS journal records who declared each count, not proof of physical witnessing.
          No count is verified, approved, stock-adjusted or imported. Staff cannot view
          other employees’ quantities. Owner review does not have an approval button.
        </p>
      </>}
    </section>
  </div>;
}
