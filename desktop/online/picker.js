'use strict';
(() => {
  const setup = window.mansuTillSetup;
  const form = document.getElementById('choose'), input = document.getElementById('address');
  const error = document.getElementById('error'), go = document.getElementById('go');
  setup.info().then(info => {
    document.getElementById('suffix').textContent = `.${info.platformDomain}`;
    document.getElementById('example').textContent = `yourshop (= yourshop.${info.platformDomain})`;
    if (info.suggestion) input.value = info.suggestion;
  });
  input.addEventListener('input', () => { error.hidden = true; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.hidden = true; go.disabled = true; go.textContent = 'Checking the shop…';
    const result = await setup.choose(input.value).catch(() => ({ ok: false, error: 'Something went wrong. Try again.' }));
    if (!result.ok) { error.textContent = result.error; error.hidden = false; go.disabled = false; go.textContent = 'Connect'; }
  });
})();
