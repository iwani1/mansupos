/**
 * Phase 2.8 — evidence-only refund/return resolution DRAFTS.
 * Recording a proposal or Owner review does not verify funds, approve a
 * payout, inspect a garment, return stock to Woo or close an exception.
 * The only write gate is isolated NODE_ENV=test + demo mode.
 */
import { AppError } from './errors.js';
import { localTransaction, saleEvent } from './sale-events.js';
import { audit } from './db.js';
import { refundEvidencePolicy } from './refund-evidence-policy.js';

const PROPOSE = 'finance.resolution.draft';
const REVIEW = 'finance.resolution.owner_reviewed';
export const resolutionIntents = Object.freeze([
  'refund_only', 'return_and_refund', 'exchange_request', 'no_refund_review',
]);
export const resolutionReasons = Object.freeze([
  'customer_request', 'size_mismatch', 'item_quality', 'duplicate_payment',
  'delivery_exception', 'unclassified_exception',
]);

const currentSale = (db, id) => db.prepare(
  'SELECT id,number,woo_order_id,status,total,refunded,updated_at FROM sales WHERE id=?'
).get(id);

function original(db, id) {
  const sale = currentSale(db, id);
  if (!sale) throw new AppError('Original POS order not found.', 404, 'RESOLUTION_CASE_NOT_FOUND');
  return sale;
}
function parseEvent(row) {
  const d = JSON.parse(row.detail_json);
  return {
    id: row.id, kind: row.event === PROPOSE ? 'proposal_draft' : 'owner_review_record',
    originalSaleId: row.sale_id, actorId: row.actor_id,
    createdAt: row.created_at, draftKey: d.draftKey,
    intent: d.intent, reasonCode: d.reasonCode,
    proposedCents: d.proposedCents,
    refundAuthorized: false, payoutVerified: false, returnedStockVerified: false,
    stockRestored: false, settlementVerified: false, checkoutAuthorized: false,
  };
}
const findByKey = (db, event, draftKey) => db.prepare(
  "SELECT id,event,sale_id,actor_id,created_at,detail_json FROM sale_events " +
  "WHERE event=? AND json_extract(detail_json,'$.draftKey')=? ORDER BY id ASC LIMIT 1"
).get(event, draftKey);
const findForSale = (db, event, saleId) => db.prepare(
  'SELECT id,event,sale_id,actor_id,created_at,detail_json FROM sale_events ' +
  'WHERE event=? AND sale_id=? ORDER BY id DESC LIMIT 1'
).get(event, saleId);

