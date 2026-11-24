import fs from 'node:fs';
import path from 'node:path';

// One process at a time owns the platform's data folder: the running server,
// or a restore. The lock file holds the owner's process id and purpose; a lock
// left by a process that has died is taken over.
// A lock from before the last reboot is always stale (its process id may now
// belong to something else).
const bootId = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; } };
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

export function readLock(dataDir) {
  try {
    const held = JSON.parse(fs.readFileSync(path.join(dataDir, 'platform.lock'), 'utf8'));
    if (held.boot && held.boot !== bootId()) return null;
    return Number.isInteger(held.pid) && alive(held.pid) ? held : null;
  } catch { return null; }
}

export function acquireLock(dataDir, purpose) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'platform.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, purpose, since: new Date().toISOString(), boot: bootId() }), { flag: 'wx', mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file); } catch { /* already gone */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const held = readLock(dataDir);
      if (held) throw new Error(`The platform data folder is in use by process ${held.pid} (${held.purpose}, since ${held.since}). Stop it first.`, { cause: error });
      fs.rmSync(file, { force: true }); // stale: its process has ended
    }
  }
  throw new Error('Could not lock the platform data folder.');
}
