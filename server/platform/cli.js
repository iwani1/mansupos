import { createInterface } from 'node:readline';
import { createPlatform } from './platform.js';
import { FEATURES, STAGES } from './registry.js';
import { backupPlatform } from './backup.js';

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
  backup [--to <folder>]                  (central database + every shop's database, verified)`;

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
