import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readConfig, publicConfig, APP_VERSION } from './config.js';
import { openDatabase, hashPassword, verifyPassword, passwordProblem, userView, audit, saleView } from './db.js';
import { WooCommerce } from './woocommerce.js';
import { Catalog } from './catalog.js';
import { SalesService, prepareSchema, paymentSchema } from './sales.js';
import { ShiftService, openShiftSchema, closeShiftSchema, cashMovementSchema } from './shifts.js';
import { AppError, now } from './errors.js';
import { createLogger, requestId } from './logger.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const SESSION_MS = 8 * 60 * 60 * 1000;
const cookieOptions = config => ({ httpOnly: true, sameSite: config.production && config.mode === 'demo' ? 'none' : 'strict', secure: config.production, path: '/', maxAge: SESSION_MS });
function readCookie(req) { return (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('mansu_session='))?.slice(14) || ''; }
function bearer(req) {
  if (req.headers.authorization?.startsWith('Bearer ')) return req.headers.authorization.slice(7);
  // Some embedded preview proxies remove Authorization. This custom header is an equivalent
  // bearer credential; it is not auto-sent cross-origin and mutations still require JSON/origin checks.
  const custom = req.headers['x-mansu-session'];
  return typeof custom === 'string' && custom.length > 0 && custom.length <= 256 ? custom : '';
}
function sessionUser(req, db, config) {
  const token = bearer(req) || readCookie(req);
  if (!token) return null;
  const row = db.prepare('SELECT users.*, sessions.last_seen, sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>? AND users.active=1').get(hash(token), Date.now());
  if (!row) return null;
  const idleMs = config.sessionIdleMinutes * 60000;
  if (row.last_seen && Date.now() - row.last_seen > idleMs) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    return null;
  }
  db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(Date.now(), hash(token));
  return userView(row);
}
function createSession(res, db, config, userId) {
  const token = randomBytes(32).toString('hex');
  const time = Date.now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,last_seen) VALUES (?,?,?,?)').run(hash(token), userId, time + SESSION_MS, time);
  res.cookie('mansu_session', token, cookieOptions(config));
  return token;
}
const role = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : next(new AppError('Your staff role does not allow this action.', 403));
const passwordSchema = z.string().min(12).max(256);

