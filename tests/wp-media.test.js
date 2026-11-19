import test from 'node:test';
import assert from 'node:assert/strict';
import { WordPressMedia } from '../server/wp-media.js';

const config = { storeUrl: 'https://www.mansutrendzgh.com', mediaUser: 'iwan1', mediaPassword: 'abcd efgh ijkl mnop qrst uvwx', writesEnabled: true };
const reply = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

test('photo upload explains why WordPress refused it, without the password', async () => {
  const cases = [
    [401, { code: 'incorrect_password' }, /username or Application Password is wrong.*not the POS one/],
    [401, { code: 'invalid_username' }, /username or Application Password is wrong/],
    [403, { code: 'rest_cannot_create' }, /not allowed to upload files/],
    [401, { code: 'application_passwords_disabled' }, /Application Passwords are switched off/],
    [401, {}, /did not accept the login/],
  ];
  for (const [status, body, pattern] of cases) {
    const media = new WordPressMedia(config, reply(status, body));
    await assert.rejects(media.upload(JPEG, 'image/jpeg', 'Test'), error => pattern.test(error.message) && !error.message.includes('abcd'), JSON.stringify(body));
  }
});

test('diagnostics check signs in read-only and reports upload permission', async () => {
  let seen;
  const ok = new WordPressMedia(config, async (url, options) => { seen = { url: String(url), method: options.method, auth: options.headers.Authorization }; return new Response(JSON.stringify({ username: 'iwan1', capabilities: { upload_files: true } }), { status: 200 }); });
  assert.deepEqual(await ok.check(), { ok: true, detail: 'Signed in as iwan1; may upload files' });
  assert.equal(seen.method, 'GET');
  assert.match(seen.url, /\/wp-json\/wp\/v2\/users\/me\?context=edit/);
  assert.equal(seen.auth, `Basic ${Buffer.from('iwan1:abcd efgh ijkl mnop qrst uvwx').toString('base64')}`);
  const noUpload = new WordPressMedia(config, reply(200, { username: 'shopper', capabilities: { read: true } }));
  assert.equal((await noUpload.check()).ok, false);
  const wrong = new WordPressMedia(config, reply(401, { code: 'incorrect_password' }));
  assert.match((await wrong.check()).detail, /wrong/);
  assert.equal((await new WordPressMedia({ ...config, mediaUser: '', mediaPassword: '' }).check()).ok, false);
});
