import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { createCustomStore } from '../src/custom-store.js';
import { createServer } from '../src/server.js';
import { ITEMS_ERROR_MESSAGE, registerPluginRoutes } from '../src/server-plugins.js';
import type { CatalogueItem, ItemRead, LintInputRead, Stage, UpdatePreview } from '../src/types.js';
import { ARCHITECT, assertUntouched, BUILD, DEPLOY, type Fixture, fixture, HELPER, put, skillDoc, snapshot } from './custom-fixture.js';
import { fakeLog } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

async function serve(t: TestContext, f: Fixture, stages: Stage[] = []): Promise<{ base: string; lines: string[] }> {
  const app = express();
  app.use(express.json());
  const { log, lines } = fakeLog();
  const store = createCustomStore({ home: f.home, pluginSource: f.pluginSource, workspaces: () => f.workspaces, onChange: () => undefined, log });
  registerPluginRoutes(app, {
    requireLive: () => ({ runtime: { config: { comb: { workspaces: f.workspaces, stages } } } }),
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
  const [file] = saved.files;
  assert.deepEqual([saved.version, saved.item.state, file?.path, file?.text, typeof file?.savedAt], ['mine', 'customized', 'SKILL.md', 'mine text', 'string']);
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

test("GET /api/items answers each item's usage from the config's stages (#313)", async (t) => {
  const f = await fixture(t);
  const { base } = await serve(t, f, [{ name: 'build', from: {}, prompt: '/hive:new-build {url}' }]);
  const items = (await call(base, 'GET', '/api/items'))[1] as CatalogueItem[];
  assert.deepEqual(items.find((i) => i.id === BUILD)?.usage, [{ kind: 'stage', stage: 'build' }]);
  assert.deepEqual(items.find((i) => i.id === DEPLOY)?.usage, []);
});

const STUB = (name: string): string => `---\nname: ${name}\ndescription: ""\n---\n`;

test("POST /api/items with a workspace origin writes the stub in that workspace's .claude/ and answers the item; a bad name, a taken name and an unknown workspace are refused (#313)", async (t) => {
  const f = await fixture(t);
  const { base } = await serve(t, f);
  const [created, skill] = await call(base, 'POST', '/api/items', { kind: 'skill', name: 'preview', origin: 'hive-site' });
  assert.deepEqual([created, (skill as CatalogueItem).id, (skill as CatalogueItem).state], [201, 'hive-site:preview', 'workspace']);
  assert.equal(await readFile(join(f.site, '.claude/skills/preview/SKILL.md'), 'utf8'), STUB('preview'));
  const agentHive = f.workspaces[0]?.path ?? ''; // agent-hive has no .claude/ yet
  assert.equal((await call(base, 'POST', '/api/items', { kind: 'specialist', name: 'checker', origin: 'agent-hive' }))[0], 201);
  assert.equal(await readFile(join(agentHive, '.claude/agents/checker.md'), 'utf8'), STUB('checker'));
  await mkdir(join(f.site, '.claude/skills/empty'), { recursive: true });
  const status = async (body: object): Promise<number> => (await call(base, 'POST', '/api/items', body))[0];
  assert.equal(await status({ kind: 'skill', name: '../x', origin: 'hive-site' }), 400);
  assert.equal(await status({ kind: 'specialist', name: 'deploy', origin: 'hive-site' }), 409, "the repository's skill holds the name");
  assert.equal(await status({ kind: 'skill', name: 'helper', origin: 'hive-site' }), 409, 'and its specialist');
  assert.equal(await status({ kind: 'skill', name: 'empty', origin: 'hive-site' }), 409, 'a skill folder with no SKILL.md yet');
  assert.equal(await status({ kind: 'skill', name: 'x', origin: 'ghost' }), 404);
  assert.deepEqual(await snapshot(f.pluginSource), f.initial.plugin, 'the shipped plugin is never written');
});

test('the update routes: GET previews, POST applies and answers the version read; stale and no update are 409 naming their code, unresolved 400 (#324, #325)', async (t) => {
  const f = await fixture(t);
  const { base } = await serve(t, f);
  await put(f.pluginSource, { 'skills/new-build/SKILL.md': skillDoc('Take the issue.', 'A PR.') });
  await call(base, 'PUT', `${at(BUILD)}/files`, { version: null, path: 'SKILL.md', text: skillDoc('Take the issue number.', 'A PR.') });
  await put(f.pluginSource, { 'skills/new-build/SKILL.md': skillDoc('Take the issue URL.', 'A PR.') });
  const update = `${at(BUILD)}/versions/mine/update`;
  const [status, body] = await call(base, 'GET', update);
  const { token, changes } = body as UpdatePreview;
  assert.deepEqual([status, changes.map((change) => change.kind)], [200, ['conflict']]);
  const [stale, staleBody] = await call(base, 'POST', update, { token: 'old', choices: {} });
  assert.deepEqual([stale, (staleBody as { code?: string }).code], [409, 'stale']);
  assert.equal((await call(base, 'POST', update, { token, choices: {} }))[0], 400, 'unresolved');
  assert.equal((await call(base, 'POST', update, { token, choices: { 'SKILL.md#0': 'both' } }))[0], 400, 'a choice is mine or hive');
  const [applied, read] = await call(base, 'POST', update, { token, choices: { 'SKILL.md#0': 'hive' } });
  assert.deepEqual([applied, (read as ItemRead).version, (read as ItemRead).item.state], [200, 'mine', 'customized']);
  assert.equal((read as ItemRead).files.find((file) => file.path === 'SKILL.md')?.text, skillDoc('Take the issue URL.', 'A PR.'));
  const [gone, goneBody] = await call(base, 'GET', update);
  assert.deepEqual([gone, (goneBody as { code?: string }).code], [409, 'no_update'], 'no update once applied');
});

test("GET /api/lint-input answers each Hive item's variables (a user-created one's from its first version), each workspace skill with none, and the plugin's scripts (#327)", async (t) => {
  const f = await fixture(t);
  await put(f.pluginSource, {
    'skills/new-build/SKILL.md': '---\nname: new-build\ndescription: Build it\nvariables:\n  base: { default: main }\n---\n{{ base }}\n',
    'scripts/check.mjs': 'process.exit(0);\n',
  });
  const { base } = await serve(t, f);
  assert.equal((await call(base, 'POST', '/api/items', { kind: 'skill', name: 'own' }))[0], 201);
  const own = '---\nname: own\ndescription: mine\nvariables:\n  mode: { default: a }\n---\n{{ mode }}\n';
  assert.equal((await call(base, 'PUT', `${at('hive:own')}/files`, { version: 'mine', path: 'SKILL.md', text: own }))[0], 200);
  const [status, body] = await call(base, 'GET', '/api/lint-input');
  const read = body as LintInputRead;
  assert.equal(status, 200);
  assert.deepEqual(read.catalogue.map((i) => [i.origin, i.kind, i.name, i.variables.map((v) => v.name)]), [
    ['hive', 'specialist', 'architect', []],
    ['hive', 'skill', 'new-build', ['base']],
    ['hive', 'skill', 'own', ['mode']],
    ['hive-site', 'skill', 'deploy', []],
  ]);
  assert.deepEqual(read.scripts, ['scripts/check.mjs']);
});

test('the dismissed routes round-trip the keys per version, null the original; a malformed body is 400, an unknown id 404 with no folder made, an unknown version 404 (#327)', async (t) => {
  const f = await fixture(t);
  const { base } = await serve(t, f);
  const dismissed = `${at(BUILD)}/dismissed`;
  const codeOf = async (method: string, path: string, body?: unknown): Promise<[number, string | undefined]> => {
    const [status, answer] = await call(base, method, path, body);
    return [status, (answer as { code?: string }).code];
  };
  assert.deepEqual(await call(base, 'PUT', dismissed, { version: null, keys: ['a\u0000b'] }), [200, ['a\u0000b']]);
  assert.deepEqual(await call(base, 'GET', dismissed), [200, ['a\u0000b']]);
  assert.deepEqual(await codeOf('GET', `${dismissed}?version=mine`), [404, 'unknown_version']);
  assert.equal((await call(base, 'PUT', dismissed, { version: null, keys: 'a' }))[0], 400);
  assert.equal((await call(base, 'PUT', dismissed, { version: null, keys: Array.from({ length: 1001 }, (_, i) => `k${i}`) }))[0], 400);
  assert.deepEqual(await codeOf('PUT', `${at('hive:ghost')}/dismissed`, { version: null, keys: ['a'] }), [404, 'unknown_item']);
  await assert.rejects(stat(join(f.home, 'custom/hive/ghost')), 'no folder is made for an unknown id');
  assert.deepEqual(await codeOf('PUT', dismissed, { version: 'ghost', keys: [] }), [404, 'unknown_version']);
  assert.equal((await call(base, 'PUT', `${at(BUILD)}/files`, { version: null, path: 'SKILL.md', text: 'mine text' }))[0], 200); // makes mine
  assert.deepEqual(await call(base, 'PUT', dismissed, { version: 'mine', keys: ['m'] }), [200, ['m']]);
  assert.deepEqual([(await call(base, 'GET', dismissed))[1], (await call(base, 'GET', `${dismissed}?version=mine`))[1]], [['a\u0000b'], ['m']]);
  await assertUntouched(f);
});
