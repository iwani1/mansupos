import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Platform email (sign-up verification, welcome). Until an email provider is
// chosen, the "outbox" driver writes each message to <data>/outbox/ and the
// admin reads it with `npm run platform -- outbox` (fine for an invited pilot,
// not for public sign-up). A provider driver plugs in here with send().
export function createMailer(config, logger) {
  if (config.mailDriver !== 'outbox') throw new Error(`Unknown PLATFORM_MAIL_DRIVER: ${config.mailDriver}`);
  const dir = path.join(config.dataDir, 'outbox');
  return {
    driver: 'outbox',
    async send({ to, subject, text }) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`);
      fs.writeFileSync(file, `${JSON.stringify({ to, subject, text, queuedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      logger.info({ msg: 'platform.mail_queued', driver: 'outbox', subject });
    },
    list(limit = 20) {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort().slice(-limit)
        .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    },
  };
}
