import { z } from 'zod';
import { AppError, RemoteError, now } from './errors.js';
import { audit } from './db.js';
import { demoProducts } from './demo-catalog.js';
import { mapProduct, mapVariation } from './woocommerce.js';
import { imageType } from './wp-media.js';

// Add and edit WooCommerce product listings from the POS. New products are
// published straight away, so they appear on the website and at the till.
// Stock of EXISTING options is changed only through Stock control (audited);
// this editor sets the starting stock of new products/options.

const MAX_OPTIONS = 100;
const money = z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, 'Use a GHS amount like 120 or 120.50');
const optionalMoney = z.union([money, z.literal('')]).default('');
const line = max => z.string().trim().max(max).refine(v => !/[\r\n\0]/.test(v), 'Use one line');
const sku = line(60).default('');
const name = line(80).min(1);
const imageRef = z.object({ id: z.number().int().positive(), src: z.string().max(1_000_000).default('') }).strict();
const attribute = z.object({ name, options: z.array(line(40).min(1)).min(1).max(40) }).strict();
const variation = z.object({
  id: z.number().int().positive().optional(),
  attributes: z.record(z.string(), line(40).min(1)),
  sku, regularPrice: money, salePrice: optionalMoney,
  stock: z.number().int().min(0).max(1_000_000).default(0),
  imageId: z.number().int().positive().nullable().default(null),
  enabled: z.boolean().default(true),
}).strict();
const base = {
  key: z.string().uuid(),
  name: line(200).min(2),
  description: z.string().max(5000).default(''),
  categoryIds: z.array(z.number().int().positive()).max(10).default([]),
  newCategory: line(60).default(''),
  images: z.array(imageRef).max(12).default([]),
  sku,
  regularPrice: optionalMoney,
  salePrice: optionalMoney,
  stock: z.number().int().min(0).max(1_000_000).default(0),
  hasOptions: z.boolean(),
  attributes: z.array(attribute).max(3).default([]),
  variations: z.array(variation).max(MAX_OPTIONS).default([]),
};
function check(value, ctx) {
  const price = (regular, sale, path) => {
    if (sale !== '' && Number(sale) >= Number(regular)) ctx.addIssue({ code: 'custom', path, message: 'Sale price must be lower than the regular price' });
    if (Number(regular) <= 0) ctx.addIssue({ code: 'custom', path, message: 'Enter a price above zero' });
  };
  if (!value.hasOptions) {
    if (value.regularPrice === '') ctx.addIssue({ code: 'custom', path: ['regularPrice'], message: 'Enter a price' });
    else price(value.regularPrice, value.salePrice, ['regularPrice']);
    return;
  }
  if (!value.attributes.length) ctx.addIssue({ code: 'custom', path: ['attributes'], message: 'Add at least one option such as Size or Colour' });
  const names = value.attributes.map(a => a.name.toLowerCase());
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['attributes'], message: 'Each option name can be used once' });
  value.attributes.forEach((a, i) => { if (new Set(a.options.map(o => o.toLowerCase())).size !== a.options.length) ctx.addIssue({ code: 'custom', path: ['attributes', i], message: `${a.name} has a repeated value` }); });
  if (!value.variations.some(v => v.enabled)) ctx.addIssue({ code: 'custom', path: ['variations'], message: 'Keep at least one size/colour combination' });
  const seen = new Set();
  const skus = new Set();
  value.variations.forEach((v, i) => {
    const keys = Object.keys(v.attributes);
    if (keys.length !== value.attributes.length || value.attributes.some(a => !a.options.includes(v.attributes[a.name]))) {
      ctx.addIssue({ code: 'custom', path: ['variations', i], message: 'Each combination must pick one value of every option' });
    }
    const id = value.attributes.map(a => String(v.attributes[a.name]).toLowerCase()).join('|');
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['variations', i], message: 'Repeated size/colour combination' });
    seen.add(id);
    if (v.sku) { if (skus.has(v.sku) || v.sku === value.sku) ctx.addIssue({ code: 'custom', path: ['variations', i, 'sku'], message: 'Each SKU must be different' }); skus.add(v.sku); }
    price(v.regularPrice, v.salePrice, ['variations', i, 'regularPrice']);
  });
}
export const productSchema = z.object(base).strict().superRefine(check);
export const productUpdateSchema = z.object({ ...base, expectedModified: z.string().max(40).default('') }).strict().superRefine(check);

