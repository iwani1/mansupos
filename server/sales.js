import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './errors.js';
import { audit, saleView } from './db.js';
import { validateAvailability } from './catalog.js';
import { ShiftService } from './shifts.js';

export const prepareSchema = z.object({
  idempotencyKey: z.string().uuid(),
  items: z.array(z.object({ productId: z.number().int().positive(), variationId: z.number().int().positive().optional().default(0), quantity: z.number().int().min(1).max(999) }).strict()).min(1).max(100),
  note: z.string().trim().max(250).optional().default(''),
}).strict();
export const paymentSchema = z.object({
  method: z.enum(['cash', 'momo', 'card']),
  reference: z.string().trim().max(80).optional().default(''),
  tendered: z.number().int().min(0).max(100000000).optional(),
  confirmed: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.method !== 'cash' && !value.reference) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Enter the external payment reference.' });
  if (/\d{13,19}/.test(value.reference.replace(/\s/g, ''))) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Never enter a full card number. Use the merchant or terminal reference.' });
});
const methodNames = { cash: 'Cash', momo: 'Mobile Money (external)', card: 'Card (external terminal)' };
const methodCodes = { cash: 'pos_cash', momo: 'pos_momo', card: 'pos_card' };
const money = value => Math.round(Number(value || 0) * 100);
const fingerprint = items => createHash('sha256').update(JSON.stringify([...items].sort((a,b) => a.productId - b.productId || a.variationId - b.variationId).map(({productId,variationId,quantity}) => ({productId,variationId,quantity})))).digest('hex');

