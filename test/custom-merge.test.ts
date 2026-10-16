import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { previewUpdate, recoverStaging } from '../src/custom-merge.js';
import { createCustomStore, type CustomStore } from '../src/custom-store.js';
import { isRefusal, type StoreRefusal } from '../src/custom-versions.js';
import { listFiles } from '../src/item-sources.js';
import { findItem } from '../src/items-catalogue.js';
import type { UpdatePreview } from '../src/types.js';
import { BUILD, DEPLOY, type Fixture, fixture, put, REPO_SKILL, skillDoc, snapshot } from './custom-fixture.js';
import { fakeLog } from './fakes.js';
import type { AfterHost } from './temp-dir.js';

const BASE = skillDoc('Take the issue.', 'A PR.');
const MINE = skillDoc('Take the issue number.', 'A PR.');
const open = (f: Fixture, changes: string[][] = []): CustomStore =>
  createCustomStore({ home: f.home, pluginSource: f.pluginSource, workspaces: () => f.workspaces, onChange: (ws) => changes.push(ws), log: fakeLog().log });
const buildDir = (f: Fixture, ...rest: string[]): string => join(f.home, 'custom/hive/new-build', ...rest);
const codeOf = (value: object): string | undefined => (isRefusal(value) ? value.code : undefined);
// A new Hive release: plugin.json says 0.2.0, and `files` (paths under the plugin) are what it changes
const ship = (f: Fixture, files: Record<string, string>): Promise<void> => put(f.pluginSource, { '.claude-plugin/plugin.json': '{"name":"hive","version":"0.2.0"}', ...files });

/** new-build shipped with SKILL.md = BASE (and the `extra` plugin files), and its version mine saved from the original with SKILL.md = `text`. */
async function customized(t: AfterHost, text = MINE, extra: Record<string, string> = {}): Promise<{ f: Fixture; store: CustomStore }> {
  const f = await fixture(t);
  await put(f.pluginSource, { 'skills/new-build/SKILL.md': BASE, ...extra });
  const store = open(f);
  await store.saveFile(BUILD, null, 'SKILL.md', text);
  return { f, store };
}

async function preview(f: Fixture, version = 'mine', id = BUILD): Promise<UpdatePreview> {
  const answer = await previewUpdate(f, id, version);
  if (isRefusal(answer)) return assert.fail(`${answer.code}: ${answer.message}`);
  return answer;
}

/** The four file cases: the Hive adds new.sh, removes the untouched run.sh and the edited edited.sh, and changes gone.sh, which the user deleted. */
async function fileCases(t: AfterHost): Promise<{ f: Fixture; store: CustomStore }> {
  const { f, store } = await customized(t, BASE, { 'skills/new-build/scripts/edited.sh': 'a\n', 'skills/new-build/scripts/gone.sh': 'g\n' });
  await store.saveFile(BUILD, 'mine', 'scripts/edited.sh', 'a mine\n');
  await store.deleteFile(BUILD, 'mine', 'scripts/gone.sh');
  await rm(join(f.pluginSource, 'skills/new-build/scripts/run.sh'));
  await rm(join(f.pluginSource, 'skills/new-build/scripts/edited.sh'));
  await ship(f, { 'skills/new-build/scripts/new.sh': 'n\n', 'skills/new-build/scripts/gone.sh': 'g2\n' });
  return { f, store };
}

/** mine's main file renamed to SKILL.md.liquid (#310); the Hive ships a change to its SKILL.md's Output. */
async function liquidVersion(t: AfterHost): Promise<{ f: Fixture; store: CustomStore }> {
  const { f, store } = await customized(t);
  await store.saveFile(BUILD, 'mine', 'SKILL.md.liquid', skillDoc('Take {{ issue }}.', 'A PR.'), 'SKILL.md');
  await ship(f, { 'skills/new-build/SKILL.md': skillDoc('Take the issue.', 'A pull request.') });
  return { f, store };
}

/** mine edits only scripts/run.sh; the Hive replaces its SKILL.md with a SKILL.md.liquid. */
async function untouchedMain(t: AfterHost): Promise<{ f: Fixture; store: CustomStore }> {
  const { f, store } = await customized(t, BASE);
  await store.saveFile(BUILD, 'mine', 'scripts/run.sh', 'echo mine\n');
  await rm(join(f.pluginSource, 'skills/new-build/SKILL.md'));
  await ship(f, { 'skills/new-build/SKILL.md.liquid': skillDoc('Take {{ issue }}.', 'A PR.') });
  return { f, store };
}

