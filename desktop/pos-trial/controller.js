import { AppError } from '../../server/errors.js';
import { TRIAL_ORIGIN, TRIAL_PASSWORD, TRIAL_USERNAME } from './trial-remote.js';

// A separate allowlist, NOT desktopDispatch: no login with real credentials,
// Woo connection, stock allocation, wholesale, customers or refunds. The
// shared SQLite ledger, checkout and sync algorithms are exercised with only
// fabricated stock and a local fake acknowledgement.
export class TrialController {
  constructor(store, remote) { this.store = store; this.remote = remote; }
  session() {
    let local;
    try { local = this.store.session(); }
    catch (error) {
      if (error.code !== 'OFFLINE_LOGIN_EXPIRED') throw error;
      local = this.store.session(); // The ledger clears only the expired user, not completed events.
    }
    const session = { ...local, config:{ ...local.config, practiceMode:true }, trial:{ simulatedConnection:this.remote.online } };
    delete session.origin;
    delete session.config.storeUrl;
    return session;
  }
  async start() {
    if (!this.store.hasAccount()) {
      await this.store.connect({ origin:TRIAL_ORIGIN, username:TRIAL_USERNAME, password:TRIAL_PASSWORD });
    } else {
      try { this.store.login({ username:TRIAL_USERNAME, password:TRIAL_PASSWORD }); }
      catch (error) {
        if (error.code !== 'OFFLINE_LOGIN_EXPIRED') throw error;
        // Recovery is still entirely local. Pending events keep original IDs
        // and allocations; this does not create a new fake grant or live sale.
        await this.store.connect({ origin:TRIAL_ORIGIN, username:TRIAL_USERNAME, password:TRIAL_PASSWORD });
      }
    }
    return this.session();
  }
  async dispatch(request) {
    const { path, method = 'GET', body } = request || {};
    if (typeof path !== 'string' || path.length > 180 || !path.startsWith('/api/') || !['GET','POST'].includes(method)) {
      throw new AppError('Unsupported practice request.', 400, 'TRIAL_ONLY');
    }
    if (path === '/api/session' && method === 'GET') return this.session();
    if (path === '/api/trial/start' && method === 'POST') return this.start();
    if (path === '/api/auth/logout' && method === 'POST') { this.store.logout(); return this.session(); }
    if (path === '/api/trial/connectivity' && method === 'POST') {
      this.store.requireUser();
      if (typeof body?.connected !== 'boolean' || Object.keys(body).length !== 1) throw new AppError('Select simulated connected or offline.', 400);
      this.remote.setConnected(body.connected);
      return this.session();
    }
    if (path === '/api/catalog' && method === 'GET') return this.store.catalog();
    if (path === '/api/sales' && method === 'GET') return this.store.sales();
    if (path === '/api/desktop/status' && method === 'GET') return this.store.queueStatus();
    if (path === '/api/sales/prepare' && method === 'POST') {
      if (body?.saleType && body.saleType !== 'retail') throw new AppError('Practice checkout is retail only.', 403, 'TRIAL_ONLY');
      return { sale:this.store.prepare(body) };
    }
    const pay = /^\/api\/sales\/([0-9a-f-]{36})\/pay$/.exec(path);
    if (pay && method === 'POST') {
      if (body?.practiceConfirmed !== true) throw new AppError('No real payment is permitted. Confirm this is only a simulated tender.', 403, 'TRIAL_ONLY');
      const payment = { ...body };
      delete payment.practiceConfirmed;
      return { sale:this.store.pay(pay[1], payment) };
    }
    const sale = /^\/api\/sales\/([0-9a-f-]{36})$/.exec(path);
    if (sale && method === 'GET') return { sale:this.store.sale(sale[1]) };
    if (path === '/api/trial/sync' && method === 'POST') return this.store.sync(true);
    if (path === '/api/trial/refresh' && method === 'POST') return this.store.refresh();
    if (path === '/api/trial/backup' && method === 'POST') return this.store.backupLedger();
    throw new AppError('This operation is not available in the isolated POS practice app.', 403, 'TRIAL_ONLY');
  }
}
