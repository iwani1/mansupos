import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './studio.css';

const root = createRoot(document.getElementById('root'));
if (window.mansuDesktop) {
  import('./DesktopApp.jsx').then(({ default: DesktopApp }) => root.render(<React.StrictMode><DesktopApp /></React.StrictMode>));
} else root.render(<React.StrictMode><App /></React.StrictMode>);

// Browser PWA stays a notice only. Never register its worker inside Electron.
if (!window.mansuDesktop && import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  }, { once: true });
}
