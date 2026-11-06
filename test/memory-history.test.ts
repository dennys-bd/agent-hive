import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { workspaceProtocolPaths } from '../src/hooks-settings.js';
import {
  BODY_MESSAGE, createMemoryStore, DESCRIPTION_MESSAGE, forgetRefusal, isMemoryRefusal, MEMORY_FULL_MESSAGE, MEMORY_SECRET_MESSAGE, type MemoryResult, memoryPath,
  memoryUsed, NO_FIELD_MESSAGE, parseMemory, revisionRefusal, WHY_MESSAGE, withDiscarded, withEntry, withForgotten, withRestored, withRevision,
} from '../src/memory.js';
import { MEMORY_HISTORY_MAX, type MemoryChange, type MemoryEntry, type MemoryFile } from '../src/types.js';
import { tempDir } from './temp-dir.js';

// The memory's history (#683): the edits a worker's hive_revise and hive_forget make, and the user's restore and discard (#684's routes)
const AT = '2026-11-06T10:00:00.000Z';
const LATER = '2026-11-07T10:00:00.000Z';
const CAP = 4000;
const BY: MemoryChange['by'] = { task: '812', stage: 'build' };
const UNKNOWN = { code: 'unknown_memory', message: "no lesson m-9 in this workspace's memory" };
const NO_CHANGE = { code: 'unknown_memory', message: "no change h-9 in this workspace's memory" };
const FULL = { code: 'memory_full', message: MEMORY_FULL_MESSAGE };
const SECRET = { code: 'memory_secret', message: MEMORY_SECRET_MESSAGE };