const cents = value => value === '' || value == null ? null : Math.round(Number(value) * 100);
const decimal = value => value === '' || value == null ? '' : (Math.round(Number(value) * 100) / 100).toFixed(2);
const paragraphs = text => text.trim() ? text.trim().split(/\n{2,}/).map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`).join('\n') : '';
const plain = html => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();
const sameName = (a, b) => normalName(a) === normalName(b);
function normalName(value) { const text = String(value || '').trim().toLowerCase().replace(/^pa_/, ''); return text === 'color' ? 'colour' : text; }

export function productWriteState(config, media) {
  let state;
  if (config.mode === 'demo') state = { enabled: true, reason: 'Demo: products are saved in this practice workspace only. Your website is not changed.' };
  else if (config.liveReadOnly) state = { enabled: false, reason: 'The read-only live pilot cannot add or edit website products.' };
  else if (config.onlineBridgeEnabled || config.onlineBridgeQuarantined) state = { enabled: false, reason: 'Product changes are locked while the reservation bridge profile is active or under review.' };
  else if (!config.configured) state = { enabled: false, reason: 'WooCommerce credentials are not configured on the server.' };
  else if (!config.writesEnabled) state = { enabled: false, reason: 'WooCommerce writes are not approved for this POS service.' };
  else if (!config.productWritesEnabled) state = { enabled: false, reason: 'Adding and editing products is switched off. Set POS_PRODUCT_WRITES_APPROVED=true on the trading service to enable it.' };
  else state = { enabled: true, reason: 'Products are published to the website and appear in the POS straight away.' };
  const photos = config.mode === 'demo' ? true : state.enabled && media.configured;
  return { ...state, photos, photosReason: photos ? '' : state.enabled ? 'Photo upload needs a WordPress Application Password on the server. Products can still be saved without photos and photos added later.' : state.reason };
}

export class ProductService {
  constructor(db, catalog, api, config, media) {
    this.db = db; this.catalog = catalog; this.api = api; this.config = config; this.media = media;
    this.queue = Promise.resolve();
    this.cache = {};
  }
  exclusive(work) { const run = this.queue.then(work, work); this.queue = run.catch(() => {}); return run; }
  state() { return productWriteState(this.config, this.media); }
  requireWrites() { const s = this.state(); if (!s.enabled) throw new AppError(s.reason, 403, 'PRODUCT_WRITES_LOCKED'); }
  get demo() { return this.config.mode === 'demo'; }
  record(user, action, entry) { audit(this.db, user.id, action, JSON.stringify({ v: 1, ...entry, by: user.name, at: now() })); }
  previous(key) {
    return this.db.prepare(`SELECT action,subject FROM audit WHERE action IN ('product.create_intent','product.created','product.create_failed','product.updated')
      AND json_valid(subject) AND json_extract(subject,'$.key')=? ORDER BY id`).all(key).map(r => ({ action: r.action, ...JSON.parse(r.subject) }));
  }
  wooError(error, fallback) {
    if (error instanceof RemoteError && error.wooMessage && error.wooStatus >= 400 && error.wooStatus < 500) {
      return new AppError(`WooCommerce: ${error.wooMessage}`, 409, error.wooCode === 'product_invalid_sku' ? 'DUPLICATE_SKU' : 'WOO_REJECTED');
    }
    return error instanceof AppError ? error : new AppError(fallback, 502);
  }

  // ---------- setup data ----------
  async setup() {
    const catalog = await this.catalog.get(false, { maxWaitMs: 4000 }).catch(() => ({ products: [] }));
    const counts = new Map();
    for (const p of catalog.products || []) for (const v of p.variations || []) for (const a of v.attributes || []) {
      const key = normalName(a.name);
      if (!key || !a.option) continue;
      if (!counts.has(key)) counts.set(key, { name: key === 'colour' ? 'Colour' : a.name.replace(/^pa_/i, '').replace(/^./, c => c.toUpperCase()), options: new Map() });
      const entry = counts.get(key).options;
      entry.set(a.option, (entry.get(a.option) || 0) + 1);
    }
    const suggestions = [...counts.values()].map(s => ({ name: s.name, options: [...s.options.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([o]) => o) }))
      .sort((a, b) => b.options.length - a.options.length).slice(0, 6);
    for (const fallback of [{ name: 'Size', options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] }, { name: 'Colour', options: ['Black', 'White', 'Red', 'Blue', 'Brown', 'Green', 'Pink', 'Beige'] }]) {
      if (!suggestions.some(s => sameName(s.name, fallback.name))) suggestions.push(fallback);
    }
    let categories = [];
    try { categories = await this.categories(); } catch (error) { if (!(error instanceof AppError)) throw error; }
    return { writes: this.state(), categories, suggestions, maxOptions: MAX_OPTIONS };
  }
  async categories(force = false) {
    if (this.demo) return this.demoCategories();
    if (!force && this.cache.categories && Date.now() - this.cache.categoriesAt < 300000) return this.cache.categories;
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const result = await this.api.categories(page);
      all.push(...(result.data || []).map(c => ({ id: c.id, name: plain(c.name), parent: c.parent || 0, count: c.count || 0 })));
      if (page >= (result.pages || 1)) break;
    }
    this.cache.categories = all; this.cache.categoriesAt = Date.now();
    return all;
  }
  async ensureCategory(nameValue) {
    const wanted = nameValue.trim();
    if (!wanted) return null;
    const found = (await this.categories()).find(c => c.name.toLowerCase() === wanted.toLowerCase());
    if (found) return found.id;
    if (this.demo) {
      const store = this.demoStore();
      const id = 500 + store.categories.length + 1;
      store.categories.push({ id, name: wanted });
      this.saveDemo(store);
      return id;
    }
    try {
      const created = await this.api.createCategory({ name: wanted });
      this.cache.categories = null;
      return created.id;
    } catch (error) {
      if (error.wooCode === 'term_exists' && error.wooData?.resourceId) return error.wooData.resourceId;
      throw this.wooError(error, 'The new category could not be created.');
    }
  }

  // ---------- photos ----------
  async uploadImage(user, buffer, productName) {
    this.requireWrites();
    const type = imageType(buffer);
    if (!type) throw new AppError('Use a JPEG, PNG or WebP photo.', 415, 'UNSUPPORTED_IMAGE');
    if (buffer.length > 8 * 1024 * 1024) throw new AppError('Photo is too large (8 MB maximum).', 413);
    if (this.demo) {
      if (buffer.length > 600 * 1024) throw new AppError('Demo photos must be under 600 KB. The app shrinks photos automatically; try a smaller one.', 413);
      const store = this.demoStore();
      const id = 800000 + store.images.length + 1;
      const image = { id, src: `data:${type};base64,${buffer.toString('base64')}` };
      store.images.push(image); this.saveDemo(store);
      return { image };
    }
    const image = await this.media.upload(buffer, type, productName);
    this.record(user, 'product.media_uploaded', { mediaId: image.id, bytes: buffer.length });
    return { image };
  }

  // ---------- create ----------
  create(user, input) {
    this.requireWrites();
    return this.exclusive(async () => {
      const prior = this.previous(input.key);
      const done = prior.find(e => e.action === 'product.created');
      if (done) return { productId: done.productId, replayed: true, warnings: done.warnings || [] };
      // A definite WooCommerce rejection (e.g. duplicate SKU) may be fixed and
      // resubmitted with the same key; an unanswered attempt may not.
      const last = prior.filter(e => ['product.create_intent', 'product.create_failed'].includes(e.action)).at(-1);
      if (last?.action === 'product.create_intent') {
        throw new AppError('An earlier save of this product may have reached the website. Check Products (refresh) before saving again, to avoid a duplicate listing.', 409, 'PRODUCT_UNCERTAIN');
      }
      const categoryIds = [...input.categoryIds];
      const extra = await this.ensureCategory(input.newCategory);
      if (extra && !categoryIds.includes(extra)) categoryIds.push(extra);
      const entry = { key: input.key, name: input.name, options: input.hasOptions ? input.variations.length : 0 };
      if (this.demo) return this.demoCreate(user, input, categoryIds, entry);
      this.record(user, 'product.create_intent', entry);
      const attributes = input.hasOptions ? await this.wooAttributes(input.attributes) : [];
      let product;
      try {
        product = await this.api.createProduct({
          name: input.name, type: input.hasOptions ? 'variable' : 'simple', status: 'publish',
          description: paragraphs(input.description), categories: categoryIds.map(id => ({ id })),
          images: input.images.map(i => ({ id: i.id })), ...(input.sku ? { sku: input.sku } : {}),
          ...(input.hasOptions ? { attributes: attributes.map(a => a.product) } : {
            regular_price: decimal(input.regularPrice), sale_price: decimal(input.salePrice), manage_stock: true, stock_quantity: input.stock }),
          meta_data: [{ key: '_mansu_pos_product_key', value: input.key }],
        });
      } catch (error) {
        const definite = error instanceof RemoteError && error.wooStatus >= 400 && error.wooStatus < 500;
        this.record(user, definite ? 'product.create_failed' : 'product.create_uncertain', { ...entry, error: String(error.wooMessage || error.message).slice(0, 200) });
        throw this.wooError(error, 'The website did not confirm the new product. Refresh Products to check before saving again.');
      }
      const warnings = [];
      if (input.hasOptions) {
        const failed = await this.createVariations(product.id, input.variations.filter(v => v.enabled), attributes);
        if (failed.length) {
          warnings.push(`${failed.length} size/colour ${failed.length === 1 ? 'combination was' : 'combinations were'} not saved: ${failed.slice(0, 3).join('; ')}`);
          if (failed.length === input.variations.filter(v => v.enabled).length) {
            // A published variable product without options cannot be bought; hide it until fixed.
            try { await this.api.updateProduct(product.id, { status: 'draft' }); warnings.push('The product was hidden (draft) because no combination could be saved. Fix it with Edit.'); } catch { /* reported below */ }
          }
        }
      }
      await this.refreshOne(product.id);
      this.record(user, 'product.created', { ...entry, productId: product.id, warnings });
      return { productId: product.id, warnings };
    });
  }

  async createVariations(productId, variations, attributes) {
    if (!variations.length) return [];
    const result = await this.api.batchVariations(productId, { create: variations.map(v => this.wooVariation(v, attributes)) });
    return (result?.create || []).filter(item => item?.error).map(item => String(item.error.message || 'rejected').replace(/<[^>]*>/g, '').slice(0, 120));
  }
  wooVariation(v, attributes, existing = false) {
    return {
      ...(v.id ? { id: v.id } : {}),
      regular_price: decimal(v.regularPrice), sale_price: decimal(v.salePrice), sku: v.sku || '',
      status: v.enabled ? 'publish' : 'private',
      ...(existing ? {} : { manage_stock: true, stock_quantity: v.stock }),
      ...(v.imageId ? { image: { id: v.imageId } } : {}),
      ...(existing ? {} : { attributes: attributes.map(a => ({ ...(a.id ? { id: a.id } : { name: a.name }), option: v.attributes[a.name] })) }),
    };
  }
  // Use the store's global attributes (e.g. "Size", "Color") when they exist,
  // creating missing values as terms, so website filters keep working.
  async wooAttributes(attributes) {
    let globals = [];
    try { globals = await this.api.attributes(); } catch { globals = []; }
    const out = [];
    for (const a of attributes) {
      const global = (globals || []).find(g => sameName(g.name, a.name) || sameName(g.slug, a.name));
      if (global) {
        const existing = [];
        for (let page = 1; page <= 10; page++) {
          const res = await this.api.attributeTerms(global.id, page);
          existing.push(...(res.data || []).map(t => plain(t.name)));
          if (page >= (res.pages || 1)) break;
        }
        for (const option of a.options) {
          if (existing.some(t => t.toLowerCase() === option.toLowerCase())) continue;
          try { await this.api.createAttributeTerm(global.id, { name: option }); }
          catch (error) { if (error.wooCode !== 'term_exists') throw this.wooError(error, `Could not add "${option}" to ${a.name}.`); }
        }
        out.push({ id: global.id, name: a.name, product: { id: global.id, options: a.options, variation: true, visible: true } });
      } else out.push({ name: a.name, product: { name: a.name, options: a.options, variation: true, visible: true } });
    }
    return out;
  }
  async refreshOne(productId) {
    try {
      const raw = await this.api.product(productId);
      const mapped = mapProduct(raw);
      if (raw.type === 'variable') {
        for (let page = 1; page <= 5; page++) {
          const res = await this.api.variations(productId, page);
          mapped.variations.push(...(res.data || []).filter(v => !v.status || v.status === 'publish').map(v => mapVariation(v, raw)));
          if (page >= (res.pages || 1)) break;
        }
        mapped.purchasable = mapped.variations.some(v => v.purchasable);
      }
      if (raw.status === 'publish') this.catalog.upsertProduct(mapped); else this.catalog.removeProduct(productId);
    } catch { this.catalog.invalidate(); }
  }

  // ---------- edit ----------
  async editable(productId) {
    if (this.demo) return this.demoEditable(productId);
    const raw = await this.api.product(productId);
    if (Number(raw?.id) !== productId || raw.status === 'trash' || !['simple', 'variable'].includes(raw.type)) throw new AppError('This product cannot be edited here.', 404);
    const variations = [];
    if (raw.type === 'variable') {
      for (let page = 1; page <= 5; page++) {
        const res = await this.api.variations(productId, page);
        variations.push(...(res.data || []));
        if (page >= (res.pages || 1)) break;
      }
    }
    const attributes = (raw.attributes || []).filter(a => a.variation).map(a => ({ name: a.name, options: a.options || [] }));
    return {
      id: raw.id, status: raw.status, permalink: raw.permalink || '', modified: raw.date_modified_gmt || raw.date_modified || '',
      name: plain(raw.name), description: plain(raw.description), categoryIds: (raw.categories || []).map(c => c.id),
      images: (raw.images || []).map(i => ({ id: i.id, src: i.src })), sku: raw.sku || '',
      regularPrice: raw.type === 'simple' ? decimal(raw.regular_price) : '', salePrice: raw.type === 'simple' ? decimal(raw.sale_price) : '',
      stock: raw.stock_quantity ?? 0, manageStock: raw.manage_stock === true, hasOptions: raw.type === 'variable', attributes,
      variations: variations.map(v => ({
        id: v.id, attributes: Object.fromEntries((v.attributes || []).map(a => [attributes.find(x => sameName(x.name, a.name))?.name || a.name, a.option])),
        sku: v.sku || '', regularPrice: decimal(v.regular_price), salePrice: decimal(v.sale_price), stock: v.stock_quantity ?? 0,
        imageId: v.image?.id || null, enabled: v.status !== 'private',
      })),
    };
  }
  update(user, productId, input) {
    this.requireWrites();
    return this.exclusive(async () => {
      const done = this.previous(input.key).find(e => e.action === 'product.updated');
      if (done) return { productId, replayed: true, warnings: done.warnings || [] };
      const categoryIds = [...input.categoryIds];
      const extra = await this.ensureCategory(input.newCategory);
      if (extra && !categoryIds.includes(extra)) categoryIds.push(extra);
      if (this.demo) return this.demoUpdate(user, productId, input, categoryIds);
      const current = await this.editable(productId);
      if (input.expectedModified && current.modified && input.expectedModified !== current.modified) {
        throw new AppError('Someone changed this product on the website since you opened it. Close and open it again to see the latest version.', 409, 'PRODUCT_CHANGED');
      }
      if (current.hasOptions !== input.hasOptions) throw new AppError('A product cannot switch between single item and sizes/colours here. Create a new product instead.', 409);
      const known = new Map(current.variations.map(v => [v.id, v]));
      for (const v of input.variations) if (v.id && !known.has(v.id)) throw new AppError('A size/colour option no longer exists. Reopen the product.', 409, 'PRODUCT_CHANGED');
      // Removing an existing option hides it (private) instead of deleting sales history.
      const kept = new Set(input.variations.filter(v => v.id).map(v => v.id));
      const hidden = current.variations.filter(v => !kept.has(v.id) && v.enabled).map(v => ({ ...v, enabled: false }));
      const attributes = input.hasOptions ? await this.wooAttributes(input.attributes) : [];
      try {
        await this.api.updateProduct(productId, {
          name: input.name, description: paragraphs(input.description), categories: categoryIds.map(id => ({ id })),
          images: input.images.map(i => ({ id: i.id })), sku: input.sku,
          ...(input.hasOptions ? { attributes: attributes.map(a => a.product) } : { regular_price: decimal(input.regularPrice), sale_price: decimal(input.salePrice) }),
        });
      } catch (error) { throw this.wooError(error, 'The website did not confirm the product change. Reopen it to check.'); }
      const warnings = [];
      if (input.hasOptions) {
        const update = [...input.variations.filter(v => v.id), ...hidden].map(v => this.wooVariation(v, attributes, true));
        const create = input.variations.filter(v => !v.id).map(v => this.wooVariation(v, attributes));
        if (update.length || create.length) {
          try {
            const res = await this.api.batchVariations(productId, { ...(update.length ? { update } : {}), ...(create.length ? { create } : {}) });
            const failed = [...(res?.update || []), ...(res?.create || [])].filter(i => i?.error);
            if (failed.length) warnings.push(`${failed.length} size/colour ${failed.length === 1 ? 'change was' : 'changes were'} not saved: ${failed.slice(0, 3).map(i => String(i.error.message || '').replace(/<[^>]*>/g, '').slice(0, 100)).join('; ')}`);
          } catch (error) { throw this.wooError(error, 'The product was saved, but its sizes/colours were not confirmed. Reopen it to check.'); }
        }
      }
      await this.refreshOne(productId);
      this.record(user, 'product.updated', { key: input.key, productId, name: input.name, warnings });
      return { productId, warnings };
    });
  }

  // ---------- demo workspace ----------
  demoStore() {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key='demo_product_store'").get();
    const store = row ? JSON.parse(row.value) : null;
    return { products: store?.products || [], categories: store?.categories || [], images: store?.images || [], nextId: store?.nextId || 990001 };
  }
  saveDemo(store) {
    this.db.prepare("INSERT INTO app_meta(key,value) VALUES ('demo_product_store',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(store));
  }
  demoCategories() {
    const names = [...new Set(demoProducts.map(p => p.category))].sort();
    return [...names.map((n, i) => ({ id: i + 1, name: n, parent: 0 })), ...this.demoStore().categories.map(c => ({ ...c, parent: 0 }))];
  }
  demoBuild(id, input, categoryIds, store, variationIds = []) {
    const cats = this.demoCategories().filter(c => categoryIds.includes(c.id));
    const imageSrc = imgId => input.images.find(i => i.id === imgId)?.src || store.images.find(i => i.id === imgId)?.src || '';
    const main = input.images[0] ? imageSrc(input.images[0].id) : '';
    const priceOf = (r, s) => cents(s || r) || 0;
    const product = {
      id, name: input.name, type: input.hasOptions ? 'variable' : 'simple', sku: input.sku, barcode: input.sku, price: input.hasOptions ? 0 : priceOf(input.regularPrice, input.salePrice),
      image: main, category: cats[0]?.name || 'Uncategorized', categories: cats.map(c => c.name), permalink: '', manageStock: true, stockStatus: 'instock', backorders: 'no',
      purchasable: true, soldIndividually: false, stock: null, variations: [],
      editor: { description: input.description, categoryIds, images: input.images.map(i => ({ id: i.id })), regularPrice: decimal(input.regularPrice), salePrice: decimal(input.salePrice), attributes: input.attributes },
    };
    if (input.hasOptions) {
      product.variations = input.variations.map((v, i) => ({
        id: v.id || variationIds[i], sku: v.sku, barcode: v.sku, label: input.attributes.map(a => v.attributes[a.name]).join(' / '),
        attributes: input.attributes.map(a => ({ name: a.name, option: v.attributes[a.name] })), price: priceOf(v.regularPrice, v.salePrice),
        image: v.imageId ? imageSrc(v.imageId) : main, manageStock: true, stockStatus: 'instock', backorders: 'no', purchasable: v.enabled,
        editor: { regularPrice: decimal(v.regularPrice), salePrice: decimal(v.salePrice), imageId: v.imageId, enabled: v.enabled },
      }));
      product.price = Math.min(...product.variations.filter(v => v.purchasable).map(v => v.price));
    }
    return product;
  }
  demoCreate(user, input, categoryIds, entry) {
    const store = this.demoStore();
    const id = store.nextId;
    const variationIds = input.variations.map((_, i) => id * 100 + i + 1);
    const enabled = input.hasOptions ? input.variations.filter(v => v.enabled) : [];
    const product = this.demoBuild(id, { ...input, variations: enabled }, categoryIds, store, enabled.map((_, i) => variationIds[i]));
    store.products.push(product); store.nextId = id + 1;
    const stock = this.db.prepare('INSERT INTO demo_stock(line_key,stock) VALUES (?,?) ON CONFLICT(line_key) DO UPDATE SET stock=excluded.stock');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveDemo(store);
      if (input.hasOptions) product.variations.forEach((v, i) => stock.run(`${id}:${v.id}`, enabled[i].stock));
      else stock.run(`${id}:0`, input.stock);
      this.record(user, 'product.created', { ...entry, productId: id, warnings: [] });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.catalog.invalidate();
    return { productId: id, warnings: [] };
  }
  demoEditable(productId) {
    const store = this.demoStore();
    const p = store.products.find(x => x.id === productId);
    if (!p) throw new AppError(demoProducts.some(x => x.id === productId) ? 'Demo sample products are fixed. Add a new product to practise editing.' : 'Product not found.', demoProducts.some(x => x.id === productId) ? 403 : 404, 'DEMO_SAMPLE_FIXED');
    const stockOf = key => this.db.prepare('SELECT stock FROM demo_stock WHERE line_key=?').get(key)?.stock ?? 0;
    return {
      id: p.id, status: 'publish', permalink: '', modified: '', name: p.name, description: p.editor.description, categoryIds: p.editor.categoryIds,
      images: p.editor.images.map(i => ({ id: i.id, src: store.images.find(x => x.id === i.id)?.src || '' })), sku: p.sku,
      regularPrice: p.editor.regularPrice, salePrice: p.editor.salePrice, stock: stockOf(`${p.id}:0`), manageStock: true,
      hasOptions: p.type === 'variable', attributes: p.editor.attributes,
      variations: p.variations.map(v => ({ id: v.id, attributes: Object.fromEntries(v.attributes.map(a => [a.name, a.option])), sku: v.sku,
        regularPrice: v.editor.regularPrice, salePrice: v.editor.salePrice, stock: stockOf(`${p.id}:${v.id}`), imageId: v.editor.imageId, enabled: v.editor.enabled })),
    };
  }
  demoUpdate(user, productId, input, categoryIds) {
    const current = this.demoEditable(productId);
    if (current.hasOptions !== input.hasOptions) throw new AppError('A product cannot switch between single item and sizes/colours here. Create a new product instead.', 409);
    const store = this.demoStore();
    const index = store.products.findIndex(x => x.id === productId);
    const kept = new Set(input.variations.filter(v => v.id).map(v => v.id));
    const hidden = current.variations.filter(v => !kept.has(v.id)).map(v => ({ ...v, enabled: false }));
    let next = Math.max(productId * 100, ...current.variations.map(v => v.id)) + 1;
    const all = [...input.variations, ...hidden].map(v => v.id ? v : { ...v, id: next++ });
    const product = this.demoBuild(productId, { ...input, variations: all }, categoryIds, store);
    store.products[index] = product;
    const stock = this.db.prepare('INSERT OR IGNORE INTO demo_stock(line_key,stock) VALUES (?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveDemo(store);
      for (const v of all) stock.run(`${productId}:${v.id}`, v.stock);
      this.record(user, 'product.updated', { key: input.key, productId, name: input.name, warnings: [] });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.catalog.invalidate();
    return { productId, warnings: [] };
  }
}
