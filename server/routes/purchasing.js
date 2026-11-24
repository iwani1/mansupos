// Suppliers, purchase orders, goods receiving, costs and reorder list.
import { z } from 'zod';
import { supplierSchema, poSchema, poActionSchema, receiptSchema, costSchema } from '../purchasing.js';

export function registerPurchasingRoutes(app, ctx) {
  const { purchasing, auth, role, sensitiveLimit } = ctx;
  // Purchasing: suppliers, purchase orders, goods receiving, costs, reorder list.
  const uuidParam = value => z.string().uuid().parse(value);
  app.get('/api/purchasing/overview', auth, role('owner', 'manager'), async (_req, res) => res.json(await purchasing.overview()));
  app.get('/api/suppliers', auth, role('owner', 'manager'), (_req, res) => res.json({ suppliers: purchasing.suppliers() }));
  app.post('/api/suppliers', auth, role('owner', 'manager'), sensitiveLimit, (req, res) => res.status(201).json(purchasing.saveSupplier(req.user, supplierSchema.parse(req.body))));
  app.put('/api/suppliers/:id', auth, role('owner', 'manager'), sensitiveLimit, (req, res) => res.json(purchasing.saveSupplier(req.user, supplierSchema.parse(req.body), uuidParam(req.params.id))));
  app.get('/api/purchase-orders', auth, role('owner', 'manager'), (req, res) => res.json({ orders: purchasing.orders({ status: req.query.status === 'open' ? 'open' : 'all' }) }));
  app.get('/api/purchase-orders/:id', auth, role('owner', 'manager'), (req, res) => res.json({ order: purchasing.order(uuidParam(req.params.id)) }));
  app.post('/api/purchase-orders', auth, role('owner', 'manager'), sensitiveLimit, (req, res) => res.status(201).json(purchasing.saveOrder(req.user, poSchema.parse(req.body))));
  app.put('/api/purchase-orders/:id', auth, role('owner', 'manager'), sensitiveLimit, (req, res) => res.json(purchasing.saveOrder(req.user, poSchema.parse(req.body), uuidParam(req.params.id))));
  app.post('/api/purchase-orders/:id/action', auth, role('owner', 'manager'), sensitiveLimit, (req, res) => res.json(purchasing.act(req.user, uuidParam(req.params.id), poActionSchema.parse(req.body))));
  app.post('/api/purchase-orders/:id/receive', auth, role('owner', 'manager'), sensitiveLimit, async (req, res) => res.json(await purchasing.receive(req.user, uuidParam(req.params.id), receiptSchema.parse(req.body))));
  app.put('/api/inventory/cost', auth, role('owner'), sensitiveLimit, (req, res) => res.json(purchasing.setCost(req.user, costSchema.parse(req.body))));
}
