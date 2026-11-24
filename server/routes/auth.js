// Session, sign-in, password change and sign-out.
import { z } from 'zod';
import { publicConfig } from '../config.js';
import { passwordProblem, userView, audit } from '../db.js';
import { hashPasswordAsync, verifyPasswordAsync, needsRehash } from '../passwords.js';
import { AppError } from '../errors.js';
import { localTransaction } from '../sale-events.js';
import { hash, bearer, readCookie, cookieOptions, sessionUser, createSession, passwordSchema, UNKNOWN_USER_HASH } from '../session.js';

export function registerAuthRoutes(app, ctx) {
  const { config, db, auth, loginLimit, sensitiveLimit } = ctx;
  // Signed out: only what the sign-in screen needs. Feature switches, version
  // and business details are sent after sign-in (login returns full config).
  const signedOutConfig = () => { const full = publicConfig(config); return { mode: full.mode, configured: full.configured, liveReadOnly: full.liveReadOnly, businessName: full.businessName, ...(full.platformShop ? { platformShop: true } : {}) }; };
  app.get('/api/session', (req, res) => {
    const user = sessionUser(req, db, config);
    res.json({ user, config: user || config.mode === 'demo' ? publicConfig(config) : signedOutConfig() });
  });
  // No demo sign-in route exists in live or staging operation.
  if (config.mode === 'demo') app.post('/api/auth/demo', (req, res) => {
    const token = createSession(res, db, config, 'demo-owner');
    res.json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get('demo-owner')), config: publicConfig(config), token });
  });
  app.post('/api/auth/login', loginLimit, async (req, res, next) => {
    const parsed = z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(256) }).safeParse(req.body);
    if (!parsed.success) return next(new AppError('Enter your username and password.', 400));
    const username = parsed.data.username.toLowerCase().trim();
    const row = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
    if (row?.locked_until && row.locked_until > Date.now()) {
      audit(db, row.id, 'auth.locked_attempt', row.id);
      return next(new AppError('This account is temporarily locked. Try again later or ask an owner to reset the password.', 423));
    }
    // Off the main thread: a sign-in never pauses checkouts on other tills.
    const passwordOk = await verifyPasswordAsync(parsed.data.password, row ? row.password_hash : UNKNOWN_USER_HASH);
    if (!row || !passwordOk) {
      if (row) {
        // Atomic increment: simultaneous wrong guesses cannot undercount.
        localTransaction(db, () => {
          const { failed_attempts: attempts } = db.prepare('UPDATE users SET failed_attempts=COALESCE(failed_attempts,0)+1 WHERE id=? RETURNING failed_attempts').get(row.id);
          const lockedUntil = attempts >= 8 ? Date.now() + 15 * 60000 : null;
          if (lockedUntil) db.prepare('UPDATE users SET locked_until=? WHERE id=?').run(lockedUntil, row.id);
          audit(db, row.id, lockedUntil ? 'auth.locked' : 'auth.failed', row.id);
        });
      } else audit(db, 'anonymous', 'auth.failed', 'unrecognized account (no username stored)');
      return next(new AppError('Username or password is incorrect.', 401));
    }
    if (row.role === 'reviewer') {
      audit(db, row.id, 'auth.reviewer_retired', row.id);
      return next(new AppError('Reviewer accounts are retired.', 403, 'REVIEWER_RETIRED'));
    }
    // Upgrade an older, weaker password hash now that the password is known.
    const upgraded = needsRehash(row.password_hash) ? await hashPasswordAsync(parsed.data.password) : null;
    const token = localTransaction(db, () => {
      db.prepare('UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=?').run(row.id);
      if (upgraded) db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?').run(upgraded, row.id, row.password_hash);
      const session = createSession(res, db, config, row.id);
      audit(db, row.id, 'auth.login', row.id);
      return session;
    });
    res.json({ user: userView(row), config: publicConfig(config), token });
  });
  app.post('/api/auth/password', auth, sensitiveLimit, async (req, res) => {
    const input = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }).parse(req.body);
    if (config.mode === 'demo') throw new AppError('Password changes are disabled in the demo workspace.', 403);
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!(await verifyPasswordAsync(input.currentPassword, row.password_hash))) {
      audit(db, req.user.id, 'auth.password_failed', req.user.id);
      throw new AppError('Current password is incorrect.', 401);
    }
    if (input.currentPassword === input.newPassword) throw new AppError('Choose a different new password.', 400);
    const problem = passwordProblem(input.newPassword, row.username);
    if (problem) throw new AppError(problem, 400);
    const currentToken = bearer(req) || readCookie(req);
    const newHash = await hashPasswordAsync(input.newPassword);
    localTransaction(db, () => {
      db.prepare('UPDATE users SET password_hash=?,must_change_password=0,failed_attempts=0,locked_until=NULL WHERE id=?').run(newHash, req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user.id, hash(currentToken));
      audit(db, req.user.id, 'auth.password_changed', req.user.id);
    });
    res.json({ ok: true, user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
  });
  app.post('/api/auth/logout', auth, (req, res) => {
    const token = bearer(req) || readCookie(req);
    localTransaction(db, () => {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
      audit(db, req.user.id, 'auth.logout', req.user.id);
    });
    res.clearCookie('mansu_session', { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });
}
