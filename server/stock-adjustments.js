import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './errors.js';
import { audit } from './db.js';
import { localTransaction } from './sale-events.js';

// A supervised request/review queue, NOT a second inventory balance.
// Production WooCommerce stock edits require an independently reviewed atomic
// compare-and-set integration; ordinary Woo product PUT can overwrite sales.
export const adjustmentRequestSchema = z.object({
  productId: z.number().int().positive(),
  variationId: z.number().int().min(0).default(0),
  expectedQuantity: z.number().int().min(0).max(100000),
  targetQuantity: z.number().int().min(0).max(100000),
  reason: z.enum(['delivery','recount','damage','missing','return','correction']),
  note: z.string().trim().min(8).max(250),
}).strict();

export const adjustmentReviewSchema = z.object({
  decision: z.enum(['approve','reject']),
  note: z.string().trim().max(250).default(''),
}).strict().superRefine((value, ctx) => {
  if (value.decision === 'reject' && value.note.length < 8) {
    ctx.addIssue({code: 'custom', path: ['note'], message: 'Explain the rejection in at least eight characters.'});
  }
});

const present = row => ({
  id: row.id, productId: row.product_id, variationId: row.variation_id,
  name: row.product_name, label: row.option_label, sku: row.sku,
  stockPool: row.stock_pool, expectedQuantity: row.expected_quantity,
  targetQuantity: row.target_quantity, reason: row.reason, note: row.note,
  requestedBy: row.requested_by, requesterName: row.requester_name,
  createdAt: row.created_at, status: row.status,
  reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at,
  reviewNote: row.review_note, verifiedAt: row.verified_at,
});

