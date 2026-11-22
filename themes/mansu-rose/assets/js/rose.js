/* Mansu Rosé front-end. Progressive enhancement only: every control below
   has a working link or form underneath it, so the shop works without JS. */
(() => {
  'use strict';
  const M = window.MANSU || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ajax = (ep) => (M.ajax || '').replace('%%endpoint%%', ep);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- Dialogs ---------- */
  const open = (id) => {
    const d = document.getElementById(id);
    if (!d || typeof d.showModal !== 'function') return false;
    if (!d.open) d.showModal();
    return true;
  };
  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open]');
    if (opener) {
      if (open(opener.dataset.open)) {
        e.preventDefault();
        if (opener.dataset.open === 'searchD') setTimeout(() => $('#q') && $('#q').focus(), 30);
      }
      return;
    }
    const closer = e.target.closest('[data-close]');
    if (closer) { const d = closer.closest('dialog'); d && d.close(); }
  });
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  /* ---------- Occasions mega menu ---------- */
  const mb = $('.mega-btn'), mg = $('#mega');
  if (mb && mg) {
    const set = (on) => { mg.hidden = !on; mb.setAttribute('aria-expanded', String(on)); };
    mb.addEventListener('click', () => set(mg.hidden));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mg.hidden) { set(false); mb.focus(); } });
    document.addEventListener('click', (e) => { if (!e.target.closest('.main-nav')) set(false); });
  }

  /* ---------- Toast ---------- */
  const toastEl = $('#toast');
  let tt;
  const toast = (msg) => {
    if (!toastEl) return;
    $('.toast-t', toastEl).textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(tt);
    tt = setTimeout(() => toastEl.classList.remove('on'), 3500);
  };

  /* ---------- Predictive search ---------- */
  const q = $('#q');
  if (q && M.ajax) {
    const info = $('#searchD .s-info'), cats = $('#searchD .s-cats'), sugg = $('#searchD .sugg');
    let timer, ctrl;
    const run = () => {
      const v = q.value.trim();
      if (v.length < 2) { info.textContent = ''; cats.innerHTML = ''; sugg.innerHTML = ''; return; }
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      fetch(ajax('mansu_search') + '&q=' + encodeURIComponent(v), { signal: ctrl.signal, credentials: 'same-origin' })
        .then((r) => r.json())
        .then((d) => {
          const all = M.search + '?s=' + encodeURIComponent(v) + '&post_type=product';
          info.innerHTML = d.total
            ? `${esc((d.total === 1 ? M.i18n.result : M.i18n.results).replace('%d', d.total))} · <a class="link-u" href="${esc(all)}">${esc(M.i18n.seeAll)}</a>`
            : esc(M.i18n.none.replace('%s', v));
          cats.innerHTML = d.cats.map((c) => `<a class="pill" href="${esc(c.url)}">${esc(c.name)}</a>`).join('');
          sugg.innerHTML = d.products.map((p) => `<a href="${esc(p.url)}" data-qv="${p.id}"><img src="${esc(p.img)}" alt="" width="240" height="320" loading="lazy"><span>${esc(p.name)}</span><small>${esc(p.price)}</small></a>`).join('');
        })
        .catch(() => {});
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
    $$('#searchD [data-pop]').forEach((b) => b.addEventListener('click', () => { q.value = b.dataset.pop; run(); q.focus(); }));
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName) && !$('dialog[open]')) { e.preventDefault(); open('searchD'); q.focus(); }
    });
  }

  /* ---------- Quick view ---------- */
  const qv = $('#qvD');
  const body = qv && $('.qv-body', qv);
  const initForm = (root) => {
    const jq = window.jQuery;
    if (!jq) return;
    jq(root).find('.variations_form').each(function () {
      if (typeof jq.fn.wc_variation_form === 'function') jq(this).wc_variation_form();
      jq(this).trigger('check_variations');
    });
    jq(document.body).trigger('mansu_quick_view_loaded', [root]);
  };
  const showQuickView = (id, fallbackUrl) => {
    if (!qv || !M.ajax) { if (fallbackUrl) location.href = fallbackUrl; return; }
    body.innerHTML = `<p class="qv-loading">${esc(M.i18n.loading)}</p>`;
    $$('dialog[open]').forEach((d) => d !== qv && d.close());
    open('qvD');
    fetch(ajax('mansu_quick_view') + '&id=' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) throw new Error('qv');
        body.innerHTML = d.data.html;
        initForm(body);
        const first = $('select, input[type=radio], button[type=submit]', body);
        if (first) first.focus();
      })
      .catch(() => { if (fallbackUrl) location.href = fallbackUrl; else qv.close(); });
  };
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-qv]');
    if (!t) return;
    e.preventDefault();
    showQuickView(t.dataset.qv, t.getAttribute('href') || '');
  });

  /* Add to cart from quick view, keeping the shopper on the page. */
  /* Add to bag from quick view or a product page without leaving it, then open the bag
     drawer, whose main button is Checkout. Grouped products and failures fall back to
     WooCommerce's normal form submit. */
  const applyFragments = (frags) => {
    Object.keys(frags || {}).forEach((sel) => $$(sel).forEach((el) => { el.outerHTML = frags[sel]; }));
  };
  const showBag = () => {
    $$('dialog[open]').forEach((d) => d.id !== 'bagD' && d.close());
    if (!open('bagD')) toast(M.i18n.added);
  };
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form.cart');
    if (!form || !M.ajax) return;
    const inQv = !!form.closest('#qvD');
    if (!inQv && !form.closest('.single-product div.product')) return;
    if (form.querySelector('input[name^="quantity["]')) return; /* grouped product */
    e.preventDefault();
    let msg = inQv ? $('.qv-msg', qv) : form.parentNode.querySelector('.atc-msg');
    if (!msg && !inQv) {
      msg = document.createElement('p');
      msg.className = 'atc-msg qv-msg';
      msg.setAttribute('role', 'status');
      form.after(msg);
    }
    const btn = $('button[type=submit]', form);
    const vid = $('input[name=variation_id]', form);
    if (vid && !Number(vid.value)) { if (msg) msg.textContent = M.i18n.choose; return; }
    const data = new FormData(form);
    const pid = form.querySelector('[name=add-to-cart]');
    if (!data.get('product_id') && pid) data.set('product_id', pid.value);
    data.delete('add-to-cart');
    if (msg) msg.textContent = '';
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    fetch(ajax('mansu_add_to_cart'), { method: 'POST', body: data, credentials: 'same-origin' })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) { if (msg) msg.textContent = res.message || M.i18n.error; return; }
        applyFragments(res.fragments);
        if (window.jQuery) window.jQuery(document.body).trigger('added_to_cart', [res.fragments, res.cart_hash, window.jQuery(btn)]);
        showBag();
      })
      .catch(() => { if (!inQv) form.submit(); else if (msg) msg.textContent = M.i18n.error; })
      .finally(() => { if (btn) { btn.disabled = false; btn.classList.remove('loading'); } });
  });

  /* WooCommerce's own AJAX add-to-cart buttons (e.g. on simple products in lists) also open the bag. */
  if (window.jQuery) {
    window.jQuery(document.body).on('added_to_cart', (_e, _f, _h, $btn) => {
      const fromUs = $btn && $btn.closest && ($btn.closest('#qvD').length || $btn.closest('.single-product div.product').length);
      if (!fromUs) showBag();
    });
  }

  /* ---------- Filter drawer: send tidy URLs (comma lists, no empty fields) ---------- */
  const ff = $('#filterForm');
  if (ff) {
    ff.addEventListener('submit', (e) => {
      e.preventDefault();
      const params = new URLSearchParams();
      const groups = {};
      new FormData(ff).forEach((v, k) => {
        if (v === '') return;
        if (k.endsWith('[]')) (groups[k.slice(0, -2)] = groups[k.slice(0, -2)] || []).push(v);
        else params.set(k, v);
      });
      Object.keys(groups).forEach((k) => params.set(k, groups[k].join(',')));
      if (!groups.filter_size) params.delete('query_type_size');
      if (!groups.filter_color) params.delete('query_type_color');
      const qs = params.toString();
      location.href = ff.action + (qs ? (ff.action.includes('?') ? '&' : '?') + qs : '');
    });
  }

  /* ---------- Sticky toolbar offset follows the real header height ---------- */
  const hdr = $('.site-header');
  if (hdr && 'ResizeObserver' in window) {
    new ResizeObserver(() => document.documentElement.style.setProperty('--hdr', hdr.offsetHeight + 'px')).observe(hdr);
  }

  /* ---------- Style Finder (home page) ----------
     The form works on its own (GET to the shop). Here: live counts per answer,
     tap a chosen answer again to clear it, and a tidy URL on submit. */
  const fd = $('#finder');
  if (fd && M.ajax) {
    const btn = $('button[type=submit]', fd), count = $('.fcount', fd), thumbs = $('.fthumbs', fd);
    const KEYS = { occ: 'product_tag', size: 'filter_size', band: 'band' };
    let last = null, ctrl;
    const sel = () => {
      const p = new URLSearchParams();
      $$('input[type=radio]:checked', fd).forEach((r) => p.set(r.name, r.value));
      return p;
    };
    const paint = (d) => {
      last = d;
      Object.keys(KEYS).forEach((k) => {
        Object.keys(d[k] || {}).forEach((v) => {
          const lab = $(`.fopt[data-k="${KEYS[k]}"][data-v="${CSS.escape(v)}"]`, fd);
          if (!lab) return;
          const n = d[k][v], on = $('input', lab).checked;
          $('small', lab).textContent = n;
          lab.classList.toggle('zero', !n && !on);
        });
      });
      const answered = $$('input[type=radio]:checked', fd).length;
      $$('.fsteps span', fd).forEach((s, i) => s.classList.toggle('on', i < answered));
      count.textContent = d.total === 1 ? M.i18n.match1 : M.i18n.matchN.replace('%d', d.total);
      btn.textContent = d.total ? M.i18n.show.replace('%d', d.total) : M.i18n.fewer;
      btn.disabled = !d.total;
      thumbs.innerHTML = (d.thumbs || []).map((src) => `<img src="${esc(src)}" alt="" width="34" height="34">`).join('');
    };
    const refresh = () => {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      fd.setAttribute('aria-busy', 'true');
      fetch(ajax('mansu_finder') + '&' + sel().toString(), { signal: ctrl.signal, credentials: 'same-origin' })
        .then((r) => r.json()).then(paint).catch(() => {})
        .finally(() => fd.removeAttribute('aria-busy'));
    };
    /* Radios cannot normally be unchecked; let a second tap clear the answer. */
    fd.addEventListener('pointerdown', (e) => {
      const lab = e.target.closest('.fopt');
      if (lab) lab.dataset.was = $('input', lab).checked ? '1' : '';
    });
    fd.addEventListener('click', (e) => {
      const lab = e.target.closest('.fopt');
      if (!lab || e.target.tagName !== 'INPUT') return;
      if (lab.dataset.was === '1') { e.target.checked = false; lab.dataset.was = ''; refresh(); }
    });
    fd.addEventListener('change', refresh);
    fd.addEventListener('submit', (e) => {
      e.preventDefault();
      if (last && last.url) { location.href = last.url; return; }
      const p = sel();
      p.set('post_type', 'product');
      if (p.has('filter_size')) p.set('query_type_size', 'or');
      location.href = fd.action + (fd.action.includes('?') ? '&' : '?') + p.toString();
    });
  }

  /* Smooth in-page scrolling only when motion is welcome. */
  if (!reduce) document.documentElement.style.scrollBehavior = 'smooth';
})();
