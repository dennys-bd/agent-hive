import { after, type TestContext, test } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MachineError, type RunSpec } from '../src/machine.js';
import { createPtyHost } from '../src/pty-host.js';
import { helperHash, INSTALL_LINE, PROBE_LINE } from '../src/wsl/helper-install.js';
import { SPAWN_LINE } from '../src/wsl/helper-link.js';
import { createWslMachine, type WslMachine, type WslMachineDeps, wslFactory } from '../src/wsl/wsl-machine.js';
import { buildHelperBundle, DISTRO, fakeWslDeps, MUTE_HELPER } from './fake-distro.js';
import { fakeMachine } from './fake-machine.js';
import { fakePtys } from './fakes.js';
import { tempDir } from './temp-dir.js';

const BUNDLE = await buildHelperBundle({ after });
const TOKEN = 'fake-token-945';
const SECRET = '0'.repeat(64); // hive.secret's header takes 64 hex characters
const MUTE_TIMEOUT_MS = 3_000; // over the probe and the install on the slowest lane, so the wait that times out is the hello's
const GH_SCRIPT = 'process.stdout.write((process.env.GH_TOKEN ?? "unset") + "|" + (process.env.PATH === undefined ? "no path" : "path"))\n';
const PENDING_SCRIPT = 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume();'; // ends with the helper, whose pipe it holds

interface Rig {
  deps: WslMachineDeps; home: string; folder: string; argv: string[][]; logs: string[];
  children: { args: readonly string[]; child: ChildProcess }[]; fakePty: ReturnType<typeof fakePtys>;
}

// The machine's deps over the fake wsl.exe, with every argv it ran and every child and log line it made
async function rigDeps(t: TestContext, over: Partial<WslMachineDeps> = {}, home?: string): Promise<Rig> {
  const distroHome = home ?? (await tempDir(t, 'wsl-distro-'));
  const wsl = fakeWslDeps(distroHome);
  const argv: string[][] = [];
  const children: Rig['children'] = [];
  const logs: string[] = [];
  const fakePty = fakePtys();
  const deps: WslMachineDeps = {
    ...wsl,
    run: (file, args, opts) => { argv.push([file, ...args]); return wsl.run(file, args, opts); },
    spawn: (file, args, opts) => {
      argv.push([file, ...args]);
      const child = spawn(file, args, opts);
      children.push({ args, child });
      return child;
    },
    helperFile: BUNDLE, node: process.execPath, hivePort: () => 1, secret: SECRET, shimWords: () => [], language: () => 'en',
    plugins: { dir: () => distroHome }, host: fakeMachine(), ptys: createPtyHost(fakePty.spawnPty), hostCwd: distroHome,
    lend: async () => TOKEN, log: (line) => logs.push(line), ...over,
  };
  return { deps, home: distroHome, folder: join(distroHome, '.config', 'agent-hive', 'wsl'), argv, children, logs, fakePty };
}

async function rig(t: TestContext, over: Partial<WslMachineDeps> = {}, home?: string): Promise<Rig & { machine: WslMachine }> {
  const r = await rigDeps(t, over, home);
  const machine = createWslMachine(DISTRO, r.deps);
  t.after(() => machine.close());
  return { ...r, machine };
}

const refusedWith = (reason: string) => (err: unknown): boolean =>
  err instanceof MachineError && err.code === MachineError.UNAVAILABLE && err.reason === reason;
const spawnedWith = (r: Rig, line: string): ChildProcess[] => r.children.filter((c) => c.args.includes(line)).map((c) => c.child);
const probes = (r: Rig): number => r.argv.filter((a) => a.includes(PROBE_LINE)).length;
const helperFiles = async (folder: string): Promise<string[]> => (await readdir(folder).catch(() => [])).filter((n) => n.startsWith('helper-'));
const exitOf = (child: ChildProcess | undefined): Promise<void> =>
  child === undefined || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve()));

test('the first call probes, installs the helper once in place of any other, starts it and answers; a second call starts nothing (#945)', async (t) => {
  const first = await rigDeps(t);
  await mkdir(first.folder, { recursive: true });
  await writeFile(join(first.folder, 'helper-0000000000000000.mjs'), 'an older helper');
  const machine = createWslMachine(DISTRO, first.deps);
  t.after(() => machine.close());
  assert.equal((await machine.fs.stat(first.home)).isDirectory(), true);
  assert.deepEqual(await helperFiles(first.folder), [`helper-${helperHash(await readFile(BUNDLE))}.mjs`]);
  await machine.fs.stat(first.home);
  assert.deepEqual([spawnedWith(first, INSTALL_LINE).length, spawnedWith(first, SPAWN_LINE).length, probes(first)], [1, 1, 1]);
  const second = await rig(t, {}, first.home);
  await second.machine.fs.stat(second.home);
  assert.deepEqual([spawnedWith(second, INSTALL_LINE).length, spawnedWith(second, SPAWN_LINE).length], [0, 1], 'the hash is there: nothing copied');
});

