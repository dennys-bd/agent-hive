import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev only: `pnpm dev` serves src/ui with HMR and forwards the API to a Hive already running (run:headless or hive).
const API_ROUTES = ['/events', '/setup', '/ptys', '/tasks', '/config', '/signal', '/board', '/api'];
const HIVE_PORT = process.env.HIVE_PORT ?? '47821';

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/ui', import.meta.url)) } },
  // One page (#552): the dashboard, which a detached window loads too, in window mode (?window=…). It lands under dist/src/ui, where
  // express.static serves it; tsc writes i18n.js, highlight.js and lib/*.js in the same dir
  build: { outDir: '../../dist/src/ui', emptyOutDir: false },
  server: { proxy: Object.fromEntries(API_ROUTES.map((route) => [route, `http://127.0.0.1:${HIVE_PORT}`])) },
});
