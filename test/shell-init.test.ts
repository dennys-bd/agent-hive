import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { AGENTS } from '../src/agents.js';
import { fishQuote, installShellInit, renderShellInit, SHELL_INIT_FILES, shellQuote } from '../src/shell-init.js';
import { shimPath } from '../src/shim.js';
import { ptyCommand, terminalEnv } from '../src/spawn.js';
import { AGENT_IDS, type PtyLaunch } from '../src/types.js';
import { tempDir } from './temp-dir.js';

const FUNCTION_FILES = ['zsh/.zshrc', 'bash/rc', 'fish/init.fish'];

test('renderShellInit puts one function per shim in the placeholder, the path quoted for the file\'s shell: a quote, a space, $\' and $& stay literal (#259)', () => {
  const shims = [{ command: 'claude', path: `/h/it's $'x' $& "dir"/bin/claude` }, { command: 'codex', path: '/h/bin/codex' }];
  const template = 'before\n__HIVE_FUNCTIONS__\nafter\n';
  const sh = [String.raw`function claude { '/h/it'\''s $'\''x'\'' $& "dir"/bin/claude' "$@"; }`, `function codex { '/h/bin/codex' "$@"; }`];
  const fish = [String.raw`function claude; '/h/it\'s $\'x\' $& "dir"/bin/claude' $argv; end`, 'function codex; \'/h/bin/codex\' $argv; end'];
  for (const file of ['zsh/.zshrc', 'bash/rc']) assert.equal(renderShellInit(template, file, shims), `before\n${sh.join('\n')}\nafter\n`, file);
  assert.equal(renderShellInit(template, 'fish/init.fish', shims), `before\n${fish.join('\n')}\nafter\n`);
  assert.equal(renderShellInit('no placeholder\n', 'zsh/.zshenv', shims), 'no placeholder\n');
});

