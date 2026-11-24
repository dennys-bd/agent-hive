import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/ui', import.meta.url)) } },
  // monaco-editor ships ESM in .js files with no "type": "module", which Node cannot load: vite transforms it (#668, line-changes.ts).
  // testTimeout 15 s, not vitest's 5 s (#970): the slowest test measured on windows-vitest is StartDialog's #237 flow at ~10 s, and 15 s
  // leaves room for a loaded local run. A per-test bound would only move the failure to the next slow test.
  test: { environment: 'jsdom', include: ['test/ui/**/*.test.tsx'], setupFiles: ['test/ui/setup.ts'], css: false, pool: 'threads', testTimeout: 15_000, server: { deps: { inline: ['monaco-editor'] } } },
});
