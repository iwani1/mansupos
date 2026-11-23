import { z } from 'zod';
import { AppError } from '../errors.js';
import { PLANS, INTERVALS, planPrice, shopPrice, computeAccess } from './billing.js';
import { validPaystackSignature } from './paystack.js';

// Subscriptions through Paystack. The amount charged always comes from our
// own checkout record (never from the browser or from Paystack metadata), a
// payment counts only when Paystack confirms success in GHS for exactly that
// amount, and each payment reference extends access once.
const checkoutSchema = z.object({
  plan: z.enum(Object.keys(PLANS)), interval: z.enum(Object.keys(INTERVALS)), autoRenew: z.boolean().default(false),
  email: z.string().trim().toLowerCase().email().max(120).optional(),
}).strict();

export function createBillingService({ registry, config, paystack, logger }) {
  const graceDays = config.graceDays;
  const access = shop => computeAccess(shop, { graceDays });

  function view(shop) {
    return {
      access: access(shop), billing: { plan: shop.billing.plan, status: shop.billing.status, paidUntil: shop.billing.paidUntil, autoRenew: shop.billing.autoRenew, subscription: Boolean(shop.billing.subscriptionCode) },
      trialEndsAt: shop.trialEndsAt, configured: Boolean(paystack), testMode: Boolean(paystack?.testMode),
      discount: shop.billing.discount,
      plans: Object.values(PLANS).map(p => ({ key: p.key, name: p.name, summary: p.summary, maxStaff: p.maxStaff,
        prices: Object.fromEntries(Object.keys(INTERVALS).map(i => [i, shopPrice(shop, p.key, i)])),
        fullPrices: Object.fromEntries(Object.keys(INTERVALS).map(i => [i, planPrice(p.key, i)])),
        autoRenew: Object.fromEntries(Object.keys(INTERVALS).map(i => [i, !shop.billing.discount && Boolean(registry.planCode(p.key, i))])) })),
      events: registry.billingEvents(shop.id, 20),
    };
  }

  // Applies a Paystack transaction (from verify or a webhook). Returns true if
  // it extended a shop's access.
  function applyCharge(data, via) {
    if (data?.status !== 'success' || data.currency !== 'GHS' || !data.reference) return false;
    const checkout = registry.checkout(data.reference);
    if (checkout) {
      if (Number(data.amount) !== checkout.amount) {
        logger.warn({ msg: 'billing.amount_mismatch', reference: data.reference, via });
        return false;
      }
      return registry.recordPayment({ shopId: checkout.shop_id, plan: checkout.plan, interval: checkout.interval, reference: data.reference,
        amount: checkout.amount, actor: `paystack:${via}`, customerCode: data.customer?.customer_code, autoRenew: Boolean(checkout.auto_renew) });
    }
    // A renewal Paystack charged on its own: matched by plan code and customer.
    const planInfo = registry.planForCode(data.plan?.plan_code || data.plan_object?.plan_code || data.plan);
    const shop = planInfo && registry.byCustomer(data.customer?.customer_code);
    if (!shop || Number(data.amount) !== planPrice(planInfo.plan, planInfo.interval)) {
      logger.warn({ msg: 'billing.unmatched_charge', reference: String(data.reference).slice(0, 60), via });
      return false;
    }
    return registry.recordPayment({ shopId: shop.id, plan: planInfo.plan, interval: planInfo.interval, reference: data.reference,
      amount: Number(data.amount), actor: `paystack:${via}`, customerCode: data.customer?.customer_code, autoRenew: true });
  }

  async function handleWebhook(req, res) {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!paystack) return send(404, { error: 'Billing is not set up.' });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) return send(413, { error: 'Too large.' }); chunks.push(chunk); }
    const raw = Buffer.concat(chunks);
    if (!validPaystackSignature(paystack.secretKey, raw, req.headers['x-paystack-signature'])) {
      logger.warn({ msg: 'billing.webhook_bad_signature' });
      return send(401, { error: 'Invalid signature.' });
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return send(400, { error: 'Invalid JSON.' }); }
    const { event, data } = body || {};
    try {
      if (event === 'charge.success') applyCharge(data, 'webhook');
      else if (event === 'subscription.create') {
        const shop = registry.byCustomer(data?.customer?.customer_code);
        if (shop && registry.billingEvent({ key: `subscription.create:${data.subscription_code}`, shopId: shop.id, kind: 'subscription', detail: 'automatic renewal on' })) {
          registry.setBilling(shop.id, { subscriptionCode: String(data.subscription_code), emailToken: String(data.email_token || ''), autoRenew: true }, 'paystack:webhook');
        }
      } else if (event === 'subscription.not_renew' || event === 'subscription.disable') {
        const shop = registry.bySubscription(data?.subscription_code);
        if (shop && registry.billingEvent({ key: `${event}:${data.subscription_code}`, shopId: shop.id, kind: 'cancelled', detail: 'automatic renewal off' })) {
          registry.setBilling(shop.id, { autoRenew: false, status: 'cancelled' }, 'paystack:webhook');
        }
      } else if (event === 'invoice.payment_failed') {
        const shop = registry.bySubscription(data?.subscription?.subscription_code);
        if (shop && registry.billingEvent({ key: `invoice.payment_failed:${data.invoice_code || data.id}`, shopId: shop.id, kind: 'payment_failed', detail: 'renewal charge failed' })) {
          registry.setBilling(shop.id, { status: 'past_due' }, 'paystack:webhook');
        }
      }
    } catch (error) {
      logger.error({ msg: 'billing.webhook_failed', event: String(event).slice(0, 40), name: error.name });
      return send(500, { error: 'Could not process.' }); // Paystack retries
    }
    return send(200, { ok: true });
  }

  function routes(shopId, origin) {
    return (app, { auth, role, sensitiveLimit }) => {
      const owner = [auth, role('owner')];
      const shop = () => { const s = registry.byId(shopId); if (!s) throw new AppError('Shop not found.', 404); return s; };
      app.get('/api/billing', ...owner, (_req, res) => res.json({ billing: view(shop()) }));
      app.post('/api/billing/checkout', ...owner, sensitiveLimit, async (req, res) => {
        if (!paystack) throw new AppError('Online payment is not set up yet. Contact Mansu POS support to pay by invoice.', 503, 'BILLING_OFF');
        const input = checkoutSchema.parse(req.body);
        const s = shop();
        const email = s.owner.email || input.email;
        if (!email) throw new AppError('Enter the email address for receipts.', 400, 'EMAIL_REQUIRED');
        if (input.autoRenew && s.billing.discount) throw new AppError('Your founding price is paid per period. Automatic renewal starts after it ends.', 400, 'DISCOUNT_ONE_OFF');
        const planCode = input.autoRenew ? registry.planCode(input.plan, input.interval) : null;
        if (input.autoRenew && !planCode) throw new AppError('Automatic renewal is not available for that plan yet. Pay for a period instead.', 400, 'NO_PLAN_CODE');
        const amount = shopPrice(s, input.plan, input.interval);
        const reference = registry.createCheckout({ shopId: s.id, plan: input.plan, interval: input.interval, amount, autoRenew: input.autoRenew });
        const data = await paystack.initialize({ email, amount, reference, callbackUrl: `${origin}/?billing=return`, plan: planCode || undefined,
          channels: input.autoRenew ? ['card'] : ['card', 'mobile_money'],
          metadata: { shop_id: s.id, shop: s.slug, plan: input.plan, interval: input.interval, auto_renew: input.autoRenew } });
        const url = String(data?.authorization_url || '');
        if (!/^https:\/\/checkout\.paystack\.com\//.test(url)) throw new AppError('Paystack did not return a checkout page.', 502);
        registry.audit(`owner:${req.user.username}`, 'billing.checkout_started', s.id, `${input.plan}/${input.interval}${input.autoRenew ? ' auto' : ''}`);
        res.json({ url });
      });
      app.post('/api/billing/verify', ...owner, sensitiveLimit, async (req, res) => {
        if (!paystack) throw new AppError('Online payment is not set up.', 503, 'BILLING_OFF');
        const { reference } = z.object({ reference: z.string().min(8).max(100) }).strict().parse(req.body);
        const checkout = registry.checkout(reference);
        if (!checkout || checkout.shop_id !== shopId) throw new AppError('Payment not found for this shop.', 404);
        if (!checkout.paid_at) {
          const data = await paystack.verify(reference);
          if (data?.status !== 'success') return res.json({ paid: false, status: String(data?.status || 'unknown'), billing: view(shop()) });
          applyCharge(data, 'verify');
        }
        res.json({ paid: Boolean(registry.checkout(reference).paid_at), billing: view(shop()), reload: true });
      });
      app.post('/api/billing/manage', ...owner, sensitiveLimit, async (_req, res) => {
        const s = shop();
        if (!paystack || !s.billing.subscriptionCode) throw new AppError('There is no automatic renewal to manage.', 409);
        const data = await paystack.manageLink(s.billing.subscriptionCode);
        const url = String(data?.link || '');
        if (!/^https:\/\/(checkout\.)?paystack\.com\//.test(url)) throw new AppError('Paystack did not return a management page.', 502);
        res.json({ url });
      });
    };
  }

  return { access, view, applyCharge, handleWebhook, routes };
}
