import { hasKnownStock, stockUnknown } from './stock.js';

// Presentation-only catalogue summaries. A parent-managed Woo variation is one
// physical stock pool shared by its options; never sum or count it per size.
export function categoryGroups(products = []) {
  const groups = new Map();
  for (const product of products) {
    const categories = [...new Set((product.categories?.length ? product.categories : [product.category || 'Uncategorized']).filter(Boolean))];
    for (const name of categories) {
      const group = groups.get(name) || { name, count: 0, image: product.image || '' };
      group.count += 1;
      if (!group.image) group.image = product.image || '';
      groups.set(name, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function stockAlerts(products = [], threshold = 5, requireSource = false) {
  const pools = new Map();
  for (const product of products) {
    const lines = product.type === 'variable' && product.variations?.length ? product.variations : [product];
    for (const line of lines) {
      if (stockUnknown(line, requireSource) || !line.manageStock || !hasKnownStock(line)) continue;
      const shared = line.stockSource === 'parent';
      const key = shared ? `${product.id}:parent` : `${product.id}:${line.id === product.id ? 0 : (line.id || 0)}`;
      const existing = pools.get(key);
      if (existing) {
        existing.stock = Math.min(existing.stock, line.stock);
        continue;
      }
      pools.set(key, {
        key, name: product.name, option: shared ? 'Shared across options' : line === product ? '' : (line.label || ''),
        image: line.image || product.image || '', stock: line.stock,
      });
    }
  }
  const values = [...pools.values()].sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name));
  return {
    low: values.filter(item => item.stock > 0 && item.stock <= threshold),
    out: values.filter(item => item.stock <= 0),
  };
}
