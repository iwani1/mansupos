import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShoppingBag, ReceiptText, Package, ChartNoAxesCombined, Users, PlugZap, CircleHelp, ArrowUpRight, ArrowRight, Store, ShieldCheck, Menu, LogOut, CalendarDays, LockKeyhole, LoaderCircle, Banknote, ScrollText, ChevronDown } from 'lucide-react';
import { api, setSessionToken } from './api.js';
import Register from './Register.jsx';
import { Sales, Inventory, Reports, Staff, Connection, Help, Shifts, Audit } from './Pages.jsx';
import { Checkout, Receipt } from './Checkout.jsx';
import { Badge, IconButton, Spinner, Toast, Notice, Modal } from './components.jsx';

const navigation = [
  { id:'register', label:'Point of sale', short:'Sell', icon:ShoppingBag },
  { id:'sales', label:'Sales history', short:'Sales', icon:ReceiptText },
  { id:'inventory', label:'Inventory', short:'Stock', icon:Package },
  { id:'shifts', label:'Shifts & drawer', short:'Drawer', icon:Banknote },
  { id:'reports', label:'Reports', short:'Reports', icon:ChartNoAxesCombined, roles:['owner','manager'] },
  { id:'staff', label:'Staff & access', short:'Staff', icon:Users, roles:['owner'], management:true },
  { id:'audit', label:'Audit log', short:'Audit', icon:ScrollText, roles:['owner'], management:true },
  { id:'connection', label:'Store connection', short:'Connect', icon:PlugZap, management:true },
];

