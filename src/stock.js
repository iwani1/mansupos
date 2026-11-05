// WooCommerce can permit backorders with either policy; an explicit API flag
// takes precedence because store extensions may override the policy.
export const allowsBackorders = line => typeof line?.backordersAllowed === 'boolean' ? line.backordersAllowed : ['yes', 'notify'].includes(line?.backorders);
export const hasKnownStock = line => Number.isFinite(line?.stock);
// Old cached live catalogues can lack stockSource. Never present those rows as
// untracked or sellable; the demo catalogue predates this field by design.
export const ownershipUnknown = (line, requireSource = false) => line?.stockSource === 'unknown' || (requireSource && line?.stockSource == null);
export const stockUnknown = (line, requireSource = false) => ownershipUnknown(line, requireSource) || Boolean(line?.manageStock && !hasKnownStock(line));
export const available = (line, requireSource = false) => Boolean(line?.purchasable && !ownershipUnknown(line, requireSource) && line.stockStatus !== 'outofstock' && (!line.manageStock || allowsBackorders(line) || (hasKnownStock(line) && line.stock > 0)));
export const physicallyInStock = (line, requireSource = false) => available(line, requireSource) && line.stockStatus !== 'onbackorder' && (!line.manageStock || (hasKnownStock(line) && line.stock > 0));
export const onBackorder = line => line?.stockStatus === 'onbackorder' || Boolean(line?.manageStock && hasKnownStock(line) && line.stock <= 0 && allowsBackorders(line));
