import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShoppingBag, ReceiptText, Package, ChartNoAxesCombined, Users, ArrowRight, Store, ShieldCheck, LockKeyhole, LoaderCircle, Banknote, ScrollText, Download, WifiOff, LayoutDashboard, Tags, Boxes, Settings2 } from 'lucide-react';
import { api, setSessionToken } from './api.js';
import Register from './Register.jsx';
import Wholesale from './Wholesale.jsx';
import InStore from './InStore.jsx';
import Overview from './Overview.jsx';
import { ProductsPage, CategoriesPage } from './Catalogue.jsx';
import Customers from './Customers.jsx';
import { WorkspaceSidebar, WorkspaceHeader } from './WorkspaceChrome.jsx';
import { Sales, Inventory, Reports, Staff, Connection, Help, Shifts, Audit } from './Pages.jsx';
import { Checkout, Receipt } from './Checkout.jsx';
import { Spinner, Toast, Notice, Modal } from './components.jsx';

const navigation = [
  { id:'overview', label:'Overview', short:'Home', icon:LayoutDashboard, group:'Workspace', roles:['owner','manager'] },
  { id:'register', label:'Point of sale', short:'Sell', icon:ShoppingBag, group:'Workspace' },
  { id:'wholesale', label:'Wholesale management', short:'Wholesale', icon:Store, group:'Workspace', roles:['owner','manager'] },
  { id:'products', label:'Products', short:'Products', icon:Package, group:'Catalogue' },
  { id:'categories', label:'Categories', short:'Categories', icon:Tags, group:'Catalogue' },
  { id:'inventory', label:'Inventory', short:'Stock', icon:Boxes, group:'Catalogue' },
  { id:'sales', label:'Sales history', short:'Sales', icon:ReceiptText, group:'Operations' },
  { id:'orders', label:'Orders', short:'Orders', icon:ScrollText, group:'Operations' },
  { id:'customers', label:'Customers', short:'Buyers', icon:Users, group:'Operations', roles:['owner','manager'] },
  { id:'shifts', label:'Shifts & drawer', short:'Drawer', icon:Banknote, group:'Operations' },
  { id:'reports', label:'Reports & analytics', short:'Reports', icon:ChartNoAxesCombined, group:'Operations', roles:['owner','manager'] },
  { id:'instore', label:'Physical source review', short:'Source', icon:Package, group:'Operations', liveOnly:true },
  { id:'staff', label:'Staff & permissions', short:'Staff', icon:Users, group:'Administration', roles:['owner'] },
  { id:'audit', label:'Audit log', short:'Audit', icon:ScrollText, group:'Administration', roles:['owner'] },
  { id:'connection', label:'Settings & connection', short:'Settings', icon:Settings2, group:'Administration' },
];
export default function App() {
  const [session,setSession]=useState(null);const [page,setPage]=useState('register');const [catalog,setCatalog]=useState(null);const [sales,setSales]=useState([]);const [salesCursor,setSalesCursor]=useState('');const [salesHasMore,setSalesHasMore]=useState(false);const [salesLoadingMore,setSalesLoadingMore]=useState(false);const [catalogError,setCatalogError]=useState('');
  const [pending,setPending]=useState(null);const [receipt,setReceipt]=useState(null);const [help,setHelp]=useState(false);const [toast,setToast]=useState(null);const [sidebar,setSidebar]=useState(false);const [profile,setProfile]=useState(false);const [accountMenu,setAccountMenu]=useState(false);const [alertsOpen,setAlertsOpen]=useState(false);const [collapsed,setCollapsed]=useState(()=>{try{return localStorage.getItem('mansu-nav-collapsed')==='true';}catch{return false;}});const [productCategory,setProductCategory]=useState('All products');const [searchSignal,setSearchSignal]=useState(0);const [refreshing,setRefreshing]=useState(false);const [refreshKey,setRefreshKey]=useState(0);const [savedCarts,setSavedCarts]=useState([]);const [shift,setShift]=useState(null);const [login,setLogin]=useState({username:'',password:''});const [loginBusy,setLoginBusy]=useState(false);const [loginError,setLoginError]=useState('');const [passwordOpen,setPasswordOpen]=useState(false);const [passwordForm,setPasswordForm]=useState({currentPassword:'',newPassword:''});const [passwordBusy,setPasswordBusy]=useState(false);
  const initialized=useRef(false);const heldKey=useRef('');const drawerRef=useRef(null);const focusPageAfterNav=useRef(false);
  const [installPrompt,setInstallPrompt]=useState(null);
  const [installed,setInstalled]=useState(()=>window.matchMedia('(display-mode: standalone)').matches||Boolean(navigator.standalone));
  const [offline,setOffline]=useState(()=>navigator.onLine===false);
  const [connectionRecheck,setConnectionRecheck]=useState(()=>navigator.onLine===false);
  const notify=useCallback((message,tone='success')=>setToast({message,tone,id:Date.now()}),[]);
  useEffect(()=>{try{localStorage.setItem('mansu-nav-collapsed', String(collapsed));}catch{}},[collapsed]);
  useEffect(()=>{
    if(!accountMenu&&!alertsOpen)return;
    const close=event=>{if(event.key==='Escape'){setAccountMenu(false);setAlertsOpen(false);}};
    const outside=event=>{if(!event.target.closest('.topbar-popover-area')){setAccountMenu(false);setAlertsOpen(false);}};
    document.addEventListener('keydown',close);document.addEventListener('pointerdown',outside);
    return()=>{document.removeEventListener('keydown',close);document.removeEventListener('pointerdown',outside);};
  },[accountMenu,alertsOpen]);
  useEffect(()=>{
    const onPrompt=event=>{event.preventDefault();setInstallPrompt(event);};
    const onInstalled=()=>{setInstalled(true);setInstallPrompt(null);};
    const connection=()=>{const disconnected=navigator.onLine===false;setOffline(disconnected);if(disconnected)setConnectionRecheck(true);};
    window.addEventListener('beforeinstallprompt',onPrompt);
    window.addEventListener('appinstalled',onInstalled);
    window.addEventListener('online',connection);
    window.addEventListener('offline',connection);
    return()=>{window.removeEventListener('beforeinstallprompt',onPrompt);window.removeEventListener('appinstalled',onInstalled);window.removeEventListener('online',connection);window.removeEventListener('offline',connection);};
  },[]);
  async function installApp(){
    if(!installPrompt)return;
    const prompt=installPrompt;setInstallPrompt(null);
    try{await prompt.prompt();const choice=await prompt.userChoice;if(choice?.outcome==='accepted')notify('Install accepted. Open Mansu POS from your desktop or app launcher when ready.');}
    catch{notify('Use your browser menu to install this app.','error');}
  }
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
    try{const [c,s,sh]=await Promise.allSettled([api(`/catalog${force?'?refresh=1':''}`),api('/sales'),api('/shifts/current')]);
      if(c.status==='fulfilled')setCatalog(c.value);
      else setCatalog(previous=>previous?{...previous,stale:true,error:'Catalogue refresh failed; this is the last loaded snapshot.'}:previous);
      if(s.status==='fulfilled'){setSales(s.value.sales);setSalesCursor(s.value.nextCursor||'');setSalesHasMore(Boolean(s.value.hasMore));}
      if(sh.status==='fulfilled')setShift(sh.value.shift);
      setCatalogError([c,s,sh].find(result=>result.status==='rejected')?.reason?.message||'');setRefreshKey(k=>k+1);
      // Reconnecting is not enough: keep the warning until a fresh catalogue
      // and operational reads have actually succeeded on this device.
      if(c.status==='fulfilled'&&Array.isArray(c.value?.products)&&!c.value.stale&&!c.value.error&&s.status==='fulfilled'&&sh.status==='fulfilled'&&navigator.onLine!==false)setConnectionRecheck(false);
    }finally{setRefreshing(false);}
  },[userId]);
  useEffect(()=>{if(!offline&&connectionRecheck&&userId&&!mustChangePassword)refresh(true);},[offline,connectionRecheck,userId,mustChangePassword,refresh]);
  const loadMoreSales=useCallback(async()=>{if(!salesCursor||salesLoadingMore)return;setSalesLoadingMore(true);try{const page=await api(`/sales?cursor=${encodeURIComponent(salesCursor)}`);setSales(previous=>{const seen=new Set(previous.map(s=>s.id));return [...previous,...page.sales.filter(s=>!seen.has(s.id))];});setSalesCursor(page.nextCursor||'');setSalesHasMore(Boolean(page.hasMore));}catch(e){notify(e.message,'error');}finally{setSalesLoadingMore(false);}},[salesCursor,salesLoadingMore,notify]);
  useEffect(()=>{if(userId&&!mustChangePassword){refresh();const key=`mansu-held-${mode}-${userId}`;heldKey.current=key;try{setSavedCarts(JSON.parse(localStorage.getItem(key)||'[]'));}catch{setSavedCarts([]);}}},[userId,mode,mustChangePassword,refresh]);
  useEffect(()=>{const expired=()=>{setSessionToken('');setSession(s=>s?{...s,user:null}:s);setCatalog(null);setSales([]);setSalesCursor('');setSalesHasMore(false);setSavedCarts([]);setShift(null);heldKey.current='';};window.addEventListener('mansu:session-expired',expired);return()=>window.removeEventListener('mansu:session-expired',expired);},[]);
  useEffect(()=>{if(heldKey.current)localStorage.setItem(heldKey.current,JSON.stringify(savedCarts));},[savedCarts]);
  useEffect(()=>{if(mode==='demo'||!userId)return;const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!pending&&!receipt)refresh();},60000);return()=>clearInterval(timer);},[mode,userId,refresh,pending,receipt]);
  // A resizable installed window can cross the drawer breakpoint while the
  // menu is open. Release the focus trap and restore the main workspace.
  useEffect(()=>{
    const desktop=window.matchMedia('(min-width: 1081px)');
    const closeOnDesktop=()=>{if(desktop.matches)setSidebar(false);};
    desktop.addEventListener('change',closeOnDesktop);
    return()=>desktop.removeEventListener('change',closeOnDesktop);
  },[]);
  useEffect(()=>{
    if(!sidebar)return;
    const overflow=document.body.style.overflow;
    const drawer=drawerRef.current;
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
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',drawerKey);const menu=document.querySelector('.mobile-menu');if(menu?.getClientRects().length)menu.focus();else drawer?.querySelector('nav [aria-current="page"]')?.focus();};
  },[sidebar]);
  useEffect(()=>{
    if(!focusPageAfterNav.current)return;
    focusPageAfterNav.current=false;
    const heading=[...document.querySelectorAll('#main-content h1')].find(el=>el.getClientRects().length);
    (heading||document.getElementById('main-content'))?.focus();
  },[page,sidebar]);
  function navigate(id){focusPageAfterNav.current=sidebar;setPage(id);setSidebar(false);setProfile(false);setAccountMenu(false);setAlertsOpen(false);}
  function openProductSearch(){navigate('register');setSearchSignal(value=>value+1);}
  function openCategory(name){setProductCategory(name);navigate('products');}
  async function logout(){try{await api('/auth/logout',{method:'POST',body:{}});setSessionToken('');setSidebar(false);if(isDemo){const data=await api('/auth/demo',{method:'POST',body:{}});setSessionToken(data.token);setSession(data);setProfile(false);setPage('register');notify('New demo session opened. Existing demo sales are preserved.');return;}setSession(s=>({...s,user:null}));setCatalog(null);setSales([]);setSalesCursor('');setSalesHasMore(false);setSavedCarts([]);setShift(null);heldKey.current='';setProfile(false);}catch(e){notify(e.message,'error');}}
  async function signIn(e){e.preventDefault();setLoginBusy(true);setLoginError('');try{const data=await api('/auth/login',{method:'POST',body:login});setSessionToken(data.token);setSession(data);setPage('register');setLogin({...login,password:''});}catch(e){setLoginError(e.message);}finally{setLoginBusy(false);}}
  async function openDemo(){setLoginBusy(true);setLoginError('');try{await loadSession();setPage('register');}catch(e){setLoginError(e.message);}finally{setLoginBusy(false);}}
  function paid(sale){setPending(null);setReceipt(sale);refresh();notify('Payment recorded. Your receipt is ready.');}
  const config=session?.config;const user=session?.user;const isDemo=config?.mode==='demo';
  if(!session)return <div className="boot-screen"><div className="brand-mark">M<span>·</span></div><span className="eyebrow">MANSUTRENDZGH</span><h1>Retail studio</h1>{catalogError?<Notice tone="error">{catalogError}<button className="button secondary" onClick={()=>location.reload()}>Try again</button></Notice>:<Spinner label="Opening your workspace…"/>}</div>;
  if(!user)return <div className="login-page"><section className="login-story"><div className="login-brand"><div className="brand-mark">M<span>·</span></div><span>MANSUTRENDZGH<small>RETAIL STUDIO · GHANA</small></span></div><div className="login-editorial"><span className="eyebrow">In-store workspace</span><h1>Good style.<br/>Great service.<br/><em>One beautiful counter.</em></h1><p>Your online collection and the orders recorded by this POS, in one clear workspace.</p></div><span className="login-story-footer"><ShieldCheck size={16}/>Designed for the way your boutique sells.</span></section><div className="login-form-wrap"><form onSubmit={signIn} className="login-form"><span className="eyebrow">Your workspace</span><h2>{config.liveReadOnly?'View live products.':'Open your register.'}</h2><p>{config.mode==='demo'?'Safe practice workspace. No real payments or live store changes.':config.liveReadOnly?'Live store catalogue · checkout locked.':`Sign in to your ${config.mode} workspace.`}</p>{config.liveReadOnly&&<Notice tone="warning">This workspace reads live product and stock data but cannot create orders or record payments. Do not collect money or release goods through this POS.</Notice>}{config.mode!=='demo'&&!config.configured&&<Notice>Owner setup required. Configure credentials and the first owner account using docs/SETUP.md.</Notice>}{loginError&&<Notice tone="error">{loginError}</Notice>}{config.mode==='demo'?<button type="button" className="button primary" onClick={openDemo} disabled={loginBusy}>{loginBusy?<LoaderCircle className="spin" size={18}/>:<ArrowRight size={18}/>} {loginBusy?'Opening demo…':'Open demo workspace'}</button>:<><label>Username<input className="input" autoComplete="username" required value={login.username} onChange={e=>setLogin({...login,username:e.target.value})}/></label><label>Password<input className="input" type="password" autoComplete="current-password" required value={login.password} onChange={e=>setLogin({...login,password:e.target.value})}/></label><button className="button primary" disabled={loginBusy}>{loginBusy?<LoaderCircle className="spin" size={18}/>:<ArrowRight size={18}/>} {loginBusy?'Signing in…':'Sign in'}</button></>}{installPrompt&&!installed&&<button type="button" className="button secondary" onClick={installApp}><Download size={17}/>Install app</button>}<small>{config.mode==='demo'?<><ShieldCheck size={13}/>No username or password. Enters as Demo Owner.</>:<><LockKeyhole size={13}/>Named accounts. Secure, eight-hour sessions.</>}</small></form></div></div>;
  const allowed=navigation.filter(n=>(!n.liveOnly||config.mode==='live')&&(!n.roles||n.roles.includes(user.role)));
  if(user.mustChangePassword)return <div className="boot-screen"><div className="brand-mark">M<span>·</span></div><h1>Set your password</h1><p className="muted">This is a temporary password. Choose a new one before using the register.</p><form className="login-form force-password" onSubmit={async e=>{e.preventDefault();setPasswordBusy(true);try{const result=await api('/auth/password',{method:'POST',body:passwordForm});setSession(s=>({...s,user:result.user}));setPasswordForm({currentPassword:'',newPassword:''});notify('Password updated. You can now use the POS.');}catch(err){notify(err.message,'error');}finally{setPasswordBusy(false);}}}><label>Temporary password<input className="input" type="password" autoComplete="current-password" required value={passwordForm.currentPassword} onChange={e=>setPasswordForm({...passwordForm,currentPassword:e.target.value})}/></label><label>New password<input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={passwordForm.newPassword} onChange={e=>setPasswordForm({...passwordForm,newPassword:e.target.value})}/></label><button className="button primary" disabled={passwordBusy}>{passwordBusy?'Saving…':'Set password'}</button></form><Toast toast={toast} onClose={closeToast}/></div>;
  const currentNav=navigation.find(n=>n.id===page);
  const catalogueIncomplete=!isDemo&&catalog?.complete===false;
  const badgeTone=page==='instore'?'amber':isDemo?'amber':catalogError||catalog?.stale||catalog?.error||catalogueIncomplete?'red':!catalog||!config.configured||!config.writesEnabled?'amber':'green';
  const badgeLabel=page==='instore'?config.inStoreCashEnabled?'In-store cash only':'In-store locked'
    :isDemo?'Demo mode':config.liveReadOnly?'No checkout':catalogError?'Connection review':!catalog?'Loading catalogue'
    :!config.configured?'Setup required':catalog.stale||catalog.error?'Connection review':catalogueIncomplete?'Incomplete catalogue'
    :!config.writesEnabled?config.inStoreCashEnabled?'In-store cash only':'Checkout locked':refreshing?'Syncing':'Catalogue synced';
  return <div className={`app-shell ${collapsed ? 'is-collapsed' : ''}`}>
    <a className="skip-link" href="#main-content" inert={sidebar}>Skip to content</a>
    {sidebar&&<div className="sidebar-scrim" aria-hidden="true" onClick={()=>setSidebar(false)}/>}
    <WorkspaceSidebar allowed={allowed} page={page} navigate={navigate} open={sidebar} drawerRef={drawerRef} collapsed={collapsed} onToggleCollapsed={()=>setCollapsed(value=>!value)} config={config} user={user} sales={sales} isDemo={isDemo} installPrompt={installPrompt} installed={installed} installApp={()=>{setSidebar(false);installApp();}} setHelp={()=>{setSidebar(false);setProfile(false);setHelp(true);}} profile={profile} setProfile={setProfile} setPasswordOpen={setPasswordOpen} logout={logout} />
    <div className="main-shell" inert={sidebar}>
      <WorkspaceHeader currentNav={currentNav} onOpenMenu={()=>setSidebar(true)} open={sidebar} onSearch={openProductSearch} badgeTone={badgeTone} badgeLabel={badgeLabel} isDemo={isDemo} config={config} user={user} sales={sales} catalog={catalog} installPrompt={installPrompt} installed={installed} installApp={installApp} onHelp={()=>setHelp(true)} alertsOpen={alertsOpen} setAlertsOpen={setAlertsOpen} accountMenu={accountMenu} setAccountMenu={setAccountMenu} onNavigate={navigate} onPassword={()=>{setPasswordOpen(true);setAccountMenu(false);}} logout={logout} />
      {isDemo&&<div className="demo-banner" role="region" aria-label="Demo environment notice"><span><span className="demo-banner-icon"><ShieldCheck size={14}/></span><strong>Demo mode</strong><span>No live orders or payments are created.</span></span><button onClick={()=>navigate('connection')}>Connect your store<ArrowRight size={14}/></button></div>}
      {config.liveReadOnly&&<div className="demo-banner" role="region" aria-label="Live catalogue read-only notice"><span><span className="demo-banner-icon"><LockKeyhole size={14}/></span><strong>Live catalogue · no checkout</strong><span>No orders or payments can be recorded. Do not release goods using this POS.</span></span></div>}
      {(offline||connectionRecheck)&&<div className="offline-banner" role="alert"><WifiOff size={18}/><span>{offline?<><strong>Device offline.</strong> Current stock cannot be checked. Do not take payment or release goods; reconnect and refresh first.</>:<><strong>Reconnected · verifying stock.</strong> Do not take payment or release goods until the current catalogue is confirmed. <button className="offline-refresh" onClick={()=>refresh(true)} disabled={refreshing}>{refreshing?'Checking…':'Retry refresh'}</button></>}</span></div>}
      <main id="main-content" tabIndex={-1} className={`main-content ${page==='register'?'register-main':''}`}>
        {catalogError&&page!=='instore'&&<Notice tone="error">{catalogError}<button className="text-button" onClick={()=>refresh(true)}>Try again</button></Notice>}
        {page==='instore'&&config.mode==='live'&&<InStore config={config} user={user} shift={shift} onOpenShift={()=>navigate('shifts')} notify={notify}/>}
        {page!=='instore'&&(!catalog&&!catalogError?<Spinner label="Loading your catalogue…"/>:<>
          {page==='overview'&&user.role!=='cashier'&&<Overview catalog={catalog} config={config} sales={sales} salesHasMore={salesHasMore} refresh={refresh} refreshKey={refreshKey} onNavigate={navigate}/>}
          <div style={{display:page==='register'?'block':'none'}}><Register key={`${config.mode}-${user.id}`} active={page==='register'} catalog={catalog} config={config} checkoutScope={`${config.mode}-${user.id}`} refresh={refresh} notify={notify} onPrepared={setPending} onOpenSales={()=>navigate('sales')} onOpenWholesale={()=>navigate('wholesale')} canWholesale={user.role!=='cashier'} searchSignal={searchSignal} savedCarts={savedCarts} setSavedCarts={setSavedCarts} setHelp={()=>setHelp(true)} shift={shift} onOpenShift={()=>navigate('shifts')}/></div>
          {user.role!=='cashier'&&<div style={{display:page==='wholesale'?'block':'none'}}><Wholesale key={`${config.mode}-${user.id}`} catalog={catalog} config={config} user={user} active={page==='wholesale'} checkoutScope={`${config.mode}-${user.id}`} refresh={refresh} notify={notify} onPrepared={setPending} onOpenSales={()=>navigate('sales')} onOpenRetail={()=>navigate('register')} shift={shift} onOpenShift={()=>navigate('shifts')}/></div>}
          {page==='products'&&<ProductsPage catalog={catalog} config={config} category={productCategory} onCategoryChange={setProductCategory} refresh={refresh} notify={notify} onNavigate={navigate}/>}
          {page==='categories'&&<CategoriesPage catalog={catalog} config={config} onSelect={openCategory} refresh={refresh}/>}
          {(page==='sales'||page==='orders')&&<Sales key={page} view={page} sales={sales} config={config} refresh={refresh} onReceipt={setReceipt} onPay={setPending} notify={notify} hasMore={salesHasMore} loadingMore={salesLoadingMore} onLoadMore={loadMoreSales}/>}
          {page==='inventory'&&<Inventory catalog={catalog} config={config} user={user} active={page==='inventory'} refresh={refresh} notify={notify}/>}
          {page==='customers'&&user.role!=='cashier'&&<Customers refreshKey={refreshKey}/>}
          {page==='shifts'&&<Shifts config={config} user={user} shift={shift} refresh={refresh} notify={notify}/>}
          {page==='reports'&&user.role!=='cashier'&&<Reports config={config} notify={notify} refreshKey={refreshKey}/>}
          {page==='staff'&&user.role==='owner'&&<Staff config={config} user={user} notify={notify}/>}
          {page==='audit'&&user.role==='owner'&&<Audit notify={notify}/>}
          {page==='connection'&&<Connection config={config} catalog={catalog} refresh={refresh} notify={notify} user={user}/>}
        </>)}
      </main><footer className="app-footer"><span>MansutRENDZGH <span>·</span> Retail studio</span><span><ShieldCheck size={12}/>{isDemo?'Isolated demo environment':config.liveReadOnly?'Live catalogue · checkout locked':`${config.mode} environment`}<span>·</span>GHS</span></footer>
    </div>
    {pending&&<Checkout sale={pending} config={config} onClose={()=>{setPending(null);refresh();if(config.mode!=='demo')notify('Unpaid order saved in Sales. Do not release goods until the full payment is verified and recorded.');}} onPaid={paid} notify={notify}/>}
    {receipt&&<Receipt sale={receipt} config={config} onClose={()=>setReceipt(null)}/>}
    {help&&<Help config={config} scope={page} onClose={()=>setHelp(false)} canInstall={Boolean(installPrompt)&&!installed} installed={installed} onInstall={installApp}/>}
    {passwordOpen&&<Modal title="Change your password" subtitle="Other sessions will be signed out." onClose={()=>setPasswordOpen(false)} busy={passwordBusy}><form onSubmit={async e=>{e.preventDefault();setPasswordBusy(true);try{await api('/auth/password',{method:'POST',body:passwordForm});setPasswordOpen(false);setPasswordForm({currentPassword:'',newPassword:''});notify('Password changed. Other sessions were signed out.');}catch(err){notify(err.message,'error');}finally{setPasswordBusy(false);}}}><div className="modal-body form-stack"><label>Current password<input className="input" type="password" autoComplete="current-password" required value={passwordForm.currentPassword} onChange={e=>setPasswordForm({...passwordForm,currentPassword:e.target.value})}/></label><label>New password<input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={passwordForm.newPassword} onChange={e=>setPasswordForm({...passwordForm,newPassword:e.target.value})}/><small className="field-hint">Use at least 12 characters. Do not reuse your WordPress password.</small></label></div><div className="modal-footer" role="group" aria-label="Dialog actions"><button type="button" className="button secondary" onClick={()=>setPasswordOpen(false)}>Cancel</button><button className="button primary" disabled={passwordBusy}>{passwordBusy?'Saving…':'Change password'}</button></div></form></Modal>}
    <Toast toast={toast} onClose={closeToast}/>
  </div>;
}
