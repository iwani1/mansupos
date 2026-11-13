import React, { useEffect, useState } from 'react';
import { RefreshCw, Search, Users } from 'lucide-react';
import { api, dateTime } from './api.js';
import { Empty, Notice, PageHeading, Spinner, TableRegion } from './components.jsx';

// Only the existing named wholesale-buyer directory is available to the POS.
// WooCommerce customer contact records are not fetched or imitated here.
export default function Customers({ refreshKey }) {
  const [buyers, setBuyers] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let current = true;
    api('/wholesale-buyers')
      .then(result => { if (current) { setBuyers(result.buyers); setError(''); } })
      .catch(problem => { if (current) { setBuyers(null); setError(problem.message); } });
    return () => { current = false; };
  }, [refreshKey, reload]);
  const filtered = (buyers || []).filter(buyer => buyer.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="customers-page"><PageHeading eyebrow="Relationships / named buyers" title="Customers" description="The existing named wholesale-buyer directory in this POS. Walk-in customers are not stored as profiles, and WooCommerce customer contact details are not synced.">
    <button className="button secondary" onClick={() => setReload(value => value + 1)}><RefreshCw size={16} />Refresh directory</button>
  </PageHeading>
    <Notice>Buyer names are private POS records for approved wholesale use. Phone numbers, addresses, purchase totals and online customer profiles are not available in this application; they are not inferred from sales.</Notice>
    {error && <Notice tone="error">Could not load buyers: {error}</Notice>}
    {buyers === null && !error ? <Spinner label="Loading named buyers…" /> : buyers && <section className="surface records-surface"><div className="section-heading"><div><span className="eyebrow">Private directory</span><h2>Named wholesale buyers</h2><p>Names already recorded in the POS ledger.</p></div><span className="records-count">{filtered.length} shown</span></div><div className="table-toolbar"><label className="search-field compact"><Search size={18} aria-hidden="true" /><input aria-label="Search named buyers" placeholder="Search by name" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      {filtered.length ? <TableRegion label="Named wholesale buyers"><table className="responsive-table customers-table"><thead><tr><th>Buyer</th><th>Record type</th><th>Added to this POS</th></tr></thead><tbody>{filtered.map(buyer => <tr key={buyer.id}><td data-label="Buyer"><strong className="table-primary">{buyer.name}</strong></td><td data-label="Record type">Named wholesale buyer</td><td data-label="Added to this POS">{dateTime(buyer.createdAt)}</td></tr>)}</tbody></table></TableRegion> : <Empty icon={Users} title={query ? 'No matching buyers' : 'No named buyers saved'} action={query && <button className="button secondary" onClick={() => setQuery('')}>Clear search</button>}>{query ? 'Try another name.' : 'Wholesale orders can still have an optional buyer name without creating a customer account.'}</Empty>}
      <div className="table-footer">{filtered.length} loaded records <span>No online customer data is shown.</span></div></section>}
  </div>;
}
