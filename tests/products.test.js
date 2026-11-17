import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { RemoteError } from '../server/errors.js';

const tradingEnv = {
  NODE_ENV: 'production', POS_MODE: 'live', WOO_BASE_URL: 'https://www.mansutrendzgh.com',
  WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic',
  POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com', POS_ALLOW_LIVE_WRITES: 'true',
  POS_OWNER_APPROVAL_REFERENCE: 'owner-chat-2026-11-16-cash-retail', POS_REQUIRE_SHIFT: 'true',
  POS_LIVE_RETAIL_CASH_DIRECT: 'true',
};
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

test('product writes have their own live switch and media needs both credentials', () => {
  assert.equal(readConfig(tradingEnv).productWritesEnabled, false);
  assert.equal(readConfig({ ...tradingEnv, POS_PRODUCT_WRITES_APPROVED: 'true' }).productWritesEnabled, true);
  assert.throws(() => readConfig({ ...tradingEnv, POS_PRODUCT_WRITES_APPROVED: 'maybe' }));
  assert.throws(() => readConfig({ ...tradingEnv, POS_WP_MEDIA_USER: 'shop' }));
  assert.throws(() => readConfig({ ...tradingEnv, POS_WP_MEDIA_USER: 'shop', POS_WP_MEDIA_APP_PASSWORD: 'short' }));
  assert.equal(readConfig({ ...tradingEnv, POS_WP_MEDIA_USER: 'shop', POS_WP_MEDIA_APP_PASSWORD: 'abcd efgh ijkl mnop qrst uvwx' }).mediaUser, 'shop');
});

function fakeWoo() {
  const state = { products: new Map(), variations: new Map(), nextId: 5000, calls: [], terms: { 1: ['S', 'M'] }, failCreate: null };
  const view = id => { const p = state.products.get(id); return p && { ...p, id }; };
  return {
    state,
    async request() { throw new Error('unexpected'); },
    async products() { return { data: [...state.products.keys()].map(view).filter(p => p.status === 'publish'), pages: 1, total: state.products.size }; },
    async variations(pid) { return { data: state.variations.get(pid) || [], pages: 1 }; },
    async product(id) { return view(id); },
    async categories() { return { data: [{ id: 15, name: 'Dresses', parent: 0, count: 4 }, { id: 16, name: 'Tops &amp; shirts', parent: 0 }], pages: 1 }; },
    async createCategory(body) { state.calls.push(['category', body]); return { id: 77, name: body.name }; },
    async attributes() { return [{ id: 1, name: 'Size', slug: 'pa_size' }]; },
    async attributeTerms(id) { return { data: (state.terms[id] || []).map((name, i) => ({ id: i + 1, name })), pages: 1 }; },
    async createAttributeTerm(id, body) { state.calls.push(['term', id, body.name]); state.terms[id].push(body.name); return { id: 99 }; },
    async createProduct(body) {
      state.calls.push(['create', body]);
      if (state.failCreate) { const e = state.failCreate; state.failCreate = null; throw e; }
      const id = state.nextId++;
      state.products.set(id, { ...body, price: body.sale_price || body.regular_price || '', stock_status: 'instock', purchasable: true, date_modified_gmt: '2026-11-17T05:00:00' });
      return view(id);
    },
    async updateProduct(id, body) { state.calls.push(['update', id, body]); Object.assign(state.products.get(id), body, { date_modified_gmt: '2026-11-17T06:00:00' }); return view(id); },
    async batchVariations(pid, body) {
      state.calls.push(['batch', pid, body]);
      const list = state.variations.get(pid) || [];
      const created = (body.create || []).map(v => {
        if (v.sku === 'TAKEN') return { id: 0, error: { code: 'product_invalid_sku', message: 'Invalid or duplicated SKU.' } };
        const row = { ...v, id: pid * 10 + list.length + 1, parent_id: pid, price: v.sale_price || v.regular_price, purchasable: true, stock_status: 'instock',
          attributes: v.attributes.map(a => ({ name: a.name || 'Size', option: a.option })) };
        list.push(row); return row;
      });
      for (const u of body.update || []) Object.assign(list.find(v => v.id === u.id), u);
      state.variations.set(pid, list);
      return { create: created, update: body.update || [] };
    },
    async recentOrders() { return { data: [], total: 0, pages: 1, paginationKnown: true }; },
  };
}

