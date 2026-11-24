// Health and readiness probes (no sign-in).
import { APP_VERSION } from '../config.js';

export function registerSystemRoutes(app, ctx) {
  const { config, db, online } = ctx;
  app.get('/api/health', (req, res) => res.json({ ok: true, mode: config.mode, liveReadOnly: config.liveReadOnly, version: APP_VERSION }));
  app.get('/api/ready', async (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      const issues = [];
      if (config.mode !== 'demo' && !config.configured) issues.push('WooCommerce credentials are not configured.');
      if (config.mode === 'live' && !config.liveReadOnly && !config.writesEnabled) issues.push('Live write gates are disabled.');
      if (config.onlineBridgeLiveEnabled) {
        try { await online.assertLiveBridgeReady(); }
        catch { issues.push('The signed Woo reservation bridge or trading ledger is not verified. Live checkout is not ready.'); }
      }
      res.status(issues.length ? 503 : 200).json({ ok: issues.length === 0, mode: config.mode, liveReadOnly: config.liveReadOnly, version: APP_VERSION, issues });
    } catch { res.status(503).json({ ok: false, error: 'Database is not ready.' }); }
  });
}
