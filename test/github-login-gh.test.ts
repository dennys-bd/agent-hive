import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import { createGithubAdd, GH_ADD_TIMEOUT_MS, GH_LOGIN_ARGS, type GhLoginFs, type GithubAdd, scratchDir, type SpawnGh } from '../src/github-login-gh.js';
import type { Exec, GithubAddStatus } from '../src/types.js';
import { fakeLog } from './fakes.js';
import { assertMode } from './posix-only.js';
import { tempDir } from './temp-dir.js';

// Built at runtime, so no fixture holds a token-shaped literal
const TOKEN = `fake-gh-${randomUUID()}`;
const CODE = 'AB12-CD34';
const DEVICE_URL = 'https://github.com/login/device';
// What gh 2.97 prints on stderr before it waits (the spec's probe)
const PROMPT = `! First copy your one-time code: ${CODE}\nOpen this URL to continue in your web browser: ${DEVICE_URL}\n`;
const INHERITED = { GH_TOKEN: 'fake-inherited', GITHUB_TOKEN: 'fake-inherited', GH_ENTERPRISE_TOKEN: 'fake-inherited', GH_DEBUG: 'api', DEBUG: '1', KEEP: 'kept' };

// gh as a child of the daemon: the test writes its streams; kill() is counted and ends it as a signal would
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  kill(): boolean {
    this.kills += 1;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

interface Spawned { file: string; args: string[]; options: SpawnOptions; child: FakeChild; hadStale: boolean }
interface ExecCall { file: string; args: string[]; env: NodeJS.ProcessEnv }
interface Harness { add: GithubAdd; dir: string; spawned: Spawned[]; execs: ExecCall[]; stored: string[]; lines: string[] }
interface HarnessOptions { store?: (token: string) => Promise<string>; fs?: GhLoginFs; platform?: NodeJS.Platform }

// One add over a temp home and a fake gh; gh auth token answers what the scratch hosts.yml holds, and fails when there is none, as gh does
async function harness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const home = await tempDir(t, 'gh-add-');
  const dir = scratchDir(home);
  const { log, lines } = fakeLog();
  const spawned: Spawned[] = [];
  const execs: ExecCall[] = [];
  const stored: string[] = [];
  const spawn: SpawnGh = (file, args, spawnOptions) => {
    const child = new FakeChild();
    spawned.push({ file, args, options: spawnOptions, child, hadStale: existsSync(join(dir, 'stale')) });
    return child as unknown as ChildProcess;
  };
  const exec: Exec = async (file, args, opts) => {
    const env = opts?.env ?? {};
    execs.push({ file, args, env });
    const hosts = await readFile(join(env.GH_CONFIG_DIR ?? '', 'hosts.yml'), 'utf8');
    return { stdout: `${/oauth_token: (\S+)/.exec(hosts)?.[1] ?? ''}\n` };
  };
  const store = options.store ?? (async (token: string) => {
    stored.push(token);
    return 'alice';
  });
  const add = createGithubAdd({ spawn, exec, env: INHERITED, platform: options.platform ?? 'darwin', home, fs: options.fs ?? { mkdir, rm }, store, log });
  t.after(() => add.close());
  return { add, dir, spawned, execs, stored, lines };
}

// Turns the event loop until `check` holds; fails instead of hanging when it never does
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 10_000 && !check(); i += 1) await turn();
  assert.ok(check(), what);
}
const started = (h: Harness, count = 1): Promise<void> => until(() => h.spawned.length === count, 'gh was never spawned');
const ended = (h: Harness): Promise<void> => until(() => h.add.status().state !== 'pending', 'the add never left pending');
const gone = (h: Harness): Promise<void> => until(() => !existsSync(h.dir), 'the scratch dir was never removed');

// gh completing the login: the token in the scratch hosts.yml, where AuthConfig.Login writes it with --insecure-storage, then exit 0
async function login(gh: Spawned): Promise<void> {
  const hosts = `github.com:\n    users:\n        alice:\n            oauth_token: ${TOKEN}\n    oauth_token: ${TOKEN}\n    user: alice\n`;
  await writeFile(join(String(gh.options.env?.GH_CONFIG_DIR), 'hosts.yml'), hosts);
  gh.child.emit('exit', 0, null);
}

// Logins are not secrets; the token, the code, the URL and gh's words never reach a log line
function assertClean(h: Harness): void {
  for (const line of h.lines) {
    assert.ok(!line.includes(TOKEN), line);
    assert.ok(!line.includes(CODE), line);
    assert.ok(!line.includes('https://'), line);
  }
}

