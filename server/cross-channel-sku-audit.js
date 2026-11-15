// Read-only identity coverage between a signed physical stock export and a
// WooCommerce published-product snapshot. A matching SKU is NOT evidence that
// both channels share one real-time stock balance, and never permits checkout.
const LIMIT = 20;
const norm = sku => typeof sku === 'string' ? sku.trim().toUpperCase() : '';
const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;

export function auditCrossChannelSkus(physical, woo, clock = Date.now()) {
  const items = Array.isArray(physical?.items) ? physical.items : [];
  const products = Array.isArray(woo?.products) ? woo.products : [];
  const stamp = Date.parse(woo?.fetchedAt || '');
  const physicalVerified = physical?.source === 'in-store-physical-stock-snapshot' &&
    /^[0-9a-f]{64}$/i.test(physical?.manifestHash || '') &&
    physical?.summary?.items === items.length;
  const wooVerified = woo?.source === 'woocommerce' && woo?.complete === true &&
    woo?.isDemo !== true && woo?.stale !== true && !woo?.error &&
    Number.isFinite(stamp) && stamp <= clock + 30000 && clock - stamp <= 120000;
  const cases = [];
  const issueCounts = {};
  const flag = (code, sku = '', productId = null, variationId = null) => {
    issueCounts[code] = (issueCounts[code] || 0) + 1;
    // Keep examples actionable when the source has many quarantined rows:
    // allow up to two per issue code so early bulk flags cannot hide unmapped SKUs.
    if (cases.length < LIMIT && cases.filter(entry => entry.code === code).length < 2) cases.push({
      code, sku: String(sku).slice(0, 64), productId, variationId,
    });
  };
  if (!physicalVerified) flag('physical_snapshot_unverified');
  if (!wooVerified) flag('woo_snapshot_unverified');

  const physicalBySku = new Map();
  let quarantined = 0, eligible = 0;
  for (const item of items) {
    if (item?.status === 'review') {
      quarantined++;
      flag('physical_quarantined', item?.sku || '');
      continue;
    }
    eligible++;
    const sku = norm(item?.sku);
    if (!sku) {
      flag('physical_missing_sku');
      continue;
    }
    if (!physicalBySku.has(sku)) physicalBySku.set(sku, []);
    physicalBySku.get(sku).push(item);
  }

  const wooBySku = new Map();
  const appendWoo = (sku, productId, variationId) => {
    const key = norm(sku);
    if (!key) return false;
    if (!wooBySku.has(key)) wooBySku.set(key, []);
    wooBySku.get(key).push({ productId: id(productId), variationId: id(variationId) });
    return true;
  };
  let missingVariationSkus = 0, parentSkusWithoutOption = 0;
  for (const product of products) {
    if (product?.type === 'simple') {
      if (!appendWoo(product.sku, product.id, null)) flag('woo_simple_missing_sku', '', id(product.id));
    } else if (product?.type === 'variable') {
      if (norm(product.sku)) {
        parentSkusWithoutOption++;
        // A parent SKU cannot uniquely identify a size or colour variation.
        flag('woo_parent_sku_requires_variation_mapping', product.sku, id(product.id));
      }
      for (const variation of Array.isArray(product.variations) ? product.variations : []) {
        if (!appendWoo(variation?.sku, product.id, variation?.id)) {
          missingVariationSkus++;
          flag('woo_variation_missing_sku', '', id(product.id), id(variation?.id));
        }
      }
    } else {
      flag('woo_unsupported_product_type', product?.sku || '', id(product?.id));
    }
  }

  let matchedPhysical = 0;
  for (const [sku, rows] of physicalBySku) {
    if (rows.length !== 1) {
      flag('physical_duplicate_sku', sku);
      continue;
    }
    const candidates = wooBySku.get(sku);
    if (!candidates?.length) {
      flag('physical_not_in_published_woo', sku);
    } else if (candidates.length !== 1) {
      flag('ambiguous_woo_sku', sku, candidates[0].productId, candidates[0].variationId);
    } else {
      matchedPhysical++;
    }
  }

  for (const [sku, matches] of wooBySku) {
    if (matches.length > 1) {
      flag('duplicate_woo_sku', sku, matches[0].productId, matches[0].variationId);
    } else if (!physicalBySku.has(sku)) {
      flag('woo_not_in_physical_snapshot', sku, matches[0].productId, matches[0].variationId);
    }
  }

  return {
    kind: 'read-only-cross-channel-sku-audit',
    auditOnly: true, checkoutAuthorized: false, sharedStockVerified: false,
    evidenceVerified: physicalVerified && wooVerified,
    physical: {
      total: items.length, eligible, quarantined,
      manifestSha256: physicalVerified ? physical.manifestHash : null,
      source: 'historical-physical-stock-export',
    },
    website: {
      products: products.length, distinctOptionSkus: wooBySku.size,
      missingVariationSkus, parentSkusWithoutOption,
      fetchedAt: woo?.fetchedAt || null, complete: woo?.complete === true,
    },
    matchedPhysical, issueCounts, examples: cases,
    limitations: [
      'Exact case-insensitive SKU matches are candidates for human mapping, not verified shared inventory.',
      'Physical quantities come from a dated source report and MUST NOT be treated as current Woo stock.',
      'Variable parent SKUs never stand in for size/colour variation identities.',
      'Unpublished Woo products, pending orders, Paystack callbacks and last-unit concurrency are not verified.',
      'No Woo order, stock, payment, POS checkout or stock allocation was changed.',
    ],
  };
}
