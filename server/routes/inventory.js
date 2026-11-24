// Catalogue reads and shared website + shop stock control.
import { audit } from '../db.js';
import { adjustSchema, countSchema, priceSchema, movementQuery } from '../inventory.js';

export function registerInventoryRoutes(app, ctx) {
  const { db, catalog, inventory, auth, role, sensitiveLimit } = ctx;
  app.get('/api/catalog', auth, async (req, res) => res.json(await catalog.get(req.query.refresh === '1', { maxWaitMs: 20000 })));

  // Shared inventory management (website + shop share WooCommerce stock).
  app.get('/api/inventory', auth, role('owner', 'manager'), async (req, res) => res.json(await inventory.overview({ refresh: req.query.refresh === '1' })));
  app.get('/api/inventory/movements', auth, role('owner', 'manager'), (req, res) => res.json(inventory.movements(movementQuery.parse(req.query))));
  app.get('/api/inventory/export', auth, role('owner', 'manager'), async (req, res) => {
    const csv = await inventory.exportCsv();
    audit(db, req.user.id, 'inventory.export', 'stock-csv');
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="mansu-stock-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
  });
  app.post('/api/inventory/adjust', auth, role('owner', 'manager'), sensitiveLimit, async (req, res) => res.json(await inventory.adjust(req.user, adjustSchema.parse(req.body))));
  app.post('/api/inventory/count', auth, role('owner', 'manager'), sensitiveLimit, async (req, res) => res.json(await inventory.count(req.user, countSchema.parse(req.body))));
  app.post('/api/inventory/price', auth, role('owner'), sensitiveLimit, async (req, res) => res.json(await inventory.price(req.user, priceSchema.parse(req.body))));
}
