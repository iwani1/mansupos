const { contextBridge, ipcRenderer } = require('electron');

const allowed = new Set([
  'GET /api/session', 'GET /api/catalog', 'GET /api/sales', 'GET /api/desktop/status',
  'POST /api/trial/start', 'POST /api/auth/logout', 'POST /api/trial/connectivity',
  'POST /api/sales/prepare', 'POST /api/trial/sync', 'POST /api/trial/refresh', 'POST /api/trial/backup',
]);
function request({ path, method = 'GET', body } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.length > 180 ||
      !(allowed.has(`${method} ${path}`) ||
        (method === 'POST' && /^\/api\/sales\/[0-9a-f-]{36}\/pay$/.test(path)) ||
        (method === 'GET' && /^\/api\/sales\/[0-9a-f-]{36}$/.test(path)))) {
    return Promise.reject(new Error('Not an available practice operation.'));
  }
  return ipcRenderer.invoke('practice:request', { path, method, body });
}
contextBridge.exposeInMainWorld('mansuPractice', Object.freeze({
  request,
  print: saleId => ipcRenderer.invoke('practice:print', saleId),
}));