async function harness(t, extraEnv = {}, { mediaConfigured = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-products-'));
  const api = fakeWoo();
  const uploads = [];
  const media = { configured: mediaConfigured, async upload(buffer, type, name) { uploads.push({ bytes: buffer.length, type, name }); return { id: 300 + uploads.length, src: `https://www.mansutrendzgh.com/wp-content/uploads/p${uploads.length}.jpg` }; } };
  const env = { ...tradingEnv, NODE_ENV: 'test', POS_PUBLIC_ORIGIN: '', POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'test-secret-passphrase-123', POS_PRODUCT_WRITES_APPROVED: 'true', ...extraEnv };
  const instance = createApp({ env, api, media, logger: silent });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (url, { method = 'GET', body, token, raw, type } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': type || 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  let token = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'test-secret-passphrase-123' } })).data.token;
  await request('/auth/password', { method: 'POST', token, body: { currentPassword: 'test-secret-passphrase-123', newPassword: 'rotated-secret-passphrase-123' } });
  token = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'rotated-secret-passphrase-123' } })).data.token;
  t.after(async () => { await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, api, uploads, request, token };
}
const dress = (extra = {}) => ({
  key: randomUUID(), name: 'Amara Wrap Dress', description: 'Soft crepe.\n\nHand wash.', categoryIds: [15], newCategory: '', images: [{ id: 301 }], sku: 'AMARA',
  hasOptions: true, attributes: [{ name: 'Size', options: ['S', 'L'] }, { name: 'Colour', options: ['Black'] }],
  variations: [{ attributes: { Size: 'S', Colour: 'Black' }, sku: 'AMARA-S-BLK', regularPrice: '450', salePrice: '', stock: 3 },
    { attributes: { Size: 'L', Colour: 'Black' }, sku: 'AMARA-L-BLK', regularPrice: '450', salePrice: '399', stock: 2 }],
  ...extra,
});

test('a photo uploads and a product with sizes/colours is published to WooCommerce and shown in the POS at once', async t => {
  const h = await harness(t);
  const setup = await h.request('/products/setup', { token: h.token });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.writes.enabled, true);
  assert.equal(setup.data.writes.photos, true);
  assert.deepEqual(setup.data.categories.map(c => c.name), ['Dresses', 'Tops & shirts']);
  const photo = await h.request('/products/media?name=Amara', { method: 'POST', token: h.token, raw: JPEG, type: 'image/jpeg' });
  assert.equal(photo.status, 201, JSON.stringify(photo.data));
  assert.equal(photo.data.image.id, 301);
  const bad = await h.request('/products/media', { method: 'POST', token: h.token, raw: Buffer.from('not an image'), type: 'image/jpeg' });
  assert.equal(bad.status, 415);

  const created = await h.request('/products', { method: 'POST', token: h.token, body: dress() });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const [, body] = h.api.state.calls.find(c => c[0] === 'create');
  assert.equal(body.status, 'publish');
  assert.equal(body.type, 'variable');
  assert.equal(body.description, '<p>Soft crepe.</p>\n<p>Hand wash.</p>');
  assert.deepEqual(body.images, [{ id: 301 }]);
  assert.deepEqual(body.attributes[0], { id: 1, options: ['S', 'L'], variation: true, visible: true }, 'store-wide Size attribute is reused');
  assert.deepEqual(body.attributes[1], { name: 'Colour', options: ['Black'], variation: true, visible: true });
  assert.ok(h.api.state.calls.some(c => c[0] === 'term' && c[2] === 'L'), 'missing size value added to the store attribute');
  const batch = h.api.state.calls.find(c => c[0] === 'batch')[2].create;
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[1], { regular_price: '450.00', sale_price: '399.00', sku: 'AMARA-L-BLK', status: 'publish', manage_stock: true, stock_quantity: 2, attributes: [{ id: 1, option: 'L' }, { name: 'Colour', option: 'Black' }] });

  const catalog = await h.request('/catalog', { token: h.token });
  const listed = catalog.data.products.find(p => p.id === created.data.productId);
  assert.ok(listed, 'new product appears in the POS without waiting for a full catalogue reload');
  assert.equal(listed.variations.length, 2);

  const again = await h.request('/products', { method: 'POST', token: h.token, body: { ...dress(), key: JSON.parse(JSON.stringify(created)).data && h.api.state.calls.find(c => c[0] === 'create')[1].meta_data[0].value } });
  assert.equal(again.data.replayed, true, 'the same save is never published twice');
  assert.equal(h.api.state.calls.filter(c => c[0] === 'create').length, 1);
});

