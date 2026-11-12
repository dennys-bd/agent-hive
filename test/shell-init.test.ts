import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { AGENTS } from '../src/agents.js';
import { pwshQuote } from '../src/pwsh-quote.js';
import { fishQuote, installShellInit, renderShellInit, SHELL_INIT_FILES, shellQuote } from '../src/shell-init.js';
import { shimDir, shimPath } from '../src/shim.js';
import { ptyCommand, terminalEnv } from '../src/spawn.js';
import { AGENT_IDS, type PtyLaunch } from '../src/types.js';
import { tempDir } from './temp-dir.js';
import { assertMode } from './posix-only.js';

const FUNCTION_FILES = ['zsh/.zshrc', 'bash/rc', 'fish/init.fish', 'pwsh/profile.ps1'];
const INSTALL = { platform: 'darwin', sh: '/bin/sh' } as const;
const PATHS = { sh: '/bin/sh', bin: '/h/bin' };

test('renderShellInit puts one function per shim in the placeholder, the path quoted for the file\'s shell: a quote, a space, $\' and $& stay literal (#259)', () => {
  const shims = [{ command: 'claude', path: `/h/it's $'x' $& "dir"/bin/claude` }, { command: 'codex', path: '/h/bin/codex' }];
  const template = 'before\n__HIVE_FUNCTIONS__\nafter\n';
  const sh = [String.raw`function claude { '/h/it'\''s $'\''x'\'' $& "dir"/bin/claude' "$@"; }`, `function codex { '/h/bin/codex' "$@"; }`];
  const fish = [String.raw`function claude; '/h/it\'s $\'x\' $& "dir"/bin/claude' $argv; end`, 'function codex; \'/h/bin/codex\' $argv; end'];
  for (const file of ['zsh/.zshrc', 'bash/rc']) assert.equal(renderShellInit(template, file, shims, PATHS), `before\n${sh.join('\n')}\nafter\n`, file);
  assert.equal(renderShellInit(template, 'fish/init.fish', shims, PATHS), `before\n${fish.join('\n')}\nafter\n`);
  assert.equal(renderShellInit('no placeholder\n', 'zsh/.zshenv', shims, PATHS), 'no placeholder\n');
});

test('pwshQuote is a word PowerShell reads literally: in single quotes, each of its five single quotes doubled, $ and backslashes left alone (#645)', () => {
  assert.equal(pwshQuote("C:\\Users\\it's $HOME"), "'C:\\Users\\it''s $HOME'");
  assert.equal(pwshQuote('a\u2018b\u2019c\u201ad\u201be'), "'a\u2018\u2018b\u2019\u2019c\u201a\u201ad\u201b\u201be'");
});

test('renderShellInit renders the PowerShell profile: the shim folder put back first on PATH and one function per agent calling sh.exe on its shim, every path pwshQuoted (#645)', () => {
  const shims = [{ command: 'claude', path: "C:\\h\\it's\\bin\\claude" }, { command: 'codex', path: 'C:\\h\\bin\\codex' }];
  const paths = { sh: 'C:\\Program Files\\Git\\bin\\sh.exe', bin: "C:\\h\\it's\\bin" };
  const template = "$env:PATH = __HIVE_BIN__ + ';' + $env:PATH\n__HIVE_FUNCTIONS__\n";
  assert.equal(renderShellInit(template, 'pwsh/profile.ps1', shims, paths), [
    "$env:PATH = 'C:\\h\\it''s\\bin' + ';' + $env:PATH",
    "Remove-Item -LiteralPath Alias:claude -Force -ErrorAction SilentlyContinue; function claude { & 'C:\\Program Files\\Git\\bin\\sh.exe' 'C:\\h\\it''s\\bin\\claude' @args }",
    "Remove-Item -LiteralPath Alias:codex -Force -ErrorAction SilentlyContinue; function codex { & 'C:\\Program Files\\Git\\bin\\sh.exe' 'C:\\h\\bin\\codex' @args }",
    '',
  ].join('\n'));
});

test('installShellInit writes every init file under <home>/shell/, its folders for this user only, a function per agent of AGENTS calling its shim, no placeholder left, and rewrites them on every boot (#259)', async (t) => {
  const home = await tempDir(t, 'home-');
  const dir = await installShellInit(home, INSTALL);
  assert.equal(dir, join(home, 'shell'));
  for (const file of SHELL_INIT_FILES) assert.doesNotMatch(await readFile(join(dir, file), 'utf8'), /__HIVE_[A-Z]+__/, file);
  // each file holds the shim's path as its own shell quotes it: fish escapes a Windows path's backslashes
  const quoted = (file: string, path: string): string => (file.startsWith('fish/') ? fishQuote(path) : file.startsWith('pwsh/') ? pwshQuote(path) : shellQuote(path));
  for (const file of FUNCTION_FILES) {
    const text = await readFile(join(dir, file), 'utf8');
    for (const id of AGENT_IDS) assert.ok(text.includes(`function ${AGENTS[id].command}`) && text.includes(quoted(file, shimPath(home, AGENTS[id]))), `${file}: ${id}`);
  }
  const profile = await readFile(join(dir, 'pwsh', 'profile.ps1'), 'utf8');
  assert.ok(profile.includes(`$env:PATH = ${pwshQuote(shimDir(home))} + ';' + $env:PATH`), 'the shim folder back first on PATH');
  assert.ok(profile.includes(`& ${pwshQuote(INSTALL.sh)} ${pwshQuote(shimPath(home, AGENTS.claude))} @args`), 'claude through sh.exe');
  for (const folder of ['', 'zsh', 'bash', 'fish', 'pwsh']) await assertMode(t, join(dir, folder), 0o700, folder); // win32: no POSIX mode bits
  await writeFile(join(dir, 'bash', 'rc'), 'from a previous version');
  await installShellInit(home, INSTALL);
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

// The real binary, or undefined: CI's Linux runner may lack zsh and fish, and that shell's test is skipped. None on win32: these run
// /bin/sh and #!/bin/sh stand-ins, and Windows' terminal is PowerShell's (#645), run on the lane in pty-spawn.test.ts
const onPath = (name: string): string | undefined => (process.platform === 'win32' ? undefined : (process.env.PATH ?? '').split(delimiter)
  .filter((dir) => dir !== '').map((dir) => join(dir, name)).find((path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }));
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
  await installShellInit(r.hive, INSTALL);
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
  const full = { HOME: r.home, TERM: 'dumb', SHELL: standIn, HIVE_SECRET_FILE: '/dev/null', ...terminalEnv(r.hive, 'T1', '/usr/bin:/bin', { platform: process.platform }), ...env };
  return new Promise((resolve) => {
    // the trailer's curl fails on the closed port, so the exit code is not the shell's: only stdout is read
    // detached: a session of its own, with no controlling terminal; an interactive shell would otherwise take over the one running the tests
    // and stop on SIGTTIN/SIGTTOU, as a pty-less CI never does
    const options = { env: full, timeout: SHELL_TIMEOUT_MS, encoding: 'utf8' as const, detached: true }; // execFile hands detached to spawn; its types omit it
    const child = execFile('/bin/sh', ['-c', ptyCommand(launch)], options, (_err, stdout) =>
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
  const line = `${TYPED}; echo "zdotdir=\${ZDOTDIR-unset}"; echo "user=\${HIVE_USER_ZDOTDIR-unset}"; [[ $HISTFILE == "$HIVE_SHELL_DIR"/* ]] && echo rc:history-in-hive`; // macOS /etc/zshrc names HISTFILE from ZDOTDIR
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
