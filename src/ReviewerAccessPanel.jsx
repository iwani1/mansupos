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
  const [handoffSecret,setHandoffSecret]=useState(null);
  const [identityMethod,setIdentityMethod]=useState('owner_reports_in_person_check');
  const [transferChannel,setTransferChannel]=useState('in_person');
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
  function issueHandoff(grantId){
    setHandoffSecret(null);
    action(async()=>{
      const result=await api('/stock-safety/reviewer-access/handoff',{
        method:'POST',body:{
          grantId,expectedRef:data.snapshotRef,
          identityCheckMethod:identityMethod,transferChannel,
          requestId:crypto.randomUUID(),
        },
      });
      if(result?.kind!=='reviewer-handoff-challenge'||!result.challenge||
         result.stockImportAuthorized!==false||result.checkoutAuthorized!==false)
        throw new Error('The one-time challenge could not be confirmed.');
      setHandoffSecret({grantId,challenge:result.challenge,expiresAt:result.expiresAt});
      setNotice('Challenge created. Share the secret out of band with the intended reviewer. No document was transferred by the POS.');
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
      <span className="eyebrow">Physical count evidence · Phase 5.5</span>
      <h3>Independent reviewer access — restricted account</h3>
      <p>Create reviewer-only logins, assign individual custody requests and
        issue one-time out-of-band handoff challenges. No sales, customer,
        payment or stock permissions are granted.</p>
    </header>
    <div className="notice notice-warning" style={{padding:16}} role="note">
      <strong>Identity and handoff are not independently verified.</strong> Your
      selected identity-check method is an Owner declaration only. The one-time
      challenge proves possession of a secret, not original-file delivery or
      independent witnessing. Keep conflicting counts OPEN; no response approves inventory.
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
    <div className="surface" style={{padding:16,marginTop:16}}>
      <h4>3. Prepare an out-of-band handoff challenge</h4>
      <p className="field-hint">Before issuing, check the intended reviewer independently.
        Do not enter a person’s name, ID document, phone number or address.
        The chosen method is only an Owner-reported declaration.</p>
      <div style={{display:'flex',flexWrap:'wrap',gap:12}}>
        <label>Owner-reported identity check
          <select className="input" value={identityMethod} onChange={e=>setIdentityMethod(e.target.value)}>
            <option value="owner_reports_in_person_check">In-person check reported</option>
            <option value="owner_reports_known_contact_callback">Known-contact callback reported</option>
            <option value="owner_reports_organization_callback">Organization callback reported</option>
          </select>
        </label>
        <label>Planned external transfer method
          <select className="input" value={transferChannel} onChange={e=>setTransferChannel(e.target.value)}>
            <option value="in_person">In person</option>
            <option value="secured_external_channel">Secured external channel</option>
            <option value="sealed_paper_copy">Sealed paper copy</option>
          </select>
        </label>
      </div>
      <p className="field-hint">A challenge expires after 24 hours. Share the code
        privately and separately from any physical document; MansuPOS itself
        does not send, upload or store documents.</p>
    </div>
    {handoffSecret&&<div className="surface" role="status" style={{padding:16,marginTop:16}}>
      <h4>One-time challenge for case #{handoffSecret.grantId}</h4>
      <p><code style={{overflowWrap:'anywhere'}}>{handoffSecret.challenge}</code></p>
      <p>Expires: {handoffSecret.expiresAt}</p>
      <p className="field-hint">Shown once. A reloaded page cannot retrieve this secret.
        Never paste it into a public post or shared business chat.</p>
      <button type="button" className="button secondary" onClick={()=>setHandoffSecret(null)}>
        Clear challenge display
      </button>
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
            <p className="field-hint">Handoff: {x.handoff?.status?.replaceAll('_',' ')||'not issued'}.
              {x.handoff?.receipt&&<> Account receipt: {x.handoff.receipt.observation.replaceAll('_',' ')}
                {' · '}Challenge possession reported; human identity and original authenticity remain unverified.</>}</p>
            {x.status==='assigned_metadata_only'&&
              ['not_issued','expired'].includes(x.handoff?.status)&&
              <button type="button" className="button secondary" disabled={busy}
                onClick={()=>issueHandoff(x.grantId)}>Issue one-time handoff challenge</button>}
            {x.status!=='revoked'&&<button type="button" className="button secondary"
              disabled={busy} onClick={()=>revoke(x.grantId)}>Revoke assignment</button>}
          </div>)}
        </div>}
    </div>
  </section>;
}