export class StockAdjustmentService {
  constructor(db, catalog, config) {
    this.db = db;
    this.catalog = catalog;
    this.config = config;
    // Independent append-only review queue. This does not change the bound
    // v9 trading ledger contract, existing checkout tables or WooCommerce.
    // A service that cannot create the table fails startup rather than
    // silently losing staff requests. Backup includes this SQLite table.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stock_adjustment_requests (
        id TEXT PRIMARY KEY, product_id INTEGER NOT NULL CHECK(product_id>0),
        variation_id INTEGER NOT NULL CHECK(variation_id>=0),
        stock_pool TEXT NOT NULL, product_name TEXT NOT NULL, option_label TEXT NOT NULL,
        sku TEXT NOT NULL, expected_quantity INTEGER NOT NULL CHECK(expected_quantity>=0),
        target_quantity INTEGER NOT NULL CHECK(target_quantity BETWEEN 0 AND 100000),
        reason TEXT NOT NULL, note TEXT NOT NULL,
        requested_by TEXT NOT NULL REFERENCES users(id), requester_name TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','approved','rejected','verified')),
        reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, review_note TEXT,
        verified_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_adjustment_open_pool ON stock_adjustment_requests(stock_pool)
        WHERE status IN ('pending','approved');
      CREATE INDEX IF NOT EXISTS idx_stock_adjustment_requested ON stock_adjustment_requests(requested_by,created_at);
      CREATE TRIGGER IF NOT EXISTS stock_adjustment_no_delete BEFORE DELETE ON stock_adjustment_requests
        BEGIN SELECT RAISE(ABORT,'Stock adjustment history must be preserved'); END;
    `);
  }

  list(user) {
    const rows = user.role === 'cashier'
      ? this.db.prepare('SELECT * FROM stock_adjustment_requests WHERE requested_by=? ORDER BY created_at DESC,id DESC LIMIT 100').all(user.id)
      : this.db.prepare('SELECT * FROM stock_adjustment_requests ORDER BY created_at DESC,id DESC LIMIT 100').all();
    return { requests: rows.map(present), liveWooWritesEnabled: false,
      scope: 'POS request and review records only. No live WooCommerce quantity change is performed.' };
  }

  async stock(productId, variationId) {
    // A fresh exact Woo product/variation GET, not a cached browser stock count.
    const [line] = await this.catalog.fresh([{ productId, variationId, quantity: 1 }]);
    if (!line?.manageStock || !Number.isSafeInteger(line.stock) || line.stock < 0 ||
        line.stockSource === 'unknown' || line.backordersAllowed === true) {
      throw new AppError('This stock owner is untracked or unverified in WooCommerce. Correct its stock management in WooCommerce first.', 409, 'STOCK_OWNER_UNVERIFIED');
    }
    if (variationId && line.stockSource === 'parent') {
      throw new AppError('This size shares parent stock. Do not edit it as an independent variation; use WooCommerce to review the parent stock pool.', 409, 'SHARED_PARENT_STOCK');
    }
    const stockPool = line.stockKey || `${productId}:${variationId}`;
    return { ...line, stockPool };
  }

  async request(user, raw) {
    const input = adjustmentRequestSchema.parse(raw);
    const current = await this.stock(input.productId, input.variationId);
    if (current.stock !== input.expectedQuantity) {
      throw new AppError('Stock changed since your screen loaded. Refresh and recount before requesting an adjustment.', 409, 'STOCK_CHANGED');
    }
    if (input.targetQuantity === current.stock) {
      throw new AppError('The proposed quantity is already the current stock. Nothing to adjust.', 409, 'NO_STOCK_CHANGE');
    }
    const record = {
      id: randomUUID(), at: now(), ...input,
      name: current.name, label: current.label || '', sku: current.sku || '',
      pool: current.stockPool,
    };
    try {
      localTransaction(this.db, () => {
        this.db.prepare(`INSERT INTO stock_adjustment_requests
          (id,product_id,variation_id,stock_pool,product_name,option_label,sku,expected_quantity,
            target_quantity,reason,note,requested_by,requester_name,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, input.productId,
          input.variationId, record.pool, record.name, record.label, record.sku,
          input.expectedQuantity, input.targetQuantity, input.reason, input.note,
          user.id, user.name, record.at);
        audit(this.db, user.id, 'stock_adjustment.requested', record.id);
      });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint')) {
        throw new AppError('An open adjustment already exists for this stock pool. Ask the owner to resolve it first.', 409, 'ADJUSTMENT_ALREADY_OPEN');
      }
      throw error;
    }
    return this.get(record.id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM stock_adjustment_requests WHERE id=?').get(id);
    if (!row) throw new AppError('Stock adjustment request not found.', 404);
    return present(row);
  }

  async review(user, id, raw) {
    const input = adjustmentReviewSchema.parse(raw);
    const row = this.db.prepare('SELECT * FROM stock_adjustment_requests WHERE id=?').get(id);
    if (!row) throw new AppError('Stock adjustment request not found.', 404);
    if (row.status !== 'pending') throw new AppError('This request was already reviewed. Refresh the queue.', 409, 'REVIEW_ALREADY_COMPLETE');
    if (input.decision === 'approve') {
      const current = await this.stock(row.product_id, row.variation_id);
      if (current.stockPool !== row.stock_pool || current.stock !== row.expected_quantity ||
          current.name !== row.product_name || (current.label || '') !== row.option_label ||
          (current.sku || '') !== row.sku) {
        throw new AppError('WooCommerce stock or product identity changed. Reject this request and submit an updated physical count.', 409, 'STOCK_CHANGED');
      }
    }
    const status = input.decision === 'approve' ? (this.config.mode === 'demo' ? 'verified' : 'approved') : 'rejected';
    const at = now();
    localTransaction(this.db, () => {
      const update = this.db.prepare(`UPDATE stock_adjustment_requests
        SET status=?,reviewed_by=?,reviewed_at=?,review_note=?,verified_at=?
        WHERE id=? AND status='pending'`).run(status,user.id,at,input.note,
          status === 'verified' ? at : null,id);
      if (update.changes !== 1) throw new AppError('The review changed. Refresh the queue.',409,'REVIEW_ALREADY_COMPLETE');
      if (this.config.mode === 'demo' && status === 'verified') {
        const edited = this.db.prepare('UPDATE demo_stock SET stock=? WHERE line_key=? AND stock=?')
          .run(row.target_quantity,row.stock_pool,row.expected_quantity);
        if (edited.changes !== 1) throw new AppError('Demo stock changed. Refresh and re-request.',409,'STOCK_CHANGED');
      }
      audit(this.db,user.id,`stock_adjustment.${status === 'rejected' ? 'rejected' : 'approved'}`,id);
      if (status === 'verified') audit(this.db,user.id,'stock_adjustment.demo_applied',id);
    });
    if (this.config.mode === 'demo' && status === 'verified') this.catalog.invalidate();
    // Live approval never calls Woo product PUT or modifies a stock quantity.
    return this.get(id);
  }

  async verify(user, id) {
    const row = this.db.prepare('SELECT * FROM stock_adjustment_requests WHERE id=?').get(id);
    if (!row) throw new AppError('Stock adjustment request not found.',404);
    if (row.status !== 'approved' || this.config.mode === 'demo') {
      throw new AppError('Only an approved live request can be checked against WooCommerce.',409,'ADJUSTMENT_NOT_APPROVED');
    }
    const current = await this.stock(row.product_id,row.variation_id);
    if (current.stockPool !== row.stock_pool || current.stock !== row.target_quantity ||
        current.name !== row.product_name || (current.label || '') !== row.option_label ||
        (current.sku || '') !== row.sku) {
      throw new AppError('Fresh WooCommerce stock does not match the approved target or product identity. Do not mark this as complete.',409,'STOCK_NOT_VERIFIED');
    }
    localTransaction(this.db, () => {
      const applied = this.db.prepare(`UPDATE stock_adjustment_requests SET status='verified',verified_at=?
        WHERE id=? AND status='approved'`).run(now(),id);
      if (applied.changes !== 1) throw new AppError('This request changed. Refresh the queue.',409);
      audit(this.db,user.id,'stock_adjustment.woo_balance_observed',id);
    });
    return this.get(id);
  }
}
