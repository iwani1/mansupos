import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Shop credentials (WooCommerce and WordPress keys) are stored encrypted in the
// central database with AES-256-GCM. The master key never sits in that
// database. Each value is bound to its shop and kind as authenticated data, so
// a row copied onto another shop, or edited, fails to decrypt instead of
// handing one shop another shop's keys.
const VERSION = 'v1';

export function parseMasterKey(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('PLATFORM_MASTER_KEY must be 32 bytes (64 hex characters or base64).');
  return key;
}

const aad = (shopId, kind) => Buffer.from(`mansu-pos/${shopId}/${kind}`, 'utf8');

export function sealSecret(masterKey, shopId, kind, plaintext) {
  if (!masterKey) throw new Error('The platform master key is not configured.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(aad(shopId, kind));
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

export function openSecret(masterKey, shopId, kind, sealed) {
  if (!masterKey) throw new Error('The platform master key is not configured.');
  const [version, iv, tag, body] = String(sealed || '').split(':');
  if (version !== VERSION || !iv || !tag || body === undefined) throw new Error('Stored shop secret is not readable.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(shopId, kind));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Stored shop secret failed its integrity check.');
  }
}
