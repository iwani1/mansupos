// This module contains no wholesale prices. Defaults come from a separate
// role-gated API, never Woo product metadata or the public product catalogue.
export function wholesaleCents(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents >= 1 && cents <= 100000000 ? cents : null;
}

const optionSignature = attributes => JSON.stringify((attributes || []).map(attribute => [attribute.name, attribute.option]));

// Sent by the owner only as a precondition: the server verifies these fields
// against fresh authenticated Woo product/variation reads before any edit.
export function wholesaleIdentity(product, option = null) {
  if (!product) return null;
  return {
    productName: product.name, parentSku: product.sku || '',
    optionSku: option?.sku || '', optionLabel: option?.label || '',
    optionAttributes: optionSignature(option?.attributes),
    retailPriceCents: option?.price ?? product.price,
  };
}

export function matchingWholesalePrice(product, option, prices, trustedCatalogue = true) {
  if (!trustedCatalogue || !product || !Array.isArray(prices)) return null;
  const record = prices.find(price => price.productId === product.id && price.variationId === (option?.id || 0));
  const identity = wholesaleIdentity(product, option);
  if (!record?.valid || !Number.isSafeInteger(identity.retailPriceCents) ||
      Object.entries(identity).some(([key, value]) => record[key] !== value)) return null;
  return record.priceCents;
}
