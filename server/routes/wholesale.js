// Private wholesale price defaults and the wholesale buyer directory.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../db.js';
import { priceInputSchema, priceRemovalSchema } from '../wholesale-prices.js';
import { AppError, now } from '../errors.js';
import { localTransaction } from '../sale-events.js';

export function registerWholesaleRoutes(app, ctx) {
  const { config, db, wholesalePrices, auth, role, sensitiveLimit } = ctx;
  // Private wholesale defaults belong to the POS ledger, not Woo product
  // metadata. Cashiers/public catalogue callers never receive these prices.
  // The live catalogue pilot cannot manage or read them.
  const priceIds = params => ({
    productId: z.coerce.number().int().positive().parse(params.productId),
    variationId: z.coerce.number().int().min(0).parse(params.variationId),
  });
  app.get('/api/wholesale-prices', auth, role('owner', 'manager'), async (_req, res) => res.json(await wholesalePrices.list()));
  app.put('/api/wholesale-prices/:productId/:variationId', auth, role('owner'), sensitiveLimit, async (req, res) => {
    const { productId, variationId } = priceIds(req.params);
    res.json({ price: await wholesalePrices.save(req.user, productId, variationId, priceInputSchema.parse(req.body)) });
  });
  app.delete('/api/wholesale-prices/:productId/:variationId', auth, role('owner'), sensitiveLimit, (req, res) => {
    const { productId, variationId } = priceIds(req.params);
    res.json(wholesalePrices.remove(req.user, productId, variationId, priceRemovalSchema.parse(req.body)));
  });
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
    if (db.prepare('SELECT id FROM trade_buyers WHERE name=? COLLATE NOCASE').get(name)) throw new AppError('That buyer already exists in the historical directory.', 409);
    const buyer = { id: randomUUID(), name };
    localTransaction(db, () => {
      db.prepare('INSERT INTO trade_buyers(id,name,created_at,created_by) VALUES (?,?,?,?)').run(buyer.id, buyer.name, now(), req.user.id);
      audit(db, req.user.id, 'wholesale.buyer_created', buyer.id);
    });
    res.status(201).json({ buyer });
  });
}
