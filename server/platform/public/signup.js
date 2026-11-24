'use strict';
(() => {
  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  };
  const verifyTitle = document.getElementById('verify-title');
  if (verifyTitle) {
    const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    history.replaceState(null, '', '/verify');
    const text = document.getElementById('verify-text'), link = document.getElementById('verify-link');
    if (!token) { verifyTitle.textContent = 'Link incomplete'; text.textContent = 'Open the link from your email again.'; return; }
    post('/api/signup/verify', { token }).then(data => {
      verifyTitle.textContent = data.already ? 'Your shop is ready' : 'Your shop is created';
      text.textContent = 'Sign in with the username and password you chose, then follow Shop setup to connect your store.';
      link.href = data.shopUrl; link.hidden = false;
    }).catch(error => { verifyTitle.textContent = 'We could not create the shop'; text.textContent = error.message; });
    return;
  }
  const form = document.getElementById('signup');
  if (!form) return;
  const host = location.hostname.replace(/^www\./, '');
  document.getElementById('slug-suffix').textContent = `.${host}`;
  const inviteField = document.getElementById('invite-field'), invite = form.elements.inviteCode;
  const fromLink = new URLSearchParams(location.search).get('invite');
  if (fromLink) { invite.value = fromLink.toUpperCase().slice(0, 40); history.replaceState(null, '', '/'); }
  fetch('/api/signup/config').then(r => r.json()).then(cfg => {
    if (cfg.mode === 'invite') { inviteField.hidden = false; invite.required = true; }
    else if (invite.value) { inviteField.hidden = false; document.getElementById('invite-hint').textContent = 'Your invitation gives you a founding price.'; }
  }).catch(() => { inviteField.hidden = false; });
  invite.addEventListener('input', () => { invite.value = invite.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); });
  const slug = form.elements.slug, hint = document.getElementById('slug-hint'), error = document.getElementById('error');
  let timer;
  slug.addEventListener('input', () => {
    slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    clearTimeout(timer);
    if (slug.value.length < 3) { hint.textContent = 'Lowercase letters, numbers and hyphens.'; return; }
    timer = setTimeout(async () => {
      const res = await fetch(`/api/signup/check?slug=${encodeURIComponent(slug.value)}`).then(r => r.json()).catch(() => null);
      if (!res || res.slug !== slug.value) return;
      hint.textContent = res.available ? `Available: ${res.url.replace('https://', '')}` : res.problem;
      hint.className = res.available ? 'ok' : 'bad';
    }, 300);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    data.acceptTerms = form.elements.acceptTerms.checked;
    const button = form.querySelector('button');
    button.disabled = true; button.textContent = 'Creating…';
    try {
      const result = await post('/api/signup', data);
      document.getElementById('done-email').textContent = result.email;
      form.hidden = true; document.getElementById('done').hidden = false;
    } catch (e) {
      error.textContent = e.message; error.hidden = false;
    } finally { button.disabled = false; button.textContent = 'Create my shop'; }
  });
})();
