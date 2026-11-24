import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { readConfig } from './config.js';
import { openDatabase } from './db.js';
import { WooCommerce } from './woocommerce.js';
import { Catalog } from './catalog.js';
import { WholesalePrices } from './wholesale-prices.js';
import { OfflineReservations } from './offline-reservations.js';
import { DesktopSyncService } from './desktop-sync.js';
import { SalesService } from './sales.js';
import { OnlineSalesService } from './online-sales.js';
import { OnlineBridgeClient } from './online-bridge-client.js';
import { ShiftService } from './shifts.js';
import { AppError } from './errors.js';
import { createLogger, requestId } from './logger.js';
import { DailyOperations } from './daily-operations.js';
import { WeeklyOperations } from './weekly-operations.js';
import { InventoryService } from './inventory.js';
import { ProductService } from './products.js';
import { WordPressMedia } from './wp-media.js';
import { ReturnsService } from './returns.js';
import { PurchasingService } from './purchasing.js';
import { role, bearer, sessionUser } from './session.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerPurchasingRoutes } from './routes/purchasing.js';
import { registerReturnsRoutes } from './routes/returns.js';
import { registerProductRoutes } from './routes/products.js';
import { registerDesktopRoutes } from './routes/desktop.js';
import { registerWholesaleRoutes } from './routes/wholesale.js';
import { registerSalesListRoutes, registerSalesRoutes } from './routes/sales.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerRecoveryRoutes } from './routes/recovery.js';
import { registerShiftRoutes } from './routes/shifts.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerStaffRoutes } from './routes/staff.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerConnectionRoutes } from './routes/connection.js';

export function createApp({ env = process.env, api: injectedApi, bridge: injectedBridge, reservations: injectedReservations, logger: injectedLogger, media: injectedMedia } = {}) {
  const config = readConfig(env);
  const logger = injectedLogger || createLogger(config.logLevel);
  const db = openDatabase(config);
  // Turning OFF the experimental bridge must never fall back to unreserved
  // legacy Woo checkout in the SAME ledger. Keep history readable, but lock
  // all checkout writes until a separately reviewed recovery is authorised.
  if (!config.onlineBridgeEnabled && db.prepare("SELECT 1 FROM sale_events WHERE event='online.intent' LIMIT 1").get()) {
    config.onlineBridgeQuarantined = true;
    config.writesEnabled = false;
    config.wholesaleWritesEnabled = false;
    config.inventoryWritesEnabled = false;
    config.productWritesEnabled = false;
    config.returnsEnabled = false;
    config.paymentMethods = ['cash'];
  }
  const api = injectedApi || new WooCommerce(config, fetch, logger);
  const catalog = new Catalog(db, api, config);
  const wholesalePrices = new WholesalePrices(db, catalog, api, config);
  const desktop = new DesktopSyncService(db, config, catalog, api,
    injectedReservations || new OfflineReservations(config), wholesalePrices);
  const sales = new SalesService(db, catalog, api, config);
  const inventory = new InventoryService(db, catalog, api, config);
  const purchasing = new PurchasingService(db, inventory, config);
  const products = new ProductService(db, catalog, api, config, injectedMedia || new WordPressMedia(config));
  // No bridge client, routes, plugin writes or new SQLite schema when OFF.
  const online = config.onlineBridgeEnabled
    ? new OnlineSalesService(db, catalog, injectedBridge || new OnlineBridgeClient(config), config)
    : null;
  const shifts = new ShiftService(db, config);
  const returns = new ReturnsService(db, api, inventory, shifts, config);
  const operations = new DailyOperations(db);
  const weekly = new WeeklyOperations(db);
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
      const photoUpload = req.method === 'POST' && req.path === '/products/media' && req.is(['image/jpeg', 'image/png', 'image/webp']);
      if (!req.is('application/json') && !photoUpload) return next(new AppError('Use application/json for API requests.', 415));
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

  const ctx = { env, config, logger, db, api, catalog, wholesalePrices, desktop, sales, inventory, purchasing, products, online, shifts, returns, operations, weekly, auth, role, loginLimit, sensitiveLimit };
  registerSystemRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerInventoryRoutes(app, ctx);
  registerPurchasingRoutes(app, ctx);
  registerReturnsRoutes(app, ctx);
  registerProductRoutes(app, ctx);
  registerDesktopRoutes(app, ctx);
  registerWholesaleRoutes(app, ctx);
  registerSalesListRoutes(app, ctx);
  registerPaymentRoutes(app, ctx);
  registerRecoveryRoutes(app, ctx);
  registerSalesRoutes(app, ctx);
  registerShiftRoutes(app, ctx);
  registerReportRoutes(app, ctx);
  registerOperationsRoutes(app, ctx);
  registerStaffRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerConnectionRoutes(app, ctx);

  app.use('/api', (req, res, next) => next(new AppError('API endpoint not found.', 404)));
  app.use((error, req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'VALIDATION_ERROR' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Invalid JSON request.' });
    const status = error.status || 500;
    if (status >= 500) logger.error({ reqId: req.id, method: req.method, path: req.path, code: error.code || 'SERVER_ERROR', name: error.name || 'Error' });
    res.status(status).json({ error: error instanceof AppError ? error.message : 'An unexpected server error occurred. Check the sale history before retrying.', code: error.code || 'SERVER_ERROR', reqId: req.id });
  });
  return { app, config, db, api, catalog, sales, inventory, products, purchasing, returns, desktop, shifts, logger };
}
