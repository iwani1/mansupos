// Plans, prices and what a shop may do right now. Prices are in pesewas
// (GHS x 100), as Paystack expects. Annual = 10 months' price for 12.
export const PLANS = {
  starter: { key: 'starter', name: 'Starter', monthly: 25000, maxStaff: 3,
    features: { inventoryWrites: false, productWrites: false, returns: false },
    summary: '1 till, up to 3 staff, sales, shifts, receipts and reports' },
  growth: { key: 'growth', name: 'Growth', monthly: 45000, maxStaff: null,
    features: { inventoryWrites: true, productWrites: true, returns: true },
    summary: 'Unlimited staff and tills, stock control, purchasing, returns, product editing' },
  pro: { key: 'pro', name: 'Pro', monthly: 80000, maxStaff: null,
    features: { inventoryWrites: true, productWrites: true, returns: true },
    summary: 'Everything in Growth, plus priority support' },
};
export const INTERVALS = { monthly: { months: 1, label: 'month' }, annually: { months: 12, label: 'year' } };
export const DEFAULT_PLAN = 'growth';

export function planPrice(plan, interval) {
  const p = PLANS[plan];
  if (!p || !INTERVALS[interval]) throw new Error('Unknown plan or billing period.');
  return interval === 'annually' ? p.monthly * 10 : p.monthly;
}

export function addMonths(fromMs, months) {
  const date = new Date(fromMs);
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months);
  if (date.getUTCDate() < day) date.setUTCDate(0); // 31 Jan + 1 month = 28/29 Feb
  return date.getTime();
}

// What the shop may do now. Never deletes anything: a lapsed shop keeps
// sign-in, reports, history and exports, but cannot sell or change website
// stock until it pays.
//   comped   - complimentary (set by an admin): full access
//   trial    - inside the free trial
//   active   - paid up
//   grace    - payment due; still full access for graceDays, with a warning
//   lapsed   - after grace: read-only
//   unbilled - created by an admin with no trial or payment yet: full access,
//              flagged in the console
export function computeAccess(shop, { now = Date.now(), graceDays = 7 } = {}) {
  const plan = PLANS[shop.billing?.plan] ? shop.billing.plan : DEFAULT_PLAN;
  const base = { plan, autoRenew: Boolean(shop.billing?.autoRenew), billingStatus: shop.billing?.status || null };
  if (shop.billing?.status === 'comped') return { ...base, state: 'comped', full: true, until: null, graceUntil: null };
  const trialEnds = shop.trialEndsAt ? Date.parse(shop.trialEndsAt) : null;
  const paidUntil = shop.billing?.paidUntil ? Date.parse(shop.billing.paidUntil) : null;
  if (trialEnds === null && paidUntil === null) return { ...base, state: 'unbilled', full: true, until: null, graceUntil: null };
  const until = Math.max(trialEnds ?? 0, paidUntil ?? 0);
  const graceUntil = until + graceDays * 86400000;
  const iso = ms => new Date(ms).toISOString();
  if (now < until) return { ...base, state: paidUntil !== null && paidUntil >= until ? 'active' : 'trial', full: true, until: iso(until), graceUntil: iso(graceUntil) };
  if (now < graceUntil) return { ...base, state: 'grace', full: true, until: iso(until), graceUntil: iso(graceUntil) };
  return { ...base, state: 'lapsed', full: false, until: iso(until), graceUntil: iso(graceUntil) };
}

// What the shop's POS app is allowed, given its plan and access.
export function entitlements(shop, access) {
  const plan = PLANS[access.plan];
  return {
    canSell: access.full && shop.stage === 'selling',
    features: Object.fromEntries(Object.entries(plan.features).map(([key, allowed]) => [key, Boolean(allowed && shop.features?.[key])])),
    maxStaff: plan.maxStaff,
  };
}
