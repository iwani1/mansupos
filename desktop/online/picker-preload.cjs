'use strict';

// The shop picker's only bridge: read the platform domain, and ask the main
// process to check and save a shop address. No file, network or Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mansuTillSetup', Object.freeze({
  info: () => ipcRenderer.invoke('till-setup:info'),
  choose: address => ipcRenderer.invoke('till-setup:choose', String(address || '').slice(0, 200)),
}));
