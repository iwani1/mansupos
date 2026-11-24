// WooCommerce connection test and diagnostics (owner only).
import { APP_VERSION } from '../config.js';
import { audit } from '../db.js';
import { ledgerInfo } from '../ledger-identity.js';

export function registerConnectionRoutes(app, ctx) {
  const { config, db, api, products, online, auth, role } = ctx;
  app.post('/api/connection/test', auth, role('owner'), async (req, res) => {
    if (config.mode === 'demo') return res.json({ connected: false, message: 'Demo is isolated from your website. Configure staging credentials on the server to test a real connection.', snapshot: true });
    const result = await api.request('products', { query: { per_page: 1, status: 'publish' } });
    audit(db, req.user.id, 'connection.test', 'read-only');
    res.json({ connected: true, message: 'Authenticated catalogue access confirmed. This test did not create orders or change stock.', productCount: result.total, writesEnabled: config.writesEnabled });
  });
  app.get('/api/connection/diagnostics', auth, role('owner'), async (req, res) => {
    const checks = [
      { name: 'HTTPS store URL', ok: config.storeUrl.startsWith('https://') },
      { name: 'Server-side credentials', ok: config.mode === 'demo' || config.configured, detail: config.mode === 'demo' ? 'Not needed for demo' : config.configured ? 'Configured' : 'Missing' },
      { name: 'Public origin configured', ok: !config.production || Boolean(config.publicOrigin) || config.mode === 'demo' },
      { name: config.liveReadOnly ? 'Live catalogue (read-only)' : 'Checkout availability',
        ok: config.liveReadOnly ? !config.writesEnabled && !config.wholesaleWritesEnabled
          : config.mode === 'demo' || config.writesEnabled,
        detail: config.liveReadOnly ? 'All checkout locked; only catalogue reads are tested'
          : config.mode === 'demo' ? 'Demo only' : config.onlineBridgeEnabled ? 'Bridge profile configured; signed health and last-unit acceptance still required'
          : config.writesEnabled ? 'Woo orders enabled'
          : 'All checkout locked' },
    ];
    if (config.mode !== 'demo' && config.configured) {
      try { const products = await api.request('products', { query: { per_page: 1, status: 'publish' } }); checks.push({ name: 'WooCommerce catalogue read', ok: true, detail: `${products.total} published products` }); }
      catch (error) { checks.push({ name: 'WooCommerce catalogue read', ok: false, detail: error.message }); }
      if (config.productWritesEnabled) {
        const photo = await products.media.check();
        checks.push({ name: 'WordPress photo upload login', ok: photo.ok, detail: photo.detail });
      }
      if (!config.liveReadOnly && config.writesEnabled) {
        try { await api.request('orders', { query: { per_page: 1 } }); checks.push({ name: 'WooCommerce orders read', ok: true }); }
        catch (error) { checks.push({ name: 'WooCommerce orders read', ok: false, detail: error.message }); }
      }
    }
    if (config.onlineBridgeLiveEnabled) {
      // Ordinary product/order GETs cannot verify an installed reservation
      // bridge. Require its signed read-only health and the bound trading UUID.
      try {
        const health = await online.bridge.health();
        const bound = ledgerInfo(db);
        if (bound.service !== 'live-trading' || bound.ledgerId !== health.ledgerId ||
            health.siteId !== config.bridgeSiteId || health.service !== config.bridgeService ||
            health.corePrerequisitesOk !== true || health.cashOnly !== true) throw new Error('Live bridge mismatch');
        checks.push({ name: 'Woo reservation bridge (signed read-only health)', ok: true,
          detail: `Woo ${health.wooVersion}; HPOS ${health.hposEnabled ? 'on' : 'off'}; tax ${health.taxEnabled ? 'on' : 'off'}. Last-unit concurrency remains unverified.` });
      } catch {
        checks.push({ name: 'Woo reservation bridge (signed read-only health)', ok: false,
          detail: 'Installed bridge or v9 ledger binding could not be verified; no live checkout acceptance.' });
      }
    }
    res.json({ mode: config.mode, version: APP_VERSION, checks, ok: checks.every(c => c.ok) });
  });
}
