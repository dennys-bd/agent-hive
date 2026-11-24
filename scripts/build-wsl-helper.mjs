// The distro's helper (#941) as one ES module, dist/wsl-helper.mjs, whose only imports are node: modules: #945 copies it into a distro,
// which has no node_modules. vite's own build() with no config file: vite.config.ts is the dashboard's.
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HELPER_FILE = 'wsl-helper.mjs';

// outDir: dist by default; a test hands a temp folder of its own, so two test files never build into one file at once
export async function buildWslHelper(outDir = 'dist') {
  await build({
    root: ROOT,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      ssr: 'src/wsl/helper-main.ts',
      outDir,
      emptyOutDir: false, // dist already holds tsc's output and the dashboard
      target: 'node24',
      minify: false,
      sourcemap: false,
      rolldownOptions: {
        external: [/^node:/],
        output: { format: 'es', entryFileNames: HELPER_FILE },
      },
    },
    ssr: { target: 'node', noExternal: true }, // every relative module inlined; only node: stays an import
  });
}

if (import.meta.main) await buildWslHelper(process.argv[2]);
