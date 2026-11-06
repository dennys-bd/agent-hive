import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_MESSAGE, bodyProblem, DESCRIPTION_MESSAGE, descriptionProblem, createMemoryStore, EMPTY_MEMORY, isMemoryRefusal, looksLikeSecret, MEMORY_FULL_MESSAGE, type MemoryResult, memoryPath, memoryUsed,
  parseMemory, recalledOf, renderMemory, renderedOf, whyProblem, withEdit, withEntry, withoutEntry, withUse,
} from '../src/memory.js';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceProtocolPaths } from '../src/hooks-settings.js';
import { type ProtocolFor, SESSION_PROTOCOL, STAGE_PROTOCOL } from '../src/protocol.js';
import { tempDir } from './temp-dir.js';
import { MEMORY_HISTORY_MAX, type MemoryChange, type MemoryEntry, type MemoryFile } from '../src/types.js';

const AT = '2026-10-05T10:00:00.000Z';
const entry = (n: number, kind: MemoryEntry['kind'], description: string, body = `body of m-${n}`): MemoryEntry =>
  ({ id: `m-${n}`, kind, description, body, origin: 'user', at: AT, uses: 0 });
// #683: a file whole but for what a test breaks
const raw = (nextId: number, entries: unknown[]): unknown => ({ nextId, nextChangeId: 1, entries, history: [] });
const FILE: MemoryFile = {
  nextId: 4, nextChangeId: 1, history: [],
  entries: [entry(1, 'fact', 'pnpm test is the gate'), entry(2, 'avoid', 'never run git push --force'), entry(3, 'pref', 'specs are written in English')],
};
const UNKNOWN = { code: 'unknown_memory', message: "no lesson m-9 in this workspace's memory" };
const CAP = 4000; // the cap #797's tests were written against
const FULL = { code: 'memory_full', message: MEMORY_FULL_MESSAGE };

// A result that must be a file: the refusal shows otherwise
function fileOf(result: MemoryResult): MemoryFile {
  assert.ok(!isMemoryRefusal(result), JSON.stringify(result));
  return result;
}

test('parseMemory takes descriptions of 1 to 150 and bodies of 1 to 4,000 characters, and throws on a text key, no body, an empty field, a field past its limit, a bad kind or a missing counter (#797, #680)', () => {
  const edge: MemoryFile = { nextId: 3, nextChangeId: 1, history: [], entries: [entry(1, 'fact', 'x', 'y'), entry(2, 'pref', 'd'.repeat(150), `${'b'.repeat(1998)}\n\t${'b'.repeat(2000)}`)] };
  assert.deepEqual(parseMemory(JSON.parse(JSON.stringify(edge))), edge);
  const used: MemoryFile = { nextId: 2, nextChangeId: 1, history: [], entries: [{ ...entry(1, 'fact', 'x'), origin: { task: '812', stage: 'build' }, uses: 2, lastUsed: { at: AT, task: '812', stage: 'build' } }] };
  assert.deepEqual(parseMemory(JSON.parse(JSON.stringify(used))), used);
  assert.deepEqual(parseMemory({ nextId: 1, nextChangeId: 1, entries: [], history: [] }), EMPTY_MEMORY);
  const noBody = { id: 'm-1', kind: 'fact', description: 'x', origin: 'user', at: AT, uses: 0 };
  const bad: [unknown, string][] = [
    [{ ...entry(1, 'fact', 'x'), text: 'x' }, 'a text key'], [{ id: 'm-1', kind: 'fact', text: 'x', origin: 'user', at: AT, uses: 0 }, 'the old shape'],
    [noBody, 'no body'], [entry(1, 'fact', ''), 'an empty description'], [entry(1, 'fact', 'x', ' \n '), 'an empty body'],
    [entry(1, 'fact', 'd'.repeat(151)), 'a description past 150'], [entry(1, 'fact', 'x', 'b'.repeat(4001)), 'a body past 4,000'],
    [entry(1, 'fact', 'two\nlines'), 'a description of two lines'], [entry(1, 'fact', 'a b'), 'a line separator'],
    [entry(1, 'fact', 'x', 'a\rb'), 'a carriage return in the body'], [{ ...entry(1, 'fact', 'x'), kind: 'correction' }, 'a kind'],
  ];
  for (const [value, why] of bad) assert.throws(() => parseMemory(raw(2, [value])), /not a memory file/, why);
  assert.throws(() => parseMemory({ entries: [] }), /not a memory file/);
  assert.throws(() => parseMemory(raw(3, [entry(1, 'fact', 'x'), entry(1, 'fact', 'y')])), /not a memory file/, 'a duplicated id');
  assert.throws(() => parseMemory(raw(2, [entry(2, 'fact', 'x')])), /not a memory file/, 'a counter not past every id');
  assert.throws(() => parseMemory([]), /not a memory file/);
});

