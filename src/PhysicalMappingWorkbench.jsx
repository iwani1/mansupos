import React, { useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, LockKeyhole, Search } from 'lucide-react';
import { api, dateTime } from './api.js';
import { Notice, TableRegion } from './components.jsx';

const labels = {
  all: 'All historical physical records',
  provisional_match: 'Potential exact SKU matches',
  missing_on_website: 'Not found in published Woo catalogue',
  held: 'Quarantined: owner review required',
  missing_physical_sku: 'Physical product missing SKU',
  duplicate_physical_sku: 'Physical product has duplicate SKU',
  parent_sku_only: 'Only a Woo variable parent SKU matches',
  ambiguous_website_identity: 'Ambiguous Woo SKU or product identity',
};

const count = (counts, key) => Number.isSafeInteger(counts?.[key]) ? counts[key] : 0;

// Product identity review only. This screen never confirms live balances or
// makes stock-changing requests, even when every SKU has a candidate.
export default function PhysicalMappingWorkbench() {
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const reset = () => { setResult(null); setError(''); };

  const load = async (page = 1, expectedRef = '') => {
    setLoading(true);
    setResult(null); // Never present an earlier observation as current.
    setError('');
    try {
      const query = new URLSearchParams({
        page: String(page), pageSize: '25', status, search: search.trim(),
      });
      if (expectedRef) query.set('expectedRef', expectedRef);
      const data = await api('/stock-safety/physical-mapping?' + query.toString());
      if (data?.kind !== 'read-only-physical-mapping-coverage' ||
          data.auditOnly !== true || data.checkoutAuthorized !== false ||
          data.sharedStockVerified !== false || data.mappingApproved !== false ||
          !/^[a-f0-9]{64}$/.test(data.snapshotRef || '') ||
          !Array.isArray(data.rows) || data.rows.length > 25 ||
          !Number.isSafeInteger(data.total) || !Number.isSafeInteger(data.totalPhysical) ||
          !Number.isSafeInteger(data.page) || !Number.isSafeInteger(data.pages) ||
          !data.counts || typeof data.counts !== 'object') {
        throw new Error('The mapping report could not be verified. Do not use these rows to sell stock.');
      }
      setResult(data);
    } catch (failure) {
      setError(failure?.message || 'Unable to open product identity review.');
    } finally {
      setLoading(false);
    }
  };

  return <section className="surface records-surface" aria-label="Physical product mapping workbench">
    <div className="section-heading">
      <div>
        <span className="eyebrow">Pre-launch inventory preparation</span>
        <h3>Physical product mapping workbench</h3>
        <p>Review each historical physical product against published WooCommerce
          SKU identities, including potential matches and items needing investigation.</p>
      </div>
    </div>
    <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'end'}}>
      <label style={{flex:'1 1 200px'}}>Mapping classification
        <select className="input" aria-label="Filter physical mapping status"
          value={status} disabled={loading} onChange={event=>{setStatus(event.target.value);reset();}}>
          {Object.entries(labels).map(([key,value])=>
            <option key={key} value={key}>{value}</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 200px'}}>Historical SKU, report row, or Woo ID
        <input className="input" type="search" aria-label="Search physical mapping"
          maxLength={64} placeholder="Search product code or row" value={search}
          disabled={loading} onChange={event=>{setSearch(event.target.value);reset();}}/>
      </label>
      <button type="button" className="button secondary" disabled={loading}
        onClick={()=>load(1)}><Search size={16}/>{loading?'Checking…':'Open mapping review'}</button>
    </div>
    {loading && <p role="status" className="field-hint">Checking only signed physical-source records and Woo product identities. No orders or stock updates.</p>}
    {error && <Notice tone="warning"><AlertTriangle size={16}/>{error} Restart from the first page if the catalogue changed.</Notice>}
    {result && !loading && <>
      {!result.evidenceVerified && <Notice tone="error">Physical or WooCommerce source evidence is incomplete, stale or unverified. Treat all links as provisional.</Notice>}
      <Notice tone="warning"><LockKeyhole size={16}/>
        <strong>Potential match does not mean approved.</strong> Verify styles, colours,
        sizes and a fresh physical count before proposing any shared-stock import.
      </Notice>
      <div className="overview-metrics">
        <div className="overview-metric"><span className="eyebrow">Physical source rows</span>
          <strong>{result.totalPhysical}</strong><small>Historical export only</small></div>
        <div className="overview-metric"><span className="eyebrow">Potential SKU matches</span>
          <strong>{count(result.counts,'provisional_match')}</strong><small>Not owner-verified mappings</small></div>
        <div className="overview-metric"><span className="eyebrow">Not on published website</span>
          <strong>{count(result.counts,'missing_on_website')}</strong><small>May need Woo identity or a new product</small></div>
        <div className="overview-metric"><span className="eyebrow">Quarantined physical records</span>
          <strong>{count(result.counts,'held')}</strong><small>Do not import or sell</small></div>
      </div>
      <p className="field-hint">
        {result.total} records for the selected filter · Page {result.page} of {result.pages} ·
        Website catalogue observed {dateTime(result.websiteFetchedAt)}.
      </p>
      {result.rows.length > 0 ?
        <TableRegion label="Historical product mapping candidates">
          <table className="responsive-table"><thead><tr>
            <th>Source row</th><th>SKU</th><th>Mapping classification</th><th>Potential Woo identity</th>
          </tr></thead><tbody>
          {result.rows.map((item,index)=><tr key={result.page+'-'+index}>
            <td data-label="Source row">{item.reportRow}</td>
            <td data-label="SKU">{item.sku || 'Missing code'}</td>
            <td data-label="Mapping classification">{labels[item.status] || 'Needs review'}</td>
            <td data-label="Potential Woo identity">
              {item.productId ? '#'+item.productId+(item.variationId?' / variation #'+item.variationId:'') : 'Not established'}
            </td>
          </tr>)}
          </tbody></table>
        </TableRegion> :
        <p className="field-hint">No source rows match this filter. This is not a stock-safety clearance.</p>}
      <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:12}}>
        <button type="button" className="button secondary"
          disabled={loading || result.page<=1}
          onClick={()=>load(result.page-1,result.snapshotRef)}>
          <ChevronLeft size={16}/>Previous
        </button>
        <button type="button" className="button secondary"
          disabled={loading || !result.hasMore}
          onClick={()=>load(result.page+1,result.snapshotRef)}>
          Next<ChevronRight size={16}/>
        </button>
      </div>
      <p className="report-scope">
        This feature cannot change Woo products, assign stock, approve mappings,
        create orders, collect payment or enable POS checkout.
        Results are snapshot-bound; changed evidence requires restarting on page one.
      </p>
    </>}
  </section>;
}
