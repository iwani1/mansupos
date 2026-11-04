import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now } from './errors.js';
import { audit } from './db.js';

export const openShiftSchema = z.object({ openingFloat: z.number().int().min(0).max(100000000), note: z.string().trim().max(250).optional().default('') }).strict();
export const closeShiftSchema = z.object({ closingCash: z.number().int().min(0).max(1000000000), note: z.string().trim().max(250).optional().default('') }).strict();
export const cashMovementSchema = z.object({ type: z.enum(['in', 'out']), amount: z.number().int().min(1).max(100000000), reason: z.string().trim().min(3).max(250) }).strict();

export class ShiftService {
  constructor(db, config) { this.db = db; this.config = config; }
  current(userId) {
    const row = this.db.prepare("SELECT * FROM shifts WHERE user_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1").get(userId);
    return row ? this.view(row) : null;
  }
  requireOpen(userId) {
    const shift = this.current(userId);
    if (!shift) throw new AppError('Open a shift before preparing a sale.', 409, 'SHIFT_REQUIRED');
    return shift;
  }
  get(id, user) {
    const row = this.db.prepare('SELECT * FROM shifts WHERE id=?').get(id);
    if (!row) throw new AppError('Shift not found.', 404);
    if (user.role === 'cashier' && row.user_id !== user.id) throw new AppError('You can only view your own shifts.', 403);
    return row;
  }
  expectedCash(shiftId) {
    const shift = this.db.prepare('SELECT * FROM shifts WHERE id=?').get(shiftId);
    if (!shift) return 0;
    const sales = this.db.prepare("SELECT COALESCE(SUM(total - refunded),0) AS total FROM sales WHERE shift_id=? AND status='paid' AND payment_method='cash'").get(shiftId).total;
    const movements = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN type='in' THEN amount ELSE -amount END),0) AS total FROM cash_movements WHERE shift_id=?").get(shiftId).total;
    return shift.opening_float + sales + movements;
  }
  view(row) {
    const expected = this.expectedCash(row.id);
    const summary = this.db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total - refunded),0) AS net,
      COALESCE(SUM(CASE WHEN payment_method='cash' THEN total - refunded ELSE 0 END),0) AS cash,
      COALESCE(SUM(CASE WHEN payment_method='momo' THEN total - refunded ELSE 0 END),0) AS momo,
      COALESCE(SUM(CASE WHEN payment_method='card' THEN total - refunded ELSE 0 END),0) AS card
      FROM sales WHERE shift_id=? AND status='paid'`).get(row.id);
    const movements = this.db.prepare('SELECT * FROM cash_movements WHERE shift_id=? ORDER BY created_at').all(row.id);
    return {
      id: row.id, userId: row.user_id, userName: row.user_name, status: row.status,
      openingFloat: row.opening_float, closingCash: row.closing_cash, expectedCash: row.status === 'open' ? expected : row.expected_cash,
      variance: row.variance, note: row.note, openedAt: row.opened_at, closedAt: row.closed_at,
      summary, movements: movements.map(m => ({ id: m.id, type: m.type, amount: m.amount, reason: m.reason, createdAt: m.created_at })),
    };
  }
  open(user, input) {
    if (this.current(user.id)) throw new AppError('You already have an open shift. Close it before opening another.', 409);
    const id = randomUUID();
    this.db.prepare('INSERT INTO shifts(id,user_id,user_name,opening_float,note,opened_at) VALUES (?,?,?,?,?,?)')
      .run(id, user.id, user.name, input.openingFloat, input.note, now());
    audit(this.db, user.id, 'shift.opened', id);
    return this.view(this.db.prepare('SELECT * FROM shifts WHERE id=?').get(id));
  }
  close(user, id, input) {
    const row = this.get(id, user);
    if (row.user_id !== user.id && user.role !== 'owner') throw new AppError('Only the cashier who opened the shift, or an owner, can close it.', 403);
    if (row.status !== 'open') throw new AppError('This shift is already closed.', 409);
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM sales WHERE shift_id=? AND status IN ('creating','awaiting_payment','needs_reconciliation')").get(id).n;
    if (pending) throw new AppError(`${pending} sale(s) still need payment or reconciliation. Resolve them before closing the shift.`, 409);
    const expected = this.expectedCash(id);
    const variance = input.closingCash - expected;
    this.db.prepare("UPDATE shifts SET status='closed',closing_cash=?,expected_cash=?,variance=?,note=?,closed_at=? WHERE id=?")
      .run(input.closingCash, expected, variance, input.note || row.note, now(), id);
    audit(this.db, user.id, 'shift.closed', `${id}:variance=${variance}`);
    return this.view(this.db.prepare('SELECT * FROM shifts WHERE id=?').get(id));
  }
  movement(user, id, input) {
    const row = this.get(id, user);
    if (row.status !== 'open') throw new AppError('Cash movements can only be recorded against an open shift.', 409);
    if (row.user_id !== user.id && user.role !== 'owner') throw new AppError('You can only record cash movements for your own shift.', 403);
    if (input.type === 'out' && this.expectedCash(id) < input.amount) throw new AppError('Cash out cannot exceed the expected drawer cash.', 400);
    const movementId = randomUUID();
    this.db.prepare('INSERT INTO cash_movements(id,shift_id,user_id,type,amount,reason,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(movementId, id, user.id, input.type, input.amount, input.reason, now());
    audit(this.db, user.id, `shift.cash_${input.type}`, `${id}:${input.amount}`);
    return this.view(this.db.prepare('SELECT * FROM shifts WHERE id=?').get(id));
  }
  list(user, days = 7) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = user.role === 'cashier'
      ? this.db.prepare('SELECT * FROM shifts WHERE user_id=? AND opened_at>=? ORDER BY opened_at DESC LIMIT 200').all(user.id, since)
      : this.db.prepare('SELECT * FROM shifts WHERE opened_at>=? ORDER BY opened_at DESC LIMIT 200').all(since);
    return rows.map(row => this.view(row));
  }
}
