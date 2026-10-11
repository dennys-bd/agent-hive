import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { VIEW_KEY_MESSAGE, VIEW_SIZE_MESSAGE, VIEW_VALUE_MESSAGE, VIEW_WRITE_MESSAGE } from '../src/server-view-state.js';
import { VIEW_VALUE_MAX_BYTES } from '../src/view-state.js';
import { VIEW_STATE_FILE } from '../src/view-store.js';
import { fakeLog } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// The view state's routes (#484), end to end on a daemon in setup mode: neither route needs a live config.
interface Started { base: string; home: string; lines: string[] }

async function start(t: TestContext, prepare?: (home: string) => Promise<void>): Promise<Started> {
  const home = await tempDir(t, 'view-');
  await prepare?.(home);
  const { log, lines } = fakeLog();
  const server = createServer({ home, log, secret: SECRET });
  const port = await server.listen(undefined);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${port}`, home, lines };
}

const UI = { 'x-hive-ui': '1' };
const post = (url: string, body: unknown, headers: Record<string, string> = UI): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const answer = async (res: Promise<Response>): Promise<[number, unknown]> => {
  const done = await res;
  return [done.status, await done.json()];
};
const LAYOUT = { docks: { automation: 'left', activities: 'left', detail: 'left' }, sizes: { left: 30, right: 30 }, open: { left: true, right: false } };

test('GET /view-state answers {} on a fresh home; POST /view-state/:key replaces that key, which GET and view-state.json then hold (#484)', async (t) => {
  const { base, home } = await start(t);
  assert.deepEqual(await answer(hiveFetch(`${base}/view-state`)), [200, {}]);
  assert.deepEqual(await answer(post(`${base}/view-state/dockLayout`, { value: LAYOUT })), [200, { ok: true }]);
  assert.deepEqual(await answer(post(`${base}/view-state/splitEdge`, { value: 'bottom' })), [200, { ok: true }]);
  assert.deepEqual(await answer(hiveFetch(`${base}/view-state`)), [200, { dockLayout: LAYOUT, splitEdge: 'bottom' }]);
  assert.deepEqual(JSON.parse(await readFile(join(home, VIEW_STATE_FILE), 'utf8')), { dockLayout: LAYOUT, splitEdge: 'bottom' });
});

test('POST /view-state/activitiesView is accepted, and GET then holds every workspace\'s view under it (#779)', async (t) => {
  const { base } = await start(t);
  const views = { hive: { mode: 'none', showWorktree: false, collapsed: ['done'], isOpen: false } };
  assert.deepEqual(await answer(post(`${base}/view-state/activitiesView`, { value: views })), [200, { ok: true }]);
  assert.deepEqual(await answer(hiveFetch(`${base}/view-state`)), [200, { activitiesView: views }]);
});

test('POST /view-state/repoLists is accepted, and GET then holds each repository\'s list widths under it (#59)', async (t) => {
  const { base } = await start(t);
  const lists = { 'acme/site': { issues: { labels: 102 }, prs: { review: 160 } } };
  assert.deepEqual(await answer(post(`${base}/view-state/repoLists`, { value: lists })), [200, { ok: true }]);
  assert.deepEqual(await answer(hiveFetch(`${base}/view-state`)), [200, { repoLists: lists }]);
});

test('POST /view-state/:key answers 400 for a key not in the list, a body without value, or a value over 256 KiB, and writes nothing (#484)', async (t) => {
  const { base, home } = await start(t);
  for (const key of ['columnFilters', 'theme', '__proto__']) {
    assert.deepEqual(await answer(post(`${base}/view-state/${key}`, { value: 1 })), [400, { error: VIEW_KEY_MESSAGE }], key);
  }
  assert.deepEqual(await answer(post(`${base}/view-state/dockLayout`, { layout: LAYOUT })), [400, { error: VIEW_VALUE_MESSAGE }]);
  const tooBig = 'x'.repeat(VIEW_VALUE_MAX_BYTES); // two quotes more once serialised
  assert.deepEqual(await answer(post(`${base}/view-state/lastWorkspace`, { value: tooBig })), [400, { error: VIEW_SIZE_MESSAGE }]);
  assert.deepEqual(await answer(hiveFetch(`${base}/view-state`)), [200, {}]);
  await assert.rejects(readFile(join(home, VIEW_STATE_FILE)), 'no file');
  const atTheCap = 'x'.repeat(VIEW_VALUE_MAX_BYTES - 2);
  assert.deepEqual(await answer(post(`${base}/view-state/lastWorkspace`, { value: atTheCap })), [200, { ok: true }], 'exactly the cap is accepted');
});

test('a POST /view-state/:key without x-hive-ui is refused by the existing gate (#484)', async (t) => {
  const { base } = await start(t);
  assert.deepEqual(await answer(post(`${base}/view-state/splitEdge`, { value: 'bottom' }, {})), [403, { error: 'origem não permitida' }]);
  assert.deepEqual(await answer(hiveFetch(`${base}/view-state`)), [200, {}]);
});

test('a write that fails answers 500 and logs the key and the error, never the value (#484)', async (t) => {
  const { base, lines } = await start(t, (home) => mkdir(join(home, VIEW_STATE_FILE)).then(() => undefined)); // the rename onto a directory fails
  const res = await answer(post(`${base}/view-state/dockLayout`, { value: { marker: 'layout-marker-484' } }));
  assert.deepEqual(res, [500, { error: VIEW_WRITE_MESSAGE }]);
  assert.ok(lines.some((line) => line.startsWith('ERROR view state dockLayout not written: ')), lines.join('\n'));
  assert.ok(!lines.some((line) => line.includes('layout-marker-484')), 'the value never reaches the log');
});