test('a distro with no node rejects with node_missing, one with node 20 with node_old; neither copies the helper, and the next call probes again (#945)', async (t) => {
  const missing = await rig(t, { node: 'no-such-node-945' });
  await assert.rejects(missing.machine.fs.stat(missing.home), refusedWith('node_missing'));
  await assert.rejects(missing.machine.exec('ls', []), refusedWith('node_missing'));
  assert.equal(probes(missing), 2, 'a failed start leaves nothing behind');
  const old = join(await tempDir(t, 'wsl-node-'), 'node');
  await writeFile(old, '#!/bin/sh\necho 20.11.0\n');
  await chmod(old, 0o755);
  const aged = await rig(t, { node: old });
  await assert.rejects(aged.machine.fs.stat(aged.home), refusedWith('node_old'));
  for (const r of [missing, aged]) assert.deepEqual([spawnedWith(r, INSTALL_LINE).length, await helperFiles(r.folder)], [0, []]);
});

test('a watch on a machine whose start fails reports the reason through onError, once, and no event (#945)', async (t) => {
  const r = await rig(t, { node: 'no-such-node-945' });
  const errors = await new Promise<unknown[]>((resolve) => {
    const seen: unknown[] = [];
    r.machine.watch(r.home, { recursive: false }, () => assert.fail('no event'), (err) => { seen.push(err); resolve(seen); });
  });
  assert.equal(errors.length, 1);
  assert.ok(refusedWith('node_missing')(errors[0]));
});

test('the helper ending rejects a pending call with machine_unavailable; the next call starts it again on the same relay port (#945)', async (t) => {
  const r = await rig(t);
  await r.machine.fs.stat(r.home);
  const port = await readFile(join(r.folder, 'relay-port'), 'utf8');
  const hooks = await readFile(join(r.folder, 'hooks.json'), 'utf8');
  const pending = r.machine.exec(process.execPath, ['-e', PENDING_SCRIPT]);
  await new Promise((resolve) => setImmediate(resolve)); // the request is on the wire
  spawnedWith(r, SPAWN_LINE)[0]?.kill();
  await assert.rejects(pending, (err: unknown) => err instanceof MachineError && err.code === MachineError.UNAVAILABLE);
  await r.machine.fs.stat(r.home);
  assert.equal(spawnedWith(r, SPAWN_LINE).length, 2);
  assert.equal(await readFile(join(r.folder, 'relay-port'), 'utf8'), port);
  assert.equal(await readFile(join(r.folder, 'hooks.json'), 'utf8'), hooks, 'hooks.json still names the same relay port');
});

test('an exec through the machine sees the lent GH_TOKEN and its PATH, a caller\'s own GH_TOKEN wins, and the token is in no argv and no log line (#945)', async (t) => {
  const r = await rig(t);
  const gh = join(r.home, 'gh.js');
  await writeFile(gh, GH_SCRIPT);
  assert.equal((await r.machine.exec(process.execPath, [gh])).stdout, `${TOKEN}|path`);
  assert.equal((await r.machine.exec(process.execPath, [gh], { env: { GH_TOKEN: 'caller-945' } })).stdout, 'caller-945|path');
  assert.ok(!r.argv.flat().some((arg) => arg.includes(TOKEN)), 'no argv wsl.exe got');
  assert.ok(!r.logs.some((line) => line.includes(TOKEN)), 'no log line');
});

test('a lend that rejects lets the call through without GH_TOKEN, and the log says there was none (#945)', async (t) => {
  const r = await rig(t, { lend: async () => { throw new Error('no GitHub token'); } });
  const gh = join(r.home, 'gh.js');
  await writeFile(gh, GH_SCRIPT);
  assert.equal((await r.machine.exec(process.execPath, [gh])).stdout, 'unset|path');
  assert.ok(r.logs.includes(`wsl ${DISTRO}: no GitHub token to lend`), r.logs.join('\n'));
});

test('close() ends the helper, and a call after it rejects with closed and spawns nothing (#945)', async (t) => {
  const r = await rig(t);
  await r.machine.fs.stat(r.home);
  const helper = spawnedWith(r, SPAWN_LINE)[0];
  r.machine.close();
  await exitOf(helper);
  const spawned = r.children.length;
  await assert.rejects(r.machine.fs.stat(r.home), refusedWith('closed'));
  assert.deepEqual([r.children.length, probes(r)], [spawned, 1]);
});

test('info() after close() throws closed, both before the first hello and after one (#945)', async (t) => {
  const fresh = await rig(t);
  fresh.machine.close();
  assert.throws(() => fresh.machine.info(), refusedWith('closed'));
  assert.equal(fresh.children.length, 0, 'nothing started');
  const r = await rig(t);
  await r.machine.fs.stat(r.home);
  r.machine.close();
  assert.throws(() => r.machine.info(), refusedWith('closed'));
});