/** hive-site's deploy saved as mine with its description edited; the repository then changes its last line. */
async function workspaceVersion(t: AfterHost): Promise<{ f: Fixture; store: CustomStore; mine: string }> {
  const f = await fixture(t);
  const store = open(f);
  const mine = REPO_SKILL.replace('Deploys the site', 'Deploys the site, mine');
  await store.saveFile(DEPLOY, null, 'SKILL.md', mine);
  await put(f.site, { '.claude/skills/deploy/SKILL.md': REPO_SKILL.replace('Deploy.', 'Deploy now.') });
  return { f, store, mine };
}

test('a shipped change away from the edited lines previews as clean changes labelled by heading, and writes nothing (#324)', async (t) => {
  const { f } = await customized(t);
  await ship(f, { 'skills/new-build/SKILL.md': skillDoc('Take the issue.', 'A pull request.') });
  const before = await snapshot(buildDir(f, 'mine'));
  const answer = await preview(f);
  assert.deepEqual([answer.version, answer.from, answer.to], ['mine', '0.1.0', '0.2.0']);
  assert.match(answer.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(answer.changes, [{ kind: 'clean', file: 'SKILL.md', heading: '## Output', removed: ['A PR.'], added: ['A pull request.'] }]);
  assert.deepEqual(await snapshot(buildDir(f, 'mine')), before, "the version's files, the render's input, are unchanged");
  assert.equal((await preview(f)).token, answer.token, 'the same three inputs give the same token');
});

test('an overlapping change previews one conflict with mine, hive and base, and each version answers its own preview (#324)', async (t) => {
  const { f, store } = await customized(t);
  await store.createVersion(BUILD, 'other', 'original');
  await store.saveFile(BUILD, 'other', 'SKILL.md', skillDoc('Take the issue id.', 'A PR.'));
  await ship(f, { 'skills/new-build/SKILL.md': skillDoc('Take the issue URL.', 'A PR.') });
  const conflict = (mine: string) => ({ kind: 'conflict', id: 'SKILL.md#0', file: 'SKILL.md', heading: '## Input', mine: [mine], hive: ['Take the issue URL.'], base: ['Take the issue.'] });
  assert.deepEqual((await preview(f, 'mine')).changes, [conflict('Take the issue number.')]);
  assert.deepEqual((await preview(f, 'other')).changes, [conflict('Take the issue id.')]);
});

test('an added file is clean, an untouched removed file is clean, an edited removed file and a deleted changed file are whole-file conflicts (#324)', async (t) => {
  const { f } = await fileCases(t);
  assert.deepEqual((await preview(f)).changes, [
    { kind: 'conflict', id: 'scripts/edited.sh#file', file: 'scripts/edited.sh', heading: 'scripts/edited.sh', mine: ['a mine'], hive: null, base: ['a'] },
    { kind: 'conflict', id: 'scripts/gone.sh#file', file: 'scripts/gone.sh', heading: 'scripts/gone.sh', mine: null, hive: ['g2'], base: ['g'] },
    { kind: 'clean', file: 'scripts/new.sh', heading: 'scripts/new.sh', removed: [], added: ['n'] },
    { kind: 'clean', file: 'scripts/run.sh', heading: 'scripts/run.sh', removed: ['echo hi'], added: [] },
  ]);
});

test('the main file pairs by role: a SKILL.md.liquid version merges against the shipped SKILL.md, an untouched SKILL.md against a shipped SKILL.md.liquid (#324)', async (t) => {
  const liquid = await liquidVersion(t);
  assert.deepEqual((await preview(liquid.f)).changes, [{ kind: 'clean', file: 'SKILL.md.liquid', heading: '## Output', removed: ['A PR.'], added: ['A pull request.'] }]);
  const untouched = await untouchedMain(t);
  assert.deepEqual((await preview(untouched.f)).changes, [{ kind: 'clean', file: 'SKILL.md', heading: '## Input', removed: ['Take the issue.'], added: ['Take {{ issue }}.'] }]);
});

test("a workspace item's version previews its repository's change, with no Hive versions (#324)", async (t) => {
  const { f } = await workspaceVersion(t);
  const answer = await preview(f, 'mine', DEPLOY);
  assert.deepEqual([answer.from, answer.to], [undefined, undefined]);
  assert.deepEqual(answer.changes, [{ kind: 'clean', file: 'SKILL.md', heading: 'SKILL.md', removed: ['Deploy.'], added: ['Deploy now.'] }]);
});

test('a version with no update, an unknown item or version, and an item the Hive no longer ships are refused (#324)', async (t) => {
  const { f } = await customized(t);
  assert.equal(codeOf(await previewUpdate(f, BUILD, 'mine')), 'no_update');
  assert.equal(codeOf(await previewUpdate(f, 'hive:nope', 'mine')), 'unknown_item');
  assert.equal(codeOf(await previewUpdate(f, BUILD, 'ghost')), 'unknown_version');
  await rm(join(f.pluginSource, 'skills/new-build'), { recursive: true });
  const gone = await previewUpdate(f, BUILD, 'mine');
  assert.equal(codeOf(gone), 'no_update');
  assert.match((gone as StoreRefusal).message, /the Hive no longer ships new-build/);
});

const BOTH = ['agent-hive', 'hive-site'];
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
// Every file under `dir` with its text: what a version's files/ holds after an apply
const texts = async (dir: string): Promise<Record<string, string>> =>
  Object.fromEntries(await Promise.all((await listFiles(dir)).map(async (path) => [path, await readFile(join(dir, path), 'utf8')] as const)));

test('applying a clean update stores the merged text, the shipped files as base/ and the new hiveVersion; the item reads customized (#324)', async (t) => {
  const { f } = await customized(t);
  await ship(f, { 'skills/new-build/SKILL.md': skillDoc('Take the issue.', 'A pull request.') });
  const { token } = await preview(f);
  const changes: string[][] = [];
  assert.deepEqual(await open(f, changes).applyUpdate(BUILD, 'mine', token, {}), { workspaces: BOTH });
  assert.deepEqual(changes, [BOTH], "onChange re-renders the version's workspaces");
  assert.deepEqual(await texts(buildDir(f, 'mine/files')), { 'SKILL.md': skillDoc('Take the issue number.', 'A pull request.'), 'scripts/run.sh': 'echo hi\n' });
  assert.deepEqual(await snapshot(buildDir(f, 'mine/base')), await snapshot(join(f.pluginSource, 'skills/new-build')));
  assert.deepEqual(await json(buildDir(f, 'mine/version.json')), { name: 'mine', from: 'original', workspaces: BOTH, hiveVersion: '0.2.0' });
  assert.equal((await findItem(f, BUILD))?.state, 'customized');
  await assert.rejects(stat(join(f.home, 'custom-staging')), 'nothing is left in the staging area');
});

test('a conflict needs a choice: unresolved without one, mine keeps the line, hive takes the shipped one; the other version stays update available (#324)', async (t) => {
  const { f, store } = await customized(t);
  await store.createVersion(BUILD, 'other', 'original');
  await store.saveFile(BUILD, 'other', 'SKILL.md', skillDoc('Take the issue id.', 'A PR.'));
  await ship(f, { 'skills/new-build/SKILL.md': skillDoc('Take the issue URL.', 'A PR.') });
  const { token } = await preview(f, 'mine');
  const refused = await store.applyUpdate(BUILD, 'mine', token, {});
  assert.equal(codeOf(refused), 'unresolved');
  assert.match((refused as StoreRefusal).message, /SKILL\.md#0/);
  assert.deepEqual(await store.applyUpdate(BUILD, 'mine', token, { 'SKILL.md#0': 'mine', 'ghost.md#3': 'hive' }), { workspaces: BOTH }, 'an unknown id is ignored');
  assert.equal(await readFile(buildDir(f, 'mine/files/SKILL.md'), 'utf8'), MINE);
  const versions = async () => (await findItem(f, BUILD))?.versions.map((v) => [v.name, v.updateAvailable]);
  assert.deepEqual(await versions(), [['mine', false], ['other', true]]);
  assert.deepEqual(await store.applyUpdate(BUILD, 'other', (await preview(f, 'other')).token, { 'SKILL.md#0': 'hive' }), { workspaces: [] });
  assert.equal(await readFile(buildDir(f, 'other/files/SKILL.md'), 'utf8'), skillDoc('Take the issue URL.', 'A PR.'));
  assert.deepEqual(await versions(), [['mine', false], ['other', false]]);
});

test('a token from before a save to the version is refused stale, and the save stays (#324)', async (t) => {
  const { f, store } = await customized(t);
  await ship(f, { 'skills/new-build/SKILL.md': skillDoc('Take the issue.', 'A pull request.') });
  const { token } = await preview(f);
  await store.saveFile(BUILD, 'mine', 'SKILL.md', 'saved after the preview\n');
  assert.equal(codeOf(await store.applyUpdate(BUILD, 'mine', token, {})), 'stale');
  assert.equal(await readFile(buildDir(f, 'mine/files/SKILL.md'), 'utf8'), 'saved after the preview\n');
});

test('a whole-file conflict keeps or drops the file as chosen; the clean adds and removals always apply (#324)', async (t) => {
  const kept = await fileCases(t);
  await kept.store.applyUpdate(BUILD, 'mine', (await preview(kept.f)).token, { 'scripts/edited.sh#file': 'mine', 'scripts/gone.sh#file': 'hive' });
  assert.deepEqual(await texts(buildDir(kept.f, 'mine/files')), { 'SKILL.md': BASE, 'scripts/edited.sh': 'a mine\n', 'scripts/gone.sh': 'g2\n', 'scripts/new.sh': 'n\n' });
  const dropped = await fileCases(t);
  await dropped.store.applyUpdate(BUILD, 'mine', (await preview(dropped.f)).token, { 'scripts/edited.sh#file': 'hive', 'scripts/gone.sh#file': 'mine' });
  assert.deepEqual(await texts(buildDir(dropped.f, 'mine/files')), { 'SKILL.md': BASE, 'scripts/new.sh': 'n\n' });
});

test('a SKILL.md.liquid version keeps its .liquid name; an untouched SKILL.md takes the shipped SKILL.md.liquid name (#324)', async (t) => {
  const liquid = await liquidVersion(t);
  await liquid.store.applyUpdate(BUILD, 'mine', (await preview(liquid.f)).token, {});
  assert.deepEqual(await texts(buildDir(liquid.f, 'mine/files')), { 'SKILL.md.liquid': skillDoc('Take {{ issue }}.', 'A pull request.'), 'scripts/run.sh': 'echo hi\n' });
  const untouched = await untouchedMain(t);
  await untouched.store.applyUpdate(BUILD, 'mine', (await preview(untouched.f)).token, {});
  assert.deepEqual(await texts(buildDir(untouched.f, 'mine/files')), { 'SKILL.md.liquid': skillDoc('Take {{ issue }}.', 'A PR.'), 'scripts/run.sh': 'echo mine\n' });
  assert.equal((await findItem(untouched.f, BUILD))?.state, 'customized');
});

test('a CRLF file keeps its line endings after apply (#324)', async (t) => {
  const crlf = (first: string, last: string): string => `${first}\r\ntwo\r\nthree\r\nfour\r\n${last}\r\n`;
  const { f, store } = await customized(t, BASE, { 'skills/new-build/notes.md': crlf('one', 'five') });
  await store.saveFile(BUILD, 'mine', 'notes.md', crlf('ONE', 'five'));
  await ship(f, { 'skills/new-build/notes.md': crlf('one', 'FIVE') });
  const answer = await preview(f);
  assert.deepEqual(answer.changes, [{ kind: 'clean', file: 'notes.md', heading: 'notes.md', removed: ['five'], added: ['FIVE'] }]);
  await store.applyUpdate(BUILD, 'mine', answer.token, {});
  assert.equal(await readFile(buildDir(f, 'mine/files/notes.md'), 'utf8'), crlf('ONE', 'FIVE'));
});

test("a workspace item's version merges like a Hive one, and its version.json gets no hiveVersion (#324)", async (t) => {
  const { f, store, mine } = await workspaceVersion(t);
  const { token } = await preview(f, 'mine', DEPLOY);
  assert.deepEqual(await store.applyUpdate(DEPLOY, 'mine', token, {}), { workspaces: ['hive-site'] });
  const dir = join(f.home, 'custom/hive-site/deploy/mine');
  assert.equal(await readFile(join(dir, 'files/SKILL.md'), 'utf8'), mine.replace('Deploy.', 'Deploy now.'));
  assert.deepEqual(await json(join(dir, 'version.json')), { name: 'mine', from: 'original', workspaces: ['hive-site'] });
  assert.equal(codeOf(await store.applyUpdate(DEPLOY, 'mine', token, {})), 'no_update');
});

test('a crash between the swap renames is undone: the version comes back from staging, and an unrelated leftover is removed (#324)', async (t) => {
  const { f } = await customized(t);
  const work = join(f.home, 'custom-staging/hive/new-build/mine');
  await mkdir(work, { recursive: true });
  await rename(buildDir(f, 'mine'), join(work, 'old'));
  await mkdir(join(f.home, 'custom-staging/hive/deploy/mine/stray'), { recursive: true });
  await recoverStaging(f.home);
  assert.deepEqual(await texts(buildDir(f, 'mine/files')), { 'SKILL.md': MINE, 'scripts/run.sh': 'echo hi\n' });
  await assert.rejects(stat(join(f.home, 'custom-staging')), 'the staging area is empty again');
});

test('a file with a NUL byte changed on both sides is a whole-file conflict, not a failed merge (#324)', async (t) => {
  const { f, store } = await customized(t, MINE, { 'skills/new-build/data.bin': 'a\0b\n' });
  await store.saveFile(BUILD, 'mine', 'data.bin', 'a\0mine\n');
  await ship(f, { 'skills/new-build/data.bin': 'a\0hive\n' });
  const conflicts = (await preview(f)).changes.filter((c) => c.kind === 'conflict');
  assert.deepEqual(conflicts.map((c) => c.kind === 'conflict' && c.id), ['data.bin#file']);
});
