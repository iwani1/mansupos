import React, { useState, useRef } from 'react';
import { AlertTriangle, FileCheck2, FileSearch, LockKeyhole } from 'lucide-react';
import { api, uuid } from './api.js';
import { Notice, TableRegion } from './components.jsx';
import { fingerprintPrivateCountFile, comparePrivateCountFile } from './private-count-file-fingerprint.js';

const filters={
  all:'All historic rows',missing_manifest:'Two counts, no file fingerprint',
  manifest_unverified:'File fingerprint recorded — unverified',
  count_discrepancy_open:'Conflicting staff counts — remains open',
  identity_hold:'Source identity held',waiting_for_counts:'Two counts incomplete',
};
const documentTypes={
  count_sheet:'Physical count sheet',
  witness_statement:'Witness statement (not authenticated)',
  garment_photo:'Garment reference photo',
};

// Browser processes a selected file LOCALLY. Only SHA-256, file size, MIME
// and a private reference are sent; never filename, file contents or images.
export default function PrivateCountFileRegister(){
  const [status,setStatus]=useState('all');
  const [search,setSearch]=useState('');
  const [report,setReport]=useState(null);
  const [selected,setSelected]=useState(null);
  const [operation,setOperation]=useState('record');
  const [documentType,setDocumentType]=useState('count_sheet');
  const [documentCode,setDocumentCode]=useState('');
  const [fingerprint,setFingerprint]=useState(null);
  const [fingerprintBusy,setFingerprintBusy]=useState(false);
  const [loading,setLoading]=useState(false);
  const [posting,setPosting]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const retry=useRef({key:'',requestId:''});
  const clear=()=>{setReport(null);setSelected(null);setFingerprint(null);
    setError('');setMessage('');};
  const load=async(page=1,expectedRef='')=>{
    setLoading(true);setReport(null);setSelected(null);setError('');
    try{
      const params=new URLSearchParams({
        page:String(page),pageSize:'25',status,search:search.trim(),
      });
      if(expectedRef)params.set('expectedRef',expectedRef);
      const data=await api('/stock-safety/count-file-manifests?'+params.toString());
      if(data?.kind!=='owner-private-count-file-manifest-review'||
         data.auditOnly!==true||data.documentContentUploaded!==false||
         data.fileSignatureVerified!==false||
         data.independentWitnessVerified!==false||data.ownerApproved!==false||
         data.mappingApproved!==false||data.stockImportAuthorized!==false||
         data.sharedStockVerified!==false||data.checkoutAuthorized!==false||
         !/^[a-f0-9]{64}$/.test(data.snapshotRef||'')||
         !Array.isArray(data.items)||data.items.length>25||
         !Number.isSafeInteger(data.page)||!Number.isSafeInteger(data.pages)){
        throw new Error('Private evidence register failed its read-only safety contract.');
      }
      setReport(data);
    }catch(failure){setError(failure?.message||'Could not load private file manifest records.');}
    finally{setLoading(false);}
  };
  const open=(item,mode)=>{
    setSelected(item);setOperation(mode);setDocumentCode('');
    setDocumentType('count_sheet');setFingerprint(null);
    setError('');setMessage('');retry.current={key:'',requestId:''};
  };
  const onFile=async(event)=>{
    const file=event.target.files?.[0];
    setFingerprint(null);setError('');setMessage('');
    if(!file)return;
    setFingerprintBusy(true);
    try{
      const result=await fingerprintPrivateCountFile(file);
      setFingerprint(result);
    }catch(failure){
      setError(failure?.message||'Cannot calculate local file SHA-256.');
    }finally{
      setFingerprintBusy(false);
      // Release the browser's file selection. No file bytes are stored in state.
      event.target.value='';
    }
  };
  const save=async(event)=>{
    event.preventDefault();
    if(!selected||!report||!fingerprint||posting||fingerprintBusy)return;
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{3,47}$/.test(documentCode.trim())){
      setError('Enter a private document code of 4–48 safe characters.');return;
    }
    const body={
      reportRow:selected.reportRow,expectedRef:report.snapshotRef,
      expectedLatestManifestId:selected.latestManifest?.id??null,
      firstClaimId:selected.firstClaimId,secondClaimId:selected.secondClaimId,
      documentCode:documentCode.trim(),documentType,
      ...fingerprint,
    };
    const key=JSON.stringify(body);
    if(retry.current.key!==key)retry.current={key,requestId:uuid()};
    setPosting(true);setError('');setMessage('');
    try{
      const response=await api('/stock-safety/count-file-manifests',{
        method:'POST',body:{...body,requestId:retry.current.requestId},
      });
      if(response?.kind!=='unverified-local-count-file-manifest'||
         response.recorded!==true||response.auditOnly!==true||
         response.documentContentUploaded!==false||
         response.independentWitnessVerified!==false||
         response.ownerApproved!==false||
         response.stockImportAuthorized!==false||
         response.checkoutAuthorized!==false)
        throw new Error('The POS did not confirm safe metadata-only recording.');
      setFingerprint(null);setSelected(null);
      retry.current={key:'',requestId:''};
      setMessage('File fingerprint recorded locally. No document was uploaded or verified as authentic.');
      await load(report.page);
    }catch(failure){
      setError(failure?.message||'Could not confirm recording. Check the register before retrying.');
    }finally{setPosting(false);}
  };
  const comparison=operation==='compare'&&fingerprint&&selected?.latestManifest?
    comparePrivateCountFile(fingerprint,selected.latestManifest):'not_checked';
  return <section className="surface records-surface" role="region"
    aria-label="Private count document integrity register">
    <div className="section-heading"><div>
      <span className="eyebrow">Owner / private file integrity</span>
      <h3>Count document fingerprints — not independent verification</h3>
      <p>Keep your original signed count sheets or photos in private custody.
        Register a SHA-256 checksum without uploading the file itself.</p>
    </div></div>
    <Notice tone="warning"><LockKeyhole size={16}/>
      <strong>Document bytes stay on your device.</strong> A matching hash
      confirms identical bytes only. Neither the contents, signatures,
      individual witnesses nor actual inventory are authenticated here.
    </Notice>
    <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'end'}}>
      <label style={{flex:'1 1 220px'}}>Review status
        <select className="input" aria-label="Filter private file register"
          value={status} disabled={loading||posting}
          onChange={e=>{setStatus(e.target.value);clear();}}>
          {Object.entries(filters).map(([key,label])=>
            <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 200px'}}>Source row or historical SKU
        <input className="input" type="search" maxLength={64}
          aria-label="Search private file register" value={search}
          disabled={loading||posting}
          onChange={e=>{setSearch(e.target.value);clear();}}/>
      </label>
      <button className="button secondary" type="button" disabled={loading||posting}
        onClick={()=>load(1)}><FileSearch size={16}/>
        {loading?'Checking…':'Open private file register'}
      </button>
    </div>
    {loading&&<p role="status" className="field-hint">
      Reading local checksum metadata. No document or WooCommerce writes.</p>}
    {error&&<Notice tone="error"><AlertTriangle size={16}/>{error}</Notice>}
    {message&&<Notice tone="warning">{message}</Notice>}
    {report&&!loading&&<>
      {!report.evidenceVerified&&<Notice tone="error">
        Signed source or Woo identity evidence is stale/incomplete. Recording is blocked.
      </Notice>}
      <p className="field-hint">{report.total} rows · Page {report.page} of {report.pages}.
        {report.totalRecordedUnverified} current file fingerprints recorded,
        none independently authenticated.</p>
      {report.items.length>0?<TableRegion label="Count file fingerprint records">
        <table className="responsive-table"><thead><tr>
          <th>Historical SKU / row</th><th>Count state</th>
          <th>Latest private reference</th><th>Local actions</th>
        </tr></thead><tbody>{report.items.map(row=><tr key={row.reportRow}>
          <td data-label="Historical SKU / row"><strong>{row.sku||'Missing SKU'}</strong>
            {' · '}Row {row.reportRow}</td>
          <td data-label="Count state">{filters[row.status]||'Unverified'}</td>
          <td data-label="Latest private reference">
            {row.latestManifest?<div>
              <strong>{row.latestManifest.documentCode}</strong>
              <small> · {documentTypes[row.latestManifest.documentType]} ·
                {row.latestManifest.fileBytes} bytes</small>
              {row.latestManifest.requiresRecheck&&
                <p className="field-hint">Claim IDs changed — recheck needed</p>}
              {row.latestManifest.sameBytesReferencedElsewhere&&
                <p className="field-hint">Same file fingerprint on another row — investigate</p>}
              <small>SHA-256: {row.latestManifest.fileSha256.slice(0,16)}…</small>
            </div>:'No document fingerprint yet'}
          </td>
          <td data-label="Local actions">
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              <button className="button secondary small" type="button"
                disabled={loading||posting||Boolean(selected)||!report.evidenceVerified||
                  !row.mayRecord}
                onClick={()=>open(row,'record')}>Record fingerprint</button>
              {row.latestManifest&&<button className="button secondary small"
                type="button" disabled={loading||posting||Boolean(selected)}
                onClick={()=>open(row,'compare')}>Compare local file</button>}
            </div>
          </td>
        </tr>)}</tbody></table>
      </TableRegion>:<p className="field-hint">No rows match this filter. No stock has been approved.</p>}
      {selected&&<form onSubmit={save} className="form-stack"
        aria-label="Private count document fingerprint form">
        <h4>{operation==='record'?'Register file SHA-256':'Check local file SHA-256'}
          {' · '}Row {selected.reportRow}</h4>
        <p>First count #{selected.firstClaimId}, second count #{selected.secondClaimId}.
          Select a PDF, PNG or JPEG up to 10 MB. It is read and hashed locally,
          not sent to MansuPOS.</p>
        <label>Private evidence file (not uploaded)
          <input className="input" type="file" aria-label="Choose private evidence file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            disabled={posting||fingerprintBusy} onChange={onFile}/>
        </label>
        {fingerprintBusy&&<p role="status">Calculating SHA-256 on this device…</p>}
        {fingerprint&&<p className="field-hint">
          Local SHA-256: {fingerprint.fileSha256} · {fingerprint.fileBytes} bytes.
          {operation==='compare'&&<>
            {' '}<strong>{comparison==='bytes_match'?
              'BYTES MATCH — contents not authenticated':
              'BYTES DIFFER — do not trust this file as the recorded copy'}</strong>
          </>}
        </p>}
        {operation==='record'&&<>
          <label>Type of supporting material
            <select className="input" aria-label="Count evidence document type"
              disabled={posting} value={documentType}
              onChange={e=>setDocumentType(e.target.value)}>
              {Object.entries(documentTypes).map(([key,name])=>
                <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
          <label>Private paper-file code (no customer or staff names)
            <input className="input" required minLength={4} maxLength={48}
              aria-label="Count evidence private code" disabled={posting}
              value={documentCode} onChange={e=>setDocumentCode(e.target.value)}
              placeholder="e.g. COUNT_NOV_0001"/>
          </label>
        </>}
        <div style={{display:'flex',flexWrap:'wrap',gap:10}}>
          {operation==='record'&&<button className="button secondary"
            type="submit" disabled={posting||fingerprintBusy||!fingerprint||
              !report.evidenceVerified}>
            <FileCheck2 size={16}/>{posting?'Recording…':'Save file fingerprint only'}
          </button>}
          <button className="button secondary" type="button" disabled={posting}
            onClick={()=>{setSelected(null);setFingerprint(null);}}>Close</button>
        </div>
      </form>}
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',marginTop:12}}>
        <button className="button secondary" type="button"
          disabled={loading||posting||Boolean(selected)||report.page<=1}
          onClick={()=>load(report.page-1,report.snapshotRef)}>Previous</button>
        <button className="button secondary" type="button"
          disabled={loading||posting||Boolean(selected)||!report.hasMore}
          onClick={()=>load(report.page+1,report.snapshotRef)}>Next</button>
      </div>
      <p className="report-scope">A checksum cannot establish the author,
        date, truth or signature of a document. Originals need secure
        offline custody and independent human review. No stock, payment,
        approval, Woo import or file upload is performed.</p>
    </>}
  </section>;
}
