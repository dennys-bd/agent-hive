#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MISSING_BUILD = 2;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = join(root, 'dist', 'src', 'main.js');
const repo = resolve(process.argv[2] ?? process.cwd());

if (!existsSync(mainJs)) {
  console.error(`${mainJs} não existe: rode \`pnpm build\` primeiro`);
  process.exit(MISSING_BUILD);
}

// the electron package exports the path of its binary; required lazily so the check above runs without it
const electronPath = createRequire(import.meta.url)('electron');
const child = spawn(electronPath, [mainJs, repo], { stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`não consegui iniciar o Electron: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
