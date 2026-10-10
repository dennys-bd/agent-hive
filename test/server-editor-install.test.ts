import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { editorDir, type Installer } from '../src/editor-install.js';
import { registerEditorInstallRoutes } from '../src/server-editor-install.js';
import type { EditorInstalls, InstallAction, InstallTarget } from '../src/types.js';
import { fakeGh, namedEventDuring, startPrs } from './pr-server.js';
import { send } from './review-server.js';
import { type AfterHost, tempDir } from './temp-dir.js';

async function serve(t: AfterHost): Promise<{ base: string; home: string; calls: string[] }> {
  const home = await tempDir(t, 'syntax-home-');
  const calls: string[] = [];
  const installer: Installer = {
    installs: async () => ({ servers: {}, syntaxes: {} }) as unknown as EditorInstalls,
    act: async (target: InstallTarget, action: InstallAction) => { calls.push(`act ${target.kind} ${target.id} ${action}`); return { status: 202, state: { state: 'installing', percent: 0 } }; },
  };
  const app = express();
  app.use(express.json());
  registerEditorInstallRoutes(app, { home, installer, stopServer: async (id) => { calls.push(`stop ${id}`); } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, home, calls };
}

test('the syntax route serves a package\'s file; an unknown id, a path out of extension/, a symlink leaving it or a folder is a 404 (#780)', async (t) => {
  const { base, home } = await serve(t);
  const extension = join(editorDir(home, { kind: 'syntax', id: 'vscode.python' }), 'extension');
  await mkdir(join(extension, 'syntaxes'), { recursive: true });
  await writeFile(join(extension, 'syntaxes', 'p.json'), '{"scopeName":"source.python"}');
  await writeFile(join(home, 'secret.json'), '{}');
  await symlink(join(home, 'secret.json'), join(extension, 'link.json'));
  const res = await fetch(`${base}/editor/syntax/vscode.python/syntaxes/p.json`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scopeName: 'source.python' });
  for (const path of ['/editor/syntax/evil.pkg/syntaxes/p.json', '/editor/syntax/vscode.python/%2E%2E/%2E%2E/%2E%2E/secret.json', '/editor/syntax/vscode.python/..%2F..%2F..%2Fsecret.json', '/editor/syntax/vscode.python/..%2F..%2F..%2F..%2F..%2Fsecret.json', '/editor/syntax/vscode.python/link.json', '/editor/syntax/vscode.python/syntaxes']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('POST acts on a known item; remove stops the server\'s processes first; a bad kind, id or action is refused (#780)', async (t) => {
  const { base, calls } = await serve(t);
  const post = (path: string, action: unknown) => fetch(`${base}/settings/editor/installs/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
  assert.equal((await post('server/pyright', 'install')).status, 202);
  assert.equal((await post('server/pyright', 'remove')).status, 202);
  assert.equal((await post('syntax/vscode.go', 'cancel')).status, 202);
  assert.deepEqual(calls, ['act server pyright install', 'stop pyright', 'act server pyright remove', 'act syntax vscode.go cancel']);
  assert.equal((await post('server/nope', 'install')).status, 404);
  assert.equal((await post('plugin/pyright', 'install')).status, 404);
  assert.equal((await post('server/pyright', 'explode')).status, 400);
});

test('the daemon serves the install routes and streams an install\'s state as a named editorInstall event (#780)', async (t) => {
  const { base } = await startPrs(t, fakeGh());
  const event = await namedEventDuring(base, 'editorInstall', () => send(base, 'POST', '/settings/editor/installs/syntax/vscode.go', { action: 'remove' }));
  assert.deepEqual(event, { kind: 'syntax', id: 'vscode.go', state: { state: 'absent' } });
  assert.equal((await send(base, 'POST', '/settings/editor/installs/syntax/evil', { action: 'remove' })).status, 404);
});
