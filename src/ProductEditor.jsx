import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ImagePlus, X, Star, Plus, Trash2, Wand2, LockKeyhole } from 'lucide-react';
import { api, authHeaders, uuid, money } from './api.js';
import { Modal, Notice, Spinner } from './components.jsx';
import './product-editor.css';

const MAX_PHOTOS = 12;
const MAX_COMBOS = 100;
const priceOk = value => /^\d{1,7}(\.\d{1,2})?$/.test(String(value).trim()) && Number(value) > 0;
const code = value => String(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const comboKey = (attrs, names) => names.map(n => String(attrs[n] ?? '').toLowerCase()).join('|');
const cleanNumber = value => value.replace(/[^\d.]/g, '');

// Shrink a camera photo before upload: faster on shop Wi-Fi, lighter website.
async function shrink(file, max, quality) {
  let source;
  try { source = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    source = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = URL.createObjectURL(file); });
  }
  const scale = Math.min(1, max / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Photo could not be read.')), 'image/jpeg', quality));
}

function combinations(attributes) {
  const usable = attributes.filter(a => a.name.trim() && a.options.length);
  if (!usable.length) return [];
  return usable.reduce((rows, a) => rows.flatMap(row => a.options.map(o => ({ ...row, [a.name.trim()]: o }))), [{}]);
}

