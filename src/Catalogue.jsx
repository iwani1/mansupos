import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Download, ExternalLink, LayoutGrid, Package, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import { money } from './api.js';
import { categoryGroups } from './catalog-insights.js';
import { hasKnownStock, onBackorder, stockUnknown } from './stock.js';
import { Badge, Empty, Modal, Notice, PageHeading, ProductImage, TableRegion } from './components.jsx';

const PAGE_SIZE = 12;
const sourceLabel = source => source === 'parent' ? 'Shared parent pool' : source === 'variation' ? 'This option' : source === 'product' ? 'This product' : source === 'untracked' ? 'Untracked' : 'Not confirmed';

function availability(line, requireSource, stockStale = false) {
  if (stockStale) return { label: 'Stock not verified', tone: 'neutral' };
  if (line.stockStatus === 'outofstock') return { label: 'Out of stock', tone: 'red' };
  if (stockUnknown(line, requireSource)) return { label: 'Stock unavailable', tone: 'neutral' };
  if (onBackorder(line)) return { label: 'Backorder', tone: 'amber' };
  if (!line.manageStock) return { label: 'Untracked', tone: 'neutral' };
  if (!hasKnownStock(line)) return { label: 'Stock unavailable', tone: 'neutral' };
  return { label: `${line.stock} available`, tone: line.stock <= 5 ? 'amber' : 'green' };
}

