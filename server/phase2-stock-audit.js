// Phase 2 inventory evidence only. A catalogue snapshot cannot reserve stock or
// certify that an online checkout and a POS sale cannot claim the same last unit.
// No Woo order, stock or payment request is made by this module.
const MAX_EXAMPLES = 20;
const validId = id => Number.isSafeInteger(id) && id > 0;
const validStock = value => Number.isSafeInteger(value) && value >= 0;
const backorders = item => item?.backordersAllowed === true ||
  ['yes', 'notify'].includes(item?.backorders);

export function auditSharedWooStock(snapshot, clock = Date.now()) {
  const issueCounts = {};
  const examples = [];
  const flag = (code, productId = null, variationId = null) => {
    issueCounts[code] = (issueCounts[code] || 0) + 1;
    if (examples.length < MAX_EXAMPLES) examples.push({ code, productId, variationId });
  };
  const products = Array.isArray(snapshot?.products) ? snapshot.products : [];
  const fetched = Date.parse(snapshot?.fetchedAt || '');
  if (snapshot?.source !== 'woocommerce' || snapshot?.isDemo === true) flag('not_live_woo_catalogue');
  if (snapshot?.complete !== true || !Array.isArray(snapshot?.products)) flag('incomplete_catalogue');
  if (snapshot?.stale === true || snapshot?.error || !Number.isFinite(fetched) ||
      fetched > clock + 30000 || clock - fetched > 120000) flag('stale_or_unverified_snapshot');
  if (Number.isSafeInteger(snapshot?.unsupported) && snapshot.unsupported > 0) flag('unsupported_woo_product_types');

  const seenProducts = new Set();
  const seenOptions = new Set();
  const pools = new Map();
  let selectableOptions = 0;
  let unavailableOptions = 0;
  for (const product of products) {
    if (!product || !validId(product.id) || seenProducts.has(product.id)) {
      flag('duplicate_or_invalid_product_identity', product?.id ?? null);
      continue;
    }
    seenProducts.add(product.id);
    if (!['simple', 'variable'].includes(product.type)) {
      flag('unsupported_product_type', product.id);
      continue;
    }
    if (product.type === 'variable' && (!Array.isArray(product.variations) || !product.variations.length)) {
      flag('missing_variations', product.id);
      continue;
    }
    const options = product.type === 'variable'
      ? product.variations : [{ ...product, id: 0 }];
    for (const option of options) {
      const variationId = product.type === 'variable' ? option?.id : 0;
      if (product.type === 'variable' && !validId(variationId)) {
        flag('invalid_variation_identity', product.id, variationId ?? null);
        continue;
      }
      const key = `${product.id}:${variationId}`;
      if (seenOptions.has(key)) {
        flag('duplicate_variation_identity', product.id, variationId);
        continue;
      }
      seenOptions.add(key);
      if (!option?.purchasable || (product.type === 'simple' && !product.purchasable)) {
        unavailableOptions++;
        continue;
      }
      selectableOptions++;
      const source = option.stockSource;
      const ownerId = source === 'parent' || source === 'product'
        ? product.id : source === 'variation' ? variationId : null;
      const permittedSource = product.type === 'simple' ? source === 'product'
        : source === 'parent' || source === 'variation';
      if (!permittedSource || !option.manageStock || !validId(ownerId) ||
          (source === 'parent' && !product.manageStock)) {
        flag(source === 'untracked' ? 'untracked_stock' : 'unknown_or_conflicting_stock_owner', product.id, variationId);
        continue;
      }
      if (backorders(option) || (source === 'parent' && backorders(product))) {
        flag('backorders_enabled', product.id, variationId);
      }
      if (!validStock(option.stock)) {
        flag('missing_or_invalid_stock_quantity', product.id, variationId);
        continue;
      }
      if (source === 'parent' && (option.stock !== product.stock || product.stockSource !== 'product')) {
        flag('parent_stock_quantity_conflict', product.id, variationId);
      }
      if (option.stockStatus === 'instock' && option.stock === 0) {
        flag('stock_status_quantity_conflict', product.id, variationId);
      }
      const pool = pools.get(ownerId);
      if (pool && pool.quantity !== option.stock) {
        flag('shared_stock_pool_disagrees', product.id, variationId);
      } else if (!pool) {
        pools.set(ownerId, { quantity: option.stock, options: 0 });
      }
      pools.get(ownerId).options++;
    }
  }
  const sharedPools = [...pools.values()].filter(pool => pool.options > 1).length;
  return {
    kind: 'read-only-shared-woo-stock-audit',
    auditOnly: true,
    checkoutAuthorized: false,
    sharedLastUnitGuardVerified: false,
    requiresOwnerOrManagerReview: true,
    // Counts are evidence about a Woo catalogue snapshot, not reserved stock.
    catalogue: {
      source: snapshot?.source || 'unknown',
      fetchedAt: snapshot?.fetchedAt || null,
      complete: snapshot?.complete === true,
      stale: snapshot?.stale === true || Boolean(snapshot?.error),
      products: products.length,
      selectableOptions,
      unavailableOptions,
      managedStockPools: pools.size,
      sharedParentOrVariationPools: sharedPools,
    },
    issueCounts,
    examples,
    limitations: [
      'Catalogue stock is not an atomic reservation and cannot authorize checkout.',
      'Woo checkout, Paystack callbacks, plugin hooks and pending-order expiry remain unverified.',
      'No stock adjustment, Woo order, refund, approval or physical cash payout was performed.',
    ],
  };
}
