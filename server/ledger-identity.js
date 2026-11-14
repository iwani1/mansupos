import { randomUUID } from 'node:crypto';

// The service class is derived from the locked runtime flags, not a value
// copied from an env file or from the backup being restored. Pilot and trading
// have the same historical POS_MODE and filename, but must NEVER share a ledger.
export function serviceIdentity(config) {
  return config.mode === 'live' ? (config.liveReadOnly ? 'live-pilot' : 'live-trading') : config.mode;
}

export function ledgerInfo(db) {
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const meta = hasTable('app_meta') ? key => db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value || '' : () => '';
  return {
    mode: meta('mode'), service: meta('service_identity'), ledgerId: meta('ledger_uuid'),
    version: hasTable('schema_migrations') ? db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get().v : 0,
  };
}

export function assertLedgerIdentity(info, config, { existing = true } = {}) {
  if (info.mode && info.mode !== config.mode) throw new Error('POS ledger mode does not match this service. Do not reuse a demo or pilot ledger for trading.');
  if (info.service && info.service !== serviceIdentity(config)) throw new Error('POS ledger service identity does not match this service. Pilot and trading ledgers must stay separate.');
  if (info.version >= 9 && (!info.mode || !info.service || !info.ledgerId)) {
    throw new Error('POS ledger v9 is missing its bound mode/service/UUID. Stop; do not infer a replacement identity or migrate this ledger.');
  }
  if (existing && !info.mode) {
    throw new Error('Existing POS ledger has no recorded mode. Stop: preserve it for isolated review; do not infer demo/staging/live from its filename.');
  }
  if (existing && config.mode === 'live' && (!info.service || !info.ledgerId)) {
    throw new Error('Existing live POS ledger has no bound pilot/trading identity. Stop: review a verified backup and bind this specific legacy ledger separately before an upgrade or restore.');
  }
  if (Boolean(info.service) !== Boolean(info.ledgerId) ||
      (info.ledgerId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(info.ledgerId))) {
    throw new Error('POS ledger identity is incomplete or invalid. Do not start this service.');
  }
}

export function initializeLedgerIdentity(db, config) {
  const info = ledgerInfo(db);
  // Never overwrite an existing identity. A restore must retain the original
  // ledger UUID, so a different service or a different same-mode ledger fails.
  assertLedgerIdentity(info, config, { existing: false });
  if (Boolean(info.service) !== Boolean(info.ledgerId)) throw new Error('POS ledger identity is incomplete.');
  const add = db.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES (?,?)');
  add.run('service_identity', serviceIdentity(config));
  add.run('ledger_uuid', randomUUID());
  const bound = ledgerInfo(db);
  assertLedgerIdentity(bound, config);
  return bound;
}
