import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './errors.js';
import { audit } from './db.js';
import { localTransaction } from './sale-events.js';

// Customer profiles and loyalty points for retail sales.
//
// - A customer is identified by phone number (unique, stored as +233…).
// - Earn: 1 point per GH₵1 paid (after any points discount), when the sale is paid.
// - Redeem: in steps of 100 points; 100 points = GH₵1 off (1 point = 1 pesewa).
//   Points are taken when the order is prepared, so they cannot be spent twice,
//   and given back if that sale is cancelled or fails.
// - A customer return takes back the points earned on the refunded amount.
// Every change is a row in the append-only loyalty_ledger; customers.points is
// the running balance kept in the same SQLite transaction.

export const POINTS_PER_CEDI = 1;
export const REDEEM_STEP = 100;

const SETTLED = new Set(['paid', 'partially_refunded', 'refunded']);
const CLOSED = new Set(['cancelled', 'failed']);

// Ghana numbers: 0XXXXXXXXX, 233XXXXXXXXX or +233XXXXXXXXX. Other countries:
// + and 8-15 digits.
export function normalisePhone(value) {
  const digits = String(value || '').replace(/[\s().-]/g, '');
  if (/^0\d{9}$/.test(digits)) return `+233${digits.slice(1)}`;
  if (/^233\d{9}$/.test(digits)) return `+${digits}`;
  if (/^\+233\d{9}$/.test(digits)) return digits;
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  return null;
}

const phoneField = z.string().trim().max(24).transform((value, ctx) => {
  const phone = normalisePhone(value);
  if (!phone) ctx.addIssue({ code: 'custom', message: 'Enter a phone number such as 024 412 3456.' });
  return phone || '';
});
const plain = max => z.string().trim().max(max).refine(v => !/[<>]/.test(v), 'Do not use < or >.');
export const customerSchema = z.object({
  name: plain(80).pipe(z.string().min(2, 'Enter the customer\'s name.')),
  phone: phoneField,
  email: z.union([z.literal(''), z.string().trim().max(120).email('Enter a valid email or leave it empty.')]).optional().default(''),
  note: plain(250).optional().default(''),
}).strict();
export const customerUpdateSchema = customerSchema.partial().strict();
export const pointsAdjustSchema = z.object({
  points: z.number().int().min(-1000000).max(1000000).refine(v => v !== 0, 'Enter a number of points.'),
  note: plain(250).pipe(z.string().min(3, 'Say why the points are being changed.')),
}).strict();

const view = row => row && ({
  id: row.id, name: row.name, phone: row.phone, email: row.email, note: row.note, points: row.points,
  pointsValue: Math.floor(row.points / REDEEM_STEP) * REDEEM_STEP, // pesewas redeemable now
  createdAt: row.created_at, updatedAt: row.updated_at,
  visits: row.visits ?? undefined, spent: row.spent ?? undefined, lastVisit: row.last_visit ?? undefined,
});

export class CustomerService {
  constructor(db, config) {
    this.db = db; this.config = config;
    db.exec(`
      CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0), created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS sale_customers (sale_id TEXT PRIMARY KEY REFERENCES sales(id), customer_id TEXT NOT NULL REFERENCES customers(id),
        redeem_points INTEGER NOT NULL DEFAULT 0 CHECK(redeem_points >= 0), created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sale_customers_customer ON sale_customers(customer_id);
      CREATE TABLE IF NOT EXISTS loyalty_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL REFERENCES customers(id), sale_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('earn','redeem','redeem_returned','return','adjust')), points INTEGER NOT NULL, balance_after INTEGER NOT NULL,
        ref TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_ledger(customer_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_sale_once ON loyalty_ledger(sale_id, kind, ref) WHERE sale_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS loyalty_ledger_no_update BEFORE UPDATE ON loyalty_ledger BEGIN SELECT RAISE(ABORT,'Loyalty history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS loyalty_ledger_no_delete BEFORE DELETE ON loyalty_ledger BEGIN SELECT RAISE(ABORT,'Loyalty history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS customers_no_delete BEFORE DELETE ON customers BEGIN SELECT RAISE(ABORT,'Customers cannot be deleted'); END;
    `);
  }

