import { createInterface } from 'node:readline';
import { createPlatform } from './platform.js';
import { FEATURES, STAGES } from './registry.js';
import { backupPlatform } from './backup.js';
import { PLANS, INTERVALS, planPrice } from './billing.js';
import { newReference } from './admin-auth.js';

// Platform admin commands until the web console exists (phase 3).
// Secrets are read from standard input, never from arguments, so they do not
// land in shell history or the process list.
const usage = `Usage: npm run platform -- <command> [options]
  list
  create-shop --slug <slug> --name "<shop name>" --store https://<store> --owner <username>
  set-woo-keys --slug <slug>              (reads consumer key, then secret, from stdin)
  set-media-login --slug <slug>           (reads WordPress user, then application password, from stdin)
  set-stage --slug <slug> --stage ${STAGES.join('|')}
  set-feature --slug <slug> --feature ${FEATURES.join('|')} --on|--off
  set-business --slug <slug> [--address ..] [--phone ..] [--tax-id ..] [--receipt-footer ..] [--receipt-width 58|80|a4]
  suspend --slug <slug> | resume --slug <slug>
  backup [--to <folder>]                  (central database + every shop's database, verified)
  outbox [--last <n>]                     (emails queued while no email provider is set up)
  admin-create --username <name>          (reads the password from stdin; prints the authenticator secret once)
  admin-reset-2fa --username <name>
  billing-sync-plans                      (creates the Paystack plans once; needs PLATFORM_PAYSTACK_SECRET_KEY)
  record-payment --slug <slug> --plan ${Object.keys(PLANS).join('|')} --interval ${Object.keys(INTERVALS).join('|')} --note "<invoice ref>"
  extend-trial --slug <slug> --days <1-90>
  set-plan --slug <slug> --plan ${Object.keys(PLANS).join('|')}
  comp --slug <slug> --on|--off --note "<reason>"`;

function options(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error(`Unexpected argument: ${args[i]}`);
    const key = args[i].slice(2);
    if (key === 'on' || key === 'off') { out[key] = true; continue; }
    if (args[i + 1] === undefined) throw new Error(`Missing value for --${key}.`);
    out[key] = args[++i];
  }
  return out;
}

