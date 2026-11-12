import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.js';

test('POS client explains an HTML gateway error instead of displaying a JSON parser exception', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('<html>Gateway Timeout</html>', {
    status: 504, headers: { 'Content-Type': 'text/html' },
  });
  await assert.rejects(api('/catalog'), {
    message: /POS server returned an unexpected page \(HTTP 504\)/,
    code: 'INVALID_API_RESPONSE', status: 504,
  });
});
