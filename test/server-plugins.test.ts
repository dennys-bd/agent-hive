import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { createCustomStore } from '../src/custom-store.js';
import { createServer } from '../src/server.js';
import { ITEMS_ERROR_MESSAGE, registerPluginRoutes } from '../src/server-plugins.js';
import type { CatalogueItem, ItemRead, UpdatePreview } from '../src/types.js';
import { ARCHITECT, assertUntouched, BUILD, DEPLOY, type Fixture, fixture, HELPER, put, skillDoc } from './custom-fixture.js';
import { fakeLog } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

async function serve(t: TestContext, f: Fixture): Promise<{ base: string; lines: string[] }> {
  const app = express();
  app.use(express.json());
  const { log, lines } = fakeLog();
  const store = createCustomStore({ home: f.home, pluginSource: f.pluginSource, workspaces: () => f.workspaces, onChange: () => undefined, log });
  registerPluginRoutes(app, {
    requireLive: () => ({ runtime: { config: { comb: { workspaces: f.workspaces } } } }),
    store,
    home: f.home,
    pluginSource: f.pluginSource,
    log,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, lines };
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<[number, unknown]> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return [res.status, res.status === 204 ? undefined : await res.json()];
}
const at = (id: string): string => `/api/items/${encodeURIComponent(id)}`;

test('the routes list, read and write the items, each write answering what the screen shows next (#315)', async (t) => {
  const f = await fixture(t);
  const { base } = await serve(t, f);
  const [status, items] = await call(base, 'GET', '/api/items');
  assert.deepEqual([status, (items as CatalogueItem[]).map((i) => i.id)], [200, [ARCHITECT, BUILD, DEPLOY, HELPER]]);
  const saved = (await call(base, 'PUT', `${at(BUILD)}/files`, { version: null, path: 'SKILL.md', text: 'mine text' }))[1] as ItemRead;
  assert.deepEqual([saved.version, saved.item.state, saved.files[0]], ['mine', 'customized', { path: 'SKILL.md', text: 'mine text' }]);
  assert.equal(((await call(base, 'POST', `${at(BUILD)}/versions`, { name: 'tdd-first', from: 'mine' }))[1] as ItemRead).version, 'tdd-first');
  const renamed = (await call(base, 'PATCH', `${at(BUILD)}/versions/tdd-first`, { name: 'tdd' }))[1] as CatalogueItem;
  assert.deepEqual(renamed.versions.map((v) => v.name), ['mine', 'tdd']);
  const assigned = (await call(base, 'POST', `${at(BUILD)}/assign`, { workspace: 'hive-site', version: 'tdd' }))[1] as CatalogueItem;
  assert.deepEqual(assigned.versions.map((v) => v.workspaces), [['agent-hive'], ['hive-site']]);
  assert.equal(((await call(base, 'GET', `${at(BUILD)}?version=tdd`))[1] as ItemRead).files[0].text, 'mine text');
  const trimmed = (await call(base, 'DELETE', `${at(BUILD)}/files`, { version: 'tdd', path: 'scripts/run.sh' }))[1] as ItemRead;
  assert.deepEqual(trimmed.files.map((file) => file.path), ['SKILL.md']);
  await call(base, 'DELETE', `${at(BUILD)}/versions/tdd`);
  assert.equal(((await call(base, 'DELETE', `${at(BUILD)}/versions/mine`))[1] as CatalogueItem).state, 'original');
  const [created, item] = await call(base, 'POST', '/api/items', { kind: 'specialist', name: 'my-reviewer' });
  assert.deepEqual([created, (item as CatalogueItem).id, (item as CatalogueItem).kind], [201, 'hive:my-reviewer', 'specialist']);
  assert.deepEqual(await call(base, 'DELETE', `${at('hive:my-reviewer')}/versions/mine`), [204, undefined]);
  await assertUntouched(f);
});

test('each refusal answers its status: 400 bad body, name or path; 404 unknown item, version or workspace; 409 exists, name_taken and original_locked (#315)', async (t) => {
  const f = await fixture(t);
  const { base } = await serve(t, f);
  const status = async (method: string, path: string, body?: unknown): Promise<number> => (await call(base, method, path, body))[0];
  assert.equal(await status('POST', '/api/items', { kind: 'tool', name: 'x' }), 400);
  assert.equal(await status('POST', '/api/items', { kind: 'skill', name: 'a/b' }), 400);
  assert.equal(await status('PUT', `${at(BUILD)}/files`, { version: null, path: '../x', text: '' }), 400);
  assert.equal(await status('GET', at('hive:nope')), 404);
  assert.equal(await status('GET', `${at(BUILD)}?version=ghost`), 404);
  assert.equal(await status('POST', `${at(BUILD)}/assign`, { workspace: 'ghost', version: null }), 404);
  assert.equal(await status('POST', '/api/items', { kind: 'specialist', name: 'new-build' }), 409, "name_taken: a shipped skill's name");
  assert.equal(await status('PUT', `${at(BUILD)}/files`, { version: null, path: 'SKILL.md', text: 'a' }), 200);
  assert.equal(await status('POST', `${at(BUILD)}/versions`, { name: 'mine', from: 'original' }), 409, 'exists');
  assert.equal(await status('POST', '/api/items', { kind: 'skill', name: 'own' }), 201);
  assert.equal(await status('POST', `${at('hive:own')}/versions`, { name: 'two', from: 'mine' }), 200);
  assert.equal(await status('DELETE', `${at('hive:own')}/versions/mine`), 409, 'in_use');
  const [locked, body] = await call(base, 'PUT', `${at(BUILD)}/files`, { version: null, path: 'SKILL.md', text: 'b' });
  assert.equal(locked, 409);
  assert.match((body as { error: string }).error, /read-only/);
  await assertUntouched(f);
});

test('an I/O failure answers 500 with a generic message, and the detail goes to the log only (#315)', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'custom'), 'not a folder');
  const { base, lines } = await serve(t, f);
  assert.deepEqual(await call(base, 'GET', '/api/items'), [500, { error: ITEMS_ERROR_MESSAGE }]);
  assert.ok(lines.some((line) => line.startsWith('ERROR plugins: GET /api/items failed: ')), lines.join('\n'));
});

