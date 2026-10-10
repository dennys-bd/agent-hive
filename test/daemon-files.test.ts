import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { acquireLock, LOCK_FILE, lockHelper, pidExists, PORT_FILE, readDaemonPort, readDaemonSecret, readLockPid, releaseLock, removeDaemonSecret, SECRET_FILE, writeDaemonPort, writeDaemonSecret } from '../src/daemon-files.js';
import { newSecret } from '../src/secret.js';
import { tempDir } from './temp-dir.js';
import { NO_PROCESS_LIST } from './process-list.js';

// A pid no process holds: a child that already exited, as a crashed daemon's pid looks to its lock
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid;
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
const noop = (): void => undefined;
const MODULE = new URL('../src/daemon-files.js', import.meta.url).href;
const FREE_MS = 5000; // a killed holder's cat reads its EOF within milliseconds; past this the takeover failed
const RETRY_MS = 20;

// Takes the lock for the test and releases it after the test, so no helper outlives the test that started it (#479)
async function hold(t: TestContext, home: string, onLost: (status: string) => void = noop): Promise<void> {
  await acquireLock(home, onLost);
  t.after(() => releaseLock(home));
}

// A daemon that crashed while holding its home (#479): a child takes the lock, says so, and is killed with SIGKILL
async function crashedHolder(home: string): Promise<void> {
  const script = `const { acquireLock } = await import(${JSON.stringify(MODULE)}); await acquireLock(process.argv[1], () => {}); console.log('taken'); setInterval(() => {}, 60_000);`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', script, home], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exit = once(holder, 'exit');
  const first = await Promise.race([once(holder.stdout, 'data'), exit.then(() => undefined)]);
  assert.ok(first !== undefined, 'the holder exited before it took the lock');
  assert.equal(String(first[0]).trim(), 'taken');
  holder.kill('SIGKILL');
  await exit;
}

// Two acquireLock calls started together. The dead holder's cat lets go a moment after the kill, and until then both are refused, so the
// pair is tried again until one resolves
async function racePair(home: string): Promise<PromiseSettledResult<void>[]> {
  const deadline = Date.now() + FREE_MS;
  for (;;) {
    const results = await Promise.allSettled([acquireLock(home, noop), acquireLock(home, noop)]);
    const held = results.every((r) => r.status === 'rejected' && /já está em execução/.test(String(r.reason)));
    if (!held || Date.now() > deadline) return results; // any other refusal is a real failure, shown at once
    await sleep(RETRY_MS);
  }
}

// The lock helpers among this process's children: their argv names the lock, which is unique to the temp home. cat is a grandchild
async function helperPids(lock: string): Promise<number[]> {
  const { stdout } = await promisify(execFile)('pgrep', ['-P', String(process.pid), '-f', lock]);
  return stdout.trim().split('\n').map(Number);
}

test('writeDaemonPort then readDaemonPort gives the port back, 0600 and no temp file left; a missing, garbage or out-of-range file reads undefined (#466)', async (t) => {
  const home = await tempDir(t, 'files-');
  assert.equal(readDaemonPort(home), undefined, 'no file: no daemon');
  writeDaemonPort(home, 51234);
  assert.equal(readDaemonPort(home), 51234);
  assert.equal(await readFile(join(home, PORT_FILE), 'utf8'), '51234\n');
  assert.equal(await mode(join(home, PORT_FILE)), 0o600);
  assert.deepEqual(await readdir(home), [PORT_FILE], 'the temp file was renamed over it');
  for (const text of ['', 'abc', '12ab', '-1', '0', '70000', '1.5']) {
    await writeFile(join(home, PORT_FILE), text);
    assert.equal(readDaemonPort(home), undefined, JSON.stringify(text));
  }
});

test('acquireLock on an empty home creates hive.lock with this pid, mode 0600 (#466, #479)', async (t) => {
  const home = await tempDir(t, 'files-');
  await hold(t, home);
  assert.equal(await readFile(join(home, LOCK_FILE), 'utf8'), `${process.pid}\n`);
  assert.equal(await mode(join(home, LOCK_FILE)), 0o600);
});

