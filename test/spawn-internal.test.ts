import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { posixShell } from '../src/posix-shell.js';
import { createPtyHost } from '../src/pty-host.js';
import { ptyCommand, runTmpDir } from '../src/spawn.js';
import { launchInternalPty } from '../src/spawn-internal.js';
import { fakePtys, LAUNCH } from './fakes.js';
import { tempDir } from './temp-dir.js';

const SECRET_FILE_PATH = '/home/agent-hive/hive.secret';

function handlers() {
  const errors: string[] = [];
  let exits = 0;
  return { errors, exits: () => exits, handlers: { onError: (m: string) => errors.push(m), onExit: () => { exits += 1; } } };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const MODE_MASK = 0o777;
const POLL_TRIES = 100;
const POLL_MS = 10;
const STRAGGLER_MS = 200;
const STRAGGLER_WRITERS = 4;
const STRAGGLER_POLL_TRIES = 600; // the removal's retries span ~5.5 s; a loaded machine can push the good one late

// The runs' temp base for one test (#428): os.tmpdir() reads TMPDIR on every call, TEMP and TMP on win32 (#644), so every hive-runs/ this
// test makes lands in a dir the test removes. Put back after the test, as claudeConfigDir does in server.test.ts.
const TEMP_NAMES = ['TMPDIR', 'TEMP', 'TMP'] as const;
async function runsBase(t: TestContext): Promise<string> {
  const base = await tempDir(t, 'runs-');
  const previous = TEMP_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of TEMP_NAMES) process.env[name] = base;
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return base;
}

// Polls until `check` holds: the run's dir is removed after the exit is reported, never awaited by it.
async function eventually(check: () => boolean, maxTries = POLL_TRIES): Promise<void> {
  for (let tries = 0; tries < maxTries && !check(); tries += 1) await sleep(POLL_MS);
  assert.ok(check(), 'never happened');
}

test('launchInternalPty runs ptyCommand through the POSIX shell in the pty host, in the worktree with the worker env; started resolves once the pty exists (#251)', async (t) => {
  await runsBase(t);
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  const handle = launchInternalPty(LAUNCH, handlers().handlers, { ptys: host, secretFile: SECRET_FILE_PATH });
  await handle.started;
  const [pty] = ptys;
  assert.deepEqual([pty.file, pty.args, pty.options.cwd], [posixShell().shell, ['-c', ptyCommand(LAUNCH)], LAUNCH.cwd]);
  assert.deepEqual([pty.options.env.HIVE_PTY_ID, pty.options.env.HIVE_PORT, pty.options.env.HIVE_SECRET_FILE, pty.options.env.HIVE_SECRET, pty.options.env.CLAUDECODE], ['W1', '4242', SECRET_FILE_PATH, undefined, undefined]);
  assert.ok(pty.args[1].includes('-H @"$HIVE_SECRET_FILE"'), 'curl reads the header from the file: only its path is ever in an argv (#467)');
  assert.ok(!pty.args[1].includes('$HIVE_SECRET"'), 'no shell expands the secret into curl\'s argv, which every account reads through ps');
  assert.equal(host.has('W1'), true);
});

test('launchInternalPty reports the exit once: kill resolves on the pty\'s exit, a second kill is the same kill, and a pty that exits on its own needs no kill (#251)', async (t) => {
  await runsBase(t);
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  const h = handlers();
  const handle = launchInternalPty(LAUNCH, h.handlers, { ptys: host, secretFile: SECRET_FILE_PATH });
  await handle.started;
  let killed = false;
  const kill = handle.kill().then(() => { killed = true; });
  await tick();
  assert.deepEqual([ptys[0].killed, killed, h.exits()], [1, false, 0], 'the pty has not exited yet');
  ptys[0].exit();
  await kill;
  assert.equal(h.exits(), 1);
  await handle.kill();
  assert.deepEqual([ptys[0].killed, h.exits()], [1, 1], 'the first kill is the kill');
  const natural = handlers();
  const other = launchInternalPty({ ...LAUNCH, ptyId: 'W2' }, natural.handlers, { ptys: host, secretFile: SECRET_FILE_PATH });
  await other.started;
  ptys[1].exit();
  await other.kill();
  assert.deepEqual([ptys[1].killed, natural.exits()], [0, 1], 'gone already: nothing to kill');
});

test('launchInternalPty rejects started with the pty message when the pty cannot spawn, or without a host, and never reports an exit (#251)', async (t) => {
  await runsBase(t);
  const h = handlers();
  const failing = createPtyHost(() => { throw new Error('posix_spawnp failed'); });
  await assert.rejects(launchInternalPty(LAUNCH, h.handlers, { ptys: failing, secretFile: SECRET_FILE_PATH }).started, { message: 'pty: posix_spawnp failed' });
  await eventually(() => !existsSync(runTmpDir('W1'))); // made for a run that never started, and removed (#428)
  const bare = launchInternalPty(LAUNCH, h.handlers);
  await assert.rejects(bare.started, { message: 'pty: no pty host' });
  await bare.kill(); // a run that never started has nothing to kill
  assert.deepEqual([h.exits(), h.errors], [0, []]);
});

