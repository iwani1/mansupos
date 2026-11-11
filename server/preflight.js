import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readConfig, APP_VERSION } from './config.js';
import { passwordProblem } from './db.js';

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
add('WooCommerce credentials', config.mode === 'demo' || config.configured, config.configured ? 'configured' : 'missing');
add('Staging approval', config.mode !== 'staging' || !config.writesEnabled || process.env.POS_STAGING_APPROVED === 'true', config.writesEnabled ? 'writes enabled' : 'writes locked');
add('Live approval', config.mode !== 'live' || !config.writesEnabled || (process.env.POS_ALLOW_LIVE_WRITES === 'true' && config.approvalReference.length >= 8), config.writesEnabled ? 'writes enabled' : 'writes locked');
add('Separate wholesale gate', true, config.mode === 'demo' ? 'isolated demo only' : config.wholesaleWritesEnabled ? 'wholesale writes enabled; confirm staging acceptance and written approval' : 'wholesale checkout locked');
let existingOwner = false;
if (config.mode !== 'demo') {
  const ledger = path.join(config.dataDir, `pos-${config.mode}.db`);
  if (fs.existsSync(ledger)) {
    let db;
    try {
      db = new DatabaseSync(ledger, { readOnly: true });
      existingOwner = Boolean(db.prepare("SELECT 1 FROM users WHERE role='owner' AND active=1 LIMIT 1").get());
    } catch { existingOwner = false; }
    finally { db?.close(); }
  }
}
const bootstrapReady = Boolean(config.ownerUsername && config.ownerPassword && !passwordProblem(config.ownerPassword, config.ownerUsername));
add('Owner bootstrap secret policy', config.mode === 'demo' || !config.ownerPassword || bootstrapReady,
  config.mode === 'demo' ? 'not required' : !config.ownerPassword ? 'no bootstrap secret retained' : bootstrapReady ? 'valid temporary secret configured' : 'replace or remove invalid bootstrap secret');
add('Owner sign-in available', config.mode === 'demo' || existingOwner || bootstrapReady,
  config.mode === 'demo' ? 'demo owner' : existingOwner ? 'active owner in ledger' : bootstrapReady ? 'valid bootstrap credentials configured' : 'configure a valid owner username/password before first start');
add('Shift accountability', true, config.requireShift ? 'required' : 'optional');
add('Session idle timeout', true, `${config.sessionIdleMinutes} minutes`);
const failed = checks.filter(c => !c.ok);
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
console.log(failed.length ? `\n${failed.length} preflight check(s) failed.` : '\nPreflight passed. This does not replace staging acceptance or owner approval.');
process.exit(failed.length ? 1 : 0);
