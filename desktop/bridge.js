import { AppError } from '../server/errors.js';

// Explicit IPC allowlist. The renderer never gets Node, file-system access,
// WordPress credentials, a raw SQLite handle, or a generic HTTP proxy.
export async function desktopDispatch(store, request) {
  const { path, method = 'GET', body } = request || {};
  if (typeof path !== 'string' || path.length > 180 || !path.startsWith('/api/') ||
      !['GET','POST'].includes(method)) throw new AppError('Unsupported desktop request.', 400);
  if (path === '/api/session' && method === 'GET') return store.session();
  if (path === '/api/auth/login' && method === 'POST') return store.login(body);
  if (path === '/api/auth/logout' && method === 'POST') return store.logout();
  if (path === '/api/desktop/connect' && method === 'POST') return store.connect(body);
  if (path === '/api/desktop/refresh' && method === 'POST') return store.refresh();
  if (path === '/api/desktop/allocate' && method === 'POST') return store.allocate(body);
  if (path === '/api/desktop/status' && method === 'GET') return store.queueStatus();
  if (path === '/api/desktop/backup' && method === 'POST') return store.backupLedger();
  if (path === '/api/desktop/sync' && method === 'POST') return store.sync(Boolean(body?.force));
  if (path === '/api/catalog' && method === 'GET') return store.catalog();
  if (path === '/api/wholesale-prices' && method === 'GET') return store.wholesalePrices();
  if (path === '/api/sales' && method === 'GET') return store.sales();
  if (path === '/api/sales/prepare' && method === 'POST') return { sale:store.prepare(body) };
  if (path === '/api/customers' && method === 'GET') return store.customerList();
  if (path === '/api/customers' && method === 'POST') return store.addCustomer(body);
  const pay = /^\/api\/sales\/([0-9a-f-]{36})\/pay$/.exec(path);
  if (pay && method === 'POST') return { sale:store.pay(pay[1],body) };
  const ret = /^\/api\/sales\/([0-9a-f-]{36})\/return$/.exec(path);
  if (ret && method === 'POST') return store.returnSale({ ...body, saleId:ret[1] });
  const sale = /^\/api\/sales\/([0-9a-f-]{36})$/.exec(path);
  if (sale && method === 'GET') return { sale:store.sale(sale[1]) };
  const retry = /^\/api\/desktop\/retry\/([0-9a-f-]{36})$/.exec(path);
  if (retry && method === 'POST') return store.retry(retry[1],body?.reason);
  const stock = /^\/api\/stock\/([1-9]\d*:(?:0|[1-9]\d*))\/movements$/.exec(path);
  if (stock && method === 'GET') return store.movements(stock[1]);
  throw new AppError('This desktop route is not available.', 404, 'DESKTOP_ROUTE_LOCKED');
}
