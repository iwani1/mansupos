import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './errors.js';
import { audit } from './db.js';

// Suppliers, purchase orders, goods receiving and cost prices.
//
// WooCommerce remains the owner of stock quantities (docs/adr/0001). Posting
// a goods receipt adds the received units through InventoryService, so each
// line is written to WooCommerce, confirmed, and recorded in the stock
// movement history like any other delivery. Purchase orders, receipts and
// costs are POS-side records: they are never sent to the website.
//
// All money is integer pesewas. Tables are additive (CREATE IF NOT EXISTS) and
// independent of the v9 ledger migrations; receipts are append-only.

export const PO_STATUSES = ['draft', 'pending_approval', 'approved', 'ordered', 'partially_received', 'received', 'cancelled'];
const OPEN_FOR_RECEIVING = ['approved', 'ordered', 'partially_received'];
const text = (max, min = 0) => z.string().trim().min(min).max(max).refine(v => !/[\r\n\0]/.test(v), 'Use one line');
const cents = z.number().int().min(0).max(100_000_000);
const qty = z.number().int().min(0).max(1_000_000);
const lineId = { productId: z.number().int().positive(), variationId: z.number().int().min(0).default(0) };

export const supplierSchema = z.object({
  name: text(120, 2), phone: text(40).default(''), email: z.union([z.string().trim().email().max(120), z.literal('')]).default(''),
  address: text(200).default(''), reference: text(60).default(''), notes: text(300).default(''), active: z.boolean().default(true),
}).strict();
const poItem = z.object({ ...lineId, name: text(200, 1), label: text(200).default(''), sku: text(80).default(''), quantity: qty.min(1), unitCost: cents }).strict();
export const poSchema = z.object({
  supplierId: z.string().uuid(), expectedDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).default(''),
  note: text(300).default(''), items: z.array(poItem).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  const seen = new Set();
  value.items.forEach((item, i) => { const k = `${item.productId}:${item.variationId}`; if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['items', i], message: 'Each item can appear once per order' }); seen.add(k); });
});
export const poActionSchema = z.object({ action: z.enum(['submit', 'approve', 'mark_ordered', 'cancel', 'close']), reason: text(200).default('') }).strict();
export const receiptSchema = z.object({
  key: z.string().uuid(), invoiceRef: text(80).default(''), note: text(300).default(''), allowExcess: z.boolean().default(false),
  lines: z.array(z.object({ itemId: z.string().uuid(), received: qty, damaged: qty.default(0), unitCost: cents.optional() }).strict()).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  if (!value.lines.some(l => l.received > 0 || l.damaged > 0)) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Enter at least one received or damaged quantity' });
  if (new Set(value.lines.map(l => l.itemId)).size !== value.lines.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Each order line can appear once per delivery' });
});
export const costSchema = z.object({ ...lineId, cost: cents }).strict();

export class PurchasingService {
  constructor(db, inventory, config) {
    this.db = db; this.inventory = inventory; this.config = config;
    db.exec(`
      CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS purchase_orders (id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, supplier_id TEXT NOT NULL REFERENCES suppliers(id), status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', expected_date TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        approved_by TEXT, approved_by_name TEXT, approved_at TEXT, ordered_at TEXT, closed_at TEXT, close_reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS purchase_order_items (id TEXT PRIMARY KEY, po_id TEXT NOT NULL REFERENCES purchase_orders(id), product_id INTEGER NOT NULL, variation_id INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', sku TEXT NOT NULL DEFAULT '', qty_ordered INTEGER NOT NULL CHECK(qty_ordered > 0), unit_cost INTEGER NOT NULL CHECK(unit_cost >= 0),
        qty_received INTEGER NOT NULL DEFAULT 0 CHECK(qty_received >= 0), qty_damaged INTEGER NOT NULL DEFAULT 0 CHECK(qty_damaged >= 0), UNIQUE(po_id, product_id, variation_id));
      CREATE TABLE IF NOT EXISTS goods_receipts (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, number TEXT NOT NULL UNIQUE, po_id TEXT NOT NULL REFERENCES purchase_orders(id),
        invoice_ref TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, received_by TEXT NOT NULL, received_by_name TEXT NOT NULL, created_at TEXT NOT NULL, lines_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS goods_receipt_items (id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES goods_receipts(id), po_item_id TEXT NOT NULL REFERENCES purchase_order_items(id),
        qty_received INTEGER NOT NULL, qty_damaged INTEGER NOT NULL DEFAULT 0, unit_cost INTEGER NOT NULL, stock_before INTEGER, stock_after INTEGER, created_at TEXT NOT NULL, UNIQUE(receipt_id, po_item_id));
      CREATE TABLE IF NOT EXISTS inventory_costs (product_id INTEGER NOT NULL, variation_id INTEGER NOT NULL DEFAULT 0, avg_cost INTEGER NOT NULL, last_cost INTEGER NOT NULL,
        updated_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', PRIMARY KEY(product_id, variation_id));
      CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_po_items_line ON purchase_order_items(product_id, variation_id);
      CREATE TRIGGER IF NOT EXISTS goods_receipt_items_no_update BEFORE UPDATE ON goods_receipt_items BEGIN SELECT RAISE(ABORT,'Posted receipt lines are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS goods_receipt_items_no_delete BEFORE DELETE ON goods_receipt_items BEGIN SELECT RAISE(ABORT,'Posted receipt lines are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS goods_receipts_no_delete BEFORE DELETE ON goods_receipts BEGIN SELECT RAISE(ABORT,'Goods receipts cannot be deleted'); END;
    `);
  }
  locked() { if (this.config.liveReadOnly) throw new AppError('The read-only live pilot cannot record purchasing.', 403, 'PURCHASING_LOCKED'); }
  tx(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  log(user, action, subject) { audit(this.db, user.id, action, typeof subject === 'string' ? subject : JSON.stringify({ v: 1, ...subject, by: user.name })); }

  // ---------- suppliers ----------
  supplierView(row) { return { id: row.id, name: row.name, phone: row.phone, email: row.email, address: row.address, reference: row.reference, notes: row.notes, active: Boolean(row.active), createdAt: row.created_at, orders: row.orders ?? 0 }; }
  suppliers() {
    return this.db.prepare('SELECT s.*, (SELECT COUNT(*) FROM purchase_orders p WHERE p.supplier_id=s.id) AS orders FROM suppliers s ORDER BY s.active DESC, s.name').all().map(r => this.supplierView(r));
  }
  saveSupplier(user, input, id = null) {
    this.locked();
    return this.tx(() => {
      const clash = this.db.prepare('SELECT id FROM suppliers WHERE name=?').get(input.name);
      if (clash && clash.id !== id) throw new AppError('A supplier with this name already exists.', 409, 'SUPPLIER_EXISTS');
      if (id) {
        if (!this.db.prepare('SELECT 1 FROM suppliers WHERE id=?').get(id)) throw new AppError('Supplier not found.', 404);
        this.db.prepare('UPDATE suppliers SET name=?,phone=?,email=?,address=?,reference=?,notes=?,active=? WHERE id=?').run(input.name, input.phone, input.email, input.address, input.reference, input.notes, input.active ? 1 : 0, id);
        this.log(user, 'supplier.updated', id);
      } else {
        id = randomUUID();
        this.db.prepare('INSERT INTO suppliers(id,name,phone,email,address,reference,notes,active,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, input.name, input.phone, input.email, input.address, input.reference, input.notes, input.active ? 1 : 0, now(), user.id);
        this.log(user, 'supplier.created', id);
      }
      return { supplier: this.supplierView(this.db.prepare('SELECT * FROM suppliers WHERE id=?').get(id)) };
    });
  }

  // ---------- purchase orders ----------
  poView(row, withItems = true) {
    const items = this.db.prepare('SELECT * FROM purchase_order_items WHERE po_id=? ORDER BY name,label').all(row.id).map(i => ({
      id: i.id, productId: i.product_id, variationId: i.variation_id, name: i.name, label: i.label, sku: i.sku, quantity: i.qty_ordered, unitCost: i.unit_cost,
      received: i.qty_received, damaged: i.qty_damaged, outstanding: Math.max(0, i.qty_ordered - i.qty_received) }));
    return {
      id: row.id, number: row.number, status: row.status, supplierId: row.supplier_id, supplierName: row.supplier_name ?? this.db.prepare('SELECT name FROM suppliers WHERE id=?').get(row.supplier_id)?.name ?? '',
      note: row.note, expectedDate: row.expected_date, createdByName: row.created_by_name, createdAt: row.created_at, updatedAt: row.updated_at,
      approvedByName: row.approved_by_name || '', approvedAt: row.approved_at, orderedAt: row.ordered_at, closedAt: row.closed_at, closeReason: row.close_reason,
      total: items.reduce((s, i) => s + i.quantity * i.unitCost, 0), units: items.reduce((s, i) => s + i.quantity, 0),
      unitsReceived: items.reduce((s, i) => s + i.received, 0), unitsOutstanding: items.reduce((s, i) => s + i.outstanding, 0),
      ...(withItems ? { items, receipts: this.receipts(row.id) } : { lines: items.length }),
    };
  }
  orders({ status = 'all', limit = 100 } = {}) {
    const rows = status === 'open'
      ? this.db.prepare("SELECT p.*, s.name AS supplier_name FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id WHERE p.status NOT IN ('received','cancelled') ORDER BY p.created_at DESC LIMIT ?").all(limit)
      : this.db.prepare('SELECT p.*, s.name AS supplier_name FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.created_at DESC LIMIT ?').all(limit);
    return rows.map(r => this.poView(r, false));
  }
  order(id) {
    const row = this.db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id);
    if (!row) throw new AppError('Purchase order not found.', 404);
    return this.poView(row);
  }
  nextNumber(prefix, table) {
    const last = this.db.prepare(`SELECT number FROM ${table} WHERE number LIKE ? ORDER BY number DESC LIMIT 1`).get(`${prefix}-%`)?.number;
    return `${prefix}-${String((last ? Number(last.split('-')[1]) : 0) + 1).padStart(5, '0')}`;
  }
  saveOrder(user, input, id = null) {
    this.locked();
    return this.tx(() => {
      const supplier = this.db.prepare('SELECT active FROM suppliers WHERE id=?').get(input.supplierId);
      if (!supplier) throw new AppError('Choose a supplier.', 400);
      const time = now();
      if (id) {
        const row = this.db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(id);
        if (!row) throw new AppError('Purchase order not found.', 404);
        if (row.status !== 'draft') throw new AppError('Only a draft order can be changed. Cancel it and create a new one.', 409, 'PO_NOT_DRAFT');
        this.db.prepare('UPDATE purchase_orders SET supplier_id=?,note=?,expected_date=?,updated_at=? WHERE id=?').run(input.supplierId, input.note, input.expectedDate, time, id);
        this.db.prepare('DELETE FROM purchase_order_items WHERE po_id=?').run(id);
      } else {
        if (!supplier.active) throw new AppError('This supplier is inactive.', 409);
        id = randomUUID();
        this.db.prepare('INSERT INTO purchase_orders(id,number,supplier_id,status,note,expected_date,created_by,created_by_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, this.nextNumber('PO', 'purchase_orders'), input.supplierId, 'draft', input.note, input.expectedDate, user.id, user.name, time, time);
      }
      const insert = this.db.prepare('INSERT INTO purchase_order_items(id,po_id,product_id,variation_id,name,label,sku,qty_ordered,unit_cost) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const item of input.items) insert.run(randomUUID(), id, item.productId, item.variationId, item.name, item.label, item.sku, item.quantity, item.unitCost);
      this.log(user, 'purchase_order.saved', id);
      return { order: this.order(id) };
    });
  }
  // Managers prepare and submit; an owner approves. An owner may approve a draft directly.
  act(user, id, { action, reason }) {
    this.locked();
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id);
      if (!row) throw new AppError('Purchase order not found.', 404);
      const time = now();
      const set = (status, extra = '', ...args) => this.db.prepare(`UPDATE purchase_orders SET status=?,updated_at=?${extra} WHERE id=?`).run(status, time, ...args, id);
      if (action === 'submit') {
        if (row.status !== 'draft') throw new AppError('Only a draft can be submitted for approval.', 409);
        set('pending_approval');
      } else if (action === 'approve') {
        if (user.role !== 'owner') throw new AppError('Only an owner can approve a purchase order.', 403);
        if (!['draft', 'pending_approval'].includes(row.status)) throw new AppError('This order is not waiting for approval.', 409);
        set('approved', ',approved_by=?,approved_by_name=?,approved_at=?', user.id, user.name, time);
      } else if (action === 'mark_ordered') {
        if (row.status !== 'approved') throw new AppError('Approve the order before marking it as sent to the supplier.', 409);
        set('ordered', ',ordered_at=?', time);
      } else if (action === 'cancel') {
        if (!['draft', 'pending_approval', 'approved', 'ordered'].includes(row.status)) throw new AppError('An order with received goods cannot be cancelled. Close it instead.', 409);
        set('cancelled', ',closed_at=?,close_reason=?', time, reason);
      } else if (action === 'close') {
        // The supplier will not deliver the rest: stop counting it as incoming.
        if (row.status !== 'partially_received') throw new AppError('Only a partially received order can be closed short.', 409);
        set('received', ',closed_at=?,close_reason=?', time, reason || 'Closed with outstanding quantities');
      }
      this.log(user, `purchase_order.${action}`, id);
      return { order: this.order(id) };
    });
  }

  // ---------- goods receiving ----------
  receipts(poId) {
    return this.db.prepare('SELECT * FROM goods_receipts WHERE po_id=? ORDER BY created_at DESC').all(poId).map(r => this.receiptView(r));
  }
  receiptView(r) {
    const posted = this.db.prepare('SELECT g.*, i.name, i.label FROM goods_receipt_items g JOIN purchase_order_items i ON i.id=g.po_item_id WHERE g.receipt_id=?').all(r.id);
    const requested = JSON.parse(r.lines_json);
    return { id: r.id, number: r.number, status: r.status, invoiceRef: r.invoice_ref, note: r.note, receivedByName: r.received_by_name, createdAt: r.created_at,
      lines: posted.map(l => ({ itemId: l.po_item_id, name: l.name, label: l.label, received: l.qty_received, damaged: l.qty_damaged, unitCost: l.unit_cost, stockBefore: l.stock_before, stockAfter: l.stock_after })),
      pendingLines: requested.filter(l => !posted.some(p => p.po_item_id === l.itemId)).length };
  }
  /**
   * Post a delivery. Each line is added to WooCommerce stock on its own and
   * recorded only after WooCommerce confirms it, so a line can never be
   * counted twice: sending the same delivery again finishes only the lines
   * that were not posted the first time.
   */
  async receive(user, poId, input) {
    this.locked();
    const state = this.inventory.writes();
    if (!state.enabled) throw new AppError(state.reason, 403, 'INVENTORY_WRITES_LOCKED');
    const po = this.db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(poId);
    if (!po) throw new AppError('Purchase order not found.', 404);
    let receipt = this.db.prepare('SELECT * FROM goods_receipts WHERE idempotency_key=?').get(input.key);
    if (receipt && receipt.po_id !== poId) throw new AppError('This delivery belongs to another purchase order.', 409);
    if (receipt?.status === 'posted') return { receipt: this.receiptView(receipt), order: this.order(poId), replayed: true, failures: [] };
    const items = new Map(this.db.prepare('SELECT * FROM purchase_order_items WHERE po_id=?').all(poId).map(i => [i.id, i]));
    if (!receipt) {
      if (!OPEN_FOR_RECEIVING.includes(po.status)) throw new AppError(po.status === 'draft' || po.status === 'pending_approval' ? 'This order must be approved before goods can be received.' : 'This order is closed for receiving.', 409, 'PO_NOT_RECEIVABLE');
      for (const line of input.lines) {
        const item = items.get(line.itemId);
        if (!item) throw new AppError('A delivery line does not belong to this order.', 400);
        if (!input.allowExcess && item.qty_received + line.received > item.qty_ordered) {
          throw new AppError(`${item.name}${item.label ? ` (${item.label})` : ''}: receiving ${line.received} would exceed the ${item.qty_ordered - item.qty_received} still outstanding. Confirm the excess delivery to accept it.`, 409, 'EXCESS_DELIVERY');
        }
      }
      receipt = this.tx(() => {
        const id = randomUUID();
        this.db.prepare('INSERT INTO goods_receipts(id,idempotency_key,number,po_id,invoice_ref,note,status,received_by,received_by_name,created_at,lines_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, input.key, this.nextNumber('GRN', 'goods_receipts'), poId, input.invoiceRef, input.note, 'posting', user.id, user.name, now(), JSON.stringify(input.lines));
        return this.db.prepare('SELECT * FROM goods_receipts WHERE id=?').get(id);
      });
    }
    // Always finish from the lines saved with the first attempt, never a changed resubmission.
    const lines = JSON.parse(receipt.lines_json);
    const failures = [];
    for (const line of lines) {
      const item = items.get(line.itemId);
      if (this.db.prepare('SELECT 1 FROM goods_receipt_items WHERE receipt_id=? AND po_item_id=?').get(receipt.id, item.id)) continue;
      const unitCost = line.unitCost ?? item.unit_cost;
      let before = null, after = null;
      if (line.received > 0) {
        try {
          const result = await this.inventory.adjust(user, { key: `${receipt.id}:${item.id}`, productId: item.product_id, variationId: item.variation_id, type: 'receive',
            quantity: line.received, reason: 'delivery', note: `${po.number} · ${receipt.number}${receipt.invoice_ref ? ` · inv ${receipt.invoice_ref}` : ''}`.slice(0, 200), enableTracking: false });
          before = result.movement.before; after = result.movement.after;
        } catch (error) {
          failures.push({ itemId: item.id, name: item.name, label: item.label, code: error.code || 'ERROR', error: error instanceof AppError ? error.message : 'Unexpected error' });
          continue;
        }
      }
      this.tx(() => {
        this.db.prepare('INSERT INTO goods_receipt_items(id,receipt_id,po_item_id,qty_received,qty_damaged,unit_cost,stock_before,stock_after,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), receipt.id, item.id, line.received, line.damaged || 0, unitCost, before, after, now());
        this.db.prepare('UPDATE purchase_order_items SET qty_received=qty_received+?, qty_damaged=qty_damaged+? WHERE id=?').run(line.received, line.damaged || 0, item.id);
        if (line.received > 0) this.applyCost(item.product_id, item.variation_id, unitCost, line.received, before, `${po.number}`);
      });
    }
    this.tx(() => {
      this.db.prepare('UPDATE goods_receipts SET status=? WHERE id=?').run(failures.length ? 'incomplete' : 'posted', receipt.id);
      const totals = this.db.prepare('SELECT SUM(qty_ordered) AS ordered, SUM(MIN(qty_received, qty_ordered)) AS received, SUM(qty_received) AS any_received FROM purchase_order_items WHERE po_id=?').get(poId);
      const status = totals.received >= totals.ordered ? 'received' : totals.any_received > 0 ? 'partially_received' : po.status;
      this.db.prepare('UPDATE purchase_orders SET status=?,updated_at=?,closed_at=CASE WHEN ?=\'received\' THEN ? ELSE closed_at END WHERE id=?').run(status, now(), status, now(), poId);
      this.log(user, 'goods_receipt.posted', { receipt: receipt.number, po: po.number, failed: failures.length });
    });
    return { receipt: this.receiptView(this.db.prepare('SELECT * FROM goods_receipts WHERE id=?').get(receipt.id)), order: this.order(poId), failures };
  }

  // ---------- costs and valuation ----------
  // Weighted average: (units already on hand x old average + units received x
  // delivery cost) / all units. With no earlier cost, the delivery cost is used.
  applyCost(productId, variationId, unitCost, received, stockBefore, source) {
    const current = this.db.prepare('SELECT avg_cost FROM inventory_costs WHERE product_id=? AND variation_id=?').get(productId, variationId);
    const onHand = Math.max(0, Number(stockBefore) || 0);
    const average = current && onHand > 0 ? Math.round((onHand * current.avg_cost + received * unitCost) / (onHand + received)) : unitCost;
    this.db.prepare(`INSERT INTO inventory_costs(product_id,variation_id,avg_cost,last_cost,updated_at,source) VALUES (?,?,?,?,?,?)
      ON CONFLICT(product_id,variation_id) DO UPDATE SET avg_cost=excluded.avg_cost,last_cost=excluded.last_cost,updated_at=excluded.updated_at,source=excluded.source`)
      .run(productId, variationId, average, unitCost, now(), source);
  }
  setCost(user, input) {
    this.locked();
    return this.tx(() => {
      this.db.prepare(`INSERT INTO inventory_costs(product_id,variation_id,avg_cost,last_cost,updated_at,source) VALUES (?,?,?,?,?,'manual')
        ON CONFLICT(product_id,variation_id) DO UPDATE SET avg_cost=excluded.avg_cost,last_cost=excluded.last_cost,updated_at=excluded.updated_at,source='manual'`)
        .run(input.productId, input.variationId, input.cost, input.cost, now());
      this.log(user, 'inventory.cost_set', { productId: input.productId, variationId: input.variationId, cost: input.cost });
      return { cost: { productId: input.productId, variationId: input.variationId, avgCost: input.cost, lastCost: input.cost } };
    });
  }
  costs() { return new Map(this.db.prepare('SELECT * FROM inventory_costs').all().map(r => [`${r.product_id}:${r.variation_id}`, r])); }
  incoming() {
    return new Map(this.db.prepare(`SELECT i.product_id, i.variation_id, SUM(MAX(0, i.qty_ordered - i.qty_received)) AS units FROM purchase_order_items i
      JOIN purchase_orders p ON p.id=i.po_id WHERE p.status IN ('approved','ordered','partially_received') GROUP BY i.product_id, i.variation_id`).all().map(r => [`${r.product_id}:${r.variation_id}`, r.units]));
  }

  /** Stock lines with cost, incoming units and a suggested reorder quantity. */
  async overview() {
    const stock = await this.inventory.overview();
    const costs = this.costs();
    const incoming = this.incoming();
    const threshold = stock.summary.threshold;
    const lines = stock.lines.map(line => {
      const cost = costs.get(line.key);
      const onOrder = incoming.get(line.key) || 0;
      // Target cover: about 45 days of shop sales, and never less than twice the low-stock level.
      const target = Math.max(threshold * 2, Math.ceil(line.posSold30 * 1.5));
      const suggested = line.manageStock && line.stock != null && line.stock + onOrder <= threshold ? Math.max(0, target - line.stock - onOrder) : 0;
      return { ...line, avgCost: cost?.avg_cost ?? null, lastCost: cost?.last_cost ?? null, incoming: onOrder, target, suggested };
    });
    const tracked = lines.filter(l => l.manageStock && l.stock != null && l.stock > 0);
    const costed = tracked.filter(l => l.avgCost != null);
    const open = this.db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE status NOT IN ('received','cancelled')").get().n;
    return {
      lines, writes: stock.writes, stale: stock.stale, fetchedAt: stock.fetchedAt,
      summary: {
        openOrders: open, awaitingApproval: this.db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE status='pending_approval'").get().n,
        incomingUnits: [...incoming.values()].reduce((s, n) => s + n, 0),
        incomingValue: this.db.prepare(`SELECT COALESCE(SUM(MAX(0, i.qty_ordered - i.qty_received) * i.unit_cost),0) AS v FROM purchase_order_items i JOIN purchase_orders p ON p.id=i.po_id WHERE p.status IN ('approved','ordered','partially_received')`).get().v,
        costValue: costed.reduce((s, l) => s + l.stock * l.avgCost, 0), retailValueOfCosted: costed.reduce((s, l) => s + l.stock * l.price, 0),
        linesWithCost: costed.length, linesWithoutCost: tracked.length - costed.length,
        toReorder: lines.filter(l => l.suggested > 0).length, threshold,
      },
    };
  }
}
