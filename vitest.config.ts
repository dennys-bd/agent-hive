import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/ui', import.meta.url)) } },
  // T4 adds the first test/ui/*.test.tsx file; remove passWithNoTests there (an installed-Vitest exit-1 workaround).
  test: { environment: 'jsdom', include: ['test/ui/**/*.test.tsx'], setupFiles: ['test/ui/setup.ts'], css: false, passWithNoTests: true },
});
