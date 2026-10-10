import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { acquireLock, readDaemonPort, readDaemonSecret, readLockPid, releaseLock, removeDaemonSecret, writeDaemonPort } from '../src/daemon-files.js';
import { bootHive } from '../src/hive.js';
import { SECRET_HEADER } from '../src/secret.js';
import { combConfig, getFreePort, LOCAL_STAGES, tempHive } from './fakes.js';
import { tempDir, type AfterHost } from './temp-dir.js';

// The daemon's port and lock in its home (#466), through the real boot: a Comb with no source on a temp git repo, zero workers, no gh, no claude.
async function hiveWithConfig(t: AfterHost): Promise<{ home: string; repo: string }> {
  const { home, repo } = await tempHive(t);
  await writeFile(join(home, 'hive.config.json'), JSON.stringify(combConfig({ stages: LOCAL_STAGES, path: repo, maxConcurrent: 0 })));
  return { home, repo };
}

test('in hive mode hooks.json names the port listen() bound, written after the bind (#466)', async (t) => {
  const { home } = await hiveWithConfig(t);
  const hive = await bootHive(home);
  t.after(() => hive.server.close());
  assert.notEqual(hive.port, 0);
  assert.match(await readFile(join(home, 'hooks.json'), 'utf8'), new RegExp(`127\\.0\\.0\\.1:${hive.port}/hooks/event`), 'every worker\'s hooks reach the daemon actually listening');
});

test('bootHive records the bound port in <home>/hive.port (0600), in hive mode and in setup mode (#466)', async (t) => {
  const { home } = await hiveWithConfig(t);
  const hive = await bootHive(home);
  t.after(() => hive.server.close());
  assert.equal(await readFile(join(home, 'hive.port'), 'utf8'), `${hive.port}\n`);
  assert.equal((await stat(join(home, 'hive.port'))).mode & 0o777, 0o600);

  const empty = await tempDir(t, 'boot-'); // nothing saved: setup mode, on a free port instead of a default one
  const setup = await bootHive(empty);
  t.after(() => setup.server.close());
  assert.equal(readDaemonPort(empty), setup.port);
});

test('bootHive tries the port hive.port names first; held by another listener, it binds a free one and rewrites the file (#466)', async (t) => {
  const { home } = await hiveWithConfig(t);
  const last = await getFreePort();
  writeDaemonPort(home, last);
  const kept = await bootHive(home);
  t.after(() => kept.server.close());
  assert.equal(kept.port, last, 'the last port: the board keeps its origin');

  const holder = createNetServer();
  await new Promise<void>((resolvePromise) => holder.listen(0, '127.0.0.1', () => resolvePromise()));
  t.after(() => holder.close());
  const taken = (holder.address() as AddressInfo).port;
  const { home: moved } = await hiveWithConfig(t);
  writeDaemonPort(moved, taken);
  const elsewhere = await bootHive(moved);
  t.after(() => elsewhere.server.close());
  assert.notEqual(elsewhere.port, taken);
  assert.equal(readDaemonPort(moved), elsewhere.port, 'the next client reads the new port');
});

test('bootHive takes <home>/hive.lock with its pid (0600); a second bootHive of the same home while the first runs is refused naming that pid; a boot that fails releases the lock and leaves the file (#466, #479)', async (t) => {
  const { home } = await hiveWithConfig(t);
  const first = await bootHive(home);
  t.after(() => first.server.close());
  const lock = join(home, 'hive.lock');
  assert.equal(await readFile(lock, 'utf8'), `${process.pid}\n`);
  assert.equal((await stat(lock)).mode & 0o777, 0o600);
  await assert.rejects(bootHive(home), { message: `Agent Hive já está em execução nesta home (pid ${process.pid})` });
  assert.equal(await readFile(lock, 'utf8'), `${process.pid}\n`, 'the refused boot leaves the running one\'s lock');

  const broken = await tempDir(t, 'boot-');
  await writeFile(join(broken, 'hive.config.json'), '{ not json');
  await assert.rejects(bootHive(broken), /JSON inválido/);
  await acquireLock(broken, () => undefined); // the failed boot let go: the next start takes the lock at once (#479)
  releaseLock(broken);
  assert.equal(await readFile(join(broken, 'hive.lock'), 'utf8'), `${process.pid}\n`, 'the file stays: only the lock went');
});