export function refundResolutionDossier(db, saleId, demoWrites = false) {
  const sale = original(db, saleId);
  const worksheet = refundEvidencePolicy(db, saleId);
  const drafts = db.prepare(
    'SELECT id,event,sale_id,actor_id,created_at,detail_json FROM sale_events ' +
    'WHERE sale_id=? AND event IN (?,?) ORDER BY id ASC LIMIT 101'
  ).all(saleId, PROPOSE, REVIEW);
  const item = drafts.find(r => r.event === PROPOSE);
  const ownerEntry = drafts.find(r => r.event === REVIEW);
  const proposal = item ? parseEvent(item) : null;
  const ownerReview = ownerEntry ? parseEvent(ownerEntry) : null;
  const contradictions = worksheet.warnings.filter(code =>
    ['invalid_original_or_refund_total', 'woo_refund_state_inconsistent',
      'original_woo_order_unknown', 'local_payment_evidence_incomplete'].includes(code));
  const required = [
    {
      code: 'original_pos_order_and_cumulative_woo_refund',
      source: 'local_pos_ledger', observed: contradictions.length === 0,
      required: 'Manually compare the original Woo order, cumulative refunds and local POS sale',
    },
    {
      code: 'external_settlement_and_all_prior_payouts',
      source: 'independent_bank_or_gateway', observed: false,
      required: 'Independently verify settled payment and all previous payouts, including partial refunds',
    },
    {
      code: 'customer_right_to_refund_and_recipient',
      source: 'merchant_policy_and_identity', observed: false,
      required: 'Confirm purchase, applicable refund policy, original payer and authorized recipient',
    },
    {
      code: 'separate_owner_financial_authorization',
      source: 'separate_approved_release_process', observed: false,
      required: 'An Owner review of a draft is NOT approval to pay or refund',
    },
    {
      code: 'actual_customer_payout_evidence',
      source: 'cash_receipt_or_gateway_statement', observed: false,
      required: 'Confirm payout with a separate verified cash/processor record; never trust Woo refund alone',
    },
    {
      code: 'physically_received_and_inspected_return',
      source: 'manual_item_inspection', observed: false,
      required: 'Confirm returned garment SKU, size, colour, condition and quantity before any stock action',
    },
    {
      code: 'shared_woo_stock_owner_adjustment',
      source: 'independent_woo_inventory_authorization', observed: false,
      required: 'Verify correct Woo parent/variation stock owner; do not restore based on a refund',
    },
  ];
  return {
    kind: 'non-executing-refund-resolution-dossier',
    originalSaleId: sale.id, originalOrderNumber: sale.number,
    wooOrderId: sale.woo_order_id, saleStatus: sale.status,
    originalUpdatedAt: sale.updated_at, recordedRefundedCents: sale.refunded,
    originalTotalCents: sale.total,
    source: 'local-pos-ledger', websiteOrdersIncluded: false,
    actionsAvailable: demoWrites,
    recordProposalAllowed: demoWrites && !proposal,
    recordOwnerReviewAllowed: demoWrites && Boolean(proposal) && !ownerReview,
    historicalProposal: proposal, historicalOwnerReview: ownerReview,
    truncatedHistory: drafts.length > 100,
    warnings: worksheet.warnings,
    requiredChecks: required, conflictingLocalEvidence: contradictions,
    settlementVerified: false, payoutVerified: false,
    returnPhysicallyInspected: false, ownerRefundApprovalIssued: false,
    cashPayoutAuthorized: false, refundExecuted: false,
    wooStockRestorationAuthorized: false, stockRestored: false,
    goodsReleaseAuthorized: false, checkoutAuthorized: false,
    mutationsAllowed: false, decision: 'external_evidence_and_authorization_required',
    notice: 'Draft proposals and Owner review acknowledgements NEVER approve or execute a refund, authenticate customer payout, inspect a return, issue replacement goods, or restore stock. The POS ledger does not verify website Paystack settlement.',
  };
}
function draftDetails(input) {
  return {
    draftKey: input.draftKey, intent: input.intent, reasonCode: input.reasonCode,
    proposedCents: input.proposedCents,
    expectedStatus: input.expectedStatus,
    expectedUpdatedAt: input.expectedUpdatedAt,
    expectedWooOrderId: input.expectedWooOrderId,
    expectedRefundedCents: input.expectedRefundedCents,
  };
}
function requireTestOnly(allowed) {
  if (!allowed) throw new AppError(
    'Resolution recording is disabled outside the isolated demo test environment.',
    403, 'REFUND_RESOLUTION_LOCKED');
}
function checkSnapshot(sale, input) {
  if (sale.status !== input.expectedStatus ||
      sale.updated_at !== input.expectedUpdatedAt ||
      sale.woo_order_id !== input.expectedWooOrderId ||
      sale.refunded !== input.expectedRefundedCents) {
    throw new AppError('Original order or cumulative refund amount changed; re-open its dossier.',
      409, 'RESOLUTION_STALE');
  }
}
export function draftRefundResolution(db, user, saleId, input, allowed = false) {
  requireTestOnly(allowed);
  if (!['owner', 'manager'].includes(user.role)) throw new AppError('Owner/Manager only.', 403);
  if (!resolutionIntents.includes(input.intent) || !resolutionReasons.includes(input.reasonCode)) {
    throw new AppError('Unknown resolution classification.', 400);
  }
  const refundIntent = input.intent === 'refund_only' || input.intent === 'return_and_refund';
  if (!Number.isSafeInteger(input.proposedCents) ||
      (refundIntent ? (input.proposedCents <= 0 || input.proposedCents > 100000000)
        : input.proposedCents !== 0)) {
    throw new AppError('Proposed refund amount does not match the draft intent.', 400);
  }
  return localTransaction(db, () => {
    const prev = findByKey(db, PROPOSE, input.draftKey);
    const expected = draftDetails(input);
    if (prev) {
      if (prev.sale_id !== saleId || prev.actor_id !== user.id ||
          JSON.stringify(JSON.parse(prev.detail_json)) !== JSON.stringify(expected)) {
        throw new AppError('Resolution draft key is already bound to another request.',
          409, 'RESOLUTION_KEY_CONFLICT');
      }
      return { created: false, entry: parseEvent(prev) };
    }
    // One pending draft per original sale; prevent two contradictory remedies
    // being presented as concurrent proposals without a revision procedure.
    if (findForSale(db, PROPOSE, saleId)) {
      throw new AppError('A resolution draft already exists for this original sale.',
        409, 'RESOLUTION_DRAFT_EXISTS');
    }
    const sale = original(db, saleId);
    checkSnapshot(sale, input);
    const evidence = refundEvidencePolicy(db, saleId,
      refundIntent ? input.proposedCents : null);
    if (evidence.warnings.some(x =>
        ['invalid_original_or_refund_total', 'woo_refund_state_inconsistent',
          'original_woo_order_unknown'].includes(x)) ||
        (refundIntent && !evidence.proposalWithinObservedRemaining)) {
      throw new AppError('Inconsistent order or cumulative refund evidence; do not draft a payout.',
        409, 'RESOLUTION_AMOUNT_OR_IDENTITY_UNSAFE');
    }
    saleEvent(db, saleId, PROPOSE, user.id, {
      wooOrderId: sale.woo_order_id,
      details: expected,
    });
    const result = findForSale(db, PROPOSE, saleId);
    audit(db, user.id, PROPOSE, saleId);
    return { created: true, entry: parseEvent(result) };
  });
}
export function ownerReviewRefundResolution(db, user, saleId, input, allowed = false) {
  requireTestOnly(allowed);
  if (user.role !== 'owner') throw new AppError('Owner-only review.', 403);
  return localTransaction(db, () => {
    const draft = findByKey(db, PROPOSE, input.draftKey);
    if (!draft || draft.sale_id !== saleId || draft.id !== input.draftEventId) {
      throw new AppError('Original resolution draft not found.', 404, 'RESOLUTION_DRAFT_NOT_FOUND');
    }
    const existing = findByKey(db, REVIEW, input.draftKey);
    if (existing) {
      if (existing.sale_id !== saleId || existing.actor_id !== user.id) {
        throw new AppError('Another Owner reviewed this draft.',
          409, 'RESOLUTION_ALREADY_REVIEWED');
      }
      return { created: false, entry: parseEvent(existing) };
    }
    if (draft.actor_id === user.id) {
      throw new AppError('The draft creator cannot review their own resolution draft.',
        409, 'RESOLUTION_SEPARATION_OF_DUTIES');
    }
    const sale = original(db, saleId);
    const draftInput = JSON.parse(draft.detail_json);
    checkSnapshot(sale, draftInput);
    if (sale.status !== input.expectedStatus ||
        sale.updated_at !== input.expectedUpdatedAt ||
        sale.refunded !== input.expectedRefundedCents) {
      throw new AppError('Original order changed while Owner reviewed the draft.',
        409, 'RESOLUTION_STALE');
    }
    saleEvent(db, saleId, REVIEW, user.id, {
      wooOrderId: sale.woo_order_id,
      details: {
        draftKey: input.draftKey, draftEventId: draft.id,
        intent: draftInput.intent, reasonCode: draftInput.reasonCode,
        proposedCents: draftInput.proposedCents,
      },
    });
    const result = findForSale(db, REVIEW, saleId);
    audit(db, user.id, REVIEW, saleId);
    return { created: true, entry: parseEvent(result) };
  });
}