  // ---------- profiles ----------
  search(query = '', limit = 50) {
    const text = String(query || '').trim().slice(0, 80);
    const phone = normalisePhone(text);
    const raw = text.replace(/\D/g, '');
    // A local number typed with its leading 0 (0244…) matches +233244….
    const digits = raw.startsWith('0') ? `233${raw.slice(1)}` : raw;
    const rows = this.db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM sale_customers sc JOIN sales s ON s.id=sc.sale_id WHERE sc.customer_id=c.id AND s.status IN ('paid','partially_refunded','refunded')) AS visits,
        (SELECT COALESCE(SUM(s.total - s.refunded),0) FROM sale_customers sc JOIN sales s ON s.id=sc.sale_id WHERE sc.customer_id=c.id AND s.status IN ('paid','partially_refunded','refunded')) AS spent,
        (SELECT MAX(s.paid_at) FROM sale_customers sc JOIN sales s ON s.id=sc.sale_id WHERE sc.customer_id=c.id) AS last_visit
      FROM customers c
      WHERE ? = '' OR c.phone = ? OR c.name LIKE ? ESCAPE '\\' OR (length(?) >= 4 AND replace(c.phone,'+','') LIKE ?)
      ORDER BY c.updated_at DESC LIMIT ?`)
      .all(text, phone || '', `%${text.replace(/[\\%_]/g, m => `\\${m}`)}%`, digits, `%${digits}%`, limit);
    return rows.map(view);
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM customers WHERE id=?').get(id);
    if (!row) throw new AppError('Customer not found.', 404);
    return row;
  }
  detail(id) {
    const customer = view(this.get(id));
    const sales = this.db.prepare(`SELECT s.id,s.number,s.status,s.total,s.refunded,s.paid_at,s.created_at,s.cashier_name,sc.redeem_points
      FROM sale_customers sc JOIN sales s ON s.id=sc.sale_id WHERE sc.customer_id=? ORDER BY s.created_at DESC LIMIT 100`).all(id)
      .map(s => ({ id: s.id, number: s.number, status: s.status, total: s.total, refunded: s.refunded, paidAt: s.paid_at, createdAt: s.created_at, cashierName: s.cashier_name, redeemedPoints: s.redeem_points }));
    const history = this.db.prepare('SELECT * FROM loyalty_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 200').all(id)
      .map(r => ({ id: r.id, kind: r.kind, points: r.points, balanceAfter: r.balance_after, saleId: r.sale_id, note: r.note, createdAt: r.created_at }));
    const settled = sales.filter(s => SETTLED.has(s.status));
    return { customer: { ...customer, visits: settled.length, spent: settled.reduce((n, s) => n + s.total - s.refunded, 0), lastVisit: settled[0]?.paidAt || null }, sales, history };
  }
  create(user, input) {
    const data = customerSchema.parse(input);
    if (this.db.prepare('SELECT 1 FROM customers WHERE phone=?').get(data.phone)) {
      throw new AppError('A customer with this phone number already exists. Search for them instead.', 409, 'CUSTOMER_EXISTS');
    }
    const id = randomUUID(); const time = now();
    localTransaction(this.db, () => {
      this.db.prepare('INSERT INTO customers(id,phone,name,email,note,points,created_by,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?,?)')
        .run(id, data.phone, data.name, data.email, data.note, user.id, time, time);
      audit(this.db, user.id, 'customer.created', id);
    });
    return view(this.get(id));
  }
  update(user, id, input) {
    const row = this.get(id);
    const data = customerUpdateSchema.parse(input);
    if (data.phone && data.phone !== row.phone && this.db.prepare('SELECT 1 FROM customers WHERE phone=? AND id<>?').get(data.phone, id)) {
      throw new AppError('Another customer already has this phone number.', 409, 'CUSTOMER_EXISTS');
    }
    const next = { ...row, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
    localTransaction(this.db, () => {
      this.db.prepare('UPDATE customers SET phone=?,name=?,email=?,note=?,updated_at=? WHERE id=?').run(next.phone, next.name, next.email, next.note, now(), id);
      audit(this.db, user.id, 'customer.updated', id);
    });
    return view(this.get(id));
  }

  // ---------- points ----------
  entry(customerId, saleId, kind, points, actorId, { ref = '', note = '' } = {}) {
    // Caller holds the transaction. Never below zero: a later deduction (e.g. a
    // return after the points were spent) takes only what is left.
    const row = this.get(customerId);
    const applied = points < 0 ? -Math.min(row.points, -points) : points;
    const balance = row.points + applied;
    this.db.prepare('INSERT INTO loyalty_ledger(customer_id,sale_id,kind,points,balance_after,ref,note,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(customerId, saleId, kind, applied, balance, ref, note, actorId || 'system', now());
    this.db.prepare('UPDATE customers SET points=?,updated_at=? WHERE id=?').run(balance, now(), customerId);
    return applied;
  }
  has(saleId, kind, ref = '') {
    return Boolean(this.db.prepare('SELECT 1 FROM loyalty_ledger WHERE sale_id=? AND kind=? AND ref=?').get(saleId, kind, ref));
  }
  adjust(user, id, input) {
    const data = pointsAdjustSchema.parse(input);
    const row = this.get(id);
    if (row.points + data.points < 0) throw new AppError(`This customer has ${row.points} points; you cannot remove more than that.`, 409);
    localTransaction(this.db, () => {
      this.entry(id, null, 'adjust', data.points, user.id, { note: data.note });
      audit(this.db, user.id, 'customer.points_adjusted', `${id}:${data.points}`);
    });
    return this.detail(id);
  }
  // Checked before any Woo order exists. Returns the discount in pesewas.
  planRedeem(customerId, points, goodsTotal) {
    if (!points) return 0;
    if (points % REDEEM_STEP) throw new AppError(`Use points in steps of ${REDEEM_STEP}.`, 400, 'POINTS_INVALID');
    const row = this.get(customerId);
    if (points > row.points) throw new AppError(`${row.name} has ${row.points} points, not ${points}.`, 409, 'POINTS_INSUFFICIENT');
    const discount = points; // 100 points = GH₵1.00 = 100 pesewas
    if (discount > goodsTotal - 100) throw new AppError('Points can pay for all but GH₵1.00 of the sale. Use fewer points.', 409, 'POINTS_TOO_MANY');
    return discount;
  }
  // Link the sale to its customer and take the redeemed points, in the same
  // transaction as the sale row is created.
  attach(saleId, customerId, redeemPoints, actorId) {
    this.db.prepare('INSERT INTO sale_customers(sale_id,customer_id,redeem_points,created_at) VALUES (?,?,?,?)').run(saleId, customerId, redeemPoints, now());
    if (redeemPoints) this.entry(customerId, saleId, 'redeem', -redeemPoints, actorId);
  }
  // Shown on the receipt and in Sales.
  saleInfo(saleId) {
    const link = this.forSale(saleId);
    if (!link) return null;
    const c = this.get(link.customer_id);
    const sum = kind => this.db.prepare('SELECT COALESCE(SUM(points),0) AS n FROM loyalty_ledger WHERE sale_id=? AND kind=?').get(saleId, kind).n;
    return { customerId: c.id, name: c.name, phone: c.phone, redeemed: link.redeem_points, discount: link.redeem_points, earned: sum('earn'), balance: c.points };
  }
  forSale(saleId) { return this.db.prepare('SELECT * FROM sale_customers WHERE sale_id=?').get(saleId) || null; }
  // Bring points in line with the sale's state. Safe to call repeatedly.
  sync(saleId, actorId = 'system') {
    const link = this.forSale(saleId);
    if (!link) return;
    const sale = this.db.prepare('SELECT id,status,total,refunded FROM sales WHERE id=?').get(saleId);
    if (!sale) return;
    localTransaction(this.db, () => {
      if (CLOSED.has(sale.status) && link.redeem_points && this.has(saleId, 'redeem') && !this.has(saleId, 'redeem_returned')) {
        this.entry(link.customer_id, saleId, 'redeem_returned', link.redeem_points, actorId, { note: 'Sale not completed' });
      }
      if (SETTLED.has(sale.status) && !this.has(saleId, 'earn')) {
        const points = Math.floor(sale.total / 100) * POINTS_PER_CEDI;
        if (points > 0) this.entry(link.customer_id, saleId, 'earn', points, actorId);
      }
    });
  }
  // A customer return: take back the points earned on the refunded amount.
  onReturn(saleId, returnId, refundCents, actorId) {
    const link = this.forSale(saleId);
    if (!link || refundCents <= 0 || !this.has(saleId, 'earn') || this.has(saleId, 'return', returnId)) return;
    const points = Math.floor(refundCents / 100) * POINTS_PER_CEDI;
    if (points <= 0) return;
    localTransaction(this.db, () => this.entry(link.customer_id, saleId, 'return', -points, actorId, { ref: returnId, note: 'Items returned' }));
  }
}
