'use strict';

const field = document.getElementById('scan-code');
const lastCode = document.getElementById('last-code');
const status = document.getElementById('scan-status');

field.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const code = field.value.trim();
  field.value = '';
  if (code.length < 4 || code.length > 128) {
    status.textContent = 'A code of 4–128 characters followed by Enter is needed. Check the scanner configuration.';
    field.focus();
    return;
  }
  // Text only, never HTML, storage, a backend request or a product lookup.
  lastCode.textContent = code;
  status.textContent = 'Code and Enter received. Compare this exact code with the printed label.';
  field.focus();
});
document.getElementById('clear-scan').addEventListener('click', () => {
  field.value = '';
  lastCode.textContent = '—';
  status.textContent = 'Waiting for code and Enter.';
  field.focus();
});
window.addEventListener('keydown', event => {
  if (event.key === 'F2') { event.preventDefault(); field.focus(); }
});

document.getElementById('print-test').addEventListener('click', () => {
  document.getElementById('test-time').textContent = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Africa/Accra',
  }).format(new Date());
  window.print(); // Only the Windows printer dialog. Never an ESC/POS drawer pulse.
});
field.focus();
