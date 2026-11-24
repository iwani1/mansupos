// Owner/manager payment reconciliation and refund review (POS ledger only).
import { z } from 'zod';
import { AppError } from '../errors.js';
import { paymentReconciliation } from '../payment-reconciliation.js';
import { refundEvidencePolicy } from '../refund-evidence-policy.js';
import { refundResolutionDossier, draftRefundResolution, ownerReviewRefundResolution, resolutionIntents, resolutionReasons } from '../refund-resolution-dossier.js';
import { financeReviewWritesAllowed, financeReviewHistory, createFinanceReviewRequest, acknowledgeFinanceReview, reviewSteps } from '../payment-review-workflow.js';

export function registerPaymentRoutes(app, ctx) {
  const { env, config, db, auth, role, sensitiveLimit } = ctx;
  // Source-limited Owner/Manager payment review: SQLite POS evidence only.
  // No Woo order read, Paystack request, cash update, refund or stock write.
  // The live catalogue pilot has only a product-read Woo key.
  app.get('/api/payments/reconciliation', auth, role('owner', 'manager'), (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).parse(req.query.limit || 50);
    const cursor = z.string().max(500).optional().parse(req.query.cursor);
    res.json(paymentReconciliation(db, { limit, cursor }));
  });
  // Financial exception triage only. POST is impossible on the reported live
  // read-only pilot or any production/staging service, regardless of env flags.
  // No settlement, cash payout, refund, stock or Woo order mutation exists.
  const financeReviewDemo = financeReviewWritesAllowed(config, env);
  const reviewSaleId = z.string().uuid();
  const reviewKey = z.string().uuid();
  const requestSchema = z.object({
    reviewKey,
    step: z.enum(reviewSteps),
    expectedStatus: z.string().min(1).max(60),
    expectedUpdatedAt: z.string().datetime(),
    expectedWooOrderId: z.number().int().positive().nullable(),
  }).strict();
  const acknowledgeSchema = z.object({
    reviewKey,
    requestEventId: z.number().int().positive(),
    expectedStatus: z.string().min(1).max(60),
    expectedUpdatedAt: z.string().datetime(),
  }).strict();
  // Refund amounts here are illustrative POS-only arithmetic. This GET
  // cannot fetch/verify bank settlement or move money/stock, and remains safe
  // on the live catalogue-only pilot.
  app.get('/api/payments/reconciliation/:saleId/refund-evidence', auth, role('owner', 'manager'), (req, res) => {
    const id = reviewSaleId.parse(req.params.saleId);
    const proposed = z.coerce.number().int().positive().max(100000000).optional().parse(req.query.proposedCents);
    res.json(refundEvidencePolicy(db, id, proposed ?? null));
  });
  const resolutionDraftSchema = z.object({
    draftKey: reviewKey,
    intent: z.enum(resolutionIntents),
    reasonCode: z.enum(resolutionReasons),
    proposedCents: z.number().int().min(0).max(100000000),
    expectedStatus: z.string().min(1).max(60),
    expectedUpdatedAt: z.string().datetime(),
    expectedWooOrderId: z.number().int().positive().nullable(),
    expectedRefundedCents: z.number().int().min(0),
  }).strict();
  const resolutionReviewSchema = z.object({
    draftKey: reviewKey,
    draftEventId: z.number().int().positive(),
    expectedStatus: z.string().min(1).max(60),
    expectedUpdatedAt: z.string().datetime(),
    expectedRefundedCents: z.number().int().min(0),
  }).strict();
  // Draft proposal and separate Owner review are NOT disbursement,
  // payment settlement, garment inspection, or stock restoration.
  app.get('/api/payments/reconciliation/:saleId/resolution', auth, role('owner', 'manager'), (req, res) => {
    res.json(refundResolutionDossier(db, reviewSaleId.parse(req.params.saleId), financeReviewDemo));
  });
  app.post('/api/payments/reconciliation/:saleId/resolution', auth, role('owner', 'manager'), sensitiveLimit, (req, res) => {
    if (!financeReviewDemo) throw new AppError('Resolution drafts are disabled on every non-test POS.', 403, 'REFUND_RESOLUTION_LOCKED');
    const result = draftRefundResolution(db, req.user, reviewSaleId.parse(req.params.saleId),
      resolutionDraftSchema.parse(req.body), financeReviewDemo);
    res.status(result.created ? 201 : 200).json({ ...result, nonExecuting: true });
  });
  app.post('/api/payments/reconciliation/:saleId/resolution/owner-review', auth, role('owner'), sensitiveLimit, (req, res) => {
    if (!financeReviewDemo) throw new AppError('Resolution review recording is disabled on every non-test POS.', 403, 'REFUND_RESOLUTION_LOCKED');
    const result = ownerReviewRefundResolution(db, req.user, reviewSaleId.parse(req.params.saleId),
      resolutionReviewSchema.parse(req.body), financeReviewDemo);
    res.status(result.created ? 201 : 200).json({ ...result, nonExecuting: true });
  });
  app.get('/api/payments/reconciliation/:saleId/review', auth, role('owner', 'manager'), (req, res) => {
    const id = reviewSaleId.parse(req.params.saleId);
    res.json(financeReviewHistory(db, id, financeReviewDemo));
  });
  app.post('/api/payments/reconciliation/:saleId/review', auth, role('owner', 'manager'), sensitiveLimit, (req, res) => {
    if (!financeReviewDemo) throw new AppError('Finance review writes are locked outside isolated demo tests.', 403, 'FINANCIAL_REVIEW_LOCKED');
    const id = reviewSaleId.parse(req.params.saleId);
    const input = requestSchema.parse(req.body);
    const result = createFinanceReviewRequest(db, req.user, id, input, financeReviewDemo);
    res.status(result.created ? 201 : 200).json({ ...result, nonExecuting: true });
  });
  app.post('/api/payments/reconciliation/:saleId/acknowledge', auth, role('owner'), sensitiveLimit, (req, res) => {
    if (!financeReviewDemo) throw new AppError('Finance review writes are locked outside isolated demo tests.', 403, 'FINANCIAL_REVIEW_LOCKED');
    const id = reviewSaleId.parse(req.params.saleId);
    const input = acknowledgeSchema.parse(req.body);
    const result = acknowledgeFinanceReview(db, req.user, id, input, financeReviewDemo);
    res.status(result.created ? 201 : 200).json({ ...result, nonExecuting: true });
  });
}
