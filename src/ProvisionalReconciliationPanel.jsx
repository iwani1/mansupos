import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {Notice} from './components.jsx';

// Owner-only: prepare an UNVERIFIED reconciliation proposal bound to a current
// reviewer case. Even an exact proposed count NEVER changes physical/Woo stock.
const intents={
  request_blind_recount:'Request a new blind recount (no units recorded)',
  inspect_original_count_document:'Request inspection of original count sheet',
  investigate_product_variation:'Investigate style, colour, size and variation',
  prepare_provisional_count:'Record an unverified provisional physical unit count',
};
const findings={
  requires_independent_recount:'Fresh independent recount required',
  original_document_unavailable:'Reviewer account reports missing original document',
  product_variation_uncertain:'Product/variation identity uncertain',
  witness_identity_not_proven:'Human reviewer identity not independently proven',
  other_evidence_problem:'Other evidence problem',
};
export default function ProvisionalReconciliationPanel(){
  const [data,setData]=useState(null);
  const [page,setPage]=useState(1);
  const [search,setSearch]=useState('');
  const [selected,setSelected]=useState(null);
  const [grantId,setGrantId]=useState('');
  const [intent,setIntent]=useState('request_blind_recount');
  const [units,setUnits]=useState('');
  const [note,setNote]=useState('');
  const [busy,setBusy]=useState(false);
  const [posting,setPosting]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const sequence=useRef(0);
  const load=useCallback(async()=>{
    const id=++sequence.current;
    setBusy(true);setError('');
    try{
      const params=new URLSearchParams({
        page:String(page),pageSize:'10',search:search.trim(),
      });
      const r=await api('/stock-safety/reconciliation-packets?'+params);
      if(r?.kind!=='owner-provisional-reconciliation-register'||
        r.auditOnly!==true||r.provisionalOnly!==true||
        r.inventoryAccepted!==false||r.stockImportAuthorized!==false||
        r.checkoutAuthorized!==false||!Array.isArray(r.items))
        throw new Error('Unverified reconciliation register was not confirmed.');
      if(id===sequence.current)setData(r);
    }catch(e){if(id===sequence.current)setError(e.message);}
    finally{if(id===sequence.current)setBusy(false);}
  },[page,search]);
  useEffect(()=>{const ref=sequence;void load();return()=>{ref.current++;};},[load]);
  function begin(row){
    setSelected({...row,requestId:crypto.randomUUID()});
    setGrantId(row.availableGrants[0]?String(row.availableGrants[0].grantId):'');
    setIntent('request_blind_recount');setUnits('');setNote('');
    setError('');setNotice('');
  }
  async function submit(e){
    e.preventDefault();
    if(!selected||!data||note.trim().length<12||!grantId)return;
    const provisionalUnits=intent==='prepare_provisional_count'?Number(units):null;
    if(intent==='prepare_provisional_count'&&
      (!/^\d+$/.test(units.trim())||!Number.isSafeInteger(provisionalUnits)||
        provisionalUnits>1000000)){
      setError('Enter a provisional whole number from 0 to 1,000,000.');return;
    }
    setPosting(true);setError('');setNotice('');
    try{
      const r=await api('/stock-safety/reconciliation-packets',{method:'POST',body:{
        reportRow:selected.reportRow,grantId:Number(grantId),
        expectedReadinessRef:data.readinessRef,
        expectedRowEvidenceRef:selected.rowEvidenceRef,
        expectedLatestPacketId:selected.latestPacket?.id??null,
        intent,proposedUnits,note:note.trim(),
        requestId:selected.requestId,
      }});
      if(r?.kind!=='owner-unverified-reconciliation-proposal'||
        r.provisionalOnly!==true||r.stockImportAuthorized!==false||
        r.checkoutAuthorized!==false||r.reconciliationApproved!==false)
        throw new Error('Provisional reconciliation record was not confirmed.');
      setSelected(null);setUnits('');setNote('');
      setNotice('An Owner PROPOSAL was recorded. It is not accepted inventory and requires external independent verification.');
      await load();
    }catch(e){setError(e.message||'Could not record the unverified proposal.');}
    finally{setPosting(false);}
  }
  return <section className="surface records-surface" aria-label="Provisional reconciliation packet register">
    <header>
      <span className="eyebrow">Phase 5.8 · Owner and restricted reviewer separation</span>
      <h3>Provisional reconciliation packets — not inventory approval</h3>
      <p>Prepare a case for further outside verification and assign it to an
        already-authorized reviewer account. Any recorded units remain an Owner
        proposal, never a usable store or website stock quantity.</p>
    </header>
    <Notice tone="warning">
      <strong>Strictly evidence-only.</strong> Neither this Owner proposal nor an account
      reviewer finding can verify a person, resolve a count dispute, approve
      stock import, or release checkout. Provisional counts are private to the Owner.
    </Notice>
    {error&&<p className="field-hint" role="alert">{error}</p>}
    {notice&&<p className="field-hint" role="status">{notice}</p>}
    <div style={{display:'flex',gap:12,alignItems:'end',flexWrap:'wrap',marginTop:16}}>
      <label>SKU or historical row
        <input className="input" type="search" maxLength={64}
          value={search} onChange={e=>{setSearch(e.target.value);setPage(1);setSelected(null);}}/>
      </label>
      <button type="button" className="button secondary" disabled={busy||posting}
        onClick={load}>{busy?'Refreshing…':'Refresh provisional packets'}</button>
    </div>
    {data&&<div style={{marginTop:16}}>
      <p className="field-hint">{data.summary.historicalRows} historical rows ·
        {' '}{data.summary.provisionalProposals} proposal events ·
        {' '}{data.summary.accountReportedIssues} reviewer-account findings ·
        {' '}<strong>0 accepted units</strong></p>
      {!data.items.length?<p>No matching evidence rows.</p>:
        <div style={{display:'grid',gap:12}}>
          {data.items.map(row=><article className="surface" key={row.reportRow}
            style={{padding:14}}>
            <h4>Row {row.reportRow} · {row.sku}</h4>
            <p className="field-hint">Readiness: BLOCKED ·
              Staff count dispute: {row.countDiscrepancyOpen?'OPEN':'Not independently verified'}</p>
            {row.latestPacket&&<div className="field-hint">
              <p>Latest Owner proposal #{row.latestPacket.id}: {intents[row.latestPacket.intent]}
                {' · '}{row.latestPacket.status.replaceAll('_',' ')}</p>
              {row.latestPacket.proposedUnits!==null&&
                <p><strong>{row.latestPacket.proposedUnits}</strong> Owner-proposed units — NOT usable stock</p>}
              {row.latestPacket.latestResponse&&
                <p>Reviewer account finding: {findings[row.latestPacket.latestResponse.finding]}
                  {' · '}independent human witnessing remains UNVERIFIED</p>}
            </div>}
            {row.availableGrants.length?
              <button type="button" className="button secondary" disabled={posting}
                onClick={()=>begin(row)}>Prepare revised unverified proposal</button>:
              <p className="field-hint">No active dedicated reviewer assignment.
                Grant access through the reviewer access panel first.</p>}
          </article>)}
        </div>}
      <div style={{display:'flex',gap:12,justifyContent:'flex-end',marginTop:16}}>
        <button type="button" className="button secondary"
          disabled={busy||posting||page<=1}
          onClick={()=>{setPage(x=>x-1);setSelected(null);}}>Previous</button>
        <button type="button" className="button secondary"
          disabled={busy||posting||page>=data.pages}
          onClick={()=>{setPage(x=>x+1);setSelected(null);}}>Next</button>
      </div>
    </div>}
    {selected&&<form className="surface" style={{padding:16,marginTop:20}}
      onSubmit={submit} aria-label="Owner unverified physical reconciliation plan">
      <h4>Prepare provisional evidence for row {selected.reportRow}</h4>
      <p>Choose the reviewer account responsible for investigating; their
        screen will not disclose any proposed unit count or your private notes.</p>
      <label>Current assigned reviewer
        <select className="input" required value={grantId}
          onChange={e=>setGrantId(e.target.value)}>
          {selected.availableGrants.map(a=><option key={a.grantId} value={a.grantId}>
            {a.username||a.reviewerId} · case grant #{a.grantId}
          </option>)}
        </select>
      </label>
      <label>Unverified next step
        <select className="input" value={intent}
          onChange={e=>{setIntent(e.target.value);setUnits('');}}>
          {Object.entries(intents).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      {intent==='prepare_provisional_count'&&<label>Provisional units — NOT stock
        <input className="input" type="number" min={0} max={1000000}
          step={1} required value={units} onChange={e=>setUnits(e.target.value)}/>
      </label>}
      <label>Factual investigation note, 12–180 characters
        <textarea className="input" required rows={3} minLength={12} maxLength={180}
          value={note} onChange={e=>setNote(e.target.value)}/>
      </label>
      <div style={{display:'flex',gap:12,marginTop:12}}>
        <button className="button primary" disabled={posting}>
          {posting?'Recording…':'Record proposal — NOT approval'}</button>
        <button className="button secondary" type="button" disabled={posting}
          onClick={()=>setSelected(null)}>Cancel</button>
      </div>
    </form>}
  </section>;
}
