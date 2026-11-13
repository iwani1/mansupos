import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, ChevronRight, CircleHelp, ClipboardCheck,
  CloudOff, DatabaseBackup, History, Minus, Plus, Printer, RotateCcw, ScanLine,
  ShieldOff, ShoppingBag, Wifi, WifiOff, X } from 'lucide-react';

const money = cents => new Intl.NumberFormat('en-GH',{style:'currency',currency:'GHS'}).format((Number(cents)||0)/100);
const label = date => date ? new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short'}).format(new Date(date)) : '—';

// No fetch, real login, or public-store API fallback exists in this renderer.
async function practice(path, method = 'GET', body) {
  if (!window.mansuPractice) throw new Error('Open the separate Windows practice application. This page cannot trade or connect to a store.');
  const reply = await window.mansuPractice.request({path:`/api${path}`,method,body});
  if (!reply?.ok) throw new Error(reply?.error?.message || 'Practice operation failed.');
  return reply.data;
}
function catalogueOptions(catalog) {
  return (catalog?.products || []).flatMap(product => product.type === 'variable' ? product.variations.map(option => ({
    productId:product.id, variationId:option.id, name:product.name, label:option.label, sku:option.sku,
    barcode:option.barcode, price:option.price, stock:option.stock, stockKey:`${product.id}:${option.stockSource === 'parent' ? 0 : option.id}`,
  })) : [{ productId:product.id, variationId:0, name:product.name, label:'',sku:product.sku,
    barcode:product.barcode, price:product.price, stock:product.stock,stockKey:`${product.id}:0` }]);
}
function Notification({message,onClose}) {
  return message && <div className="practice-notice" role="alert"><AlertTriangle size={17}/><span>{message}</span><button type="button" aria-label="Dismiss notice" onClick={onClose}><X size={17}/></button></div>;
}