export default function App() {
  const [session,setSession]=useState(null);const [page,setPage]=useState('register');const [catalog,setCatalog]=useState(null);const [sales,setSales]=useState([]);const [salesCursor,setSalesCursor]=useState('');const [salesHasMore,setSalesHasMore]=useState(false);const [salesLoadingMore,setSalesLoadingMore]=useState(false);const [catalogError,setCatalogError]=useState('');
  const [pending,setPending]=useState(null);const [receipt,setReceipt]=useState(null);const [help,setHelp]=useState(false);const [toast,setToast]=useState(null);const [sidebar,setSidebar]=useState(false);const [profile,setProfile]=useState(false);const [refreshing,setRefreshing]=useState(false);const [refreshKey,setRefreshKey]=useState(0);const [savedCarts,setSavedCarts]=useState([]);const [shift,setShift]=useState(null);const [login,setLogin]=useState({username:'',password:''});const [loginBusy,setLoginBusy]=useState(false);const [loginError,setLoginError]=useState('');const [passwordOpen,setPasswordOpen]=useState(false);const [passwordForm,setPasswordForm]=useState({currentPassword:'',newPassword:''});const [passwordBusy,setPasswordBusy]=useState(false);
  const initialized=useRef(false);const heldKey=useRef('');const drawerRef=useRef(null);const focusPageAfterNav=useRef(false);
  const notify=useCallback((message,tone='success')=>setToast({message,tone,id:Date.now()}),[]);
  const closeToast=useCallback(()=>setToast(null),[]);
  const loadSession=useCallback(async()=>{
    let data=await api('/session');
    if(!data.user&&data.config.mode==='demo')data=await api('/auth/demo',{method:'POST',body:{}});
    if (data.token) setSessionToken(data.token);
    setSession(data);return data;
  },[]);
  useEffect(()=>{if(initialized.current)return;initialized.current=true;loadSession().catch(e=>setCatalogError(e.message));},[loadSession]);
  const userId=session?.user?.id;const mode=session?.config?.mode;const mustChangePassword=session?.user?.mustChangePassword;
  const refresh=useCallback(async(force=false)=>{
    if(!userId)return;
    setRefreshing(true);
    try{const [c,s,sh]=await Promise.all([api(`/catalog${force?'?refresh=1':''}`),api('/sales'),api('/shifts/current')]);setCatalog(c);setSales(s.sales);setSalesCursor(s.nextCursor||'');setSalesHasMore(Boolean(s.hasMore));setShift(sh.shift);setCatalogError('');setRefreshKey(k=>k+1);}
    catch(e){setCatalogError(e.message);}finally{setRefreshing(false);}
  },[userId]);
  const loadMoreSales=useCallback(async()=>{if(!salesCursor||salesLoadingMore)return;setSalesLoadingMore(true);try{const page=await api(`/sales?cursor=${encodeURIComponent(salesCursor)}`);setSales(previous=>{const seen=new Set(previous.map(s=>s.id));return [...previous,...page.sales.filter(s=>!seen.has(s.id))];});setSalesCursor(page.nextCursor||'');setSalesHasMore(Boolean(page.hasMore));}catch(e){notify(e.message,'error');}finally{setSalesLoadingMore(false);}},[salesCursor,salesLoadingMore,notify]);
  useEffect(()=>{if(userId&&!mustChangePassword){refresh();const key=`mansu-held-${mode}-${userId}`;heldKey.current=key;try{setSavedCarts(JSON.parse(localStorage.getItem(key)||'[]'));}catch{setSavedCarts([]);}}},[userId,mode,mustChangePassword,refresh]);
  useEffect(()=>{const expired=()=>{setSessionToken('');setSession(s=>s?{...s,user:null}:s);setCatalog(null);setSales([]);setSalesCursor('');setSalesHasMore(false);setSavedCarts([]);setShift(null);heldKey.current='';};window.addEventListener('mansu:session-expired',expired);return()=>window.removeEventListener('mansu:session-expired',expired);},[]);
  useEffect(()=>{if(heldKey.current)localStorage.setItem(heldKey.current,JSON.stringify(savedCarts));},[savedCarts]);
  useEffect(()=>{if(mode==='demo'||!userId)return;const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!pending&&!receipt)refresh();},60000);return()=>clearInterval(timer);},[mode,userId,refresh,pending,receipt]);
  useEffect(()=>{
    if(!sidebar)return;
    const overflow=document.body.style.overflow;
    const drawerKey=e=>{
      if(e.key==='Escape'){e.preventDefault();setSidebar(false);return;}
      if(e.key!=='Tab')return;
      const controls=[...(drawerRef.current?.querySelectorAll('a[href],button:not(:disabled)')||[])].filter(el=>el.getClientRects().length);
      if(!controls.length)return;
      if(e.shiftKey&&document.activeElement===controls[0]){e.preventDefault();controls.at(-1).focus();}
      else if(!e.shiftKey&&document.activeElement===controls.at(-1)){e.preventDefault();controls[0].focus();}
    };
    document.body.style.overflow='hidden';
    document.addEventListener('keydown',drawerKey);
    drawerRef.current?.querySelector('[data-nav="register"]')?.focus();
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',drawerKey);document.querySelector('.mobile-menu')?.focus();};
  },[sidebar]);
  useEffect(()=>{
    if(!focusPageAfterNav.current)return;
    focusPageAfterNav.current=false;
    const heading=[...document.querySelectorAll('#main-content h1')].find(el=>el.getClientRects().length);
    (heading||document.getElementById('main-content'))?.focus();
  },[page,sidebar]);
  function navigate(id){focusPageAfterNav.current=sidebar;setPage(id);setSidebar(false);setProfile(false);}
  async function logout(){try{await api('/auth/logout',{method:'POST',body:{}});setSessionToken('');setSidebar(false);if(isDemo){const data=await api('/auth/demo',{method:'POST',body:{}});setSessionToken(data.token);setSession(data);setProfile(false);setPage('register');notify('New demo session opened. Existing demo sales are preserved.');return;}setSession(s=>({...s,user:null}));setCatalog(null);setSales([]);setSalesCursor('');setSalesHasMore(false);setSavedCarts([]);setShift(null);heldKey.current='';setProfile(false);}catch(e){notify(e.message,'error');}}
  async function signIn(e){e.preventDefault();setLoginBusy(true);setLoginError('');try{const data=await api('/auth/login',{method:'POST',body:login});setSessionToken(data.token);setSession(data);setPage('register');setLogin({...login,password:''});}catch(e){setLoginError(e.message);}finally{setLoginBusy(false);}}
  async function openDemo(){setLoginBusy(true);setLoginError('');try{await loadSession();setPage('register');}catch(e){setLoginError(e.message);}finally{setLoginBusy(false);}}
  function paid(sale){setPending(null);setReceipt(sale);refresh();notify('Payment recorded. Your receipt is ready.');}
  const config=session?.config;const user=session?.user;const isDemo=config?.mode==='demo';
  if(!session)return <div className="boot-screen"><div className="brand-mark">M<span>·</span></div><span className="eyebrow">MANSUTRENDZGH</span><h1>Retail studio</h1>{catalogError?<Notice tone="error">{catalogError}<button className="button secondary" onClick={()=>location.reload()}>Try again</button></Notice>:<Spinner label="Opening your workspace…"/>}</div>;
  if(!user)return <div className="login-page"><section className="login-story"><div className="login-brand"><div className="brand-mark">M<span>·</span></div><span>MANSUTRENDZGH<small>RETAIL STUDIO · GHANA</small></span></div><div className="login-editorial"><span className="eyebrow">In-store workspace</span><h1>Good style.<br/>Great service.<br/><em>One beautiful counter.</em></h1><p>Your collection, your customers, and your online store — together in one considered workspace.</p></div><span className="login-story-footer"><ShieldCheck size={16}/>Designed for the way your boutique sells.</span></section><div className="login-form-wrap"><form onSubmit={signIn} className="login-form"><span className="eyebrow">Your workspace</span><h2>Open your register.</h2><p>{config.mode==='demo'?'Safe practice workspace. No real payments or live store changes.':`Sign in to your ${config.mode} workspace.`}</p>{config.mode!=='demo'&&!config.configured&&<Notice>Owner setup required. Configure credentials and the first owner account using docs/SETUP.md.</Notice>}{loginError&&<Notice tone="error">{loginError}</Notice>}{config.mode==='demo'?<button type="button" className="button primary" onClick={openDemo} disabled={loginBusy}>{loginBusy?<LoaderCircle className="spin" size={18}/>:<ArrowRight size={18}/>} {loginBusy?'Opening demo…':'Open demo workspace'}</button>:<><label>Username<input className="input" autoComplete="username" required value={login.username} onChange={e=>setLogin({...login,username:e.target.value})}/></label><label>Password<input className="input" type="password" autoComplete="current-password" required value={login.password} onChange={e=>setLogin({...login,password:e.target.value})}/></label><button className="button primary" disabled={loginBusy}>{loginBusy?<LoaderCircle className="spin" size={18}/>:<ArrowRight size={18}/>} {loginBusy?'Signing in…':'Sign in'}</button></>}<small>{config.mode==='demo'?<><ShieldCheck size={13}/>No username or password. Enters as Demo Owner.</>:<><LockKeyhole size={13}/>Named accounts. Secure, eight-hour sessions.</>}</small></form></div></div>;
  const allowed=navigation.filter(n=>!n.roles||n.roles.includes(user.role));
  if(user.mustChangePassword)return <div className="boot-screen"><div className="brand-mark">M<span>·</span></div><h1>Set your password</h1><p className="muted">This is a temporary password. Choose a new one before using the register.</p><form className="login-form force-password" onSubmit={async e=>{e.preventDefault();setPasswordBusy(true);try{const result=await api('/auth/password',{method:'POST',body:passwordForm});setSession(s=>({...s,user:result.user}));setPasswordForm({currentPassword:'',newPassword:''});notify('Password updated. You can now use the POS.');}catch(err){notify(err.message,'error');}finally{setPasswordBusy(false);}}}><label>Temporary password<input className="input" type="password" autoComplete="current-password" required value={passwordForm.currentPassword} onChange={e=>setPasswordForm({...passwordForm,currentPassword:e.target.value})}/></label><label>New password<input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={passwordForm.newPassword} onChange={e=>setPasswordForm({...passwordForm,newPassword:e.target.value})}/></label><button className="button primary" disabled={passwordBusy}>{passwordBusy?'Saving…':'Set password'}</button></form><Toast toast={toast} onClose={closeToast}/></div>;
  const currentNav=navigation.find(n=>n.id===page);
  const initials=user.name.split(' ').map(n=>n[0]).slice(0,2).join('');
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" inert={sidebar}>Skip to content</a>
    {sidebar&&<div className="sidebar-scrim" aria-hidden="true" onClick={()=>setSidebar(false)}/>}
    <aside id="workspace-nav" ref={drawerRef} className={`sidebar ${sidebar?'open':''}`} aria-label="Workspace navigation">
      <a className="app-brand" href="#" onClick={e=>{e.preventDefault();navigate('register');}} title="Mansutrendzgh home"><div className="brand-mark">M<span>·</span></div><div className="rail-brand">MANSU<small>RETAIL STUDIO</small></div></a>
      <button className="store-selector" onClick={()=>navigate('connection')} title="Store connection · Main store"><span className="store-icon"><Store size={19}/></span><span><strong>MansutRENDZGH</strong><small>Store connection · Ghana</small></span><ArrowUpRight size={15}/></button>
      <div className="nav-section-label">Counter</div>
      <nav aria-label="Main navigation">{allowed.filter(n=>!n.management).map(n=><button key={n.id} className={`nav-item ${page===n.id?'active':''}`} onClick={()=>navigate(n.id)} aria-current={page===n.id?'page':undefined} title={n.label} data-nav={n.id}><n.icon size={21} strokeWidth={1.6} aria-hidden="true"/><span className="nav-full-label">{n.label}</span><span className="nav-short-label">{n.short}</span>{n.id==='register'&&<span className="nav-active-dot"/>}{n.id==='sales'&&sales.some(s=>s.status==='needs_reconciliation')&&<><span className="nav-alert" aria-hidden="true">!</span><span className="sr-only">Sales need review</span></>}</button>)}
      <div className="nav-section-label management-label">Studio</div>{allowed.filter(n=>n.management).map(n=><button key={n.id} className={`nav-item ${page===n.id?'active':''}`} onClick={()=>navigate(n.id)} aria-current={page===n.id?'page':undefined} title={n.label} data-nav={n.id}><n.icon size={21} strokeWidth={1.6} aria-hidden="true"/><span className="nav-full-label">{n.label}</span><span className="nav-short-label">{n.short}</span></button>)}</nav>
      <div className="sidebar-bottom"><div className="connection-card"><span className="connection-card-icon"><PlugZap size={18}/></span><div><strong>{isDemo?'Your store, together.':'One connected store.'}</strong><p>{isDemo?'Practice safely, then connect WooCommerce.':'Online and in-store, in sync.'}</p></div><button onClick={()=>navigate('connection')}>{isDemo?'Set up connection':'Connection details'}<ArrowUpRight size={14}/></button></div><button className="nav-item help-nav" onClick={()=>{setSidebar(false);setHelp(true);}}><CircleHelp size={20} aria-hidden="true"/><span className="nav-full-label">Help & shortcuts</span><span className="nav-short-label">Help</span><kbd>?</kbd></button><div className="sidebar-profile"><button onClick={()=>setProfile(!profile)} aria-expanded={profile}><span className="avatar">{initials}</span><span><strong>{user.name}</strong><small className="capitalize">{user.role} account</small></span><ChevronDown size={15}/></button>{profile&&<div className="profile-menu"><button onClick={()=>{navigate('connection');setProfile(false);}}><Store size={16}/>Workspace details</button>{!isDemo&&<button onClick={()=>{setSidebar(false);setPasswordOpen(true);setProfile(false);}}><LockKeyhole size={16}/>Change password</button>}<button onClick={logout}><LogOut size={16}/>{isDemo?'Reset demo session':'Sign out'}</button></div>}</div></div>
    </aside>
    <div className="main-shell" inert={sidebar}>
      <header className="topbar"><div className="breadcrumb"><IconButton icon={Menu} label="Open navigation" className="mobile-menu" aria-expanded={sidebar} aria-controls="workspace-nav" onClick={()=>setSidebar(true)}/><div className="topbar-wordmark">MANSUTRENDZGH<span>RETAIL STUDIO</span></div><span className="breadcrumb-divider"/><Store size={15}/><span>Main store</span><span className="breadcrumb-divider"/><strong>{currentNav?.label}</strong></div><div className="topbar-right"><span className="topbar-date"><CalendarDays size={15}/>{new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Africa/Accra'})}</span><Badge tone={isDemo?'amber':catalogError||catalog?.stale||catalog?.error?'red':!catalog||!config.configured||!config.writesEnabled?'amber':'green'} dot>{isDemo?'Demo mode':catalogError?'Connection review':!catalog?'Loading catalogue':!config.configured?'Setup required':catalog.stale||catalog.error?'Connection review':!config.writesEnabled?'Checkout locked':refreshing?'Syncing':'Catalogue synced'}</Badge><IconButton icon={CircleHelp} label="Open quick guide" onClick={()=>setHelp(true)}/><span className="avatar top-avatar">{initials}</span></div></header>
      {isDemo&&<div className="demo-banner" role="region" aria-label="Demo environment notice"><span><span className="demo-banner-icon"><ShieldCheck size={14}/></span><strong>Demo mode</strong><span>No live orders or payments are created.</span></span><button onClick={()=>navigate('connection')}>Connect your store<ArrowRight size={14}/></button></div>}
      <main id="main-content" tabIndex={-1} className={`main-content ${page==='register'?'register-main':''}`}>
        {catalogError&&<Notice tone="error">{catalogError}<button className="text-button" onClick={()=>refresh(true)}>Try again</button></Notice>}
        {!catalog&&!catalogError?<Spinner label="Loading your catalogue…"/>:<>
          <div style={{display:page==='register'?'block':'none'}}><Register key={`${config.mode}-${user.id}`} active={page==='register'} catalog={catalog} config={config} user={user} checkoutScope={`${config.mode}-${user.id}`} refresh={refresh} notify={notify} onPrepared={setPending} onOpenSales={()=>navigate('sales')} savedCarts={savedCarts} setSavedCarts={setSavedCarts} setHelp={()=>setHelp(true)} shift={shift} onOpenShift={()=>navigate('shifts')}/></div>
          {page==='sales'&&<Sales sales={sales} config={config} refresh={refresh} onReceipt={setReceipt} onPay={setPending} notify={notify} hasMore={salesHasMore} loadingMore={salesLoadingMore} onLoadMore={loadMoreSales}/>}
          {page==='inventory'&&<Inventory catalog={catalog} config={config} refresh={refresh} notify={notify}/>}
          {page==='shifts'&&<Shifts config={config} user={user} shift={shift} refresh={refresh} notify={notify}/>}
          {page==='reports'&&user.role!=='cashier'&&<Reports config={config} notify={notify} refreshKey={refreshKey}/>}
          {page==='staff'&&user.role==='owner'&&<Staff config={config} user={user} notify={notify}/>}
          {page==='audit'&&user.role==='owner'&&<Audit notify={notify}/>}
          {page==='connection'&&<Connection config={config} catalog={catalog} refresh={refresh} notify={notify} user={user}/>}
        </>}
      </main><footer className="app-footer"><span>MansutRENDZGH <span>·</span> Retail studio</span><span><ShieldCheck size={12}/>{isDemo?'Isolated demo environment':`${config.mode} environment`}<span>·</span>GHS</span></footer>
    </div>
    {pending&&<Checkout sale={pending} config={config} onClose={()=>{setPending(null);refresh();if(config.mode!=='demo')notify('Unpaid order saved in Sales. Do not release goods until the full payment is verified and recorded.');}} onPaid={paid} notify={notify}/>}
    {receipt&&<Receipt sale={receipt} config={config} onClose={()=>setReceipt(null)}/>}
    {help&&<Help config={config} onClose={()=>setHelp(false)}/>}
    {passwordOpen&&<Modal title="Change your password" subtitle="Other sessions will be signed out." onClose={()=>setPasswordOpen(false)} busy={passwordBusy}><form onSubmit={async e=>{e.preventDefault();setPasswordBusy(true);try{await api('/auth/password',{method:'POST',body:passwordForm});setPasswordOpen(false);setPasswordForm({currentPassword:'',newPassword:''});notify('Password changed. Other sessions were signed out.');}catch(err){notify(err.message,'error');}finally{setPasswordBusy(false);}}}><div className="modal-body form-stack"><label>Current password<input className="input" type="password" autoComplete="current-password" required value={passwordForm.currentPassword} onChange={e=>setPasswordForm({...passwordForm,currentPassword:e.target.value})}/></label><label>New password<input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={passwordForm.newPassword} onChange={e=>setPasswordForm({...passwordForm,newPassword:e.target.value})}/><small className="field-hint">Use at least 12 characters. Do not reuse your WordPress password.</small></label></div><div className="modal-footer" role="group" aria-label="Dialog actions"><button type="button" className="button secondary" onClick={()=>setPasswordOpen(false)}>Cancel</button><button className="button primary" disabled={passwordBusy}>{passwordBusy?'Saving…':'Change password'}</button></div></form></Modal>}
    <Toast toast={toast} onClose={closeToast}/>
  </div>;
}
