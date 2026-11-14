import { createHash, randomUUID } from 'node:crypto';
import { AppError, now } from './errors.js';
import { audit, saleView } from './db.js';
import { ledgerInfo, serviceIdentity } from './ledger-identity.js';
import { validateAvailability } from './catalog.js';
import { normalizeItems } from './sale-inputs.js';
import { localTransaction, saleEvent } from './sale-events.js';
import { ShiftService } from './shifts.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const review = 'This attempt or its Woo stock/payment state needs review. Do not collect cash again, retry a write, create another order, or release goods.';
const eventExists = (db, id, event) => Boolean(db.prepare('SELECT 1 FROM sale_events WHERE sale_id=? AND event=? LIMIT 1').get(id, event));

// This service deliberately uses the existing v9 sales + append-only events
// instead of creating an unprotected sidecar ledger. Phase 1 restore, identity,
// authorization and closed-shift protections continue to apply. It never
// writes to Woo stock tables or retries a possibly executed remote mutation.
export class OnlineSalesService {
  constructor(db, catalog, bridge, config) {
    if (!config.onlineBridgeEnabled || !bridge) throw new Error('The Woo reservation bridge is disabled.');
    this.db = db;
    this.catalog = catalog;
    this.bridge = bridge;
    this.config = config;
    this.shifts = new ShiftService(db, config);
    this.locks = new Set();
    const identity = ledgerInfo(db);
    if (identity.service !== serviceIdentity(config) || identity.service !== config.bridgeService ||
        !identity.ledgerId || identity.version !== 9) {
      throw new Error('The Woo bridge requires its own bound v9 ledger; pilot and trading databases must stay separate.');
    }
    this.ledgerId = identity.ledgerId;
  }
  isOnline(id) { return eventExists(this.db, id, 'online.intent'); }
  view(row) { return { ...saleView(row), onlineBridge: true }; }
  row(id, user) {
    const row = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
    if (!row) throw new AppError('Sale not found.', 404);
    if (!this.isOnline(id)) throw new AppError('This is not an online bridge attempt.', 409);
    if (user.role === 'cashier' && row.cashier_id !== user.id) throw new AppError('You can only view your own sales.', 403);
    return row;
  }
  async exclusive(key, work) {
    if (this.locks.has(key)) throw new AppError('The attempt is already being processed. Refresh this same sale.', 409, 'SALE_BUSY');
    this.locks.add(key);
    try { return await work(); } finally { this.locks.delete(key); }
  }
  markReview(row, actorId, event, code = 'UNKNOWN') {
    localTransaction(this.db, () => {
      this.db.prepare('UPDATE sales SET status=?,error=?,updated_at=? WHERE id=?')
        .run('needs_reconciliation', review, now(), row.id);
      saleEvent(this.db, row.id, event, actorId, { wooOrderId: row.woo_order_id, details: { code } });
    });
  }
  assertRemote(row, remote, { lines = true } = {}) {
    if (!remote || remote.key !== row.idempotency_key || remote.fingerprint !== row.fingerprint ||
        remote.service !== this.config.bridgeService || remote.ledgerId !== this.ledgerId || remote.siteId !== this.config.bridgeSiteId ||
        (row.woo_order_id && remote.orderId !== row.woo_order_id) ||
        (row.prepared_total && remote.totalCents !== row.prepared_total)) {
      throw new AppError('Woo attempt identity, total or site did not match this bound POS ledger.', 409, 'RECONCILIATION_REQUIRED');
    }
    const saved = JSON.parse(row.items_json || '[]');
    if (lines && (!saved.length || !Array.isArray(remote.items) || remote.items.length !== saved.length ||
        remote.items.some(item => !item || !['productId', 'variationId', 'quantity', 'ownerId', 'unitCents'].every(key =>
          Number.isSafeInteger(item[key])) || (item.agreedUnitCents != null && !Number.isSafeInteger(item.agreedUnitCents)) ||
          !Number.isSafeInteger(item.grossCents) || item.grossCents < 0 ||
          !Number.isSafeInteger(item.taxCents) || item.taxCents < 0 || typeof item.sku !== 'string'))) {
      throw new AppError('Woo order line evidence is missing. Review the same attempt.', 409, 'RECONCILIATION_REQUIRED');
    }
    if (lines) {
      const expected = saved.map(item => `${item.productId}:${item.variationId}:${item.quantity}:${item.ownerId}:${item.price}:${item.agreedUnitPrice ?? ''}:${item.sku || ''}`).sort();
      const actual = remote.items.map(item => `${item.productId}:${item.variationId}:${item.quantity}:${item.ownerId}:${item.unitCents}:${item.agreedUnitCents ?? ''}:${item.sku}`).sort();
      if (expected.some((item, index) => item !== actual[index]) ||
          remote.items.some(item => item.grossCents !== (item.agreedUnitCents ?? item.unitCents) * item.quantity ||
            item.taxCents > item.grossCents) ||
          saved.some(item => item.total != null && !remote.items.some(actual =>
            actual.productId === item.productId && actual.variationId === item.variationId &&
            actual.grossCents - actual.taxCents === item.total && actual.taxCents === item.tax)) ||
          !Number.isSafeInteger(remote.totalCents) || remote.totalCents < 1 ||
          !Number.isSafeInteger(remote.taxCents) || remote.taxCents < 0 ||
          remote.totalCents !== saved.reduce((total, item) => total + (item.agreedUnitPrice ?? item.price) * item.quantity, 0) ||
          remote.totalCents !== remote.items.reduce((total, item) => total + item.grossCents, 0) ||
          remote.taxCents !== remote.items.reduce((total, item) => total + item.taxCents, 0)) {
        throw new AppError('Woo changed the product, managed stock owner, approved price, tax-inclusive total or quantity.', 409, 'RECONCILIATION_REQUIRED');
      }
    }
  }
  assertLinked(row) {
    if (!row || !Number.isSafeInteger(row.woo_order_id) || row.woo_order_id < 1 ||
        !Number.isSafeInteger(row.total) || row.total < 1 || row.prepared_total !== row.total) {
      throw new AppError('The original Woo order and exact POS total are not durably linked. No cash or cancellation is allowed.', 409, 'RECONCILIATION_REQUIRED');
    }
  }
  assertReserved(remote, { forCash = false } = {}) {
    const remaining = Date.parse(remote.expiresAt) - Date.now();
    if (remote.state !== 'reserved' || !remote.orderId || !remote.orderIdentityVerified || remote.stockOrCashIntentObserved ||
        !remote.reservationVerified || remote.paymentVerified || remote.refundedCents !== 0 ||
        !Number.isFinite(remaining) || remaining < (forCash ? 90000 : 30000) || remaining > 11 * 60000) {
      throw new AppError('A live Woo hold with sufficient remaining time was not verified. Do not collect cash.', 409, 'RESERVATION_UNVERIFIED');
    }
  }
  assertCashIntent(remote) {
    const remaining = Date.parse(remote.expiresAt) - Date.now();
    if (remote.state !== 'cash_intent' || !remote.orderId || !remote.orderIdentityVerified ||
        !remote.cashIntentVerified || !remote.stockOrCashIntentObserved ||
        remote.paymentVerified || remote.refundedCents !== 0 ||
        !Number.isFinite(remaining) || remaining < 90000 || remaining > 11 * 60000) {
      throw new AppError('Original Woo cash intent and stock hold cannot be verified.', 409, 'RECONCILIATION_REQUIRED');
    }
  }
  async assertLiveBridgeReady() {
    if (!this.config.onlineBridgeLiveEnabled) return null; // Local synthetic bridge remains isolated.
    try {
      // This is a signed, read-only WP GET. It never creates an order or
      // extends a stock hold; the PHP write endpoints still verify Woo state.
      const health = await this.bridge.health();
      if (!health || health.kind !== 'mansu-online-bridge-health' || health.ok !== true ||
          health.service !== this.config.bridgeService || health.service !== 'live-trading' ||
          health.siteId !== this.config.bridgeSiteId || health.ledgerId !== this.ledgerId ||
          health.corePrerequisitesOk !== true || health.cashOnly !== true ||
          health.wooVersion !== '11.0.1' ||
          typeof health.taxEnabled !== 'boolean' || typeof health.hposEnabled !== 'boolean') {
        throw new Error('Remote bridge or v9 trading ledger did not match.');
      }
      return health;
    } catch {
      // Do not expose signed credentials or raw remote errors to the browser.
      // No new cash intent, order or stock mutation is allowed on this path.
      throw new AppError('The signed Woo reservation bridge is not verified for this trading ledger. Do not prepare a new sale or collect cash.', 503, 'BRIDGE_NOT_READY');
    }
  }
  async prepare(user, input) {
    if (!this.config.writesEnabled) throw new AppError('Online bridge writes are locked.', 403, 'CHECKOUT_LOCKED');
    const type = input.saleType || 'retail';
    if (type === 'wholesale' && (!['owner', 'manager'].includes(user.role) || !this.config.wholesaleWritesEnabled)) {
      throw new AppError('Wholesale requires a manager or owner and a separate local-test gate.', 403, 'WHOLESALE_CHECKOUT_LOCKED');
    }
    const items = normalizeItems(input.items);
    const buyer = type === 'wholesale' && input.buyerId ? this.db.prepare('SELECT id,name FROM trade_buyers WHERE id=?').get(input.buyerId) : null;
    if (input.buyerId && !buyer) throw new AppError('The named wholesale buyer no longer exists.', 400);
    const buyerName = buyer?.name || (type === 'wholesale' ? (input.buyerName || '').replace(/\s+/g, ' ') : '');
    const fingerprint = hash({ type, items, note: input.note, buyerId: buyer?.id || '', buyerName });
    return this.exclusive(`prepare:${input.idempotencyKey}`, async () => {
      const existing = this.db.prepare('SELECT * FROM sales WHERE idempotency_key=?').get(input.idempotencyKey);
      if (existing) {
        if (!this.isOnline(existing.id) || existing.fingerprint !== fingerprint || existing.cashier_id !== user.id) {
          throw new AppError('This checkout key belongs to a different cart, actor or checkout path.', 409);
        }
        if (existing.status === 'awaiting_payment') return this.view(existing);
        throw new AppError('This key is paid, closed or requires read-only reconciliation. Never submit a second Woo order.', 409, 'RECONCILIATION_REQUIRED');
      }
      // A heuristic only: Woo's unique attempt key and core hold remain the
      // authority across processes, cashiers and website checkout paths.
      const pending = this.db.prepare(`SELECT id FROM sales WHERE fingerprint=? AND status IN ('creating','awaiting_payment','needs_reconciliation')
        AND created_at>=? LIMIT 1`).get(fingerprint, new Date(Date.now() - 15 * 60000).toISOString());
      if (pending) throw new AppError('A matching unfinished cart exists. Inspect Sales instead of creating another order.', 409, 'RECONCILIATION_REQUIRED');
      // No local intent or remote reservation until this exact trading ledger
      // is verified. Local fixtures have their own separate test-only gate.
      await this.assertLiveBridgeReady();
      const shift = this.shifts.requireOpen(user.id);
      const id = randomUUID();
      const time = now();
      localTransaction(this.db, () => {
        this.db.prepare(`INSERT INTO sales(id,idempotency_key,fingerprint,number,status,currency,cashier_id,cashier_name,note,
          items_json,created_at,updated_at,shift_id,sale_type,buyer_id,buyer_name,trade_quote_json,
          trade_approved_by_id,trade_approved_by_name,trade_approved_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.idempotencyKey, fingerprint, `${this.config.onlineBridgeLiveEnabled ? 'POS' : 'STG'}-${id.slice(0, 8).toUpperCase()}`,
            'creating', 'GHS', user.id, user.name, input.note, '[]', time, time, shift.id,
            type === 'wholesale' ? 'trade' : 'retail', buyer?.id || null, buyerName,
            type === 'wholesale' ? JSON.stringify(items) : null,
            type === 'wholesale' ? user.id : null, type === 'wholesale' ? user.name : null, type === 'wholesale' ? time : null);
        saleEvent(this.db, id, 'online.intent', user.id, { details: { saleType: type, shiftId: shift.id, lineCount: items.length, ledgerId: this.ledgerId } });
        audit(this.db, user.id, 'online.attempt_intent', id);
      });
      let attempted = false;
      try {
        const lines = await this.catalog.fresh(items);
        validateAvailability(lines);
        const snapshot = lines.map((line, index) => {
          if (!line.manageStock || !Number.isSafeInteger(line.stock) || line.stock < 1 ||
              line.backordersAllowed !== false || !Number.isSafeInteger(line.price) || line.price < 1 ||
              !['parent', 'variation', 'product'].includes(line.stockSource)) {
            throw new AppError('Woo stock ownership, price or backorder policy is not proven for this line.', 409, 'STOCK_UNAVAILABLE');
          }
          const ownerId = line.stockSource === 'parent' ? line.productId : (line.variationId || line.productId);
          return { productId: line.productId, variationId: line.variationId, quantity: line.quantity,
            name: line.name, label: line.label, sku: line.sku, image: line.image,
            ownerId, price: line.price, ...(type === 'wholesale' ? { agreedUnitPrice: items[index].agreedUnitPrice } : {}) };
        });
        const total = snapshot.reduce((sum, line) => sum + (line.agreedUnitPrice ?? line.price) * line.quantity, 0);
        if (!Number.isSafeInteger(total) || total < 1 || total > 100000000) throw new AppError('The tax-inclusive cart total is outside the permitted range.', 400);
        const quote = type === 'wholesale' ? items.map((item, i) => ({ ...item, catalogueUnitPrice: lines[i].price })) : null;
        const quoteHash = quote ? hash({ buyerId: buyer?.id || null, buyerName, approvedBy: user.id, approvedAt: time, items: quote }) : null;
        localTransaction(this.db, () => {
          this.db.prepare('UPDATE sales SET items_json=?,trade_quote_json=? WHERE id=?').run(JSON.stringify(snapshot), quote ? JSON.stringify(quote) : null, id);
          saleEvent(this.db, id, 'online.cart_verified', user.id, { amountCents: total, details: { lineCount: snapshot.length } });
          saleEvent(this.db, id, 'online.reserve_started', user.id, { details: { siteId: this.config.bridgeSiteId } });
        });
        const payload = { service: this.config.bridgeService, ledgerId: this.ledgerId, key: input.idempotencyKey, fingerprint,
          cashierId: user.id, shiftId: shift.id, saleType: type,
          ...(quote ? { quoteHash, approvedBy: user.id, approvedAt: time, buyerId: buyer?.id || '', buyerName } : {}),
          items: snapshot.map(line => ({ productId: line.productId, variationId: line.variationId, quantity: line.quantity,
            expectedUnitCents: line.price, ownerId: line.ownerId, sku: line.sku || '',
            ...(type === 'wholesale' ? { agreedUnitCents: line.agreedUnitPrice } : {}) })) };
        attempted = true;
        const remote = await this.bridge.create(payload);
        const row = this.row(id, user);
        this.assertRemote(row, remote);
        this.assertReserved(remote);
        if (remote.totalCents !== total) throw new AppError('Woo and the signed quote did not agree on the gross total.', 409, 'RECONCILIATION_REQUIRED');
        const priced = snapshot.map(line => {
          const observed = remote.items.find(item => item.productId === line.productId && item.variationId === line.variationId);
          return { ...line, total: observed.grossCents - observed.taxCents, tax: observed.taxCents };
        });
        localTransaction(this.db, () => {
          const changed = this.db.prepare(`UPDATE sales SET woo_order_id=?,number=?,status='awaiting_payment',total=?,prepared_total=?,tax=?,subtotal=?,
            items_json=?,updated_at=?,error=NULL WHERE id=? AND status='creating' AND woo_order_id IS NULL`)
            .run(remote.orderId, `${this.config.onlineBridgeLiveEnabled ? 'POS' : 'STG'}-${remote.orderId}`, total, total, remote.taxCents, total - remote.taxCents,
              JSON.stringify(priced), now(), id);
          if (changed.changes !== 1) throw new AppError('Original attempt changed before Woo reservation was saved.', 409, 'RECONCILIATION_REQUIRED');
          saleEvent(this.db, id, 'online.hold_verified', user.id, { wooOrderId: remote.orderId, amountCents: total,
            details: { expiresAt: remote.expiresAt, siteId: remote.siteId } });
          audit(this.db, user.id, 'online.hold_verified', id);
        });
        return this.view(this.row(id, user));
      } catch (error) {
        if (!attempted) {
          localTransaction(this.db, () => {
            this.db.prepare("UPDATE sales SET status='failed',error=?,updated_at=? WHERE id=?")
              .run('Product or quote was rejected before any bridge order request.', now(), id);
            saleEvent(this.db, id, 'online.prepare_failed', user.id, { details: { code: error.code || 'ERROR' } });
          });
          throw error;
        }
        this.markReview(this.row(id, user), user.id, 'online.reserve_uncertain', error.code || 'ERROR');
        throw new AppError('Woo reservation outcome is uncertain. Use read-only reconciliation on this key; do not create another order.', 502, 'RECONCILIATION_REQUIRED');
      }
    });
  }
  async status(user, id) {
    const row = this.row(id, user);
    const remote = await this.bridge.status(row.idempotency_key);
    this.assertRemote(row, remote);
    // Keep status/recovery readable when the bridge is unhealthy, but never
    // tell a cashier that physical cash collection is permitted.
    let liveCashReady = true;
    if (this.config.onlineBridgeLiveEnabled) {
      try { await this.assertLiveBridgeReady(); }
      catch { liveCashReady = false; }
    }
    return { sale: this.view(row), bridge: { state: remote.state, orderId: remote.orderId,
      reservationVerified: remote.reservationVerified, paymentVerified: remote.paymentVerified,
      cancelledVerified: remote.cancelledVerified, expiresAt: remote.expiresAt,
      cashCollectionAllowed: liveCashReady && row.status === 'awaiting_payment' && !row.payment_method &&
        row.tendered == null && !row.paid_at &&
        Number.isSafeInteger(row.woo_order_id) && row.woo_order_id > 0 && row.prepared_total === row.total && row.total > 0 &&
        !eventExists(this.db, id, 'online.cash_intent_started') &&
        !eventExists(this.db, id, 'online.cash_accepted') && !eventExists(this.db, id, 'online.payment_started') &&
        !eventExists(this.db, id, 'online.cancel_started') && remote.state === 'reserved' &&
        remote.orderIdentityVerified && !remote.stockOrCashIntentObserved &&
        remote.reservationVerified && !remote.paymentVerified && remote.refundedCents === 0 &&
        Number.isFinite(Date.parse(remote.expiresAt)) && Date.parse(remote.expiresAt) - Date.now() >= 90000 &&
        Date.parse(remote.expiresAt) - Date.now() <= 11 * 60000 } };
  }
  async reconcile(user, id) {
    return this.exclusive(`sale:${id}`, async () => this.reconcileUnlocked(user, id));
  }
  async reconcileUnlocked(user, id) {
    const row = this.row(id, user);
    let remote;
    try {
      remote = await this.bridge.status(row.idempotency_key);
      this.assertRemote(row, remote);
    } catch (error) {
      this.markReview(row, user.id, 'online.status_uncertain', error.code || 'ERROR');
      throw new AppError(review, 502, 'RECONCILIATION_REQUIRED');
    }
    const custody = eventExists(this.db, id, 'online.cash_accepted');
    const started = eventExists(this.db, id, 'online.payment_started');
    const intentStarted = eventExists(this.db, id, 'online.cash_intent_started');
    const cancelStarted = eventExists(this.db, id, 'online.cancel_started');
    const previouslyPaid = Boolean(row.paid_at);
    let status = 'needs_reconciliation', paidAt = row.paid_at, message = review;
    if (remote.state === 'paid' && remote.paymentVerified && remote.orderIdentityVerified &&
        remote.stockOrCashIntentObserved && intentStarted && custody && started && !cancelStarted && row.payment_method === 'cash' &&
        Number.isSafeInteger(row.tendered) && row.tendered >= row.total &&
        row.change_due === row.tendered - row.total &&
        Number.isSafeInteger(row.woo_order_id) && row.woo_order_id === remote.orderId &&
        row.prepared_total === row.total && row.total > 0 &&
        Number.isFinite(Date.parse(remote.paidAt)) && remote.totalCents === row.total && !remote.refundedCents) {
      status = 'paid';
      paidAt = row.paid_at || new Date(remote.paidAt).toISOString();
      message = null;
    } else if (!custody && !started && !intentStarted && !cancelStarted && !previouslyPaid && !row.payment_method &&
        row.tendered == null && row.status !== 'failed' && remote.state === 'reserved') {
      try { this.assertReserved(remote, { forCash: true }); status = 'awaiting_payment'; message = null; }
      catch { /* Hold is unknown/expired; never reopen cash collection. */ }
    } else if (!custody && !started && !intentStarted && !previouslyPaid && remote.state === 'cancelled' &&
        remote.cancelledVerified === true && remote.orderIdentityVerified && !remote.stockOrCashIntentObserved) {
      status = 'cancelled'; message = null;
    }
    if (previouslyPaid && status !== 'paid') { status = 'needs_reconciliation'; paidAt = row.paid_at; message = review; }
    localTransaction(this.db, () => {
      const latest = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
      if (!latest || latest.status !== row.status || latest.payment_method !== row.payment_method ||
          latest.tendered !== row.tendered || latest.paid_at !== row.paid_at || latest.woo_order_id !== row.woo_order_id ||
          latest.prepared_total !== row.prepared_total || latest.total !== row.total || latest.items_json !== row.items_json ||
          latest.shift_id !== row.shift_id || latest.fingerprint !== row.fingerprint || latest.idempotency_key !== row.idempotency_key ||
          eventExists(this.db, id, 'online.cash_accepted') !== custody ||
          eventExists(this.db, id, 'online.cash_intent_started') !== intentStarted ||
          eventExists(this.db, id, 'online.payment_started') !== started ||
          eventExists(this.db, id, 'online.cancel_started') !== cancelStarted) {
        throw new AppError('The local attempt changed during status recovery. Refresh before any action.', 409, 'SALE_BUSY');
      }
      // Lost create responses can be linked ONLY through the bridge's durable
      // same-key status, after exact cart/ledger/site validation. Never POST.
      if (!row.woo_order_id && remote.orderId && remote.totalCents > 0 && ['reserved', 'cancelled'].includes(remote.state)) {
        const priced = JSON.parse(row.items_json).map(line => {
          const observed = remote.items.find(item => item.productId === line.productId && item.variationId === line.variationId);
          return { ...line, total: observed.grossCents - observed.taxCents, tax: observed.taxCents };
        });
        const changed = this.db.prepare('UPDATE sales SET woo_order_id=?,number=?,total=?,prepared_total=?,tax=?,subtotal=?,items_json=? WHERE id=? AND woo_order_id IS NULL')
          .run(remote.orderId, `${this.config.onlineBridgeLiveEnabled ? 'POS' : 'STG'}-${remote.orderId}`, remote.totalCents, remote.totalCents,
            remote.taxCents, remote.totalCents - remote.taxCents, JSON.stringify(priced), id);
        if (changed.changes !== 1) throw new AppError('Recovered Woo identity could not be linked to the original sale.', 409, 'RECONCILIATION_REQUIRED');
        saleEvent(this.db, id, 'online.order_recovered', user.id, { wooOrderId: remote.orderId, amountCents: remote.totalCents });
      }
      this.db.prepare('UPDATE sales SET status=?,paid_at=?,error=?,updated_at=? WHERE id=?')
        .run(status, paidAt, message, now(), id);
      if (status === 'paid' && !previouslyPaid) {
        saleEvent(this.db, id, 'online.payment_verified', user.id, { wooOrderId: remote.orderId, amountCents: row.total });
        audit(this.db, user.id, 'sale.paid', `${id}:cash`);
      }
      saleEvent(this.db, id, 'online.status_observed', user.id, { wooOrderId: remote.orderId,
        details: { state: remote.state, status, reservationVerified: remote.reservationVerified, paymentVerified: remote.paymentVerified } });
    });
    if (status === 'paid') this.catalog.invalidate();
    return this.view(this.row(id, user));
  }
  async collectAndConfirm(user, id, payment) {
    return this.exclusive(`sale:${id}`, async () => {
      let row = this.row(id, user);
      if (!this.config.writesEnabled || row.sale_type === 'trade' && !this.config.wholesaleWritesEnabled) {
        throw new AppError('Online retail or wholesale cash writes are locked.', 403, 'CHECKOUT_LOCKED');
      }
      if (user.id !== row.cashier_id) {
        throw new AppError('Only the cashier responsible for the original open drawer can record physical cash.', 403, 'SHIFT_CLOSED');
      }
      if (payment.method !== 'cash' || payment.reference || payment.confirmed !== true) {
        throw new AppError('Online bridge accepts physically confirmed cash only.', 403, 'PAYMENT_METHOD_LOCKED');
      }
      if (row.status === 'paid' && row.paid_at) {
        if (payment.tendered !== row.tendered) throw new AppError('This sale already has a different cash custody record.', 409);
        // A duplicate POS response may be old: verify the original Woo order
        // again before exposing a receipt. This is a GET, never a second pay.
        const verified = await this.reconcileUnlocked(user, id);
        if (verified.status !== 'paid') throw new AppError(review, 409, 'RECONCILIATION_REQUIRED');
        return verified;
      }
      if (row.payment_method || row.tendered != null || row.status !== 'awaiting_payment' ||
          eventExists(this.db, id, 'online.cash_intent_started') ||
          eventExists(this.db, id, 'online.cash_accepted') || eventExists(this.db, id, 'online.payment_started') ||
          eventExists(this.db, id, 'online.cancel_started')) {
        throw new AppError(review, 409, 'RECONCILIATION_REQUIRED');
      }
      this.assertLinked(row);
      if (!Number.isSafeInteger(payment.tendered) || payment.tendered < row.total || payment.tendered > 100000000) {
        throw new AppError('Count cash and confirm that any change was physically handed over first.', 400);
      }
      const shift = this.db.prepare('SELECT status,user_id FROM shifts WHERE id=?').get(row.shift_id);
      if (!shift || shift.status !== 'open' || shift.user_id !== row.cashier_id) throw new AppError('The original cash drawer shift is not open.', 409, 'SHIFT_CLOSED');
      // Verify before even STARTING a cash intent. If a later physical cash
      // event already exists, the separate reconciliation path remains usable.
      await this.assertLiveBridgeReady();
      try {
        const remote = await this.bridge.status(row.idempotency_key);
        this.assertRemote(row, remote);
        this.assertReserved(remote, { forCash: true });
      } catch (error) {
        this.markReview(row, user.id, 'online.pre_cash_uncertain', error.code || 'ERROR');
        throw new AppError('Cash was not recorded. The Woo hold must be reviewed before any collection.', 409, 'RESERVATION_UNVERIFIED');
      }
      // Lock the original cash intent in the POS ledger BEFORE the remote
      // write. Any interrupted acknowledgement becomes a manual-review case.
      localTransaction(this.db, () => {
        const current = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
        const drawer = this.db.prepare('SELECT status,user_id FROM shifts WHERE id=?').get(row.shift_id);
        this.assertLinked(current);
        if (current.status !== 'awaiting_payment' || current.payment_method || current.tendered != null ||
            current.total !== row.total || current.items_json !== row.items_json ||
            current.woo_order_id !== row.woo_order_id || current.shift_id !== row.shift_id ||
            !drawer || drawer.status !== 'open' || drawer.user_id !== row.cashier_id ||
            eventExists(this.db, id, 'online.cash_intent_started') ||
            eventExists(this.db, id, 'online.cash_accepted') || eventExists(this.db, id, 'online.payment_started') ||
            eventExists(this.db, id, 'online.cancel_started')) {
          throw new AppError('Original cash attempt already started or changed.', 409, 'RECONCILIATION_REQUIRED');
        }
        const changed = this.db.prepare("UPDATE sales SET status='needs_reconciliation',error=?,updated_at=? WHERE id=? AND status='awaiting_payment' AND payment_method IS NULL AND tendered IS NULL")
          .run('Awaiting original Woo cash-intent acknowledgement; do not repeat payment or cancellation.', now(), id);
        if (changed.changes !== 1) throw new AppError('Original cash attempt could not be locked.', 409, 'RECONCILIATION_REQUIRED');
        saleEvent(this.db, id, 'online.cash_intent_started', user.id, { wooOrderId: row.woo_order_id, amountCents: row.total });
      });
      try {
        const intent = await this.bridge.cashIntent(row.idempotency_key);
        this.assertRemote(row, intent);
        this.assertCashIntent(intent);
      } catch (error) {
        this.markReview(this.row(id, user), user.id, 'online.cash_intent_uncertain', error.code || 'ERROR');
        throw new AppError('Woo cash intent is uncertain. Do not collect cash again, cancel or retry; review the original order.', 502, 'RECONCILIATION_REQUIRED');
      }
      // An acknowledged Woo intent is NOT proof of payment; record the
      // physical cash in the original drawer once, before confirming Woo.
      localTransaction(this.db, () => {
        const latest = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
        this.assertLinked(latest);
        const drawer = this.db.prepare('SELECT status,user_id FROM shifts WHERE id=?').get(row.shift_id);
        if (latest.total !== row.total || latest.woo_order_id !== row.woo_order_id ||
            latest.items_json !== row.items_json || latest.shift_id !== row.shift_id ||
            !drawer || drawer.status !== 'open' || drawer.user_id !== row.cashier_id) {
          throw new AppError('The original order or cash drawer changed before custody. Review the same sale.', 409, 'RECONCILIATION_REQUIRED');
        }
        if (!eventExists(this.db, id, 'online.cash_intent_started') ||
            eventExists(this.db, id, 'online.cash_accepted') || eventExists(this.db, id, 'online.payment_started') ||
            eventExists(this.db, id, 'online.cancel_started')) {
          throw new AppError('Cash, payment or cancellation already started. Review the original attempt.', 409, 'RECONCILIATION_REQUIRED');
        }
        const changed = this.db.prepare(`UPDATE sales SET payment_method='cash',tendered=?,change_due=?,status='needs_reconciliation',
          updated_at=?,error=? WHERE id=? AND status='needs_reconciliation' AND payment_method IS NULL AND tendered IS NULL`)
          .run(payment.tendered, payment.tendered - row.total, now(), 'Cash is in the drawer; Woo payment is not yet verified. Do not collect it again.', id);
        if (changed.changes !== 1) throw new AppError('Cash custody was already recorded. Review this sale.', 409, 'RECONCILIATION_REQUIRED');
        saleEvent(this.db, id, 'online.cash_accepted', user.id, { wooOrderId: row.woo_order_id, amountCents: row.total,
          details: { tenderedCents: payment.tendered, changeGivenCents: payment.tendered - row.total, shiftId: row.shift_id } });
        audit(this.db, user.id, 'online.cash_accepted', id);
      });
      row = this.row(id, user);
      return this.confirmUnlocked(user, row);
    });
  }
  async confirmAfterCrash(user, id) {
    return this.exclusive(`sale:${id}`, async () => {
      if (!['owner', 'manager'].includes(user.role)) throw new AppError('Only a manager or owner may review a recorded but unsent cash payment.', 403);
      return this.confirmUnlocked(user, this.row(id, user));
    });
  }
  async confirmUnlocked(user, row) {
    this.assertLinked(row);
    if (!this.config.writesEnabled || row.sale_type === 'trade' && !this.config.wholesaleWritesEnabled) {
      throw new AppError('Online retail or wholesale cash writes are locked.', 403, 'CHECKOUT_LOCKED');
    }
    if (!eventExists(this.db, row.id, 'online.cash_intent_started') ||
        !eventExists(this.db, row.id, 'online.cash_accepted') || row.payment_method !== 'cash' || !row.tendered ||
        row.paid_at || eventExists(this.db, row.id, 'online.payment_started')) {
      throw new AppError('Payment was already sent, was not collected, or requires read-only reconciliation. Never send it twice.', 409, 'RECONCILIATION_REQUIRED');
    }
    try {
      const remote = await this.bridge.status(row.idempotency_key);
      this.assertRemote(row, remote);
      this.assertCashIntent(remote);
      const shift = this.db.prepare('SELECT status FROM shifts WHERE id=?').get(row.shift_id);
      if (shift?.status !== 'open') throw new AppError('Original drawer shift is not open.', 409, 'SHIFT_CLOSED');
      localTransaction(this.db, () => {
        // BEGIN IMMEDIATE also serializes a second service process using this
        // same SQLite ledger. A process-local Set alone is not a cash lock.
        const latest = this.db.prepare('SELECT * FROM sales WHERE id=?').get(row.id);
        this.assertLinked(latest);
        const drawer = this.db.prepare('SELECT status FROM shifts WHERE id=?').get(row.shift_id);
        if (eventExists(this.db, row.id, 'online.payment_started') || latest.status !== 'needs_reconciliation' ||
            latest.payment_method !== 'cash' || latest.tendered !== row.tendered || latest.paid_at ||
            latest.woo_order_id !== row.woo_order_id || latest.total !== row.total || latest.items_json !== row.items_json ||
            latest.shift_id !== row.shift_id || drawer?.status !== 'open') {
          throw new AppError('The original cash payment was already sent or changed. Read status; never send twice.', 409, 'RECONCILIATION_REQUIRED');
        }
        saleEvent(this.db, row.id, 'online.payment_started', user.id, { wooOrderId: row.woo_order_id, amountCents: row.total });
      });
      // From here ANY lost reply is uncertain. Do not call pay a second time.
      const paid = await this.bridge.pay(row.idempotency_key);
      this.assertRemote(row, paid);
      if (paid.state !== 'paid' || paid.paymentVerified !== true || !paid.orderIdentityVerified ||
          !paid.stockOrCashIntentObserved || !Number.isFinite(Date.parse(paid.paidAt)) || paid.refundedCents) {
        throw new AppError('Woo payment or one-time stock reduction could not be verified.', 409, 'RECONCILIATION_REQUIRED');
      }
      return this.reconcileUnlocked(user, row.id);
    } catch (error) {
      this.markReview(this.row(row.id, user), user.id, 'online.payment_uncertain', error.code || 'ERROR');
      throw new AppError(review, 502, 'RECONCILIATION_REQUIRED');
    }
  }
  async cancel(user, id) {
    return this.exclusive(`sale:${id}`, async () => {
      const row = this.row(id, user);
      if (row.status === 'cancelled') {
        const verified = await this.reconcileUnlocked(user, id);
        if (verified.status !== 'cancelled') throw new AppError(review, 409, 'RECONCILIATION_REQUIRED');
        return verified; // Same-key replay is a read-only Woo status check.
      }
      this.assertLinked(row);
      if (!this.config.writesEnabled || row.sale_type === 'trade' && !this.config.wholesaleWritesEnabled) {
        throw new AppError('Online retail or wholesale writes are locked.', 403, 'CHECKOUT_LOCKED');
      }
      if (row.status !== 'awaiting_payment' || row.payment_method || row.tendered != null || row.paid_at ||
          eventExists(this.db, id, 'online.cash_intent_started') ||
          eventExists(this.db, id, 'online.cash_accepted') || eventExists(this.db, id, 'online.payment_started') ||
          eventExists(this.db, id, 'online.cancel_started')) {
        throw new AppError('Only an unpaid attempt with no cash custody can be cancelled automatically.', 409, 'RECONCILIATION_REQUIRED');
      }
      localTransaction(this.db, () => {
        const latest = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
        this.assertLinked(latest);
        if (latest.total !== row.total || latest.woo_order_id !== row.woo_order_id ||
            latest.items_json !== row.items_json || eventExists(this.db, id, 'online.cash_intent_started') ||
            eventExists(this.db, id, 'online.cash_accepted') ||
            eventExists(this.db, id, 'online.payment_started') || eventExists(this.db, id, 'online.cancel_started')) {
          throw new AppError('Cash, payment, cancellation or order mapping changed. Review the original sale.', 409, 'RECONCILIATION_REQUIRED');
        }
        const changed = this.db.prepare(`UPDATE sales SET status='needs_reconciliation',error=?,updated_at=?
          WHERE id=? AND status='awaiting_payment' AND payment_method IS NULL AND tendered IS NULL`)
          .run('Unpaid cancellation sent. Verify the same Woo order before any other action.', now(), id);
        if (changed.changes !== 1) throw new AppError('Cash or status changed; cancellation was not sent.', 409, 'RECONCILIATION_REQUIRED');
        saleEvent(this.db, id, 'online.cancel_started', user.id, { wooOrderId: row.woo_order_id });
      });
      try {
        const remote = await this.bridge.cancel(row.idempotency_key);
        this.assertRemote(row, remote);
        if (remote.state !== 'cancelled' || remote.cancelledVerified !== true || !remote.orderIdentityVerified ||
            remote.stockOrCashIntentObserved || remote.paymentVerified) {
          throw new AppError('Woo cancellation or release could not be verified.', 409, 'RECONCILIATION_REQUIRED');
        }
        return this.reconcileUnlocked(user, id);
      } catch (error) {
        this.markReview(this.row(id, user), user.id, 'online.cancel_uncertain', error.code || 'ERROR');
        throw new AppError(review, 502, 'RECONCILIATION_REQUIRED');
      }
    });
  }
}
