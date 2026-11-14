// Explicit OFFLINE access recovery after an approved POS ledger restore.
// Never invoked by normal startup, preflight or the restore itself. The POS
// service must be stopped. Select an existing owner using independent evidence
// and give them a NEW temporary password from a private 0600 file, not argv.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readConfig } from './config.js';
import { hashPassword, passwordProblem } from './passwords.js';
import { SCHEMA_VERSION } from './db.js';
import { assertLedgerIdentity } from './ledger-identity.js';
import { inspectSnapshot, assertRestorableSnapshot } from './backup-metadata.js';
import { acquireInstanceLease } from './instance-lease.js';

const DISABLED_HASH = '!disabled-after-restore';
const LOCK_KEY = 'restored_accounts_locked';

function privatePassword(file, config, username) {
  if (!path.isAbsolute(file)) throw new Error('Use an absolute path to a private owner password file, outside the checkout and POS data directory.');
  const inside = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
  const actual = fs.realpathSync(file); // Also catch a symlinked parent directory.
  const checkout = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (inside(actual, checkout) || inside(actual, fs.realpathSync(config.dataDir))) {
    throw new Error('The owner password file must not be inside the checkout or POS data/backups.');
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.size < 12 || before.size > 258 || (before.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new Error('The owner password file must be a regular, private 0600 file owned by the recovery operator.');
  }
  // O_NOFOLLOW plus an inode check prevents a swapped symlink between stat
  // and open. Nothing from the file is printed or passed on the command line.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || (opened.mode & 0o077) !== 0) {
      throw new Error('The owner password file changed during recovery.');
    }
    const password = fs.readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (/[\r\n\0]/.test(password)) throw new Error('The owner password file must contain exactly one password line.');
    const problem = passwordProblem(password, username);
    if (problem) throw new Error(`New owner password policy: ${problem}`);
    return password;
  } finally { fs.closeSync(fd); }
}

process.umask(0o077);
const config = readConfig();
const [flag, enteredUsername, passwordFile] = process.argv.slice(2);
if (config.mode === 'demo' || process.argv.length !== 5 || flag !== '--confirm-restored-owner' ||
    !enteredUsername || enteredUsername.length > 80 || !passwordFile) {
  throw new Error('Usage (approved offline maintenance only): node server/recover-restored-owner.js --confirm-restored-owner OWNER_USERNAME /private/new-owner-password-file');
}
const username = enteredUsername.trim().toLowerCase();
if (!username) throw new Error('Choose an existing, independently verified owner account from the restored ledger.');
const file = path.join(config.dataDir, `pos-${config.mode}.db`);
if (!fs.existsSync(file)) throw new Error('The restored POS ledger is missing; no account was changed.');
const lease = acquireInstanceLease(config);
try {
  const info = inspectSnapshot(file);
  if (info.version < 3 || info.version > SCHEMA_VERSION || !info.counts || info.foreignKeyViolations) {
    throw new Error('Restored ledger schema or references are incomplete. No account was changed.');
  }
  assertLedgerIdentity(info, config, { existing: config.mode === 'live' || info.version >= 9 });
  assertRestorableSnapshot(file, info.version);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT value FROM app_meta WHERE key=?').get(LOCK_KEY)?.value !== '1' ||
          db.prepare('SELECT 1 FROM sessions LIMIT 1').get() ||
          db.prepare('SELECT 1 FROM users WHERE active<>0 OR password_hash<>? OR must_change_password<>1 LIMIT 1').get(DISABLED_HASH)) {
        throw new Error('Restored account lock is missing or incomplete. No accounts were reactivated; review this ledger offline.');
      }
      const owner = db.prepare("SELECT id FROM users WHERE username=? AND role='owner' AND active=0").get(username);
      if (!owner) throw new Error('No matching disabled owner exists in the restored ledger. No account was changed.');
      const password = privatePassword(passwordFile, config, username);
      db.prepare('UPDATE users SET password_hash=?,active=1,must_change_password=1,failed_attempts=0,locked_until=NULL WHERE id=?')
        .run(hashPassword(password), owner.id);
      db.prepare('DELETE FROM app_meta WHERE key=?').run(LOCK_KEY);
      db.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES (?,?,?,?)')
        .run('system', 'ledger.owner_recovered', owner.id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
  console.log('Offline owner recovery completed. Only the selected owner was reactivated with a new temporary password; all other accounts remain disabled and old passwords unusable. Privately remove the password file, change the owner password on first login, review Woo/cash/stock, then individually reset and authorize staff accounts before any approved selling.');
} finally { lease.release(); }