test('parseMemory requires nextChangeId and history: it throws with either missing, a change of a bad shape, a repeated change id or one at or past the counter, and more than 50 changes; a full file reads back as written (#683)', () => {
  const change: MemoryChange = { id: 'h-1', entry: entry(9, 'fact', 'the lesson as it was'), action: 'revised', by: { task: '812', stage: 'build' }, why: 'it proved wrong', at: AT };
  const full: MemoryFile = { ...FILE, nextChangeId: 3, history: [change, { ...change, id: 'h-2', action: 'removed', by: 'local' }] };
  assert.deepEqual(parseMemory(JSON.parse(JSON.stringify(full))), full);
  assert.throws(() => parseMemory({ nextId: 4, nextChangeId: 1, entries: FILE.entries }), /not a memory file/, 'no history');
  assert.throws(() => parseMemory({ nextId: 4, entries: FILE.entries, history: [] }), /not a memory file/, 'no nextChangeId');
  assert.throws(() => parseMemory({ ...full, nextChangeId: 0 }), /not a memory file/, 'a counter below 1');
  const bad: [unknown, string][] = [
    [{ ...change, id: 'm-1' }, 'a lesson id'], [{ ...change, entry: { ...change.entry, body: '' } }, 'an entry of a bad shape'],
    [{ ...change, action: 'edited' }, 'an action'], [{ ...change, by: 'user' }, 'the user as its author'], [{ ...change, by: 'tasks' }, 'a by'],
    [{ ...change, why: 'two\nlines' }, 'a why of two lines'], [{ ...change, why: '' }, 'an empty why'], [{ ...change, at: 1 }, 'an at'],
  ];
  for (const [value, why] of bad) assert.throws(() => parseMemory({ ...full, history: [value] }), /not a memory file/, why);
  assert.throws(() => parseMemory({ ...full, history: [change, change] }), /not a memory file/, 'a repeated id');
  assert.throws(() => parseMemory({ ...full, nextChangeId: 2 }), /not a memory file/, 'h-2 at the counter');
  const many = Array.from({ length: MEMORY_HISTORY_MAX + 1 }, (_, i) => ({ ...change, id: `h-${i + 1}` }));
  assert.throws(() => parseMemory({ ...full, nextChangeId: 52, history: many }), /not a memory file/, 'more than 50 changes');
  assert.equal(parseMemory({ ...full, nextChangeId: 51, history: many.slice(0, MEMORY_HISTORY_MAX) }).history.length, MEMORY_HISTORY_MAX);
});

test('a description and a why are one line of 1 to 150 characters after the trim; a body is 1 to 4,000 characters of plain text that keeps line feeds and tabs (#680)', () => {
  assert.equal(descriptionProblem('  Portuguese copy for a run  '), undefined);
  assert.equal(descriptionProblem('x'.repeat(150)), undefined);
  for (const bad of ['', '   ', 'x'.repeat(151), 'one\ntwo', 'one\rtwo', 'a b', 'a b', 'a\u0007b', 'a​b', 'a‮b']) {
    assert.equal(descriptionProblem(bad), DESCRIPTION_MESSAGE, JSON.stringify(bad.slice(0, 20)));
  }
  assert.equal(bodyProblem('Run it before every commit.\n\n\tWhy: CI runs the same.'), undefined);
  assert.equal(bodyProblem(`  ${'b'.repeat(4000)}  `), undefined, 'the trim comes first');
  for (const bad of ['', ' \n\t ', 'b'.repeat(4001), 'a\rb', 'a b', 'a b', 'a​b', 'a\u0007b', 'a‮b']) {
    assert.equal(bodyProblem(bad), BODY_MESSAGE, JSON.stringify(bad.slice(0, 20)));
  }
  assert.equal(whyProblem('the lesson said so'), undefined);
  assert.equal(whyProblem('x'.repeat(151)), 'why must be one line of 1 to 150 characters');
  assert.equal(whyProblem('a\nb'), 'why must be one line of 1 to 150 characters');
  assert.equal(whyProblem('a​b'), 'why must be one line of 1 to 150 characters');
});