export function createApp({ env = process.env, api: injectedApi, logger: injectedLogger } = {}) {
  const config = readConfig(env);
  const logger = injectedLogger || createLogger(config.logLevel);
  const db = openDatabase(config);
  const api = injectedApi || new WooCommerce(config, fetch, logger);
  const catalog = new Catalog(db, api, config);
  const sales = new SalesService(db, catalog, api, config);
  const shifts = new ShiftService(db, config);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    req.id = requestId();
    res.set('X-Request-Id', req.id);
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api/health') || req.path.startsWith('/api/ready')) return;
      logger.info({ reqId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, userId: req.user?.id });
    });
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: config.production ? { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'https:', 'data:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'self'"], baseUri: ["'self'"], formAction: ["'self'"], upgradeInsecureRequests: null } } : false,
    frameguard: false, crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.production ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
  }));
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.is('application/json')) return next(new AppError('Use application/json for API requests.', 415));
      const origin = req.headers.origin;
      if (origin) {
        try {
          const parsed = new URL(origin);
          if (config.publicOrigin) {
            if (parsed.origin !== new URL(config.publicOrigin).origin) return next(new AppError('Cross-origin request rejected.', 403));
          } else {
            const allowedHosts = [req.headers.host, req.headers['x-forwarded-host']?.split(',')[0]?.trim()].filter(Boolean);
            if (!allowedHosts.includes(parsed.host)) return next(new AppError('Cross-origin request rejected.', 403));
          }
        } catch { return next(new AppError('Invalid request origin.', 403)); }
      } else if (config.production && config.publicOrigin && !bearer(req)) {
        return next(new AppError('Missing request origin.', 403));
      }
    }
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please wait a moment.' } }));
  const auth = (req, res, next) => {
    req.user = sessionUser(req, db, config);
    if (!req.user) return next(new AppError('Sign in to continue.', 401));
    if (req.user.mustChangePassword && !['/api/auth/password', '/api/auth/logout', '/api/session'].includes(req.path)) {
      return next(new AppError('Change your temporary password before continuing.', 403, 'PASSWORD_CHANGE_REQUIRED'));
    }
    next();
  };
  const loginLimit = rateLimit({ windowMs: 15 * 60000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again later.' } });
  const sensitiveLimit = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Please wait a moment.' } });

  app.get('/api/health', (req, res) => res.json({ ok: true, mode: config.mode, version: APP_VERSION }));
  app.get('/api/ready', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      const issues = [];
      if (config.mode !== 'demo' && !config.configured) issues.push('WooCommerce credentials are not configured.');
      if (config.mode === 'live' && !config.writesEnabled) issues.push('Live write gate is disabled.');
      res.status(issues.length ? 503 : 200).json({ ok: issues.length === 0, mode: config.mode, version: APP_VERSION, issues });
    } catch { res.status(503).json({ ok: false, error: 'Database is not ready.' }); }
  });
  app.get('/api/session', (req, res) => res.json({ user: sessionUser(req, db, config), config: publicConfig(config) }));
  app.post('/api/auth/demo', (req, res, next) => {
    if (config.mode !== 'demo') return next(new AppError('Demo access is disabled.', 403));
    const token = createSession(res, db, config, 'demo-owner');
    res.json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get('demo-owner')), config: publicConfig(config), token });
  });
  app.post('/api/auth/login', loginLimit, (req, res, next) => {
    const parsed = z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(256) }).safeParse(req.body);
    if (!parsed.success) return next(new AppError('Enter your username and password.', 400));
    const username = parsed.data.username.toLowerCase().trim();
    const row = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
    if (row?.locked_until && row.locked_until > Date.now()) return next(new AppError('This account is temporarily locked. Try again later or ask an owner to reset the password.', 423));
    if (!row || !verifyPassword(parsed.data.password, row.password_hash)) {
      if (row) {
        const attempts = (row.failed_attempts || 0) + 1;
        const lockedUntil = attempts >= 8 ? Date.now() + 15 * 60000 : null;
        db.prepare('UPDATE users SET failed_attempts=?,locked_until=? WHERE id=?').run(attempts, lockedUntil, row.id);
        audit(db, row.id, lockedUntil ? 'auth.locked' : 'auth.failed', row.id);
      }
      return next(new AppError('Username or password is incorrect.', 401));
    }
    db.prepare('UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=?').run(row.id);
    const token = createSession(res, db, config, row.id);
    audit(db, row.id, 'auth.login', row.id);
    res.json({ user: userView(row), config: publicConfig(config), token });
  });
  app.post('/api/auth/password', auth, sensitiveLimit, (req, res) => {
    const input = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }).parse(req.body);
    if (config.mode === 'demo') throw new AppError('Password changes are disabled in the demo workspace.', 403);
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!verifyPassword(input.currentPassword, row.password_hash)) throw new AppError('Current password is incorrect.', 401);
    if (input.currentPassword === input.newPassword) throw new AppError('Choose a different new password.', 400);
    const problem = passwordProblem(input.newPassword, row.username);
    if (problem) throw new AppError(problem, 400);
    db.prepare('UPDATE users SET password_hash=?,must_change_password=0,failed_attempts=0,locked_until=NULL WHERE id=?').run(hashPassword(input.newPassword), req.user.id);
    const currentToken = bearer(req) || readCookie(req);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user.id, hash(currentToken));
    audit(db, req.user.id, 'auth.password_changed', req.user.id);
    res.json({ ok: true, user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
  });
  app.post('/api/auth/logout', auth, (req, res) => {
    const token = bearer(req) || readCookie(req);
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    res.clearCookie('mansu_session', { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });

  app.get('/api/catalog', auth, async (req, res) => res.json(await catalog.get(req.query.refresh === '1')));
  // Retain the v4 table name to preserve existing named buyers and sale FKs.
  app.get('/api/wholesale-buyers', auth, role('owner', 'manager'), (req, res) => {
    res.json({ buyers: db.prepare('SELECT id,name,created_at FROM trade_buyers ORDER BY name COLLATE NOCASE, id').all()
      .map(row => ({ id: row.id, name: row.name, createdAt: row.created_at })) });
  });
  app.post('/api/wholesale-buyers', auth, role('owner', 'manager'), sensitiveLimit, (req, res) => {
    if (!config.wholesaleWritesEnabled) throw new AppError('Wholesale writes are locked until separately authorized.', 403, 'WHOLESALE_CHECKOUT_LOCKED');
    // eslint-disable-next-line no-control-regex -- Buyer names appear in orders, receipts and exports.
    const { name: entered } = z.object({ name: z.string().trim().min(2).max(120).refine(name => !/[\u0000-\u001f\u007f]/.test(name), 'Use a single-line buyer name.') }).strict().parse(req.body);
    const name = entered.replace(/\s+/g, ' ');
    if (db.prepare('SELECT id FROM trade_buyers WHERE name=? COLLATE NOCASE').get(name)) throw new AppError('That buyer already exists. Select the existing buyer.', 409);
    const buyer = { id: randomUUID(), name };
    db.prepare('INSERT INTO trade_buyers(id,name,created_at,created_by) VALUES (?,?,?,?)').run(buyer.id, buyer.name, now(), req.user.id);
    audit(db, req.user.id, 'wholesale.buyer_created', buyer.id);
    res.status(201).json({ buyer });
  });
  app.get('/api/sales', auth, (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).parse(req.query.limit || 250);
    const cursor = z.string().max(500).optional().parse(req.query.cursor);
    res.json(sales.listPage(req.user, { limit, cursor }));
  });
  app.post('/api/sales/prepare', auth, sensitiveLimit, async (req, res) => {
    const input = prepareSchema.parse(req.body);
    res.status(201).json({ sale: await sales.prepare(req.user, input) });
  });
  app.post('/api/sales/:id/pay', auth, sensitiveLimit, async (req, res) => res.json({ sale: await sales.complete(req.user, req.params.id, paymentSchema.parse(req.body)) }));
  app.post('/api/sales/:id/reconcile', auth, async (req, res) => res.json({ sale: await sales.reconcile(req.user, req.params.id) }));
  app.post('/api/sales/:id/cancel', auth, async (req, res) => res.json({ sale: await sales.cancel(req.user, req.params.id) }));
  app.post('/api/sales/reconcile-pending', auth, role('owner', 'manager'), async (req, res) => res.json(await sales.reconcilePending(req.user)));

  app.get('/api/shifts/current', auth, (req, res) => res.json({ shift: shifts.current(req.user.id), required: config.requireShift }));
  app.get('/api/shifts', auth, (req, res) => {
    const days = z.coerce.number().int().min(1).max(90).parse(req.query.days || 7);
    res.json({ shifts: shifts.list(req.user, days) });
  });
  app.post('/api/shifts/open', auth, async (req, res) => res.status(201).json({ shift: shifts.open(req.user, openShiftSchema.parse(req.body)) }));
  app.post('/api/shifts/:id/close', auth, async (req, res) => res.json({ shift: shifts.close(req.user, req.params.id, closeShiftSchema.parse(req.body)) }));
  app.post('/api/shifts/:id/cash', auth, async (req, res) => res.json({ shift: shifts.movement(req.user, req.params.id, cashMovementSchema.parse(req.body)) }));

  const settledStatuses = ['paid', 'partially_refunded', 'refunded'];
  const reportRows = (user, since) => {
    const sql = `SELECT * FROM sales WHERE status IN (${settledStatuses.map(() => '?').join(',')}) AND paid_at IS NOT NULL AND paid_at>=? ${user.role === 'cashier' ? 'AND cashier_id=?' : ''} ORDER BY paid_at ASC, id ASC`;
    const params = [...settledStatuses, since.toISOString(), ...(user.role === 'cashier' ? [user.id] : [])];
    return db.prepare(sql).all(...params).map(saleView);
  };
  app.get('/api/reports', auth, role('owner', 'manager'), (req, res) => {
    const days = z.coerce.number().int().min(1).max(90).parse(req.query.days || 7);
    const since = new Date(); since.setUTCHours(0,0,0,0); since.setUTCDate(since.getUTCDate() - days + 1);
    const rows = reportRows(req.user, since);
    const net = sale => sale.total - (sale.refunded || 0);
    const total = rows.reduce((sum, sale) => sum + net(sale), 0);
    const gross = rows.reduce((sum, sale) => sum + sale.total, 0);
    const refunded = rows.reduce((sum, sale) => sum + (sale.refunded || 0), 0);
    const active = rows.filter(sale => sale.status !== 'refunded');
    const methods = ['cash','momo','card'].map(method => { const matches = rows.filter(s => s.paymentMethod === method); return { method, count: matches.length, total: matches.reduce((sum,s) => sum + net(s), 0) }; });
    const saleTypes = ['retail','wholesale'].map(type => { const matches = rows.filter(s => s.saleType === type); return { type, count: matches.length, total: matches.reduce((sum,s) => sum + net(s), 0) }; });
    const daily = Array.from({ length: days }, (_, i) => { const date = new Date(since); date.setUTCDate(date.getUTCDate() + i); const key = date.toISOString().slice(0,10); const matches = rows.filter(s => s.paidAt?.startsWith(key)); return { date: key, total: matches.reduce((sum,s) => sum + net(s), 0), count: matches.length }; });
    const products = new Map();
    for (const sale of active) for (const item of sale.items) { const key = `${item.productId}:${item.variationId}`; const p = products.get(key) || { name: item.name, label: item.label, quantity: 0, total: 0 }; p.quantity += item.quantity; p.total += item.total; products.set(key,p); }
    res.json({ days, since: since.toISOString(), total, gross, refunded, orders: rows.length, activeOrders: active.length, refundedOrders: rows.length - active.length, items: active.reduce((sum,s) => sum + s.items.reduce((n,i) => n + i.quantity,0),0), average: rows.length ? Math.round(total / rows.length) : 0, methods, saleTypes, daily, topProducts: [...products.values()].sort((a,b) => b.quantity - a.quantity).slice(0,8), sales: rows, scope: 'POS sales recorded by this app; not all online-store orders.' });
  });
  app.get('/api/reports/export', auth, role('owner', 'manager'), (req, res) => {
    const days = z.coerce.number().int().min(1).max(90).parse(req.query.days || 7);
    const since = new Date(); since.setUTCHours(0,0,0,0); since.setUTCDate(since.getUTCDate() - days + 1);
    const rows = reportRows(req.user, since);
    // eslint-disable-next-line no-control-regex -- CSV formula hardening intentionally strips control characters.
    const cell = value => { let text = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"','""')}"`; };
    const csv = [['Receipt','WooCommerce order','Paid at (UTC)','Cashier','Shift','Payment method','External reference','Status','Gross GHS','Refunded GHS','Net GHS','Mode','Sale type','Wholesale buyer','Wholesale approved by','Agreed wholesale total GHS'],
      ...rows.map(s => [s.number,s.wooOrderId || '',s.paidAt,s.cashierName,s.shiftId || '',s.paymentMethod,s.paymentReference,s.status,(s.total/100).toFixed(2),((s.refunded||0)/100).toFixed(2),((s.total-(s.refunded||0))/100).toFixed(2),config.mode,s.saleType,s.buyerName,s.wholesaleApprovedByName,s.agreedTotal != null ? (s.agreedTotal/100).toFixed(2) : ''])]
      .map(row => row.map(cell).join(',')).join('\r\n');
    audit(db, req.user.id, 'reports.export', `${rows.length} rows`);
    res.type('text/csv').attachment(`mansu-pos-${config.mode}-${now().slice(0,10)}.csv`).send(csv);
  });

  app.get('/api/staff', auth, role('owner'), (req, res) => res.json({ staff: db.prepare('SELECT * FROM users ORDER BY created_at').all().map(userView) }));
  app.post('/api/staff', auth, role('owner'), (req, res, next) => {
    if (config.mode === 'demo') return next(new AppError('Staff creation is available only in a configured staging/live workspace.', 403));
    const input = z.object({ name: z.string().trim().min(2).max(80), username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,40}$/), role: z.enum(['cashier','manager']), password: passwordSchema }).parse(req.body);
    const problem = passwordProblem(input.password, input.username);
    if (problem) throw new AppError(problem, 400);
    if (db.prepare('SELECT id FROM users WHERE username=?').get(input.username.toLowerCase())) throw new AppError('That username is already in use.', 409);
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at,must_change_password) VALUES (?,?,?,?,?,?,1)').run(id,input.username.toLowerCase(),input.name,input.role,hashPassword(input.password),now());
    audit(db, req.user.id, 'staff.created', id);
    res.status(201).json({ user: userView(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  });
  app.post('/api/staff/:id/password', auth, role('owner'), sensitiveLimit, (req, res) => {
    if (config.mode === 'demo') throw new AppError('Password changes are disabled in the demo workspace.', 403);
    const { newPassword } = z.object({ newPassword: passwordSchema }).parse(req.body);
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!row) throw new AppError('Staff member not found.', 404);
    const problem = passwordProblem(newPassword, row.username);
    if (problem) throw new AppError(problem, 400);
    db.prepare('UPDATE users SET password_hash=?,must_change_password=1,failed_attempts=0,locked_until=NULL WHERE id=?').run(hashPassword(newPassword), req.params.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
    audit(db, req.user.id, 'staff.password_reset', req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/staff/:id/status', auth, role('owner'), (req, res) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    if (req.params.id === req.user.id) throw new AppError('You cannot deactivate your own account.', 400);
    const result = db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0,req.params.id);
    if (!result.changes) throw new AppError('Staff member not found.', 404);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
    audit(db, req.user.id, active ? 'staff.activated' : 'staff.deactivated', req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/audit', auth, role('owner'), (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).parse(req.query.limit || 100);
    const rows = db.prepare('SELECT audit.*, users.name AS actor_name FROM audit LEFT JOIN users ON users.id=audit.actor ORDER BY audit.id DESC LIMIT ?').all(limit);
    res.json({ events: rows.map(r => ({ id: r.id, actor: r.actor, actorName: r.actor_name || r.actor, action: r.action, subject: r.subject, createdAt: r.created_at })) });
  });
  app.post('/api/connection/test', auth, role('owner'), async (req, res) => {
    if (config.mode === 'demo') return res.json({ connected: false, message: 'Demo is isolated from your website. Configure staging credentials on the server to test a real connection.', snapshot: true });
    const result = await api.request('products', { query: { per_page: 1, status: 'publish' } });
    audit(db, req.user.id, 'connection.test', 'read-only');
    res.json({ connected: true, message: 'Authenticated catalogue access confirmed. This test did not create orders or change stock.', productCount: result.total, writesEnabled: config.writesEnabled });
  });
  app.get('/api/connection/diagnostics', auth, role('owner'), async (req, res) => {
    const checks = [
      { name: 'HTTPS store URL', ok: config.storeUrl.startsWith('https://') },
      { name: 'Server-side credentials', ok: config.mode === 'demo' || config.configured, detail: config.mode === 'demo' ? 'Not needed for demo' : config.configured ? 'Configured' : 'Missing' },
      { name: 'Public origin configured', ok: !config.production || Boolean(config.publicOrigin) || config.mode === 'demo' },
      { name: 'Write gate', ok: config.mode === 'demo' ? true : config.writesEnabled, detail: config.mode === 'demo' ? 'Demo only' : config.writesEnabled ? 'Enabled' : 'Locked' },
    ];
    if (config.mode !== 'demo' && config.configured) {
      try { const products = await api.request('products', { query: { per_page: 1, status: 'publish' } }); checks.push({ name: 'WooCommerce catalogue read', ok: true, detail: `${products.total} published products` }); }
      catch (error) { checks.push({ name: 'WooCommerce catalogue read', ok: false, detail: error.message }); }
      try { await api.request('orders', { query: { per_page: 1 } }); checks.push({ name: 'WooCommerce orders read', ok: true }); }
      catch (error) { checks.push({ name: 'WooCommerce orders read', ok: false, detail: error.message }); }
    }
    res.json({ mode: config.mode, version: APP_VERSION, checks, ok: checks.every(c => c.ok) });
  });

  app.use('/api', (req, res, next) => next(new AppError('API endpoint not found.', 404)));
  app.use((error, req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'VALIDATION_ERROR' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Invalid JSON request.' });
    const status = error.status || 500;
    if (status >= 500) logger.error({ reqId: req.id, method: req.method, path: req.path, code: error.code || 'SERVER_ERROR', name: error.name || 'Error' });
    res.status(status).json({ error: error instanceof AppError ? error.message : 'An unexpected server error occurred. Check the sale history before retrying.', code: error.code || 'SERVER_ERROR', reqId: req.id });
  });
  return { app, config, db, api, catalog, sales, shifts, logger };
}
