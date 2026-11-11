import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// A PID file is unsafe in containers: a restarted container can reuse PID 1,
// and PID 1 in another container is not the same process. SQLite's exclusive
// transaction is a kernel-backed, cross-process lease on the persistent data
// volume; a crash releases it without needing to delete a stale file.
export function acquireInstanceLease(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.dataDir, `pos-${config.mode}.instance.db`);
  const lock = new DatabaseSync(file);
  let acquired = false;
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    acquired = true;
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (acquired) lock.exec('ROLLBACK');
    lock.close();
    if (/database is locked/i.test(error.message)) {
      throw new Error(`Another POS instance or restore is using the ${config.mode} data volume. Stop it before continuing.`, { cause: error });
    }
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try { lock.exec('ROLLBACK'); } finally { lock.close(); }
    },
  };
}