export class SalesService {
  constructor(db, catalog, api, config) { this.db = db; this.catalog = catalog; this.api = api; this.config = config; this.locks = new Set(); this.shifts = new ShiftService(db, config); }
  get(id, user) {
    const row = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
    if (!row) throw new AppError('Sale not found.', 404);
    if (user.role === 'cashier' && row.cashier_id !== user.id) throw new AppError('You can only view your own sales.', 403);
    return row;
  }
  list(user, limit = 250) {
    const rows = user.role === 'cashier'
      ? this.db.prepare('SELECT * FROM sales WHERE cashier_id=? ORDER BY created_at DESC LIMIT ?').all(user.id, limit)
      : this.db.prepare('SELECT * FROM sales ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(saleView);
  }
  async exclusive(key, fn) {
    if (this.locks.has(key)) throw new AppError('This sale is already being processed. Please wait.', 409);
    this.locks.add(key);
    try { return await fn(); } finally { this.locks.delete(key); }
  }
  saveRemote(row, order) {
    const paid = Boolean(order.date_paid) && ['processing', 'completed', 'refunded'].includes(order.status);
    const refunded = (order.refunds || []).reduce((sum, r) => sum + money(r.total), 0);
    const status = paid ? 'paid' : ['cancelled', 'trash', 'failed'].includes(order.status) ? 'cancelled' : 'awaiting_payment';
    const items = (order.line_items || []).map(item => {
      const original = JSON.parse(row.items_json).find(i => i.productId === item.product_id && i.variationId === (item.variation_id || 0));
      return { productId: item.product_id, variationId: item.variation_id || 0, name: item.name, label: item.meta_data?.find(m => ['Size', 'size'].includes(m.key))?.value || original?.label || '', sku: item.sku || '', image: original?.image || '', price: money(item.price), quantity: item.quantity, total: money(item.total), tax: money(item.total_tax) };
    });
    this.db.prepare('UPDATE sales SET woo_order_id=?,number=?,status=?,total=?,tax=?,subtotal=?,refunded=?,currency=?,items_json=?,updated_at=?,paid_at=?,error=NULL WHERE id=?')
      .run(order.id, `${this.config.mode === 'live' ? 'WC' : 'STG'}-${order.number || order.id}`, status, money(order.total), money(order.total_tax), (order.line_items || []).reduce((sum,i) => sum + money(i.subtotal), 0), Math.abs(refunded), order.currency, JSON.stringify(items), now(), paid ? `${order.date_paid_gmt || order.date_paid}Z` : null, row.id);
    if (status === 'paid') this.catalog.invalidate();
    return this.get(row.id, { role: 'owner' });
  }
  async prepare(user, input) {
    if (this.config.mode !== 'demo' && !this.config.writesEnabled) throw new AppError('Checkout is locked. Complete staging tests and enable the approved server-side write gate first.', 403, 'CHECKOUT_LOCKED');
    return this.exclusive(`prepare:${input.idempotencyKey}`, async () => {
      const hash = fingerprint(input.items);
      const existing = this.db.prepare('SELECT * FROM sales WHERE idempotency_key=?').get(input.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== hash || existing.cashier_id !== user.id) throw new AppError('This checkout key belongs to a different cart.', 409);
        if (existing.status === 'needs_reconciliation' || existing.status === 'creating') throw new AppError('This sale needs reconciliation before another attempt.', 409, 'RECONCILIATION_REQUIRED');
        return saleView(existing);
      }
      const shift = this.config.requireShift && this.config.mode !== 'demo' ? this.shifts.requireOpen(user.id) : this.shifts.current(user.id);
      const id = randomUUID();
      const time = now();
      const number = `DEMO-${id.slice(0, 8).toUpperCase()}`;
      this.db.prepare('INSERT INTO sales(id,idempotency_key,fingerprint,number,status,currency,cashier_id,cashier_name,note,created_at,updated_at,shift_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.idempotencyKey, hash, number, 'creating', 'GHS', user.id, user.name, input.note, time, time, shift?.id || null);
      const row = this.get(id, user);
      try {
        const lines = await this.catalog.fresh(input.items);
        validateAvailability(lines);
        if (this.config.mode === 'demo') {
          const total = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
          this.db.prepare('UPDATE sales SET status=?,total=?,subtotal=?,items_json=? WHERE id=?').run('awaiting_payment', total, total, JSON.stringify(lines.map(l => ({ ...l, total: l.price * l.quantity, tax: 0 }))), id);
        } else {
          const order = await this.api.createOrder({
            status: 'pending', payment_method: '', payment_method_title: 'In-store payment pending',
            line_items: input.items.map(i => ({ product_id: i.productId, ...(i.variationId ? { variation_id: i.variationId } : {}), quantity: i.quantity })),
            shipping: [], customer_note: input.note,
            meta_data: [{ key: '_mansu_pos_key', value: input.idempotencyKey }, { key: '_mansu_pos_channel', value: 'mansu-pos' }, { key: '_mansu_pos_cashier', value: user.id }],
          });
          this.db.prepare('UPDATE sales SET woo_order_id=? WHERE id=?').run(order.id, id);
          this.saveRemote(row, order);
          if (order.currency !== 'GHS') {
            this.db.prepare('UPDATE sales SET status=?,error=? WHERE id=?').run('needs_reconciliation', 'The connected store is not using GHS. Review the pending WooCommerce order.', id);
            throw new AppError('The connected store is not using GHS. Checkout stopped for owner review.', 409);
          }
        }
        audit(this.db, user.id, 'sale.prepared', id);
        return saleView(this.get(id, user));
      } catch (error) {
        const mayExistRemotely = Boolean(this.get(id, user).woo_order_id);
        this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run(error.uncertain || mayExistRemotely ? 'needs_reconciliation' : 'failed', error.message, now(), id);
        if (error instanceof AppError && !error.uncertain && !mayExistRemotely) throw error;
        throw new AppError('Checkout was interrupted. Do not create another order; reconcile this sale from Sales first.', 502, 'RECONCILIATION_REQUIRED');
      }
    });
  }
  async complete(user, id, payment) {
    return this.exclusive(`sale:${id}`, async () => {
      let row = this.get(id, user);
      if (row.status === 'paid') return saleView(row);
      if (row.status !== 'awaiting_payment') throw new AppError('This sale is not ready to record payment. Reconcile or review it first.', 409);
      if (this.config.requireShift && this.config.mode !== 'demo') {
        const shift = row.shift_id ? this.db.prepare('SELECT status FROM shifts WHERE id=?').get(row.shift_id) : null;
        if (!shift || shift.status !== 'open') throw new AppError('The shift for this sale is closed. Ask an owner to review it before recording payment.', 409, 'SHIFT_CLOSED');
      }
      const total = row.total;
      if (payment.method === 'cash' && (payment.tendered == null || payment.tendered < total)) throw new AppError('Cash received must cover the WooCommerce order total.', 400);
      const tendered = payment.method === 'cash' ? payment.tendered : total;
      const reference = payment.method === 'cash' ? '' : payment.reference;
      const finish = () => {
        this.db.prepare('UPDATE sales SET status=?,payment_method=?,payment_reference=?,tendered=?,change_due=?,paid_at=?,updated_at=?,error=NULL WHERE id=?')
          .run('paid', payment.method, reference, tendered, tendered - total, now(), now(), id);
        audit(this.db, user.id, 'sale.paid', `${id}:${payment.method}`);
        return saleView(this.get(id, user));
      };
      if (this.config.mode === 'demo') {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const item of JSON.parse(row.items_json)) {
            const key = `${item.productId}:${item.variationId || 0}`;
            const stock = this.db.prepare('SELECT stock FROM demo_stock WHERE line_key=?').get(key);
            if (!stock || stock.stock < item.quantity) throw new AppError(`Demo stock changed for ${item.name}. Prepare a new sale.`, 409);
            this.db.prepare('UPDATE demo_stock SET stock=stock-? WHERE line_key=?').run(item.quantity, key);
          }
          const result = finish();
          this.db.exec('COMMIT');
          return result;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      try {
        validateAvailability(await this.catalog.fresh(JSON.parse(row.items_json).map(i => ({ productId: i.productId, variationId: i.variationId, quantity: i.quantity }))));
        // Persist the intended payment record before the remote write so a lost response can be reconciled.
        this.db.prepare('UPDATE sales SET payment_method=?,payment_reference=?,tendered=?,change_due=? WHERE id=?').run(payment.method, reference, tendered, tendered - total, id);
        const order = await this.api.updateOrder(row.woo_order_id, {
          status: this.config.orderStatus, set_paid: true,
          payment_method: methodCodes[payment.method], payment_method_title: methodNames[payment.method],
          transaction_id: reference,
          meta_data: [{ key: '_mansu_pos_payment_recorded', value: 'externally-collected' }, { key: '_mansu_pos_paid_at', value: now() }],
        });
        const saved = this.saveRemote(row, order);
        if (saved.status !== 'paid') throw new AppError('WooCommerce has not confirmed payment. Reconcile this sale before retrying.', 409);
        audit(this.db, user.id, 'sale.paid', `${id}:${payment.method}`);
        return saleView(this.get(id, user));
      } catch (error) {
        this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run('needs_reconciliation', 'Payment confirmation was interrupted. Check the WooCommerce order before taking another payment.', now(), id);
        if (error instanceof AppError && !error.uncertain && error.code !== 'WOOCOMMERCE_ERROR') throw error;
        throw new AppError('Payment confirmation needs reconciliation. Do not collect a second payment or create a new order.', 502, 'RECONCILIATION_REQUIRED');
      }
    });
  }
  async reconcile(user, id) {
    return this.exclusive(`sale:${id}`, async () => {
      const row = this.get(id, user);
      if (this.config.mode === 'demo') throw new AppError('Demo sales do not connect to WooCommerce.', 400);
      if (row.status === 'paid' || row.status === 'awaiting_payment' || row.status === 'cancelled') {
        if (!row.woo_order_id) return saleView(row);
      }
      const order = row.woo_order_id ? await this.api.order(row.woo_order_id) : await this.api.findOrderByKey(row.idempotency_key, row.created_at);
      if (!order) {
        this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?').run('needs_reconciliation', 'No matching WooCommerce order found in the recent search window. Owner must verify in WooCommerce before retrying.', now(), id);
        throw new AppError('No matching order found. Do not retry checkout until the owner has verified WooCommerce.', 409);
      }
      if (!order.meta_data?.some(m => m.key === '_mansu_pos_key' && m.value === row.idempotency_key)) throw new AppError('Order identity did not match this checkout.', 409);
      const saved = saleView(this.saveRemote(row, order));
      audit(this.db, user.id, 'sale.reconciled', id);
      return saved;
    });
  }
  async reconcilePending(user = { id: 'system', role: 'owner', name: 'System' }, limit = 20) {
    if (this.config.mode === 'demo' || !this.config.configured) return { checked: 0, reconciled: 0, failed: 0 };
    const rows = this.db.prepare("SELECT id FROM sales WHERE status IN ('creating','needs_reconciliation','awaiting_payment') OR (status='paid' AND updated_at < ?) ORDER BY updated_at ASC LIMIT ?")
      .all(new Date(Date.now() - 3600000).toISOString(), limit);
    let reconciled = 0, failed = 0;
    for (const row of rows) {
      try { await this.reconcile(user, row.id); reconciled++; }
      catch { failed++; }
    }
    if (rows.length) audit(this.db, user.id, 'sale.reconcile_pending', `checked=${rows.length};reconciled=${reconciled};failed=${failed}`);
    return { checked: rows.length, reconciled, failed };
  }
  async cancel(user, id) {
    return this.exclusive(`sale:${id}`, async () => {
      const row = this.get(id, user);
      if (row.status === 'cancelled') return saleView(row);
      if (!['awaiting_payment', 'failed'].includes(row.status)) throw new AppError('Only an unpaid, known order can be cancelled here. Handle paid orders and refunds in WooCommerce.', 409);
      if (this.config.mode !== 'demo' && row.woo_order_id) await this.api.updateOrder(row.woo_order_id, { status: 'cancelled' });
      this.db.prepare('UPDATE sales SET status=?,updated_at=?,error=NULL WHERE id=?').run('cancelled', now(), id);
      audit(this.db, user.id, 'sale.cancelled', id);
      return saleView(this.get(id, user));
    });
  }
}
