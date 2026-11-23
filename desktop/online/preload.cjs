'use strict';

// The till's only bridge into the POS page: print the receipt that is on
// screen. No file, network, settings or Node access is exposed; the main
// process decides the printer and checks the request came from the POS.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mansuTill', Object.freeze({
  printReceipt: () => ipcRenderer.invoke('mansu-till:print-receipt'),
}));
