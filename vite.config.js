import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', allowedHosts: true },
  // The installed app uses a private app:// origin and relative asset paths.
  // Ordinary web/live builds retain their existing root-relative URLs.
  base: process.env.MANSU_DESKTOP_BUILD === '1' ? './' : '/',
  build: { outDir: 'dist', sourcemap: false },
});
