import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { claudeEnvLine, commandShimDir, commandShimSource, installCommandShims, renderCommandShim, renderCommandShimCmd, shimWords } from '../src/command-shim.js';
import type { Command } from '../src/types.js';
import { assertMode, NO_POSIX_SIGNALS, SH_LAUNCHER } from './posix-only.js';
import { tempDir } from './temp-dir.js';
import { ACQUIRE, FAKE_EXIT, NO_ANSWER_MS, REFUSED_EXIT, RELEASE, SECRET, SHIM_TIMEOUT_MS, WORD, fakeOut, runShim, searchPath, setup, startShim, until } from './command-shim-rig.js';


test('renderCommandShim names its word, its language and its platform, quoted, in place of every placeholder (#800, #806)', async () => {
  const template = await readFile(commandShimSource(), 'utf8');
  const shim = renderCommandShim(template, WORD, 'en', 'darwin');
  assert.match(shim, /^word='pnpm'$/m);
  assert.match(shim, /^language='en' /m);
  assert.match(shim, /^platform='darwin' /m);
  assert.match(renderCommandShim(template, WORD, 'en', 'win32'), /^platform='win32' /m);
  assert.doesNotMatch(shim, /__HIVE_/);
});

test('outside a Hive pty the shim runs the real binary as typed and asks nothing (#800)', async (t) => {
  const { r, seen } = await setup(t, 'refused memory 1');
  for (const name of ['HIVE_PTY_ID', 'HIVE_PORT', 'HIVE_SECRET_FILE']) {
    const ran = await runShim(r, ['test'], { env: { [name]: undefined } });
    assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])], name);
  }
  assert.deepEqual(seen, []);
});

test('a real binary missing from PATH is 127 with its message, before any acquire (#800)', async (t) => {
  const { r, seen } = await setup(t, 'run');
  const ran = await runShim(r, ['test'], { env: { PATH: dirname(r.shim) } });
  assert.deepEqual([ran.code, ran.stderr, seen.length], [127, 'pnpm: not found on PATH\n', 0]);
});

test('a Hive that never answers costs at most 2 s: the binary runs with its own code (#800)', async (t) => {
  const { r } = await setup(t, undefined);
  const ran = await runShim(r, ['test']);
  assert.equal(ran.code, FAKE_EXIT);
  assert.ok(ran.ms < NO_ANSWER_MS, `${ran.ms} ms`);
});

test('run, or an answer the shim does not know, runs the binary and sends no release (#800)', async (t) => {
  for (const answer of ['run', 'maybe memory', 'run bad/name', 'refused memory x', 'wait memory']) {
    const { r, seen } = await setup(t, answer);
    const ran = await runShim(r, ['test']);
    assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])], answer);
    assert.deepEqual(seen.map((s) => s.path), [ACQUIRE], `${answer}: no release`);
  }
});

test('run memory runs the binary as a child with the shim\'s stdin and its exit code, then sends one release of memory once it ended (#800)', async (t) => {
  const { r, seen } = await setup(t, 'run memory');
  const ran = await runShim(r, ['test'], { stdin: 'typed' });
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'], 'typed')]);
  assert.deepEqual(seen.map((s) => s.path), [ACQUIRE, RELEASE]);
  const [, release] = seen;
  assert.deepEqual([JSON.parse(release.body), release.pty, release.secret, release.childDone], [{ semaphore: 'memory' }, 'R1', SECRET, true]);
});

test('refused memory <place> prints one line on stderr with the place\'s ordinal, exits 75 and never runs the binary (#800)', async (t) => {
  const places: [number, string][] = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [112, '112th']];
  for (const [place, ordinal] of places) {
    const { r, seen } = await setup(t, `refused memory ${place}`);
    const ran = await runShim(r, ['test']);
    assert.deepEqual([ran.code, ran.stdout, existsSync(r.done)], [REFUSED_EXIT, '', false], ordinal);
    assert.equal(ran.stderr, `hive: pnpm refused: the semaphore memory is full and you are ${ordinal} in line. Do not retry: you will be told when your turn comes.\n`);
    assert.deepEqual(seen.map((s) => s.path), [ACQUIRE], 'a refused place stays in line: no release');
  }
});

// win32: no trap ever sees the kill (NO_POSIX_SIGNALS)
// planning decision 1: an INT reaches the child as TERM, since a background child of a non-interactive sh ignores INT
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
  test(`a ${signal} to the shim alone during run memory ends the child, sends the release and exits ${code} (#800)`, { skip: NO_POSIX_SIGNALS }, async (t) => {
    const { r, seen } = await setup(t, 'run memory');
    const pidFile = join(r.root, 'child.pid');
    const shim = startShim(r, ['test'], { env: { FAKE_PID_FILE: pidFile } });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'));
    const child = Number(readFileSync(pidFile, 'utf8'));
    shim.kill(signal);
    assert.equal((await shim.done).code, code);
    assert.throws(() => process.kill(child, 0), { code: 'ESRCH' }, 'the child ended with the shim');
    assert.deepEqual(seen.map((s) => s.path), [ACQUIRE, RELEASE]);
  });
}

