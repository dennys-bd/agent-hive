import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeEnvLine, commandShimDir, commandShimSource, installCommandShims, renderCommandShim, shimWords } from '../src/command-shim.js';
import { SECRET_HEADER } from '../src/secret.js';
import type { Command } from '../src/types.js';
import { assertMode, NO_POSIX_SHELL } from './posix-only.js';
import { tempDir } from './temp-dir.js';

const WORD = 'pnpm';
const SECRET = 'test-secret'; // a header line for curl's -H @file, never a real token
const ACQUIRE = '/hooks/semaphores/acquire';
const RELEASE = '/hooks/semaphores/release';
const FAKE_EXIT = 7;
const REFUSED_EXIT = 75;
const SHIM_TIMEOUT_MS = 10_000;
const NO_ANSWER_MS = 3_000; // the shim's -m 2, plus the binary's own run
const POSIX = { skip: NO_POSIX_SHELL };

// The real binary the shim finds: each arg on a line, then its stdin, a mark that it ended, and exit 7. With FAKE_PID_FILE: its pid there
// and a long sleep, for a signal to end
const FAKE = `#!/bin/sh
if [ -n "\${FAKE_PID_FILE:-}" ]; then echo $$ > "$FAKE_PID_FILE"; exec sleep 30; fi
for a in "$@"; do printf 'arg:%s\\n' "$a"; done
printf 'stdin:%s\\n' "$(cat)"
: > "$FAKE_DONE"
exit ${FAKE_EXIT}
`;
const fakeOut = (args: readonly string[], stdin = ''): string => [...args.map((a) => `arg:${a}`), `stdin:${stdin}`, ''].join('\n');

interface Seen { path: string; pty?: string; secret?: string; body: string; childDone: boolean }
interface Rig { root: string; shim: string; done: string; env: NodeJS.ProcessEnv }
interface Ran { code: number | null; stdout: string; stderr: string; ms: number }

