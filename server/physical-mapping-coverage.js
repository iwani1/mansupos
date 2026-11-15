import { createHash } from 'node:crypto';
import { auditCrossChannelSkus } from './cross-channel-sku-audit.js';

// This is an identity review workbench, NOT an inventory importer. A matching
// code cannot prove colour/size identity, physically counted stock or checkout.
const statuses = new Set([
  'all', 'provisional_match', 'held', 'missing_physical_sku',
  'duplicate_physical_sku', 'parent_sku_only',
  'missing_on_website', 'ambiguous_website_identity',
]);
const normalize = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const validId = value => Number.isSafeInteger(value) && value > 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A trusted internal caller may collect the full derived review rows in one pass.
// Never send the collector to the client; public API responses remain paged.
export function listPhysicalMappingCoverage(physical, woo, options = {}, clock = Date.now(), collectRows = null) {
  const { page = 1, pageSize = 25, status = 'all', search = '' } = options;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50 ||
      !statuses.has(status) || typeof search !== 'string' || search.length > 64) {
    throw new RangeError('Invalid physical product mapping request.');
  }

  const source = Array.isArray(physical?.items) ? physical.items : [];
  const products = Array.isArray(woo?.products) ? woo.products : [];
  // The preceding verifier checks the pinned historical source identity and
  // freshness/completeness of the Woo snapshot; it never authorizes trading.
  const audit = auditCrossChannelSkus(physical, woo, clock);
  const physicalCodes = new Map();
  for (const item of source) {
    const sku = normalize(item?.sku);
    if (sku) physicalCodes.set(sku, (physicalCodes.get(sku) || 0) + 1);
  }

  const optionsBySku = new Map();
  const websiteIdentityCounts = new Map();
  const parentOnly = new Set();
  const append = (sku, productId, variationId) => {
    const key = normalize(sku);
    if (!key) return;
    const identity = validId(productId) && (variationId == null || validId(variationId))
      ? String(productId) + ':' + String(variationId || 0) : null;
    if (identity) websiteIdentityCounts.set(identity, (websiteIdentityCounts.get(identity) || 0) + 1);
    if (!optionsBySku.has(key)) optionsBySku.set(key, []);
    optionsBySku.get(key).push({
      productId: validId(productId) ? productId : null,
      variationId: validId(variationId) ? variationId : null,
      identity,
    });
  };
  for (const product of products) {
    if (product?.type === 'simple') {
      append(product.sku, product.id, null);
    } else if (product?.type === 'variable') {
      if (normalize(product.sku)) parentOnly.add(normalize(product.sku));
      for (const variation of Array.isArray(product.variations) ? product.variations : []) {
        // A variable parent SKU cannot substitute for an actual variation SKU.
        append(variation?.sku, product.id, validId(variation?.id) ? variation.id : -1);
      }
    }
  }

  const counts = Object.fromEntries([...statuses].filter(x => x !== 'all').map(x => [x, 0]));
  const rows = source.map((item, index) => {
    const sku = normalize(item?.sku);
    const candidates = sku ? optionsBySku.get(sku) || [] : [];
    let state;
    if (item?.status === 'review') state = 'held';
    else if (!sku) state = 'missing_physical_sku';
    else if (physicalCodes.get(sku) !== 1) state = 'duplicate_physical_sku';
    else if (candidates.length > 1) state = 'ambiguous_website_identity';
    else if (candidates.length === 1 && (!candidates[0].identity ||
        websiteIdentityCounts.get(candidates[0].identity) !== 1)) state = 'ambiguous_website_identity';
    else if (candidates.length === 1 && parentOnly.has(sku)) state = 'ambiguous_website_identity';
    else if (candidates.length === 1) state = 'provisional_match';
    else if (parentOnly.has(sku)) state = 'parent_sku_only';
    else state = 'missing_on_website';
    counts[state]++;

    // Report-row and product/variation IDs can help locate a record, but are
    // never approved mappings. Names, quantities and prices remain private.
    const row = {
      reportRow: Number.isSafeInteger(item?.reportRow) && item.reportRow > 0
        ? item.reportRow : index + 1,
      sku: sku.slice(0, 64),
      status: state,
      websiteCandidates: candidates.length,
      productId: state === 'provisional_match' ? candidates[0].productId : null,
      variationId: state === 'provisional_match' ? candidates[0].variationId : null,
    };
    return row;
  });

  if (Array.isArray(collectRows)) collectRows.push(...rows);

  const snapshotRef = hash({
    physicalManifestSha256: physical?.manifestHash || null,
    wooFetchedAt: woo?.fetchedAt || null,
    rows,
  });
  const needle = normalize(search);
  const filtered = rows.filter(item => (status === 'all' || item.status === status) &&
    (!needle || item.sku.includes(needle) ||
      String(item.reportRow).includes(needle) ||
      String(item.productId ?? '').includes(needle) ||
      String(item.variationId ?? '').includes(needle)));
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return {
    kind: 'read-only-physical-mapping-coverage',
    auditOnly: true,
    checkoutAuthorized: false,
    sharedStockVerified: false,
    mappingApproved: false,
    evidenceVerified: audit.evidenceVerified,
    physicalManifestSha256: audit.physical.manifestSha256,
    websiteFetchedAt: audit.website.fetchedAt,
    totalPhysical: source.length,
    counts,
    snapshotRef,
    page, pageSize, pages, total,
    hasMore: page < pages,
    filter: { status, search },
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    notice: 'Provisional SKU identities only. No physical recount, true colour/size mapping, Woo inventory synchronization, order, payment or checkout was verified or changed.',
  };
}
