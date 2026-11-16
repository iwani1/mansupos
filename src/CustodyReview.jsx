import React, { useRef, useState } from 'react';
import { ClipboardCheck, LockKeyhole, ShieldAlert } from 'lucide-react';
import { api, uuid } from './api.js';
import { Notice, TableRegion } from './components.jsx';

const filters={
  all:'All historic product rows',
  file_manifest_missing:'No original file fingerprint recorded',
  custody_entry_needed:'First custody declaration needed',
  custody_declared_unverified:'Custody declared (not verified)',
  review_requested_unconfirmed:'Independent review requested (not confirmed)',
  count_discrepancy_open:'Conflicting employee counts (still open)',
  identity_hold:'Source identity held',
  waiting_for_counts:'Two staff count claims missing',
};
const steps={
  sealed_in_private_custody:'Declare original secured in private custody',
  custody_access_logged:'Record a custody access event',
  independent_review_requested:'Record a request for independent document review',
};
const channels={
  none:'Not applicable',
  in_person:'Proposed in-person review',
  secured_external_channel:'Proposed secure external file handoff',
  sealed_paper_copy:'Proposed sealed physical-paper handoff',
};

export default function CustodyReview(){
  const [filter,setFilter]=useState('all');
  const [search,setSearch]=useState('');
  const [report,setReport]=useState(null);
  const [busy,setBusy]=useState(false);
  const [posting,setPosting]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [selected,setSelected]=useState(null);
  const [step,setStep]=useState('sealed_in_private_custody');
  const [locationCode,setLocationCode]=useState('');
  const [channel,setChannel]=useState('none');
  const [note,setNote]=useState('');
  const retry=useRef({key:'',requestId:''});
  const clear=()=>{
    setReport(null);setSelected(null);setError('');setNotice('');
  };
  const load=async(page=1,expectedRef='')=>{
    setBusy(true);setReport(null);setSelected(null);setError('');
    try{
      const query=new URLSearchParams({
        page:String(page),pageSize:'25',status:filter,search:search.trim(),
      });
      if(expectedRef)query.set('expectedRef',expectedRef);
      const data=await api('/stock-safety/evidence-custody?'+query.toString());
      if(data?.kind!=='owner-unverified-evidence-custody'||
         data.auditOnly!==true||data.documentBytesStored!==false||
         data.documentSignatureVerified!==false||
         data.independentWitnessVerified!==false||
         data.independentReviewConfirmed!==false||
         data.ownerApproved!==false||data.mappingApproved!==false||
         data.sharedStockVerified!==false||
         data.stockImportAuthorized!==false||
         data.checkoutAuthorized!==false||
         !/^[a-f0-9]{64}$/.test(data.snapshotRef||'')||
         !Array.isArray(data.items)||data.items.length>25||
         !data.tally||!Number.isSafeInteger(data.page)||
         !Number.isSafeInteger(data.pages)||!Number.isSafeInteger(data.total))
        throw new Error('Custody evidence failed its unverified-read safety checks.');
      setReport(data);
    }catch(err){setError(err?.message||'Could not read private custody evidence.');}
    finally{setBusy(false);}
  };
  const begin=(row)=>{
    setSelected(row);setError('');setNotice('');
    const next=row.latestCustodyEvent?'independent_review_requested':'sealed_in_private_custody';
    setStep(next);
    setLocationCode(row.latestCustodyEvent?.locationCode||'');
    setChannel(next==='independent_review_requested'?'in_person':'none');
    setNote('');
    retry.current={key:'',requestId:''};
  };
  const submit=async(event)=>{
    event.preventDefault();
    if(!selected||!report||posting)return;
    const noteValue=note.trim(),place=locationCode.trim();
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{3,47}$/.test(place)){
      setError('Use an anonymous 4–48 character secure-storage code.');return;
    }
    if(noteValue.length<8||noteValue.length>180||/[\r\n]/.test(noteValue)){
      setError('Write a one-line custody note of 8–180 characters.');return;
    }
    const body={
      reportRow:selected.reportRow,
      expectedRef:report.snapshotRef,
      expectedLatestEventId:selected.latestCustodyEvent?.id??null,
      manifestId:selected.manifest.id,
      fileSha256:selected.manifest.fileSha256,
      firstClaimId:selected.firstClaimId,
      secondClaimId:selected.secondClaimId,
      action:step,locationCode:place,
      reviewChannel:step==='independent_review_requested'?channel:'none',
      note:noteValue,
    };
    const key=JSON.stringify(body);
    if(retry.current.key!==key)retry.current={key,requestId:uuid()};
    setPosting(true);setError('');setNotice('');
    try{
      const saved=await api('/stock-safety/evidence-custody',{
        method:'POST',body:{...body,requestId:retry.current.requestId},
      });
      if(saved?.kind!=='unverified-owner-custody-event'||
         saved.recorded!==true||saved.auditOnly!==true||
         saved.documentBytesStored!==false||
         saved.independentReviewConfirmed!==false||
         saved.independentWitnessVerified!==false||
         saved.ownerApproved!==false||saved.stockImportAuthorized!==false||
         saved.checkoutAuthorized!==false)
        throw new Error('Owner custody note was not safely confirmed.');
      setSelected(null);setNote('');
      retry.current={key:'',requestId:''};
      setNotice('Owner custody declaration recorded. No independent reviewer or actual file handoff was verified.');
      await load(report.page);
    }catch(err){
      setError(err?.message||'Cannot confirm custody note. Inspect the owner audit history before retrying.');
    }finally{setPosting(false);}
  };
  return <section className="surface records-surface" role="region"
    aria-label="Owner custody and independent review preparation">
    <div className="section-heading"><div>
      <span className="eyebrow">Owner / evidence handling preparation</span>
      <h3>Custody & independent review — declarations only</h3>
      <p>Record how originals are purportedly secured, document access events,
        and prepare a request for independent document examination.</p>
    </div></div>
    <Notice tone="warning"><LockKeyhole size={16}/>
      <strong>No real handoff is executed here.</strong> These are owner claims,
      not custody verification, reviewer acknowledgement, witness authentication,
      electronic signatures, approval or permission to import inventory.
    </Notice>
    <div style={{display:'flex',flexWrap:'wrap',gap:12,alignItems:'end'}}>
      <label style={{flex:'1 1 210px'}}>Evidence status
        <select className="input" aria-label="Filter custody evidence"
          value={filter} disabled={busy||posting}
          onChange={e=>{setFilter(e.target.value);clear();}}>
          {Object.entries(filters).map(([key,label])=>
            <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 180px'}}>Historical SKU / source row / file code
        <input className="input" type="search" maxLength={64}
          aria-label="Search custody evidence" value={search}
          disabled={busy||posting}
          onChange={e=>{setSearch(e.target.value);clear();}}/>
      </label>
      <button className="button secondary" type="button" disabled={busy||posting}
        onClick={()=>load(1)}><ClipboardCheck size={16}/>
        {busy?'Loading evidence…':'Open custody register'}
      </button>
    </div>
    {error&&<Notice tone="error"><ShieldAlert size={16}/>{error}</Notice>}
    {notice&&<Notice tone="warning">{notice}</Notice>}
    {report&&!busy&&<>
      {!report.evidenceVerified&&<Notice tone="error">
        Historical source or WooCommerce product identities are stale/incomplete.
        Owner custody recording is disabled.</Notice>}
      <div className="overview-metrics">
        <div className="overview-metric"><span className="eyebrow">File fingerprints missing</span>
          <strong>{report.tally.manifestMissing}</strong></div>
        <div className="overview-metric"><span className="eyebrow">Current owner notes</span>
          <strong>{report.tally.custodyNotesCurrent}</strong>
          <small>Not externally verified</small></div>
        <div className="overview-metric"><span className="eyebrow">Review requested</span>
          <strong>{report.tally.reviewsRequestedUnconfirmed}</strong>
          <small>No reviewer acknowledgement</small></div>
        <div className="overview-metric"><span className="eyebrow">Count discrepancies</span>
          <strong>{report.tally.countDiscrepanciesOpen}</strong>
          <small>Still unresolved</small></div>
      </div>
      <p className="field-hint">{report.total} source rows ·
        Page {report.page} of {report.pages}</p>
      {report.items.length>0?<TableRegion label="Private evidence custody records">
        <table className="responsive-table"><thead><tr>
          <th>SKU / historical row</th><th>Current fingerprint</th>
          <th>Custody evidence</th><th>Owner action</th>
        </tr></thead><tbody>{report.items.map(row=><tr key={row.reportRow}>
          <td data-label="SKU / historical row"><strong>{row.sku||'Missing SKU'}</strong>
            {' · '}row {row.reportRow}
            {row.countDiscrepancyOpen&&
              <p className="field-hint">Count declarations disagree — open</p>}
          </td>
          <td data-label="Current fingerprint">{row.manifest?
            <><strong>{row.manifest.documentCode}</strong>
              <small> · SHA-256 {row.manifest.fileSha256.slice(0,16)}…</small>
              {row.manifest.requiresRecheck&&
                <p>Source claims changed; recheck this fingerprint.</p>}
            </>:'No registered original fingerprint'}</td>
          <td data-label="Custody evidence">
            {row.latestCustodyEvent?
              <><strong>{steps[row.latestCustodyEvent.action]}</strong>
                <small> · custody reference {row.latestCustodyEvent.locationCode}</small>
                <p>{row.latestCustodyEvent.note}</p>
                {row.latestCustodyEvent.needsRecheck&&
                  <p className="field-hint">Earlier entry needs recheck</p>}
              </>:'No custody declaration'}
            <small> · {filters[row.status]||'Not verified'}</small>
          </td>
          <td data-label="Owner action">
            <button type="button" className="button secondary small"
              disabled={busy||posting||Boolean(selected)||
                !report.evidenceVerified||!row.mayRecord}
              onClick={()=>begin(row)}>Record custody step</button>
          </td>
        </tr>)}</tbody></table>
      </TableRegion>:<p className="field-hint">No records match. This does not certify inventory.</p>}
      {selected&&<form className="form-stack" onSubmit={submit}
        aria-label="Record owner custody declaration">
        <h4>Evidence handling · source row {selected.reportRow}</h4>
        <p>Original fingerprint #{selected.manifest.id}; count claims
          #{selected.firstClaimId} and #{selected.secondClaimId}.
          A review request here does not deliver a file to anyone.</p>
        <label>Handling declaration
          <select className="input" aria-label="Custody handling action"
            value={step} disabled={posting}
            onChange={e=>{
              setStep(e.target.value);
              setChannel(e.target.value==='independent_review_requested'?
                'in_person':'none');
            }}>
            {Object.entries(steps).map(([key,name])=>
              <option key={key} value={key}>{name}</option>)}
          </select>
        </label>
        <label>Anonymous secure-storage reference (not a filesystem path)
          <input className="input" required minLength={4} maxLength={48}
            aria-label="Secure storage reference code" value={locationCode}
            disabled={posting} onChange={e=>setLocationCode(e.target.value)}
            placeholder="e.g. SEALED_CASE_0001"/>
        </label>
        {step==='independent_review_requested'&&<label>Proposed review handoff method
          <select className="input" aria-label="Proposed review channel"
            disabled={posting} value={channel} onChange={e=>setChannel(e.target.value)}>
            {Object.entries(channels).filter(([key])=>key!=='none').map(
              ([key,name])=><option key={key} value={key}>{name}</option>)}
          </select>
        </label>}
        <label>One-line custody / review preparation note (no personal data)
          <textarea className="input" required rows={2} maxLength={180}
            aria-label="Owner custody preparation note" value={note}
            disabled={posting} onChange={e=>setNote(e.target.value)}
            placeholder="e.g. Original held in secure cabinet, independent review requested."/>
        </label>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <button className="button secondary" type="submit"
            disabled={posting||!report.evidenceVerified}>
            <ClipboardCheck size={16}/>{posting?'Recording…':'Save unverified custody entry'}
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
      <p className="report-scope">No file is uploaded or delivered. Physical
        custody, handoff, identity, signatures, receiving acknowledgement,
        stock approval, payment and checkout remain independently unverified.</p>
    </>}
  </section>;
}
