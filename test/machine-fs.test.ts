import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CopyOptions, RmOptions } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MachineError } from '../src/machine.js';
import { fileFs, isLocal, MACHINE_REMOTE, moveFs, pathFs, REMOTE_REFUSAL, treeFs, withMachinePath } from '../src/machine-fs.js';
import { fakeMachine, statsOf } from './fake-machine.js';
import { tempDir } from './temp-dir.js';

test('pathFs asks the machine lstat, never stat, and its realpath (#160)', async () => {
  const asked: string[] = [];
  const machine = fakeMachine({ fs: {
    lstat: async (path) => { asked.push(path); return statsOf('folder'); },
    stat: async () => assert.fail('stat follows a symlink to its target'),
    realpath: async (path) => `/real${path}`,
  } });
  const fs = pathFs(machine);
  assert.equal((await fs.stat('/repo/a')).isDirectory(), true);
  assert.equal(await fs.realpath('/repo/a'), '/real/repo/a');
  assert.deepEqual(asked, ['/repo/a']);
});

test('treeFs: writeNew never overwrites, replace is the machine\'s writeAtomic, sameFile compares inodes, mkdirs makes the folders between (#160)', async (t) => {
  const dir = await tempDir(t, 'machine-fs-');
  const replaced: string[] = [];
  const local = fakeMachine();
  const fs = treeFs(fakeMachine({ fs: { writeAtomic: (path, text) => { replaced.push(path); return local.fs.writeAtomic(path, text); } } }));
  await fs.mkdirs(join(dir, 'a', 'b'));
  await fs.writeNew(join(dir, 'a', 'b', 'x.ts'), 'one');
  await assert.rejects(fs.writeNew(join(dir, 'a', 'b', 'x.ts'), 'two'), { code: 'EEXIST' });
  await fs.replace(join(dir, 'a', 'b', 'x.ts'), 'three');
  assert.deepEqual([await readFile(join(dir, 'a', 'b', 'x.ts'), 'utf8'), replaced], ['three', [join(dir, 'a', 'b', 'x.ts')]]);
  await writeFile(join(dir, 'y.ts'), '');
  assert.deepEqual([await fs.sameFile(join(dir, 'y.ts'), join(dir, 'y.ts')), await fs.sameFile(join(dir, 'y.ts'), join(dir, 'a', 'b', 'x.ts')), await fs.sameFile(join(dir, 'y.ts'), join(dir, 'gone'))], [true, false, false]);
});

test('moveFs copies recursively, keeping links and never over an existing path, and removes recursively (#160)', async () => {
  const seen: unknown[] = [];
  const fs = moveFs(fakeMachine({ fs: {
    cp: async (from: string, to: string, options?: CopyOptions) => { seen.push(['cp', from, to, options]); },
    rm: async (path: string, options?: RmOptions) => { seen.push(['rm', path, options]); },
  } }));
  await fs.cp('/repo/a', '/repo/b');
  await fs.rm('/repo/b');
  assert.deepEqual(seen, [['cp', '/repo/a', '/repo/b', { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }], ['rm', '/repo/b', { recursive: true }]]);
});

test('fileFs.isFile answers a regular file only: a folder and a missing path are not (#160)', async (t) => {
  const dir = await tempDir(t, 'machine-fs-');
  await writeFile(join(dir, 'a.md'), '');
  await mkdir(join(dir, 'sub'));
  const fs = fileFs(fakeMachine());
  assert.deepEqual([await fs.isFile(join(dir, 'a.md')), await fs.isFile(join(dir, 'sub')), await fs.isFile(join(dir, 'gone'))], [true, false, false]);
});

test('isLocal is the local id only, and the remote refusal is a 409 machine_remote (#160)', () => {
  assert.deepEqual([isLocal(fakeMachine()), isLocal(fakeMachine({ id: 'AB:CD' }))], [true, false]);
  assert.deepEqual([REMOTE_REFUSAL.status, REMOTE_REFUSAL.code], [409, MACHINE_REMOTE]);
});

test('withMachinePath sets PATH to the machine\'s; on win32 another spelling of it goes first (#160)', () => {
  assert.deepEqual(withMachinePath({ PATH: '/host/bin', A: '1' }, { platform: 'linux', path: '/machine/bin' }), { PATH: '/machine/bin', A: '1' });
  assert.deepEqual(withMachinePath({ Path: 'C:\\host', A: '1' }, { platform: 'win32', path: 'C:\\machine' }), { A: '1', PATH: 'C:\\machine' });
});

test('fakeMachine: its default exec answers nothing, a given one rejects as a MachineError, info merged over the local one\'s, the id overridable (#160)', async () => {
  assert.deepEqual(await fakeMachine().exec('git', ['status']), { stdout: '' });
  const failing = fakeMachine({ exec: async () => { throw Object.assign(new Error('Command failed'), { code: 128, stderr: 'fatal: no' }); } });
  await assert.rejects(failing.exec('git', ['status']), (err: unknown) => err instanceof MachineError && err.code === 128 && err.stderr === 'fatal: no');
  assert.equal(fakeMachine({ id: 'AB:CD' }).id, 'AB:CD');
  const info = fakeMachine({ info: { platform: 'win32' } }).info();
  assert.deepEqual([info.platform, info.tmpdir], ['win32', fakeMachine().info().tmpdir]);
});
