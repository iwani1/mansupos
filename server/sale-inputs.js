import { z } from 'zod';
import { AppError } from './errors.js';

// Shared schema for both the web checkout and the protected desktop ledger.
// The practice-only Windows build imports this file without importing Woo,
// server routes, catalogue IO or production payment adapters.
export const prepareSchema = z.object({
  idempotencyKey: z.string().uuid(),
  saleType: z.enum(['retail', 'wholesale']).optional().default('retail'),
  // A buyer name is optional on new wholesale orders. buyerId remains accepted
  // for outstanding orders made by the previous named-buyer checkout.
  buyerId: z.string().uuid().optional(),
  buyerName: z.string().trim().max(120).optional(),
  wholesaleApproved: z.boolean().optional().default(false),
  items: z.array(z.object({
    productId: z.number().int().positive(), variationId: z.number().int().min(0).optional().default(0),
    quantity: z.number().int().min(1).max(999), agreedUnitPrice: z.number().int().min(1).max(100000000).optional(),
  }).strict()).min(1).max(100),
  note: z.string().trim().max(250).optional().default(''),
}).strict().superRefine((value, ctx) => {
  if (value.saleType === 'wholesale') {
    // eslint-disable-next-line no-control-regex -- Buyer names appear on orders, receipts and exports.
    if (value.buyerName && (value.buyerName.length < 2 || /[\u0000-\u001f\u007f]/.test(value.buyerName))) ctx.addIssue({ code: 'custom', path: ['buyerName'], message: 'Use a single-line buyer name of at least two characters, or leave it blank.' });
    if (value.buyerId && value.buyerName) ctx.addIssue({ code: 'custom', path: ['buyerName'], message: 'Provide either a buyer name or an existing buyer ID, not both.' });
    value.items.forEach((item, i) => { if (item.agreedUnitPrice === undefined) ctx.addIssue({ code: 'custom', path: ['items', i, 'agreedUnitPrice'], message: 'Enter an agreed tax-inclusive unit price for every wholesale line.' }); });
    if (!value.wholesaleApproved) ctx.addIssue({ code: 'custom', path: ['wholesaleApproved'], message: 'An owner or manager must approve the wholesale quote before preparing an order.' });
  } else {
    if (value.buyerId || value.buyerName !== undefined || value.wholesaleApproved) ctx.addIssue({ code: 'custom', path: ['buyerName'], message: 'Buyer and approval require a wholesale sale.' });
    value.items.forEach((item, i) => { if (item.agreedUnitPrice !== undefined) ctx.addIssue({ code: 'custom', path: ['items', i, 'agreedUnitPrice'], message: 'Retail prices come from WooCommerce; do not send prices from the browser.' }); });
  }
});
export const paymentSchema = z.object({
  method: z.enum(['cash', 'momo', 'card']),
  reference: z.string().trim().max(80).optional().default(''),
  tendered: z.number().int().min(0).max(100000000).optional(),
  confirmed: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.method !== 'cash' && !value.reference) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Enter the external payment reference.' });
  if (/\d{13,19}/.test(value.reference.replace(/\D/g, ''))) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Never enter a full card number. Use the merchant or terminal reference.' });
});

export function normalizeItems(items) {
  const merged = new Map();
  for (const item of items) {
    const key = `${item.productId}:${item.variationId || 0}`;
    const current = merged.get(key) || { productId: item.productId, variationId: item.variationId || 0, quantity: 0, ...(item.agreedUnitPrice !== undefined ? { agreedUnitPrice: item.agreedUnitPrice } : {}) };
    if (current.agreedUnitPrice !== item.agreedUnitPrice) throw new AppError('Use one agreed unit price for each product option in a wholesale order.', 400);
    current.quantity += item.quantity;
    if (current.quantity > 999) throw new AppError('A single cart line cannot exceed 999 units.', 400);
    merged.set(key, current);
  }
  return [...merged.values()].sort((a, b) => a.productId - b.productId || a.variationId - b.variationId);
}
