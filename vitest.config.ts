import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/ui', import.meta.url)) } },
  // monaco-editor ships ESM in .js files with no "type": "module", which Node cannot load: vite transforms it (#668, line-changes.ts)
  test: { environment: 'jsdom', include: ['test/ui/**/*.test.tsx'], setupFiles: ['test/ui/setup.ts'], css: false, pool: 'threads', server: { deps: { inline: ['monaco-editor'] } } },
});
