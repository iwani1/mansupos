import React, { useEffect, useState } from 'react';
import { CreditCard, RefreshCw, Smartphone, ExternalLink, CheckCircle2 } from 'lucide-react';
import { api, dateTime } from './api.js';
import { PageHeading, Notice, Spinner } from './components.jsx';

// Platform shops only: the owner's subscription. Payment happens on Paystack's
// own page; the server confirms it with Paystack before extending access.
const cedis = pesewas => `GH₵${(pesewas / 100).toLocaleString('en-GH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const STATE = {
  trial: ['Free trial', 'info'], active: ['Paid', 'success'], grace: ['Payment due', 'warning'],
  lapsed: ['Ended — sales paused', 'error'], comped: ['Complimentary', 'success'], unbilled: ['Not billed', 'info'],
};
const day = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

export default function Billing({ notify }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [interval, setInterval] = useState('monthly');
  const [email, setEmail] = useState('');
  const load = () => api('/billing').then(r => setData(r.billing)).catch(e => setError(e.message));
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const reference = params.get('reference') || params.get('trxref');
    if (params.get('billing') === 'return' && reference) {
      history.replaceState(null, '', location.pathname);
      setBusy('verify');
      api('/billing/verify', { method: 'POST', body: { reference } })
        .then(r => { setData(r.billing); if (r.paid) { notify?.('Payment received. Thank you!'); setTimeout(() => window.location.reload(), 1200); } else setError(`Payment not completed (${r.status}). You have not been charged for this attempt.`); })
        .catch(e => setError(e.message)).finally(() => setBusy(''));
    } else load();
  }, [notify]);
  if (!data) return error ? <Notice tone="error">{error}</Notice> : <Spinner label={busy === 'verify' ? 'Confirming your payment with Paystack…' : 'Loading billing…'} />;

  const { access } = data;
  const [label, tone] = STATE[access.state] || ['', 'info'];
  const pay = (plan, autoRenew) => async () => {
    setBusy(`${plan}-${autoRenew}`); setError('');
    try {
      const { url } = await api('/billing/checkout', { method: 'POST', body: { plan, interval, autoRenew, ...(email ? { email } : {}) } });
      window.location.assign(url);
    } catch (e) { setError(e.message); setBusy(''); }
  };
  const manage = async () => {
    setBusy('manage');
    try { const { url } = await api('/billing/manage', { method: 'POST', body: {} }); window.open(url, '_blank', 'noopener'); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const statusLine = access.state === 'trial' ? `Free trial until ${day(access.until)}.`
    : access.state === 'active' ? `Paid until ${day(access.until)}.${data.billing.autoRenew ? ' Renews automatically.' : ''}`
      : access.state === 'grace' ? `Payment was due on ${day(access.until)}. Selling stops on ${day(access.graceUntil)} unless you pay.`
        : access.state === 'lapsed' ? 'Sales and website changes are paused. Sign-in, reports and history are still open. Pay to resume straight away.'
          : access.state === 'comped' ? 'Your shop is on a complimentary plan.' : 'No billing set up for this shop yet.';

  return <div className="setup-page">
    <PageHeading eyebrow="Your shop" title="Billing" description="Plans in Ghana cedi. Pay by card or Mobile Money through Paystack." />
    {error && <Notice tone="error">{error}</Notice>}
    {!data.configured && <Notice>Online payment is not set up yet. Contact Mansu POS support to pay by invoice.</Notice>}
    {data.testMode && <Notice tone="warning">Paystack TEST mode: no real money is charged.</Notice>}
    {data.discount && <Notice tone="success">Founding price: {data.discount.percent}% off every payment until {day(data.discount.until)}. Thank you for helping us build Mansu POS. Automatic card renewal starts after the founding price ends.</Notice>}
    <section className="surface setup-step">
      <div className="setup-step-head"><CheckCircle2 size={18} aria-hidden="true" /><h2>{label}</h2><span className={`badge ${tone}`}>{(data.plans.find(p => p.key === access.plan) || {}).name || ''} plan</span></div>
      <div className="setup-step-body"><p>{statusLine}</p>
        {data.billing.subscription && <button type="button" className="button secondary" onClick={manage} disabled={!!busy}><ExternalLink size={15} /> Update card or cancel renewal</button>}
      </div>
    </section>
    <div className="billing-intervals" role="radiogroup" aria-label="Billing period">
      {[['monthly', 'Monthly'], ['annually', 'Yearly — 2 months free']].map(([key, text]) =>
        <button key={key} type="button" role="radio" aria-checked={interval === key} className={interval === key ? 'selected' : ''} onClick={() => setInterval(key)}>{text}</button>)}
    </div>
    <div className="billing-plans">
      {data.plans.map(plan => <section key={plan.key} className={`surface billing-plan${plan.key === access.plan ? ' current' : ''}`} aria-labelledby={`plan-${plan.key}`}>
        <h2 id={`plan-${plan.key}`}>{plan.name}{plan.key === access.plan && <small> · current</small>}</h2>
        <p className="billing-price"><strong>{cedis(plan.prices[interval])}</strong> / {interval === 'annually' ? 'year' : 'month'}
          {plan.fullPrices && plan.fullPrices[interval] !== plan.prices[interval] && <span className="billing-was"><span className="sr-only">usually </span>{cedis(plan.fullPrices[interval])}</span>}</p>
        <p className="billing-summary">{plan.summary}</p>
        <button type="button" className="button primary" onClick={pay(plan.key, false)} disabled={!data.configured || !!busy}>
          <Smartphone size={15} /> {busy === `${plan.key}-false` ? 'Opening Paystack…' : `Pay for one ${interval === 'annually' ? 'year' : 'month'}`}</button>
        {plan.autoRenew[interval] && <button type="button" className="button secondary" onClick={pay(plan.key, true)} disabled={!data.configured || !!busy}>
          <RefreshCw size={15} /> {busy === `${plan.key}-true` ? 'Opening Paystack…' : 'Renew automatically by card'}</button>}
      </section>)}
    </div>
    <p className="field-hint">"Pay for one month/year" accepts card or Mobile Money and does not renew by itself. Paying early adds the time after your current period ends.</p>
    <label className="billing-email">Receipt email (only if your shop has none)<input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={120} /></label>
    {data.events.length > 0 && <section className="surface setup-step"><div className="setup-step-head"><CreditCard size={18} aria-hidden="true" /><h2>History</h2></div>
      <ul className="setup-health">{data.events.map(e => <li key={`${e.at}-${e.kind}-${e.reference}`} className="pass"><CheckCircle2 size={16} aria-hidden="true" /><div><strong>{e.kind === 'payment' ? `Payment ${e.amount ? cedis(e.amount) : ''}` : e.detail}</strong><span>{dateTime(e.at)}{e.kind === 'payment' ? ` · ${e.detail}` : ''}</span></div></li>)}</ul>
    </section>}
  </div>;
}