test('looksLikeSecret catches the common token and key shapes and leaves ordinary sentences with paths, numbers and hyphenated words alone (#797)', () => {
  // fake shapes built from pieces: never a real credential in a fixture
  const fake = 'a1B2'.repeat(6);
  const secrets = [`gh${'p'}_${fake}`, 'github_pat_11ABCDEFG0', `sk-${'abc123'.repeat(4)}`, 'AKIAIOSFODNN7EXAMPLE', '-----BEGIN OPENSSH PRIVATE KEY-----', 'Zx9'.repeat(11)];
  for (const text of secrets) assert.equal(looksLikeSecret(`use ${text} here`), true, text.slice(0, 12));
  const more = ['xoxb-12345-abcdef', `AIza${'Ab1_-'.repeat(7)}`, 'eyJhbGciOi.eyJzdWIiOi', 'PASSWORD: hunter2', 'api_key=abc', 'token = abc', 'postgres://user:pw@host/db'];
  for (const text of more) assert.equal(looksLikeSecret(`use ${text} here`), true, text.slice(0, 12));
  for (const ok of ['the token lives in the env, never in config', 'a password is never saved here', 'see https://example.com/docs for the api key rules']) assert.equal(looksLikeSecret(ok), false, ok);
  assert.equal(looksLikeSecret('run pnpm test in src/ui before a commit; it takes about 90 seconds'), false);
  assert.equal(looksLikeSecret('keep the task-specific-instructions-file-name out of CLAUDE.md'), false, 'sk- inside a word is no key');
  // #680: `/`, `-` and `_` end a run: a dated spec path or a kebab slug in a body is ordinary text
  assert.equal(looksLikeSecret('read docs/agent/hive/specs/2026-11-05-workspace-memory-index-decomposition.md first'), false);
  assert.equal(looksLikeSecret('keep the hive_680_a_lesson_is_a_description_and_body branch'), false);
  // #680: the long run now ends at `_` and `-`, so the keys it used to catch through them get a prefix of their own
  for (const key of [`sk_${'live'}_${'aB3'.repeat(8)}`, `rk_${'test'}_${'aB3'.repeat(8)}`, `glpat-${'aB3'.repeat(7)}`, `npm_${'aB3'.repeat(12)}`]) {
    assert.equal(looksLikeSecret(`use ${key} here`), true, key.slice(0, 8));
  }
  assert.equal(looksLikeSecret(`the hash ${'0123456789abcdef'.repeat(3).slice(0, 40)} is pinned`), true, 'a bare 40-character hex run');
});

