import React, { useEffect, useState } from 'react';
import { Globe, Store } from 'lucide-react';
import { api, money } from './api.js';
import { Notice, Spinner, Stat } from './components.jsx';

// Website orders for the same period, read from WooCommerce (POS orders
// excluded), plus the shop + website combined total.
export default function WebsiteReport({ config, days, pos, refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const available = config.mode !== 'demo' && !config.liveReadOnly && config.configured;
  useEffect(() => {
    if (!available) return undefined;
    let active = true;
    setData(null); setError('');
    api(`/reports/website?days=${days}`).then(d => { if (active) setData(d); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [days, refreshKey, available]);
  if (!available) return <section className="surface website-report"><div className="section-heading"><div><h2>Website orders</h2><p>Online checkout orders from WooCommerce</p></div><Globe size={20} /></div><p className="field-hint">{config.mode === 'demo' ? 'The demo has no website. On the live POS, paid website orders for the same period appear here next to shop sales.' : 'Website orders cannot be read by this POS service.'}</p></section>;
  if (error) return <Notice tone="error">Website orders could not be loaded: {error}</Notice>;
  if (!data) return <Spinner label="Reading website orders from WooCommerce…" />;
  const combined = pos.total + data.total;
  const share = combined > 0 ? Math.round(data.total / combined * 100) : 0;
  return <section className="surface website-report" aria-label="Website orders">
    <div className="section-heading"><div><h2>Website orders</h2><p>Paid online checkouts in the same period, after refunds · POS orders not included</p></div><Globe size={20} /></div>
    {data.partial && <Notice tone="warning">More than 2,000 website orders in this period. Only the first 2,000 are counted; choose a shorter period.</Notice>}
    <div className="stats-grid four">
      <Stat label="Shop + website" value={money(combined)} detail={`${pos.orders + data.orders} paid orders in total`} tone="featured" />
      <Stat label="Website sales" value={money(data.total)} detail={`${data.orders} ${data.orders === 1 ? 'order' : 'orders'} · ${share}% of total`} />
      <Stat label="Shop (POS) sales" value={money(pos.total)} detail={`${pos.orders} ${pos.orders === 1 ? 'order' : 'orders'}`} />
      <Stat label="Average website order" value={money(data.average)} detail={data.refunded ? `${money(data.refunded)} refunded` : 'No refunds'} />
    </div>
    <div className="website-report-columns">
      <div><h3>Daily website sales</h3><dl className="website-report-list">{data.daily.filter(d => d.count).length ? data.daily.filter(d => d.count).map(d => <div key={d.date}><dt>{new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} <span>· {d.count} {d.count === 1 ? 'order' : 'orders'}</span></dt><dd>{money(d.total)}</dd></div>) : <p className="field-hint">No paid website orders in this period.</p>}</dl></div>
      <div><h3>How website customers paid</h3><dl className="website-report-list">{data.methods.length ? data.methods.map(m => <div key={m.name}><dt>{m.name} <span>· {m.count}</span></dt><dd>{money(m.total)}</dd></div>) : <p className="field-hint">No payments yet.</p>}</dl></div>
      <div><h3>Top website products</h3><dl className="website-report-list">{data.topProducts.length ? data.topProducts.map(p => <div key={p.name}><dt>{p.name} <span>· {p.quantity} sold</span></dt><dd>{money(p.total)}</dd></div>) : <p className="field-hint">Nothing sold online yet.</p>}</dl></div>
    </div>
    <p className="field-hint"><Store size={13} aria-hidden="true" /> {data.scope}</p>
  </section>;
}
