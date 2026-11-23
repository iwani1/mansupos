import fs from 'node:fs';
import path from 'node:path';
import { computeAccess } from './billing.js';
import { backupPlatform } from './backup.js';

// Hourly platform jobs: billing reminder emails (each sent once) and the daily
// backup with retention.
const DAY = 86400000;
const day = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Accra' });

export function remindersDue(shop, access, now = Date.now()) {
  const until = access.until ? Date.parse(access.until) : null;
  if (!until || shop.status !== 'active') return [];
  const left = until - now;
  if (access.state === 'trial' && left <= DAY) return [{ key: `trial-1:${access.until}`, subject: `Your Mansu POS trial ends tomorrow`, text: `The free trial for ${shop.name} ends on ${day(access.until)}.` }];
  if (access.state === 'trial' && left <= 3 * DAY) return [{ key: `trial-3:${access.until}`, subject: `Your Mansu POS trial ends in 3 days`, text: `The free trial for ${shop.name} ends on ${day(access.until)}.` }];
  if (access.state === 'active' && !access.autoRenew && left <= 5 * DAY) return [{ key: `renew-5:${access.until}`, subject: `Mansu POS: payment due on ${day(access.until)}`, text: `${shop.name} is paid until ${day(access.until)}.` }];
  if (access.state === 'grace') return [{ key: `grace:${access.until}`, subject: `Mansu POS: payment overdue for ${shop.name}`, text: `Payment for ${shop.name} was due on ${day(access.until)}. Selling stops on ${day(access.graceUntil)} unless it is paid.` }];
  if (access.state === 'lapsed' && now - Date.parse(access.graceUntil) < 3 * DAY) return [{ key: `lapsed:${access.graceUntil}`, subject: `Mansu POS: sales paused for ${shop.name}`, text: `Sales and website changes for ${shop.name} are paused. Sign-in, reports and history are still open, and nothing has been deleted.` }];
  return [];
}

export async function runReminders({ registry, config, mailer, logger, now = Date.now() }) {
  let sent = 0;
  for (const shop of registry.list()) {
    if (!shop.owner.email) continue;
    const access = computeAccess(shop, { now, graceDays: config.graceDays });
    for (const reminder of remindersDue(shop, access, now)) {
      if (!registry.billingEvent({ key: `reminder:${shop.id}:${reminder.key}`, shopId: shop.id, kind: 'reminder', detail: reminder.subject })) continue;
      try {
        await mailer.send({ to: shop.owner.email, subject: reminder.subject,
          text: `Hello ${shop.owner.name || ''},\n\n${reminder.text}\n\nChoose a plan or pay: ${config.shopOrigin(shop.slug)}/ (sign in as the owner, then Billing).\nQuestions? Reply to this email.\n\nMansu POS` });
        sent++;
      } catch (error) {
        // Allow a retry next hour: forget the event if the email did not go.
        registry.db.prepare('DELETE FROM billing_events WHERE event_key=?').run(`reminder:${shop.id}:${reminder.key}`);
        logger.error({ msg: 'platform.reminder_failed', shop: shop.slug, reason: error.message });
      }
    }
  }
  return sent;
}

export function pruneBackups(dir, keepDays, now = Date.now()) {
  if (!fs.existsSync(dir)) return [];
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    // Only folders this job made: <ISO time>-<id> with a manifest inside.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}$/.test(name)) continue;
    const full = path.join(dir, name);
    if (!fs.existsSync(path.join(full, 'manifest.json'))) continue;
    const taken = Date.parse(name.slice(0, 24).replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3'));
    if (Number.isFinite(taken) && now - taken > keepDays * DAY) { fs.rmSync(full, { recursive: true, force: true }); removed.push(name); }
  }
  return removed;
}

export async function runScheduledBackup({ registry, config, logger, now = Date.now() }) {
  if (!config.backupHours) return null;
  const last = Number(registry.setting('last_backup_at') || 0);
  if (now - last < config.backupHours * 3600000) return null;
  const { dir, manifest } = await backupPlatform(config, registry, config.backupDir);
  registry.setSetting('last_backup_at', String(now));
  const removed = pruneBackups(config.backupDir, config.backupKeepDays, now);
  logger.info({ msg: 'platform.backup_done', shops: manifest.shops.length, removed: removed.length });
  return dir;
}