test('pending answers the code and the URL once gh printed them; after exit 0 the token is stored and the add is connected as store\'s login (#960)', async (t) => {
  const h = await harness(t);
  const seen: (GithubAddStatus | undefined)[] = [h.add.start()];
  assert.deepEqual(seen[0], { state: 'pending' });
  await started(h);
  const [gh] = h.spawned;
  await assertMode(t, h.dir, 0o700);
  gh.child.stderr.write(PROMPT);
  await until(() => JSON.stringify(h.add.status()).includes(DEVICE_URL), 'the code and the URL were never read');
  seen.push(h.add.status());
  assert.deepEqual(h.add.status(), { state: 'pending', code: CODE, url: DEVICE_URL });
  await login(gh);
  await ended(h);
  seen.push(h.add.status());
  assert.deepEqual(h.add.status(), { state: 'connected', login: 'alice' });
  assert.deepEqual(h.stored, [TOKEN]);
  await gone(h);
  for (const status of seen) assert.ok(!JSON.stringify(status).includes(TOKEN), 'no status holds the token');
  assert.ok(h.lines.includes('INFO github login add started'), h.lines.join('\n'));
  assert.ok(h.lines.includes('INFO github login add connected: alice'), h.lines.join('\n'));
  assertClean(h);
});

test('gh runs the fixed argv on pipes with stdin ignored; its env and gh auth token\'s carry the scratch GH_CONFIG_DIR and no inherited token (#960)', async (t) => {
  const h = await harness(t);
  h.add.start();
  await started(h);
  const [gh] = h.spawned;
  assert.equal(gh.file, 'gh');
  assert.deepEqual(gh.args, ['auth', 'login', '--web', '--insecure-storage', '--hostname', 'github.com', '--git-protocol', 'https']);
  assert.deepEqual([...GH_LOGIN_ARGS], gh.args);
  assert.deepEqual(gh.options.stdio, ['ignore', 'pipe', 'pipe']);
  await login(gh);
  await ended(h);
  assert.equal(h.execs.length, 1);
  assert.deepEqual([h.execs[0].file, h.execs[0].args], ['gh', ['auth', 'token', '--hostname', 'github.com']]);
  for (const env of [gh.options.env ?? {}, h.execs[0].env]) {
    assert.equal(env.GH_CONFIG_DIR, h.dir);
    assert.equal(env.GH_HOST, 'github.com');
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_DEBUG', 'DEBUG']) assert.equal(env[name], undefined, name);
    assert.equal(env.KEEP, 'kept', 'the rest of the daemon\'s env is kept');
  }
});

test('what a crash left in the scratch dir is removed before gh starts (#960)', async (t) => {
  const h = await harness(t);
  await mkdir(h.dir);
  await writeFile(join(h.dir, 'stale'), 'left by a crash');
  h.add.start();
  await started(h);
  assert.equal(h.spawned[0].hadStale, false);
  assert.ok(existsSync(h.dir), 'made again, empty');
});

test('a second start while one is pending answers undefined and spawns nothing (#960)', async (t) => {
  const h = await harness(t);
  h.add.start();
  await started(h);
  assert.equal(h.add.start(), undefined);
  for (let i = 0; i < 50; i += 1) await turn(); // room for a wrong second spawn
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].child.kills, 0);
  assert.deepEqual(h.add.status(), { state: 'pending' });
});

test('a non-zero exit answers failed exited with its code in the log, the dir goes, and the next add starts afresh (#960)', async (t) => {
  const h = await harness(t);
  h.add.start();
  await started(h);
  h.spawned[0].child.emit('exit', 1, null);
  assert.deepEqual(h.add.status(), { state: 'failed', reason: 'exited' });
  await gone(h);
  assert.ok(h.lines.includes('WARN github login add failed (exited, exit 1)'), h.lines.join('\n'));
  assert.deepEqual(h.add.start(), { state: 'pending' });
  await started(h, 2);
});

test('exit 0 with no token answers failed token and stores nothing (#960)', async (t) => {
  const h = await harness(t);
  h.add.start();
  await started(h);
  h.spawned[0].child.emit('exit', 0, null); // no hosts.yml: gh auth token fails
  await ended(h);
  assert.deepEqual(h.add.status(), { state: 'failed', reason: 'token' });
  assert.deepEqual(h.stored, []);
  await gone(h);
  assert.ok(h.lines.includes('WARN github login add failed (token, exit 0)'), h.lines.join('\n'));
});