test('a duplicate SKU is explained and the same form can be fixed and saved', async t => {
  const h = await harness(t);
  const input = dress({ hasOptions: false, attributes: [], variations: [], regularPrice: '120', salePrice: '', stock: 5 });
  h.api.state.failCreate = Object.assign(new RemoteError('rejected', 502), { wooStatus: 400, wooCode: 'product_invalid_sku', wooMessage: 'Invalid or duplicated SKU.' });
  const first = await h.request('/products', { method: 'POST', token: h.token, body: input });
  assert.equal(first.status, 409);
  assert.equal(first.data.code, 'DUPLICATE_SKU');
  assert.match(first.data.error, /duplicated SKU/);
  const fixed = await h.request('/products', { method: 'POST', token: h.token, body: { ...input, sku: 'AMARA-2' } });
  assert.equal(fixed.status, 201, JSON.stringify(fixed.data));
  const body = h.api.state.calls.filter(c => c[0] === 'create').at(-1)[1];
  assert.equal(body.type, 'simple');
  assert.equal(body.regular_price, '120.00');
  assert.equal(body.stock_quantity, 5);
});

test('an unanswered save blocks a blind retry that could publish a duplicate', async t => {
  const h = await harness(t);
  const input = dress();
  h.api.state.failCreate = new RemoteError('timeout', 502, true);
  assert.equal((await h.request('/products', { method: 'POST', token: h.token, body: input })).status, 502);
  const retry = await h.request('/products', { method: 'POST', token: h.token, body: input });
  assert.equal(retry.status, 409);
  assert.equal(retry.data.code, 'PRODUCT_UNCERTAIN');
});

test('editing updates details, adds a new size, hides a removed one and refuses stale edits', async t => {
  const h = await harness(t);
  const created = await h.request('/products', { method: 'POST', token: h.token, body: dress() });
  const id = created.data.productId;
  const open = await h.request(`/products/${id}/edit`, { token: h.token });
  assert.equal(open.status, 200, JSON.stringify(open.data));
  const p = open.data.product;
  assert.equal(p.description, 'Soft crepe.\n\nHand wash.');
  assert.equal(p.variations.length, 2);
  const [small, large] = p.variations;
  const update = { key: randomUUID(), name: 'Amara Wrap Dress (new season)', description: p.description, categoryIds: p.categoryIds, newCategory: 'New in', images: p.images.map(i => ({ id: i.id })), sku: p.sku,
    regularPrice: '', salePrice: '', stock: 0, hasOptions: true, expectedModified: p.modified,
    attributes: [{ name: 'Size', options: ['S', 'L', 'XL'] }, { name: 'Colour', options: ['Black'] }],
    variations: [{ ...small, regularPrice: '480' }, { attributes: { Size: 'XL', Colour: 'Black' }, sku: 'AMARA-XL-BLK', regularPrice: '480', salePrice: '', stock: 4, imageId: null, enabled: true }] };
  const saved = await h.request(`/products/${id}`, { method: 'PUT', token: h.token, body: update });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const batch = h.api.state.calls.filter(c => c[0] === 'batch').at(-1)[2];
  assert.equal(batch.create.length, 1);
  assert.equal(batch.create[0].stock_quantity, 4);
  assert.deepEqual(batch.update.map(u => [u.id, u.regular_price, u.status]), [[small.id, '480.00', 'publish'], [large.id, '450.00', 'private']]);
  assert.ok(!('stock_quantity' in batch.update[0]), 'existing stock is only changed through Stock control');
  assert.ok(h.api.state.calls.some(c => c[0] === 'category' && c[1].name === 'New in'));
  const stale = await h.request(`/products/${id}`, { method: 'PUT', token: h.token, body: { ...update, key: randomUUID() } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'PRODUCT_CHANGED');
});

test('validation catches missing prices, repeated combinations and sale above regular', async t => {
  const h = await harness(t);
  const bad = [
    dress({ variations: [] }),
    dress({ variations: [dress().variations[0], dress().variations[0]] }),
    dress({ hasOptions: false, regularPrice: '', attributes: [], variations: [] }),
    dress({ hasOptions: false, regularPrice: '100', salePrice: '150', attributes: [], variations: [] }),
  ];
  for (const body of bad) assert.equal((await h.request('/products', { method: 'POST', token: h.token, body })).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal(h.api.state.calls.filter(c => c[0] === 'create').length, 0);
});

test('without the switch or photo password the screens explain what is locked', async t => {
  const locked = await harness(t, { POS_PRODUCT_WRITES_APPROVED: 'false' });
  const setup = await locked.request('/products/setup', { token: locked.token });
  assert.equal(setup.data.writes.enabled, false);
  assert.equal((await locked.request('/products', { method: 'POST', token: locked.token, body: dress() })).data.code, 'PRODUCT_WRITES_LOCKED');
  const noPhotos = await harness(t, {}, { mediaConfigured: false });
  const s2 = await noPhotos.request('/products/setup', { token: noPhotos.token });
  assert.equal(s2.data.writes.enabled, true);
  assert.equal(s2.data.writes.photos, false);
});

test('demo: add and edit a product with sizes, sell it from the catalogue', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-products-demo-'));
  const instance = createApp({ env: { POS_MODE: 'demo', NODE_ENV: 'test', POS_DATA_DIR: dir }, logger: silent });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (url, opts = {}) => { const res = await fetch(base + url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } }); return { status: res.status, data: await res.json() }; };
  const token = (await call('/auth/demo', { method: 'POST', body: '{}' })).data.token;
  const auth = { Authorization: `Bearer ${token}` };
  const photo = await call('/products/media', { method: 'POST', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: JPEG });
  assert.equal(photo.status, 201);
  const created = await call('/products', { method: 'POST', headers: auth, body: JSON.stringify(dress({ images: [{ id: photo.data.image.id }], categoryIds: [1] })) });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const catalog = (await call('/catalog', { headers: auth })).data;
  const listed = catalog.products.find(p => p.id === created.data.productId);
  assert.equal(listed.variations.length, 2);
  assert.equal(listed.variations[0].stock, 3);
  assert.match(listed.image, /^data:image\/jpeg;base64,/);
  const edit = (await call(`/products/${listed.id}/edit`, { headers: auth })).data.product;
  const saved = await call(`/products/${listed.id}`, { method: 'PUT', headers: auth, body: JSON.stringify({ ...edit, key: randomUUID(), expectedModified: '', newCategory: '', images: edit.images.map(i => ({ id: i.id })), name: 'Renamed dress', id: undefined, status: undefined, permalink: undefined, modified: undefined, manageStock: undefined }) });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await call('/catalog', { headers: auth })).data.products.find(p => p.id === listed.id).name, 'Renamed dress');
  assert.equal((await call('/products/7325/edit', { headers: auth })).data.code, 'DEMO_SAMPLE_FIXED');
});