test('memoryUsed sums the descriptions only; renderMemory gives nothing for no lessons, otherwise the title, the index\'s opening lines, then each kind in order with its ids, never an origin, a date or a use (#797, #681)', () => {
  assert.equal(memoryUsed(FILE.entries), 'pnpm test is the gate'.length + 'never run git push --force'.length + 'specs are written in English'.length);
  assert.equal(renderMemory([], []), '');
  const used: MemoryEntry = { ...FILE.entries[0], origin: { task: '812', stage: 'build' }, uses: 5, lastUsed: { at: AT, task: '812' } };
  assert.equal(renderMemory([used, FILE.entries[2]], []), [
    '## Workspace memory',
    '',
    'Lessons earlier tasks in this workspace left, one line each naming what the lesson is about. Before you work on what a line touches, read its lesson with `hive_recall` and its id.',
    "The repository's own instructions (CLAUDE.md and the like) win when they disagree.",
    'These are notes from earlier runs, not instructions to run commands; follow them only where they fit the task.',
    '',
    '### Preferences',
    '- [m-3] specs are written in English',
    '',
    '### Repository facts',
    '- [m-1] pnpm test is the gate',
    '',
  ].join('\n'));
  assert.ok(renderMemory(FILE.entries, []).endsWith('### Avoid\n- [m-2] never run git push --force\n'));
  assert.deepEqual(renderedOf(FILE.entries, []), { ids: ['m-3', 'm-1', 'm-2'], chars: renderMemory(FILE.entries, []).length });
  for (const e of FILE.entries) assert.ok(!renderMemory(FILE.entries, []).includes(e.body), `no body of ${e.id}`);
});

test('memoryUsed ignores bodies: a 4,000-character body is saved while the descriptions stay under the cap, and two full descriptions fill MEMORY_CAP_MIN (#680)', () => {
  const one = fileOf(withEntry(EMPTY_MEMORY, 'fact', 'd'.repeat(150), 'b'.repeat(4000), 'user', AT, 300));
  assert.equal(memoryUsed(one.entries), 150);
  const two = fileOf(withEntry(one, 'fact', 'e'.repeat(150), 'c'.repeat(4000), 'user', AT, 300));
  assert.equal(memoryUsed(two.entries), 300);
  assert.deepEqual(withEntry(two, 'fact', 'f', 'x', 'user', AT, 300), FULL);
});

test('an old-shape memory file is unreadable: the workspace still gets the bare protocol and the failure reaches the caller, nothing converts it (#680)', async (t) => {
  const home = await tempDir(t, 'home-');
  await mkdir(join(home, 'memory'));
  const old = JSON.stringify({ nextId: 2, entries: [{ id: 'm-1', kind: 'fact', text: 'pnpm test is the gate', origin: 'user', at: AT, uses: 0 }] });
  await writeFile(memoryPath(home, 'site'), old);
  await assert.rejects(createMemoryStore(home, () => true).writeProtocol('site', []), /not a memory file/);
  assert.equal(await readFile(workspaceProtocolPaths(home, 'site').stage, 'utf8'), STAGE_PROTOCOL);
  assert.equal(await readFile(memoryPath(home, 'site'), 'utf8'), old, 'the file is left as it was');
});

test('withEntry adds m-<nextId> unused and refuses when the sum of the descriptions passes the cap; withEdit keeps origin and uses and never refuses what does not grow the sum; withUse counts and replaces lastUsed; withoutEntry never reuses an id; none mutates (#797)', () => {
  const frozen = structuredClone(FILE);
  const added = fileOf(withEntry(FILE, 'avoid', '  do not edit dist/  ', '  Rebuild instead.\n  Why: dist/ is generated.\n', { task: '812', stage: 'build' }, AT, CAP));
  assert.deepEqual([added.nextId, added.entries.at(-1)], [5, { id: 'm-4', kind: 'avoid', description: 'do not edit dist/', body: 'Rebuild instead.\n  Why: dist/ is generated.', origin: { task: '812', stage: 'build' }, at: AT, uses: 0 }]);
  const full: MemoryFile = { nextId: 41, nextChangeId: 1, history: [], entries: Array.from({ length: 40 }, (_, i) => entry(i + 1, 'fact', 'y'.repeat(100))) }; // exactly 4,000
  assert.deepEqual(withEntry(full, 'fact', 'z', 'the lesson', 'user', AT, CAP), FULL);
  assert.deepEqual(withEdit(full, 'm-1', 'fact', 'y'.repeat(101), 'the lesson', AT, CAP), FULL);
  fileOf(withEdit(full, 'm-1', 'avoid', 'z'.repeat(100), 'the lesson', AT, CAP)); // same sum: never refused
  const over: MemoryFile = { ...full, entries: [...full.entries, entry(41, 'fact', 'z'.repeat(150))] }; // a hand edit left it past the cap
  fileOf(withEdit(over, 'm-41', 'fact', 'short', 'the lesson', AT, CAP)); // a shrink: never refused
  const once = fileOf(withUse(FILE, 'm-1', { at: AT, task: '812', stage: 'build' }));
  const twice = fileOf(withUse(once, 'm-1', { at: '2026-10-06T10:00:00.000Z', task: '813' }));
  assert.deepEqual([twice.entries[0].uses, twice.entries[0].lastUsed], [2, { at: '2026-10-06T10:00:00.000Z', task: '813' }]);
  const learned = { ...twice, entries: [{ ...twice.entries[0], origin: { task: '700', stage: 'spec' } }, ...twice.entries.slice(1)] };
  const edited = fileOf(withEdit(learned, 'm-1', 'pref', 'pnpm test is the only gate', 'CI runs it too', '2026-10-07T10:00:00.000Z', CAP));
  assert.deepEqual(edited.entries[0], { ...learned.entries[0], kind: 'pref', description: 'pnpm test is the only gate', body: 'CI runs it too', at: '2026-10-07T10:00:00.000Z' }, 'origin and uses kept');
  assert.deepEqual(fileOf(withoutEntry(FILE, 'm-2')), { ...FILE, entries: [FILE.entries[0], FILE.entries[2]] });
  for (const result of [withEdit(FILE, 'm-9', 'fact', 'x', 'the lesson', AT, CAP), withoutEntry(FILE, 'm-9'), withUse(FILE, 'm-9', { at: AT, task: '1' })]) assert.deepEqual(result, UNKNOWN);
  assert.deepEqual(FILE, frozen, 'no input was mutated');
});

