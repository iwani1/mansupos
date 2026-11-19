import { AppError, RemoteError } from './errors.js';

// Uploads product photos to the WordPress media library. WooCommerce REST keys
// cannot upload files, so this uses a dedicated WordPress Application Password
// (POS_WP_MEDIA_USER / POS_WP_MEDIA_APP_PASSWORD) kept only on the server.

// WordPress's reason for refusing, in plain words. Never includes the password.
function refusal(status, data) {
  const code = String(data?.code || '');
  if (code === 'incorrect_password' || code === 'invalid_username' || code === 'invalid_email') return `the WordPress username or Application Password is wrong (${code}). Use the WordPress username, not the POS one.`;
  if (code === 'application_passwords_disabled' || code === 'application_passwords_disabled_for_user') return 'Application Passwords are switched off on the website.';
  if (code === 'rest_cannot_create' || code === 'rest_forbidden') return `this WordPress user is not allowed to upload files (${code}). Use an Administrator or Shop Manager.`;
  if (status === 401) return 'WordPress did not accept the login (no reason given). Check the username and Application Password.';
  return `WordPress refused it (HTTP ${status}${code ? `, ${code.slice(0, 60)}` : ''}).`;
}

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function imageType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

export class WordPressMedia {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }
  get configured() { return Boolean(this.config.mediaUser && this.config.mediaPassword); }
  // Read-only login check for diagnostics: who the password belongs to and
  // whether that user may upload files. No file is sent.
  async check() {
    if (!this.configured) return { ok: false, detail: 'Not configured (POS_WP_MEDIA_USER / POS_WP_MEDIA_APP_PASSWORD)' };
    let response;
    try {
      response = await this.fetch(`${this.config.storeUrl}/wp-json/wp/v2/users/me?context=edit&_fields=username,roles,capabilities`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.mediaUser}:${this.config.mediaPassword}`).toString('base64')}`, Accept: 'application/json', 'User-Agent': 'MansuPOS/1.2' },
      });
    } catch { return { ok: false, detail: 'The website could not be reached.' }; }
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) return { ok: false, detail: refusal(response.status, data) };
    const canUpload = Boolean(data?.capabilities?.upload_files);
    return { ok: canUpload, detail: canUpload ? `Signed in as ${String(data.username || this.config.mediaUser).slice(0, 60)}; may upload files` : `Signed in as ${String(data?.username || this.config.mediaUser).slice(0, 60)}, but this user may not upload files` };
  }

  async upload(buffer, type, name) {
    if (!this.configured) throw new AppError('Photo upload needs a WordPress Application Password on the server (POS_WP_MEDIA_USER and POS_WP_MEDIA_APP_PASSWORD).', 503, 'MEDIA_NOT_CONFIGURED');
    if (!this.config.writesEnabled || this.config.onlineBridgeEnabled || this.config.liveReadOnly) throw new AppError('Website writes are locked for this POS service.', 403, 'MEDIA_LOCKED');
    const slug = String(name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'product';
    const filename = `${slug}-${Date.now().toString(36)}.${TYPES[type]}`;
    let response;
    try {
      response = await this.fetch(`${this.config.storeUrl}/wp-json/wp/v2/media`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000), body: buffer,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.mediaUser}:${this.config.mediaPassword}`).toString('base64')}`,
          'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"`, Accept: 'application/json', 'User-Agent': 'MansuPOS/1.2',
        },
      });
    } catch { throw new RemoteError('The website could not be reached to upload the photo. Try again.', 502); }
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (response.status === 401 || response.status === 403) throw new RemoteError(`Photo upload refused: ${refusal(response.status, data)}`, 502);
    if (!response.ok || !Number.isSafeInteger(data?.id)) throw new RemoteError(`WordPress could not save the photo${data?.message ? `: ${String(data.message).replace(/<[^>]*>/g, '').slice(0, 120)}` : '.'}`, 502);
    let src = '';
    try { const url = new URL(data.source_url); if (url.protocol === 'https:') src = url.href; } catch { src = ''; }
    return { id: data.id, src };
  }
}
