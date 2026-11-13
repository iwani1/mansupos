import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64, SCRYPT).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  if (!encoded || typeof password !== 'string' || password.length > 256) return false;
  const parts = encoded.split(':');
  const [salt, hash] = parts[0] === 'scrypt' ? [parts[1], parts[2]] : [parts[0], parts[1]];
  if (!salt || !hash) return false;
  try {
    const actual = scryptSync(password, salt, 64, SCRYPT);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
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
