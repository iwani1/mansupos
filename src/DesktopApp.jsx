import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutDashboard, ShoppingBag, Store, Package, ReceiptText, Users, RefreshCw, ShieldCheck,
  WifiOff, Wifi, LockKeyhole, ArrowRight, RotateCcw, Boxes, Settings2, LogOut, AlertTriangle,
  CheckCircle2, Banknote, Printer } from 'lucide-react';
import { api, money, dateTime, uuid } from './api.js';
import Register from './Register.jsx';
import Wholesale from './Wholesale.jsx';
import { Checkout, Receipt } from './Checkout.jsx';
import { Empty, Notice, PageHeading, ProductImage, Spinner, Toast, Modal } from './components.jsx';
import './desktop.css';

const links=[
  {id:'overview',label:'Overview',icon:LayoutDashboard}, {id:'register',label:'Point of sale',icon:ShoppingBag},
  {id:'wholesale',label:'Wholesale',icon:Store,manager:true}, {id:'inventory',label:'Reserved inventory',icon:Boxes},
  {id:'sales',label:'Local sales',icon:ReceiptText}, {id:'customers',label:'Customers',icon:Users,manager:true},
  {id:'sync',label:'Sync & conflicts',icon:RefreshCw}, {id:'settings',label:'Settings & allocation',icon:Settings2},
];
export default function DesktopApp(){
  const [session,setSession]=useState(null),[catalog,setCatalog]=useState(null),[sales,setSales]=useState([]),[queue,setQueue]=useState(null);
  const [page,setPage]=useState('overview'),[pending,setPending]=useState(null),[receipt,setReceipt]=useState(null);
  const [toast,setToast]=useState(null),[error,setError]=useState('');
  const [savedCarts,setSavedCarts]=useState([]),[online,setOnline]=useState(navigator.onLine);
  const notice=(message,tone='success')=>setToast({message,tone,id:Date.now()});
  const refresh=useCallback(async()=>{
    try {
      const s=await api('/session');setSession(s);
      if(!s.user){setCatalog(null);setSales([]);setQueue(null);return;}
      const [c,history,status]=await Promise.all([api('/catalog'),api('/sales'),api('/desktop/status')]);
      setCatalog(c);setSales(history.sales);setQueue(status);setError('');
    } catch (e){setError(e.message);}
  },[]);
  useEffect(()=>{refresh();},[refresh]);
  useEffect(()=>{const on=()=>setOnline(true),off=()=>setOnline(false),expired=()=>{setSession(s=>s?{...s,user:null}:s);setCatalog(null);};
    window.addEventListener('online',on);window.addEventListener('offline',off);window.addEventListener('mansu:session-expired',expired);
    const images=window.mansuDesktop?.onImages(()=>refresh());
    const timer=setInterval(()=>{if(document.visibilityState==='visible')refresh();},30000);
    return()=>{window.removeEventListener('online',on);window.removeEventListener('offline',off);window.removeEventListener('mansu:session-expired',expired);images?.();clearInterval(timer);};
  },[refresh]);
  const user=session?.user,config=session?.config;
  const accessible=useMemo(()=>links.filter(item=>!item.manager||user?.role!=='cashier'),[user?.role]);
  async function logout(){try{await api('/auth/logout',{method:'POST',body:{}});}catch{ /* The main process still drops the local session. */ }
    setSession(s=>({...s,user:null}));setCatalog(null);setSales([]);setSavedCarts([]);setPending(null);setReceipt(null);}
  function paid(sale){setPending(null);setReceipt(sale);refresh();setPage('sales');notice(sale.paymentMethod==='momo'?'MoMo reference saved as UNVERIFIED. Do not release goods.':'Cash receipt saved locally. Synchronization is still tracked separately.');}
  if(!session) return <div className="desktop-loading"><Spinner label="Opening protected desktop ledger…"/>{error&&<Notice tone="error">{error}</Notice>}</div>;
  if(!user) return <DesktopSignIn session={session} onReady={async()=>{await refresh();setPage('overview');}} error={error}/>;
  const heading=accessible.find(item=>item.id===page)?.label||'Overview';
  return <div className="desktop-shell">
    <a href="#desktop-main" className="skip-link">Skip to content</a>
    <aside className="desktop-rail" aria-label="Desktop workspace">
      <div className="desktop-brand"><span className="desktop-mark">M<span>·</span></span><div><strong>MANSU</strong><small>TRENDZGH · POS</small></div></div>
      <div className="desktop-rail-caption">OFFLINE TILL · ONE DEVICE</div>
      <nav aria-label="Desktop navigation">{accessible.map(item=><button key={item.id} type="button" className={page===item.id?'current':''}
        aria-current={page===item.id?'page':undefined} onClick={()=>setPage(item.id)}><item.icon size={18}/><span>{item.label}</span>{item.id==='sync'&&queue?.pending>0&&<em>{queue.pending}</em>}</button>)}</nav>
      <div className="desktop-rail-foot"><span>{user.name} · {user.role}</span><button onClick={logout}><LogOut size={16}/> Sign out</button></div>
    </aside>
    <div className="desktop-content"><header className="desktop-top"><div><small>PROTECTED LOCAL WORKSPACE</small><h1>{heading}</h1></div>
      <div className="desktop-top-actions"><span className={`desktop-pill ${config.writesEnabled?'ready':'locked'}`}>
        {config.writesEnabled?<ShieldCheck size={15}/>:<LockKeyhole size={15}/>} {config.writesEnabled?'Reserved checkout ready':'Shared-stock checkout locked'}</span>
        <button className="button secondary small" onClick={()=>refresh()} aria-label="Refresh local records"><RefreshCw size={16}/> Refresh</button></div></header>
      {!online&&<div className="desktop-connection" role="status"><WifiOff size={18}/> Device offline · local receipts remain available. Only a valid Woo-held allocation permits checkout.</div>}
      {!config.writesEnabled&&<div className="desktop-lock" role="alert"><AlertTriangle size={19}/><div><strong>Do not collect payment or release shared goods using this till yet.</strong><span>New checkout requires a separately approved, unexpired Woo-held allocation. Pending sync, an expired lease or a closed selling gate also lock this till; previously saved receipts remain available. The read-only web pilot is separate.</span></div></div>}
      {queue?.conflicts>0&&<div className="desktop-connection conflict" role="alert"><AlertTriangle size={18}/>{queue.conflicts} synchronization conflict{queue.conflicts===1?'':'s'} need owner review. No sale was silently discarded. <button onClick={()=>setPage('sync')}>Review events</button></div>}
      <main id="desktop-main" className="desktop-main" tabIndex={-1}>
        {error&&<Notice tone="error">{error}<button className="text-button" onClick={()=>refresh()}>Retry local reads</button></Notice>}
        {page==='overview'&&<DesktopOverview catalog={catalog} sales={sales} queue={queue} session={session} onNavigate={setPage}/>}
        <div hidden={page!=='register'}><Register key={user.id} active={page==='register'} catalog={catalog} config={config}
          checkoutScope={`desktop-${user.id}`} refresh={refresh} notify={notice} onPrepared={setPending} onOpenSales={()=>setPage('sales')}
          onOpenWholesale={()=>setPage('wholesale')} canWholesale={user.role!=='cashier'} savedCarts={savedCarts} setSavedCarts={setSavedCarts}
          searchSignal={0} setHelp={()=>setPage('settings')} shift={null} onOpenShift={()=>{}}/></div>
        {user.role!=='cashier'&&<div hidden={page!=='wholesale'}><Wholesale key={user.id} active={page==='wholesale'} catalog={catalog} config={config} user={user}
          checkoutScope={`desktop-${user.id}`} refresh={refresh} notify={notice} onPrepared={setPending} onOpenSales={()=>setPage('sales')}
          onOpenRetail={()=>setPage('register')} shift={null} onOpenShift={()=>{}}/></div>}
        {page==='inventory'&&<DesktopInventory catalog={catalog} user={user}/>}
        {page==='sales'&&<DesktopSales sales={sales} user={user} onReceipt={setReceipt} onUpdated={refresh} notice={notice}/>}
        {page==='customers'&&user.role!=='cashier'&&<DesktopCustomers notice={notice}/>}
        {page==='sync'&&<DesktopSync queue={queue} onUpdated={refresh} notice={notice} user={user} online={online}/>}
        {page==='settings'&&<DesktopSettings session={session} catalog={catalog} queue={queue} user={user} onUpdated={refresh} notice={notice} online={online}/>}
      </main><footer className="desktop-footer">MansutRENDZGH POS · Windows desktop <span>·</span> Version {config.version} <span>·</span> Local receipts are not proof of Woo synchronization.</footer>
    </div>
    {pending&&<Checkout sale={pending} config={config} onClose={()=>{setPending(null);notice('Draft closed. No payment, stock movement or sale was recorded.');}} onPaid={paid} notify={notice}/>}
    {receipt&&<Receipt sale={receipt} config={config} onClose={()=>setReceipt(null)}/>}
    <Toast toast={toast} onClose={()=>setToast(null)}/>
  </div>;
}
function DesktopSignIn({session,onReady,error}){
  const [tab,setTab]=useState(session.provisioned?'offline':'connect');
  const [origin,setOrigin]=useState(session.origin||''),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[problem,setProblem]=useState('');
  async function submit(event){event.preventDefault();setBusy(true);setProblem('');try{
    await api(tab==='connect'?'/desktop/connect':'/auth/login',{method:'POST',body:{...(tab==='connect'?{origin}:{}),username,password}});
    setPassword('');await onReady();
  }catch(e){setProblem(e.message);}finally{setBusy(false);}}
  return <div className="desktop-gate"><div className="desktop-gate-card"><div className="desktop-gate-mark">M<span>·</span></div><span className="eyebrow">MANSUTRENDZGH · WINDOWS POS</span><h1>{tab==='connect'?'Connect the separate trading service':'Sign in to this computer'}</h1>
    <p>{tab==='connect'?'An owner must first approve and set up a separate live trading service. The existing read-only catalogue pilot cannot authorize offline sales.':'Previously authorized staff can sign in without internet until the local permission lease expires.'}</p>
    {session.provisioned&&<div className="desktop-gate-tabs" role="group" aria-label="Sign-in method"><button className={tab==='offline'?'active':''} onClick={()=>{setTab('offline');setProblem('');}}>Offline sign-in</button><button className={tab==='connect'?'active':''} onClick={()=>{setTab('connect');setProblem('');}}>Reconnect online</button></div>}
    <form onSubmit={submit} className="desktop-gate-form">{tab==='connect'&&<label>Approved trading POS HTTPS address<input className="input" type="url" placeholder="https://trading.mansutrendzgh.com" required value={origin} onChange={e=>setOrigin(e.target.value)} /></label>}
      <label>Staff username<input className="input" autoComplete="username" required maxLength={80} value={username} onChange={e=>setUsername(e.target.value)}/></label>
      <label>Password<input className="input" type="password" autoComplete={tab==='connect'?'current-password':'off'} required minLength={12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/></label>
      {(problem||error)&&<Notice tone="error">{problem||error}</Notice>}
      <button className="button primary" disabled={busy}>{busy?'Checking…':tab==='connect'?'Connect securely':'Unlock local ledger'}<ArrowRight size={16}/></button></form>
    <div className="desktop-gate-warning"><LockKeyhole size={18}/> No WooCommerce or WordPress key is entered or stored on this computer. Offline checkout cannot be enabled by installing this app alone.</div>
  </div></div>;
}
function DesktopOverview({catalog,sales,queue,session,onNavigate}){
  const available=catalog?.products?.flatMap(p=>p.type==='variable'?p.variations:[p]).filter(line=>line.stock>0).length||0;
  const paid=sales.filter(s=>s.paymentMethod==='cash');
  return <div className="desktop-overview"><PageHeading eyebrow="One protected computer" title="Counter overview" description="Local till only · website orders are not included here."/>
    <div className="desktop-metrics"><div><span>Locally recorded cash</span><strong>{money(paid.reduce((n,s)=>n+s.total-s.refunded,0))}</strong><small>{paid.length} receipts on this device</small></div><div><span>Sellable reserved options</span><strong>{available}</strong><small>Shared parent pools are not added together</small></div><div><span>Awaiting sync</span><strong>{queue?.pending||0}</strong><small>{queue?.conflicts||0} conflict{queue?.conflicts===1?'':'s'} need review</small></div></div>
    <div className="desktop-overview-cards"><section className="surface"><h2>Stock authority</h2><p>Only units deducted from public Woo stock and assigned to this device may be sold locally. Expired or unknown grants are never treated as available.</p><strong>{session.config.writesEnabled?'Unexpired allocation on this device':'Checkout locked · no approved allocation'}</strong><button className="button secondary" onClick={()=>onNavigate('inventory')}>See reserved units <ArrowRight size={16}/></button></section>
      <section className="surface"><h2>Durable synchronization</h2><p>Cash receipts, unit movements and the unique sync event commit together. An uncertain Woo response stays queued; never create a second sale to resolve it.</p><strong>Lease: {session.leaseExpiresAt?dateTime(session.leaseExpiresAt):'Not issued'}</strong><button className="button secondary" onClick={()=>onNavigate('sync')}>Review sync status <ArrowRight size={16}/></button></section></div>
  </div>;
}
function DesktopInventory({catalog,user}){
  const [query,setQuery]=useState(''),[selected,setSelected]=useState(null),[movements,setMovements]=useState([]);
  const products=(catalog?.products||[]).filter(p=>`${p.name} ${p.sku} ${p.variations.map(v=>v.sku+' '+v.label).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  async function history(p,line){const key=line.stockSource==='parent'?`${p.id}:0`:`${p.id}:${line.id||0}`;
    try{setMovements((await api(`/stock/${key}/movements`)).movements);setSelected({name:p.name,label:line.label||'',key});}
    catch(e){setSelected({name:p.name,key,error:e.message});}}
  return <><PageHeading eyebrow="Device-held Woo allocation" title="Reserved inventory" description="Counts shown are for this till only; never add parent-stock variations together."/>
    <section className="surface desktop-list"><label className="desktop-search">Search products and options<input className="input" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Name or exact SKU"/></label>
    {!products.length&&<Empty icon={Package} title="No matching reserved goods">Products appear after an approved online snapshot is cached.</Empty>}
    {products.map(p=><div className="desktop-inventory-row" key={p.id}><ProductImage src={p.image} name={p.name}/><div><strong>{p.name}</strong><small>{p.sku||'No SKU'} · {p.category}</small></div>
      <div className="desktop-inventory-options">{(p.type==='variable'?p.variations:[p]).map(line=><button key={line.id||0} onClick={()=>user.role!=='cashier'&&history(p,line)} disabled={user.role==='cashier'} title={user.role==='cashier'?'Movement history is restricted to management.':'View local stock movements'}>
        <span>{line.label||'Standard'}</span><strong>{line.stock||0} reserved</strong></button>)}</div></div>)}</section>
    {selected&&<Modal title="Local stock movements" subtitle={`${selected.name}${selected.label?' · '+selected.label:''} · ${selected.key}`} onClose={()=>setSelected(null)}><div className="modal-body">{selected.error?<Notice tone="error">{selected.error}</Notice>:movements.length?movements.map(m=><p key={m.seq}>{dateTime(m.created_at)} · {m.kind.replaceAll('_',' ')} · {m.delta>0?'+':''}{m.delta} → {m.balance_after}</p>):<p>No local sale or return has moved this pool yet. Initial Woo allocation is shown in inventory.</p>}</div></Modal>}
  </>;
}
function DesktopSales({sales,user,onReceipt,onUpdated,notice}){
  const [query,setQuery]=useState(''),[returning,setReturning]=useState(null);
  const filtered=sales.filter(s=>`${s.number} ${s.buyerName||''} ${s.items.map(i=>i.name).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeading eyebrow="Protected local ledger" title="Sales & returns" description="A local cash receipt is durable. Woo order IDs appear only after synchronization is acknowledged."/>
    <section className="surface desktop-list"><label className="desktop-search">Find a local receipt<input className="input" placeholder="Receipt, product or buyer" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      {!filtered.length&&<Empty icon={ReceiptText} title="No local sales found">Completed local sales and unverified MoMo notices will appear here.</Empty>}
      {filtered.map(s=><div className="desktop-sale-row" key={s.id}><div><strong>{s.number}</strong><small>{dateTime(s.createdAt)} · {s.cashierName} · {s.saleType==='wholesale'?'Wholesale':'Retail'}</small>
        <p>{s.items.map(i=>`${i.quantity} × ${i.name}${i.label?' · '+i.label:''}`).join(', ')}</p></div><div className="desktop-sale-status"><strong>{money(s.total)}</strong><small>{s.status==='payment_unverified'?'UNVERIFIED MoMo — hold goods':s.status.includes('returned')?`Returned ${money(s.refunded)}`:'Cash locally recorded'}</small><small>Sync {s.syncState}{s.wooOrderId?` · Woo #${s.wooOrderId}`:''}</small></div>
        <div className="desktop-sale-actions"><button className="button secondary small" onClick={()=>onReceipt(s)}><Printer size={14}/>{s.paymentMethod==='momo'?'Notice':'Receipt'}</button>
          {user.role!=='cashier'&&s.paymentMethod==='cash'&&s.refunded<s.total&&<button className="button secondary small" onClick={()=>setReturning(s)}>Return goods</button>}</div></div>)}
    </section>{returning&&<DesktopReturn sale={returning} onClose={()=>setReturning(null)} onSaved={async result=>{setReturning(null);await onUpdated();notice(`Return recorded locally (${money(result.sale.refunded)} total refunded). Sync is pending.`);}}/>}</>;
}
function DesktopReturn({sale,onClose,onSaved}){
  const [quantities,setQuantities]=useState({}),[reason,setReason]=useState(''),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const key=useRef(uuid());
  const items=sale.items.map(i=>{const prior=sale.returnedItems?.find(r=>r.productId===i.productId&&r.variationId===i.variationId)?.quantity||0;
    return {...i,left:i.quantity-prior,selected:Number(quantities[`${i.productId}:${i.variationId}`]||0)};});
  const chosen=items.filter(i=>i.selected>0&&i.selected<=i.left).map(i=>({productId:i.productId,variationId:i.variationId,quantity:i.selected}));
  const amount=items.reduce((n,i)=>n+(i.selected>0?i.selected*(i.agreedUnitPrice??i.price):0),0);
  async function submit(){if(!chosen.length||chosen.length!==items.filter(i=>i.selected>0).length||!checked||busy)return;
    setBusy(true);setError('');try{const result=await api(`/sales/${sale.id}/return`,{method:'POST',body:{idempotencyKey:key.current,items:chosen,reason,cashRefunded:true}});await onSaved(result);}
    catch(e){setError(e.message);}finally{setBusy(false);}}
  return <Modal title="Record a local cash return" subtitle={sale.number} onClose={onClose} busy={busy}><div className="modal-body desktop-return"><Notice tone="warning">Management only. Confirm goods are physically returned and cash was actually refunded. No payment gateway refund is triggered; the Woo refund waits in the durable queue.</Notice>
    {items.map(i=><label key={`${i.productId}:${i.variationId}`}>{i.name}{i.label?' · '+i.label:''} · up to {i.left} at {money(i.agreedUnitPrice??i.price)}<input className="input" type="number" min="0" max={i.left} step="1" value={quantities[`${i.productId}:${i.variationId}`]??0} onChange={e=>setQuantities(q=>({...q,[`${i.productId}:${i.variationId}`]:e.target.value}))}/></label>)}
    <label>Reason<input className="input" required minLength={5} maxLength={250} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <strong>Total cash refunded: {money(amount)}</strong><label className="desktop-confirm"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/> I refunded this cash and accepted the returned goods.</label>
    {error&&<Notice tone="error">{error} Retry with the same return ID; never create a second refund.</Notice>}</div><div className="modal-footer"><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={!chosen.length||chosen.length!==items.filter(i=>i.selected>0).length||reason.trim().length<5||!checked||busy} onClick={submit}>{busy?'Saving…':'Commit local return'}</button></div></Modal>;
}
function DesktopCustomers({notice}){
  const [customers,setCustomers]=useState([]),[name,setName]=useState(''),[phone,setPhone]=useState(''),[error,setError]=useState('');
  const load=()=>api('/customers').then(r=>setCustomers(r.customers)).catch(e=>setError(e.message));
  useEffect(()=>{load();},[]);
  async function save(e){e.preventDefault();try{await api('/customers',{method:'POST',body:{name,phone}});setName('');setPhone('');load();notice('Customer saved in the protected local directory.');}catch(err){setError(err.message);}}
  return <><PageHeading eyebrow="Role-restricted local directory" title="Customers" description="Names and phone numbers are protected on this Windows user profile. This list is not silently uploaded to Woo."/>
    <form className="surface desktop-customer-form" onSubmit={save}><label>Name<input className="input" minLength={2} maxLength={120} required value={name} onChange={e=>setName(e.target.value)}/></label><label>Phone (optional)<input className="input" maxLength={40} value={phone} onChange={e=>setPhone(e.target.value)}/></label><button className="button primary">Save customer</button></form>
    {error&&<Notice tone="error">{error}</Notice>}<section className="surface desktop-list">{customers.map(c=><div className="desktop-customer" key={c.id}><strong>{c.name}</strong><span>{c.phone||'No phone saved'}</span><small>{dateTime(c.createdAt)}</small></div>)}{!customers.length&&<Empty icon={Users} title="No local customers">Save a customer for your private till directory.</Empty>}</section></>;
}
function DesktopSync({queue,onUpdated,notice,user,online}){
  const [busy,setBusy]=useState(false),[retryId,setRetryId]=useState(''),[reason,setReason]=useState('');
  async function sync(){setBusy(true);try{const result=await api('/desktop/sync',{method:'POST',body:{force:true}});await onUpdated();
    notice(result.conflicts?`${result.conflicts} event needs owner review.`:`${result.pending} local event${result.pending===1?'':'s'} still pending.`,result.conflicts?'error':'success');}
    catch(e){notice(e.message,'error');}finally{setBusy(false);}}
  async function retry(){setBusy(true);try{await api(`/desktop/retry/${retryId}`,{method:'POST',body:{reason}});setRetryId('');setReason('');await onUpdated();notice('The original event is eligible for a SAME-ID retry. No sale was deleted.');}
    catch(e){notice(e.message,'error');}finally{setBusy(false);}}
  return <><PageHeading eyebrow="Durable event queue" title="Sync & reconciliation" description="The first unresolved event blocks later ones. Never re-enter a completed sale to fix a timeout.">
    <button className="button primary" disabled={!online||busy} onClick={sync}><RefreshCw size={16}/>{busy?'Checking…':'Sync now'}</button></PageHeading>
    <div className="desktop-metrics"><div><span>Pending / retry</span><strong>{queue?.pending||0}</strong><small>Saved locally before network use</small></div><div><span>Conflicts</span><strong>{queue?.conflicts||0}</strong><small>Owner must resolve explicitly</small></div><div><span>Offline lease expiry</span><strong className="desktop-date">{queue?.leaseExpiresAt?dateTime(queue.leaseExpiresAt):'Not issued'}</strong><small>Expired grants lock new sales, not the queue</small></div></div>
    <Notice tone="warning">An acknowledgement must match the event ID and fingerprint. A conflict is never dismissed or silently force-applied. Restore internet, verify Woo order, website stock and the cash receipt with the owner, then retry the <strong>same</strong> event ID.</Notice>
    <section className="surface desktop-list" aria-label="Synchronization events">{!queue?.rows?.length&&<Empty icon={CheckCircle2} title="No events yet">Locally committed transactions will appear here.</Empty>}
      {queue?.rows?.map(row=><div className="desktop-queue-row" key={row.id}><span className={row.state==='conflict'?'desktop-queue-alert':''}>{row.state==='acked'?<CheckCircle2 size={18}/>:<RotateCcw size={18}/>}</span><div><strong>{row.kind==='return'?'Cash return':'Sale'} · {row.id.slice(0,8)}</strong><small>Receipt {row.saleId.slice(0,8)} · {row.attempts} attempt{row.attempts===1?'':'s'} · {row.state}</small>{row.lastError&&<p>{row.lastError}</p>}</div>{row.state==='conflict'&&user.role==='owner'&&<button className="button secondary small" onClick={()=>setRetryId(row.id)}>Owner review & retry</button>}</div>)}</section>
    {retryId&&<Modal title="Retry the original event" subtitle={retryId} onClose={()=>setRetryId('')}><div className="modal-body"><Notice tone="warning">First verify the original Woo order or refund and the site's reserved stock. Retrying never creates a new ID. Do not retry until the discrepancy is understood.</Notice><label>Owner review note (at least 10 characters)<textarea className="input" minLength={10} maxLength={250} value={reason} onChange={e=>setReason(e.target.value)}/></label></div><div className="modal-footer"><button className="button secondary" onClick={()=>setRetryId('')}>Cancel</button><button className="button primary" disabled={reason.trim().length<10||busy} onClick={retry}>Allow same-ID retry</button></div></Modal>}
  </>;
}
function DesktopSettings({session,catalog,queue,user,onUpdated,notice,online}){
  const [selection,setSelection]=useState(''),[quantity,setQuantity]=useState('1'),[busy,setBusy]=useState(false),[update,setUpdate]=useState(null),[backupPath,setBackupPath]=useState('');
  const allocationKey=useRef(uuid());
  useEffect(()=>{window.mansuDesktop?.updates('status').then(setUpdate).catch(()=>{});},[]);
  const options=(catalog?.products||[]).flatMap(p=>p.type==='variable'?p.variations.map(v=>({productId:p.id,variationId:v.id,
    label:`${p.name} · ${v.label} (${v.sku||'no option SKU'})`})):[{productId:p.id,variationId:0,label:`${p.name} (${p.sku||'no SKU'})`}]);
  async function refresh(){setBusy(true);try{await api('/desktop/refresh',{method:'POST',body:{}});await onUpdated();notice('Snapshot refreshed. Review this device’s allocation before checkout.');}
    catch(e){notice(e.message,'error');}finally{setBusy(false);}}
  async function backup(){setBusy(true);try{const result=await api('/desktop/backup',{method:'POST',body:{}});setBackupPath(result.path);notice('Verified local snapshot created. It is NOT a portable backup without the original Windows profile and DPAPI keys.');}
    catch(e){notice(e.message,'error');}finally{setBusy(false);}}
  async function allocate(retry=false){
    const saved=session.pendingAllocation;
    if(retry&&!saved)return;
    if(!retry&&!selection)return;
    const line=retry?saved:options[Number(selection)];
    if(!line)return;
    const request=retry?{idempotencyKey:saved.idempotencyKey,productId:saved.productId,variationId:saved.variationId,quantity:saved.quantity}
      :{...line,quantity:Number(quantity),idempotencyKey:allocationKey.current};
    if(!window.confirm(retry?`Retry the saved Woo allocation ${saved.idempotencyKey} for ${saved.quantity} unit(s)? Check Woo first. The SAME ID will be used.`
      :`Reserve ${quantity} unit(s) of ${line.label}? This physically reduces stock available on the website. Only proceed during an approved witnessed setup.`))return;
    setBusy(true);try{await api('/desktop/allocate',{method:'POST',body:request});allocationKey.current=uuid();await onUpdated();notice('Woo confirmed this allocation. Offline selling still needs separate live acceptance.');}
    catch(e){await onUpdated();notice(`${e.message} The saved allocation ID must be reviewed before any new request.`,'error');}finally{setBusy(false);}}
  return <><PageHeading eyebrow="One bound Windows user profile" title="Settings & allocation" description="The existing read-only pilot is not a trading service. Device setup and offline selling have different approvals."/>
    <section className="surface desktop-settings"><h2>Connection</h2><p><strong>Trading POS:</strong> {session.origin||'Not connected'}</p><p><strong>Device ID:</strong> <code>{session.deviceId||'Not enrolled'}</code></p>
      <p><strong>Offline lease:</strong> {session.leaseExpiresAt?dateTime(session.leaseExpiresAt):'None'} · {session.config.writesEnabled?'selling authority active':'checkout locked'}</p>
      <button className="button secondary" onClick={refresh} disabled={!online||busy||Boolean(queue?.pending)}><Wifi size={16}/> Refresh central catalogue & allocation</button>
      {queue?.pending>0&&<Notice tone="warning">Sync and reconcile all pending events before replacing the local stock snapshot.</Notice>}</section>
    {user.role==='owner'&&<section className="surface desktop-settings"><h2>Owner-only website stock allocation</h2><Notice tone="warning">The central service's separate setup gate and the Woo plugin must be installed and verified first. Allocating stock immediately subtracts these units from the website. Installation alone does not approve checkout; do not use the read-only pilot.</Notice>
      {session.pendingAllocation&&<Notice tone="error">Unresolved allocation <code>{session.pendingAllocation.idempotencyKey}</code> for {session.pendingAllocation.quantity} unit(s) of stock pool {session.pendingAllocation.stockKey}. The request ID was saved before contacting Woo. Check the website and its reservation ledger; never create a new ID to fix a timeout. <button className="button secondary small" disabled={!online||busy||Boolean(queue?.pending)} onClick={()=>allocate(true)}>Retry the saved request</button></Notice>}
      <label>Exact Woo product or variation<select className="input" value={selection} onChange={e=>{setSelection(e.target.value);allocationKey.current=uuid();}} disabled={Boolean(session.pendingAllocation)}><option value="">Select an identity</option>{options.map((o,i)=><option value={i} key={`${o.productId}:${o.variationId}`}>{o.label}</option>)}</select></label>
      <label>Units to reserve<input className="input" type="number" min="1" max="1000" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)} disabled={Boolean(session.pendingAllocation)}/></label>
      <button className="button primary" disabled={Boolean(session.pendingAllocation)||!selection||!online||busy||Boolean(queue?.pending)||!Number.isInteger(Number(quantity))||Number(quantity)<1||Number(quantity)>1000} onClick={()=>allocate()}>Request approved Woo allocation</button></section>}
    <section className="surface desktop-settings"><h2>Protected local ledger snapshot</h2><p>Create an integrity-checked copy in this Windows user’s AppData before an upgrade. This snapshot includes all pending events but is <strong>not portable</strong> to a different Windows profile or replacement PC because its sensitive records require the original DPAPI keys.</p><button className="button secondary" disabled={busy} onClick={backup}>Create verified local snapshot</button>{backupPath&&<p role="status">Snapshot: <code>{backupPath}</code></p>}<Notice tone="warning">A copy on this same disk is not an off-device disaster-recovery plan. Securely back up the original Windows user profile and test a restore under operator supervision before live checkout.</Notice></section>
    <section className="surface desktop-settings"><h2>Installer and updates</h2><p>Version {update?.version||session.config.version}. The protected ledger is in this Windows user's AppData and remains separate from the app on upgrades.</p><Notice tone="warning">{update?.message||'No public signed update has been approved.'} Never update during a transaction or with unsynchronized sales.</Notice>
      <p><Banknote size={16}/> Offline checkout is cash-only. No card or MoMo charge/verification is performed on this computer.</p></section>
  </>;
}
