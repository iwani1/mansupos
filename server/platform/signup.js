import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { hashPasswordAsync, passwordProblem } from '../passwords.js';
import { slugProblem } from './slug.js';
import { normaliseStoreUrl } from './store-url.js';

// The platform's own site at the base domain: sign up, verify the email,
// and the new shop is created with a 14-day trial in "setup" stage.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TRIAL_DAYS = 14;

const signupSchema = z.object({
  shopName: z.string().trim().min(2, 'Enter the shop name').max(80),
  slug: z.string().trim().toLowerCase(),
  storeUrl: z.string().trim().max(200),
  ownerName: z.string().trim().min(2, 'Enter your name').max(80),
  email: z.string().trim().toLowerCase().max(120).email('Enter a valid email address'),
  phone: z.string().trim().max(40).regex(/^[0-9+() -]*$/, 'Use digits, spaces and + only').default(''),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'Username: 3 to 40 letters, numbers, dots, hyphens or underscores'),
  password: z.string().min(12, 'Use a password of at least 12 characters').max(256),
  acceptTerms: z.literal(true, { message: 'Accept the terms to continue' }),
  inviteCode: z.string().trim().toUpperCase().max(40).optional().transform(v => v || undefined),
}).strict();

export function createSignupApp({ config, registry, provisionShop, mailer, logger, mount }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: null } },
    strictTransportSecurity: config.production ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use(express.json({ limit: '16kb' }));
  const baseOrigin = `https://${config.baseDomain}`;
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'POST') {
      if (!req.is('application/json')) return next(new AppError('Use application/json.', 415));
      const origin = req.headers.origin;
      if (origin ? origin !== baseOrigin : config.production) return next(new AppError('Cross-origin request rejected.', 403));
    }
    return next();
  });
  const limit = (windowMs, max, message) => rateLimit({ windowMs, limit: max, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: message } });
  const signupLimit = limit(60 * 60000, config.signupsPerHour, 'Too many sign-ups from this connection. Try again in an hour.');
  const verifyLimit = limit(60 * 60000, 20, 'Too many attempts. Try again later.');
  const checkLimit = limit(60000, 60, 'Too many checks. Wait a moment.');

  app.get('/api/health', (_req, res) => res.json({ ok: true, platform: true }));
  // Release notice read by every Windows till (Help > Check for updates).
  app.get('/till/latest.json', (_req, res) => {
    const release = registry.tillRelease();
    if (!release) return res.status(404).json({ error: 'No release published.' });
    res.set('Cache-Control', 'public, max-age=300').json(release);
  });
  app.get('/api/signup/config', (_req, res) => res.json({ mode: config.signupMode, baseDomain: config.baseDomain }));
  app.get('/api/signup/check', checkLimit, (req, res) => {
    const slug = String(req.query.slug || '').trim().toLowerCase();
    const problem = slugProblem(slug) || (registry.bySlug(slug) ? 'That address is already taken.' : '');
    res.json({ slug, available: !problem, problem, url: problem ? null : config.shopOrigin(slug) });
  });

  app.post('/api/signup', signupLimit, async (req, res) => {
    const input = signupSchema.parse(req.body);
    const slugIssue = slugProblem(input.slug) || (registry.bySlug(input.slug) ? 'That address is already taken.' : '');
    if (slugIssue) throw new AppError(slugIssue, 400, 'SLUG');
    let storeUrl;
    try { storeUrl = normaliseStoreUrl(input.storeUrl); } catch (error) { throw new AppError(error.message, 400, 'STORE_URL'); }
    // Pilot: sign-up by invitation only (PLATFORM_SIGNUP_MODE=invite).
    let invite = null;
    // In open mode a code is optional, but still applies its founding price.
    if (config.signupMode === 'invite' || input.inviteCode) {
      invite = registry.invite(input.inviteCode || '', input.email);
      if (!invite) throw new AppError('That invite code is not valid for this email. Ask Mansu POS for an invitation.', 400, 'INVITE');
    }
    const pwIssue = passwordProblem(input.password, input.username);
    if (pwIssue) throw new AppError(pwIssue, 400, 'PASSWORD');
    const { password, ...rest } = input;
    delete rest.acceptTerms;
    delete rest.inviteCode;
    if (invite) rest.inviteId = invite.id;
    const { token } = registry.createSignup({ email: input.email, payload: { ...rest, storeUrl }, passwordHash: await hashPasswordAsync(password) });
    try {
      await mailer.send({
        to: input.email, subject: 'Confirm your Mansu POS sign-up',
        text: `Hello ${input.ownerName},\n\nConfirm your email to create ${input.shopName} on Mansu POS:\n${baseOrigin}/verify#token=${token}\n\nThe link works for 24 hours. If you did not sign up, ignore this email.`,
      });
    } catch {
      throw new AppError('We could not send the confirmation email. Check the address and try again in a few minutes.', 502, 'MAIL_FAILED');
    }
    registry.audit('signup', 'signup.requested', null, input.slug);
    res.status(202).json({ ok: true, email: input.email });
  });

  app.post('/api/signup/verify', verifyLimit, async (req, res) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).strict().parse(req.body);
    const signup = registry.signupByToken(token);
    if (!signup) throw new AppError('This link is not valid. Sign up again.', 404, 'LINK_INVALID');
    if (signup.usedAt) {
      const shop = signup.shopId && registry.byId(signup.shopId);
      if (shop) return res.json({ ok: true, shopUrl: config.shopOrigin(shop.slug), already: true });
      throw new AppError('This link has already been used.', 409, 'LINK_USED');
    }
    if (signup.expired) throw new AppError('This link has expired. Sign up again.', 410, 'LINK_EXPIRED');
    if (!registry.claimSignup(signup.id)) throw new AppError('This link has already been used.', 409, 'LINK_USED');
    const p = signup.payload;
    if (registry.bySlug(p.slug)) throw new AppError('Someone took that shop address before you confirmed. Sign up again with another address.', 409, 'SLUG_TAKEN');
    let invite = null;
    if (p.inviteId) {
      invite = registry.db.prepare('SELECT * FROM invites WHERE id=?').get(p.inviteId);
      if (!registry.claimInvite(p.inviteId, null)) throw new AppError('That invitation has already been used or has expired. Ask Mansu POS for a new one.', 409, 'INVITE_USED');
    } else if (config.signupMode === 'invite') throw new AppError('Sign-up is by invitation only.', 403, 'INVITE');
    const { shop } = provisionShop({
      slug: p.slug, name: p.shopName, storeUrl: p.storeUrl, ownerUsername: p.username, trialDays: TRIAL_DAYS,
      owner: { name: p.ownerName, email: signup.email, phone: p.phone, passwordHash: signup.passwordHash }, actor: `signup:${signup.email}`,
    });
    registry.attachSignupShop(signup.id, shop.id);
    if (invite) {
      registry.db.prepare('UPDATE invites SET shop_id=? WHERE id=?').run(shop.id, invite.id);
      if (invite.discount_percent) registry.setDiscount(shop.id, { percent: invite.discount_percent, months: invite.discount_months }, `invite:${invite.id}`);
    }
    const shopUrl = config.shopOrigin(shop.slug);
    await mailer.send({
      to: signup.email, subject: `${shop.name} is ready on Mansu POS`,
      text: `Your shop is at ${shopUrl}\nSign in as "${p.username}" with the password you chose, then follow Shop setup to connect your WooCommerce store.\nYour free trial runs for ${TRIAL_DAYS} days.`,
    }).catch(() => logger.warn({ msg: 'platform.welcome_mail_failed', shop: shop.slug }));
    logger.info({ msg: 'platform.signup_verified', shop: shop.slug });
    res.status(201).json({ ok: true, shopUrl });
  });

  if (mount) mount(app);
  app.use('/api', (_req, _res, next) => next(new AppError('Not found.', 404)));
  const pages = { '/': 'index.html', '/verify': 'verify.html', '/console': 'console.html', '/terms': 'terms.html', '/privacy': 'privacy.html' };
  app.get(Object.keys(pages), (req, res) => res.sendFile(pages[req.path], { root: publicDir, headers: { 'Cache-Control': 'no-cache' } }));
  app.use('/static', express.static(publicDir, { index: false, maxAge: '1h' }));
  app.use((error, req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => i.message).join('. '), code: 'VALIDATION_ERROR' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Invalid request.' });
    const status = error.status || 500;
    if (status >= 500) logger.error({ msg: 'platform.signup_error', name: error.name, reason: String(error.message).slice(0, 200) });
    return res.status(status).json({ error: error instanceof AppError ? error.message : 'Something went wrong. Please try again.', code: error.code || 'SERVER_ERROR' });
  });
  return app;
}
