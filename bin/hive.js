#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MISSING_BUILD = 2;
const USAGE = 2;
const BAD_HOME = 2;
const HOME_MODE = 0o700; // the home holds the log, the prompts and the credentials
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = join(root, 'dist', 'src', 'main.js');
const daemonJs = join(root, 'dist', 'src', 'daemon.js');
const homeJs = join(root, 'dist', 'src', 'home.js');
const loginJs = join(root, 'dist', 'src', 'login.js');
// `hive`, `hive stop` or `hive login [provider]`: one Hive per home (#202), so there is no folder to name
const [first, ...rest] = process.argv.slice(2);

if (first === 'login') {
  if (!existsSync(loginJs)) {
    console.error(`${loginJs} não existe: rode \`pnpm build\` primeiro`);
    process.exit(MISSING_BUILD);
  }
  const { runLogin } = await import(pathToFileURL(loginJs).href);
  process.exit(await runLogin(rest[0]));
}

const isStop = first === 'stop';
if ((first !== undefined && !isStop) || rest.length > 0) {
  console.error('uso: hive | hive stop | hive login [provider]');
  process.exit(USAGE);
}

for (const built of [daemonJs, homeJs]) {
  if (!existsSync(built)) {
    console.error(`${built} não existe: rode \`pnpm build\` primeiro`);
    process.exit(MISSING_BUILD);
  }
}

// the launcher and the home are the build's: hive.port lookup, probe, start with the wait, stop.
const daemon = await import(pathToFileURL(daemonJs).href);
const { hiveHome } = await import(pathToFileURL(homeJs).href);
let home;
try {
  home = hiveHome();
} catch (err) {
  console.error(err.message); // a relative HIVE_HOME (#310) is a usage error
  process.exit(BAD_HOME);
}
const logPath = join(home, 'hive.log');

if (isStop) await stop();
else await start();

async function stop() {
  try {
    const stopped = await daemon.stopDaemon(home);
    console.log(stopped ? 'Agent Hive parado' : 'Agent Hive não está em execução');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

async function start() {
  const electronPath = requireElectron();
  let running;
  try {
    running = await daemon.ensureDaemon(home);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${running.port}`;
  if (running.pid === undefined) console.log(`Agent Hive já está em execução em ${url}, abrindo a janela`);
  else console.log(`Agent Hive iniciado em ${url} (pid ${running.pid}, log: ${logPath})`);
  openViewer(electronPath);
}

// the electron package exports the path of its binary; required lazily so `hive stop` and the checks above run without it
function requireElectron() {
  try {
    return createRequire(import.meta.url)('electron');
  } catch {
    console.error(`electron não encontrado: rode \`pnpm install\` em ${root}`);
    process.exit(1);
  }
}

// detach: the viewer outlives this command; its stdout/stderr join the daemon's in the home's hive.log
function openViewer(electronPath) {
  let fd;
  try {
    mkdirSync(home, { recursive: true, mode: HOME_MODE });
    fd = openSync(logPath, 'a', 0o600); // the log is only for this user
  } catch (err) {
    console.error(`não consegui abrir ${logPath}: ${err.message}`);
    process.exit(1);
  }
  const child = spawn(electronPath, [mainJs], { // no repo: the viewer opens the home's Hive
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env, // inherit PATH (and XDG_CONFIG_HOME / HIVE_HOME, #310) so `claude`, `gh` and the same home resolve in a daemon the viewer may start
  });
  child.on('error', (err) => {
    console.error(`não consegui iniciar o Electron: ${err.message}`);
    process.exit(1);
  });
  child.on('spawn', () => {
    closeSync(fd);
    child.unref();
  });
}
