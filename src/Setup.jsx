import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, PlugZap, Stethoscope, ReceiptText, ToggleRight, Rocket, Clock, MonitorDown } from 'lucide-react';
import { api } from './api.js';
import { PageHeading, Notice, Spinner } from './components.jsx';

// Platform shops only: the owner's checklist from sign-up to the first sale.
const ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle };
const STAGE_LABEL = { setup: 'Not connected', read_only: 'Practice mode — no real sales', selling: 'Selling' };
const daysLeft = iso => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));

function Step({ number, done, icon: Icon, title, children }) {
  return <section className={`surface setup-step${done ? ' done' : ''}`} aria-labelledby={`setup-step-${number}`}>
    <div className="setup-step-head">
      <span className="setup-step-number" aria-hidden="true">{done ? <CheckCircle2 size={18} /> : number}</span>
      <Icon size={18} aria-hidden="true" />
      <h2 id={`setup-step-${number}`}>{title}{done && <span className="sr-only"> (done)</span>}</h2>
    </div>
    <div className="setup-step-body">{children}</div>
  </section>;
}

export default function Setup({ notify }) {
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [business, setBusiness] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const load = () => api('/setup').then(data => { setSetup(data.setup); setBusiness({ name: data.setup.name, ...data.setup.business }); }).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (new URLSearchParams(location.search).get('setup') === 'connected') {
      notify?.('Store connected. Run the store check next.');
      history.replaceState(null, '', location.pathname);
    }
  }, [notify]);
  const run = async (name, fn) => {
    setBusy(name); setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  if (!setup) return error ? <Notice tone="error">{error}</Notice> : <Spinner label="Loading shop setup…" />;

  const health = setup.health;
  const fresh = setup.healthAt && Date.now() - Date.parse(setup.healthAt) < 24 * 3600000;
  const canSell = setup.connected && health?.ok && fresh;
  const connect = () => run('connect', async () => { const { url } = await api('/setup/woo/connect', { method: 'POST', body: {} }); window.location.assign(url); });
  const check = () => run('health', async () => { setSetup((await api('/setup/health', { method: 'POST', body: {} })).setup); });
  const saveBusiness = event => { event.preventDefault(); run('business', async () => {
    const body = Object.fromEntries(Object.entries(business).filter(([key]) => ['name', 'address', 'phone', 'taxId', 'receiptFooter', 'receiptWidth'].includes(key)).map(([k, v]) => [k, String(v ?? '')]));
    if (!body.receiptWidth) delete body.receiptWidth;
    setSetup((await api('/setup/business', { method: 'PUT', body })).setup);
    notify?.('Receipt details saved. They apply after the next reload.');
  }); };
  const toggle = (key, value) => run(`feature-${key}`, async () => { setSetup((await api('/setup/features', { method: 'PUT', body: { [key]: value } })).setup); });
  const stage = next => run('stage', async () => {
    await api('/setup/stage', { method: 'POST', body: { stage: next, ...(next === 'selling' ? { confirm } : {}) } });
    window.location.reload();
  });

  return <div className="setup-page">
    <PageHeading eyebrow="Your shop" title="Shop setup" description={`${setup.slug} · ${STAGE_LABEL[setup.stage]}`}>
      {setup.trialEndsAt && <span className="setup-trial"><Clock size={15} aria-hidden="true" /> Free trial: {daysLeft(setup.trialEndsAt)} days left</span>}
    </PageHeading>
    {error && <Notice tone="error">{error}</Notice>}

    <Step number={1} done={setup.connected} icon={PlugZap} title="Connect your WooCommerce store">
      <p>You will be sent to <strong>{setup.storeUrl.replace('https://', '')}</strong> to approve Mansu POS. Sign in there as a store administrator and choose <em>Approve</em>.</p>
      {setup.connected
        ? <p className="setup-ok">Connected{setup.connectedAt ? ` on ${new Date(setup.connectedAt).toLocaleDateString()}` : ''}. <button type="button" className="text-button" onClick={connect} disabled={!!busy}>Connect again</button></p>
        : <button type="button" className="button primary" onClick={connect} disabled={!!busy}>{busy === 'connect' ? 'Opening your store…' : 'Connect store'}</button>}
    </Step>

    <Step number={2} done={Boolean(health?.ok && fresh)} icon={Stethoscope} title="Check your store">
      <p>Checks currency, stock tracking, SKUs and products so the till and website keep one stock count.</p>
      <button type="button" className="button secondary" onClick={check} disabled={!setup.connected || !!busy}>{busy === 'health' ? 'Checking…' : health ? 'Check again' : 'Run store check'}</button>
      {health && <ul className="setup-health" aria-label="Store check results">
        {health.items.map(item => { const Icon = ICON[item.status]; return <li key={item.key} className={item.status}>
          <Icon size={17} aria-hidden="true" /><div><strong>{item.label}</strong><span>{item.detail}</span></div>
          <span className="sr-only">{item.status === 'pass' ? 'Passed' : item.status === 'warn' ? 'Warning' : 'Must fix'}</span>
        </li>; })}
      </ul>}
      {health && <p className="field-hint">Checked {new Date(setup.healthAt).toLocaleString()}{!fresh && ' — run it again before selling'}.</p>}
    </Step>

    <Step number={3} done={Boolean(setup.business?.address)} icon={ReceiptText} title="Receipt details">
      <form className="setup-form" onSubmit={saveBusiness}>
        <label>Shop name<input className="input" value={business.name || ''} maxLength={80} required onChange={e => setBusiness({ ...business, name: e.target.value })} /></label>
        <label>Address<input className="input" value={business.address || ''} maxLength={200} onChange={e => setBusiness({ ...business, address: e.target.value })} /></label>
        <label>Phone<input className="input" value={business.phone || ''} maxLength={60} onChange={e => setBusiness({ ...business, phone: e.target.value })} /></label>
        <label>Tax ID (optional)<input className="input" value={business.taxId || ''} maxLength={40} onChange={e => setBusiness({ ...business, taxId: e.target.value })} /></label>
        <label className="wide">Receipt footer<input className="input" value={business.receiptFooter || ''} maxLength={200} placeholder={`Thank you for shopping with ${business.name || 'us'}.`} onChange={e => setBusiness({ ...business, receiptFooter: e.target.value })} /></label>
        <label>Paper width<select className="select" value={business.receiptWidth || '80'} onChange={e => setBusiness({ ...business, receiptWidth: e.target.value })}><option value="80">80 mm</option><option value="58">58 mm</option><option value="a4">A4</option></select></label>
        <div className="wide"><button type="submit" className="button secondary" disabled={!!busy}>{busy === 'business' ? 'Saving…' : 'Save receipt details'}</button></div>
      </form>
    </Step>

    <Step number={4} done={false} icon={ToggleRight} title="Optional features">
      <p>These change website stock or money, so they are off until you turn them on. They apply once selling starts.</p>
      {[['inventoryWrites', 'Stock control', 'Receive deliveries, write off damage, run counts'], ['productWrites', 'Product editing', 'Add and edit website products and photos'], ['returns', 'Customer returns', 'Refund to the WooCommerce order and pay cash from the shift']].map(([key, label, hint]) =>
        <label key={key} className="setup-toggle"><input type="checkbox" checked={Boolean(setup.features?.[key])} disabled={!!busy} onChange={e => toggle(key, e.target.checked)} /><span><strong>{label}</strong><small>{hint}</small></span></label>)}
    </Step>

    <Step number={5} done={setup.stage === 'selling'} icon={Rocket} title={setup.stage === 'selling' ? 'Selling' : 'Start selling'}>
      {setup.stage === 'selling'
        ? <><p>Every sale now creates a WooCommerce order and lowers website stock.</p><button type="button" className="button secondary" onClick={() => stage('read_only')} disabled={!!busy}>Pause selling (back to practice)</button></>
        : <>
          <p>In practice mode staff can learn the till on your real catalogue; nothing is sold. When you start selling, cash sales create real WooCommerce orders and change website stock.</p>
          <label className="setup-toggle"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} disabled={!canSell} /><span><strong>I understand sales will be real</strong><small>Make one small test sale first and check it in WooCommerce.</small></span></label>
          <button type="button" className="button primary" onClick={() => stage('selling')} disabled={!canSell || !confirm || !!busy}>{busy === 'stage' ? 'Starting…' : 'Start selling'}</button>
          {!canSell && <p className="field-hint">{!setup.connected ? 'Connect your store first.' : 'Run the store check; every "must fix" item has to pass.'}</p>}
        </>}
    </Step>
    <Step number={6} done={false} icon={MonitorDown} title="Windows till (optional)">
      <p>A desktop app for the shop PC: your shop in its own window, silent receipt printing and cash drawer. On first launch type <strong>{setup.slug}</strong> as the shop address.</p>
      {setup.till
        ? <><p><a className="button secondary" href={setup.till.url} rel="noopener noreferrer">Download Mansu POS {setup.till.version} for Windows</a></p>
          <p className="field-hint">SHA-256: <code>{setup.till.sha256}</code></p></>
        : <p className="field-hint">The Windows installer is not published yet. The web till works in any browser meanwhile.</p>}
    </Step>
  </div>;
}