// The two routes on loopback, each request kept with whether the fake binary had ended by then. undefined: acquire never answers, as a
// stuck Hive
async function fakeDaemon(t: TestContext, answer: string | undefined, isChildDone: () => boolean): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ path: req.url ?? '', pty: req.headers['x-hive-pty']?.toString(), secret: req.headers[SECRET_HEADER]?.toString(), body, childDone: isChildDone() });
      if (req.url === RELEASE) res.writeHead(204).end();
      else if (answer !== undefined) res.writeHead(200, { 'content-type': 'text/plain' }).end(`${answer}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: (server.address() as AddressInfo).port, seen };
}

// The shim rendered as installCommandShims renders it, in a folder first on PATH, then the fake binary's folder, then the system's for sh,
// curl and sleep. The env is a Hive pty's, as ptyEnv gives it: HIVE_PTY_ID, HIVE_PORT and the secret's header file
async function rig(root: string, port: number, word: string): Promise<Rig> {
  const shims = join(root, 'command-shims');
  const real = join(root, 'real');
  await mkdir(shims);
  await mkdir(real);
  const shim = join(shims, word);
  await writeFile(shim, renderCommandShim(await readFile(commandShimSource(), 'utf8'), word));
  await chmod(shim, 0o755);
  if (word === WORD) {
    await writeFile(join(real, word), FAKE);
    await chmod(join(real, word), 0o755);
  }
  const secretFile = join(root, 'hive.secret');
  await writeFile(secretFile, `${SECRET_HEADER}: ${SECRET}\n`);
  const done = join(root, 'done');
  const env = { HOME: root, PATH: [shims, real, process.env.PATH ?? ''].join(':'), HIVE_PTY_ID: 'R1', HIVE_PORT: String(port), HIVE_SECRET_FILE: secretFile, FAKE_DONE: done };
  return { root, shim, done, env };
}

async function setup(t: TestContext, answer: string | undefined, word = WORD): Promise<{ r: Rig; seen: Seen[] }> {
  const root = await tempDir(t, 'command-shim-');
  const { port, seen } = await fakeDaemon(t, answer, () => existsSync(join(root, 'done')));
  return { r: await rig(root, port, word), seen };
}

// The shim under sh, as a pty's shell runs a PATH hit; HOME is the rig's, so no ~/.curlrc of the machine's reaches curl
// closedStdin: the shim started by `sh` with fd 0 closed (`<&-`), under that sh
interface ShimOptions { stdin?: string; env?: NodeJS.ProcessEnv; closedStdin?: string }
function startShim(r: Rig, args: readonly string[], o: ShimOptions = {}): { pid: number; kill(signal: NodeJS.Signals): void; done: Promise<Ran> } {
  const started = Date.now();
  const argv = o.closedStdin === undefined ? [r.shim, ...args] : ['-c', `exec ${o.closedStdin} "$0" "$@" <&-`, r.shim, ...args];
  const child = spawn(o.closedStdin ?? '/bin/sh', argv, { env: { ...r.env, ...o.env }, timeout: SHIM_TIMEOUT_MS });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  child.stdin.end(o.stdin ?? '');
  const done = new Promise<Ran>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started })));
  return { pid: child.pid ?? 0, kill: (signal) => { child.kill(signal); }, done };
}
const runShim = (r: Rig, args: readonly string[], o?: ShimOptions): Promise<Ran> => startShim(r, args, o).done;

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i += 1) await sleep(10);
  assert.ok(check(), 'never happened');
}

test('renderCommandShim names its word, quoted, in place of every placeholder (#800)', async () => {
  const shim = renderCommandShim(await readFile(commandShimSource(), 'utf8'), WORD);
  assert.match(shim, /^word='pnpm'$/m);
  assert.doesNotMatch(shim, /__HIVE_/);
});

test('outside a Hive pty the shim runs the real binary as typed and asks nothing (#800)', POSIX, async (t) => {
  const { r, seen } = await setup(t, 'refused memory 1');
  for (const name of ['HIVE_PTY_ID', 'HIVE_PORT', 'HIVE_SECRET_FILE']) {
    const ran = await runShim(r, ['test'], { env: { [name]: undefined } });
    assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])], name);
  }
  assert.deepEqual(seen, []);
});

test('a real binary missing from PATH is 127 with its message, before any acquire (#800)', POSIX, async (t) => {
  const { r, seen } = await setup(t, 'run');
  const ran = await runShim(r, ['test'], { env: { PATH: dirname(r.shim) } });
  assert.deepEqual([ran.code, ran.stderr, seen.length], [127, 'pnpm: not found on PATH\n', 0]);
});

test('a Hive that never answers costs at most 2 s: the binary runs with its own code (#800)', POSIX, async (t) => {
  const { r } = await setup(t, undefined);
  const ran = await runShim(r, ['test']);
  assert.equal(ran.code, FAKE_EXIT);
  assert.ok(ran.ms < NO_ANSWER_MS, `${ran.ms} ms`);
});

test('run, or an answer the shim does not know, runs the binary and sends no release (#800)', POSIX, async (t) => {
  for (const answer of ['run', 'maybe memory', 'run bad/name', 'refused memory x', 'wait memory']) {
    const { r, seen } = await setup(t, answer);
    const ran = await runShim(r, ['test']);
    assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])], answer);
    assert.deepEqual(seen.map((s) => s.path), [ACQUIRE], `${answer}: no release`);
  }
});

test('run memory runs the binary as a child with the shim\'s stdin and its exit code, then sends one release of memory once it ended (#800)', POSIX, async (t) => {
  const { r, seen } = await setup(t, 'run memory');
  const ran = await runShim(r, ['test'], { stdin: 'typed' });
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'], 'typed')]);
  assert.deepEqual(seen.map((s) => s.path), [ACQUIRE, RELEASE]);
  const [, release] = seen;
  assert.deepEqual([JSON.parse(release.body), release.pty, release.secret, release.childDone], [{ semaphore: 'memory' }, 'R1', SECRET, true]);
});

test('refused memory <place> prints one line on stderr with the place\'s ordinal, exits 75 and never runs the binary (#800)', POSIX, async (t) => {
  const places: [number, string][] = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [112, '112th']];
  for (const [place, ordinal] of places) {
    const { r, seen } = await setup(t, `refused memory ${place}`);
    const ran = await runShim(r, ['test']);
    assert.deepEqual([ran.code, ran.stdout, existsSync(r.done)], [REFUSED_EXIT, '', false], ordinal);
    assert.equal(ran.stderr, `hive: pnpm refused: the semaphore memory is full and you are ${ordinal} in line. Do not retry: you will be told when your turn comes.\n`);
    assert.deepEqual(seen.map((s) => s.path), [ACQUIRE], 'a refused place stays in line: no release');
  }
});

test('wait memory <place> gives the place back first, then runs the binary as typed (#800)', POSIX, async (t) => {
  const { r, seen } = await setup(t, 'wait memory 1');
  const ran = await runShim(r, ['test'], { stdin: 'typed' });
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'], 'typed')]);
  assert.deepEqual(seen.map((s) => [s.path, s.childDone]), [[ACQUIRE, false], [RELEASE, false]]);
  assert.deepEqual(JSON.parse(seen[1].body), { semaphore: 'memory' });
});

// planning decision 1: an INT reaches the child as TERM, since a background child of a non-interactive sh ignores INT
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
  test(`a ${signal} to the shim alone during run memory ends the child, sends the release and exits ${code} (#800)`, POSIX, async (t) => {
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

test('the argv reaches the daemon as arg fields, the shim\'s word first and each arg whole, with the shim\'s pid and the pty (#800)', POSIX, async (t) => {
  const { r, seen } = await setup(t, 'run');
  const args = ['test', 'a b', 'line\nbreak', '--filter=x&y=z', '@file', ''];
  const shim = startShim(r, args);
  assert.equal((await shim.done).code, FAKE_EXIT);
  const form = new URLSearchParams(seen[0].body);
  assert.deepEqual([form.getAll('arg'), form.get('pid')], [[WORD, ...args], String(shim.pid)]);
  assert.deepEqual([seen[0].pty, seen[0].secret], ['R1', SECRET]);
});

test('with a semaphore on curl itself the shim\'s own curl is the real one, never the shim again (#800)', POSIX, async (t) => {
  const { r, seen } = await setup(t, 'run', 'curl');
  const ran = await runShim(r, ['--version']);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /^curl /);
  assert.equal(seen.length, 1, 'one acquire, no loop');
});

test('two command-shim folders on PATH (a Hive started from a Hive pty) run the real binary once, never each other in a loop (#800)', { ...POSIX, timeout: SHIM_TIMEOUT_MS * 2 }, async (t) => {
  const { r, seen } = await setup(t, 'run');
  const outer = join(r.root, 'outer-command-shims');
  await mkdir(outer);
  await writeFile(join(outer, WORD), renderCommandShim(await readFile(commandShimSource(), 'utf8'), WORD));
  await chmod(join(outer, WORD), 0o755);
  const ran = await runShim(r, ['test'], { env: { PATH: [dirname(r.shim), outer, join(r.root, 'real'), process.env.PATH ?? ''].join(':') } });
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])]);
  assert.deepEqual(seen.map((s) => s.path), [ACQUIRE, ACQUIRE], 'one acquire per shim, then the real binary');
});