test('the argv reaches the daemon as arg fields, the shim\'s word first and each arg whole, with a pid the daemon finds alive and the pty (#800, #806)', async (t) => {
  const { r, seen } = await setup(t, 'run');
  const args = ['test', 'a b', '--filter=x&y=z', '@file', ''];
  const shim = startShim(r, args, { lastArg: 'line\nbreak' }); // a line break whole on every OS (planning decision 7)
  assert.equal((await shim.done).code, FAKE_EXIT);
  const form = new URLSearchParams(seen[0].body);
  assert.deepEqual(form.getAll('arg'), [WORD, ...args, 'line\nbreak']);
  assert.deepEqual([seen[0].pidAlive, seen[0].pty, seen[0].secret], [true, 'R1', SECRET]);
  await t.test('the pid is the one Node started', { skip: SH_LAUNCHER }, () => assert.equal(form.get('pid'), String(shim.pid)));
});

test('with a semaphore on curl itself the shim\'s own curl is the real one, never the shim again (#800)', async (t) => {
  const { r, seen } = await setup(t, 'run', 'curl');
  const ran = await runShim(r, ['--version']);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /^curl /);
  assert.equal(seen.length, 1, 'one acquire, no loop');
});

test('two command-shim folders on PATH (a Hive started from a Hive pty) run the real binary once, never each other in a loop (#800)', { timeout: SHIM_TIMEOUT_MS * 2 }, async (t) => {
  const { r, seen } = await setup(t, 'run');
  const outer = join(r.root, 'outer-command-shims');
  await mkdir(outer);
  await writeFile(join(outer, WORD), renderCommandShim(await readFile(commandShimSource(), 'utf8'), WORD, 'en', process.platform));
  await chmod(join(outer, WORD), 0o755);
  const ran = await runShim(r, ['test'], { env: { PATH: searchPath(dirname(r.shim), outer, join(r.root, 'real')) } });
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])]);
  assert.deepEqual(seen.map((s) => s.path), [ACQUIRE, ACQUIRE], 'one acquire per shim, then the real binary');
});

test('a folder named as the word on PATH is skipped, as the shell\'s own lookup skips it (#800)', async (t) => {
  const { r } = await setup(t, 'run');
  await mkdir(join(r.root, 'decoy', WORD), { recursive: true });
  const ran = await runShim(r, ['test'], { env: { PATH: searchPath(dirname(r.shim), join(r.root, 'decoy'), join(r.root, 'real')) } });
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])]);
});

test('a ~/.curlrc never applies to the shim\'s curl: a --trace there writes no file with the secret header (#800)', async (t) => {
  const { r, seen } = await setup(t, 'run memory');
  const trace = join(r.root, 'trace');
  await writeFile(join(r.root, '.curlrc'), `trace = "${trace}"\n`);
  const ran = await runShim(r, ['test']);
  assert.deepEqual([ran.code, seen.map((s) => s.path)], [FAKE_EXIT, [ACQUIRE, RELEASE]]);
  assert.equal(existsSync(trace), false);
});

for (const sh of ['/bin/sh', '/bin/dash'].filter((path) => existsSync(path))) {
  test(`run memory with stdin closed under ${sh} still runs the binary and sends one release (#800)`, async (t) => {
    const { r, seen } = await setup(t, 'run memory');
    const ran = await runShim(r, ['test'], { closedStdin: sh });
    assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])], ran.stderr);
    assert.deepEqual(seen.map((s) => s.path), [ACQUIRE, RELEASE]);
  });
}

// #806: a real binary that names its tag and its own file name, exit 7. A shebang script off win32; on the lane a batch file, since MSYS
// hands a .cmd or .bat to cmd.exe, which reads no shebang (planning decision 6)
const named = (tag: string): string => (process.platform === 'win32'
  ? `@echo ran:${tag}:%~nx0\r\n@exit /b ${FAKE_EXIT}\r\n`
  : `#!/bin/sh\nprintf 'ran:${tag}:%s\\n' "\${0##*/}"\nexit ${FAKE_EXIT}\n`);
async function fakeAt(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), text);
  await chmod(join(dir, name), 0o755);
}
const CMD_REFUSAL = (n: number): string => `hive: pnpm: cmd.exe cannot pass argument ${n} (it has %, a line break or NUL)\n`;

