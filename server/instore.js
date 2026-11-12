import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './errors.js';
import { audit } from './db.js';
import { loadInStoreSnapshot, sourceProblem } from './instore-catalog.js';
import { ShiftService } from './shifts.js';

export const inStoreSaleSchema = z.object({
  idempotencyKey: z.string().uuid(),
  items: z.array(z.object({ sku: z.string().regex(/^\d{1,8}$/), quantity: z.number().int().min(1).max(999) }).strict()).min(1).max(100),
  expectedTotal: z.number().int().min(1).max(1000000000),
  tendered: z.number().int().min(1).max(1000000000),
  confirmed: z.literal(true),
  note: z.string().trim().max(250).optional().default(''),
}).strict();
export const inStoreCountSchema = z.object({
  idempotencyKey: z.string().uuid(), expectedQuantity: z.number().int().min(0).max(1000000),
  countedQuantity: z.number().int().min(0).max(1000000), reason: z.string().trim().min(5).max(250),
}).strict();
const sha256 = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const saleView = row => ({
  id: row.id, number: row.number, status: 'paid', saleType: 'instore', paymentMethod: 'cash',
  total: row.total, tendered: row.tendered, changeDue: row.change_due, currency: 'GHS',
  items: JSON.parse(row.items_json), note: row.note, paidAt: row.paid_at,
  cashierId: row.cashier_id, cashierName: row.cashier_name, shiftId: row.shift_id,
  sourceHash: row.source_hash,
});
const money = cents => (cents / 100).toFixed(2);
// Spreadsheet-safe, including whitespace before a formula or a minus sign.
// eslint-disable-next-line no-control-regex -- Export intentionally strips control characters.
const csvCell = value => { let text = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); if (/^\s*[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };

function normalizedItems(items) {
  const merged = new Map();
  for (const item of items) {
    const quantity = (merged.get(item.sku) || 0) + item.quantity;
    if (quantity > 999) throw new AppError('A product cannot exceed 999 units in one sale.', 400);
    merged.set(item.sku, quantity);
  }
  return [...merged].map(([sku, quantity]) => ({ sku, quantity })).sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
}

export class InStoreService {
  constructor(db, config, loadSnapshot = loadInStoreSnapshot) {
    this.db = db;
    this.config = config;
    this.loadSnapshot = loadSnapshot;
    this.shifts = new ShiftService(db, config);
    if (config.inStoreCashEnabled) this.importOnce();
  }

  locked() {
    if (this.config.mode !== 'live' || !this.config.inStoreCashEnabled || this.config.liveReadOnly) {
      throw new AppError('In-store cash checkout is locked until a separate, reviewed rollout.', 403, 'INSTORE_CHECKOUT_LOCKED');
    }
  }

  snapshot() {
    const snapshot = this.loadSnapshot(); // Verifies BOTH original PDF and CSV hashes on every request.
    if (this.config.inStoreCashEnabled && snapshot.manifestHash !== this.config.inStoreSourceHash) {
      throw sourceProblem('the pinned stock snapshot hash does not match this rollout.');
    }
    return snapshot;
  }

  imported() { return this.db.prepare('SELECT * FROM instore_imports WHERE id=1').get(); }

  importOnce() {
    this.locked();
    const snapshot = this.snapshot();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.imported();
      if (existing && existing.source_hash !== snapshot.manifestHash) {
        throw sourceProblem('this ledger belongs to a different stock snapshot. Never reimport over recorded balances.');
      }
      if (!existing) {
        if (this.db.prepare('SELECT 1 FROM instore_inventory LIMIT 1').get() ||
            this.db.prepare('SELECT 1 FROM instore_sales LIMIT 1').get() ||
            this.db.prepare('SELECT 1 FROM instore_stock_movements LIMIT 1').get()) {
          throw sourceProblem('existing in-store records without an import marker; do not reseed the ledger.');
        }
        const eligible = snapshot.items.filter(item => item.status !== 'review');
        const time = now();
        this.db.prepare('INSERT INTO instore_imports(id,source_hash,csv_hash,pdf_hash,imported_at,listed,eligible,quarantined) VALUES (1,?,?,?,?,?,?,?)')
          .run(snapshot.manifestHash, snapshot.csvHash, snapshot.pdfHash, time, snapshot.items.length, eligible.length, snapshot.summary.needsReview);
        const insert = this.db.prepare('INSERT INTO instore_inventory(sku,name,group_name,barcode,price_cents,initial_quantity,on_hand) VALUES (?,?,?,?,?,?,?)');
        const movement = this.db.prepare("INSERT INTO instore_stock_movements(sku,delta,balance_after,kind,actor_id,occurred_at) VALUES (?,?,?,'import',?,?)");
        for (const item of eligible) {
          insert.run(item.sku, item.name, item.group, item.barcode, item.priceCents, item.stock, item.stock);
          if (item.stock) movement.run(item.sku, item.stock, item.stock, 'system', time);
        }
        audit(this.db, 'system', 'instore.imported', `${snapshot.manifestHash}:${eligible.length} eligible:${snapshot.summary.needsReview} quarantined`);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  catalog() {
    if (this.config.mode !== 'live') throw new AppError('In-store goods are available only in the live physical-store workspace.', 404);
    const snapshot = this.snapshot();
    const imported = this.imported();
    if (!imported) return snapshot;
    if (imported.source_hash !== snapshot.manifestHash || imported.csv_hash !== snapshot.csvHash || imported.pdf_hash !== snapshot.pdfHash ||
        imported.listed !== snapshot.items.length || imported.eligible !== snapshot.items.length - snapshot.summary.needsReview) {
      throw sourceProblem('ledger import and source snapshot differ; stop and review.');
    }
    const stockRows = new Map(this.db.prepare('SELECT * FROM instore_inventory').all().map(row => [row.sku, row]));
    if (stockRows.size !== imported.eligible) throw sourceProblem('ledger inventory row count differs from the verified import.');
    const items = snapshot.items.map(item => {
      if (item.status === 'review') {
        if (item.sku && stockRows.has(item.sku)) throw sourceProblem('a quarantined item was added to sellable stock.');
        return item;
      }
      const stock = stockRows.get(item.sku);
      if (!stock || stock.name !== item.name || stock.group_name !== item.group || stock.barcode !== item.barcode ||
          stock.price_cents !== item.priceCents || stock.initial_quantity !== item.reportedQuantity) {
        throw sourceProblem('inventory identities/prices differ from the verified snapshot.');
      }
      return { ...item, stock: stock.on_hand, status: stock.on_hand > 0 ? 'available' : 'out_of_stock' };
    });
    return { ...snapshot, items, summary: {
      ...snapshot.summary, available: items.filter(item => item.status === 'available').length,
      outOfStock: items.filter(item => item.status === 'out_of_stock').length,
      salesEnabled: Boolean(this.config.inStoreCashEnabled), importedAt: imported.imported_at,
    } };
  }

  recordSale(user, input) {
    this.locked();
    const catalog = this.catalog(); // Fail closed on changed source, review flags or a damaged import.
    const items = normalizedItems(input.items);
    const fingerprint = sha256({ items, note: input.note, expectedTotal: input.expectedTotal, tendered: input.tendered, confirmed: input.confirmed });
    const bySku = new Map(catalog.items.map(item => [item.sku, item]));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const original = this.db.prepare('SELECT * FROM instore_sales WHERE idempotency_key=?').get(input.idempotencyKey);
      if (original) {
        if (original.cashier_id !== user.id && user.role !== 'owner') throw new AppError('This sale belongs to another cashier.', 404);
        if (original.fingerprint !== fingerprint) throw new AppError('This payment attempt key was already used for another cart or cash amount.', 409, 'INSTORE_IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT');
        return saleView(original);
      }
      const shift = this.shifts.requireOpen(user.id); // Mandatory for this cash pool, even if online checkout is locked.
      const lines = [];
      let total = 0;
      for (const { sku, quantity } of items) {
        const item = bySku.get(sku);
        if (!item || item.status === 'review') throw new AppError(`SKU ${sku} is not cleared for in-store sale. Ask the owner to review it.`, 409, 'INSTORE_ITEM_REVIEW');
        if (item.status !== 'available' || item.stock < quantity) throw new AppError(`SKU ${sku} has insufficient in-store stock. Refresh the collection.`, 409, 'INSTORE_OUT_OF_STOCK');
        const lineTotal = item.priceCents * quantity;
        total += lineTotal;
        if (!Number.isSafeInteger(total) || total > 1000000000) throw new AppError('This cart is too large for a cash sale.', 400);
        lines.push({ sku, name: item.name, quantity, price: item.priceCents, total: lineTotal });
      }
      if (total !== input.expectedTotal) throw new AppError('The in-store total has changed. Refresh and confirm the exact GHS amount before taking cash.', 409, 'INSTORE_PRICE_CHANGED');
      if (input.tendered < total) throw new AppError('Cash received cannot be less than the total amount.', 400, 'INSTORE_INSUFFICIENT_CASH');
      const paidAt = now();
      const id = randomUUID();
      const receipt = this.db.prepare(`INSERT INTO instore_sales(id,idempotency_key,fingerprint,number,total,tendered,change_due,cashier_id,cashier_name,shift_id,items_json,note,source_hash,paid_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.idempotencyKey, fingerprint, `IS-PENDING-${id}`, total, input.tendered,
        input.tendered - total, user.id, user.name, shift.id, JSON.stringify(lines), input.note, catalog.manifestHash, paidAt);
      const number = `IS-${paidAt.slice(0, 10).replaceAll('-', '')}-${String(receipt.lastInsertRowid).padStart(6, '0')}`;
      this.db.prepare('UPDATE instore_sales SET number=? WHERE id=?').run(number, id);
      const update = this.db.prepare('UPDATE instore_inventory SET on_hand=on_hand-? WHERE sku=? AND on_hand>=?');
      const movement = this.db.prepare("INSERT INTO instore_stock_movements(sku,delta,balance_after,kind,sale_id,actor_id,occurred_at) VALUES (?,?,?,'sale',?,?,?)");
      for (const line of lines) {
        if (update.run(line.quantity, line.sku, line.quantity).changes !== 1) {
          throw new AppError(`SKU ${line.sku} was sold by another cashier. No sale was recorded.`, 409, 'INSTORE_OUT_OF_STOCK');
        }
        const balance = this.db.prepare('SELECT on_hand FROM instore_inventory WHERE sku=?').get(line.sku).on_hand;
        movement.run(line.sku, -line.quantity, balance, id, user.id, paidAt);
      }
      audit(this.db, user.id, 'instore.cash_sale', `${number}:${total}:${shift.id}`);
      const row = this.db.prepare('SELECT * FROM instore_sales WHERE id=?').get(id);
      this.db.exec('COMMIT');
      return saleView(row);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  ownSale(user, row) {
    if (!row || (user.role === 'cashier' && row.cashier_id !== user.id)) throw new AppError('In-store receipt not found.', 404);
    return saleView(row);
  }
  sale(user, id) { return this.ownSale(user, this.db.prepare('SELECT * FROM instore_sales WHERE id=?').get(id)); }
  byKey(user, key) { return this.ownSale(user, this.db.prepare('SELECT * FROM instore_sales WHERE idempotency_key=?').get(key)); }
  list(user, limit = 50, before = null) {
    const condition = user.role === 'cashier' ? 'WHERE cashier_id=?' : 'WHERE 1=1';
    const params = user.role === 'cashier' ? [user.id] : [];
    const rows = this.db.prepare(`SELECT * FROM instore_sales ${condition} ${before ? 'AND seq<?' : ''} ORDER BY seq DESC LIMIT ?`)
      .all(...params, ...(before ? [before] : []), limit + 1);
    return { sales: rows.slice(0, limit).map(saleView), nextCursor: rows.length > limit ? rows[limit - 1].seq : null };
  }

  report(days) {
    const since = new Date(); since.setUTCHours(0, 0, 0, 0); since.setUTCDate(since.getUTCDate() - days + 1);
    const rows = this.db.prepare('SELECT * FROM instore_sales WHERE paid_at>=? ORDER BY paid_at ASC, seq ASC').all(since.toISOString()).map(saleView);
    const total = rows.reduce((sum, sale) => sum + sale.total, 0);
    const products = new Map();
    for (const sale of rows) for (const item of sale.items) {
      const product = products.get(item.sku) || { sku: item.sku, name: item.name, quantity: 0, total: 0 };
      product.quantity += item.quantity; product.total += item.total;
      products.set(item.sku, product);
    }
    const daily = Array.from({ length: days }, (_, index) => {
      const date = new Date(since); date.setUTCDate(date.getUTCDate() + index);
      const key = date.toISOString().slice(0, 10);
      const matches = rows.filter(sale => sale.paidAt.startsWith(key));
      return { date: key, count: matches.length, total: matches.reduce((sum, sale) => sum + sale.total, 0) };
    });
    return { days, since: since.toISOString(), orders: rows.length, total, cash: total,
      units: [...products.values()].reduce((sum, item) => sum + item.quantity, 0),
      average: rows.length ? Math.round(total / rows.length) : 0,
      daily, topProducts: [...products.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 8),
      scope: 'POS-only in-store cash sales. Excludes online orders, WooCommerce Retail and Wholesale. Gross amounts; no tax breakdown.',
    };
  }

  exportCsv(days) {
    const since = new Date(); since.setUTCHours(0, 0, 0, 0); since.setUTCDate(since.getUTCDate() - days + 1);
    const rows = this.db.prepare('SELECT * FROM instore_sales WHERE paid_at>=? ORDER BY paid_at ASC, seq ASC').all(since.toISOString()).map(saleView);
    const csv = [['In-store receipt', 'Paid at (UTC)', 'Cashier', 'Shift', 'SKU', 'Product', 'Quantity', 'Final unit GHS',
      'Line GHS', 'Sale total GHS', 'Cash tendered GHS', 'Change due GHS', 'Source snapshot SHA-256'],
    ...rows.flatMap(sale => sale.items.map(item => [sale.number, sale.paidAt, sale.cashierName, sale.shiftId, item.sku,
      item.name, item.quantity, money(item.price), money(item.total), money(sale.total), money(sale.tendered),
      money(sale.changeDue), sale.sourceHash]))].map(row => row.map(csvCell).join(',')).join('\r\n');
    return { csv, count: rows.length };
  }

  // A verified physical recount may adjust ONLY an already identified,
  // reviewed-and-imported SKU. Negative/missing-unit/price/SKU exceptions
  // require a new owner-reviewed source, never a count override.
  recordCount(user, sku, input) {
    this.locked();
    if (user.role !== 'owner') throw new AppError('Only the owner may correct a physical in-store count.', 403);
    this.catalog();
    const fingerprint = sha256({ sku, expectedQuantity: input.expectedQuantity, countedQuantity: input.countedQuantity, reason: input.reason });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT * FROM instore_stock_counts WHERE idempotency_key=?').get(input.idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.actor_id !== user.id) throw new AppError('This stock-count key was used for a different count.', 409, 'INSTORE_IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT');
        return { sku: previous.sku, onHand: previous.counted_quantity, adjustedAt: previous.created_at };
      }
      const stock = this.db.prepare('SELECT on_hand FROM instore_inventory WHERE sku=?').get(sku);
      if (!stock) throw new AppError('This SKU is quarantined or not in the in-store stock pool.', 409, 'INSTORE_ITEM_REVIEW');
      if (stock.on_hand !== input.expectedQuantity) throw new AppError('Stock changed since the physical count. Refresh before updating it.', 409, 'INSTORE_COUNT_STALE');
      const delta = input.countedQuantity - stock.on_hand;
      if (!delta) throw new AppError('The new count is unchanged. No adjustment was recorded.', 400);
      const time = now();
      this.db.prepare('UPDATE instore_inventory SET on_hand=? WHERE sku=? AND on_hand=?').run(input.countedQuantity, sku, stock.on_hand);
      this.db.prepare('INSERT INTO instore_stock_counts(idempotency_key,sku,fingerprint,expected_quantity,counted_quantity,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(input.idempotencyKey, sku, fingerprint, stock.on_hand, input.countedQuantity, input.reason, user.id, time);
      this.db.prepare("INSERT INTO instore_stock_movements(sku,delta,balance_after,kind,reason,actor_id,occurred_at) VALUES (?,?,?,'count',?,?,?)")
        .run(sku, delta, input.countedQuantity, input.reason, user.id, time);
      audit(this.db, user.id, 'instore.stock_count', `${sku}:${stock.on_hand}->${input.countedQuantity}:${input.reason}`);
      this.db.exec('COMMIT');
      return { sku, onHand: input.countedQuantity, adjustedAt: time };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  movements(sku, limit = 100, before = null) {
    const stock = this.db.prepare('SELECT sku,name,initial_quantity,on_hand FROM instore_inventory WHERE sku=?').get(sku);
    if (!stock) throw new AppError('In-store stock ledger not found for that SKU.', 404);
    const rows = this.db.prepare(`SELECT m.id,m.delta,m.balance_after,m.kind,m.reason,m.sale_id,m.actor_id,m.occurred_at,s.number AS receipt_number
      FROM instore_stock_movements m LEFT JOIN instore_sales s ON s.id=m.sale_id
      WHERE m.sku=? ${before ? 'AND m.id<?' : ''} ORDER BY m.id DESC LIMIT ?`).all(sku, ...(before ? [before] : []), limit + 1);
    return { sku: stock.sku, name: stock.name, initialQuantity: stock.initial_quantity, onHand: stock.on_hand,
      movements: rows.slice(0, limit).map(row => ({ id: row.id, delta: row.delta, balanceAfter: row.balance_after,
        kind: row.kind, reason: row.reason, receiptNumber: row.receipt_number, actorId: row.actor_id, occurredAt: row.occurred_at })),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }
}
