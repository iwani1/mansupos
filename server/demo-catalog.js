// Public product facts sampled read-only from the WooCommerce Store API on 2026-11-03.
// Names, prices, source URLs, and IDs are sampled product facts. Quantities, barcode aliases,
// register categories, and sales are DEMO data. Local images are clearly disclosed illustrations,
// not photographs of the actual products. Live mode loads the actual WooCommerce image URLs.
// No claim is made that these are current live stock quantities or the complete catalogue.
const photo = (name, month = '2026/10') => `https://www.mansutrendzgh.com/wp-content/uploads/${month}/${name}-480x638.jpg`;
const definitions = [
  [7331, 'NEW ADVANCED HANDHELD AC FAN', 199, 'photo_2026-10-23_01-41-18', 'Accessories', null, 'August 2026-88-1-1-1-1-1-1-1-2-1-1-1'],
  [7325, 'PEARL SHIRT', 280, 'photo_2026-10-23_01-41-14', 'Tops & shirts', [7326,7327,7328], 'August 2026-88-1-1-1-1-1-1-1-2-1-1'],
  [7315, 'RED CHIFFON ASYMMETRIC SET', 450, 'photo_2026-10-23_01-41-12', 'Sets', [7316,7317,7318], 'August 2026-88-1-1-1-1-1-1-1-2-1'],
  [7307, 'Celine Luxe Pleated Dress', 390, 'photo_2026-10-22_16-08-12', 'Dresses', [7308,7309,7310], 'August 2026-88-1-1-1-1-1-1-1-2'],
  [7303, 'Mila Chocolate Brown', 399, 'photo_2026-10-22_16-08-08', 'Dresses', [7304,7305,7306], 'August 2026-88-1-1-1-1-1-1-1-1-1'],
  [7298, 'Zuri Patchwork set', 450, 'photo_2026-10-22_16-08-07', 'Sets', [7299,7300,7301], 'August 2026-88-1-1-1-1-1-1-1-1'],
  [7293, 'Naya Classic KNIT POLO TOP', 260, 'photo_2026-10-22_16-08-05', 'Tops & shirts', [7294,7295,7296], 'August 2026-88-1-1-1-1-1-1-1'],
  [7280, 'Ruffle Maxi Dress', 480, 'photo_2026-10-22_16-07-59', 'Dresses', [7281,7282,7283], 'August 2026-88-1-1-1-1-1-1'],
  [7268, 'Mosaic Luxe Set', 450, 'photo_2026-09-30_21-29-08', 'Sets', [7269,7270,7271], 'August 2026-88-1-1-1-1-1', '2026/09'],
  [7259, 'Zahra Luxe Ruffle Kaftan', 399, 'photo_2026-09-23_09-33-37', 'Dresses', [7260,7261,7262], 'August 2026-88-1-1-1-1', '2026/09'],
];
export const SNAPSHOT_DATE = '2026-11-03T21:00:00Z';
const pImage = p => `/demo/${p.category === 'Accessories' ? 'handheld-fan' : p.id === 7259 ? 'kaftan' : p.category === 'Tops & shirts' ? 'pearl-shirt' : p.category === 'Sets' ? (p.id === 7315 ? 'red-set' : 'patchwork-set') : 'pleated-dress'}.jpg`;
export const demoProducts = definitions.map(([id,name,price,image,category,variationIds,sku,month], index) => ({
  id, name, type: variationIds ? 'variable' : 'simple', sku,
  barcode: `DEMO-${1001 + index}`, price: price * 100,
  image: `/demo/${category === 'Accessories' ? 'handheld-fan' : id === 7259 ? 'kaftan' : category === 'Tops & shirts' ? 'pearl-shirt' : category === 'Sets' ? (id === 7315 ? 'red-set' : 'patchwork-set') : 'pleated-dress'}.jpg`,
  sourceImage: photo(image, month), imageSource: 'illustration', category, categories: [category],
  permalink: '', manageStock: true, stockStatus: 'instock', backorders: 'no',
  purchasable: true, soldIndividually: false,
  stock: variationIds ? null : 6 + index,
  variations: variationIds ? variationIds.map((variationId, i) => ({
    id: variationId, sku: `${sku}-${['L','M','S'][i]}`,
    barcode: `DEMO-${1001 + index}-${['L','M','S'][i]}`,
    label: ['L', 'M', 'S'][i], attributes: [{ name: 'Size', option: ['L','M','S'][i] }],
    price: price * 100, image: pImage({ id, category }), manageStock: true,
    stock: [3 + index % 3, 5 + index % 4, index === 7 ? 0 : 2 + index % 3][i],
    stockStatus: index === 7 && i === 2 ? 'outofstock' : 'instock',
    backorders: 'no', purchasable: true,
  })) : [],
}));

export function demoLine(product, variationId = null) {
  const variant = product.variations.find(v => v.id === Number(variationId));
  if (product.type === 'variable' && !variant) throw new Error('Choose a size first.');
  const source = variant || product;
  return {
    key: `${product.id}:${variant?.id || 0}`, productId: product.id, variationId: variant?.id || 0,
    name: product.name, label: variant?.label || '', sku: source.sku,
    barcode: source.barcode, image: source.image, price: source.price,
    manageStock: source.manageStock, stock: source.stock,
    stockStatus: source.stockStatus, backorders: source.backorders,
    purchasable: source.purchasable, soldIndividually: product.soldIndividually,
  };
}
