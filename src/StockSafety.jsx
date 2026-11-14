import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, LockKeyhole, RefreshCw, ShieldCheck, Boxes } from 'lucide-react';
import { api, dateTime } from './api.js';
import { Badge, Notice, PageHeading, TableRegion } from './components.jsx';

// A catalogue audit is evidence about *displayed* Woo product balances, not a
// sale/reservation gate. Never derive a checkout authorization from issueCounts.
const explanations = {
  not_live_woo_catalogue: 'This is not an authenticated WooCommerce catalogue.',
  incomplete_catalogue: 'Some product or variation pages may be missing.',
  stale_or_unverified_snapshot: 'The latest Woo refresh is stale, failed or unverified.',
  unsupported_woo_product_types: 'Woo products with unsupported types were excluded.',
  unsupported_product_type: 'An unsupported product type is present.',
  duplicate_or_invalid_product_identity: 'A product ID is missing or repeated.',
  missing_variations: 'A variable product has no verified size or colour options.',
  invalid_variation_identity: 'A variation has an invalid ID.',
  duplicate_variation_identity: 'A variation identity is repeated.',
  untracked_stock: 'Woo does not manage stock for this selectable product/option.',
  unknown_or_conflicting_stock_owner: 'Woo stock ownership is unknown or contradictory.',
  backorders_enabled: 'Backorders are allowed and need a separate stock policy.',
  missing_or_invalid_stock_quantity: 'A managed stock quantity is missing or invalid.',
  parent_stock_quantity_conflict: 'A size disagrees with its shared parent stock balance.',
  stock_status_quantity_conflict: 'Woo says in stock while the quantity is zero.',
  shared_stock_pool_disagrees: 'Options using one stock owner disagree on its balance.',
};
const labelFor = code => explanations[code] || code.replaceAll('_', ' ');

export default function StockSafety({ active }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    setResult(null); // Never show previous observations as a fresh audit.
    try {
      const response = await api('/stock-safety/audit');
      if (response?.kind !== 'read-only-shared-woo-stock-audit' ||
          response.auditOnly !== true || response.checkoutAuthorized !== false ||
          response.sharedLastUnitGuardVerified !== false ||
          !response.catalogue || !response.issueCounts || !Array.isArray(response.examples)) {
        throw new Error('Unexpected stock audit response. Do not use it for checkout decisions.');
      }
      setResult(response);
    } catch (failure) {
      setError(failure?.message || 'The Woo stock audit could not be verified.');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { if (active) void load(); }, [active, load]);
  const issues = result ? Object.entries(result.issueCounts).filter(([, count]) => count > 0) : [];
  return <div className="sales-page">
    <PageHeading eyebrow="Inventory / shared Woo stock" title="Stock safety review"
      description="Owner and Manager review of WooCommerce product and variation balances. This is evidence, not permission to trade.">
      <button type="button" className="button secondary" disabled={busy} onClick={load}>
        <RefreshCw size={16} className={busy ? 'spin' : ''} />{busy ? 'Checking Woo products…' : 'Refresh stock audit'}
      </button>
    </PageHeading>
    <Notice tone="warning"><LockKeyhole size={16} /> <strong>Checkout remains locked.</strong> Even an audit with zero findings cannot verify simultaneous website/POS last-unit reservations, Paystack callbacks, pending orders or physical cash. Do not take payment or release goods based on this screen.</Notice>
    {error && <Notice tone="error"><AlertTriangle size={16} />{error} Refresh the catalogue and review the WooCommerce connection before using stock figures.</Notice>}
    {busy && <p role="status" className="field-hint">Reading published Woo products and variations. No order or stock write is being sent.</p>}
    {result && !busy && <React.Fragment>
      <section className="surface records-surface" aria-label="Woo stock audit summary">
        <div className="section-heading"><div><span className="eyebrow">Read-only snapshot</span><h2>Stock ownership evidence</h2><p>Last product refresh: {dateTime(result.catalogue.fetchedAt)} · Woo catalogue {result.catalogue.complete ? 'complete' : 'incomplete'}</p></div><Badge tone="amber"><ShieldCheck size={14}/> Not approved for checkout</Badge></div>
        <div className="overview-metrics">
          <div className="overview-metric"><span className="eyebrow">Woo products inspected</span><strong>{result.catalogue.products}</strong><small>Published catalogue snapshot</small></div>
          <div className="overview-metric"><span className="eyebrow">Selectable options</span><strong>{result.catalogue.selectableOptions}</strong><small>Not independent stock units</small></div>
          <div className="overview-metric"><span className="eyebrow">Tracked stock pools</span><strong>{result.catalogue.managedStockPools}</strong><small>Shared variation owners counted once</small></div>
          <div className="overview-metric"><span className="eyebrow">Review flags</span><strong>{issues.reduce((sum, [, count]) => sum + count, 0)}</strong><small>{issues.length} distinct issue types</small></div>
        </div>
        <p className="field-hint"><Boxes size={14} /> {result.catalogue.sharedParentOrVariationPools} tracked stock pools are shared by multiple size/colour options. The quantity belongs to the owner, not to every variation separately.</p>
      </section>
      <section className="surface records-surface" aria-label="Stock audit findings">
        <div className="section-heading"><div><span className="eyebrow">Owner / Manager evidence</span><h2>Issues needing review</h2></div></div>
        {issues.length === 0 ? <Notice tone="warning">No snapshot consistency issue was detected. This does <strong>not</strong> prove safe checkout, reservation expiry or late online payments.</Notice> :
          <TableRegion label="Stock safety issues"><table className="responsive-table"><thead><tr><th>Issue</th><th className="right">Observations</th></tr></thead><tbody>
            {issues.map(([code, count]) => <tr key={code}><td data-label="Issue">{labelFor(code)}</td><td className="right" data-label="Observations"><strong>{count}</strong></td></tr>)}
          </tbody></table></TableRegion>}
        {result.examples.length > 0 && <div className="section-heading"><div><span className="eyebrow">Sample identifiers</span><p>Up to 20 examples. Review affected products in WooCommerce before deciding what to correct.</p></div><ul className="field-hint">{result.examples.map((entry, index) =>
          <li key={index}>{labelFor(entry.code)} · Product #{entry.productId ?? 'unknown'}{entry.variationId ? ` / Variation #${entry.variationId}` : ''}</li>)}</ul></div>}
      </section>
      <p className="report-scope">Read-only product data only. This audit did not create an order, collect cash, approve a refund, reserve stock, change website quantities or authorize checkout.</p>
    </React.Fragment>}
  </div>;
}