test('installShellInit writes every init file under <home>/shell/, its folders for this user only, a function per agent of AGENTS calling its shim, no placeholder left, and rewrites them on every boot (#259)', async (t) => {
  const home = await tempDir(t, 'home-');
  const dir = await installShellInit(home);
  assert.equal(dir, join(home, 'shell'));
  for (const file of SHELL_INIT_FILES) assert.doesNotMatch(await readFile(join(dir, file), 'utf8'), /__HIVE_[A-Z]+__/, file);
  for (const file of FUNCTION_FILES) {
    const text = await readFile(join(dir, file), 'utf8');
    for (const id of AGENT_IDS) assert.ok(text.includes(`function ${AGENTS[id].command}`) && text.includes(shimPath(home, AGENTS[id])), `${file}: ${id}`);
  }
  for (const folder of ['', 'zsh', 'bash', 'fish']) assert.equal((await stat(join(dir, folder))).mode & 0o777, 0o700, folder);
  await writeFile(join(dir, 'bash', 'rc'), 'from a previous version');
  await installShellInit(home);
  assert.match(await readFile(join(dir, 'bash', 'rc'), 'utf8'), /function claude \{/, 'upgrading the Hive changes every terminal');
});

const COMMANDS = AGENT_IDS.map((id) => AGENTS[id].command);
const TYPED = COMMANDS.join('; '); // each agent as the user types it: the same line in zsh, bash and fish
const SHIM_RAN = COMMANDS.map((command) => `shim:${command}`);
const RC_RAN = COMMANDS.map((command) => `rc:${command}`);
const RC_LOADED = 'rc:loaded'; // the user's rc file ran
const MARKER = /^(shim|rc):|^(zdotdir|user)=/; // the test's own lines, apart from anything a system rc file prints
const CLOSED_PORT = 9; // the trailer's exit report goes nowhere
const SHELL_TIMEOUT_MS = 20_000;

// The real binary, or undefined: CI's Linux runner may lack zsh and fish, and that shell's test is skipped
const onPath = (name: string): string | undefined => (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '').map((dir) => join(dir, name))
  .find((path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
const BASH = onPath('bash');
const ZSH = onPath('zsh');
const FISH = onPath('fish');

interface Shell { name: 'bash' | 'zsh' | 'fish'; binary: string; flags: string }
interface Rig { root: string; hive: string; home: string; fakes: string }

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

async function fakeAgents(dir: string, tag: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const command of COMMANDS) await executable(join(dir, command), `echo ${tag}:${command}`);
}

// A Hive home with the real init files and fake shims printing shim:<command>, and a user's HOME with a folder of fakes printing rc:<command>
// for the user's rc file to put first on PATH. A quote and a space in every path: the init files and the case line must quote them
async function rig(t: TestContext): Promise<Rig> {
  const root = await tempDir(t, "shell it's-");
  const r = { root, hive: join(root, 'hive'), home: join(root, 'home'), fakes: join(root, 'home', 'fake bin') };
  await installShellInit(r.hive);
  await fakeAgents(join(r.hive, 'bin'), 'shim');
  await fakeAgents(r.fakes, 'rc');
  return r;
}

// The user's rc file in sh syntax: says it ran, then puts the fakes first on PATH, as ~/.local/bin or $PNPM_HOME do
const shRc = (fakes: string): string => `echo ${RC_LOADED}\nPATH=${shellQuote(fakes)}:$PATH\n`;

// The terminal's launch: ptyCommand's own line under /bin/sh -c with terminalEnv's env, as the pty host runs it. $SHELL is a stand-in named
// after the shell, since the case line matches on that name: it execs the real one with the case line's args, then what the pty would have
// given it, a tty (-i: an interactive shell, which reads its rc files) and the keys typed (-c). Answers the test's own output lines.
async function typeIn(r: Rig, shell: Shell, line: string, env: NodeJS.ProcessEnv = {}): Promise<string[]> {
  await mkdir(join(r.root, 'as'), { recursive: true });
  const standIn = join(r.root, 'as', shell.name);
  await executable(standIn, `exec ${shellQuote(shell.binary)} "$@" ${shell.flags} -c ${shellQuote(line)}`);
  const launch: PtyLaunch = { ptyId: 'T1', slug: 'local', cwd: r.home, port: CLOSED_PORT, terminal: true };
  const full = { HOME: r.home, TERM: 'dumb', SHELL: standIn, HIVE_SECRET_FILE: '/dev/null', ...terminalEnv(r.hive, 'T1', '/usr/bin:/bin'), ...env };
  return new Promise((resolve) => {
    // the trailer's curl fails on the closed port, so the exit code is not the shell's: only stdout is read
    const child = execFile('/bin/sh', ['-c', ptyCommand(launch)], { env: full, timeout: SHELL_TIMEOUT_MS }, (_err, stdout) =>
      resolve(stdout.split('\n').filter((l) => MARKER.test(l))));
    child.stdin?.end(); // a system rc file that prompts (compinit's insecure-dirs question) reads EOF instead of waiting for the timeout
  });
}

test('without HIVE_SHELL_DIR a terminal is the plain $SHELL, and the rc file\'s PATH wins over the shim: what the init files fix (#259)', { skip: BASH === undefined && 'no bash on PATH' }, async (t) => {
  const r = await rig(t);
  await writeFile(join(r.home, '.bashrc'), shRc(r.fakes));
  assert.deepEqual(await typeIn(r, { name: 'bash', binary: BASH ?? '', flags: '-i' }, TYPED, { HIVE_SHELL_DIR: undefined }), [RC_LOADED, ...RC_RAN]);
});

test('bash: claude and codex typed in a terminal whose ~/.bashrc puts others first on PATH run their shims, after ~/.bashrc ran (#259)', { skip: BASH === undefined && 'no bash on PATH' }, async (t) => {
  const r = await rig(t);
  await writeFile(join(r.home, '.bashrc'), shRc(r.fakes));
  assert.deepEqual(await typeIn(r, { name: 'bash', binary: BASH ?? '', flags: '-i' }, TYPED), [RC_LOADED, ...SHIM_RAN]);
});

test('zsh: claude and codex typed in a terminal whose .zshrc puts others first on PATH run their shims, and ZDOTDIR is the user\'s once the shell is up: unset, unset in a login shell, a custom folder, a folder the user\'s .zshenv sets (#259)', { skip: ZSH === undefined && 'no zsh on PATH' }, async (t) => {
  const zsh: Shell = { name: 'zsh', binary: ZSH ?? '', flags: '-i' };
  const line = `${TYPED}; echo "zdotdir=\${ZDOTDIR-unset}"; echo "user=\${HIVE_USER_ZDOTDIR-unset}"`;
  const r = await rig(t);
  await writeFile(join(r.home, '.zshrc'), shRc(r.fakes));
  const unset = [RC_LOADED, ...SHIM_RAN, 'zdotdir=unset', 'user=unset'];
  assert.deepEqual(await typeIn(r, zsh, line), unset);
  assert.deepEqual(await typeIn(r, { ...zsh, flags: '-l -i' }, line), unset, 'a login shell: .zlogin restores it');
  const custom = join(r.root, 'zdot dir');
  await mkdir(custom);
  await writeFile(join(custom, '.zshrc'), shRc(r.fakes));
  await writeFile(join(r.home, '.zshrc'), 'echo rc:home\n'); // read only if ZDOTDIR were ignored
  const moved = [RC_LOADED, ...SHIM_RAN, `zdotdir=${custom}`, 'user=unset'];
  assert.deepEqual(await typeIn(r, zsh, line, { ZDOTDIR: custom }), moved, 'the user\'s ZDOTDIR from the env');
  await writeFile(join(r.home, '.zshenv'), `ZDOTDIR=${shellQuote(custom)}\n`);
  assert.deepEqual(await typeIn(r, zsh, line), moved, 'the user\'s ZDOTDIR from ~/.zshenv');
});

test('fish: claude and codex typed in a terminal whose config.fish puts others first on PATH run their shims, after config.fish ran (#259)', { skip: FISH === undefined && 'no fish on PATH' }, async (t) => {
  const r = await rig(t);
  const config = join(r.home, '.config', 'fish');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'config.fish'), `echo ${RC_LOADED}\nset -gx PATH ${fishQuote(r.fakes)} $PATH\n`);
  assert.deepEqual(await typeIn(r, { name: 'fish', binary: FISH ?? '', flags: '' }, TYPED), [RC_LOADED, ...SHIM_RAN]);
});
