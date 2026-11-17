// Restore drill: prove that a backup can actually be opened and used, on ANY
// machine, without touching a running POS. It copies the snapshot and its
// manifest into a fresh private temp folder, checks the copy (SQLite
// integrity, manifest checksum and identity, required schema) and prints what
// the backup contains. It never writes to the original files, never reads the
// POS settings file and never replaces a ledger: use server/restore.js for that.
//
//   node server/restore-drill.js /path/to/pos-live-....db
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from './db.js';
import { inspectSnapshot, verifyManifest, assertRestorableSnapshot } from './backup-metadata.js';

export async function runRestoreDrill(file, { keep = false } = {}) {
  if (!file) throw new Error('Usage: npm run restore-drill -- /path/to/pos-live-DATE.db');
  const source = path.resolve(file);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Backup file not found: ${source}`);
  const manifest = `${source}.manifest.json`;
  if (!fs.existsSync(manifest)) throw new Error('The matching .manifest.json file is missing. Copy the .db and its .db.manifest.json together.');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-pos-restore-drill-'));
  try {
    fs.chmodSync(workDir, 0o700);
    const copy = path.join(workDir, path.basename(source));
    fs.copyFileSync(source, copy);
    fs.copyFileSync(manifest, `${copy}.manifest.json`);

    const info = inspectSnapshot(copy);
    if (info.version < 1 || info.version > SCHEMA_VERSION) throw new Error(`Backup schema v${info.version} is not supported by this code (v${SCHEMA_VERSION}).`);
    const saved = await verifyManifest(copy, info);
    assertRestorableSnapshot(copy, info.version);
    if (info.foreignKeyViolations) throw new Error(`Backup has ${info.foreignKeyViolations} foreign-key violation(s).`);

    const db = new DatabaseSync(copy, { readOnly: true });
    let contents;
    try {
      const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
      const count = name => hasTable(name) ? db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n : null;
      const sales = hasTable('sales') ? db.prepare(`SELECT COUNT(*) AS n,
        COALESCE(SUM(CASE WHEN status IN ('paid','partially_refunded','refunded') THEN total END),0) AS paidTotal,
        MAX(created_at) AS lastSaleAt FROM sales`).get() : null;
      contents = {
        sales: sales?.n ?? null, paidTotalPesewas: sales?.paidTotal ?? null, lastSaleAt: sales?.lastSaleAt ?? null,
        shifts: count('shifts'), cashMovements: count('cash_movements'), users: count('users'), auditEntries: count('audit'),
      };
    } finally { db.close(); }

    return {
      ok: true, backup: source, createdAt: saved?.createdAt ?? null,
      mode: info.mode, service: info.service || null, ledgerId: info.ledgerId || null, schemaVersion: info.version,
      pending: info.counts?.pending ?? null, contents, workDir: keep ? workDir : null,
    };
  } finally {
    if (!keep) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runRestoreDrill(process.argv[2], { keep: process.argv.includes('--keep') });
    const c = result.contents;
    console.log([
      'RESTORE DRILL PASSED — this backup opens, matches its manifest and has the full schema.',
      `  Backup taken:   ${result.createdAt ?? 'unknown'}`,
      `  Ledger:         ${result.service ?? result.mode} · schema v${result.schemaVersion} · ${result.ledgerId ?? 'no id'}`,
      `  Sales:          ${c.sales} (last at ${c.lastSaleAt ?? 'none'}); paid total GHS ${((c.paidTotalPesewas ?? 0) / 100).toFixed(2)}`,
      `  Unfinished:     ${result.pending ?? 0} sale(s) awaiting payment or reconciliation`,
      `  Shifts:         ${c.shifts}, cash movements ${c.cashMovements}, staff accounts ${c.users}, audit entries ${c.auditEntries}`,
      result.workDir ? `  Checked copy kept in ${result.workDir} (delete it when done).` : '  The checked copy was deleted; the original files were not changed.',
      'Compare the last sale and paid total with the POS Sales screen for the same time.',
    ].join('\n'));
  } catch (error) {
    console.error(`RESTORE DRILL FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
