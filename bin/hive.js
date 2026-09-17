#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MISSING_BUILD = 2;
const MISSING_REPO = 2;
const BAD_CONFIG = 2;
// mirrors DEFAULT_CONFIG.port in src/config.ts
const DEFAULT_PORT = 47821;
const PORT_CHECK_TIMEOUT_MS = 1000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = join(root, 'dist', 'src', 'main.js');
const repo = resolve(process.argv[2] ?? process.cwd());

if (!existsSync(repo) || !statSync(repo).isDirectory()) {
  console.error(`diretório não encontrado: ${repo}`);
  process.exit(MISSING_REPO);
}

if (!existsSync(mainJs)) {
  console.error(`${mainJs} não existe: rode \`pnpm build\` primeiro`);
  process.exit(MISSING_BUILD);
}

// the electron package exports the path of its binary; required lazily so the check above runs without it
let electronPath;
try {
  electronPath = createRequire(import.meta.url)('electron');
} catch {
  console.error(`electron não encontrado: rode \`pnpm install\` em ${root}`);
  process.exit(1);
}

function readConfiguredPort() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(repo, 'hive.config.json'), 'utf8'));
  } catch {
    // missing or unparsable file: the app itself reports it on boot; the probe just uses the default
    return DEFAULT_PORT;
  }
  if (raw.port === undefined) return DEFAULT_PORT;
  // same rule as requireInt in src/config.ts, so a bad port fails here instead of probing the wrong one
  if (!Number.isInteger(raw.port) || raw.port < 0) {
    console.error('hive.config.json: "port" must be a non-negative integer');
    process.exit(BAD_CONFIG);
  }
  return raw.port;
}

const port = readConfiguredPort();

async function checkRunningInstance() {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/setup`, { signal: AbortSignal.timeout(PORT_CHECK_TIMEOUT_MS) });
  } catch (err) {
    // only a refused connection means the port is free; a timeout or reset means someone holds it
    if (err?.cause?.code === 'ECONNREFUSED') return;
    console.error(`porta ${port} em uso e sem resposta (veja: lsof -i :${port})`);
    process.exit(1);
  }
  const body = await res.json().catch(() => undefined);
  if (body && typeof body.repo === 'string') {
    // no terminal escapes from a stranger on the port
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    const shownRepo = body.repo.replace(/[\x00-\x1f\x7f]/g, '');
    console.log(`Agent Hive já está rodando em http://127.0.0.1:${port} (repo: ${shownRepo})`);
    process.exit(0);
  }
  console.error(`porta ${port} em uso por outro processo (veja: lsof -i :${port})`);
  process.exit(1);
}

await checkRunningInstance();

// detach: keep the Hive and its workers alive after the launching terminal closes
const hiveDir = join(repo, '.hive');
const logPath = join(hiveDir, 'hive.log');
let fd;
try {
  mkdirSync(hiveDir, { recursive: true, mode: 0o700 });
  fd = openSync(logPath, 'a', 0o600); // the log is only for this user
} catch (err) {
  console.error(`não consegui abrir ${logPath}: ${err.message}`);
  process.exit(1);
}

const child = spawn(electronPath, [mainJs, repo], {
  detached: true,
  stdio: ['ignore', fd, fd],
  env: process.env, // inherit PATH so `claude` and `gh` resolve
});
child.on('error', (err) => {
  console.error(`não consegui iniciar o Electron: ${err.message}`);
  process.exit(1);
});
child.on('spawn', () => {
  closeSync(fd);
  console.log(`Agent Hive iniciado (pid ${child.pid}, log: ${logPath})`);
  child.unref();
});