export default function ProductEditor({ productId = null, config, notify, onClose, onSaved }) {
  const [setup, setSetup] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [defaults, setDefaults] = useState({ price: '', sale: '', stock: '' });
  const [key] = useState(uuid);
  const seeded = useRef(false);
  const files = useRef(null);
  const camera = useRef(null);
  const demo = config.mode === 'demo';

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const s = await api('/products/setup');
        const product = productId ? (await api(`/products/${productId}/edit`)).product : null;
        if (!live) return;
        setSetup(s);
        setForm(product ? { ...product, newCategory: '', rows: product.variations.map(v => ({ ...v, existing: true })) } : {
          name: '', description: '', categoryIds: [], newCategory: '', images: [], sku: '', regularPrice: '', salePrice: '', stock: '',
          hasOptions: true, attributes: [{ name: 'Size', options: [] }, { name: 'Colour', options: [] }], rows: [],
        });
      } catch (e) { if (live) setError(e.message); }
    })();
    return () => { live = false; };
  }, [productId]);

  const names = useMemo(() => (form?.attributes || []).filter(a => a.name.trim() && a.options.length).map(a => a.name.trim()), [form?.attributes]);
  const combos = useMemo(() => combinations(form?.attributes || []), [form?.attributes]);
  // Keep one row per size/colour combination; keep what was typed when options change.
  useEffect(() => {
    if (!form?.hasOptions) return;
    // When editing, combinations the website does not sell yet start unticked;
    // values added afterwards start ticked.
    const firstEdit = Boolean(productId) && !seeded.current;
    seeded.current = true;
    setForm(f => {
      const byKey = new Map(f.rows.map(r => [comboKey(r.attributes, names), r]));
      const rows = combos.slice(0, MAX_COMBOS).map(attrs => byKey.get(comboKey(attrs, names)) || { attributes: attrs, sku: '', regularPrice: defaults.price, salePrice: defaults.sale, stock: defaults.stock, imageId: null, enabled: !firstEdit, existing: false });
      const same = rows.length === f.rows.length && rows.every((r, i) => r === f.rows[i]);
      return same ? f : { ...f, rows };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- defaults only seed new rows
  }, [combos, names, form?.hasOptions, productId]);

  if (error && !form) return <Modal title={productId ? 'Edit product' : 'Add product'} onClose={onClose}><div className="modal-body"><Notice tone="error">{error}</Notice></div></Modal>;
  if (!form || !setup) return <Modal title={productId ? 'Edit product' : 'Add product'} onClose={onClose}><div className="modal-body"><Spinner label="Loading…" /></div></Modal>;

  const writes = setup.writes;
  const set = patch => setForm(f => ({ ...f, ...patch }));
  const setAttr = (index, patch) => set({ attributes: form.attributes.map((a, i) => i === index ? { ...a, ...patch } : a) });
  const setRow = (index, patch) => set({ rows: form.rows.map((r, i) => i === index ? { ...r, ...patch } : r) });
  const lockedOptions = new Set(form.rows.filter(r => r.existing).flatMap(r => Object.entries(r.attributes).map(([n, o]) => `${n.toLowerCase()}|${o}`)));

  async function addPhotos(list) {
    const chosen = [...list].slice(0, MAX_PHOTOS - form.images.length);
    if (!chosen.length) return;
    setUploading(n => n + chosen.length); setError('');
    for (const file of chosen) {
      try {
        const blob = await shrink(file, demo ? 900 : 1600, demo ? 0.78 : 0.85);
        const response = await fetch(`/api/products/media?name=${encodeURIComponent(form.name || 'product')}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg', ...authHeaders() }, body: blob });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Photo upload failed.');
        setForm(f => ({ ...f, images: [...f.images, data.image] }));
      } catch (e) { setError(`${file.name || 'Photo'}: ${e.message}`); }
      finally { setUploading(n => n - 1); }
    }
  }
  function addOption(index, raw) {
    const values = raw.split(',').map(v => v.trim()).filter(Boolean);
    const a = form.attributes[index];
    const next = [...a.options];
    for (const v of values) if (!next.some(o => o.toLowerCase() === v.toLowerCase())) next.push(v.slice(0, 40));
    setAttr(index, { options: next.slice(0, 40) });
  }
  function applyDefaults() {
    set({ rows: form.rows.map(r => ({ ...r, ...(defaults.price ? { regularPrice: defaults.price } : {}), ...(defaults.sale !== '' ? { salePrice: defaults.sale } : {}), ...(!r.existing && defaults.stock !== '' ? { stock: defaults.stock } : {}) })) });
  }
  function autoSku() {
    const base = (form.sku || code(form.name)).trim();
    if (!base) return;
    set({ sku: form.sku || base, rows: form.rows.map(r => r.sku ? r : { ...r, sku: [base, ...names.map(n => code(r.attributes[n]))].join('-') }) });
  }

  const enabledRows = form.rows.filter(r => r.enabled);
  const prices = enabledRows.filter(r => priceOk(r.regularPrice)).map(r => Math.round(Number(r.salePrice || r.regularPrice) * 100));
  const problems = [];
  if (form.name.trim().length < 2) problems.push('Enter a product name.');
  if (form.hasOptions) {
    if (!enabledRows.length) problems.push('Add at least one size or colour.');
    if (combos.length > MAX_COMBOS) problems.push(`Too many combinations (${combos.length}); the limit is ${MAX_COMBOS}.`);
    if (enabledRows.some(r => !priceOk(r.regularPrice))) problems.push('Every size/colour needs a price.');
    if (form.rows.some(r => r.salePrice !== '' && priceOk(r.regularPrice) && Number(r.salePrice) >= Number(r.regularPrice))) problems.push('A sale price must be lower than the price.');
  } else {
    if (!priceOk(form.regularPrice)) problems.push('Enter a price.');
    if (form.salePrice !== '' && Number(form.salePrice) >= Number(form.regularPrice)) problems.push('The sale price must be lower than the price.');
  }

  async function save() {
    if (problems.length || busy || uploading) return;
    setBusy(true); setError('');
    const usable = form.attributes.filter(a => a.name.trim() && a.options.length).map(a => ({ name: a.name.trim(), options: a.options }));
    const body = {
      key, name: form.name.trim(), description: form.description, categoryIds: form.categoryIds, newCategory: form.newCategory.trim(),
      images: form.images.map(i => ({ id: i.id })), sku: form.sku.trim(), hasOptions: form.hasOptions,
      regularPrice: form.hasOptions ? '' : form.regularPrice.trim(), salePrice: form.hasOptions ? '' : form.salePrice.trim(),
      stock: form.hasOptions ? 0 : Number(form.stock || 0),
      attributes: form.hasOptions ? usable : [],
      variations: form.hasOptions ? form.rows.filter(r => r.enabled || r.existing).map(r => ({
        ...(r.id ? { id: r.id } : {}), attributes: Object.fromEntries(usable.map(a => [a.name, r.attributes[a.name]])), sku: r.sku.trim(),
        regularPrice: String(r.regularPrice).trim(), salePrice: String(r.salePrice || '').trim(), stock: Number(r.stock || 0), imageId: r.imageId || null, enabled: r.enabled,
      })) : [],
      ...(productId ? { expectedModified: form.modified || '' } : {}),
    };
    try {
      const result = productId ? await api(`/products/${productId}`, { method: 'PUT', body }) : await api('/products', { method: 'POST', body });
      for (const w of result.warnings || []) notify(w, 'error');
      notify(productId ? `${body.name} updated on the website and in the POS.` : demo ? `${body.name} added to the demo catalogue.` : `${body.name} is published on the website and ready to sell in the POS.`);
      onSaved?.(result.productId);
      onClose();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const categories = setup.categories;
  const suggestions = setup.suggestions || [];
  return <Modal title={productId ? 'Edit product' : 'Add product'} subtitle={productId ? form.name : demo ? 'Practice only: your website is not changed.' : 'Published to the website and the POS when you save.'} wide busy={busy} onClose={onClose} className="product-editor-modal">
    <div className="modal-body product-editor">
      {!writes.enabled && <Notice tone="warning" icon={LockKeyhole}><strong>View only.</strong> {writes.reason}</Notice>}

      <section className="pe-section" aria-labelledby="pe-photos"><h3 id="pe-photos">Photos</h3>
        {!writes.photos && writes.enabled && <Notice tone="warning">{writes.photosReason}</Notice>}
        <div className="pe-photos">
          {form.images.map((image, index) => <figure key={image.id} className={index === 0 ? 'main' : ''}>
            {image.src ? <img src={image.src} alt={`Product photo ${index + 1}`} /> : <span className="pe-photo-missing">Photo {index + 1}</span>}
            {index === 0 ? <figcaption>Main photo</figcaption> : <button type="button" className="pe-photo-action" onClick={() => set({ images: [image, ...form.images.filter(i => i !== image)] })} aria-label={`Make photo ${index + 1} the main photo`}><Star size={14} /></button>}
            <button type="button" className="pe-photo-remove" onClick={() => set({ images: form.images.filter(i => i !== image), rows: form.rows.map(r => r.imageId === image.id ? { ...r, imageId: null } : r) })} aria-label={`Remove photo ${index + 1}`}><X size={14} /></button>
          </figure>)}
          {uploading > 0 && <figure className="pe-uploading"><Spinner label={`Uploading ${uploading}…`} /></figure>}
          {form.images.length < MAX_PHOTOS && writes.enabled && writes.photos && <div className="pe-photo-buttons">
            <button type="button" className="button secondary" onClick={() => camera.current?.click()}><Camera size={16} />Take photo</button>
            <button type="button" className="button secondary" onClick={() => files.current?.click()}><ImagePlus size={16} />Choose photos</button>
          </div>}
        </div>
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={e => { addPhotos(e.target.files); e.target.value = ''; }} />
        <input ref={files} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={e => { addPhotos(e.target.files); e.target.value = ''; }} />
        <p className="field-hint">The first photo is the main one on the website. Photos are resized automatically before upload.</p>
      </section>

      <section className="pe-section form-stack" aria-labelledby="pe-details"><h3 id="pe-details">Details</h3>
        <label>Product name<input className="input" maxLength={200} value={form.name} onChange={e => set({ name: e.target.value })} placeholder="e.g. Amara Wrap Dress" /></label>
        <div className="pe-field"><span className="pe-label">Categories</span>
          <div className="pe-chips">{form.categoryIds.map(id => <span className="pe-chip" key={id}>{categories.find(c => c.id === id)?.name || `#${id}`}<button type="button" aria-label="Remove category" onClick={() => set({ categoryIds: form.categoryIds.filter(x => x !== id) })}><X size={12} /></button></span>)}</div>
          <div className="pe-row"><select className="select" aria-label="Add a category" value="" onChange={e => { const id = Number(e.target.value); if (id && !form.categoryIds.includes(id)) set({ categoryIds: [...form.categoryIds, id].slice(0, 10) }); }}>
            <option value="">Add a category…</option>{categories.filter(c => !form.categoryIds.includes(c.id)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <input className="input" maxLength={60} aria-label="New category name" placeholder="or type a new category" value={form.newCategory} onChange={e => set({ newCategory: e.target.value })} /></div>
        </div>
        <label>Description<textarea className="input" rows={4} maxLength={5000} value={form.description} onChange={e => set({ description: e.target.value })} placeholder="Fabric, fit, care…" /></label>
        <label>Product SKU (optional)<input className="input" maxLength={60} value={form.sku} onChange={e => set({ sku: e.target.value })} placeholder="e.g. AMARA" /></label>
      </section>

      <section className="pe-section" aria-labelledby="pe-type"><h3 id="pe-type">Sizes and colours</h3>
        {productId ? <p className="field-hint">{form.hasOptions ? 'This product has sizes/colours.' : 'This product is a single item.'}</p> :
          <div className="pe-type" role="group" aria-label="Product type">
            <button type="button" aria-pressed={form.hasOptions} className={form.hasOptions ? 'selected' : ''} onClick={() => set({ hasOptions: true })}>Has sizes / colours</button>
            <button type="button" aria-pressed={!form.hasOptions} className={!form.hasOptions ? 'selected' : ''} onClick={() => set({ hasOptions: false })}>Single item</button>
          </div>}

        {!form.hasOptions && <div className="pe-grid three">
          <label>Price (GH₵)<input className="input" inputMode="decimal" value={form.regularPrice} onChange={e => set({ regularPrice: cleanNumber(e.target.value) })} /></label>
          <label>Sale price (optional)<input className="input" inputMode="decimal" value={form.salePrice} onChange={e => set({ salePrice: cleanNumber(e.target.value) })} /></label>
          {productId ? <div className="pe-field"><span className="pe-label">In stock</span><strong>{form.stock}</strong><small className="field-hint">Change in Stock control</small></div>
            : <label>Starting stock<input className="input" inputMode="numeric" value={form.stock} onChange={e => set({ stock: e.target.value.replace(/\D/g, '') })} /></label>}
        </div>}

        {form.hasOptions && <>
          {form.attributes.map((a, index) => {
            const suggestion = suggestions.find(s => s.name.toLowerCase() === a.name.trim().toLowerCase() || (/^colou?r$/i.test(s.name) && /^colou?r$/i.test(a.name.trim())));
            return <div className="pe-attr" key={index}>
              <div className="pe-row"><input className="input pe-attr-name" maxLength={80} aria-label={`Option ${index + 1} name`} placeholder="Option name, e.g. Size" value={a.name} disabled={a.options.some(o => lockedOptions.has(`${a.name.toLowerCase()}|${o}`))} onChange={e => setAttr(index, { name: e.target.value })} />
                {form.attributes.length > 1 && !a.options.some(o => lockedOptions.has(`${a.name.toLowerCase()}|${o}`)) && <button type="button" className="icon-button" aria-label={`Remove option ${a.name || index + 1}`} onClick={() => set({ attributes: form.attributes.filter((_, i) => i !== index) })}><Trash2 size={16} /></button>}</div>
              <div className="pe-chips">{a.options.map(o => <span className="pe-chip selected" key={o}>{o}{!lockedOptions.has(`${a.name.toLowerCase()}|${o}`) && <button type="button" aria-label={`Remove ${o}`} onClick={() => setAttr(index, { options: a.options.filter(x => x !== o) })}><X size={12} /></button>}</span>)}
                <input className="input pe-chip-input" aria-label={`Add ${a.name || 'option'} value`} placeholder="Type a value, press Enter" onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addOption(index, e.currentTarget.value); e.currentTarget.value = ''; } }} onBlur={e => { if (e.currentTarget.value.trim()) { addOption(index, e.currentTarget.value); e.currentTarget.value = ''; } }} /></div>
              {suggestion && <div className="pe-suggest"><span>Quick add:</span>{suggestion.options.filter(o => !a.options.includes(o)).slice(0, 14).map(o => <button type="button" key={o} className="pe-chip" onClick={() => addOption(index, o)}>+ {o}</button>)}</div>}
            </div>;
          })}
          {form.attributes.length < 3 && <button type="button" className="text-button" onClick={() => set({ attributes: [...form.attributes, { name: '', options: [] }] })}><Plus size={14} />Add another option (e.g. Length)</button>}

          {form.rows.length > 0 && <>
            <div className="pe-defaults">
              <label>Price for all<input className="input" inputMode="decimal" value={defaults.price} onChange={e => setDefaults(d => ({ ...d, price: cleanNumber(e.target.value) }))} /></label>
              <label>Sale for all<input className="input" inputMode="decimal" value={defaults.sale} onChange={e => setDefaults(d => ({ ...d, sale: cleanNumber(e.target.value) }))} /></label>
              <label>Stock for each new<input className="input" inputMode="numeric" value={defaults.stock} onChange={e => setDefaults(d => ({ ...d, stock: e.target.value.replace(/\D/g, '') }))} /></label>
              <button type="button" className="button secondary" onClick={applyDefaults}>Apply to all</button>
              <button type="button" className="button secondary" onClick={autoSku} title="Fill empty SKUs from the product SKU and option codes"><Wand2 size={15} />Fill SKUs</button>
            </div>
            <div className="table-scroll" role="region" aria-label="Size and colour combinations" tabIndex={0}><table className="pe-table"><thead><tr><th>Sell</th><th>Option</th><th>SKU</th><th>Price</th><th>Sale</th><th>Stock</th>{form.images.length > 0 && <th>Photo</th>}</tr></thead><tbody>
              {form.rows.map((r, index) => {
                const label = names.map(n => r.attributes[n]).join(' / ');
                return <tr key={comboKey(r.attributes, names)} className={r.enabled ? '' : 'off'}>
                  <td><input type="checkbox" checked={r.enabled} aria-label={`Sell ${label}`} onChange={e => setRow(index, { enabled: e.target.checked })} /></td>
                  <td><strong>{label}</strong>{r.existing && !r.enabled && <small>Hidden from sale</small>}</td>
                  <td><input className="input" maxLength={60} aria-label={`SKU for ${label}`} value={r.sku} onChange={e => setRow(index, { sku: e.target.value })} /></td>
                  <td><input className="input pe-num" inputMode="decimal" aria-label={`Price for ${label}`} value={r.regularPrice} onChange={e => setRow(index, { regularPrice: cleanNumber(e.target.value) })} /></td>
                  <td><input className="input pe-num" inputMode="decimal" aria-label={`Sale price for ${label}`} value={r.salePrice} onChange={e => setRow(index, { salePrice: cleanNumber(e.target.value) })} /></td>
                  <td>{r.existing ? <span className="pe-stock" title="Change existing stock in Stock control">{r.stock}</span> : <input className="input pe-num" inputMode="numeric" aria-label={`Stock for ${label}`} value={r.stock} onChange={e => setRow(index, { stock: e.target.value.replace(/\D/g, '') })} />}</td>
                  {form.images.length > 0 && <td><select className="select pe-num" aria-label={`Photo for ${label}`} value={r.imageId || ''} onChange={e => setRow(index, { imageId: Number(e.target.value) || null })}><option value="">Main</option>{form.images.map((img, i) => <option key={img.id} value={img.id}>Photo {i + 1}</option>)}</select></td>}
                </tr>;
              })}
            </tbody></table></div>
            <p className="field-hint">{enabledRows.length} of {form.rows.length} combinations for sale{productId ? '. Existing stock is changed in Stock control; unticking an existing option hides it from sale.' : '.'}</p>
          </>}
        </>}
      </section>

      {problems.length > 0 && (form.name || form.rows.length) ? <ul className="pe-problems">{problems.map(p => <li key={p}>{p}</li>)}</ul> : null}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
    <div className="modal-footer" role="group" aria-label="Product actions">
      {form.hasOptions && enabledRows.length > 0 && <span className="pe-summary">{enabledRows.length} {enabledRows.length === 1 ? 'option' : 'options'}{prices.length ? ` · from ${money(Math.min(...prices))}` : ''}</span>}
      <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="button primary" onClick={save} disabled={!writes.enabled || busy || uploading > 0 || problems.length > 0}>{busy ? 'Saving…' : productId ? 'Save changes' : demo ? 'Add to demo' : 'Publish product'}</button>
    </div>
  </Modal>;
}
