/* Mansutrendzgh storefront demo core: catalogue search, facets, bag, WhatsApp order.
   No dependencies. PRODUCTS is injected by build.py. */
const Shop = (() => {
  const P = PRODUCTS;
  const WA = '233545396555';
  const CATS = ['Dresses', 'Two-Piece Sets', 'Tops & Shirts', 'Trousers & Skirts', 'Kaftans & Abayas'];
  const OCCASIONS = ['Office', 'Church & Events', 'Evening', 'Weekend'];
  const SIZE_ORDER = ['S', 'M', 'L', 'XL', '2XL', '3XL', 'Free'];
  const PRICE_BANDS = [
    { id: 'u300', label: 'Under GH₵ 300', test: (n) => n < 300 },
    { id: '300-400', label: 'GH₵ 300–400', test: (n) => n >= 300 && n <= 400 },
    { id: 'o400', label: 'Over GH₵ 400', test: (n) => n > 400 },
  ];
  const SWATCH = {
    Black: '#1b1b1b', White: '#f7f7f5', Red: '#c62828', Green: '#2e7d4f', Yellow: '#f3d250', 'Butter Yellow': '#f6e39a',
    Blue: '#5b86c9', 'Sky Blue': '#9cc7ea', 'Denim Blue': '#5d7ea6', Navy: '#1f2f56', 'Navy Blue': '#1f2f56', Pink: '#efa7bd',
    Fuchsia: '#d81b72', Blush: '#e9c3c3', Brown: '#7a4a2a', Chocolate: '#5a3424', Coffee: '#6f4e37', Wine: '#6d1a2f',
    Grey: '#9a9a9a', Gold: '#c9a24a', Lilac: '#b9a6dc', Orange: '#e8742c', Taupe: '#a39383', Nude: '#d9b99b',
    'Black/Silver': 'linear-gradient(135deg,#1b1b1b 50%,#c0c0c0 50%)', Multi: 'conic-gradient(#d33,#fc3,#3a7,#36c,#d33)',
    Floral: 'conic-gradient(#e7a,#fd8,#9c7,#e7a)', 'As shown': 'linear-gradient(135deg,#ddd,#999)',
  };
  P.forEach((p) => {
    p.sizes = p.sizes.map((s) => (s === 'Free size' ? 'Free' : s));
    p.colours = [...new Set(p.colours.map((c) => ({ 'Navy Blue': 'Navy', Coffee: 'Chocolate', Nude: 'Taupe' }[c] || c)))];
  });

  const money = (n) => 'GH₵ ' + Number(n).toLocaleString('en-GH');
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const SYN = {
    trouser: 'pant', trousers: 'pant', pants: 'pant', jean: 'denim', jeans: 'denim', blouse: 'top', tops: 'top',
    shirts: 'shirt', dresses: 'dress', gown: 'dress', maxi: 'maxi', sets: 'set', 'two-piece': 'set', twopiece: 'set',
    coord: 'set', 'co-ord': 'set', kaftans: 'kaftan', caftan: 'kaftan', abayas: 'abaya', skirts: 'skirt',
    church: 'church', office: 'office', work: 'office', party: 'evening', night: 'evening', wedding: 'events',
    casual: 'weekend', yellow: 'yellow', pink: 'pink', grey: 'grey', gray: 'grey',
  };
  const hay = (p) => norm([p.name, p.cat, p.occ.join(' '), p.colours.join(' '), p.isNew ? 'new' : ''].join(' '));
  P.forEach((p) => (p._h = hay(p)));
  const tokens = (q) => norm(q).split(/[^a-z0-9-]+/).filter(Boolean).map((t) => SYN[t] || t.replace(/s$/, ''));
  const matches = (p, q) => !q || tokens(q).every((t) => p._h.includes(t));

  /* state: { q, cat, occ:Set, size:Set, colour:Set, band, newOnly, sort } */
  function pass(p, st, skip) {
    if (skip !== 'q' && !matches(p, st.q || '')) return false;
    if (skip !== 'cat' && st.cat && p.cat !== st.cat) return false;
    if (skip !== 'occ' && st.occ && st.occ.size && !p.occ.some((o) => st.occ.has(o))) return false;
    if (skip !== 'size' && st.size && st.size.size && !p.sizes.some((s) => st.size.has(s))) return false;
    if (skip !== 'colour' && st.colour && st.colour.size && !p.colours.some((c) => st.colour.has(c))) return false;
    if (skip !== 'band' && st.band) { const b = PRICE_BANDS.find((x) => x.id === st.band); if (b && !b.test(p.price)) return false; }
    if (skip !== 'newOnly' && st.newOnly && !p.isNew) return false;
    return true;
  }
  function results(st) {
    const r = P.filter((p) => pass(p, st));
    const s = st.sort || 'featured';
    if (s === 'price-asc') r.sort((a, b) => a.price - b.price);
    if (s === 'price-desc') r.sort((a, b) => b.price - a.price);
    if (s === 'newest') r.sort((a, b) => b.id - a.id);
    return r;
  }
  /* Facet counts: how many products each option would show, given every other active filter. */
  function facet(st, key) {
    const base = P.filter((p) => pass(p, st, key));
    const m = new Map();
    const add = (k) => m.set(k, (m.get(k) || 0) + 1);
    base.forEach((p) => {
      if (key === 'cat') add(p.cat);
      if (key === 'occ') p.occ.forEach(add);
      if (key === 'size') p.sizes.forEach(add);
      if (key === 'colour') p.colours.forEach(add);
      if (key === 'band') PRICE_BANDS.forEach((b) => b.test(p.price) && add(b.id));
    });
    return m;
  }
  const allColours = [...new Set(P.flatMap((p) => p.colours))].filter((c) => c !== 'As shown').sort();
  const allSizes = SIZE_ORDER.filter((s) => P.some((p) => p.sizes.includes(s)));
  const byId = (id) => P.find((p) => p.id === +id);
  const suggest = (q, n = 6) => (q.trim() ? P.filter((p) => matches(p, q)).slice(0, n) : []);
  const catSuggest = (q) => (q.trim() ? CATS.filter((c) => tokens(q).some((t) => norm(c).includes(t))) : []);

  /* Bag, kept in this browser only */
  const KEY = 'mansu-demo-bag';
  let bag = [];
  try { bag = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { bag = []; }
  const subs = [];
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(bag)); } catch (e) {} subs.forEach((f) => f(bag)); };
  const bagApi = {
    items: () => bag.map((l) => ({ ...l, p: byId(l.id) })).filter((l) => l.p),
    count: () => bag.reduce((a, l) => a + l.qty, 0),
    total: () => bag.reduce((a, l) => a + l.qty * (byId(l.id)?.price || 0), 0),
    add(id, size, colour) {
      const l = bag.find((x) => x.id === id && x.size === size && x.colour === colour);
      l ? l.qty++ : bag.push({ id, size, colour, qty: 1 });
      save();
    },
    setQty(i, q) { if (q <= 0) bag.splice(i, 1); else bag[i].qty = q; save(); },
    on: (f) => subs.push(f),
  };
  function waLink(lines) {
    const L = lines || bagApi.items();
    const body = L.length
      ? 'Hello Mansutrendzgh, I would like to order:\n' +
        L.map((l) => `• ${l.p.name} (${l.colour}, size ${l.size}) × ${l.qty} = ${money(l.p.price * l.qty)}`).join('\n') +
        `\nTotal: ${money(L.reduce((a, l) => a + l.p.price * l.qty, 0))}\nDelivery area: `
      : 'Hello Mansutrendzgh, I have a question about an item.';
    return `https://wa.me/${WA}?text=${encodeURIComponent(body)}`;
  }
  const alt = (p) => `${p.name} in ${p.colours[0].toLowerCase()}, ${p.cat.toLowerCase()}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* Quick view: a native <dialog> (focus is trapped and restored by the browser). */
  function quickView(dlg, id, opts = {}) {
    const p = byId(id);
    let size = p.sizes.length === 1 ? p.sizes[0] : null;
    let colour = p.colours[0];
    dlg.innerHTML = `
      <form method="dialog" class="qv">
        <button class="qv-x" value="close" aria-label="Close">×</button>
        <div class="qv-media">
          <img src="${p.img}" alt="${esc(alt(p))}" width="480" height="638">
          ${p.img2 ? `<img src="${p.img2}" alt="${esc(p.name)}, second view" width="480" height="638" loading="lazy">` : ''}
        </div>
        <div class="qv-info">
          <p class="qv-cat">${p.cat}${p.isNew ? ' · New in' : ''}</p>
          <h2 id="qv-title">${esc(p.name)}</h2>
          <p class="qv-price">${money(p.price)}</p>
          <fieldset class="qv-opts"><legend>Colour: <b data-colour>${esc(colour)}</b></legend>
            ${p.colours.map((c, i) => `<label class="sw"><input type="radio" name="colour" value="${esc(c)}" ${i ? '' : 'checked'}><span style="background:${SWATCH[c] || '#bbb'}" title="${esc(c)}"></span><span class="vh">${esc(c)}</span></label>`).join('')}
          </fieldset>
          <fieldset class="qv-opts"><legend>Size${size ? ': <b>' + size + '</b>' : ''}</legend>
            ${p.sizes.map((s) => `<label class="sz"><input type="radio" name="size" value="${s}" ${size === s ? 'checked' : ''}><span>${s}</span></label>`).join('')}
          </fieldset>
          <p class="qv-msg" role="status" aria-live="polite"></p>
          <div class="qv-cta">
            <button type="button" class="btn-primary" data-add>Add to bag</button>
            <a class="btn-ghost" target="_blank" rel="noopener" data-wa href="#">Ask on WhatsApp</a>
          </div>
          <ul class="qv-notes">
            <li>Delivery across Ghana, or collect from our Accra showroom</li>
            <li>Wholesale prices for boutiques on request</li>
          </ul>
          <a class="qv-link" href="${p.url}" target="_blank" rel="noopener">View on the live shop ↗</a>
        </div>
      </form>`;
    dlg.setAttribute('aria-labelledby', 'qv-title');
    const msg = dlg.querySelector('.qv-msg');
    const wa = dlg.querySelector('[data-wa]');
    const upd = () => (wa.href = waLink([{ p, size: size || 'to confirm', colour, qty: 1 }]));
    dlg.querySelectorAll('input[name=colour]').forEach((r) => r.addEventListener('change', () => { colour = r.value; dlg.querySelector('[data-colour]').textContent = colour; upd(); }));
    dlg.querySelectorAll('input[name=size]').forEach((r) => r.addEventListener('change', () => { size = r.value; msg.textContent = ''; upd(); }));
    dlg.querySelector('[data-add]').addEventListener('click', () => {
      if (!size) { msg.textContent = 'Choose a size first.'; dlg.querySelector('input[name=size]').focus(); return; }
      bagApi.add(p.id, size, colour);
      dlg.close();
      opts.onAdd && opts.onAdd(p, size);
    });
    upd();
    dlg.showModal();
  }

  /* Hash routing for shareable filtered views: #cat-dresses, #occ-office, #new */
  const slug = (s) => norm(s).replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  function readHash(st) {
    const h = location.hash.slice(1);
    const c = CATS.find((x) => 'cat-' + slug(x) === h);
    const o = OCCASIONS.find((x) => 'occ-' + slug(x) === h);
    if (c) st.cat = c;
    if (o) st.occ = new Set([o]);
    if (h === 'new') st.newOnly = true;
    return !!(c || o || h === 'new');
  }

  return { P, CATS, OCCASIONS, PRICE_BANDS, SWATCH, money, results, facet, allColours, allSizes, byId, suggest, catSuggest,
    bag: bagApi, waLink, alt, esc, quickView, slug, readHash, WA_DISPLAY: '+233 54 539 6555' };
})();