test('a folder named as the word on PATH is skipped, as the shell\'s own lookup skips it (#800)', POSIX, async (t) => {
  const { r } = await setup(t, 'run');
  await mkdir(join(r.root, 'decoy', WORD), { recursive: true });
  const ran = await runShim(r, ['test'], { env: { PATH: [dirname(r.shim), join(r.root, 'decoy'), join(r.root, 'real'), process.env.PATH ?? ''].join(':') } });
  assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])]);
});

test('a ~/.curlrc never applies to the shim\'s curl: a --trace there writes no file with the secret header (#800)', POSIX, async (t) => {
  const { r, seen } = await setup(t, 'run memory');
  const trace = join(r.root, 'trace');
  await writeFile(join(r.root, '.curlrc'), `trace = "${trace}"\n`);
  const ran = await runShim(r, ['test']);
  assert.deepEqual([ran.code, seen.map((s) => s.path)], [FAKE_EXIT, [ACQUIRE, RELEASE]]);
  assert.equal(existsSync(trace), false);
});

for (const sh of ['/bin/sh', '/bin/dash'].filter((path) => existsSync(path))) {
  test(`run memory with stdin closed under ${sh} still runs the binary and sends one release (#800)`, POSIX, async (t) => {
    const { r, seen } = await setup(t, 'run memory');
    const ran = await runShim(r, ['test'], { closedStdin: sh });
    assert.deepEqual([ran.code, ran.stdout], [FAKE_EXIT, fakeOut(['test'])], ran.stderr);
    assert.deepEqual(seen.map((s) => s.path), [ACQUIRE, RELEASE]);
  });
}

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
  assert.deepEqual(shimWords(config), ['pnpm', 'docker']);
});

test('installCommandShims writes one executable shim per word into <home>/command-shims, and a save without a word deletes its file and keeps the rest (#800)', async (t) => {
  const home = await tempDir(t, 'home-');
  const dir = commandShimDir(home);
  assert.equal(dir, join(home, 'command-shims'));
  const both = commandsConfig(commandOf('test', line('pnpm test', 'memory')), commandOf('up', line('docker compose up', 'disk')));
  assert.deepEqual(await installCommandShims(home, both, 'darwin'), ['pnpm', 'docker']);
  assert.equal(await readFile(join(dir, 'pnpm'), 'utf8'), renderCommandShim(await readFile(commandShimSource(), 'utf8'), 'pnpm'));
  await assertMode(t, dir, 0o700);
  await assertMode(t, join(dir, 'pnpm'), 0o755);
  await writeFile(join(dir, 'stray'), 'left by an older version');
  await installCommandShims(home, commandsConfig(commandOf('up', line('docker compose up', 'disk'))), 'linux');
  assert.deepEqual(await readdir(dir), ['docker']);
});

test('installCommandShims on win32 writes nothing and answers no word: Windows has no command shim until node 5 of #704 (#800)', async (t) => {
  const home = await tempDir(t, 'home-');
  assert.deepEqual(await installCommandShims(home, commandsConfig(commandOf('test', line('pnpm test', 'memory'))), 'win32'), []);
  assert.equal(existsSync(commandShimDir(home)), false);
});

test('claudeEnvLine prepends the folder, quoted, to PATH and exports it (#800)', () => {
  assert.equal(claudeEnvLine("/h/it's"), "PATH='/h/it'\\''s':$PATH; export PATH\n");
});
