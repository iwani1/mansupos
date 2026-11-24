import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, verifyPasswordAsync, passwordProblem } from '../passwords.js';
import { sealSecret, openSecret } from './secrets.js';

// Platform admin sign-in for the console: password + 6-digit authenticator
// code (RFC 6238 TOTP, 30-second steps, SHA-1, as Google Authenticator and
// similar apps expect). Each code works once; 8 failures lock the account for
// 15 minutes; sessions end after 30 idle minutes or 8 hours.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SESSION_MS = 8 * 3600000, IDLE_MS = 30 * 60000;
const sha = value => createHash('sha256').update(String(value)).digest('hex');
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

export function base32Encode(buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(text).toUpperCase().replace(/[\s=]/g, '')) {
    const index = B32.indexOf(ch);
    if (index < 0) throw new Error('Invalid base32.');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(number).padStart(6, '0');
}

// Returns the matched time step (one step of clock drift allowed) or 0.
export function verifyTotp(secret, code, { now = Date.now(), lastStep = 0 } = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) return 0;
  const current = Math.floor(now / 30000);
  for (const step of [current - 1, current, current + 1]) {
    if (step > lastStep && totpCode(secret, step) === code) return step;
  }
  return 0;
}

export class AdminAuth {
  constructor(registry, masterKey) { this.registry = registry; this.db = registry.db; this.masterKey = masterKey; }

  create(username, password) {
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(name)) throw new Error('Username: 3 to 40 letters, numbers, dots, hyphens or underscores.');
    const problem = passwordProblem(password, name);
    if (problem) throw new Error(problem);
    if (String(password).length < 14) throw new Error('Admin passwords need at least 14 characters.');
    if (this.db.prepare('SELECT 1 FROM admins WHERE username=?').get(name)) throw new Error('That admin already exists.');
    const id = `adm_${randomBytes(8).toString('hex')}`;
    const secret = base32Encode(randomBytes(20));
    this.db.prepare('INSERT INTO admins(id,username,password_hash,totp_sealed,created_at) VALUES (?,?,?,?,?)')
      .run(id, name, hashPassword(password), sealSecret(this.masterKey, `admin:${id}`, 'totp', secret), new Date().toISOString());
    this.registry.audit('cli', 'admin.created', null, name);
    return { id, username: name, secret, otpauth: `otpauth://totp/Mansu%20POS:${encodeURIComponent(name)}?secret=${secret}&issuer=Mansu%20POS` };
  }

  resetTotp(username) {
    const admin = this.db.prepare('SELECT * FROM admins WHERE username=?').get(String(username || '').toLowerCase());
    if (!admin) throw new Error('No such admin.');
    const secret = base32Encode(randomBytes(20));
    this.db.prepare('UPDATE admins SET totp_sealed=?, last_totp_step=0 WHERE id=?').run(sealSecret(this.masterKey, `admin:${admin.id}`, 'totp', secret), admin.id);
    this.db.prepare('DELETE FROM admin_sessions WHERE admin_id=?').run(admin.id);
    this.registry.audit('cli', 'admin.totp_reset', null, admin.username);
    return { secret, otpauth: `otpauth://totp/Mansu%20POS:${encodeURIComponent(admin.username)}?secret=${secret}&issuer=Mansu%20POS` };
  }

  async login(username, password, code) {
    const name = String(username || '').trim().toLowerCase();
    const admin = this.db.prepare('SELECT * FROM admins WHERE username=? AND disabled=0').get(name);
    if (admin?.locked_until && admin.locked_until > Date.now()) return { error: 'This account is locked for 15 minutes after repeated failures.', status: 423 };
    const passwordOk = await verifyPasswordAsync(String(password || ''), admin ? admin.password_hash : DUMMY_HASH);
    let step = 0;
    if (admin && passwordOk) {
      const secret = base32Decode(openSecret(this.masterKey, `admin:${admin.id}`, 'totp', admin.totp_sealed));
      step = verifyTotp(secret, String(code || ''), { lastStep: admin.last_totp_step });
    }
    if (!admin || !passwordOk || !step) {
      if (admin) {
        const attempts = this.db.prepare('UPDATE admins SET failed_attempts=failed_attempts+1 WHERE id=? RETURNING failed_attempts').get(admin.id).failed_attempts;
        if (attempts >= 8) this.db.prepare('UPDATE admins SET locked_until=? WHERE id=?').run(Date.now() + 15 * 60000, admin.id);
      }
      this.registry.audit(admin ? `admin:${admin.username}` : 'anonymous', 'console.login_failed', null, admin ? '' : 'unknown username');
      return { error: 'Username, password or code is incorrect.', status: 401 };
    }
    const token = randomBytes(32).toString('hex');
    const time = Date.now();
    this.db.prepare('UPDATE admins SET failed_attempts=0, locked_until=NULL, last_totp_step=?, last_login=? WHERE id=?').run(step, new Date().toISOString(), admin.id);
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at<?').run(time);
    this.db.prepare('INSERT INTO admin_sessions(token_hash,admin_id,created_at,last_seen,expires_at) VALUES (?,?,?,?,?)').run(sha(token), admin.id, time, time, time + SESSION_MS);
    this.registry.audit(`admin:${admin.username}`, 'console.login', null, '');
    return { token, admin: { id: admin.id, username: admin.username } };
  }

  session(token) {
    if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
    const row = this.db.prepare(`SELECT admin_sessions.*, admins.username FROM admin_sessions JOIN admins ON admins.id=admin_sessions.admin_id
      WHERE token_hash=? AND expires_at>? AND admins.disabled=0`).get(sha(token), Date.now());
    if (!row) return null;
    if (Date.now() - row.last_seen > IDLE_MS) { this.logout(token); return null; }
    this.db.prepare('UPDATE admin_sessions SET last_seen=? WHERE token_hash=?').run(Date.now(), sha(token));
    return { id: row.admin_id, username: row.username };
  }

  logout(token) { this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(sha(String(token || ''))); }
}

export const newReference = () => `manual_${randomUUID()}`;
