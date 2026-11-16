import React, {useCallback,useEffect,useState} from 'react';
import {api} from './api.js';

// Owner provisions a single-purpose account and grants one evidence snapshot.
// Neither action verifies the reviewer's real-world identity or authorizes stock.
export default function ReviewerAccessPanel(){
  const [data,setData]=useState(null);
  const [username,setUsername]=useState('review.');
  const [temporary,setTemporary]=useState(null);
  const [account,setAccount]=useState('');
  const [caseRow,setCaseRow]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const load=useCallback(async()=>{
    const result=await api('/stock-safety/reviewer-access');
    if(result?.kind!=='owner-reviewer-access-register'||result.stockImportAuthorized!==false||
       result.checkoutAuthorized!==false||!Array.isArray(result.accounts)||
       !Array.isArray(result.cases)||!Array.isArray(result.assignments))
      throw new Error('Reviewer-access evidence is not safe to display.');
    setData(result);
  },[]);
  useEffect(()=>{load().catch(e=>setError(e.message));},[load]);
  async function action(fn){
    setBusy(true);setError('');setNotice('');
    try{await fn();await load();}
    catch(e){setError(e.message||'Reviewer access could not be changed.');}
    finally{setBusy(false);}
  }
  function provision(e){
    e.preventDefault();
    action(async()=>{
      const result=await api('/stock-safety/reviewer-access/accounts',{
        method:'POST',body:{username:username.trim().toLowerCase()},
      });
      if(result?.kind!=='reviewer-account-created'||!result.temporaryPassword||
         result.humanIdentityVerified!==false)
        throw new Error('Reviewer account provisioning was not confirmed.');
      setTemporary({username:result.username,password:result.temporaryPassword});
      setUsername('review.');
      setAccount(result.reviewerId);
      setNotice('Restricted reviewer account created. Share the one-time password through a private, trusted channel.');
    });
  }
  function grant(e){
    e.preventDefault();
    const row=data?.cases.find(x=>String(x.reportRow)===caseRow);
    if(!row||!account)return;
    action(async()=>{
      const result=await api('/stock-safety/reviewer-access/grants',{method:'POST',body:{
        reviewerId:account,reportRow:row.reportRow,
        expectedRef:data.snapshotRef,
        custodyRequestId:row.custodyRequestId,
        manifestId:row.manifestId,fileSha256:row.fileSha256,
        firstClaimId:row.firstClaimId,secondClaimId:row.secondClaimId,
        requestId:crypto.randomUUID(),
      }});
      if(result?.kind!=='reviewer-case-grant'||result.checkoutAuthorized!==false)
        throw new Error('Reviewer grant not confirmed as restricted.');
      setNotice('Case metadata assigned. The reviewer will need to sign in and change their temporary password.');
    });
  }
  function revoke(id){
    action(async()=>{
      const result=await api('/stock-safety/reviewer-access/revoke',{method:'POST',body:{
        grantId:id,requestId:crypto.randomUUID(),
      }});
      if(result?.revoked!==true)throw new Error('Revocation not confirmed.');
      setNotice('Assignment revoked. Prior audit records remain append-only.');
    });
  }
  return <section className="surface records-surface" role="region"
    aria-label="Independent reviewer account and case access">
    <header>
      <span className="eyebrow">Physical count evidence · Phase 5.4</span>
      <h3>Independent reviewer access — restricted account</h3>
      <p>Create a reviewer-only login and assign individual custody requests.
        No sales, customer, payment or stock permissions are granted.</p>
    </header>
    <div className="notice notice-warning" style={{padding:16}} role="note">
      <strong>Login is not identity verification.</strong> Check the reviewer independently,
      provide any original document through a separately controlled channel,
      and keep conflicting counts OPEN. No response authorizes stock import or checkout.
    </div>
    {error&&<p role="alert" className="field-hint">{error}</p>}
    {notice&&<p role="status" className="field-hint">{notice}</p>}
    <button className="button secondary" type="button"
      onClick={()=>load().catch(e=>setError(e.message))}>Refresh access register</button>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:16,marginTop:18}}>
      <form onSubmit={provision} className="surface" style={{padding:16}}>
        <h4>1. Create reviewer account</h4>
        <p className="field-hint">Username must start with review. and have at least four characters after that prefix.</p>
        <label>Account username<input className="input" required pattern="review\.[a-z0-9][a-z0-9._-]{2,35}"
          value={username} onChange={e=>setUsername(e.target.value)}/></label>
        <button className="button primary" disabled={busy}>Generate one-time password</button>
      </form>
      <form onSubmit={grant} className="surface" style={{padding:16}}>
        <h4>2. Grant one review request</h4>
        <label>Active reviewer account
          <select className="input" value={account} onChange={e=>setAccount(e.target.value)} required>
            <option value="">Choose reviewer</option>
            {data?.accounts.filter(x=>x.active).map(x=><option key={x.id} value={x.id}>{x.username}</option>)}
          </select>
        </label>
        <label>Eligible request
          <select className="input" value={caseRow} onChange={e=>setCaseRow(e.target.value)} required>
            <option value="">Choose source row</option>
            {data?.cases.map(x=><option key={x.reportRow} value={x.reportRow}>Row {x.reportRow} · {x.sku}</option>)}
          </select>
        </label>
        <button className="button primary" disabled={busy||!data?.cases.length}>Grant metadata-only access</button>
      </form>
    </div>
    {temporary&&<div className="surface" style={{padding:16,marginTop:16}} role="status">
      <h4>Temporary credential — shown only on creation</h4>
      <p><strong>Username:</strong> <code>{temporary.username}</code></p>
      <p><strong>Temporary password:</strong> <code style={{overflowWrap:'anywhere'}}>{temporary.password}</code></p>
      <p className="field-hint">Deliver privately; do not put passwords in a customer or staff group. Reviewer must change it on first sign-in.</p>
      <button className="button secondary" type="button" onClick={()=>setTemporary(null)}>I have safely stored it · clear display</button>
    </div>}
    <div style={{marginTop:24}}>
      <h4>Reviewer account assignments</h4>
      {!data?.assignments.length?<p className="field-hint">No reviewer case has been assigned yet.</p>:
        <div style={{display:'grid',gap:10}}>
          {data.assignments.map(x=><div key={x.grantId} className="surface" style={{padding:14}}>
            <p><strong>Case {x.reportRow}</strong> · {data.accounts.find(a=>a.id===x.reviewerId)?.username||'Reviewer account'}
              {' · '}{x.status.replaceAll('_',' ')}</p>
            <p className="field-hint">Document hash: {x.fileSha256} ·
              Count disagreement: {x.countDiscrepancyOpen===true?'OPEN':'Not verified / unavailable'}</p>
            {x.latestAcknowledgement&&<p className="field-hint">Account response: {x.latestAcknowledgement.outcome.replaceAll('_',' ')}
              {' · '}{x.latestAcknowledgement.recordedAt}</p>}
            {x.status!=='revoked'&&<button type="button" className="button secondary"
              disabled={busy} onClick={()=>revoke(x.grantId)}>Revoke assignment</button>}
          </div>)}
        </div>}
    </div>
  </section>;
}