import { scrypt, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// No node:util import: this file is shared with the practice till, whose
// build allows only a short list of Node modules.
const scryptAsync = (password, salt, length, options) => new Promise((resolve, reject) => {
  scrypt(password, salt, length, options, (error, key) => (error ? reject(error) : resolve(key)));
});

// Current parameters: OWASP's scrypt recommendation (N=2^15, r=8, p=3;
// about 32 MB). Stored as scrypt2:N:r:p:salt:hash so they can be raised later.
// Older hashes (scrypt:salt:hash or salt:hash, N=2^14 r=8 p=1) still verify and
// are upgraded the next time that person signs in.
const CURRENT = { N: 32768, r: 8, p: 3 };
const LEGACY = { N: 16384, r: 8, p: 1 };
const MAXMEM = 96 * 1024 * 1024;
const KEY_LENGTH = 64;

function parse(encoded) {
  if (typeof encoded !== 'string') return null;
  const parts = encoded.split(':');
  if (parts[0] === 'scrypt2' && parts.length === 6) {
    const [N, r, p] = parts.slice(1, 4).map(Number);
    if (![N, r, p].every(Number.isInteger) || N < 16384 || N > 1048576 || (N & (N - 1)) || r < 1 || r > 32 || p < 1 || p > 16) return null;
    return { params: { N, r, p }, salt: parts[4], hash: parts[5] };
  }
  const [salt, hash] = parts[0] === 'scrypt' ? [parts[1], parts[2]] : [parts[0], parts[1]];
  return salt && hash ? { params: LEGACY, salt, hash } : null;
}

const encode = (salt, key) => `scrypt2:${CURRENT.N}:${CURRENT.r}:${CURRENT.p}:${salt}:${key.toString('hex')}`;

// Synchronous: used for rare owner actions (adding staff, resets, setup).
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return encode(salt, scryptSync(password, salt, KEY_LENGTH, { ...CURRENT, maxmem: MAXMEM }));
}

// Asynchronous: runs on libuv's thread pool, so a sign-in never blocks sales.
export async function hashPasswordAsync(password) {
  const salt = randomBytes(16).toString('hex');
  return encode(salt, await scryptAsync(password, salt, KEY_LENGTH, { ...CURRENT, maxmem: MAXMEM }));
}

function matches(actual, hash) {
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyPassword(password, encoded) {
  const stored = parse(encoded);
  if (!stored || typeof password !== 'string' || password.length > 256) return false;
  try { return matches(scryptSync(password, stored.salt, KEY_LENGTH, { ...stored.params, maxmem: MAXMEM }), stored.hash); }
  catch { return false; }
}

export async function verifyPasswordAsync(password, encoded) {
  const stored = parse(encoded);
  if (!stored || typeof password !== 'string' || password.length > 256) return false;
  try { return matches(await scryptAsync(password, stored.salt, KEY_LENGTH, { ...stored.params, maxmem: MAXMEM }), stored.hash); }
  catch { return false; }
}

// True when a stored hash uses weaker parameters than CURRENT.
export function needsRehash(encoded) {
  const stored = parse(encoded);
  if (!stored) return false;
  return stored.params.N < CURRENT.N || stored.params.r < CURRENT.r || stored.params.p < CURRENT.p || !String(encoded).startsWith('scrypt2:');
}

const COMMON_PASSWORDS = new Set(['password1234', 'password12345', 'qwerty12345', 'letmein12345', 'mansutrendzgh', 'mansutrendzgh123', 'welcome12345', 'admin1234567']);
export function passwordProblem(password, username = '') {
  if (typeof password !== 'string' || password.length < 12) return 'Use a password of at least 12 characters.';
  if (password.length > 256) return 'Password is too long.';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'Choose a less common password.';
  if (username && lower.includes(username.toLowerCase()) && username.length >= 3) return 'Password must not contain the username.';
  if (/^(.)\1+$/.test(password)) return 'Choose a less repetitive password.';
  return '';
}