test('options that inherit the parent SKU open empty and can be given their own SKUs', async t => {
  const h = await harness(t);
  // Woo reports an option with no SKU of its own using the parent's SKU.
  const id = 7000;
  h.api.state.products.set(id, { name: 'LYSA', type: 'variable', status: 'publish', sku: 'MT-GROUP-PILOT-05-1-1-1-1', description: '', categories: [], images: [],
    attributes: [{ id: 1, name: 'Size', variation: true, options: ['M', 'S', 'L'] }], date_modified_gmt: '2026-11-17T05:00:00' });
  h.api.state.variations.set(id, ['M', 'S', 'L'].map((size, i) => ({ id: 7001 + i, parent_id: id, sku: 'MT-GROUP-PILOT-05-1-1-1-1', regular_price: '490', sale_price: '',
    price: '490', status: 'publish', stock_quantity: 5, manage_stock: true, attributes: [{ id: 1, name: 'Size', option: size }] })));
  const p = (await h.request(`/products/${id}/edit`, { token: h.token })).data.product;
  assert.deepEqual(p.variations.map(v => v.sku), ['', '', ''], 'inherited SKUs are shown as empty');
  const base = { key: randomUUID(), name: 'LYSA', description: '', categoryIds: [], newCategory: '', images: [], sku: 'LYSA', regularPrice: '', salePrice: '', stock: 0,
    hasOptions: true, expectedModified: p.modified, attributes: [{ name: 'Size', options: ['M', 'S', 'L'] }] };
  // A name-only edit must not resend the inherited SKU (Woo would reject it as a duplicate).
  const renamed = await h.request(`/products/${id}`, { method: 'PUT', token: h.token, body: { ...base, sku: p.sku, variations: p.variations } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.ok(h.api.state.calls.filter(c => c[0] === 'batch').at(-1)[2].update.every(u => !('sku' in u)));
  const reopened = (await h.request(`/products/${id}/edit`, { token: h.token })).data.product;
  const fixed = await h.request(`/products/${id}`, { method: 'PUT', token: h.token, body: { ...base, key: randomUUID(), expectedModified: reopened.modified,
    variations: reopened.variations.map(v => ({ ...v, sku: `LYSA-${v.attributes.Size}` })) } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.deepEqual(h.api.state.calls.filter(c => c[0] === 'batch').at(-1)[2].update.map(u => u.sku), ['LYSA-M', 'LYSA-S', 'LYSA-L']);
  assert.equal(h.api.state.calls.filter(c => c[0] === 'update').at(-1)[2].sku, 'LYSA');
});