test('close() between the first call and its hello rejects the call with closed, and the helper\'s child is gone (#945)', async (t) => {
  const mute = join(await tempDir(t, 'wsl-mute-'), 'mute.mjs');
  await writeFile(mute, MUTE_HELPER);
  const r = await rig(t, { helperFile: mute, helloTimeoutMs: MUTE_TIMEOUT_MS * 10 });
  const call = r.machine.fs.stat(r.home);
  while (spawnedWith(r, SPAWN_LINE).length === 0) await new Promise((resolve) => setTimeout(resolve, 10)); // the start is in the hello's wait
  r.machine.close();
  await assert.rejects(call, refusedWith('closed'));
  const [helper] = spawnedWith(r, SPAWN_LINE);
  await exitOf(helper);
  assert.ok(helper && (helper.exitCode !== null || helper.signalCode !== null), 'the helper\'s wsl.exe ended');
});

test('close() after the hello but before the start is adopted rejects the call with closed, and the helper\'s child is gone (#945)', async (t) => {
  let machine: WslMachine | undefined;
  // shimWords is read while the Hive's folder is prepared, after the hello and before adopt
  const r = await rigDeps(t, { shimWords: () => { machine?.close(); return []; } });
  machine = createWslMachine(DISTRO, r.deps);
  t.after(() => machine?.close());
  await assert.rejects(machine.fs.stat(r.home), refusedWith('closed'));
  const [helper] = spawnedWith(r, SPAWN_LINE);
  await exitOf(helper);
  assert.ok(helper && (helper.exitCode !== null || helper.signalCode !== null), 'the helper\'s wsl.exe ended');
});

test('info() before the first hello throws starting and starts the helper; after it, the helper\'s facts (#945)', async (t) => {
  const r = await rig(t);
  assert.throws(() => r.machine.info(), refusedWith('starting'));
  await r.machine.fs.stat(r.home);
  assert.equal(r.machine.info().platform, process.platform);
  assert.equal(spawnedWith(r, SPAWN_LINE).length, 1, 'info\'s start and the stat shared one');
});

test('a helper that never says hello fails the start with helper_failed once the timeout passes, and its child is killed (#945)', async (t) => {
  const mute = join(await tempDir(t, 'wsl-mute-'), 'mute.mjs');
  await writeFile(mute, MUTE_HELPER);
  const r = await rig(t, { helperFile: mute, helloTimeoutMs: MUTE_TIMEOUT_MS });
  await assert.rejects(r.machine.fs.stat(r.home), refusedWith('helper_failed'));
  const [helper] = spawnedWith(r, SPAWN_LINE);
  assert.ok(helper, 'the start reached the hello\'s wait');
  await exitOf(helper);
  assert.equal(helper.killed, true);
});

const HANDLERS = { onExit: (): void => {}, onError: (): void => {} };
const terminal = (ptyId: string, cwd: string, more: Partial<RunSpec> = {}): RunSpec => ({ ptyId, slug: 'hive-945', workspace: 'w', cwd, terminal: true, ...more });

test('a pty through the machine starts once the helper has, with GH_TOKEN in its lent env and in no argv; a caller\'s own lent value wins (#945)', async (t) => {
  const r = await rig(t);
  await r.machine.pty.spawn(terminal('P945', r.home), HANDLERS).started;
  await r.machine.pty.spawn(terminal('P946', r.home, { lent: { GH_TOKEN: 'caller-945' } }), HANDLERS).started;
  const [lent, own] = r.fakePty.ptys;
  assert.ok(lent && own);
  assert.equal(lent.options.env.GH_TOKEN, TOKEN);
  assert.ok(String(lent.options.env.WSLENV).split(':').includes('GH_TOKEN'));
  assert.equal(own.options.env.GH_TOKEN, 'caller-945');
  assert.ok(![lent, own].some((p) => [p.file, ...p.args].some((arg) => arg.includes(TOKEN))));
  assert.equal(r.machine.pty.pid('P945'), undefined);
  for (const pty of r.fakePty.ptys) pty.exit(0);
});

test('a pty on a machine whose start fails rejects started with the reason, and its kill resolves (#945)', async (t) => {
  const r = await rig(t, { node: 'no-such-node-945' });
  const handle = r.machine.pty.spawn(terminal('P947', r.home), HANDLERS);
  await assert.rejects(handle.started, refusedWith('node_missing'));
  await handle.kill();
  assert.equal(r.fakePty.ptys.length, 0);
});

test('wslFactory hands no factory off win32, and on win32 a machine per distro that starts nothing until a call (#945)', async (t) => {
  const r = await rigDeps(t);
  assert.equal(wslFactory('darwin', r.deps), undefined);
  assert.equal(wslFactory('linux', r.deps), undefined);
  const machine = wslFactory('win32', r.deps)?.('Ubuntu-24.04');
  t.after(() => machine?.close());
  assert.equal(machine?.id, 'wsl:Ubuntu-24.04');
  assert.deepEqual([r.argv.length, r.children.length], [0, 0]);
});