test('while acquireLock holds a home, a second acquireLock of it in the same process is refused naming the holder\'s pid, and the file is left as it was (#479)', async (t) => {
  const home = await tempDir(t, 'files-');
  await hold(t, home);
  await assert.rejects(acquireLock(home, noop), { message: `Agent Hive já está em execução nesta home (pid ${process.pid})` });
  assert.equal(await readFile(join(home, LOCK_FILE), 'utf8'), `${process.pid}\n`, 'a second open file description conflicts under flock');
});

test('the takeover of #479: a lock left by a holder killed with SIGKILL is taken by the next acquireLock, and of two started together exactly one resolves', async (t) => {
  const home = await tempDir(t, 'files-');
  await crashedHolder(home);
  assert.notEqual(readLockPid(home), process.pid, 'the dead holder\'s pid is still in the file');
  const results = await racePair(home);
  t.after(() => releaseLock(home));
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.match(String(refused?.reason), /Agent Hive já está em execução nesta home/);
  assert.equal(readLockPid(home), process.pid, 'the winner wrote its pid');
});

test('acquireLock refuses a symlink at hive.lock and leaves its target untouched (#466, #479)', async (t) => {
  const home = await tempDir(t, 'files-');
  const target = join(home, 'elsewhere');
  await writeFile(target, 'keep\n');
  await symlink(target, join(home, LOCK_FILE));
  await assert.rejects(acquireLock(home, noop), { message: `${join(home, LOCK_FILE)} não é um arquivo comum` });
  assert.equal(await readFile(target, 'utf8'), 'keep\n');
});

test('releaseLock frees the home at once for the next acquireLock and leaves hive.lock with its pid; a home this process does not hold is left alone (#479)', async (t) => {
  const home = await tempDir(t, 'files-');
  const lock = join(home, LOCK_FILE);
  releaseLock(home);
  assert.equal(existsSync(lock), false, 'nothing held: nothing touched');
  await writeFile(lock, '4242\n');
  releaseLock(home);
  assert.equal(await readFile(lock, 'utf8'), '4242\n', 'another process\'s pid, and no helper of this one');
  const lost: string[] = [];
  await acquireLock(home, (status) => lost.push(status));
  releaseLock(home);
  assert.equal(await readFile(lock, 'utf8'), `${process.pid}\n`, 'kept: an unlinked lock would let two launches lock two inodes');
  await hold(t, home); // right away: acquireLock waits for the released helper to exit
  assert.deepEqual(lost, [], 'a release is not a lost lock');
});

test('a helper killed while it holds the lock calls onLost with its status (#479)', { skip: NO_PROCESS_LIST }, async (t) => {
  const home = await tempDir(t, 'files-');
  let reportLost: (status: string) => void = noop;
  const lost = new Promise<string>((resolve) => { reportLost = resolve; });
  await hold(t, home, (status) => reportLost(status));
  const pids = await helperPids(join(home, LOCK_FILE));
  assert.equal(pids.length, 1, 'one helper holds the home');
  process.kill(pids[0], 'SIGKILL');
  assert.equal(await lost, 'SIGKILL');
});

test('a helper that exits before taking the lock for any reason but a holder is a boot error naming its status (#479)', async (t) => {
  const home = await tempDir(t, 'files-');
  const lock = join(home, LOCK_FILE);
  await writeFile(lock, '');
  await chmod(lock, 0); // a plain file to lstat, but the helper cannot open it
  const [tool] = lockHelper(process.platform, lock);
  const prefix = `Agent Hive não pegou ${lock}: ${tool} saiu com `;
  await assert.rejects(acquireLock(home, noop), (err: Error) => {
    assert.ok(err.message.startsWith(prefix), err.message);
    assert.match(err.message.slice(prefix.length), /^\d+$/);
    assert.notEqual(err.message.slice(prefix.length), '75', 'nobody holds it');
    return true;
  });
});

