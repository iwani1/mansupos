/**
 * Phase 2.6: non-executing financial exception review.
 *
 * Requests and separate Owner acknowledgements append to the existing
 * immutable sale_events and audit tables. They do not authorize/execute a
 * refund, move cash, change Woo status, reserve/restock stock, or close a case.
 * Only isolated demo tests may POST; never write to a live/read-only ledger.
 */
import { AppError } from './errors.js';
import { localTransaction, saleEvent } from './sale-events.js';
import { audit } from './db.js';
import { paymentReconciliationCase } from './payment-reconciliation.js';

const REQUEST = 'finance.review.requested';
const ACK = 'finance.review.acknowledged';
export const reviewSteps = Object.freeze([
  'verify_original_woo_order',
  'reconcile_pos_cash_custody',
  'request_refund_payout_evidence',
  'escalate_financial_exception',
]);

export function financeReviewWritesAllowed(config, env) {
  return config.mode === 'demo' && !config.liveReadOnly &&
    !config.production && env.NODE_ENV === 'test';
}

function entryView(row) {
  const details = JSON.parse(row.detail_json);
  return {
    eventId: row.id, reviewKey: details.reviewKey,
    kind: row.event === REQUEST ? 'request' : 'owner_acknowledgement',
    step: details.step, actorId: row.actor_id, createdAt: row.created_at,
    refundAuthorized: false, refundExecuted: false,
    cashPaidOut: false, stockRestored: false,
  };
}
function originalCase(db, saleId) {
  const item = paymentReconciliationCase(db, saleId);
  if (!item) throw new AppError('Original POS financial exception was not found.', 404, 'REVIEW_CASE_NOT_FOUND');
  return item;
}
const queryEvent = (db, event, reviewKey) => db.prepare(
  "SELECT id,event,sale_id,actor_id,detail_json,created_at FROM sale_events " +
  "WHERE event=? AND json_extract(detail_json,'$.reviewKey')=? ORDER BY id ASC LIMIT 1"
).get(event, reviewKey);
const lastEvent = (db, event, saleId) => db.prepare(
  'SELECT id,event,sale_id,actor_id,detail_json,created_at FROM sale_events ' +
  'WHERE event=? AND sale_id=? ORDER BY id DESC LIMIT 1'
).get(event, saleId);

export function financeReviewHistory(db, saleId, enabled = false) {
  const item = originalCase(db, saleId);
  const rows = db.prepare(
    'SELECT id,event,sale_id,actor_id,detail_json,created_at FROM sale_events ' +
    'WHERE sale_id=? AND event IN (?,?) ORDER BY id ASC LIMIT 101'
  ).all(saleId, REQUEST, ACK);
  return {
    kind: 'non-executing-finance-review',
    source: 'local-pos-ledger', actionsAvailable: enabled,
    refundAuthorized: false, refundExecuted: false,
    cashPaidOut: false, stockRestored: false, gatewaySettlementVerified: false,
    saleId: item.id, saleStatus: item.status,
    saleUpdatedAt: item.updatedAt, wooOrderId: item.wooOrderId,
    issueCodes: item.issueCodes,
    availableSteps: reviewSteps.filter(step =>
      step !== 'request_refund_payout_evidence' ||
      item.issueCodes.includes('cash_refund_payout_unverified')),
    entries: rows.slice(0, 100).map(entryView),
    truncated: rows.length > 100,
    notice: 'These requests and acknowledgements are instructions to investigate ONLY. They do not authorize a payout, issue a refund, verify funds, release goods, restore stock or resolve an exception.',
  };
}

function requireDemoWrite(enabled) {
  if (!enabled) throw new AppError(
    'Financial review recording is disabled outside isolated demo tests; live POS and website remain read-only.',
    403, 'FINANCIAL_REVIEW_LOCKED'
  );
}

export function createFinanceReviewRequest(db, user, saleId, input, enabled = false) {
  requireDemoWrite(enabled);
  if (!['owner', 'manager'].includes(user.role)) throw new AppError('Owner/Manager only.', 403);
  if (!reviewSteps.includes(input.step)) throw new AppError('Invalid review step.', 400);
  return localTransaction(db, () => {
    const existing = queryEvent(db, REQUEST, input.reviewKey);
    if (existing) {
      const old = JSON.parse(existing.detail_json);
      if (existing.sale_id !== saleId || existing.actor_id !== user.id ||
          old.step !== input.step || old.expectedStatus !== input.expectedStatus ||
          old.expectedUpdatedAt !== input.expectedUpdatedAt ||
          old.expectedWooOrderId !== input.expectedWooOrderId) {
        throw new AppError('Review key is already bound to another sale or request.', 409, 'REVIEW_CONFLICT');
      }
      return { created: false, entry: entryView(existing) };
    }
    const item = originalCase(db, saleId);
    if (item.status !== input.expectedStatus ||
        item.updatedAt !== input.expectedUpdatedAt ||
        item.wooOrderId !== input.expectedWooOrderId) {
      throw new AppError('Original POS order evidence changed. Refresh first.', 409, 'REVIEW_STALE');
    }
    if (input.step === 'request_refund_payout_evidence' &&
        !item.issueCodes.includes('cash_refund_payout_unverified')) {
      throw new AppError('No cash-refund record requires evidence for this case.', 409, 'REVIEW_NOT_APPLICABLE');
    }
    saleEvent(db, saleId, REQUEST, user.id, {
      wooOrderId: item.wooOrderId,
      details: {
        reviewKey: input.reviewKey, step: input.step,
        expectedStatus: item.status, expectedUpdatedAt: item.updatedAt,
        expectedWooOrderId: item.wooOrderId,
      },
    });
    const created = lastEvent(db, REQUEST, saleId);
    audit(db, user.id, REQUEST, saleId);
    return { created: true, entry: entryView(created) };
  });
}

export function acknowledgeFinanceReview(db, user, saleId, input, enabled = false) {
  requireDemoWrite(enabled);
  if (user.role !== 'owner') throw new AppError('Only Owner may acknowledge a review.', 403);
  return localTransaction(db, () => {
    const request = queryEvent(db, REQUEST, input.reviewKey);
    if (!request || request.sale_id !== saleId || request.id !== input.requestEventId) {
      throw new AppError('Original review request cannot be verified.', 404, 'REVIEW_NOT_FOUND');
    }
    const existing = queryEvent(db, ACK, input.reviewKey);
    if (existing) {
      if (existing.sale_id !== saleId || existing.actor_id !== user.id) {
        throw new AppError('Already acknowledged by another Owner.', 409, 'REVIEW_CONFLICT');
      }
      return { created: false, entry: entryView(existing) };
    }
    if (request.actor_id === user.id) {
      throw new AppError('Reviewer and owner acknowledger must be different people.',
        409, 'TWO_PERSON_REVIEW_REQUIRED');
    }
    const item = originalCase(db, saleId);
    if (item.status !== input.expectedStatus || item.updatedAt !== input.expectedUpdatedAt) {
      throw new AppError('Original order evidence changed. Refresh first.', 409, 'REVIEW_STALE');
    }
    saleEvent(db, saleId, ACK, user.id, {
      wooOrderId: item.wooOrderId,
      details: {
        reviewKey: input.reviewKey,
        step: JSON.parse(request.detail_json).step,
        originalRequestEventId: request.id,
      },
    });
    const created = lastEvent(db, ACK, saleId);
    audit(db, user.id, ACK, saleId);
    return { created: true, entry: entryView(created) };
  });
}
