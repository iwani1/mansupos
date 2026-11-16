import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {Notice} from './components.jsx';

// Read-only Owner inspection. Synthetic PASS is not production permission.
const stageTitle={
  physical_inventory_acceptance:'1. Independent inventory acceptance',
  store_website_stock_synchronization:'2. Store and website stock safety',
  checkout_payments_refunds:'3. Checkout, cash, Paystack and refunds',
  security_backup_training_release:'4. Recovery, security and controlled launch',
};
const track={
  physical:'Independent physical evidence',
  sync:'Actual WooCommerce integration',
  payment:'Actual checkout and gateway testing',
  release:'Production release checks',
};
export default function FullLaunchReadinessPanel(){
  const [report,setReport]=useState(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const sequence=useRef(0);
  const load=useCallback(async()=>{
    const id=++sequence.current;
    setBusy(true);setError('');
    try{
      const data=await api('/stock-safety/full-launch-readiness');
      if(data?.kind!=='owner-four-track-launch-readiness'||
        data.releaseBlocked!==true||data.productionReady!==false||
        data.authorizedLiveDeployment!==false||
        data.stockImportAuthorized!==false||
        data.checkoutAuthorized!==false||data.paymentsAuthorized!==false||
        data.content?.format!=='mansupos-four-track-build-readiness-v1'||
        !Array.isArray(data.content.stages)||data.content.stages.length!==4||
        !Array.isArray(data.content.requirements)||
        data.content.requirements.some(x=>x.verified!==false))
        throw new Error('The full launch-readiness report did not confirm permanent release holds.');
      if(sequence.current===id)setReport(data);
    }catch(e){if(sequence.current===id)setError(e.message||'Could not verify release hold.');}
    finally{if(sequence.current===id)setBusy(false);}
  },[]);
  useEffect(()=>{const request=sequence;void load();return()=>{request.current++;};},[load]);
  return <section className="surface records-surface"
    role="region" aria-label="Four-stage development and launch safety report">
    <header>
      <span className="eyebrow">Remaining four tracks · development safety review</span>
      <h3>Store + website launch readiness</h3>
      <p>The code can exercise synthetic stock and payment edge cases, but a
        live release needs independently verified stock, installed-site concurrency,
        real gateway evidence, backup restoration and explicit Owner acceptance.</p>
    </header>
    <Notice tone="warning">
      <strong>Production release BLOCKED.</strong> No current evidence permits
      new WooCommerce stock imports, automated deductions, POS checkout,
      collecting payment or changing the Contabo trading service.
    </Notice>
    {error&&<p className="field-hint" role="alert">{error}</p>}
    <button type="button" className="button secondary" disabled={busy}
      onClick={load}>{busy?'Checking…':'Refresh release readiness'}</button>
    {report&&<div style={{marginTop:18}}>
      <div className="surface" style={{padding:16}}>
        <h4>Synthetic validation only — not the live store</h4>
        <p>Shared stock model: <strong>{report.content.evidence.syntheticStockChecksPassed}
          /{report.content.evidence.syntheticStockTestCount}</strong> scenarios passing.</p>
        <p>Payment/refund model: <strong>{report.content.evidence.syntheticPaymentChecksPassed}
          /{report.content.evidence.syntheticPaymentTestCount}</strong> scenarios passing.</p>
        <p className="field-hint">Actual WooCommerce orders written: 0 ·
          Actual Paystack calls: 0 · Live checkout authorized: NO.</p>
      </div>
      <div style={{display:'grid',gap:12,marginTop:16}}>
        {report.content.stages.map(s=><article className="surface" key={s.id}
          style={{padding:16}}>
          <h4>{stageTitle[s.id]||s.label}</h4>
          <p>{s.developmentArtifact}</p>
          <p className="field-hint">Synthetic check: {s.syntheticCheck.replaceAll('_',' ')}
            {' · '}Independent external verification: NO
            {' · '}Production enabled: NO</p>
          <ul>
            {report.content.requirements.filter(x=>x.track===({
              physical_inventory_acceptance:'physical',
              store_website_stock_synchronization:'sync',
              checkout_payments_refunds:'payment',
              security_backup_training_release:'release',
            })[s.id]).map(x=><li key={x.id}>
              {x.reason} <strong>— still required</strong>
            </li>)}
          </ul>
        </article>)}
      </div>
      <div className="surface" style={{padding:16,marginTop:16}}>
        <h4>Historical inventory evidence</h4>
        <p>{report.content.evidence.historicalSourceRows} historical stock rows ·
          {' '}{report.content.evidence.unresolvedPhysicalCountRows} disputed count cases ·
          0 independently accepted rows.</p>
        <p className="field-hint">Audit evidence checksum:
          {' '}<code style={{overflowWrap:'anywhere'}}>
            {report.content.evidence.independentAuditManifestSha256}
          </code></p>
        <p className="field-hint">The checksum does not prove original records,
          independent witnessing or authentic human signatures.</p>
      </div>
      <p><strong>Deployment remains blocked.</strong> No override or launch
        action is provided by this review screen.</p>
      <p className="field-hint">Track categories: {Object.values(track).join(' · ')}.</p>
    </div>}
  </section>;
}
