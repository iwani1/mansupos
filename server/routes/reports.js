// Sales reports and CSV export.
import { z } from 'zod';
import { audit, saleView } from '../db.js';
import { now } from '../errors.js';

export function registerReportRoutes(app, ctx) {
  const { config, db, auth, role } = ctx;
  const recordedPaidStatuses = ['paid', 'partially_refunded', 'refunded', 'needs_reconciliation'];
  const reportRows = (user, since) => {
    // paid_at is the prior POS payment evidence. A later Woo discrepancy must
    // flag that receipt for review, not silently remove its recorded cash or
    // historical report row. An unconfirmed payment attempt has no paid_at.
    const sql = `SELECT * FROM sales WHERE status IN (${recordedPaidStatuses.map(() => '?').join(',')}) AND paid_at IS NOT NULL AND paid_at>=? ${user.role === 'cashier' ? 'AND cashier_id=?' : ''} ORDER BY paid_at ASC, id ASC`;
    const params = [...recordedPaidStatuses, since.toISOString(), ...(user.role === 'cashier' ? [user.id] : [])];
    return db.prepare(sql).all(...params).map(saleView);
  };
  app.get('/api/reports', auth, role('owner', 'manager'), (req, res) => {
    const days = z.coerce.number().int().min(1).max(90).parse(req.query.days || 7);
    const since = new Date(); since.setUTCHours(0,0,0,0); since.setUTCDate(since.getUTCDate() - days + 1);
    const rows = reportRows(req.user, since);
    const net = sale => sale.total - (sale.refunded || 0);
    const total = rows.reduce((sum, sale) => sum + net(sale), 0);
    const gross = rows.reduce((sum, sale) => sum + sale.total, 0);
    const refunded = rows.reduce((sum, sale) => sum + (sale.refunded || 0), 0);
    const active = rows.filter(sale => sale.refunded < sale.total);
    const methods = ['cash','momo','card'].map(method => { const matches = rows.filter(s => s.paymentMethod === method); return { method, count: matches.length, total: matches.reduce((sum,s) => sum + net(s), 0) }; });
    const saleTypes = ['retail','wholesale'].map(type => { const matches = rows.filter(s => s.saleType === type); return { type, count: matches.length, total: matches.reduce((sum,s) => sum + net(s), 0) }; });
    const daily = Array.from({ length: days }, (_, i) => { const date = new Date(since); date.setUTCDate(date.getUTCDate() + i); const key = date.toISOString().slice(0,10); const matches = rows.filter(s => s.paidAt?.startsWith(key)); return { date: key, total: matches.reduce((sum,s) => sum + net(s), 0), count: matches.length }; });
    const products = new Map();
    for (const sale of active) for (const item of sale.items) { const key = `${item.productId}:${item.variationId}`; const p = products.get(key) || { name: item.name, label: item.label, quantity: 0, total: 0 }; p.quantity += item.quantity; p.total += item.total; products.set(key,p); }
    res.json({ days, since: since.toISOString(), total, gross, refunded, orders: rows.length, activeOrders: active.length, refundedOrders: rows.length - active.length,
      reviewRequiredOrders: rows.filter(s => s.status === 'needs_reconciliation').length,
      items: active.reduce((sum,s) => sum + s.items.reduce((n,i) => n + i.quantity,0),0), average: rows.length ? Math.round(total / rows.length) : 0, methods, saleTypes, daily, topProducts: [...products.values()].sort((a,b) => b.quantity - a.quantity).slice(0,8), sales: rows,
      scope: 'Recorded POS payments, including previously paid receipts under review. Woo refunds are observations, not proof of cash payouts. Excludes legacy POS-only In-store cash receipts and online website orders.' });
  });
  app.get('/api/reports/export', auth, role('owner', 'manager'), (req, res) => {
    const days = z.coerce.number().int().min(1).max(90).parse(req.query.days || 7);
    const since = new Date(); since.setUTCHours(0,0,0,0); since.setUTCDate(since.getUTCDate() - days + 1);
    const rows = reportRows(req.user, since);
    // eslint-disable-next-line no-control-regex -- CSV formula hardening intentionally strips control characters.
    const cell = value => { let text = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"','""')}"`; };
    const csv = [['Receipt','WooCommerce order','Paid at (UTC)','Cashier','Shift','Payment method','External reference','Status','Gross GHS','Refunded GHS','Net GHS','Mode','Sale type','Wholesale buyer','Wholesale approved by','Agreed wholesale total GHS'],
      ...rows.map(s => [s.number,s.wooOrderId || '',s.paidAt,s.cashierName,s.shiftId || '',s.paymentMethod,s.paymentReference,s.status,(s.total/100).toFixed(2),((s.refunded||0)/100).toFixed(2),((s.total-(s.refunded||0))/100).toFixed(2),config.mode,s.saleType,s.buyerName,s.wholesaleApprovedByName,s.agreedTotal != null ? (s.agreedTotal/100).toFixed(2) : ''])]
      .map(row => row.map(cell).join(',')).join('\r\n');
    audit(db, req.user.id, 'reports.export', `${rows.length} rows`);
    res.type('text/csv').attachment(`mansu-pos-${config.mode}-${now().slice(0,10)}.csv`).send(csv);
  });
}
