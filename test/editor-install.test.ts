import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { editorDir } from '../src/editor-install.js';
import { json, rig, settled, writeStub } from './editor-stubs.js';

const execFileAsync = promisify(execFile);

const PYRIGHT = { kind: 'server', id: 'pyright' } as const;
const GOPLS = { kind: 'server', id: 'gopls' } as const;
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

test('an npm server installs into its own folder with installed.json; the listing shows it with the latest version (#780)', async (t) => {
  const r = await rig(t);
  r.routes.set('/npm/pyright/latest', json({ version: '1.2.3' }));
  assert.deepEqual(await r.installer.act(PYRIGHT, 'install'), { status: 202, state: { state: 'installing' } }, 'an npm install cannot measure itself: no percent');
  assert.deepEqual((await settled(r, 'pyright')).state, { state: 'installed', version: '1.2.3' });
  assert.deepEqual(r.events.filter((e) => e.state.state === 'installing').filter((e) => 'percent' in e.state), []);
  const dir = editorDir(r.home, PYRIGHT);
  assert.equal(JSON.parse(await readFile(join(dir, 'installed.json'), 'utf8')).version, '1.2.3');
  assert.ok(await exists(join(dir, 'node_modules', 'pyright', 'package.json')));
  r.routes.set('/npm/pyright/latest', json({ version: '1.3.0' }));
  assert.deepEqual((await r.installer.installs()).servers.pyright, { state: 'installed', version: '1.2.3', latest: '1.3.0' });
});

test('the folder appears only after success; a second install while one runs is a 409 (#780)', async (t) => {
  const r = await rig(t);
  r.routes.set('/npm/pyright/latest', json({ version: '1.2.3' }));
  await writeStub(r.bin, 'npm', '#!/bin/sh\n/bin/sleep 0.4\nexit 1\n');
  await r.installer.act(PYRIGHT, 'install');
  assert.equal((await r.installer.act(PYRIGHT, 'install')).status, 409);
  assert.equal(await exists(editorDir(r.home, PYRIGHT)), false);
  await settled(r, 'pyright');
});

test('a failure keeps the previous install, says where it stopped, and fills the log with the error last (#780)', async (t) => {
  const r = await rig(t);
  r.routes.set('/npm/pyright/latest', json({ version: '1.2.3' }));
  await r.installer.act(PYRIGHT, 'install');
  await settled(r, 'pyright');
  await writeStub(r.bin, 'npm', '#!/bin/sh\necho "npm ERR! 404 Not Found" >&2\nexit 1\n');
  r.routes.set('/npm/pyright/latest', json({ version: '1.3.0' }));
  await r.installer.act(PYRIGHT, 'update');
  const { state } = await settled(r, 'pyright');
  assert.ok(state.state === 'failed');
  assert.deepEqual([state.version, state.step], ['1.3.0', 'npm install']);
  assert.match(state.log, /npm ERR! 404 Not Found/);
  assert.equal(state.log.split('\n').at(-1), 'npm exited with code 1');
  assert.equal(JSON.parse(await readFile(join(editorDir(r.home, PYRIGHT), 'installed.json'), 'utf8')).version, '1.2.3');
});

test('a tool missing from PATH is the requires state, before anything starts; recheck looks again (#780)', async (t) => {
  const r = await rig(t, []);
  assert.deepEqual(await r.installer.act(PYRIGHT, 'install'), { status: 200, state: { state: 'requires', tool: 'node' } });
  assert.deepEqual((await r.installer.installs()).servers.gopls, { state: 'requires', tool: 'go' });
  await writeStub(r.bin, 'node', '#!/bin/sh\n');
  await writeStub(r.bin, 'npm', '#!/bin/sh\n');
  assert.deepEqual(await r.installer.act(PYRIGHT, 'recheck'), { status: 200, state: { state: 'absent' } });
});

test('a toolchain server installs with go into GOBIN; its version is the proxy\'s, without its v (#780)', async (t) => {
  const r = await rig(t);
  r.routes.set('/go/golang.org/x/tools/gopls/@latest', json({ Version: 'v0.20.0' }));
  await r.installer.act(GOPLS, 'install');
  assert.deepEqual((await settled(r, 'gopls')).state, { state: 'installed', version: '0.20.0' });
  assert.ok(await exists(join(editorDir(r.home, GOPLS), 'bin', 'gopls')));
});

test('cancel stops the step, removes the temp folder and leaves the prior state; remove deletes the folder (#780)', async (t) => {
  const r = await rig(t);
  r.routes.set('/npm/pyright/latest', json({ version: '1.2.3' }));
  await writeStub(r.bin, 'npm', '#!/bin/sh\n/bin/sleep 5\n');
  await r.installer.act(PYRIGHT, 'install');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await r.installer.act(PYRIGHT, 'cancel');
  assert.deepEqual((await settled(r, 'pyright')).state, { state: 'absent' });
  const parent = dirname(editorDir(r.home, PYRIGHT));
  assert.deepEqual((await readdir(parent).catch(() => [])).filter((name) => name.includes('.tmp-')), []);
  await r.installer.act(GOPLS, 'remove');
  assert.equal(await exists(editorDir(r.home, GOPLS)), false);
});

test('an update stops the item\'s running processes before the old folder moves (#780)', async (t) => {
  const order: string[] = [];
  let beforeSwap: () => Promise<void> = () => Promise.resolve();
  const r = await rig(t, undefined, { beforeSwap: () => beforeSwap() });
  r.routes.set('/npm/pyright/latest', json({ version: '1.2.3' }));
  await r.installer.act(PYRIGHT, 'install');
  await settled(r, 'pyright');
  beforeSwap = async () => { order.push(`stopped, old install ${(await exists(join(editorDir(r.home, PYRIGHT), 'installed.json'))) ? 'still there' : 'gone'}`); };
  r.routes.set('/npm/pyright/latest', json({ version: '1.3.0' }));
  await r.installer.act(PYRIGHT, 'update');
  await settled(r, 'pyright');
  assert.deepEqual(order, ['stopped, old install still there']);
});

const DART = { kind: 'server', id: 'dart' } as const;

test('a system server installs nothing: it requires its tool until the tool is on PATH, then reads installed at the version it prints; install and update are 409 (#782)', async (t) => {
  const r = await rig(t, []);
  assert.deepEqual((await r.installer.installs()).servers.dart, { state: 'requires', tool: 'dart' });
  await writeStub(r.bin, 'dart', '#!/bin/sh\necho "Dart SDK version: 3.5.4 (stable) (Tue Oct 1 2025) on \\"macos_arm64\\""\n');
  await execFileAsync(join(r.bin, 'dart'), ['--version']); // the first run of a new script can wait on the OS's scan under load, longer than the version cap
  assert.deepEqual(await r.installer.act(DART, 'recheck'), { status: 200, state: { state: 'installed', version: '3.5.4' } });
  assert.deepEqual((await r.installer.installs()).servers.dart, { state: 'installed', version: '3.5.4' });
  assert.deepEqual(await r.installer.act(DART, 'install'), { status: 409, message: 'dart comes with its SDK: nothing to install' });
  assert.equal((await r.installer.act(DART, 'update')).status, 409);
});