test('pidExists: true for this process and for another user\'s (EPERM), false for one that exited (#466)', () => {
  assert.equal(pidExists(process.pid), true);
  assert.equal(pidExists(1), true, 'launchd: EPERM for this user, alive all the same');
  assert.equal(pidExists(deadPid()), false);
});

test('lockHelper: lockf on darwin and flock with -E 75 on linux, both without waiting and keeping the file; any other platform is refused naming it (#479)', () => {
  assert.deepEqual(lockHelper('darwin', '/h/hive.lock'), ['/usr/bin/lockf', ['-k', '-s', '-t', '0', '/h/hive.lock', '/bin/cat']]);
  assert.deepEqual(lockHelper('linux', '/h/hive.lock'), ['flock', ['-n', '-E', '75', '/h/hive.lock', 'cat']]);
  assert.throws(() => lockHelper('win32', '/h/hive.lock'), { message: 'Agent Hive não executa em win32: o lock da home precisa de lockf (macOS) ou flock (Linux)' });
});

test('writeDaemonSecret writes the header line curl reads with -H @file; readDaemonSecret gives the bare secret back, mode 0600 and no temp file left (#467)', async (t) => {
  const home = await tempDir(t, 'files-');
  assert.equal(readDaemonSecret(home), undefined, 'no file: no daemon');
  const secret = newSecret();
  writeDaemonSecret(home, secret);
  assert.equal(readDaemonSecret(home), secret);
  assert.equal(await readFile(join(home, SECRET_FILE), 'utf8'), `x-hive-secret: ${secret}\n`);
  assert.equal(await mode(join(home, SECRET_FILE)), 0o600);
  assert.deepEqual(await readdir(home), [SECRET_FILE], 'the temp file was renamed over it');
});

test('curl -H @hive.secret sends the x-hive-secret header with the value writeDaemonSecret wrote: only the path is in its argv (#467)', async (t) => {
  const home = await tempDir(t, 'files-');
  const secret = newSecret();
  writeDaemonSecret(home, secret);
  const seen: (string | string[] | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers['x-hive-secret']);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  await promisify(execFile)('curl', ['-s', '-m', '2', '-H', `@${join(home, SECRET_FILE)}`, url]);
  assert.deepEqual(seen, [secret]);
});

test('readDaemonSecret reads undefined for an empty file, a bare secret, another header, or a short, long, upper-case or non-hex value (#467)', async (t) => {
  const home = await tempDir(t, 'files-');
  const secret = newSecret();
  const line = (value: string): string => `x-hive-secret: ${value}\n`;
  const bad = ['', 'abc', secret, `x-hive-pty: ${secret}\n`, `x-hive-secret:${secret}\n`, line(secret.slice(1)), line(`${secret}0`), line(secret.toUpperCase().replace(/[0-9]/g, 'A')), line('g'.repeat(64))];
  for (const text of bad) {
    await writeFile(join(home, SECRET_FILE), text);
    assert.equal(readDaemonSecret(home), undefined, JSON.stringify(text));
  }
});

test('removeDaemonSecret removes hive.secret while hive.lock names this process, keeps it under another pid\'s lock, and does nothing with no file (#467, #479)', async (t) => {
  const home = await tempDir(t, 'files-');
  removeDaemonSecret(home); // no lock, no file: no throw
  const secret = newSecret();
  writeDaemonSecret(home, secret);
  await writeFile(join(home, LOCK_FILE), '4242\n');
  removeDaemonSecret(home);
  assert.equal(readDaemonSecret(home), secret, 'another daemon\'s lock: its secret');
  await hold(t, home); // no process holds the lock that names 4242: this one takes it
  removeDaemonSecret(home);
  assert.equal(existsSync(join(home, SECRET_FILE)), false);
  removeDaemonSecret(home); // already gone: no throw
});