test('the cap is the caller\'s: withEntry refuses past a cap of 500 and accepts up to it; under a cap lowered below what is used an edit that shrinks the sum passes and one that grows it is refused (#73)', () => {
  const four: MemoryFile = { nextId: 5, nextChangeId: 1, history: [], entries: Array.from({ length: 4 }, (_, i) => entry(i + 1, 'fact', 'y'.repeat(100))) }; // 400 used
  assert.equal(memoryUsed(fileOf(withEntry(four, 'fact', 'z'.repeat(100), 'the lesson', 'user', AT, 500)).entries), 500, 'exactly the cap');
  assert.deepEqual(withEntry(four, 'fact', 'z'.repeat(101), 'the lesson', 'user', AT, 500), FULL);
  assert.equal(fileOf(withEntry(four, 'fact', 'z'.repeat(101), 'the lesson', 'user', AT, CAP)).entries.length, 5, 'the same lesson under a larger cap');
  assert.equal(memoryUsed(fileOf(withEdit(four, 'm-1', 'fact', 'short', 'the lesson', AT, 300)).entries), 305, 'still past a lowered cap, but smaller: nothing is deleted or refused');
  assert.deepEqual(withEdit(four, 'm-1', 'fact', 'y'.repeat(101), 'the lesson', AT, 300), FULL);
});

test('the store keeps one file per workspace, rewrites its protocol files when the rendered memory changes and not on a use, and writes nothing for a workspace no longer live (#797)', async (t) => {
  const home = await tempDir(t, 'home-');
  const live = new Set(['site']);
  const store = createMemoryStore(home, (name) => live.has(name));
  const paths = workspaceProtocolPaths(home, 'site');
  await store.writeProtocol('site', []); // the boot's
  assert.equal(await readFile(paths.stage, 'utf8'), STAGE_PROTOCOL);
  assert.deepEqual(store.rendered('site'), { ids: [], chars: 0 });
  const saved = fileOf(await store.update('site', (file) => withEntry(file, 'fact', 'pnpm test is the gate', 'the lesson', 'user', AT, CAP)));
  assert.deepEqual(JSON.parse(await readFile(memoryPath(home, 'site'), 'utf8')), saved);
  assert.deepEqual([(await stat(memoryPath(home, 'site'))).mode & 0o777, (await stat(join(home, 'memory'))).mode & 0o777], [0o600, 0o700], 'private to the user');
  const section = renderMemory(saved.entries, []);
  assert.deepEqual([await readFile(paths.stage, 'utf8'), await readFile(paths.session, 'utf8')], [`${STAGE_PROTOCOL}\n${section}`, `${SESSION_PROTOCOL}\n${section}`]);
  assert.deepEqual(store.rendered('site'), { ids: ['m-1'], chars: section.length });
  await writeFile(paths.stage, 'by hand');
  fileOf(await store.update('site', (file) => withUse(file, 'm-1', { at: AT, task: '812' })));
  assert.equal(await readFile(paths.stage, 'utf8'), 'by hand', 'a use renders nothing: the protocol files are left alone');
  assert.deepEqual(await store.update('site', (file) => withoutEntry(file, 'm-9')), UNKNOWN);
  live.delete('site');
  await store.update('site', (file) => withEntry(file, 'fact', 'late', 'the lesson', 'user', AT, CAP));
  assert.equal((await store.read('site')).entries.length, 1, 'a workspace a save removed is never written');
});

