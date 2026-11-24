// The distro's own disk through the machine (#948 decision 10) and the bytes across the real wsl.exe pipe (decision 11). Every folder is
// fresh under the distro user's home and every repository is local to the distro: no network, so a GitHub outage never reaches the lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realWsl, stdoutOf, within } from './real-wsl.js';

const WATCH_MS = 10_000;
const GIT_IDENTITY = ['-c', 'user.name=WSL lane', '-c', 'user.email=lane@example.invalid'];
const BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i)); // every byte value, 0x00 to 0xff
const OCTAL = 8;
const BYTES_MAX = 1024;

test('lstat of a symlink made by ln -s reports a symbolic link (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  const dir = await freshDir();
  const target = machine.paths.join(dir, 'target');
  const link = machine.paths.join(dir, 'link');
  await machine.fs.writeFile(target, 'x\n');
  await stdoutOf(machine, 'ln', ['-s', target, link]);
  assert.equal((await machine.fs.lstat(link)).isSymbolicLink(), true);
});

test('fs.chmod(path, 0o755) is seen by stat -c %a inside the distro as 755 (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  const file = machine.paths.join(await freshDir(), 'mode');
  await machine.fs.writeFile(file, 'x\n');
  await machine.fs.chmod(file, 0o755);
  assert.equal((await stdoutOf(machine, 'stat', ['-c', '%a', file])).trim(), '755');
});

test('a file written by exec reaches an open watch on its folder within 10 s (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  const dir = await freshDir();
  let isSeen = false;
  let failure: Error | undefined;
  const watcher = machine.watch(dir, { recursive: false }, (name) => { if (name === 'f') isSeen = true; }, (err) => { failure = err; });
  t.after(() => watcher.close());
  // written again until heard: the watch opens over the mux after watch() returns, so the first write may come before it
  await within(WATCH_MS, async () => {
    if (failure !== undefined) throw failure;
    await stdoutOf(machine, 'sh', ['-c', 'echo x > f'], { cwd: dir });
    return isSeen;
  }, 'a watch event for f');
});

test('a repository made with git init and one commit, cloned with git clone inside the distro, answers an empty git status --porcelain (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  const dir = await freshDir();
  const origin = machine.paths.join(dir, 'origin');
  const git = (cwd: string, args: string[]): Promise<string> => stdoutOf(machine, 'git', [...GIT_IDENTITY, ...args], { cwd });
  await git(dir, ['init', '-q', 'origin']);
  await machine.fs.writeFile(machine.paths.join(origin, 'README.md'), 'the WSL lane\n');
  await git(origin, ['add', 'README.md']);
  await git(origin, ['commit', '-q', '-m', 'init']);
  await git(dir, ['clone', '-q', 'origin', 'clone']);
  assert.equal(await git(machine.paths.join(dir, 'clone'), ['status', '--porcelain']), '');
});

test('every byte 0x00-0xff written with fs.writeFile hashes inside the distro as it does on the host (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  const file = machine.paths.join(await freshDir(), 'bytes');
  await machine.fs.writeFile(file, BYTES);
  const [hash] = (await stdoutOf(machine, 'sha256sum', [file])).split(' ');
  assert.equal(hash, createHash('sha256').update(BYTES).digest('hex'));
});

test('the same bytes made inside the distro by printf with octal escapes read back with fs.readFile equal the buffer (#948)', async (t) => {
  const { machine, freshDir } = realWsl(t);
  const file = machine.paths.join(await freshDir(), 'printed');
  // every byte as \NNN, % and \ included, so the format holds no conversion; coreutils' printf (env finds it) writes \000 too
  const format = Array.from(BYTES, (b) => `\\${b.toString(OCTAL).padStart(3, '0')}`).join('');
  await stdoutOf(machine, 'sh', ['-c', 'env printf "$1" > "$2"', 'sh', format, file]);
  assert.deepEqual(await machine.fs.readFile(file, { maxBytes: BYTES_MAX }), BYTES);
});
