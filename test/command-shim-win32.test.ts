import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { commandShimDir, installCommandShims, msysPath } from '../src/command-shim.js';
import { envValue, resolveExec } from '../src/exec-path.js';
import { posixShell, posixShellEnv } from '../src/posix-shell.js';
import { ptyEnv, windowsShell } from '../src/spawn.js';
import type { Command } from '../src/types.js';
import { ACQUIRE, FAKE_EXIT, inTerminal, RELEASE, setup, until } from './command-shim-rig.js';
import { ONLY_WIN32 } from './posix-only.js';
import { tempDir } from './temp-dir.js';

// #806 decision 15: the issue's two feasibility points, proven where only they can be, on the Windows lane
const ON_WINDOWS = { skip: ONLY_WIN32, timeout: 60_000 };
const run = promisify(execFile);
const NOW = 'now=true';
const CLOSED_PORT = 9; // acquire finds no Hive there: the shim runs the real binary as typed
const RUN_TIMEOUT_MS = 30_000;
const WAIT_TRIES = 3_000; // 30 s: sh.exe starting in a ConPTY is slower than the default 5 s
// Windows' file system ignores case, and a tool may print the drive in either
const sameFile = (printed: string, expected: string): boolean => printed.trim().toLowerCase() === expected.toLowerCase();
// A ConPTY may redraw a run of spaces as a cursor move, which stripping leaves out: the screen is compared without any whitespace
const flat = (text: string): string => stripVTControlCharacters(text).replace(/\s+/g, '');
const PNPM_TEST: Command = { name: 'test', impls: [{ workspace: null, command: 'pnpm test', semaphore: 'memory' }], menu: true, env: {} };

// A worker's env as ptyEnv gives it, from a base whose path is Path as a child of PowerShell has it, with a real pnpm.cmd later on it
async function workerEnv(t: TestContext): Promise<{ shims: string; env: NodeJS.ProcessEnv }> {
  const home = await tempDir(t, 'win-shim-');
  await installCommandShims(home, { comb: { commands: [PNPM_TEST] } }, 'en', { platform: 'win32', sh: posixShell().shell });
  const real = join(home, 'real');
  const tmp = join(home, 'tmp');
  await mkdir(real);
  await mkdir(tmp);
  await writeFile(join(real, 'pnpm.cmd'), '@echo real pnpm %*\r\n');
  const rest = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
  const base = { ...rest, Path: `${real};${envValue(process.env, 'PATH') ?? ''}` };
  const shims = commandShimDir(home);
  return { shims, env: { ...ptyEnv(base, 'W1', CLOSED_PORT, tmp, join(home, 'hive.secret'), 'win32', shims), ...posixShellEnv('win32') } };
}

test('on the Windows lane a worker\'s Git bash and PowerShell find the command shim before a real pnpm.cmd later on PATH, and the .cmd twin runs that real one through sh.exe (#806)', ON_WINDOWS, async (t) => {
  const { shims, env } = await workerEnv(t);
  const bash = await run(posixShell().shell, ['-c', 'command -v pnpm'], { env, timeout: RUN_TIMEOUT_MS });
  assert.ok(sameFile(bash.stdout, msysPath(join(shims, 'pnpm'))), bash.stdout);
  const pwsh = windowsShell(process.env, 'win32');
  assert.ok(pwsh !== undefined, 'every Windows ships powershell.exe');
  const psEnv = /pwsh\.exe$/i.test(pwsh) ? env : { ...env, PSModulePath: '' }; // as pty-spawn.test.ts: 5.1 breaks on pwsh 7's PSModulePath
  const ps = await run(pwsh, ['-NoProfile', '-NonInteractive', '-Command', '@(Get-Command pnpm)[0].Source'], { env: psEnv, timeout: RUN_TIMEOUT_MS });
  assert.ok(sameFile(ps.stdout, join(shims, 'pnpm.cmd')), ps.stdout);
  // planning decision 1: the twin starts the shim as %~dp0pnpm, backslashes and all; a lost folder would run the twin again, forever
  const twin = resolveExec(join(shims, 'pnpm.cmd'), ['test'], { platform: 'win32', env });
  const ran = await run(twin.file, [...twin.args], { env: { ...env, ...twin.env }, windowsVerbatimArguments: twin.windowsVerbatimArguments, timeout: RUN_TIMEOUT_MS });
  assert.match(ran.stdout, /^real pnpm test\r?$/m);
});

test('on the Windows lane a terminal\'s wait in a ConPTY runs it now on r when stty works under sh.exe, else shows its line without the key and runs on its turn (#806)', ON_WINDOWS, async (t) => {
  let turn = false;
  const { r, seen } = await setup(t, (_n, body) => (body.includes(NOW) || turn ? 'run memory' : 'wait memory 3'));
  // A real binary that reads no stdin: a ConPTY gives the shell no EOF on ^D to end the rig's cat
  await writeFile(join(r.root, 'real', 'pnpm'), `#!/bin/sh\necho "ran $*"\nexit ${FAKE_EXIT}\n`);
  const shell = inTerminal(r);
  await until(() => flat(shell.output()).includes('Ctrl-Cleaves'), WAIT_TRIES);
  const keyed = flat(shell.output()).includes('rrunsitnow');
  t.diagnostic(keyed ? 'stty worked in the ConPTY: the key is offered' : 'stty failed in the ConPTY: the wait sleeps, and the card\'s run now covers it');
  if (keyed) shell.term.write('r');
  else turn = true;
  assert.equal(await shell.exited, FAKE_EXIT);
  assert.ok(flat(shell.output()).includes('rantest'), 'the real binary ran');
  assert.equal(seen.filter((s) => s.path === ACQUIRE).at(-1)?.body.includes(NOW), keyed, keyed ? 'r asked now' : 'no key, so no acquire carries now');
  assert.equal(seen.at(-1)?.path, RELEASE);
});
