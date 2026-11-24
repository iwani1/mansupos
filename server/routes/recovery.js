// Recovery queue for interrupted or pending sales.
import { z } from 'zod';
import { AppError } from '../errors.js';

export function registerRecoveryRoutes(app, ctx) {
  const { db, auth, role } = ctx;
  app.get('/api/recovery/queue', auth, role('owner', 'manager'), (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).parse(req.query.limit || 200);
    const cursor = z.string().max(500).optional().parse(req.query.cursor);
    let after = null;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (typeof after.updatedAt !== 'string' || !after.updatedAt || after.updatedAt.length > 100 ||
            typeof after.id !== 'string' || !after.id || after.id.length > 100) throw new Error('Invalid cursor');
      } catch { throw new AppError('Invalid recovery cursor.', 400); }
    }
    const rows = db.prepare(`SELECT sales.id,sales.number,sales.status,sales.woo_order_id,sales.payment_method,
      sales.total,sales.refunded,sales.paid_at,sales.shift_id,sales.updated_at,
      EXISTS (SELECT 1 FROM sale_events WHERE sale_id=sales.id AND event='online.cash_intent_started') AS cash_intent_event,
      EXISTS (SELECT 1 FROM sale_events WHERE sale_id=sales.id AND event='online.cash_accepted') AS cash_custody_event,
      shifts.status AS original_shift_status
      FROM sales LEFT JOIN shifts ON shifts.id=sales.shift_id
      WHERE (sales.status IN ('creating','needs_reconciliation','awaiting_payment')
         OR (sales.refunded>0 AND sales.payment_method='cash'))
      ${after ? 'AND (sales.updated_at < ? OR (sales.updated_at = ? AND sales.id < ?))' : ''}
      ORDER BY sales.updated_at DESC,sales.id DESC LIMIT ?`)
      .all(...(after ? [after.updatedAt, after.updatedAt, after.id] : []), limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({ sales: page.map(row => ({ id: row.id, number: row.number, status: row.status,
      wooOrderId: row.woo_order_id, paymentMethod: row.payment_method, refundedCents: row.refunded,
      originalShiftId: row.shift_id, originalShiftStatus: row.original_shift_status || null,
      cashIntentAwaitingReview: Boolean(row.cash_intent_event) && !row.cash_custody_event &&
        row.status !== 'paid',
      cashCustodyUnresolved: Boolean(row.cash_custody_event) && row.status !== 'paid',
      cashHeldCents: Boolean(row.cash_custody_event) && row.status !== 'paid' ? row.total : 0,
      cashPayoutUnverified: row.refunded > 0 && row.payment_method === 'cash', updatedAt: row.updated_at })),
    hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ updatedAt: last.updated_at, id: last.id })).toString('base64url') : null,
    note: 'A Woo cash intent does not prove money was collected. A historical paid timestamp does not prove current payment. Woo refunds do not prove physical cash was paid back. Closed shifts remain frozen.' });
  });
}