test('a hive.lock no process holds is taken over, whatever pid and age it names: a live pid in a file just written included (#466, #479)', async (t) => {
  const { home } = await hiveWithConfig(t);
  const lock = join(home, 'hive.lock');
  await writeFile(lock, '1\n'); // pid 1 exists on every machine and the file is young: the stale check of #466 would have refused it
  const taken = await bootHive(home);
  t.after(() => taken.server.close());
  assert.equal(await readFile(lock, 'utf8'), `${process.pid}\n`);
});

test('bootHive writes a new secret to <home>/hive.secret (0600) on every boot, in hive mode and in setup mode (#467)', async (t) => {
  const { home } = await hiveWithConfig(t);
  const first = await bootHive(home);
  t.after(() => first.server.close()); // a no-op after the close below; closes it when an assertion fails first
  const secret = readDaemonSecret(home);
  assert.notEqual(secret, undefined, '64 hex characters, written after the bind');
  assert.equal((await stat(join(home, 'hive.secret'))).mode & 0o777, 0o600);
  await first.server.close();
  releaseLock(home); // what run.ts does on a clean stop, so the same process can boot this home again
  const second = await bootHive(home);
  t.after(() => second.server.close());
  assert.notEqual(readDaemonSecret(home), secret, 'a new boot voids every old copy');

  const empty = await tempDir(t, 'boot-'); // nothing saved: setup mode
  const setup = await bootHive(empty);
  t.after(() => setup.server.close());
  assert.notEqual(readDaemonSecret(empty), undefined);
});

test('bootHive writes hive.secret only after the bind, next to hive.port: until then no client pairs the old port with the new secret (#467)', async (t) => {
  const { home } = await hiveWithConfig(t);
  const first = await bootHive(home);
  t.after(() => first.server.close());
  const oldPort = first.port;
  await first.server.close();
  removeDaemonSecret(home); // what run.ts does on a clean stop, before releaseLock
  releaseLock(home);
  await writeFile(join(home, 'hive.lock'), '0\n'); // hive.lock stays with the first boot's pid (#479): a pid nobody has shows when the next boot took it
  const booting = bootHive(home);
  t.after(async () => (await booting).server.close()); // closed even when an assertion below fails first
  do await tick(); while (readLockPid(home) !== process.pid); // the lock is taken and the boot went on; the bind is still ahead (agent detection)
  assert.equal(existsSync(join(home, 'hive.secret')), false, 'no secret while hive.port still names the old port');
  assert.equal(readDaemonPort(home), oldPort);
  const second = await booting;
  assert.notEqual(readDaemonSecret(home), undefined, 'written once the port is bound');
  assert.equal(readDaemonPort(home), second.port);
});

test('a boot refused by a live lock leaves the running daemon\'s hive.secret; a boot that fails after taking the lock leaves none (#467)', async (t) => {
  const { home } = await hiveWithConfig(t);
  const running = await bootHive(home);
  t.after(() => running.server.close());
  const secret = readDaemonSecret(home);
  await assert.rejects(bootHive(home), { message: `Agent Hive já está em execução nesta home (pid ${process.pid})` });
  assert.equal(readDaemonSecret(home), secret, 'the refused boot never wrote');

  const broken = await tempDir(t, 'boot-');
  await writeFile(join(broken, 'hive.config.json'), '{ not json');
  await assert.rejects(bootHive(broken), /JSON inválido/);
  assert.equal(existsSync(join(broken, 'hive.secret')), false, 'a failed boot leaves no secret');
});

test('bootHive hands the server the secret it wrote: a request with hive.secret\'s value passes, one without it gets 403 (#467)', async (t) => {
  const { home } = await hiveWithConfig(t);
  const hive = await bootHive(home);
  t.after(() => hive.server.close());
  const url = `http://127.0.0.1:${hive.port}/ptys`;
  assert.equal((await fetch(url, { headers: { [SECRET_HEADER]: readDaemonSecret(home) ?? '' } })).status, 200);
  assert.equal((await fetch(url)).status, 403);
});