async function readLines(count) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = [];
  for await (const line of rl) { lines.push(line.trim()); if (lines.length === count) break; }
  rl.close();
  if (lines.length !== count || lines.some(line => !line)) throw new Error(`Expected ${count} non-empty lines on standard input.`);
  return lines;
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help') { console.log(usage); process.exit(command ? 0 : 1); }
const platform = createPlatform({ logger: { debug() {}, info() {}, warn: console.error, error: console.error, child() { return this; } } });
const { registry } = platform;
const actor = `cli:${process.env.USER || 'admin'}`;
try {
  const opt = options(rest);
  const shop = () => {
    const found = registry.bySlug(opt.slug || '');
    if (!found) throw new Error('No shop with that --slug.');
    return found;
  };
  switch (command) {
    case 'list':
      for (const s of registry.list()) console.log([s.slug, s.status, s.stage, s.storeUrl, s.name].join('\t'));
      break;
    case 'create-shop': {
      const result = platform.provisionShop({ slug: opt.slug, name: opt.name, storeUrl: opt.store, ownerUsername: opt.owner, actor });
      console.log(`Created ${result.shop.slug} (${result.shop.id}) at ${platform.config.shopOrigin(result.shop.slug)}`);
      console.log(`Owner: ${result.ownerUsername}  Temporary password (shown once): ${result.ownerPassword}`);
      console.log('Next: set-woo-keys, then set-stage read_only, then selling after the owner has checked the catalogue.');
      break;
    }
    case 'set-woo-keys': {
      const s = shop();
      const [key, secret] = await readLines(2);
      if (!/^ck_[0-9a-f]{40}$/i.test(key) || !/^cs_[0-9a-f]{40}$/i.test(secret)) throw new Error('Expected a WooCommerce consumer key (ck_...) and secret (cs_...).');
      registry.setSecret(s.id, 'woo_key', key, actor);
      registry.setSecret(s.id, 'woo_secret', secret, actor);
      console.log(`Saved WooCommerce keys for ${s.slug} (encrypted).`);
      break;
    }
    case 'set-media-login': {
      const s = shop();
      const [user, password] = await readLines(2);
      if (password.replace(/\s/g, '').length < 16) throw new Error('Expected a WordPress Application Password.');
      registry.setSecret(s.id, 'wp_media_user', user, actor);
      registry.setSecret(s.id, 'wp_media_password', password, actor);
      console.log(`Saved WordPress photo login for ${s.slug} (encrypted).`);
      break;
    }
    case 'set-stage': console.log(registry.update(shop().id, { stage: opt.stage }, actor).stage); break;
    case 'set-feature': {
      if (Boolean(opt.on) === Boolean(opt.off)) throw new Error('Give exactly one of --on or --off.');
      console.log(JSON.stringify(registry.update(shop().id, { features: { [opt.feature]: Boolean(opt.on) } }, actor).features));
      break;
    }
    case 'set-business': {
      const map = { address: 'address', phone: 'phone', 'tax-id': 'taxId', 'receipt-footer': 'receiptFooter', 'receipt-width': 'receiptWidth' };
      const business = {};
      for (const [flag, value] of Object.entries(opt)) { if (flag !== 'slug') { if (!map[flag]) throw new Error(`Unknown option --${flag}.`); business[map[flag]] = value; } }
      console.log(JSON.stringify(registry.update(shop().id, { business }, actor).business));
      break;
    }
    case 'backup': {
      const { dir, manifest } = await backupPlatform(platform.config, registry, opt.to);
      console.log(`Backed up the central database and ${manifest.shops.length} shop(s) to ${dir}`);
      if (manifest.skipped.length) console.log(`Skipped (no database yet): ${manifest.skipped.map(s => s.slug).join(', ')}`);
      console.log('Back up PLATFORM_MASTER_KEY separately: without it the saved shop keys cannot be read.');
      break;
    }
    case 'outbox':
      for (const m of platform.mailer.list(Number(opt.last) || 10)) console.log(`--- ${m.queuedAt}  to: ${m.to}\n${m.subject}\n\n${m.text}\n`);
      break;
    case 'admin-create': {
      const [password] = await readLines(1);
      const made = platform.adminAuth.create(opt.username, password);
      console.log(`Admin ${made.username} created. Add this to an authenticator app now (shown once):`);
      console.log(`  Secret: ${made.secret}\n  URL:    ${made.otpauth}`);
      console.log(`Console: https://${platform.config.baseDomain}/console`);
      break;
    }
    case 'admin-reset-2fa': {
      const made = platform.adminAuth.resetTotp(opt.username);
      console.log(`New authenticator secret (shown once): ${made.secret}\n  URL: ${made.otpauth}`);
      break;
    }
    case 'billing-sync-plans': {
      if (!platform.paystack) throw new Error('Set PLATFORM_PAYSTACK_SECRET_KEY first.');
      for (const plan of Object.keys(PLANS)) for (const interval of Object.keys(INTERVALS)) {
        const existing = registry.planCode(plan, interval);
        if (existing) { console.log(`${plan}/${interval}: ${existing} (kept)`); continue; }
        const made = await platform.paystack.createPlan({ name: `Mansu POS ${PLANS[plan].name} (${interval})`, amount: planPrice(plan, interval), interval });
        registry.setSetting(`paystack_plan:${plan}:${interval}`, made.plan_code);
        registry.audit(actor, 'billing.plan_created', null, `${plan}/${interval} ${made.plan_code}`);
        console.log(`${plan}/${interval}: ${made.plan_code} (created${platform.paystack.testMode ? ', TEST mode' : ''})`);
      }
      break;
    }
    case 'record-payment': {
      const s = shop();
      if (!opt.note || opt.note.length < 3) throw new Error('Add --note with the invoice or receipt number.');
      registry.recordPayment({ shopId: s.id, plan: opt.plan, interval: opt.interval, reference: newReference(), amount: planPrice(opt.plan, opt.interval), actor });
      registry.audit(actor, 'billing.manual_payment_note', s.id, opt.note);
      console.log(`Recorded. Paid until ${registry.byId(s.id).billing.paidUntil}`);
      break;
    }
    case 'extend-trial': {
      const s = shop();
      const days = Number(opt.days);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be 1 to 90.');
      const from = Math.max(Date.now(), s.trialEndsAt ? Date.parse(s.trialEndsAt) : 0);
      console.log(`Trial ends ${registry.setBilling(s.id, { trialEndsAt: new Date(from + days * 86400000).toISOString() }, actor).trialEndsAt}`);
      break;
    }
    case 'set-plan': console.log(registry.setBilling(shop().id, { plan: opt.plan }, actor).billing.plan); break;
    case 'comp': {
      const s = shop();
      if (Boolean(opt.on) === Boolean(opt.off) || !opt.note) throw new Error('Give --on or --off, and --note with the reason.');
      registry.setBilling(s.id, { status: opt.on ? 'comped' : (s.billing.paidUntil ? 'active' : null) }, actor);
      registry.audit(actor, 'billing.comp_note', s.id, opt.note);
      console.log(opt.on ? 'Complimentary.' : 'Billing normal.');
      break;
    }
    case 'suspend': registry.update(shop().id, { status: 'suspended' }, actor); console.log('Suspended.'); break;
    case 'resume': registry.update(shop().id, { status: 'active' }, actor); console.log('Active.'); break;
    default: throw new Error(`Unknown command.\n${usage}`);
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
} finally {
  platform.close();
}
