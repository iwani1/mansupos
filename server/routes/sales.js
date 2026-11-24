// Sales history and checkout: prepare, pay, confirm, reconcile and cancel sales.
import { z } from 'zod';
import { prepareSchema, paymentSchema } from '../sales.js';
import { AppError } from '../errors.js';
import { readSaleEvents } from '../sale-events.js';

export function registerSalesListRoutes(app, ctx) {
  const { sales, auth } = ctx;
  app.get('/api/sales', auth, (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).parse(req.query.limit || 250);
    const cursor = z.string().max(500).optional().parse(req.query.cursor);
    res.json(sales.listPage(req.user, { limit, cursor }));
  });
}

export function registerSalesRoutes(app, ctx) {
  const { db, sales, online, auth, role, sensitiveLimit } = ctx;
  app.get('/api/sales/:id/events', auth, role('owner', 'manager'), (req, res) => {
    sales.get(req.params.id, req.user);
    const limit = z.coerce.number().int().min(1).max(500).parse(req.query.limit || 200);
    res.json({ saleId: req.params.id, events: readSaleEvents(db, req.params.id, limit) });
  });
  app.post('/api/sales/prepare', auth, sensitiveLimit, async (req, res) => {
    const input = prepareSchema.parse(req.body);
    res.status(201).json({ sale: await (online ? online.prepare(req.user, input) : sales.prepare(req.user, input)) });
  });
  app.post('/api/sales/:id/pay', auth, sensitiveLimit, async (req, res) => {
    const payment = paymentSchema.parse(req.body);
    if (online && !online.isOnline(req.params.id)) throw new AppError('An older Woo order cannot use the reservation bridge. Review it separately.', 409, 'RECONCILIATION_REQUIRED');
    res.json({ sale: await (online ? online.collectAndConfirm(req.user, req.params.id, payment) : sales.complete(req.user, req.params.id, payment)) });
  });
  app.get('/api/sales/:id/online-status', auth, async (req, res) => {
    if (!online) throw new AppError('Local online bridge is disabled.', 403, 'CHECKOUT_LOCKED');
    res.json(await online.status(req.user, req.params.id)); // Remote GET; no local or Woo mutation.
  });
  app.post('/api/sales/:id/confirm-cash', auth, role('owner', 'manager'), sensitiveLimit, async (req, res) => {
    if (!online) throw new AppError('Local online bridge is disabled.', 403, 'CHECKOUT_LOCKED');
    res.json({ sale: await online.confirmAfterCrash(req.user, req.params.id) });
  });
  app.post('/api/sales/:id/reconcile', auth, async (req, res) => {
    if (online && !online.isOnline(req.params.id)) throw new AppError('Older Woo orders need separate legacy review while the bridge is enabled.', 409);
    if (!online && sales.isOnlineSale(req.params.id)) throw new AppError('The local online bridge is disabled. Review the original attempt without remote mutation.', 403, 'CHECKOUT_LOCKED');
    res.json({ sale: await (online ? online.reconcile(req.user, req.params.id) : sales.reconcile(req.user, req.params.id)) });
  });
  app.post('/api/sales/:id/cancel', auth, async (req, res) => {
    if (online && !online.isOnline(req.params.id)) throw new AppError('Older Woo orders need separate legacy review while the bridge is enabled.', 409);
    res.json({ sale: await (online ? online.cancel(req.user, req.params.id) : sales.cancel(req.user, req.params.id)) });
  });
  app.post('/api/sales/reconcile-pending', auth, role('owner', 'manager'), async (req, res) => res.json(await sales.reconcilePending(req.user)));
}