function csvCell(value) {
  // eslint-disable-next-line no-control-regex -- CSV formula and control-character hardening.
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const safe = /^[\s]*[=+@\-\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function exportCatalogue(products, notify, requireSource, catalog, isDemo) {
  const stockVerified = !catalog?.stale && !catalog?.error && (!requireSource || catalog?.complete === true);
  const rows = [['Workspace', 'Product', 'Option', 'SKU', 'Category', 'Retail price GHS', 'Stock units', 'Stock source'],
    ...products.flatMap(product => (product.type === 'variable' ? product.variations : [product]).map(line => [
      isDemo ? 'Demo only' : 'WooCommerce snapshot', product.name, line === product ? '' : line.label, line.sku, product.category,
      ((line.price ?? product.price) / 100).toFixed(2), stockVerified && line.manageStock && !stockUnknown(line, requireSource) && hasKnownStock(line) ? line.stock : '', sourceLabel(line.stockSource),
    ]))];
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `mansu-${isDemo ? 'demo-' : ''}catalogue-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(isDemo ? 'Demo catalogue downloaded. These are practice products and stock, not a live store export.'
    : stockVerified ? 'Loaded catalogue snapshot downloaded. Stock is a snapshot, not a recount.'
      : 'Loaded catalogue downloaded without unverified stock figures. Refresh and verify before trading.');
}

export function ProductsPage({ catalog, config, category, onCategoryChange, refresh, notify, onNavigate }) {
  const products = useMemo(() => catalog?.products || [], [catalog]);
  const categories = useMemo(() => categoryGroups(products), [products]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  useEffect(() => setPage(1), [search, sort, category]);
  const filtered = useMemo(() => products.filter(product => {
    const text = `${product.name} ${product.sku} ${(product.variations || []).map(v => `${v.sku} ${v.label}`).join(' ')}`.toLowerCase();
    return (!search.trim() || text.includes(search.trim().toLowerCase())) && (category === 'All products' || product.category === category || product.categories?.includes(category));
  }).sort((a, b) => sort === 'price-low' ? a.price - b.price || a.name.localeCompare(b.name)
    : sort === 'price-high' ? b.price - a.price || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name)), [products, search, category, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const requireSource = config.mode !== 'demo';
  const stockStale = Boolean(catalog?.stale || catalog?.error);
  return <div className="catalogue-page">
    <PageHeading eyebrow="The collection / WooCommerce" title="Products" description="The published online catalogue and its product options. Product editing stays in WooCommerce; this POS does not change website listings.">
      <button className="button secondary" onClick={() => refresh(true)}><RefreshCw size={16} />Refresh catalogue</button>
      <button className="button secondary" onClick={() => exportCatalogue(filtered, notify, requireSource, catalog, config.mode === 'demo')} disabled={!filtered.length}><Download size={16} />Export shown</button>
    </PageHeading>
    {catalog?.stale && <Notice tone="warning">This is a cached snapshot. Stock is not verified; refresh before relying on prices or quantities.</Notice>}
    {catalog?.error && !catalog.stale && <Notice tone="warning">Catalogue stock could not be verified: {catalog.error}</Notice>}
    {requireSource && catalog?.complete === false && <Notice tone="warning">Some WooCommerce product or option pages were not loaded. Counts below cover only the visible catalogue; refresh or review the website before relying on them.</Notice>}
    {requireSource && catalog?.unsupported > 0 && <Notice tone="warning">{catalog.unsupported} unsupported online {catalog.unsupported === 1 ? 'product type is' : 'product types are'} not shown in this POS directory.</Notice>}
    <div className="catalogue-strip"><div><span>Loaded products</span><strong>{products.length}</strong></div><div><span>Loaded categories</span><strong>{categories.length}</strong></div><div><span>Loaded options</span><strong>{products.reduce((total, product) => total + (product.variations?.length || 0), 0)}</strong></div><p>{config.mode === 'demo' ? 'Sample catalogue and illustrative images; no website edits.' : 'Product, price and stock edits are owned by WooCommerce.'}</p></div>
    <section className="surface records-surface"><div className="section-heading"><div><span className="eyebrow">Product directory</span><h2>Catalogue</h2><p>Search a style or SKU; open a product to inspect its options.</p></div><span className="records-count">{filtered.length} {filtered.length === 1 ? 'style' : 'styles'}</span></div>
      <div className="table-toolbar"><label className="search-field compact"><Search size={18} aria-hidden="true" /><input aria-label="Search products" placeholder="Search a product, option or SKU" value={search} onChange={event => setSearch(event.target.value)} /></label><label className="select-label"><span>Category</span><select className="select" aria-label="Filter product category" value={category} onChange={event => onCategoryChange(event.target.value)}><option>All products</option>{categories.map(group => <option key={group.name}>{group.name}</option>)}</select></label><label className="select-label"><SlidersHorizontal size={16} aria-hidden="true" /><select className="select" aria-label="Sort products" value={sort} onChange={event => setSort(event.target.value)}><option value="name">Name A–Z</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option></select></label></div>
      {visible.length ? <TableRegion label="Published product catalogue"><table className="responsive-table catalogue-table"><thead><tr><th>Style</th><th>Category</th><th>SKU</th><th>Options</th><th>Availability</th><th className="right">Retail price</th></tr></thead><tbody>{visible.map(product => {
        const state = product.type === 'variable' && !stockStale
          ? product.stockStatus === 'outofstock' ? { label: 'Out of stock', tone: 'red' }
            : !product.purchasable || !product.variations.some(line => line.purchasable && line.stockStatus !== 'outofstock')
              ? { label: 'No available options', tone: 'neutral' } : { label: 'See options', tone: 'neutral' }
          : availability(product, requireSource, stockStale);
        return <tr key={product.id}><td data-label="Style"><div className="table-product"><ProductImage src={product.image} name={product.name} /><div><button className="product-name-button" onClick={() => setDetail(product)}>{product.name}</button><small>{config.mode === 'demo' ? 'Demo catalogue' : 'Published online'}</small></div></div></td><td data-label="Category">{product.category || 'Uncategorized'}</td><td data-label="SKU"><span className="sku-cell">{product.sku || 'No parent SKU'}</span></td><td data-label="Options">{product.type === 'variable' ? `${product.variations.length} options` : 'Single style'}</td><td data-label="Availability"><Badge dot tone={state.tone}>{state.label}</Badge></td><td data-label="Retail price" className="right"><strong>{product.type === 'variable' ? 'From ' : ''}{money(product.price)}</strong></td></tr>;
      })}</tbody></table></TableRegion> : <Empty icon={Package} title={products.length ? 'No matching styles' : 'No products loaded'} action={products.length && <button className="button secondary" onClick={() => { setSearch(''); onCategoryChange('All products'); }}>Clear filters</button>}>{products.length ? 'Try another name, SKU or category.' : 'Refresh the catalogue to see the online collection.'}</Empty>}
      <div className="table-footer"><span>Showing {filtered.length ? (page - 1) * PAGE_SIZE + 1 : 0}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}</span><div className="pagination"><button className="button secondary small" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page} of {pages}</span><button className="button secondary small" disabled={page === pages} onClick={() => setPage(value => value + 1)}>Next</button></div></div></section>
    {config.mode !== 'demo' && !config.liveReadOnly && <p className="catalogue-hint">Private wholesale defaults are managed separately from website prices. <button className="text-button" onClick={() => onNavigate('inventory')}>View inventory <ArrowRight size={14} /></button></p>}
    {detail && <Modal title={detail.name} subtitle={`${detail.category || 'Uncategorized'} · ${detail.sku || 'No parent SKU'}`} onClose={() => setDetail(null)} wide className="product-detail-modal"><div className="modal-body"><div className="catalogue-detail"><ProductImage src={detail.image} name={detail.name} /><div><span className="eyebrow">{config.mode === 'demo' ? 'Demo listing' : 'Published online listing'}</span><strong>{detail.type === 'variable' ? 'From ' : ''}{money(detail.price)}</strong><p>Retail price from the catalogue. WooCommerce owns product editing, publishing and stock.</p>{detail.permalink && <a className="button secondary small" href={detail.permalink} target="_blank" rel="noreferrer">View on website <ExternalLink size={15} /></a>}</div></div><h3 className="detail-subheading">{detail.type === 'variable' ? 'Product options' : 'Stock information'}</h3><div className="option-list">{(detail.type === 'variable' ? detail.variations : [detail]).map(line => { const state = availability(line, requireSource, stockStale); return <div key={line.id}><div><strong>{line === detail ? 'Standard' : line.label || `Option #${line.id}`}</strong><small>{line.sku || 'No option SKU'} · {sourceLabel(line.stockSource)}</small></div><span>{money(line.price)}</span><Badge tone={state.tone} dot>{state.label}</Badge></div>; })}</div>{detail.type === 'variable' && <p className="field-hint">Options with parent-managed stock share a single pool; counts are not separate units per size.</p>}</div><div className="modal-footer" role="group" aria-label="Product details actions"><button className="button primary" onClick={() => setDetail(null)}>Done</button></div></Modal>}
  </div>;
}

export function CategoriesPage({ catalog, config, onSelect, refresh }) {
  const products = catalog?.products || [];
  const groups = categoryGroups(products);
  return <div className="catalogue-page"><PageHeading eyebrow="The collection / organisation" title="Categories" description="Browse real categories from the current product catalogue. Selecting one filters the product directory."><button className="button secondary" onClick={() => refresh(true)}><RefreshCw size={16} />Refresh catalogue</button></PageHeading>
    {catalog?.stale && <Notice tone="warning">This category directory uses cached catalogue data. Refresh for the latest listing.</Notice>}
    {catalog?.error && !catalog.stale && <Notice tone="warning">The catalogue could not be verified: {catalog.error}</Notice>}
    {config.mode !== 'demo' && catalog?.complete === false && <Notice tone="warning">This category view covers loaded WooCommerce products only; some product or option pages were not loaded.</Notice>}
    {config.mode !== 'demo' && catalog?.unsupported > 0 && <Notice tone="warning">Unsupported online product types are not included in these category counts.</Notice>}
    <div className="category-overview"><div><span className="eyebrow">Category directory</span><h2>How the collection is organised</h2><p>Categories are set in WooCommerce, not edited in the POS.</p></div><strong>{groups.length} {groups.length === 1 ? 'category' : 'categories'}</strong></div>
    {groups.length ? <div className="category-grid">{groups.map((group, index) => <button className="category-tile" key={group.name} onClick={() => onSelect(group.name)}><span className="category-number">{String(index + 1).padStart(2, '0')}</span><ProductImage src={group.image} name={group.name} /><span className="category-tile-detail"><span><strong>{group.name}</strong><small>{group.count} {group.count === 1 ? 'style' : 'styles'} · {config.mode === 'demo' ? 'demo catalogue' : 'published products'}</small></span><ArrowRight size={18} aria-hidden="true" /></span></button>)}</div> : <Empty icon={LayoutGrid} title="No categories loaded">Refresh the catalogue to browse your collection.</Empty>}
  </div>;
}
