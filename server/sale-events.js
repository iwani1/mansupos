import { now } from './errors.js';

// Keep local row transitions and their audit/event evidence in ONE SQLite
// commit. Never hold this transaction open while calling WooCommerce.
export function localTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Only server-chosen, non-secret fields go in details. A payment reference,
// buyer identity, raw Woo response, or HTTP credential must not be copied here.
export function saleEvent(db, saleId, event, actorId, { wooOrderId = null, amountCents = null, details = {} } = {}) {
  const json = JSON.stringify(details);
  if (json.length > 1024 || (wooOrderId != null && (!Number.isSafeInteger(Number(wooOrderId)) || Number(wooOrderId) < 1)) ||
      (amountCents != null && (!Number.isSafeInteger(amountCents) || amountCents < 0))) {
    throw new Error('Invalid non-secret sale event fields.');
  }
  db.prepare('INSERT INTO sale_events(sale_id,event,actor_id,woo_order_id,amount_cents,detail_json,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(saleId, event, actorId || 'system', wooOrderId == null ? null : Number(wooOrderId), amountCents, json, now());
}

export function readSaleEvents(db, saleId, limit = 200) {
  return db.prepare('SELECT id,event,actor_id,woo_order_id,amount_cents,detail_json,created_at FROM sale_events WHERE sale_id=? ORDER BY id DESC LIMIT ?')
    .all(saleId, limit).map(row => ({
      id: row.id, event: row.event, actorId: row.actor_id, wooOrderId: row.woo_order_id,
      amountCents: row.amount_cents, details: JSON.parse(row.detail_json), createdAt: row.created_at,
    }));
}
