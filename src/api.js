let sessionToken = '';
export function setSessionToken(token = '') { sessionToken = token; }
export function authHeaders() { return sessionToken ? { Authorization: `Bearer ${sessionToken}`, 'X-Mansu-Session': sessionToken } : {}; }
export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options.headers }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'The request could not be completed.'); error.code = data.code; error.status = response.status; if (response.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new CustomEvent('mansu:session-expired')); throw error; }
  return data;
}
export const money = value => new Intl.NumberFormat('en-GH', { style: 'currency', currency: 'GHS', minimumFractionDigits: 2 }).format((Number(value) || 0) / 100);
export const dateTime = value => value ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Accra' }).format(new Date(value)) : '—';
export const methodLabel = { cash: 'Cash', momo: 'Mobile Money', card: 'Card' };
export const statusLabel = { paid: 'Paid', partially_refunded: 'Partially refunded', refunded: 'Refunded', awaiting_payment: 'Awaiting payment', needs_reconciliation: 'Needs review', creating: 'Creating', failed: 'Failed', cancelled: 'Cancelled' };
export const uuid = () => crypto.randomUUID();