export default function PracticeApp() {
  const [session,setSession] = useState(null), [catalog,setCatalog] = useState(null), [sales,setSales] = useState([]);
  const [queue,setQueue] = useState(null), [cart,setCart] = useState([]), [search,setSearch] = useState('');
  const [page,setPage] = useState('till'), [draft,setDraft] = useState(null), [selected,setSelected] = useState(null);
  const [tender,setTender] = useState(''), [confirmed,setConfirmed] = useState(false), [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState(''), [message,setMessage] = useState('');
  const scanRef = useRef(null), commitLock = useRef(false);
  const refresh = useCallback(async () => {
    const active = await practice('/session'); setSession(active);
    if (!active.user) { setCatalog(null);setSales([]);setQueue(null);return; }
    const [c,history,q] = await Promise.all([practice('/catalog'),practice('/sales'),practice('/desktop/status')]);
    setCatalog(c);setSales(history.sales);setQueue(q);
  },[]);
  useEffect(() => { refresh().catch(error => setNotice(error.message)); },[refresh]);
  useEffect(() => {
    const shortcut = event => {
      if (event.key === 'F2' && !event.ctrlKey && !event.altKey) { event.preventDefault();setPage('till');setTimeout(()=>scanRef.current?.focus(),0); }
    };
    window.addEventListener('keydown',shortcut);return () => window.removeEventListener('keydown',shortcut);
  },[]);
  const options = useMemo(()=>catalogueOptions(catalog),[catalog]);
  const total = cart.reduce((sum,line)=>sum+line.price*line.quantity,0);
  const fakeOnline = session?.trial?.simulatedConnection === true;
  const supply = key => options.find(item=>item.stockKey===key)?.stock ?? 0;
  function addOption(item) {
    if (!session?.config?.writesEnabled) { setNotice('Practice allocations have expired or are empty. No new sample checkout can be recorded.');return; }
    const used = cart.filter(line=>line.stockKey===item.stockKey).reduce((sum,line)=>sum+line.quantity,0);
    if (used >= supply(item.stockKey)) { setNotice('This practice stock pool is empty or already in the cart.');return; }
    setNotice('');setCart(previous=>{
      const found=previous.find(line=>line.productId===item.productId&&line.variationId===item.variationId);
      return found ? previous.map(line=>line===found?{...line,quantity:line.quantity+1}:line) : [...previous,{...item,quantity:1}];
    });
  }
  function removeOption(item) {
    setCart(previous=>previous.flatMap(line=>line.productId===item.productId&&line.variationId===item.variationId
      ? line.quantity===1?[]:[{...line,quantity:line.quantity-1}] : [line]));
  }
  function scan(event) {
    event.preventDefault();const value=search.trim().toUpperCase();if(!value)return;
    const item=options.find(o=>o.sku.toUpperCase()===value||o.barcode?.toUpperCase()===value);
    if(item) { addOption(item);setSearch('');return; }
    if(catalog?.products.some(p=>p.type==='variable' && (p.sku.toUpperCase()===value||p.barcode?.toUpperCase()===value))) {
      setNotice('Select a sample size or scan the exact sample-option code. No item was added.');return;
    }
    setNotice('Only the printed SAMPLE codes in this app work. A real shop barcode cannot be used.');
  }
  async function perform(action,success) {
    if(busy)return;setBusy(true);setNotice('');setMessage('');
    try { await action();if(success)setMessage(success); }
    catch(error){setNotice(error.message);}
    finally{setBusy(false);}
  }
  async function start() { await perform(async()=>{await practice('/trial/start','POST',{});await refresh();},'Sample till opened. The fake sync connection starts OFFLINE.'); }
  async function review() {
    await perform(async()=>{
      const result=await practice('/sales/prepare','POST',{idempotencyKey:crypto.randomUUID(),saleType:'retail',items:cart.map(({productId,variationId,quantity})=>({productId,variationId,quantity})),note:'SIMULATED PRACTICE — no payment'});
      setDraft(result.sale);setTender((result.sale.total/100).toFixed(2));setConfirmed(false);
    });
  }
  async function commit() {
    if(commitLock.current||!draft||!confirmed)return;
    commitLock.current=true;
    const amount=Number(tender);
    if(!/^\d+(?:\.\d{1,2})?$/.test(tender)||!Number.isSafeInteger(Math.round(amount*100))||Math.round(amount*100)<draft.total){
      setNotice('Enter an illustrative tender at least equal to the sample total. Do not handle real money.');commitLock.current=false;return;
    }
    await perform(async()=>{
      const {sale}=await practice(`/sales/${draft.id}/pay`,'POST',{method:'cash',tendered:Math.round(amount*100),confirmed:true,practiceConfirmed:true});
      setDraft(null);setSelected(sale);setCart([]);setPage('history');await refresh();
    },'Sample checkout saved on this computer. Close and reopen the app to check recovery.');
    commitLock.current=false;
  }
  async function print(sale) {
    await perform(async()=>{
      const reply=await window.mansuPractice.print(sale.id);
      if(!reply?.ok) throw new Error(reply?.error?.message || 'Printing failed or was cancelled.');
    },'NOT A RECEIPT practice slip sent to the Windows print dialog. Check the printer; do not release goods.');
  }
  async function fakeConnection(value) {
    await perform(async()=>{await practice('/trial/connectivity','POST',{connected:value});await refresh();},
      value?'Fake service CONNECTED (local only). You may now retry the pending sample event.':'Fake service OFFLINE. No real internet connection is used.');
  }
  async function sync() { await perform(async()=>{await practice('/trial/sync','POST',{});await refresh();},
    fakeOnline?'Fake service acknowledged local sample events. No Woo order was created.':'Fake service is OFFLINE. The same event remains on this computer for retry.'); }
  async function snapshot() { await perform(async()=>{await practice('/trial/refresh','POST',{});await refresh();},
    'Sample balances refreshed locally; used sample units were not replenished.'); }
  async function backup() { await perform(async()=>{
    const result=await practice('/trial/backup','POST',{});setMessage(`Verified practice-only backup saved at: ${result.path}`);
  }); }

  if(!session) return <div className="practice-loading"><span className="practice-mark">P</span><h1>Opening the separate practice app…</h1><Notification message={notice} onClose={()=>setNotice('')}/></div>;
  if(!session.user) return <div className="practice-gate"><div className="practice-gate-card">
    <span className="practice-badge"><ShieldOff size={16}/> PRACTICE APPLICATION · NOT FOR SALES</span>
    <span className="practice-mark">P</span><p className="practice-overline">MANSUTRENDZGH · WINDOWS POS WORKFLOW TRIAL</p>
    <h1>Practice a sale. Never make one.</h1><p>This separate app uses invented products, a local protected ledger and a fake sync service. It does not connect to the shop or trading server. No money, orders or real stock move.</p>
    <ul><li><Check size={16}/> Scan a SAMPLE code or select an option.</li><li><Check size={16}/> Save a simulated offline checkout.</li><li><Check size={16}/> Close and reopen this app to find it again.</li><li><Check size={16}/> Print a NOT A RECEIPT slip, then try fake sync.</li></ul>
    <Notification message={notice} onClose={()=>setNotice('')}/>
    <button type="button" className="practice-primary" onClick={start} disabled={busy}>{busy?'Opening sample ledger…':'Open sample till'}<ArrowRight size={18}/></button>
    <small>Do not enter any real staff password. This is not the selling POS. A successful trial does not authorize live sales.</small>
  </div></div>;
  const visible = (catalog?.products || []).filter(p=>!search.trim()||[
    p.name,p.sku,p.barcode,...p.variations.flatMap(v=>[v.label,v.sku,v.barcode])].some(value=>value?.toLowerCase().includes(search.trim().toLowerCase())));
  const pending = queue?.pending || 0;
  return <div className="practice-shell"><div className="practice-warning" role="status"><ShieldOff size={18}/><strong>PRACTICE ONLY — NOT FOR SALES</strong><span>No money · no goods · no real orders</span><strong>NOT A RECEIPT</strong></div>
    <div className="practice-layout"><aside className="practice-sidebar" aria-label="Practice steps"><div className="practice-brand"><span className="practice-mark">P</span><div><strong>MANSU</strong><small>POS · PRACTICE</small></div></div>
      <p>ONE COMPUTER · SAMPLE DATA</p><nav aria-label="Practice navigation">
        <button type="button" className={page==='till'?'current':''} onClick={()=>setPage('till')}><ShoppingBag size={18}/> Sample till <ChevronRight size={15}/></button>
        <button type="button" className={page==='history'?'current':''} onClick={()=>setPage('history')}><History size={18}/> Saved practice slips <ChevronRight size={15}/></button>
        <button type="button" className={page==='sync'?'current':''} onClick={()=>setPage('sync')}><RotateCcw size={18}/> Fake sync & recovery {pending>0&&<b>{pending}</b>}</button>
      </nav><div className="practice-side-note"><CircleHelp size={17}/><span>Close the window and reopen it to verify your saved sample checkout survives a restart.</span></div>
      <span className="practice-side-footer">Local trial only · no updater · no Woo connection</span>
    </aside><main className="practice-content" id="main">
      <header className="practice-head"><div><p>ISOLATED WINDOWS WORKFLOW TRIAL</p><h1>{page==='till'?'Practice till':page==='history'?'Saved practice slips':'Fake sync & recovery'}</h1></div><span className={`practice-connection ${fakeOnline?'sim-connected':''}`}>{fakeOnline?<Wifi size={16}/>:<WifiOff size={16}/>} Fake service: {fakeOnline?'CONNECTED':'OFFLINE'}</span></header>
      <div className="practice-lead"><AlertTriangle size={19}/><div><strong>All stock and currency below are illustrative.</strong> Use SAMPLE codes only. Do not accept payment or release goods. The fake connection switch never uses the internet.</div></div>
      <Notification message={notice} onClose={()=>setNotice('')}/>{message&&<div className="practice-success" role="status"><Check size={17}/>{message}</div>}
      {page==='till'&&<div className="practice-till"><section className="practice-catalog"><div className="practice-section-title"><span>01 / SELECT SAMPLES</span><h2>Find a practice product</h2><p>Scan the example label and press Enter, or click a sample option. F2 focuses the scan field.</p></div>
        <form onSubmit={scan} className="practice-search"><ScanLine size={21}/><input ref={scanRef} type="text" aria-label="Scan SAMPLE barcode or SKU" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Scan QA-SCARF-01, QA-TEE-S or QA-TEE-L" maxLength={80}/><button type="submit">Add code</button></form>
        <div className="practice-products">{visible.map((product,index)=><article className="practice-product" key={product.id}><div className={`practice-product-art tone-${index%3}`} aria-hidden="true"><span>{product.type==='variable'?'02':'01'}</span><strong>SAMPLE</strong></div><div className="practice-product-info"><small>PRACTICE STOCK · NOT REAL INVENTORY</small><h3>{product.name}</h3><p>{product.type==='variable'?'Choose the exact sample option; both sizes share one sample stock pool.':`Code ${product.sku} · ${money(product.price)} illustrative`}</p><div className="practice-options">{(product.type==='variable'?product.variations:[product]).map(option=>{
          const item=options.find(o=>o.productId===product.id&&o.variationId===(product.type==='variable'?option.id:0));
          return <button type="button" key={option.id} onClick={()=>addOption(item)} disabled={!item?.stock||!session.config.writesEnabled}>
            <Plus size={15}/>{product.type==='variable'?`${option.label} · ${money(option.price)}`:`Add sample · ${money(option.price)}`}<small>{option.stock} left</small>
          </button>;
        })}</div></div></article>)}</div>{visible.length===0&&<p className="practice-empty">No sample matches that search. Real store products cannot be used here.</p>}</section>
        <section className="practice-cart" aria-label="Practice cart"><div className="practice-cart-head"><span>02 / BUILD THE CART</span><h2>Sample basket</h2><p>Local sample stock only</p></div><div className="practice-cart-body">{cart.length===0?<div className="practice-cart-empty"><ShoppingBag size={30}/><strong>Your practice basket is empty</strong><p>Select a sample product or scan a QA code.</p></div>:cart.map(item=><div className="practice-cart-line" key={`${item.productId}:${item.variationId}`}><div><strong>{item.name}</strong><small>{item.label||item.sku} · {money(item.price)} each</small><div className="practice-quantity"><button type="button" aria-label={`Remove one ${item.label||item.sku}`} onClick={()=>removeOption(item)}><Minus size={14}/></button><span>{item.quantity}</span><button type="button" aria-label={`Add one ${item.label||item.sku}`} onClick={()=>addOption(item)}><Plus size={14}/></button></div></div><strong>{money(item.price*item.quantity)}</strong></div>)}</div><div className="practice-cart-foot"><div><span>SIMULATED TOTAL</span><strong>{money(total)}</strong></div><button type="button" className="practice-primary" onClick={review} disabled={busy||cart.length===0||!session.config.writesEnabled}>Review simulated checkout <ArrowRight size={17}/></button><small>No tender is accepted; no live sale can be created.</small></div></section></div>}
      {page==='history'&&<section className="practice-panel"><div className="practice-panel-head"><div><span>03 / PERSISTED ON THIS COMPUTER</span><h2>Saved practice checkouts</h2><p>Close and reopen this app. Click “Open sample till” again, then return here; the same practice number and pending event should remain.</p></div><ClipboardCheck size={27}/></div>
        {sales.length===0?<p className="practice-empty">No practice checkout yet. Complete a sample checkout while the fake service is offline.</p>:sales.map(sale=><div className="practice-history-row" key={sale.id}><div><strong>{sale.number}</strong><p>{label(sale.createdAt)} · {sale.items.map(i=>`${i.quantity} × ${i.name}${i.label?` (${i.label})`:''}`).join(', ')}</p><small>{sale.syncState==='acked'?'Fake sync acknowledged · no real order':'Stored locally · fake sync pending'}</small></div><div><strong>{money(sale.total)} <small>simulation</small></strong><button type="button" onClick={()=>setSelected(sale)}>View / print NOT A RECEIPT</button></div></div>)}</section>}
      {page==='sync'&&<div className="practice-recovery"><section className="practice-panel"><div className="practice-panel-head"><div><span>04 / OFFLINE THEN FAKE SYNC</span><h2>Try the recovery sequence</h2><p>The service below is in-process only. Switching it on does not use Wi-Fi, DNS, Woo, Paystack or the trading server.</p></div><CloudOff size={27}/></div><div className="practice-step-grid"><div><b>1</b><h3>Keep fake connection OFFLINE</h3><p>Complete the sample checkout and optionally attempt sync. It must stay pending.</p></div><div><b>2</b><h3>Close and reopen the app</h3><p>Resume the sample till. Verify your original number and pending ID are still here.</p></div><div><b>3</b><h3>Connect the FAKE service</h3><p>Retry the same event. Only the local acknowledgement changes; no shop stock or order changes.</p></div></div>
        <div className="practice-actions"><button type="button" className={fakeOnline?'practice-ghost':'practice-secondary'} onClick={()=>fakeConnection(false)} disabled={busy||!fakeOnline}><WifiOff size={17}/> Fake OFFLINE</button><button type="button" className={fakeOnline?'practice-secondary':'practice-ghost'} onClick={()=>fakeConnection(true)} disabled={busy||fakeOnline}><Wifi size={17}/> Fake CONNECTED</button><button type="button" className="practice-primary" onClick={sync} disabled={busy||pending===0}><RotateCcw size={17}/> Attempt fake sync</button></div>
        <div className="practice-queue-summary"><strong>{pending}</strong><div><b>sample event{pending===1?'':'s'} pending</b><small>{queue?.conflicts||0} blocked · {queue?.rows?.filter(row=>row.state==='acked').length||0} fake acknowledgements</small></div></div>
        {(queue?.rows||[]).map(row=><div className="practice-event" key={row.id}><span className={row.state==='acked'?'ok':''}>{row.state==='acked'?'FAKE ACK':row.state.toUpperCase()}</span><div><strong>Practice event ID: {row.id}</strong><small>Attempts: {row.attempts} · same ID on every retry</small>{row.lastError&&<p>{row.lastError}</p>}</div></div>)}
      </section><section className="practice-panel"><div className="practice-panel-head"><div><span>LOCAL SAFETY</span><h2>Sample ledger tools</h2><p>No sale data from the separate selling POS is opened, restored or changed.</p></div><DatabaseBackup size={27}/></div><div className="practice-tools"><button type="button" className="practice-secondary" onClick={backup} disabled={busy}><DatabaseBackup size={17}/> Make verified practice backup</button><button type="button" className="practice-secondary" onClick={snapshot} disabled={busy||pending>0}><RotateCcw size={17}/> Refresh existing sample balance</button></div><p className="practice-helper">Refreshing never adds sample units. If the simulated lease expires, finish fake sync first; no selling access is granted by this trial.</p></section></div>}
      <footer className="practice-footer"><ShieldOff size={15}/> MansutRENDZGH POS Practice · separate app and data folder · unsigned QA build · NOT A RECEIPT</footer>
    </main></div>
    {draft&&<div className="practice-modal-backdrop" role="presentation"><section className="practice-dialog" role="dialog" aria-modal="true" aria-label="Review simulated checkout"><button type="button" className="practice-close" aria-label="Close checkout review" onClick={()=>{setDraft(null);setConfirmed(false);}}><X size={18}/></button><span className="practice-badge">SIMULATION ONLY · NO PAYMENT</span><h2>Review simulated checkout</h2><p>Check the sample lines. The next step writes an offline sample event to this computer, not a payment or real order.</p><div className="practice-dialog-lines">{draft.items.map(item=><div key={`${item.productId}:${item.variationId}`}><span>{item.quantity} × {item.name}{item.label?` · ${item.label}`:''}</span><strong>{money(item.total)}</strong></div>)}<div><b>ILLUSTRATIVE TOTAL</b><strong>{money(draft.total)}</strong></div></div>
      <label className="practice-field">Illustrative tender (GH₵ — do not handle money)<input type="text" inputMode="decimal" value={tender} onChange={e=>setTender(e.target.value)} maxLength={15}/></label>
      <label className="practice-agreement"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>I did not accept money or release goods. I am recording a simulated tender using sample products only.</span></label>
      <div className="practice-dialog-actions"><button type="button" className="practice-ghost" onClick={()=>setDraft(null)}>Cancel sample draft</button><button type="button" className="practice-primary" onClick={commit} disabled={!confirmed||busy}>Save sample event offline <ArrowRight size={17}/></button></div></section></div>}
    {selected&&<div className="practice-modal-backdrop" role="presentation"><section className="practice-dialog practice-slip-dialog" role="dialog" aria-modal="true" aria-label="Practice slip"><button type="button" className="practice-close" aria-label="Close practice slip" onClick={()=>setSelected(null)}><X size={18}/></button><span className="practice-badge">NOT A RECEIPT</span><h2>Sample checkout saved</h2><p>The sample ledger and retryable fake sync event were recorded atomically. Do not accept money or release goods.</p><div className="practice-slip"><h3>NOT A RECEIPT</h3><strong>SIMULATED POS PRACTICE</strong><p>NO PAYMENT ACCEPTED · NO GOODS RELEASED</p><small>{selected.number}</small>{selected.items.map(item=><div key={`${item.productId}:${item.variationId}`}><span>{item.quantity} × {item.name} {item.label}</span><b>{money(item.total)}</b></div>)}<div><b>SIMULATED TOTAL</b><b>{money(selected.total)}</b></div><p>FAKE SYNC ONLY · NOT VALID FOR RETURNS OR PROOF OF PURCHASE</p><h3>NOT A RECEIPT</h3></div><p className="practice-helper">{selected.syncState==='acked'?'Fake sync acknowledged. No Woo order exists.':'Still pending fake sync; restart the app to verify this event persists.'} Printing opens the Windows printer dialog, not a cash drawer command. Disable any printer-driver auto-kick for this test.</p><div className="practice-dialog-actions"><button type="button" className="practice-ghost" onClick={()=>setSelected(null)}>Done</button><button type="button" className="practice-primary" onClick={()=>print(selected)} disabled={busy}><Printer size={17}/> Print NOT A RECEIPT</button></div></section></div>}
  </div>;
}
