import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { PLANS, INTERVALS, planPrice, computeAccess } from './billing.js';
import { newReference } from './admin-auth.js';

// The platform console API at <base domain>/api/console. Admin sign-in is
// password + authenticator code; the session cookie is host-only, HttpOnly,
// SameSite=Strict (and Secure in production). Every change is audited with
// the admin's name.
const COOKIE = 'mansu_console';
const readCookie = req => (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend'), note: z.string().max(200).default('') }).strict(),
  z.object({ action: z.literal('resume'), note: z.string().max(200).default('') }).strict(),
  z.object({ action: z.literal('extend_trial'), days: z.number().int().min(1).max(90), note: z.string().max(200).default('') }).strict(),
  z.object({ action: z.literal('record_payment'), plan: z.enum(Object.keys(PLANS)), interval: z.enum(Object.keys(INTERVALS)), note: z.string().trim().min(3, 'Add a note: invoice or receipt number').max(200) }).strict(),
  z.object({ action: z.literal('set_plan'), plan: z.enum(Object.keys(PLANS)), note: z.string().max(200).default('') }).strict(),
  z.object({ action: z.literal('comp'), on: z.boolean(), note: z.string().trim().min(3, 'Add a reason').max(200) }).strict(),
]);

export function consoleRouter({ registry, auth, config, billing }) {
  const router = express.Router();
  const cookie = token => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${config.production ? '; Secure' : ''}; Max-Age=28800`;
  const loginLimit = rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again later.' } });
  const requireAdmin = (req, _res, next) => {
    req.admin = auth.session(readCookie(req));
    return req.admin ? next() : next(new AppError('Sign in to the console.', 401));
  };
  const shopView = shop => ({
    id: shop.id, slug: shop.slug, name: shop.name, url: config.shopOrigin(shop.slug), storeUrl: shop.storeUrl, status: shop.status, stage: shop.stage,
    owner: shop.owner, createdAt: shop.createdAt, trialEndsAt: shop.trialEndsAt, billing: shop.billing, access: computeAccess(shop, { graceDays: config.graceDays }),
    connected: registry.hasSecret(shop.id, 'woo_key'), healthOk: shop.health?.ok ?? null,
  });

  router.post('/login', loginLimit, async (req, res) => {
    const input = z.object({ username: z.string().max(80), password: z.string().max(256), code: z.string().max(10) }).strict().parse(req.body);
    const result = await auth.login(input.username, input.password, input.code);
    if (result.error) throw new AppError(result.error, result.status);
    res.set('Set-Cookie', cookie(result.token)).json({ admin: result.admin });
  });
  router.post('/logout', (req, res) => {
    auth.logout(readCookie(req));
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict${config.production ? '; Secure' : ''}; Max-Age=0`).json({ ok: true });
  });
  router.get('/me', requireAdmin, (req, res) => res.json({ admin: req.admin, billingConfigured: Boolean(billing.configured), baseDomain: config.baseDomain }));
  router.get('/shops', requireAdmin, (_req, res) => res.json({ shops: registry.list().map(shopView) }));
  router.get('/shops/:id', requireAdmin, (req, res) => {
    const shop = registry.byId(req.params.id);
    if (!shop) throw new AppError('Shop not found.', 404);
    res.json({ shop: shopView(shop), events: registry.billingEvents(shop.id, 50), audit: registry.recentAudit(50, shop.id) });
  });
  router.post('/shops/:id/actions', requireAdmin, (req, res) => {
    const shop = registry.byId(req.params.id);
    if (!shop) throw new AppError('Shop not found.', 404);
    const input = actionSchema.parse(req.body);
    const actor = `admin:${req.admin.username}`;
    if (input.action === 'suspend') registry.update(shop.id, { status: 'suspended' }, actor);
    if (input.action === 'resume') registry.update(shop.id, { status: 'active' }, actor);
    if (input.action === 'extend_trial') {
      const from = Math.max(Date.now(), shop.trialEndsAt ? Date.parse(shop.trialEndsAt) : 0);
      registry.setBilling(shop.id, { trialEndsAt: new Date(from + input.days * 86400000).toISOString() }, actor);
    }
    if (input.action === 'record_payment') {
      registry.recordPayment({ shopId: shop.id, plan: input.plan, interval: input.interval, reference: newReference(), amount: planPrice(input.plan, input.interval), actor });
    }
    if (input.action === 'set_plan') registry.setBilling(shop.id, { plan: input.plan }, actor);
    if (input.action === 'comp') registry.setBilling(shop.id, { status: input.on ? 'comped' : (shop.billing.paidUntil ? 'active' : null) }, actor);
    if (input.note) registry.audit(actor, `console.${input.action}`, shop.id, input.note);
    res.json({ shop: shopView(registry.byId(shop.id)) });
  });
  router.get('/audit', requireAdmin, (req, res) => res.json({ audit: registry.recentAudit(Math.min(500, Number(req.query.limit) || 100)) }));
  return router;
}
