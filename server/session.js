// Session tokens, cookies and the role check shared by app.js and the routes.
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { hashPassword, userView } from './db.js';
import { AppError } from './errors.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const SESSION_MS = 8 * 60 * 60 * 1000;
export const cookieOptions = config => ({ httpOnly: true, sameSite: config.production && config.mode === 'demo' ? 'none' : 'strict', secure: config.production, path: '/', maxAge: SESSION_MS });
export const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export function readCookie(req) { return (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('mansu_session='))?.slice(14) || ''; }
export function bearer(req) {
  const authorization = req.headers.authorization;
  const primary = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  // Some embedded preview proxies remove Authorization. The custom header is
  // equivalent bearer material and must never silently override a different one.
  const custom = req.headers['x-mansu-session'];
  if (custom && primary && custom !== primary) return '';
  const token = primary || custom || '';
  return typeof token === 'string' && TOKEN_PATTERN.test(token) ? token : '';
}
export function sessionUser(req, db, config) {
  const headerPresent = req.headers.authorization?.startsWith('Bearer ') || req.headers['x-mansu-session'] != null;
  const supplied = bearer(req);
  const cookie = readCookie(req);
  if (headerPresent && !supplied || cookie && !TOKEN_PATTERN.test(cookie) || cookie && supplied && cookie !== supplied) return null;
  const token = supplied || cookie;
  if (!token) return null;
  const row = db.prepare('SELECT users.*, sessions.last_seen, sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>? AND users.active=1').get(hash(token), Date.now());
  if (!row) return null;
  // Reviewer accounts belonged to the retired stock-evidence workflow. Treat
  // any session they still hold as signed out, everywhere.
  if (row.role === 'reviewer') {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    return null;
  }
  const idleMs = config.sessionIdleMinutes * 60000;
  if (row.last_seen && Date.now() - row.last_seen > idleMs) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    return null;
  }
  db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(Date.now(), hash(token));
  return userView(row);
}
export function createSession(res, db, config, userId) {
  const token = randomBytes(32).toString('hex');
  const time = Date.now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,last_seen) VALUES (?,?,?,?)').run(hash(token), userId, time + SESSION_MS, time);
  res.cookie('mansu_session', token, cookieOptions(config));
  return token;
}
export const role = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : next(new AppError('Your staff role does not allow this action.', 403));
export const passwordSchema = z.string().min(12).max(256);
// Unknown usernames still pay the scrypt cost, so response time does not
// reveal which staff usernames exist.
export const UNKNOWN_USER_HASH = hashPassword(randomBytes(24).toString('hex'));
