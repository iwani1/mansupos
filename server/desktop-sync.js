import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { audit } from './db.js';
import { AppError, now } from './errors.js';
import { allocationInputSchema, bootstrapSchema, deviceIdSchema, grantSchema, syncEventSchema } from '../desktop/contracts.js';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const allowed = (config, selling = false) => {
  if (!config.desktopSetupEnabled || (selling && !config.desktopEnabled) || config.liveReadOnly || !config.writesEnabled || config.mode !== 'live') {
    throw new AppError('The separate offline reservation rollout is locked. No Woo write was made.', 403, 'OFFLINE_RESERVATIONS_LOCKED');
  }
};
const isManager = user => ['owner','manager'].includes(user?.role);
const requireOwner = user => { if (user?.role !== 'owner') throw new AppError('Only an owner can manage offline allocations.', 403); };
const meta = (order, key) => order.meta_data?.find(entry => entry.key === key)?.value;

export class DesktopSyncService {
  constructor(db, config, catalog, woo, reservations, wholesalePrices) {
    this.db = db; this.config = config; this.catalog = catalog; this.woo = woo; this.reservations = reservations;
    this.wholesalePrices = wholesalePrices;
  }
  device(id) {
    allowed(this.config);
    const deviceId = deviceIdSchema.parse(id);
    const row = this.db.prepare('SELECT * FROM offline_devices WHERE id=? AND active=1').get(deviceId);
    if (!row) throw new AppError('This computer has not been enrolled by an owner.', 403, 'DEVICE_NOT_ENROLLED');
    return row;
  }
  deviceSecret(id) {
    return createHmac('sha256', this.config.desktopDeviceMasterSecret).update(`mansu:desktop:v1:${id}`).digest('hex');
  }
  enroll(user, data) {
    allowed(this.config); requireOwner(user);
    const { deviceId } = z.object({ deviceId:deviceIdSchema }).strict().parse(data);
    const existing = this.db.prepare('SELECT * FROM offline_devices WHERE active=1 LIMIT 1').get();
    if (existing && existing.id !== deviceId) throw new AppError('One offline till is already enrolled. Recover its pending sales before enrolling another.', 409, 'SINGLE_TILL');
    if (!existing) {
      this.db.prepare('INSERT INTO offline_devices(id,enrolled_by,enrolled_at) VALUES (?,?,?)').run(deviceId,user.id,now());
      audit(this.db, user.id, 'desktop.enrolled', deviceId);
    }
    // Only an authenticated owner receives this derived key. It is encrypted
    // with DPAPI on the till and never appears in Woo, a product, or a renderer
    // response after the initial provisioning IPC exchange completes.
    return { deviceId, enrolled: true, deviceSecret: this.deviceSecret(deviceId) };
  }
  async bootstrap(user, id) {
    const device = this.device(id);
    const [catalog, status] = await Promise.all([this.catalog.get(true), this.reservations.status(device.id)]);
    if (catalog.source !== 'woocommerce' || catalog.complete !== true || catalog.stale || !Array.isArray(catalog.products)) {
      throw new AppError('Woo catalogue is stale or incomplete. Do not cache a selling snapshot.', 503, 'CATALOG_INCOMPLETE');
    }
    if (status?.deviceId !== device.id || status?.enforced !== true || !Array.isArray(status.grants) ||
        Number.isNaN(Date.parse(status.leaseExpiresAt))) throw new AppError('Woo has not confirmed enforceable allocations for this exact till.', 503, 'RESERVATION_UNVERIFIED');
    const grants = status.grants.map(g => grantSchema.parse(g));
    if (new Set(grants.map(g => g.stockKey)).size !== grants.length) throw new AppError('Woo returned duplicate allocation pools.', 503);
    const wholesalePrices = isManager(user) && this.config.wholesaleWritesEnabled
      ? (await this.wholesalePrices.list()).prices.filter(price => price.valid === true) : [];
    const canSell = this.config.desktopEnabled && status.enabled === true && status.leaseExpiresAt > now() && grants.some(g => g.remaining > 0);
    return bootstrapSchema.parse({ deviceId: device.id, canSell, canWholesale: canSell && this.config.wholesaleWritesEnabled,
      leaseExpiresAt: status.leaseExpiresAt, catalog: { ...catalog, stale: false, complete: true }, wholesalePrices, grants });
  }
  async allocate(user, data) {
    allowed(this.config); requireOwner(user);
    const input = allocationInputSchema.parse(data);
    this.device(input.deviceId);
    const result = await this.reservations.allocate(input);
    const grant = grantSchema.parse(result?.grant);
    if (result?.deviceId !== input.deviceId || result.stockKey !== grant.stockKey || grant.productId !== input.productId ||
        ![0,input.variationId].includes(grant.variationId) || grant.stockKey !== `${grant.productId}:${grant.variationId}`) {
      throw new AppError('Woo did not confirm the requested stock pool. Keep the original allocation ID for owner review.', 502, 'RESERVATION_UNCERTAIN');
    }
    audit(this.db, user.id, 'desktop.allocated', `${input.deviceId}:${result.stockKey}:${input.quantity}`);
    return result;
  }
  verifyEvent(event) {
    if (event.kind === 'sale') {
      if (event.saleType === 'wholesale' && !this.config.wholesaleWritesEnabled) {
        throw new AppError('Wholesale trading is separately locked. Preserve this local sale for owner review.', 409, 'SYNC_CONFLICT');
      }
      if (event.paymentMethod === 'cash' ? event.paymentStatus !== 'cash_received' || event.tendered < event.total || event.paymentReference !== ''
        : event.paymentStatus !== 'unverified' || event.tendered !== 0 || !event.paymentReference) {
        throw new AppError('Payment evidence and status disagree; keep this transaction under review.', 409, 'SYNC_CONFLICT');
      }
      if (event.saleType === 'retail' ? event.approvedById !== null || event.items.some(i => i.agreedUnitPrice != null)
        : !event.approvedById || event.items.some(i => i.agreedUnitPrice == null)) {
        throw new AppError('Wholesale approval or retail pricing is incomplete.', 409, 'SYNC_CONFLICT');
      }
      const amount = event.items.reduce((sum,i) => sum + (i.agreedUnitPrice ?? i.price) * i.quantity, 0);
      if (amount !== event.total || new Set(event.items.map(i => `${i.productId}:${i.variationId}`)).size !== event.items.length) {
        throw new AppError('Offline sale lines and the collected total do not reconcile.', 409, 'SYNC_CONFLICT');
      }
      if (event.saleType === 'wholesale') {
        const approver = this.db.prepare('SELECT role FROM users WHERE id=?').get(event.approvedById);
        if (!isManager(approver)) throw new AppError('The wholesale approver could not be verified. Owner review required.', 409, 'SYNC_CONFLICT');
      }
    } else {
      const actor = this.db.prepare('SELECT role FROM users WHERE id=?').get(event.actorId);
      if (!isManager(actor)) throw new AppError('Local return approver needs owner review.', 409, 'SYNC_CONFLICT');
      if (event.amount !== event.items.reduce((sum,i) => sum + i.amount,0)) throw new AppError('Return amount does not match its items.', 409, 'SYNC_CONFLICT');
      const original = this.db.prepare('SELECT * FROM sales WHERE id=?').get(event.saleId);
      if (!original || original.status === 'awaiting_payment' || original.refunded + event.amount > original.total) {
        throw new AppError('Original cash sale is not reconciled or refund exceeds it.', 409, 'SYNC_CONFLICT');
      }
    }
  }
  verifyOrder(event, order, result) {
    if (!order || !Number.isInteger(order.id) || meta(order,'_mansu_offline_sale_id') !== (event.kind === 'sale' ? event.id : event.saleId) ||
        meta(order,'_mansu_offline_device_id') !== event.deviceId || order.currency !== 'GHS') {
      throw new AppError('Woo order identity did not match the durable offline event. Owner review required.', 409, 'SYNC_CONFLICT');
    }
    if (event.kind === 'sale') {
      if (Math.round(Number(order.total) * 100) !== event.total || order.line_items?.length !== event.items.length ||
          event.items.some(line => !order.line_items.some(item => item.product_id === line.productId &&
            (item.variation_id || 0) === line.variationId && item.quantity === line.quantity))) {
        throw new AppError('Woo order goods or total differ from the local receipt. Do not acknowledge this sale.', 409, 'SYNC_CONFLICT');
      }
      const settled = ['processing','completed'].includes(order.status) && Boolean(order.date_paid || order.date_paid_gmt);
      if (event.paymentMethod === 'cash' ? !settled : settled || order.status !== 'pending') {
        throw new AppError('Woo payment state does not match locally collected cash or unverified MoMo.', 409, 'SYNC_CONFLICT');
      }
    } else {
      const refund = order.refunds?.find(row => row.id === result.refundId);
      if (!Number.isInteger(result.refundId) || result.amount !== event.amount ||
          !refund || Math.abs(Math.round(Number(refund.total) * 100)) !== event.amount) {
        throw new AppError('Woo refund identity and amount did not match this local cash return.', 409, 'SYNC_CONFLICT');
      }
    }
  }
  importSale(event, order) {
    const lines = event.items.map(item => ({ ...item,
      image: '', total: (item.agreedUnitPrice ?? item.price) * item.quantity,
      ...(event.saleType === 'wholesale' ? { cataloguePrice:item.price, agreedLineTotal:item.agreedUnitPrice*item.quantity } : {}) }));
    const quote = event.saleType === 'wholesale' ? lines.map(i => ({ productId:i.productId, variationId:i.variationId,
      quantity:i.quantity, agreedUnitPrice:i.agreedUnitPrice, catalogueUnitPrice:i.price })) : null;
    const kind = event.saleType === 'wholesale' ? 'trade' : 'retail';
    const tax = Math.round(Number(order.total_tax || 0) * 100);
    this.db.prepare(`INSERT INTO sales(id,idempotency_key,fingerprint,number,woo_order_id,status,payment_method,payment_reference,
      total,tax,subtotal,refunded,tendered,change_due,currency,cashier_id,cashier_name,note,items_json,created_at,updated_at,paid_at,
      prepared_total,sale_type,buyer_name,trade_quote_json,trade_approved_by_id,trade_approved_by_name,trade_approved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(event.id,event.id,fingerprint(event),`MTD-${event.createdAt.slice(0,10).replaceAll('-','')}-${event.id.slice(0,8).toUpperCase()}`,
        order.id,event.paymentMethod==='cash'?'paid':'awaiting_payment',event.paymentMethod,event.paymentReference,
        event.total,tax,event.total-tax,0,event.tendered,event.paymentMethod==='cash'?event.tendered-event.total:0,
        'GHS',event.cashierId,event.cashierName,event.note,JSON.stringify(lines),event.createdAt,now(),event.paymentMethod==='cash'?event.createdAt:null,
        event.total,kind,event.buyerName,quote?JSON.stringify(quote):null,event.approvedById,event.approvedByName,
        event.approvedById?event.createdAt:null);
  }
  importReturn(event) {
    const row = this.db.prepare('SELECT * FROM sales WHERE id=?').get(event.saleId);
    if (!row) throw new AppError('Central sale is missing for this return.', 409, 'SYNC_CONFLICT');
    this.db.prepare('UPDATE sales SET refunded=refunded+?,status=?,updated_at=? WHERE id=?')
      .run(event.amount,row.refunded+event.amount === row.total ? 'refunded' : 'partially_refunded',now(),row.id);
  }
  async sync(user, data) {
    allowed(this.config, true);
    const { event, signature } = z.object({ event:syncEventSchema, signature:z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(data);
    this.device(event.deviceId);
    const expected = createHmac('sha256', this.deviceSecret(event.deviceId)).update(JSON.stringify(event)).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature,'hex'))) {
      throw new AppError('This event was not signed by the enrolled till. No Woo write was made.', 403, 'DEVICE_SIGNATURE_INVALID');
    }
    const fp = fingerprint(event);
    const existing = this.db.prepare('SELECT * FROM offline_events WHERE id=?').get(event.id);
    if (existing && (existing.fingerprint !== fp || existing.device_id !== event.deviceId || existing.kind !== event.kind)) {
      throw new AppError('An offline event ID was reused with different contents. Do not create another order.', 409, 'SYNC_CONFLICT');
    }
    if (existing?.status === 'acked') return { id:event.id, fingerprint:fp, status:'acked', wooOrderId:existing.woo_order_id };
    this.verifyEvent(event);
    if (!existing) this.db.prepare(`INSERT INTO offline_events(id,device_id,kind,fingerprint,payload_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',?,?)`).run(event.id,event.deviceId,event.kind,fp,JSON.stringify(event),event.createdAt,now());
    // A remote timeout is uncertain. The plugin has its own unique event ID
    // and order ID mapping, so replaying THIS exact payload is safe; never use
    // the legacy generic Woo createOrder() (POST is not idempotent).
    const result = await this.reservations.sync(event);
    if (result?.id !== event.id || result?.fingerprint !== fp || !Number.isInteger(result.orderId)) {
      throw new AppError('Woo reservation acknowledgement was incomplete. Keep this event pending.', 503, 'RESERVATION_UNCERTAIN');
    }
    const order = await this.woo.order(result.orderId);
    this.verifyOrder(event, order, result);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A second concurrent replay can finish its remote read after the first
      // request already committed. Recheck under SQLite's writer lock, or a
      // refund could otherwise be added to the central ledger twice.
      if (this.db.prepare('SELECT status FROM offline_events WHERE id=?').get(event.id)?.status === 'acked') {
        this.db.exec('COMMIT');
        return { id:event.id, fingerprint:fp, status:'acked', wooOrderId:order.id };
      }
      if (event.kind === 'sale') this.importSale(event, order);
      else this.importReturn(event);
      this.db.prepare("UPDATE offline_events SET status='acked',woo_order_id=?,error=NULL,updated_at=? WHERE id=?")
        .run(order.id, now(), event.id);
      audit(this.db, user.id, `desktop.${event.kind}_synced`, `${event.id}:${order.id}`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id:event.id, fingerprint:fp, status:'acked', wooOrderId:order.id };
  }
}