// A file no edit may touch: a write into a frozen object throws, since an ES module is strict
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}
const entry = (n: number, description: string, extra: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({ id: `m-${n}`, kind: 'fact', description, body: `body of m-${n}`, origin: 'user', at: AT, uses: 0, ...extra });
const FILE: MemoryFile = frozen({
  nextId: 4, nextChangeId: 1, history: [],
  entries: [entry(1, 'pnpm test is the gate', { uses: 3, lastUsed: { at: AT, task: '700' } }), entry(2, 'never run git push --force', { origin: { task: '790', stage: 'spec' } }), entry(3, 'specs are written in English')],
});
function fileOf(result: MemoryResult): MemoryFile {
  assert.ok(!isMemoryRefusal(result), JSON.stringify(result));
  return result;
}

test('withRevision rewrites only the given fields, trimmed, moves at, keeps id, origin, uses and lastUsed, and appends a revised change with the lesson as it was, the caller and the why (#683)', () => {
  const revised = fileOf(withRevision(FILE, 'm-1', { description: '  pnpm test is the only gate  ' }, { by: BY, why: '  CI runs it too  ' }, LATER, CAP));
  assert.deepEqual(revised.entries[0], { ...FILE.entries[0], description: 'pnpm test is the only gate', at: LATER });
  assert.deepEqual(revised.history, [{ id: 'h-1', entry: FILE.entries[0], action: 'revised', by: BY, why: 'CI runs it too', at: LATER }]);
  assert.deepEqual([revised.nextId, revised.nextChangeId, revised.entries.slice(1)], [4, 2, FILE.entries.slice(1)]);
  const all = fileOf(withRevision(revised, 'm-1', { kind: 'avoid', description: 'x', body: '  new body\n\tkept  ' }, { by: 'local', why: 'w' }, AT, CAP));
  assert.deepEqual([all.entries[0].kind, all.entries[0].description, all.entries[0].body, all.entries[0].uses, all.entries[0].origin], ['avoid', 'x', 'new body\n\tkept', 3, 'user']);
  assert.deepEqual(all.history.map((c) => [c.id, c.by, c.entry.description]), [['h-1', BY, 'pnpm test is the gate'], ['h-2', 'local', 'pnpm test is the only gate']]);
});

test('withRevision refuses an unknown id and a revision that takes the descriptions past the cap and grows them; a shrink or a body passes (#683)', () => {
  const full: MemoryFile = { nextId: 41, nextChangeId: 1, history: [], entries: Array.from({ length: 40 }, (_, i) => entry(i + 1, 'y'.repeat(100))) }; // exactly 4,000
  assert.deepEqual(withRevision(full, 'm-1', { description: 'y'.repeat(101) }, { by: BY, why: 'w' }, AT, CAP), FULL);
  assert.equal(fileOf(withRevision(full, 'm-1', { description: 'short' }, { by: BY, why: 'w' }, AT, CAP)).history.length, 1);
  assert.equal(fileOf(withRevision(full, 'm-1', { body: 'b'.repeat(4000) }, { by: BY, why: 'w' }, AT, CAP)).entries[0].body.length, 4000, 'a body counts for nothing');
  assert.deepEqual(withRevision(FILE, 'm-9', { body: 'x' }, { by: BY, why: 'w' }, AT, CAP), UNKNOWN);
});

test('withForgotten removes the lesson, keeps nextId and appends a removed change with the lesson whole; an unknown id is refused (#683)', () => {
  const forgot = fileOf(withForgotten(FILE, 'm-2', { by: 'local', why: ' the repository moved on ' }, LATER));
  assert.deepEqual([forgot.nextId, forgot.entries.map((e) => e.id)], [4, ['m-1', 'm-3']]);
  assert.deepEqual(forgot.history, [{ id: 'h-1', entry: FILE.entries[1], action: 'removed', by: 'local', why: 'the repository moved on', at: LATER }]);
  assert.deepEqual(withForgotten(FILE, 'm-9', { by: 'local', why: 'w' }, AT), UNKNOWN);
});

test('a 51st change drops the oldest: the history keeps its newest MEMORY_HISTORY_MAX, a change id is never reused, and what it writes parses (#683)', () => {
  const file = Array.from({ length: MEMORY_HISTORY_MAX + 1 }, (_, i) => i + 1)
    .reduce((current, n) => fileOf(withRevision(current, 'm-3', { body: `body ${n}` }, { by: BY, why: `why ${n}` }, AT, CAP)), FILE);
  assert.equal(file.history.length, MEMORY_HISTORY_MAX);
  assert.deepEqual([file.history[0].id, file.history[0].why, file.history.at(-1)?.id, file.nextChangeId], ['h-2', 'why 2', 'h-51', 52]);
  assert.deepEqual(parseMemory(JSON.parse(JSON.stringify(file))), file);
});

test('withRestored puts a revised change back over the lesson with its kind, description, body, origin and at, keeping the current uses and lastUsed; a lesson since removed, or a removed change, comes back whole; the change leaves the history (#683)', () => {
  const revised = fileOf(withRevision(FILE, 'm-1', { kind: 'pref', description: 'changed' }, { by: BY, why: 'w' }, LATER, CAP));
  const read = { ...revised, entries: revised.entries.map((e) => (e.id === 'm-1' ? { ...e, uses: 4, lastUsed: { at: LATER, task: '813' } } : e)) }; // a read after the revision
  const back = fileOf(withRestored(read, 'h-1', CAP));
  assert.deepEqual(back.entries[0], { ...FILE.entries[0], uses: 4, lastUsed: { at: LATER, task: '813' } });
  assert.deepEqual([back.history, back.nextChangeId], [[], 2]);
  const gone = fileOf(withForgotten(revised, 'm-1', { by: BY, why: 'w' }, LATER));
  const again = fileOf(withRestored(gone, 'h-1', CAP));
  assert.deepEqual([again.entries[0], again.history.map((c) => c.id)], [FILE.entries[0], ['h-2']], 'a revised change of a lesson since removed comes back whole, first by its id');
  const forgot = fileOf(withForgotten(FILE, 'm-2', { by: BY, why: 'w' }, LATER));
  const restored = fileOf(withRestored(forgot, 'h-1', CAP));
  assert.deepEqual([restored.entries.find((e) => e.id === 'm-2'), restored.nextId, restored.history], [FILE.entries[1], 4, []]);
});

test('withRestored puts a lesson that comes back whole at its id\'s place, by the id\'s number, not at the end (#684)', () => {
  const many: MemoryFile = { ...FILE, nextId: 12, entries: [entry(1, 'a'), entry(2, 'b'), entry(10, 'j'), entry(11, 'k')] };
  const back = (id: string): string[] => fileOf(withRestored(fileOf(withForgotten(many, id, { by: BY, why: 'w' }, LATER)), 'h-1', CAP)).entries.map((e) => e.id);
  for (const id of ['m-1', 'm-2', 'm-11']) assert.deepEqual(back(id), ['m-1', 'm-2', 'm-10', 'm-11'], id); // m-2 before m-10: a string order would put it last
});

test('withRestored refuses an unknown change and a restore that takes the descriptions past the cap and grows them; withDiscarded only takes the change out and refuses an unknown one (#683)', () => {
  const forgot = fileOf(withForgotten(FILE, 'm-2', { by: BY, why: 'w' }, LATER));
  assert.deepEqual(withRestored(forgot, 'h-1', memoryUsed(forgot.entries)), FULL);
  assert.deepEqual(withRestored(forgot, 'h-9', CAP), NO_CHANGE);
  assert.deepEqual(fileOf(withDiscarded(forgot, 'h-1')), { ...forgot, history: [] });
  assert.deepEqual(withDiscarded(forgot, 'h-9'), NO_CHANGE);
});

test('no history edit mutates its input: each runs on a frozen file (#683)', () => {
  const forgot = frozen(fileOf(withForgotten(FILE, 'm-2', { by: BY, why: 'w' }, LATER)));
  const snapshot = structuredClone(forgot);
  fileOf(withRevision(forgot, 'm-1', { body: 'x' }, { by: BY, why: 'w' }, AT, CAP));
  fileOf(withForgotten(forgot, 'm-1', { by: BY, why: 'w' }, AT));
  fileOf(withRestored(forgot, 'h-1', CAP));
  fileOf(withDiscarded(forgot, 'h-1'));
  assert.deepEqual(forgot, snapshot);
});

test('revisionRefusal wants one of the three fields, then each given field and the why in shape, then no secret in any; forgetRefusal checks the why alike (#683)', () => {
  const key = `use ${'Zx9'.repeat(11)} here`; // a secret's shape built from pieces, never a real one
  assert.deepEqual(revisionRefusal({}, 'w'), { code: 'bad_memory', message: NO_FIELD_MESSAGE });
  assert.equal(revisionRefusal({ kind: 'pref' }, 'it is how the user wants it'), undefined);
  assert.deepEqual(revisionRefusal({ description: 'two\nlines' }, 'w'), { code: 'bad_memory', message: DESCRIPTION_MESSAGE });
  assert.deepEqual(revisionRefusal({ body: 'a\rb' }, 'w'), { code: 'bad_memory', message: BODY_MESSAGE });
  assert.deepEqual(revisionRefusal({ body: 'x' }, 'one\ntwo'), { code: 'bad_memory', message: WHY_MESSAGE });
  assert.deepEqual(revisionRefusal({ body: key }, 'one\ntwo'), { code: 'bad_memory', message: WHY_MESSAGE }, 'the shape comes before a secret');
  for (const fields of [{ description: key }, { body: key }]) assert.deepEqual(revisionRefusal(fields, 'w'), SECRET);
  assert.deepEqual(revisionRefusal({ kind: 'fact' }, key), SECRET);
  assert.equal(forgetRefusal('it no longer holds'), undefined);
  assert.deepEqual(forgetRefusal(''), { code: 'bad_memory', message: WHY_MESSAGE });
  assert.deepEqual(forgetRefusal(key), SECRET);
});

test('the store writes a forget into the protocol files, and a discard, which changes only the history, leaves them alone (#683)', async (t) => {
  const home = await tempDir(t, 'home-');
  const store = createMemoryStore(home, () => true);
  const { stage } = workspaceProtocolPaths(home, 'site');
  fileOf(await store.update('site', (file) => withEntry(file, 'fact', 'pnpm test is the gate', 'the lesson', 'user', AT, CAP)));
  assert.ok((await readFile(stage, 'utf8')).includes('- [m-1] pnpm test is the gate'));
  fileOf(await store.update('site', (file) => withForgotten(file, 'm-1', { by: BY, why: 'w' }, AT)));
  assert.equal((await readFile(stage, 'utf8')).includes('pnpm test is the gate'), false, 'the forgotten lesson left the section');
  await writeFile(stage, 'as launched');
  const saved = fileOf(await store.update('site', (file) => withDiscarded(file, 'h-1')));
  assert.deepEqual([saved.history, await readFile(stage, 'utf8')], [[], 'as launched']);
  assert.deepEqual(JSON.parse(await readFile(memoryPath(home, 'site'), 'utf8')), saved);
});
