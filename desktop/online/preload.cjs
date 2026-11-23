'use strict';

// The till's only bridge into the POS page: print the receipt that is on
// screen, and tell the till a just-paid sale's receipt is showing (it prints
// it if auto-print is on). No file, network, settings or Node access is exposed; the main
// process decides the printer and checks the request came from the POS.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mansuTill', Object.freeze({
  printReceipt: () => ipcRenderer.invoke('mansu-till:print-receipt'),
  receiptReady: saleId => ipcRenderer.invoke('mansu-till:receipt-ready', String(saleId).slice(0, 100)),
}));