test('a memory file the Hive cannot read still gets its workspace the bare protocol, and the failure reaches the caller (#797)', async (t) => {
  const home = await tempDir(t, 'home-');
  await mkdir(join(home, 'memory'));
  await writeFile(memoryPath(home, 'site'), '{"nextId":"x","entries":[]}');
  const store = createMemoryStore(home, () => true);
  await assert.rejects(store.writeProtocol('site', []), /not a memory file/);
  assert.equal(await readFile(workspaceProtocolPaths(home, 'site').stage, 'utf8'), STAGE_PROTOCOL);
});

test('when writing the protocol files fails after the file was saved, the update still answers the saved file and logs the error class only (#797)', async (t) => {
  const home = await tempDir(t, 'home-');
  await writeFile(join(home, 'protocol'), 'a file where the folder should be');
  const logged: string[] = [];
  const store = createMemoryStore(home, () => true, { error: (message) => logged.push(message) });
  const saved = fileOf(await store.update('site', (file) => withEntry(file, 'fact', 'pnpm test is the gate', 'the lesson', 'user', AT, CAP)));
  assert.deepEqual(JSON.parse(await readFile(memoryPath(home, 'site'), 'utf8')), saved);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^memory site: .*\(Error\)$/);
  assert.ok(!logged[0].includes('pnpm'), 'no lesson text in the line');
});

test('the index tells a run to read a lesson with hive_recall and never names hive_applied; with hive_recall off there is no section and renderedOf names nothing (#681)', () => {
  const text = renderMemory(FILE.entries, []);
  assert.ok(text.includes('read its lesson with `hive_recall` and its id'), text);
  assert.equal(text.includes('hive_applied'), false);
  assert.equal(renderMemory(FILE.entries, ['hive_recall']), '');
  assert.deepEqual(renderedOf(FILE.entries, ['hive_recall']), { ids: [], chars: 0 });
  assert.deepEqual(renderedOf(FILE.entries, ['hive_remember', 'hive_task']), { ids: ['m-3', 'm-1', 'm-2'], chars: text.length }, 'another tool off changes nothing');
});

test('writeProtocol writes what protocolFor answers for the workspace and the off it is given, the memory under it; a lesson saved later rewrites with that off (#336)', async (t) => {
  const home = await tempDir(t, 'home-');
  const asked: [string, readonly string[]][] = [];
  const protocolFor: ProtocolFor = async (workspace, off) => {
    asked.push([workspace, off]);
    return { stage: `stage of ${workspace}\n`, session: `session of ${workspace}\n`, local: `local of ${workspace}\n` };
  };
  const store = createMemoryStore(home, () => true, undefined, protocolFor);
  const paths = workspaceProtocolPaths(home, 'site');
  await store.writeProtocol('site', ['hive_create_task']);
  assert.deepEqual([await readFile(paths.stage, 'utf8'), await readFile(paths.session, 'utf8')], ['stage of site\n', 'session of site\n']);
  const saved = fileOf(await store.update('site', (file) => withEntry(file, 'fact', 'pnpm test is the gate', 'the lesson', 'user', AT, CAP)));
  const section = renderMemory(saved.entries, ['hive_create_task']);
  assert.deepEqual([await readFile(paths.stage, 'utf8'), await readFile(paths.session, 'utf8')], [`stage of site\n\n${section}`, `session of site\n\n${section}`]);
  assert.deepEqual(asked, [['site', ['hive_create_task']], ['site', ['hive_create_task']]]);
  assert.deepEqual(store.rendered('site'), { ids: ['m-1'], chars: section.length });
});