test('the win32 shim finds <word><ext> per PATH folder in PATHEXT\'s order and without case, past a folder holding only pnpm.vbs (#806)', async (t) => {
  const { r } = await setup(t, 'run', WORD, 'win32');
  const vbs = join(r.root, 'vbs');
  const cmds = join(r.root, 'cmds');
  await fakeAt(vbs, 'pnpm.vbs', named('vbs'));
  await fakeAt(cmds, 'pnpm.bat', named('cmds'));
  await fakeAt(cmds, 'pnpm.cmd', named('cmds'));
  const PATH = searchPath(dirname(r.shim), vbs, cmds, join(r.root, 'real'));
  const cases: [string | undefined, string][] = [[undefined, 'pnpm.bat'], ['.VBS;.CMD;.BAT', 'pnpm.cmd'], ['.cmd;.bat', 'pnpm.cmd'], ['.Bat;.Cmd', 'pnpm.bat']];
  for (const [PATHEXT, name] of cases) {
    const ran = await runShim(r, ['test'], { env: { PATH, PATHEXT } });
    assert.deepEqual([ran.code, ran.stdout.trim()], [FAKE_EXIT, `ran:cmds:${name}`], PATHEXT ?? 'no PATHEXT: .COM;.EXE;.BAT;.CMD');
  }
});

test('the win32 shim takes <dir>/<word> as given before its PATHEXT names in the same folder (#806)', async (t) => {
  const { r } = await setup(t, 'run', WORD, 'win32');
  await fakeAt(join(r.root, 'real'), 'pnpm.cmd', named('real'));
  const ran = await runShim(r, ['test']);
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])]);
});

test('the win32 shim never runs its own .cmd twin: the shims\' folder is skipped with it (#806)', async (t) => {
  const { r } = await setup(t, 'run', WORD, 'win32');
  await fakeAt(dirname(r.shim), 'pnpm.cmd', named('twin'));
  const cmds = join(r.root, 'cmds');
  await fakeAt(cmds, 'pnpm.cmd', named('cmds'));
  const ran = await runShim(r, ['test'], { env: { PATH: searchPath(dirname(r.shim), cmds) } });
  assert.equal(ran.stdout.trim(), 'ran:cmds:pnpm.cmd');
});

test('the win32 shim refuses an argument with %, a CR or a LF for a .cmd or .bat real binary: 126, its position only, before any acquire, outside a Hive pty too (#806)', async (t) => {
  for (const ext of ['.cmd', '.bat']) {
    const { r, seen } = await setup(t, 'run', WORD, 'win32');
    const cmds = join(r.root, 'cmds');
    await fakeAt(cmds, `pnpm${ext}`, named('cmds'));
    const env = { PATH: searchPath(dirname(r.shim), cmds) };
    const cases: [string[], string | undefined, number][] = [[['test', '50%'], undefined, 2], [['test'], 'a\rb', 2], [[], 'a\nb', 1], [['50%', 'test'], undefined, 1]];
    for (const [args, lastArg, n] of cases) {
      const ran = await runShim(r, args, { env, lastArg });
      assert.deepEqual([ran.code, ran.stdout, ran.stderr], [126, '', CMD_REFUSAL(n)], `${ext} ${JSON.stringify([...args, lastArg])}`);
    }
    const outside = await runShim(r, ['50%'], { env: { ...env, HIVE_PTY_ID: undefined } });
    assert.deepEqual([outside.code, outside.stderr], [126, CMD_REFUSAL(1)], 'never passed on changed');
    assert.deepEqual(seen, [], 'no acquire, so no permit or place is taken');
  }
});

test('the win32 shim passes %, a CR and a LF whole to a real binary that is no batch file (#806)', async (t) => {
  const { r } = await setup(t, 'run', WORD, 'win32');
  for (const lastArg of ['a\rb', 'a\nb']) {
    const ran = await runShim(r, ['50%'], { lastArg });
    assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['50%', lastArg])], JSON.stringify(lastArg));
  }
});

test('the win32 shim sends a pid the daemon finds alive: its Windows pid on the lane, $$ where /proc has no winpid (#806)', async (t) => {
  const { r, seen } = await setup(t, 'run', WORD, 'win32');
  const shim = startShim(r, ['test']);
  assert.equal((await shim.done).code, FAKE_EXIT);
  assert.equal(seen[0].pidAlive, true);
  await t.test('the pid is the one Node started', { skip: SH_LAUNCHER }, () => {
    assert.equal(new URLSearchParams(seen[0].body).get('pid'), String(shim.pid));
  });
});

const line = (command: string, semaphore?: string, workspace: string | null = null): Command['impls'][number] =>
  ({ workspace, command, ...(semaphore === undefined ? {} : { semaphore }) });
const commandOf = (name: string, ...impls: Command['impls']): Command => ({ name, impls, menu: true, env: {} });
const commandsConfig = (...commands: Command[]): { comb: { commands: Command[] } } => ({ comb: { commands } });

