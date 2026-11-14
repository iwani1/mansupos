import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readConfig, APP_VERSION } from './config.js';
import { passwordProblem } from './db.js';
import { loadInStoreSnapshot } from './instore-catalog.js';
import { assertLedgerIdentity } from './ledger-identity.js';
import { inspectSnapshot, assertRestorableSnapshot } from './backup-metadata.js';

const config = readConfig();
const checks = [];
const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
const nodeParts = process.versions.node.split('.').map(Number);
add('Node.js 22.13+', nodeParts[0] > 22 || (nodeParts[0] === 22 && nodeParts[1] >= 13), process.versions.node);
add('Application version', true, APP_VERSION);
add('Mode', ['demo', 'staging', 'live'].includes(config.mode), config.mode);
add('POS listener', true, `${config.bindHost}:${config.port}${config.bindHost === '127.0.0.1' ? ' (host-local only)' : ' (isolate within a container/network)'}`);
add('HTTPS store URL', config.storeUrl.startsWith('https://'), config.storeUrl);
add('Production public origin', !config.production || config.mode === 'demo' || Boolean(config.publicOrigin), config.publicOrigin || 'not set');
const exampleHost = origin => origin && new URL(origin).hostname.endsWith('.example');
add('Example hostnames replaced', config.mode === 'demo' || (!exampleHost(config.storeUrl) && !exampleHost(config.publicOrigin)),
  config.mode === 'demo' ? 'isolated demo' : 'replace .example URLs before connecting a store');
add('Production build', !config.production || fs.existsSync(path.resolve('dist/index.html')), 'dist/index.html');
add('Data directory', (() => { try { fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 }); fs.accessSync(config.dataDir, fs.constants.W_OK); return true; } catch { return false; } })(), config.dataDir);
const ledgerPath = path.join(config.dataDir, `pos-${config.mode}.db`);
let identityIssue = '';
let ledgerLabel = 'new ledger; identity assigned on first start (not a trading approval)';
if (fs.existsSync(ledgerPath)) {
  try {
    const info = inspectSnapshot(ledgerPath);
    assertLedgerIdentity(info, config);
    if (info.version >= 3 && (!info.counts || info.foreignKeyViolations)) {
      throw new Error('POS ledger has a missing sales table or orphan references. Preserve it for isolated review.');
    }
    assertRestorableSnapshot(ledgerPath, info.version);
    ledgerLabel = `${info.service}; schema ${info.version}; UUID ${info.ledgerId}`;
  } catch (error) { identityIssue = error.message; }
}
add('POS ledger service identity', !identityIssue, identityIssue || ledgerLabel);
add('WooCommerce credentials', config.mode === 'demo' || config.configured, config.configured ? 'configured' : 'missing');
add('Staging approval', config.mode !== 'staging' || !config.writesEnabled || process.env.POS_STAGING_APPROVED === 'true', config.writesEnabled ? 'writes enabled' : 'writes locked');
add('Live approval', config.mode !== 'live' || !config.writesEnabled || (process.env.POS_ALLOW_LIVE_WRITES === 'true' && config.approvalReference.length >= 8), config.writesEnabled ? 'writes enabled' : 'writes locked');
add('Live catalogue pilot', !config.liveReadOnly || (!config.writesEnabled && !config.wholesaleWritesEnabled && !config.inStoreCashEnabled && config.mode === 'live'),
  config.liveReadOnly ? 'Woo catalogue and verified physical-source reads only; all three checkout gates locked' : 'not requested');
add('Separate wholesale gate', true, config.mode === 'demo' ? 'isolated demo only' : config.wholesaleWritesEnabled ? 'wholesale writes enabled; verify documented tax/stock/recovery acceptance and written approval' : 'wholesale checkout locked');
add('One-till offline setup', !config.desktopSetupEnabled || config.mode === 'live' && !config.liveReadOnly && config.writesEnabled && config.desktopDeviceMasterSecret.length >= 32,
  config.desktopSetupEnabled ? 'explicit setup gate enabled; plugin and real stock allocation remain UNVERIFIED' : 'enrollment and allocation disabled');
add('Offline selling', !config.desktopEnabled || config.desktopSetupEnabled && !config.liveReadOnly,
  config.desktopEnabled ? 'explicit selling gate enabled; NOT evidence of witnessed Woo last-unit, order or Windows acceptance' : 'desktop shared-stock checkout locked');
let physicalStock;
if (config.mode === 'live') {
  try { physicalStock = loadInStoreSnapshot();
    add('In-store CSV / PDF source', true, `${physicalStock.summary.items} products; ${physicalStock.summary.needsReview} quarantined; SHA-256 ${physicalStock.manifestHash}`);
  } catch (error) { add('In-store CSV / PDF source', false, error.message); }
  add('Separate in-store cash gate', !config.inStoreCashEnabled || physicalStock?.manifestHash === config.inStoreSourceHash,
    config.inStoreCashEnabled ? 'cash gate approved separately; pinned source must match and shift is mandatory' : 'in-store checkout locked; physical catalogue only');
}
add('Live payment scope', config.mode !== 'live' || config.paymentMethods.length === 1 && config.paymentMethods[0] === 'cash',
  config.mode === 'live' ? 'cash only; MoMo/card/Paystack POS recording is disabled' : 'non-live payment methods');
let existingOwner = false;
let restoredAccountsLocked = false;
if (config.mode !== 'demo') {
  const ledger = path.join(config.dataDir, `pos-${config.mode}.db`);
  if (fs.existsSync(ledger)) {
    let db;
    try {
      db = new DatabaseSync(ledger, { readOnly: true });
      restoredAccountsLocked = Boolean(db.prepare("SELECT 1 FROM app_meta WHERE key='restored_accounts_locked'").get());
      existingOwner = Boolean(db.prepare("SELECT 1 FROM users WHERE role='owner' AND active=1 LIMIT 1").get());
    } catch { existingOwner = false; }
    finally { db?.close(); }
  }
}
add('Restored account recovery', config.mode === 'demo' || !restoredAccountsLocked,
  restoredAccountsLocked ? 'all restored accounts are disabled; stop and use the separately approved offline owner-recovery procedure' : 'no restore account lock');
const bootstrapReady = Boolean(config.ownerUsername && config.ownerPassword && !passwordProblem(config.ownerPassword, config.ownerUsername));
add('Owner bootstrap secret policy', config.mode === 'demo' || !config.ownerPassword || bootstrapReady,
  config.mode === 'demo' ? 'not required' : !config.ownerPassword ? 'no bootstrap secret retained' : bootstrapReady ? 'valid temporary secret configured' : 'replace or remove invalid bootstrap secret');
add('Owner sign-in available', config.mode === 'demo' || !restoredAccountsLocked && (existingOwner || bootstrapReady),
  config.mode === 'demo' ? 'demo owner' : restoredAccountsLocked ? 'restore lock forbids owner bootstrap and sign-in' : existingOwner ? 'active owner in ledger' : bootstrapReady ? 'valid bootstrap credentials configured' : 'configure a valid owner username/password before first start');
add('Shift accountability', true, config.requireShift ? 'required' : 'optional');
add('Session idle timeout', true, `${config.sessionIdleMinutes} minutes`);
const failed = checks.filter(c => !c.ok);
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
console.log(failed.length ? `\n${failed.length} preflight check(s) failed.` : '\nPreflight passed. Live checkout still requires separate acceptance and written owner approval.');
process.exit(failed.length ? 1 : 0);
