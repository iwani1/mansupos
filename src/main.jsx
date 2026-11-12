import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './studio.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);

// Installability is optional. A service worker caches only the public offline
// notice; authenticated pages, Woo stock and all /api requests stay network-only.
if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  }, { once: true });
}
