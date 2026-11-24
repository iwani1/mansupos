import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Pilot health, read straight from each shop's own database (read-only, safe
// while the shop is open). "Needs attention" = a sale that has been neither
// paid nor cancelled for over 30 minutes: the early sign of a lost sale.
const ATTENTION = "status IN ('creating','awaiting_payment','needs_reconciliation')";

export function shopMetrics(registry, shop, now = Date.now()) {
  const file = path.join(registry.shopDir(shop), 'pos-live.db');
  if (!fs.existsSync(file)) return { available: false };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    const iso = ms => new Date(ms).toISOString();
    const one = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch { return null; } };
    const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
    const week = one("SELECT COUNT(*) AS n, COALESCE(SUM(total - refunded),0) AS amount FROM sales WHERE status='paid' AND paid_at>=?", iso(now - 7 * 86400000));
    const day = one("SELECT COUNT(*) AS n, COALESCE(SUM(total - refunded),0) AS amount FROM sales WHERE status='paid' AND paid_at>=?", today.toISOString());
    return {
      available: true,
      salesToday: day?.n ?? 0, takingsToday: day?.amount ?? 0,
      sales7d: week?.n ?? 0, takings7d: week?.amount ?? 0,
      lastSaleAt: one("SELECT MAX(paid_at) AS at FROM sales WHERE status='paid'")?.at ?? null,
      needsAttention: one(`SELECT COUNT(*) AS n FROM sales WHERE ${ATTENTION} AND updated_at<?`, iso(now - 30 * 60000))?.n ?? 0,
      openShifts: one("SELECT COUNT(*) AS n FROM shifts WHERE status='open'")?.n ?? 0,
      staff: one("SELECT COUNT(*) AS n FROM users WHERE active=1")?.n ?? 0,
      lastSignInAt: one("SELECT MAX(created_at) AS at FROM audit WHERE action='auth.login'")?.at ?? null,
    };
  } finally { db.close(); }
}

// Things worth a look, worst first.
export function healthFlags(shop, metrics, access) {
  const flags = [];
  if (metrics.needsAttention) flags.push({ level: 'critical', text: `${metrics.needsAttention} sale(s) stuck for over 30 minutes — reconcile now` });
  if (access.state === 'lapsed') flags.push({ level: 'warning', text: 'Lapsed: sales paused' });
  if (access.state === 'grace') flags.push({ level: 'warning', text: 'Payment overdue' });
  if (shop.health && shop.health.ok === false) flags.push({ level: 'warning', text: 'Store check failing' });
  if (shop.stage === 'selling' && metrics.available && (!metrics.lastSaleAt || Date.now() - Date.parse(metrics.lastSaleAt) > 7 * 86400000)) flags.push({ level: 'info', text: 'Selling, but no sale in 7 days' });
  if (shop.stage !== 'selling' && Date.now() - Date.parse(shop.createdAt) > 7 * 86400000) flags.push({ level: 'info', text: 'Not selling a week after sign-up' });
  return flags;
}
