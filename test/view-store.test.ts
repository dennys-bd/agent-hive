import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isViewKey, VIEW_KEYS, VIEW_VALUE_MAX_BYTES } from '../src/view-state.js';
import { createViewStore, readViewState, VIEW_STATE_FILE } from '../src/view-store.js';
import { tempDir } from './temp-dir.js';

// The view state's file in the home (#484): loaded once, rewritten whole on every change, one write at a time.
const LAYOUT = { docks: { automation: 'left', activities: 'left', detail: 'right' } };
const onDisk = async (home: string): Promise<unknown> => JSON.parse(await readFile(join(home, VIEW_STATE_FILE), 'utf8'));

test('the view state has fourteen keys, runNoAsk (#469), activitiesView (#779), projectViews (#756), changesBase (#668), repositories (#757), filesShowHidden (#947) flowView (#909) and repoLists (#59) among them, columnFilters and closeTabNotice not, and a 256 KiB cap per value (#484, #614)', () => {
  assert.deepEqual([...VIEW_KEYS], ['dockLayout', 'stageFilters', 'centerLayouts', 'consoleHeight', 'splitEdge', 'lastWorkspace', 'activitiesView', 'projectViews', 'changesBase', 'repositories', 'filesShowHidden', 'flowView', 'repoLists', 'runNoAsk']);
  assert.equal(VIEW_VALUE_MAX_BYTES, 262_144);
  assert.deepEqual(['splitEdge', 'flowView', 'columnFilters', 'toString', 42].map((value) => isViewKey(value)), [true, true, false, false, false]);
});

test('readViewState reads {} with no file, a file it cannot read, invalid JSON, or JSON that is no object (#484)', async (t) => {
  const home = await tempDir(t, 'view-');
  const file = join(home, VIEW_STATE_FILE);
  assert.deepEqual(readViewState(home), {}, 'no file');
  for (const text of ['{oops', '[1,2]', '42', 'null', '"dockLayout"']) {
    await writeFile(file, text);
    assert.deepEqual(readViewState(home), {}, text);
  }
  await rm(file);
  await mkdir(file); // a directory at the path: reading it fails with EISDIR
  assert.deepEqual(readViewState(home), {}, 'unreadable');
});

test('readViewState keeps the known keys with their values as stored and drops every other key (#484)', async (t) => {
  const home = await tempDir(t, 'view-');
  await writeFile(join(home, VIEW_STATE_FILE), JSON.stringify({ dockLayout: LAYOUT, splitEdge: 'garbage', columnFilters: { dev: [] }, theme: 'dark' }));
  assert.deepEqual(readViewState(home), { dockLayout: LAYOUT, splitEdge: 'garbage' }); // a value's shape is its UI module's to check
});

test('set replaces one key in a new map and writes the whole map through a temp file, 0600, leaving no .tmp behind (#484)', async (t) => {
  const home = await tempDir(t, 'view-');
  const initial = { splitEdge: 'bottom' };
  const store = createViewStore(home, initial);
  await store.set('dockLayout', LAYOUT);
  assert.deepEqual(store.get(), { splitEdge: 'bottom', dockLayout: LAYOUT });
  assert.deepEqual(initial, { splitEdge: 'bottom' }, 'the initial map is never written to');
  assert.deepEqual(await onDisk(home), { splitEdge: 'bottom', dockLayout: LAYOUT });
  assert.equal((await stat(join(home, VIEW_STATE_FILE))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(home), [VIEW_STATE_FILE]);
});

test('two concurrent sets of different keys both land in the file (#484)', async (t) => {
  const home = await tempDir(t, 'view-');
  const store = createViewStore(home, {});
  await Promise.all([store.set('dockLayout', LAYOUT), store.set('lastWorkspace', 'site')]);
  assert.deepEqual(await onDisk(home), { dockLayout: LAYOUT, lastWorkspace: 'site' });
});

test('a failed write rejects that set and keeps the map, so the next set writes both keys (#484)', async (t) => {
  const home = await tempDir(t, 'view-');
  const file = join(home, VIEW_STATE_FILE);
  await mkdir(file); // the rename onto a directory fails
  const store = createViewStore(home, {});
  await assert.rejects(store.set('splitEdge', 'bottom'));
  assert.deepEqual(store.get(), { splitEdge: 'bottom' });
  await rm(file, { recursive: true });
  await store.set('consoleHeight', 300);
  assert.deepEqual(await onDisk(home), { splitEdge: 'bottom', consoleHeight: 300 });
});