test('shimWords: the distinct first words of every line with a semaphore, in any workspace; none for a line without one, an unmatchable line, a path or . (#800)', () => {
  const config = commandsConfig(
    commandOf('test', line('pnpm test', 'memory', 'api'), line('NODE_ENV=test pnpm vitest', 'memory', 'web'), line('npm test')),
    commandOf('up', line('docker compose up', 'disk')),
    commandOf('lint', line('pnpm lint', 'memory')),
    commandOf('quoted', line('"pnpm" test', 'memory')),
    commandOf('local', line('./scripts/e2e.sh', 'memory'), line('. ./env.sh', 'disk', 'web'), line('bin/e2e', 'disk', 'api')),
  );
  assert.deepEqual(shimWords(config, 'darwin'), ['pnpm', 'docker']);
});

test('installCommandShims writes one executable shim per word into <home>/command-shims, and a save without a word deletes its file and keeps the rest (#800)', async (t) => {
  const home = await tempDir(t, 'home-');
  const dir = commandShimDir(home);
  assert.equal(dir, join(home, 'command-shims'));
  const both = commandsConfig(commandOf('test', line('pnpm test', 'memory')), commandOf('up', line('docker compose up', 'disk')));
  assert.deepEqual(await installCommandShims(home, both, 'pt', { platform: 'darwin', sh: '/bin/sh' }), ['pnpm', 'docker']);
  assert.equal(await readFile(join(dir, 'pnpm'), 'utf8'), renderCommandShim(await readFile(commandShimSource(), 'utf8'), 'pnpm', 'pt', 'darwin'));
  await assertMode(t, dir, 0o700);
  await assertMode(t, join(dir, 'pnpm'), 0o755);
  await writeFile(join(dir, 'stray'), 'left by an older version');
  await installCommandShims(home, commandsConfig(commandOf('up', line('docker compose up', 'disk'))), 'en', { platform: 'linux', sh: '/bin/sh' });
  assert.deepEqual(await readdir(dir), ['docker']);
});

test('shimWords on win32: none for a word holding :, nor for one sharing a file name, in any case, with an earlier word or its twin; all of them elsewhere (#806)', () => {
  const config = commandsConfig(
    commandOf('test', line('pnpm test', 'memory'), line('Pnpm lint', 'memory'), line('PNPM.cmd x', 'memory')),
    commandOf('odd', line('a:b run', 'memory')),
  );
  assert.deepEqual(shimWords(config, 'win32'), ['pnpm']);
  assert.deepEqual(shimWords(config, 'linux'), ['pnpm', 'Pnpm', 'PNPM.cmd', 'a:b']);
});

test('renderCommandShimCmd writes the sh.exe path and the word with % doubled and leaves the template\'s own %~dp0 and %* alone (#806)', () => {
  assert.equal(renderCommandShimCmd('"__HIVE_SH__" "%~dp0__HIVE_COMMAND__" %*', 'a%b', 'C:\\Git 100%\\bin\\sh.exe'), '"C:\\Git 100%%\\bin\\sh.exe" "%~dp0a%%b" %*');
});

test('installCommandShims on win32 writes each word\'s POSIX shim and its .cmd twin, and a save keeps both of every current word and deletes the rest (#806)', async (t) => {
  const home = await tempDir(t, 'home-');
  const dir = commandShimDir(home);
  const install = { platform: 'win32', sh: 'C:\\Program Files\\Git\\bin\\sh.exe' } as const;
  const both = commandsConfig(commandOf('test', line('pnpm test', 'memory')), commandOf('up', line('docker compose up', 'disk')));
  assert.deepEqual(await installCommandShims(home, both, 'en', install), ['pnpm', 'docker']);
  assert.equal(await readFile(join(dir, 'pnpm'), 'utf8'), renderCommandShim(await readFile(commandShimSource(), 'utf8'), 'pnpm', 'en', 'win32'));
  const twin = await readFile(join(dir, 'pnpm.cmd'), 'utf8');
  assert.match(twin, /^set MSYS2_ARG_CONV_EXCL=\*\r?$/m);
  assert.match(twin, /^"C:\\Program Files\\Git\\bin\\sh\.exe" "%~dp0pnpm" %\*\r?$/m);
  await writeFile(join(dir, 'stray.cmd'), 'left by an older version');
  await installCommandShims(home, commandsConfig(commandOf('up', line('docker compose up', 'disk'))), 'en', install);
  assert.deepEqual((await readdir(dir)).sort(), ['docker', 'docker.cmd']);
});

test('claudeEnvLine prepends the folder, quoted, to PATH and exports it (#800)', () => {
  assert.equal(claudeEnvLine("/h/it's"), "PATH='/h/it'\\''s':$PATH; export PATH\n");
});