test('a lesson saved while a settings write is queued rewrites with that write\'s off, not the one before it (#336)', async (t) => {
  const home = await tempDir(t, 'home-');
  const asked: (readonly string[])[] = [];
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const protocolFor: ProtocolFor = async (_workspace, off) => {
    asked.push(off);
    if (asked.length === 1) await held; // the settings write's turn holds until the lesson's rewrite is queued behind it
    return { stage: 'stage\n', session: 'session\n', local: 'local\n' };
  };
  const store = createMemoryStore(home, () => true, undefined, protocolFor);
  const settings = store.writeProtocol('site', ['hive_create_task']);
  const lesson = store.update('site', (file) => withEntry(file, 'fact', 'pnpm test is the gate', 'the lesson', 'user', AT, CAP));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([settings, lesson]);
  assert.deepEqual(asked, [['hive_create_task'], ['hive_create_task']]);
});

test('a lesson from a local session and a use with no task parse, beside every older shape; a task, when there is one, is still a string (#256)', () => {
  const file: MemoryFile = {
    nextId: 4, nextChangeId: 1, history: [],
    entries: [
      { ...entry(1, 'fact', 'x'), origin: 'local', uses: 1, lastUsed: { at: AT } },
      { ...entry(2, 'pref', 'y'), origin: { task: '812', stage: 'build' }, uses: 1, lastUsed: { at: AT, task: '812', stage: 'build' } },
      { ...entry(3, 'avoid', 'z'), origin: { task: '790' } },
    ],
  };
  assert.deepEqual(parseMemory(JSON.parse(JSON.stringify(file))), file);
  assert.throws(() => parseMemory(raw(2, [{ ...entry(1, 'fact', 'x'), origin: 'tasks' }])), /not a memory file/);
  assert.throws(() => parseMemory(raw(2, [{ ...entry(1, 'fact', 'x'), uses: 1, lastUsed: { at: AT, task: 812 } }])), /not a memory file/);
});

test('a lastUsed with or without a why parses; withUse counts a read and replaces lastUsed whole, so a why from before #681 goes; recalledOf answers the id, kind, description and body only (#681)', () => {
  // hive_applied wrote a why until #681: untyped on purpose, as it sits on disk
  const onDisk = { nextId: 3, nextChangeId: 1, history: [], entries: [
    { ...entry(1, 'fact', 'x'), uses: 2, lastUsed: { at: AT, task: '812', stage: 'build', why: 'ran it' } },
    { ...entry(2, 'pref', 'y'), origin: 'local', uses: 1, lastUsed: { at: AT } },
  ] };
  const file = parseMemory(JSON.parse(JSON.stringify(onDisk)));
  assert.deepEqual(file.entries.map((e) => e.uses), [2, 1]);
  const LATER = '2026-10-06T10:00:00.000Z';
  const read = fileOf(withUse(file, 'm-1', { at: LATER, task: '813', stage: 'build' }));
  assert.deepEqual([read.entries[0].uses, read.entries[0].lastUsed], [3, { at: LATER, task: '813', stage: 'build' }]);
  const lesson: MemoryEntry = { ...entry(4, 'avoid', 'never edit dist/', 'Rebuild it.\n\tWhy: generated.'), origin: { task: '812', stage: 'build' }, uses: 3, lastUsed: { at: AT, task: '812' } };
  assert.deepEqual(recalledOf(lesson), { id: 'm-4', kind: 'avoid', description: 'never edit dist/', body: 'Rebuild it.\n\tWhy: generated.' });
  assert.deepEqual(Object.keys(recalledOf(lesson)), ['id', 'kind', 'description', 'body']);
});
