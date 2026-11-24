// Customer returns: Woo refund, cash out on the shift, restock choice.
import { z } from 'zod';
import { returnSchema, resolveSchema } from '../returns.js';

export function registerReturnsRoutes(app, ctx) {
  const { returns, auth, role, sensitiveLimit } = ctx;
  // Customer returns (owner and manager): refund on the Woo order, cash out on the shift, restock choice.
  app.get('/api/returns/summary', auth, role('owner', 'manager'), (_req, res) => res.json({ writes: returns.state(), summary: returns.summary(), awaiting: returns.awaiting() }));
  app.get('/api/returns/find', auth, role('owner', 'manager'), (req, res) => res.json({ sales: returns.find(String(req.query.q || '').slice(0, 40)) }));
  app.get('/api/returns/sale/:saleId', auth, role('owner', 'manager'), (req, res) => res.json(returns.forUser(req.user, z.string().min(1).max(80).parse(req.params.saleId))));
  app.get('/api/returns', auth, role('owner', 'manager'), (_req, res) => res.json({ returns: returns.list() }));
  app.post('/api/returns', auth, role('owner', 'manager'), sensitiveLimit, async (req, res) => res.json(await returns.create(req.user, returnSchema.parse(req.body))));
  app.post('/api/returns/items/:id/resolve', auth, role('owner', 'manager'), sensitiveLimit, async (req, res) => res.json(await returns.resolve(req.user, z.string().uuid().parse(req.params.id), resolveSchema.parse(req.body))));
}
