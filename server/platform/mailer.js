import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Platform email (sign-up confirmation, welcome, billing reminders).
//   resend - sends through Resend's HTTPS API (PLATFORM_RESEND_API_KEY,
//            PLATFORM_MAIL_FROM on a domain verified in Resend)
//   outbox - writes each message to <data>/outbox/ for `npm run platform --
//            outbox` (development, or a pilot before email is set up)
export function createMailer(config, logger, fetchImpl = fetch) {
  if (config.mailDriver === 'resend') {
    return {
      driver: 'resend',
      async send({ to, subject, text }) {
        let response;
        try {
          response = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text, ...(config.mailReplyTo ? { reply_to: config.mailReplyTo } : {}) }),
          });
        } catch { throw new Error('The email service could not be reached.'); }
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          logger.error({ msg: 'platform.mail_failed', driver: 'resend', status: response.status, reason: String(body?.message || '').slice(0, 160) });
          throw new Error(`The email was not accepted (HTTP ${response.status}).`);
        }
        logger.info({ msg: 'platform.mail_sent', driver: 'resend', subject });
      },
      list: () => [],
    };
  }
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