test('a store that rejects answers failed store and logs its error, never the token (#960)', async (t) => {
  const h = await harness(t, { store: () => Promise.reject(new Error('viewer down')) });
  h.add.start();
  await started(h);
  await login(h.spawned[0]);
  await ended(h);
  assert.deepEqual(h.add.status(), { state: 'failed', reason: 'store' });
  await gone(h);
  assert.ok(h.lines.includes('ERROR github login add: not stored: viewer down'), h.lines.join('\n'));
  assert.ok(h.lines.includes('WARN github login add failed (store, exit 0)'), h.lines.join('\n'));
  assertClean(h);
});

test('cancel kills gh, answers cancelled and removes the dir; a late exit 0 reads no token (#960)', async (t) => {
  const h = await harness(t);
  h.add.start();
  await started(h);
  const [gh] = h.spawned;
  h.add.cancel();
  assert.equal(gh.child.kills, 1);
  assert.deepEqual(h.add.status(), { state: 'cancelled' });
  gh.child.emit('exit', 0, null);
  h.add.cancel(); // nothing pending: no change
  await gone(h);
  assert.deepEqual(h.add.status(), { state: 'cancelled' });
  assert.deepEqual(h.execs, []);
  assert.ok(h.lines.includes('INFO github login add cancelled'), h.lines.join('\n'));
});

test('a cancel before gh spawned spawns nothing and leaves no dir (#960)', async (t) => {
  const h = await harness(t);
  h.add.start();
  h.add.cancel();
  await h.add.close(); // settles once every queued step of the scratch dir has run
  assert.equal(h.spawned.length, 0);
  assert.equal(existsSync(h.dir), false);
  assert.deepEqual(h.add.status(), { state: 'cancelled' });
});

test('10 minutes pending kill gh, answer failed timeout and remove the dir (#960)', async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.add.start();
  await started(h);
  t.mock.timers.tick(GH_ADD_TIMEOUT_MS - 1);
  assert.equal(h.add.status().state, 'pending');
  t.mock.timers.tick(1);
  assert.equal(h.spawned[0].child.kills, 1);
  assert.deepEqual(h.add.status(), { state: 'failed', reason: 'timeout' });
  await gone(h);
  assert.equal(GH_ADD_TIMEOUT_MS, 600_000);
  assert.ok(h.lines.includes('WARN github login add failed (timeout)'), h.lines.join('\n'));
});

test('on win32 a gh found nowhere ends the add as failed exited, naming the spawn error (#960)', async (t) => {
  const h = await harness(t, { platform: 'win32' }); // INHERITED has no PATH: resolveExec finds no gh
  assert.deepEqual(h.add.start(), { state: 'pending' });
  await ended(h);
  assert.deepEqual(h.add.status(), { state: 'failed', reason: 'exited' });
  assert.equal(h.spawned.length, 0);
  await gone(h);
  assert.ok(h.lines.includes('WARN github login add failed (exited, spawn: gh was not found)'), h.lines.join('\n'));
});

test('a removal that fails is logged and never changes the status (#960)', async (t) => {
  let removals = 0;
  const fs: GhLoginFs = {
    mkdir,
    rm: async (path, options) => {
      removals += 1;
      if (removals > 1) throw new Error('busy'); // the start's removal works; every end's fails
      await rm(path, options);
    },
  };
  const h = await harness(t, { fs });
  h.add.start();
  await started(h);
  h.add.cancel();
  await until(() => h.lines.includes('WARN github login add: the scratch dir not removed: busy'), h.lines.join('\n'));
  assert.deepEqual(h.add.status(), { state: 'cancelled' });
});

test('close kills a pending gh and settles once the dir is gone (#960)', async (t) => {
  const h = await harness(t);
  h.add.start();
  await started(h);
  await h.add.close();
  assert.equal(h.spawned[0].child.kills, 1);
  assert.equal(existsSync(h.dir), false);
});

test('a close while the token is read after exit 0 stores nothing (#960)', async (t) => {
  const h = await harness(t);
  h.add.start();
  await started(h);
  await login(h.spawned[0]);
  await h.add.close();
  await until(() => h.execs.length === 1, 'gh auth token never ran');
  for (let i = 0; i < 20; i += 1) await turn();
  assert.deepEqual(h.stored, []);
});
