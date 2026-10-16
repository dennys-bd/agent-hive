import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { previewUpdate } from '../src/custom-merge.js';
import { createCustomStore, type CustomStore } from '../src/custom-store.js';
import { isRefusal, type StoreRefusal } from '../src/custom-versions.js';
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
