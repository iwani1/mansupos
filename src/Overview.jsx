import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CircleAlert, Clock3, Package, RefreshCw, ShoppingBag, TrendingUp } from 'lucide-react';
import { api, dateTime, money } from './api.js';
import { stockAlerts } from './catalog-insights.js';
import { Badge, Empty, Notice, PageHeading, ProductImage, Spinner, StatusBadge, TableRegion } from './components.jsx';
import { SalesChart } from './Pages.jsx';

const unsettled = new Set(['awaiting_payment', 'needs_reconciliation', 'creating']);

function Metric({ label, value, note, emphasis = false }) {
  return <div className={`overview-metric${emphasis ? ' overview-metric-lead' : ''}`}>
    <span>{label}</span><strong>{value}</strong><small>{note}</small>
  </div>;
}

export default function Overview({ catalog, config, sales, salesHasMore, refresh, refreshKey, onNavigate }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setError('');
    Promise.all([api('/reports?days=1'), api('/reports?days=7')])
      .then(([today, week]) => { if (current) setReport({ today, week }); })
      .catch(problem => { if (current) { setReport(null); setError(problem.message); } });
    return () => { current = false; };
  }, [refreshKey]);

  const alerts = useMemo(() => stockAlerts(catalog?.products, config.lowStockThreshold, config.mode !== 'demo'), [catalog, config.lowStockThreshold, config.mode]);
  const stockIsCurrent = Boolean(catalog && !catalog.stale && !catalog.error && (config.mode === 'demo' || catalog.complete === true));
  const pending = sales.filter(sale => unsettled.has(sale.status));
  const recent = sales.slice(0, 5);
  const summary = report?.today;
  const week = report?.week;
  const largestChannel = Math.max(0, ...(week?.saleTypes || []).map(channel => channel.total));

  return <div className="overview-page">
    <PageHeading eyebrow="MansutRENDZGH / business overview" title="Overview" description="A clear view of this POS. Website orders and legacy In-store cash receipts are not included.">
      <button className="button secondary" onClick={() => refresh(true)}><RefreshCw size={16} />Refresh workspace</button>
    </PageHeading>
    <div className="overview-intro"><div><span className="eyebrow">The day's ledger</span><h2>At a glance, with nothing assumed.</h2><p>Amounts below come from recorded POS activity, not estimated website sales.</p></div><span>{new Intl.DateTimeFormat('en-GH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Accra' }).format(new Date())}</span></div>
    {config.mode === 'demo' && <Notice>Practice figures from this isolated demo only. They are not live MansutRENDZGH sales.</Notice>}
    {config.mode !== 'demo' && catalog?.complete === false && <Notice tone="warning">The WooCommerce catalogue is incomplete. Product and stock counts cannot represent all website goods; refresh and review the missing pages.</Notice>}
    {config.mode !== 'demo' && catalog?.unsupported > 0 && <Notice tone="warning">{catalog.unsupported} online product {catalog.unsupported === 1 ? 'type is' : 'types are'} not supported by this POS catalogue and excluded from product/stock summaries.</Notice>}
    {error && <Notice tone="error">Reports could not be loaded: {error} <button className="text-button" onClick={() => refresh()}>Retry</button></Notice>}
    {!report && !error ? <Spinner label="Reading your POS records…" /> : report && <>
      <section className="overview-metrics" aria-label="Today's POS activity">
        <Metric label="Today's net POS sales" value={money(summary.total)} note="After recorded refunds · GHS" emphasis />
        <Metric label="Settled POS orders" value={summary.orders} note="Paid and refunded records" />
        <Metric label="Retail · today" value={money(summary.saleTypes.find(item => item.type === 'retail')?.total || 0)} note="Net retail POS sales" />
        <Metric label="Wholesale · today" value={money(summary.saleTypes.find(item => item.type === 'wholesale')?.total || 0)} note="Net wholesale POS sales" />
      </section>
      <div className="overview-operational" aria-label="Operational indicators">
        <button type="button" onClick={() => onNavigate('orders')}><Clock3 size={19} /><span><strong>{pending.length}{salesHasMore ? '+' : ''}</strong><small>Unsettled · loaded POS orders</small></span><ArrowRight size={16} /></button>
        <button type="button" onClick={() => onNavigate('inventory')}><CircleAlert size={19} /><span><strong>{stockIsCurrent ? alerts.low.length : '—'}</strong><small>Known low-stock pools</small></span><ArrowRight size={16} /></button>
        <div><Package size={19} /><span><strong>{summary.items}</strong><small>Items sold · today</small></span></div>
      </div>
      <div className="overview-grid">
        <section className="surface chart-panel overview-chart"><div className="section-heading"><div><span className="eyebrow">01 / Performance</span><h2>Sales over time</h2><p>Last 7 days · net POS activity in GHS</p></div><Badge>POS only</Badge></div><SalesChart daily={week.daily} days={7} /></section>
        <section className="surface overview-channels"><div className="section-heading"><div><span className="eyebrow">02 / Channel mix</span><h2>Where sales happened</h2><p>Last 7 days · after recorded refunds</p></div></div><div className="channel-list">
          {week.saleTypes.map(channel => <div className="channel-row" key={channel.type}><div><strong>{channel.type === 'wholesale' ? 'Wholesale POS' : 'Retail POS'}</strong><span>{channel.count} {channel.count === 1 ? 'order' : 'orders'}</span></div><strong>{money(channel.total)}</strong><div className="channel-track" aria-hidden="true"><span style={{ width: `${largestChannel ? Math.max(0, channel.total) / largestChannel * 100 : 0}%` }} /></div></div>)}
          <div className="channel-row channel-unavailable"><div><strong>Online retail</strong><span>Woo website orders are not synced to this POS</span></div><strong>Not available</strong></div>
        </div></section>
      </div>
      <div className="overview-grid overview-grid-secondary">
        <section className="surface overview-recent"><div className="section-heading"><div><span className="eyebrow">03 / The ledger</span><h2>Recent POS activity</h2><p>Latest loaded orders, including unpaid records</p></div><button className="text-button" onClick={() => onNavigate('sales')}>All sales <ArrowRight size={15} /></button></div>{recent.length ? <TableRegion label="Recent POS sales"><table className="responsive-table overview-table"><thead><tr><th>Reference</th><th>Channel</th><th>Status</th><th className="right">Amount</th></tr></thead><tbody>{recent.map(sale => <tr key={sale.id}><td data-label="Reference"><strong className="table-primary">{sale.number}</strong><small>{dateTime(sale.paidAt || sale.createdAt)}</small></td><td data-label="Channel">{sale.saleType === 'wholesale' ? 'Wholesale' : 'Retail'}</td><td data-label="Status"><StatusBadge status={sale.status} /></td><td data-label="Amount" className="right"><strong>{money(sale.total)}</strong></td></tr>)}</tbody></table></TableRegion> : <Empty icon={ShoppingBag} title="No POS activity yet">Orders created through this POS will appear here.</Empty>}</section>
        <section className="surface overview-top"><div className="section-heading"><div><span className="eyebrow">04 / The collection</span><h2>Most selected pieces</h2><p>Top-selling POS goods · last 7 days</p></div><TrendingUp size={19} aria-hidden="true" /></div>{week.topProducts.length ? <div className="overview-top-list">{week.topProducts.slice(0, 4).map((item, index) => <div key={`${item.name}:${item.label}:${index}`}><span className="rank">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.name}</strong><small>{item.label || 'Standard option'}</small></div><span>{item.quantity} {item.quantity === 1 ? 'unit' : 'units'}</span></div>)}</div> : <Empty icon={ShoppingBag} title="No bestsellers yet">They appear after POS sales are recorded.</Empty>}</section>
      </div>
      <section className="surface overview-stock"><div className="section-heading"><div><span className="eyebrow">05 / Watch list</span><h2>Inventory attention</h2><p>Known Woo stock pools at or below {config.lowStockThreshold} units · each parent pool counted once</p></div><button className="text-button" onClick={() => onNavigate('inventory')}>View inventory <ArrowRight size={15} /></button></div>{!stockIsCurrent ? <Notice tone="warning">Catalogue stock is stale, incomplete or unavailable. Refresh and verify stock before relying on quantities.</Notice> : alerts.low.length || alerts.out.length ? <div className="overview-stock-list">{[...alerts.out, ...alerts.low].slice(0, 5).map(item => <div key={item.key}><ProductImage src={item.image} name={item.name} /><span><strong>{item.name}</strong><small>{item.option || 'Standard'}</small></span><Badge tone={item.stock <= 0 ? 'red' : 'amber'} dot>{item.stock <= 0 ? 'Out of stock' : `${item.stock} left`}</Badge></div>)}</div> : <div className="overview-clear"><Package size={19} />No tracked pools currently at or below the low-stock threshold.</div>}</section>
      <p className="report-scope">Reports cover POS-linked Retail and Wholesale only. Online orders are not imported. This screen does not authorise checkout in a read-only environment.</p>
    </>}
  </div>;
}
