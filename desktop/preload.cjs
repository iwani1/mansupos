const { contextBridge, ipcRenderer } = require('electron');

// This is the ONLY surface exposed to the bundled renderer. No Node globals,
// raw IPC, filesystem, shell, Woo credentials, or generic remote fetch.
contextBridge.exposeInMainWorld('mansuDesktop', Object.freeze({
  request: async (path, method = 'GET', body) => {
    const reply = await ipcRenderer.invoke('mansu:request', { path, method, body });
    if (reply.ok) return reply.data;
    const error = new Error(reply.error.message);
    error.code = reply.error.code;
    error.status = reply.error.status;
    throw error;
  },
  updates: async action => {
    const reply = await ipcRenderer.invoke('mansu:updates', action);
    if (reply.ok) return reply.data;
    throw new Error(reply.error.message);
  },
  onImages: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('mansu:images', listener);
    return () => ipcRenderer.removeListener('mansu:images', listener);
  },
}));
