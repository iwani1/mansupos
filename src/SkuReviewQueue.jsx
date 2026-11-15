import React, { useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, LockKeyhole, Search } from 'lucide-react';
import { api, dateTime } from './api.js';
import { Notice, TableRegion } from './components.jsx';

// A paged owner/manager investigation aid, NOT a unified-stock allocation.
// Filters and pagination only access the read-only SKU reconciliation endpoint.
export default function SkuReviewQueue({ issueCounts, labelFor }) {
  const [code, setCode] = useState('all');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const clear = () => { setResult(null); setError(''); };
  const load = async (page = 1, expectedRef = '') => {
    setBusy(true);
    setError('');
    setResult(null); // Do not show results from the wrong filter or snapshot.
    try {
      const query = new URLSearchParams({
        page: String(page), pageSize: '25', code, search: search.trim(),
      });
      if (expectedRef) query.set('expectedRef', expectedRef);
      const data = await api('/stock-safety/source-review?' + query.toString());
      if (data?.kind !== 'read-only-cross-channel-sku-review' ||
          data.auditOnly !== true || data.checkoutAuthorized !== false ||
          data.sharedStockVerified !== false ||
          !/^[a-f0-9]{64}$/.test(data.snapshotRef || '') ||
          !Array.isArray(data.findings) || !data.issueCounts ||
          !Number.isSafeInteger(data.total) || !Number.isSafeInteger(data.page) ||
          !Number.isSafeInteger(data.pages) || data.findings.length > 25) {
        throw new Error('Unexpected stock review response. Do not use this for checkout.');
      }
      setResult(data);
    } catch (failure) {
      setError(failure?.message || 'Could not open the SKU review list.');
    } finally {
      setBusy(false);
    }
  };
  const codes = Object.keys(issueCounts || {}).filter(item => issueCounts[item] > 0);
  return <section className="surface records-surface" aria-label="Full SKU reconciliation review">
    <div className="section-heading"><div>
      <span className="eyebrow">Owner / Manager review queue</span>
      <h3>Investigate all product-code discrepancies</h3>
      <p>Filter and page through the complete list, not just the first 20 examples.
        Codes are identification evidence only; they do not synchronize stock.</p>
    </div></div>
    <div style={{display:'flex',flexWrap:'wrap',gap:12,alignItems:'end'}}>
      <label style={{flex:'1 1 210px'}}>Issue category
        <select className="input" aria-label="Filter SKU issues" value={code}
          onChange={event => {setCode(event.target.value);clear();}} disabled={busy}>
          <option value="all">All findings</option>
          {codes.map(item=><option key={item} value={item}>{labelFor(item)} ({issueCounts[item]})</option>)}
        </select>
      </label>
      <label style={{flex:'1 1 210px'}}>SKU, Woo product/variation ID or report row
        <input className="input" type="search" aria-label="Find SKU or identifier"
          placeholder="Enter code or ID" maxLength={64} value={search}
          onChange={event=>{setSearch(event.target.value);clear();}} disabled={busy}/>
      </label>
      <button type="button" className="button secondary" onClick={()=>load(1)}
        disabled={busy}><Search size={16}/>{busy?'Loading…':'Review findings'}</button>
    </div>
    {busy && <p role="status" className="field-hint">Checking identifiers from the verified historical source and Woo product catalogue. No stock writes.</p>}
    {error && <Notice tone="warning"><AlertTriangle size={16}/>{error} Start a new review from page one; older pages may belong to a changed Woo snapshot.</Notice>}
    {result && !busy && <>
      {!result.evidenceVerified && <Notice tone="warning">
        One or both sources are incomplete or unverified. Review these findings as provisional only.
      </Notice>}
      <Notice tone="warning"><LockKeyhole size={16}/>
        Review only. These identifiers are not live stock quantities or authorization to take payments or release goods.
      </Notice>
      <p className="field-hint">
        {result.total} findings for this filter · Page {result.page} of {result.pages} ·
        Woo observation: {dateTime(result.websiteFetchedAt)} ·
        Maximum 25 per page
      </p>
      {result.findings.length > 0 ?
        <TableRegion label="Paginated SKU reconciliation findings">
          <table className="responsive-table"><thead><tr>
            <th>Issue</th><th>SKU</th><th>Website ID</th><th>Physical report row</th>
          </tr></thead><tbody>
          {result.findings.map((item,index)=><tr key={result.page+'-'+index}>
            <td data-label="Issue">{labelFor(item.code)}</td>
            <td data-label="SKU">{item.sku || 'Not recorded'}</td>
            <td data-label="Website ID">{item.productId ? '#'+item.productId+(item.variationId?' / #'+item.variationId:'') : '—'}</td>
            <td data-label="Physical report row">{item.reportRow || '—'}</td>
          </tr>)}
          </tbody></table>
        </TableRegion> :
        <p className="field-hint">No findings match the selected filters. This is not proof of stock readiness.</p>}
      <div style={{display:'flex',gap:10,justifyContent:'flex-end',alignItems:'center',marginTop:12}}>
        <button type="button" className="button secondary"
          disabled={busy || result.page <= 1}
          onClick={()=>load(result.page-1,result.snapshotRef)}>
          <ChevronLeft size={16}/> Previous
        </button>
        <button type="button" className="button secondary"
          disabled={busy || !result.hasMore}
          onClick={()=>load(result.page+1,result.snapshotRef)}>
          Next <ChevronRight size={16}/>
        </button>
      </div>
      <p className="report-scope">If the catalogue changes between pages, the server blocks the old snapshot token. Restart from page one rather than mixing two observations. No customer data, prices, checkout writes or stock adjustments are returned.</p>
    </>}
  </section>;
}