test('launchInternalPty gives the run a TMPDIR of its own: <tmpdir>/hive-runs/<ptyId>, mode 0o700, there when the pty spawns, gone with what the run wrote once it exits (#428)', async (t) => {
  const base = await runsBase(t);
  const dir = join(base, 'hive-runs', 'W1');
  const { spawnPty, ptys } = fakePtys();
  let modeAtSpawn: number | undefined;
  const host = createPtyHost((file, args, options) => {
    modeAtSpawn = statSync(dir).mode & MODE_MASK;
    return spawnPty(file, args, options);
  });
  const h = handlers();
  await launchInternalPty(LAUNCH, h.handlers, { ptys: host, secretFile: SECRET_FILE_PATH }).started;
  // Windows has no POSIX mode bits: stat reports 0o666 whatever mkdir was asked
  if (process.platform !== 'win32') assert.equal(modeAtSpawn, 0o700);
  assert.equal(ptys[0].options.env.TEMP, process.platform === 'win32' ? dir : process.env.TEMP, 'TEMP is the run\'s own on win32 only (#644)');
  assert.equal(ptys[0].options.env.TMPDIR, dir);
  await writeFile(join(dir, 'left-by-a-test-run.txt'), 'x');
  ptys[0].exit();
  await eventually(() => !existsSync(dir));
  assert.deepEqual([h.exits(), h.errors], [1, []]);
});

// A process of the run outliving the pty, as node flushing its compile cache does: it keeps adding files to cache/ for `ms`. A write
// into a dir already removed fails and is dropped, so the writer never brings the dir back.
async function keepWriting(cache: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  const writer = async (w: number): Promise<void> => {
    for (let n = 0; Date.now() < until; n += 1) await writeFile(join(cache, `f${w}-${n}`), 'x').catch(() => undefined);
  };
  await Promise.all(Array.from({ length: STRAGGLER_WRITERS }, (_, w) => writer(w)));
}

test('launchInternalPty still removes a TMPDIR a straggler of the run keeps writing to after the exit, with no error (#495)', async (t) => {
  const base = await runsBase(t);
  const cache = join(base, 'hive-runs', 'W1', 'node-compile-cache');
  const { spawnPty, ptys } = fakePtys();
  const h = handlers();
  await launchInternalPty(LAUNCH, h.handlers, { ptys: createPtyHost(spawnPty), secretFile: SECRET_FILE_PATH }).started;
  await mkdir(cache);
  const writing = keepWriting(cache, STRAGGLER_MS);
  await sleep(POLL_MS); // the straggler is mid-write when the pty exits
  ptys[0].exit();
  await writing;
  await eventually(() => !existsSync(join(base, 'hive-runs', 'W1')), STRAGGLER_POLL_TRIES);
  assert.deepEqual([h.exits(), h.errors], [1, []]);
});

test('launchInternalPty reports a TMPDIR it cannot remove as tmp: <message> on onError, and the exit still once (#428)', { skip: process.platform === 'win32' && 'POSIX permissions: on Windows a read-only mode on a dir does not stop its entries being removed' }, async (t) => {
  const base = await runsBase(t);
  const runs = join(base, 'hive-runs');
  const { spawnPty, ptys } = fakePtys();
  const h = handlers();
  await launchInternalPty(LAUNCH, h.handlers, { ptys: createPtyHost(spawnPty), secretFile: SECRET_FILE_PATH }).started;
  await chmod(runs, 0o500); // no entry of hive-runs/ can be removed now
  t.after(() => chmod(runs, 0o700)); // runs before tempDir's removal of the base
  ptys[0].exit();
  await eventually(() => h.errors.length > 0);
  assert.match(h.errors[0], /^tmp: /);
  assert.equal(existsSync(join(runs, 'W1')), true);
  assert.equal(h.exits(), 1);
});

test('launchInternalPty rejects started with pty: when the run\'s TMPDIR cannot be made, spawns no pty and reports nothing else (#428)', async (t) => {
  const base = await runsBase(t);
  await writeFile(join(base, 'hive-runs'), 'a file where the dir should go');
  const { spawnPty, ptys } = fakePtys();
  const h = handlers();
  await assert.rejects(launchInternalPty(LAUNCH, h.handlers, { ptys: createPtyHost(spawnPty), secretFile: SECRET_FILE_PATH }).started, { message: /^pty: / });
  await tick();
  assert.deepEqual([ptys.length, h.exits(), h.errors], [0, 0, []], 'no run on the shared temp dir, and no removal of a path never made');
});

test('a terminal\'s launch reaches the pty with its own env over the worker env, and its ring goes to its log as it ends (#696)', async (t) => {
  await runsBase(t);
  const log = join(await tempDir(t, 'ring-'), 'W1.log');
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  const launch = { ...LAUNCH, terminal: true as const, env: { HISTFILE: '/h/terminals/W1.history' }, keep: { log } };
  await launchInternalPty(launch, handlers().handlers, { ptys: host, secretFile: SECRET_FILE_PATH }).started;
  const [pty] = ptys;
  assert.deepEqual([pty.options.env.HISTFILE, pty.options.env.HIVE_PTY_ID], ['/h/terminals/W1.history', 'W1']);
  pty.emit('$ ls\r\n');
  pty.exit();
  assert.equal(await readFile(log, 'utf8'), '$ ls\r\n');
});

test('launchInternalPty spawns the pty at the launch\'s size, the grid the page asked for (#808)', async (t) => {
  await runsBase(t);
  const { spawnPty, ptys } = fakePtys();
  await launchInternalPty({ ...LAUNCH, size: { cols: 132, rows: 41 } }, handlers().handlers, { ptys: createPtyHost(spawnPty), secretFile: SECRET_FILE_PATH }).started;
  assert.deepEqual([ptys[0].options.cols, ptys[0].options.rows], [132, 41]);
});
