import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {Notice} from './components.jsx';

// Owner-only, GET-only offline metadata export. It does NOT sign,
 // authenticate human witnesses, deliver original documents or approve stock.
export default function InventoryAuditHandoff(){
  const [report,setReport]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const serial=useRef(0);
  const load=useCallback(async()=>{
    const request=++serial.current;
    setBusy(true);setError('');setNotice('');
    try{
      const value=await api('/stock-safety/audit-handoff');
      if(value?.kind!=='owner-inventory-audit-handoff'||
        value.auditOnly!==true||value.metadataOnly!==true||
        value.stockImportAuthorized!==false||
        value.checkoutAuthorized!==false||
        value.paymentsAuthorized!==false||
        value.inventoryAccepted!==false||
        value.releaseReady!==false||
        value.content?.format!=='mansupos-inventory-audit-handoff-v1'||
        !/^[a-f0-9]{64}$/.test(value.sha256||'')||
        !Array.isArray(value.content.items))
        throw new Error('The POS did not return a safe unapproved audit manifest.');
      if(request===serial.current)setReport(value);
    }catch(e){if(request===serial.current)setError(e.message||'Cannot prepare the evidence manifest.');}
    finally{if(request===serial.current)setBusy(false);}
  },[]);
  useEffect(()=>{const current=serial;void load();return()=>{current.current++;};},[load]);
  function download(){
    if(!report)return;
    // This is a browser-only download; no file is sent to an external contact.
    const bytes=JSON.stringify(report,null,2)+'\n';
    const blob=new Blob([bytes],{type:'application/json'});
    const location=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=location;
    link.download='mansupos-unverified-inventory-audit-'+report.sha256.slice(0,12)+'.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(location);
    setNotice('Metadata manifest saved by your browser. Keep the SHA-256 reference separately in a trusted location. It is NOT an audit certificate.');
  }
  return <section className="surface records-surface" role="region"
    aria-label="Offline inventory evidence handoff manifest">
    <header>
      <span className="eyebrow">Phase 5.9 · Owner-only offline audit preparation</span>
      <h3>Inventory audit handoff — metadata only</h3>
      <p>Export one evidence manifest for offline inspection by a trusted,
        independently verified professional. It records missing proof and
        historical event references without transferring original documents.</p>
    </header>
    <Notice tone="warning">
      <strong>NOT an independently signed or certified inventory audit.</strong>
      A SHA-256 checksum only helps detect changes relative to a checksum you
      recorded separately. It cannot prove a person’s identity or that the
      count, original file or WooCommerce stock is correct. No stock is released.
    </Notice>
    {error&&<p role="alert" className="field-hint">{error}</p>}
    {notice&&<p role="status" className="field-hint">{notice}</p>}
    <div style={{display:'flex',gap:12,flexWrap:'wrap',marginTop:14}}>
      <button type="button" className="button secondary" disabled={busy}
        onClick={load}>{busy?'Checking evidence…':'Refresh audit manifest'}</button>
      <button type="button" className="button primary" disabled={busy||!report}
        onClick={download}>Save metadata JSON for offline review</button>
    </div>
    {report&&<div style={{marginTop:16}}>
      <p><strong>{report.content.summary.historicalRows}</strong> historical source rows
        {' · '}<strong>{report.content.summary.disputedRows}</strong> count disagreements
        {' · '}<strong>0 accepted rows</strong></p>
      <p><strong>SHA-256 content checksum</strong></p>
      <code style={{overflowWrap:'anywhere'}}>{report.sha256}</code>
      <p className="field-hint">Record this checksum separately before transferring
        the JSON through a secure, independently chosen channel. The manifest
        contains SKUs, flags and event references; keep it private.</p>
      <h4>Included, but still unverified</h4>
      <p className="field-hint">Historical source reference, current readiness
        and reconciliation snapshot references, per-item open evidence
        requirements, case priority, latest packet type and reviewer account
        issue codes. No private Owner notes, proposed quantities, raw count
        sheets, reviewer passwords, customer data or document bytes.</p>
      <h4>Mandatory release controls</h4>
      <p className="field-hint">Independent witness, original signed physical
        counts, variation mappings, last-unit Woo reservations, Paystack
        callbacks/refunds, off-host backup restoration and supervised
        rollout all remain unverified.</p>
    </div>}
  </section>;
}