test('the daemon serves /api/items, and a PATCH without x-hive-ui is refused by the gate as POST, PUT and DELETE are (#315)', async (t) => {
  const home = await tempDir(t, 'plugins-gate-');
  const server = createServer({ home, log: fakeLog().log, secret: SECRET });
  const port = await server.listen(undefined);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await hiveFetch(`${base}/api/items`)).status, 409, 'registered, and waiting for a config like every live route');
  const res = await hiveFetch(`${base}${at(BUILD)}/versions/mine`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
  assert.deepEqual([res.status, await res.json()], [403, { error: 'origem não permitida' }]);
});

test('the update routes: GET previews, POST applies and answers the version read; stale and no update are 409, unresolved 400 (#324)', async (t) => {
  const f = await fixture(t);
  const { base } = await serve(t, f);
  await put(f.pluginSource, { 'skills/new-build/SKILL.md': skillDoc('Take the issue.', 'A PR.') });
  await call(base, 'PUT', `${at(BUILD)}/files`, { version: null, path: 'SKILL.md', text: skillDoc('Take the issue number.', 'A PR.') });
  await put(f.pluginSource, { 'skills/new-build/SKILL.md': skillDoc('Take the issue URL.', 'A PR.') });
  const update = `${at(BUILD)}/versions/mine/update`;
  const [status, body] = await call(base, 'GET', update);
  const { token, changes } = body as UpdatePreview;
  assert.deepEqual([status, changes.map((change) => change.kind)], [200, ['conflict']]);
  assert.equal((await call(base, 'POST', update, { token: 'old', choices: {} }))[0], 409, 'stale');
  assert.equal((await call(base, 'POST', update, { token, choices: {} }))[0], 400, 'unresolved');
  assert.equal((await call(base, 'POST', update, { token, choices: { 'SKILL.md#0': 'both' } }))[0], 400, 'a choice is mine or hive');
  const [applied, read] = await call(base, 'POST', update, { token, choices: { 'SKILL.md#0': 'hive' } });
  assert.deepEqual([applied, (read as ItemRead).version, (read as ItemRead).item.state], [200, 'mine', 'customized']);
  assert.equal((read as ItemRead).files.find((file) => file.path === 'SKILL.md')?.text, skillDoc('Take the issue URL.', 'A PR.'));
  assert.equal((await call(base, 'GET', update))[0], 409, 'no update once applied');
});
