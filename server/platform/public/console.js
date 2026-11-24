'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'class') node.className = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v); }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child.nodeType ? child : String(child));
    return node;
  };
  const day = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const when = iso => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const api = async (url, body) => {
    const res = await fetch(`/api/console${url}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/login') { showLogin(); throw new Error('Signed out.'); }
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  };
  const showError = message => { $('error').textContent = message; $('error').hidden = !message; };
  const VIEWS = ['shops', 'health', 'feedback', 'invites', 'audit'];
  const money = pesewas => `GH₵${(Number(pesewas || 0) / 100).toFixed(2)}`;
  let shops = [];
  function showLogin() { $('app').hidden = true; $('login-view').hidden = false; }
  async function start() {
    try {
      const me = await api('/me');
      $('who').textContent = me.admin.username;
      $('login-view').hidden = true; $('app').hidden = false;
      await loadShops();
    } catch { showLogin(); }
  }
  $('login').addEventListener('submit', async event => {
    event.preventDefault();
    const f = event.target, err = $('login-error');
    err.hidden = true;
    try { await api('/login', { username: f.username.value, password: f.password.value, code: f.code.value.trim() }); f.reset(); await start(); }
    catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  $('logout').addEventListener('click', async () => { await api('/logout', {}).catch(() => {}); showLogin(); });
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
    for (const b of document.querySelectorAll('[data-view]')) b.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'page');
    const view = button.dataset.view;
    for (const name of VIEWS) $(`${name}-view`).hidden = name !== view;
    $('detail').hidden = true;
    ({ shops: loadShops, health: loadHealth, feedback: loadFeedback, invites: loadInvites, audit: loadAudit })[view]();
  });
  $('filter').addEventListener('input', renderShops);

  async function loadShops() {
    showError('');
    try { shops = (await api('/shops')).shops; renderShops(); } catch (e) { showError(e.message); }
  }
  function renderShops() {
    const q = $('filter').value.trim().toLowerCase();
    const list = shops.filter(s => !q || [s.name, s.slug, s.owner.email].some(v => String(v || '').toLowerCase().includes(q)));
    const count = state => shops.filter(s => s.access.state === state).length;
    $('stats').replaceChildren(...[['Shops', shops.length], ['Paying', count('active')], ['On trial', count('trial')], ['Payment due', count('grace')], ['Lapsed', count('lapsed')], ['Selling', shops.filter(s => s.stage === 'selling').length]]
      .map(([label, value]) => el('div', {}, el('strong', {}, value), el('span', {}, label))));
    $('shops').replaceChildren(...list.map(s => el('tr', { onclick: () => openShop(s.id), tabindex: '0', onkeydown: e => { if (e.key === 'Enter') openShop(s.id); } },
      el('td', {}, el('strong', {}, s.name), el('small', {}, s.slug)),
      el('td', {}, el('span', { class: `pill ${s.status}` }, s.status), el('small', {}, s.stage.replace('_', ' '))),
      el('td', {}, el('span', { class: `pill ${s.access.state}` }, s.access.state), el('small', {}, s.access.until ? `until ${day(s.access.until)}` : '')),
      el('td', {}, s.access.plan),
      el('td', {}, s.owner.name || '—', el('small', {}, s.owner.email || '')),
      el('td', {}, s.connected ? 'connected' : 'not connected', el('small', {}, s.healthOk === null ? '' : s.healthOk ? 'check passed' : 'check failing')),
      el('td', {}, day(s.createdAt)))));
  }
  async function openShop(id) {
    showError('');
    let data;
    try { data = await api(`/shops/${encodeURIComponent(id)}`); } catch (e) { return showError(e.message); }
    const s = data.shop;
    const act = body => async event => {
      event.preventDefault();
      try { await api(`/shops/${encodeURIComponent(id)}/actions`, body(event.target)); await loadShops(); await openShop(id); }
      catch (e) { showError(e.message); }
    };
    const plans = () => el('select', { name: 'plan' }, ['starter', 'growth', 'pro'].map(p => el('option', { value: p }, p)));
    const intervals = () => el('select', { name: 'interval' }, el('option', { value: 'monthly' }, 'monthly'), el('option', { value: 'annually' }, 'annually'));
    const note = (required, placeholder) => el('input', { name: 'note', placeholder, ...(required ? { required: '' } : {}), maxlength: '200' });
    $('detail').replaceChildren(
      el('div', {}, el('button', { type: 'button', class: 'link', onclick: () => { $('detail').hidden = true; $('shops-view').hidden = false; } }, '← All shops')),
      el('h2', { id: 'detail-title' }, s.name),
      el('div', { class: 'detail-grid' },
        ...[['Address', s.url], ['Store', s.storeUrl], ['Status', `${s.status} · ${s.stage.replace('_', ' ')}`], ['Access', `${s.access.state}${s.access.until ? ` until ${day(s.access.until)}` : ''}`],
          ['Plan', `${s.access.plan}${s.billing.autoRenew ? ' · auto-renew' : ''}`], ['Founding price', s.billing.discount ? `${s.billing.discount.percent}% off until ${day(s.billing.discount.until)}` : 'none'], ['Paid until', day(s.billing.paidUntil)], ['Trial ends', day(s.trialEndsAt)],
          ['Owner', `${s.owner.name || '—'} ${s.owner.email || ''} ${s.owner.phone || ''}`], ['Created', day(s.createdAt)]]
          .map(([k, v]) => el('div', {}, el('span', {}, k), v))),
      el('div', { class: 'actions' },
        el('form', { onsubmit: act(() => ({ action: s.status === 'suspended' ? 'resume' : 'suspend', note: '' })) }, el('h3', {}, s.status === 'suspended' ? 'Resume shop' : 'Suspend shop'), el('button', { type: 'submit' }, s.status === 'suspended' ? 'Resume' : 'Suspend')),
        el('form', { onsubmit: act(f => ({ action: 'record_payment', plan: f.plan.value, interval: f.interval.value, note: f.note.value })) }, el('h3', {}, 'Record a payment (invoice)'), plans(), intervals(), note(true, 'Invoice / receipt number'), el('button', { type: 'submit' }, 'Record payment')),
        el('form', { onsubmit: act(f => ({ action: 'extend_trial', days: Number(f.days.value), note: f.note.value })) }, el('h3', {}, 'Extend trial'), el('input', { name: 'days', type: 'number', min: '1', max: '90', value: '7' }), note(false, 'Reason (optional)'), el('button', { type: 'submit' }, 'Extend')),
        el('form', { onsubmit: act(f => ({ action: 'set_plan', plan: f.plan.value, note: f.note.value })) }, el('h3', {}, 'Change plan'), plans(), note(false, 'Reason (optional)'), el('button', { type: 'submit' }, 'Set plan')),
        el('form', { onsubmit: act(f => ({ action: 'discount', percent: Number(f.percent.value), months: Number(f.months.value), note: f.note.value })) }, el('h3', {}, 'Founding price'),
          el('label', {}, 'Percent off', el('input', { name: 'percent', type: 'number', min: '0', max: '90', value: String(s.billing.discount?.percent || 0) })),
          el('label', {}, 'For months from today (0 ends it)', el('input', { name: 'months', type: 'number', min: '0', max: '24', value: s.billing.discount ? '6' : '0' })),
          note(false, 'Reason (optional)'), el('button', { type: 'submit' }, 'Save price')),
        el('form', { onsubmit: act(f => ({ action: 'comp', on: s.access.state !== 'comped', note: f.note.value })) }, el('h3', {}, s.access.state === 'comped' ? 'End complimentary' : 'Make complimentary'), note(true, 'Reason'), el('button', { type: 'submit' }, s.access.state === 'comped' ? 'End' : 'Make complimentary'))),
      el('h3', {}, 'Billing events'),
      el('div', { class: 'table-wrap' }, el('table', {}, el('tbody', {}, data.events.length ? data.events.map(e => el('tr', {}, el('td', {}, when(e.at)), el('td', {}, e.kind), el('td', {}, e.amount ? `GH₵${(e.amount / 100).toFixed(2)}` : ''), el('td', {}, e.detail))) : el('tr', {}, el('td', {}, 'None yet.'))))),
      el('h3', {}, 'Recent activity'),
      el('div', { class: 'table-wrap' }, el('table', {}, el('tbody', {}, data.audit.map(a => el('tr', {}, el('td', {}, when(a.at)), el('td', {}, a.actor), el('td', {}, a.action), el('td', {}, a.detail)))))));
    $('shops-view').hidden = true; $('detail').hidden = false;
  }
  async function loadHealth() {
    showError('');
    try {
      const list = (await api('/health')).shops;
      $('health').replaceChildren(...(list.length ? list.map(h => el('tr', { onclick: () => openShop(h.id), tabindex: '0', onkeydown: e => { if (e.key === 'Enter') openShop(h.id); } },
        el('td', {}, el('strong', {}, h.name), el('small', {}, `${h.stage.replace('_', ' ')} · ${h.access}`)),
        ...(h.metrics.available ? [
          el('td', {}, `${h.metrics.salesToday} sales`, el('small', {}, money(h.metrics.takingsToday))),
          el('td', {}, `${h.metrics.sales7d} sales`, el('small', {}, money(h.metrics.takings7d))),
          el('td', {}, when(h.metrics.lastSaleAt)),
          el('td', {}, h.metrics.needsAttention ? el('span', { class: 'pill lapsed' }, h.metrics.needsAttention) : '0'),
          el('td', {}, h.metrics.openShifts), el('td', {}, h.metrics.staff, el('small', {}, `signed in ${when(h.metrics.lastSignInAt)}`)),
        ] : [el('td', { colspan: '6' }, 'No data yet')]),
        el('td', {}, h.flags.length ? h.flags.map(f => el('span', { class: `flag ${f.level}` }, f.text)) : el('small', {}, 'All good'))))
        : [el('tr', {}, el('td', { colspan: '8' }, 'No shops yet.'))]));
    } catch (e) { showError(e.message); }
  }
  $('feedback-status').addEventListener('change', () => loadFeedback());
  async function loadFeedback() {
    showError('');
    try {
      const { feedback } = await api(`/feedback?status=${encodeURIComponent($('feedback-status').value)}`);
      $('feedback').replaceChildren(...(feedback.length ? feedback.map(f => {
        const card = el('article', { class: `feedback-card ${f.kind}` },
          el('header', {}, el('span', { class: `pill ${f.kind === 'problem' ? 'lapsed' : f.kind === 'idea' ? 'active' : 'trial'}` }, f.kind),
            el('strong', {}, f.shop || f.shopId), el('small', {}, `${f.fromUser} (${f.fromRole})${f.page ? ` · ${f.page}` : ''} · ${when(f.createdAt)}`)),
          el('p', { class: 'message' }, f.message));
        if (f.status === 'resolved') card.append(el('p', { class: 'reply' }, el('strong', {}, `Reply by ${String(f.resolvedBy || '').replace('admin:', '')}: `), f.reply || '(no reply, marked resolved)'));
        else card.append(el('form', { onsubmit: async event => {
          event.preventDefault();
          try { await api(`/feedback/${f.id}/resolve`, { reply: event.target.reply.value }); await loadFeedback(); } catch (e) { showError(e.message); }
        } }, el('label', {}, 'Reply to the shop (they see it on their Feedback page)', el('textarea', { name: 'reply', maxlength: '500', rows: '2' })), el('button', { type: 'submit' }, 'Resolve')));
        return card;
      }) : [el('p', { class: 'hint' }, 'Nothing here.')]));
    } catch (e) { showError(e.message); }
  }
  async function loadInvites() {
    showError('');
    try {
      const { invites, mode } = await api('/invites');
      $('invite-mode').textContent = mode === 'invite' ? 'Sign-up is invitation-only. Each code works once.' : 'Sign-up is open to anyone; codes still apply a founding price.';
      $('invites').replaceChildren(...(invites.length ? invites.map(i => el('tr', {},
        el('td', {}, `…${i.hint}`), el('td', {}, i.email || 'any email', el('small', {}, i.note || '')),
        el('td', {}, i.discountPercent ? `${i.discountPercent}% for ${i.discountMonths} months` : '—'),
        el('td', {}, el('span', { class: `pill ${i.status === 'open' ? 'trial' : i.status === 'used' ? 'active' : 'lapsed'}` }, i.status), el('small', {}, i.usedAt ? when(i.usedAt) : '')),
        el('td', {}, day(i.createdAt), el('small', {}, String(i.createdBy || '').replace('admin:', ''))), el('td', {}, day(i.expiresAt)),
        el('td', {}, i.status === 'open' ? el('button', { type: 'button', class: 'link', onclick: async () => {
          if (!window.confirm('Revoke this invitation? It will stop working.')) return;
          try { await api(`/invites/${encodeURIComponent(i.id)}/revoke`, {}); await loadInvites(); } catch (e) { showError(e.message); }
        } }, 'Revoke') : '')))
        : [el('tr', {}, el('td', { colspan: '7' }, 'No invitations yet.'))]));
    } catch (e) { showError(e.message); }
  }
  $('invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const f = event.target, made = $('invite-made');
    made.hidden = true; showError('');
    try {
      const result = await api('/invites', { email: f.email.value.trim(), note: f.note.value, discountPercent: Number(f.discountPercent.value || 0), discountMonths: Number(f.discountMonths.value || 0), days: Number(f.days.value || 30) });
      const copy = text => el('button', { type: 'button', class: 'link', onclick: () => navigator.clipboard?.writeText(text) }, 'Copy');
      made.replaceChildren(el('p', {}, el('strong', {}, 'Send this now. It is shown only once.')),
        el('p', {}, 'Code: ', el('code', {}, result.code), ' ', copy(result.code)),
        el('p', {}, 'Sign-up link: ', el('code', {}, result.signupUrl), ' ', copy(result.signupUrl)));
      made.hidden = false; f.reset();
      await loadInvites();
    } catch (e) { showError(e.message); }
  });
  async function loadAudit() {
    try {
      const { audit } = await api('/audit?limit=200');
      const names = Object.fromEntries(shops.map(s => [s.id, s.slug]));
      $('audit').replaceChildren(...audit.map(a => el('tr', {}, el('td', {}, when(a.at)), el('td', {}, a.actor), el('td', {}, a.action), el('td', {}, names[a.shopId] || ''), el('td', {}, a.detail))));
    } catch (e) { showError(e.message); }
  }
  start();
})();
