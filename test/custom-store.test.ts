import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createCustomStore, type StoreResult } from '../src/custom-store.js';
import { isRefusal } from '../src/custom-versions.js';
import { readCatalogue, readItem } from '../src/items-catalogue.js';
import { assertUntouched, BUILD, DEPLOY, type Fixture, fixture, HELPER, put, REPO_SKILL, SKILL, snapshot } from './custom-fixture.js';

const REVIEWER = 'hive:my-reviewer';
const BOTH = ['agent-hive', 'hive-site'];
const open = (f: Fixture, changes: string[][] = []) =>
  createCustomStore({ home: f.home, pluginSource: f.pluginSource, workspaces: () => f.workspaces, onChange: (ws) => changes.push(ws) });
const item = async (f: Fixture, id: string) => (await readCatalogue(f)).find((i) => i.id === id);
const codeOf = (result: StoreResult): string | undefined => (isRefusal(result) ? result.code : undefined);
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const buildDir = (f: Fixture, ...rest: string[]) => join(f.home, 'custom/hive/new-build', ...rest);

test('the first save of a shipped skill creates mine with files/, base/ and every workspace that used the original (#315)', async (t) => {
  const f = await fixture(t);
  const changes: string[][] = [];
  assert.deepEqual(await open(f, changes).saveFile(BUILD, null, 'SKILL.md', `${SKILL}More.\n`), { workspaces: BOTH });
  assert.deepEqual(changes, [BOTH]);
  assert.equal(await readFile(buildDir(f, 'mine/files/SKILL.md'), 'utf8'), `${SKILL}More.\n`);
  assert.equal(await readFile(buildDir(f, 'mine/files/scripts/run.sh'), 'utf8'), 'echo hi\n');
  assert.equal(await readFile(buildDir(f, 'mine/base/SKILL.md'), 'utf8'), SKILL);
  assert.deepEqual(await json(buildDir(f, 'mine/version.json')), { name: 'mine', from: 'original', workspaces: BOTH, hiveVersion: '0.1.0' });
  const read = await item(f, BUILD);
  assert.deepEqual([read?.state, read?.versions.map((v) => [v.name, v.workspaces]), read?.onOriginal], ['customized', [['mine', BOTH]], []]);
  await assertUntouched(f);
});

test('two saves of the original at once: the chain lets the first create mine and refuses the second with original_locked (#315)', async (t) => {
  const f = await fixture(t);
  const changes: string[][] = [];
  const store = open(f, changes);
  const [first, second] = await Promise.all([store.saveFile(BUILD, null, 'SKILL.md', 'a'), store.saveFile(BUILD, null, 'SKILL.md', 'b')]);
  assert.deepEqual([first, codeOf(second)], [{ workspaces: BOTH }, 'original_locked']);
  assert.deepEqual(changes, [BOTH], 'onChange only after the write that happened');
  assert.equal(await readFile(buildDir(f, 'mine/files/SKILL.md'), 'utf8'), 'a');
});

test('a new version from mine copies its files/ and base/; use in moves a workspace, which is never in two versions (#315)', async (t) => {
  const f = await fixture(t);
  const store = open(f);
  await store.saveFile(BUILD, null, 'SKILL.md', 'mine text');
  assert.deepEqual(await store.createVersion(BUILD, 'tdd-first', 'mine'), { workspaces: [] });
  assert.deepEqual(await snapshot(buildDir(f, 'tdd-first/files')), await snapshot(buildDir(f, 'mine/files')));
  assert.deepEqual(await snapshot(buildDir(f, 'tdd-first/base')), await snapshot(buildDir(f, 'mine/base')));
  const layout = async () => {
    const read = await item(f, BUILD);
    return [read?.versions.map((v) => [v.name, v.workspaces]), read?.onOriginal];
  };
  assert.deepEqual(await store.assign(BUILD, 'hive-site', 'tdd-first'), { workspaces: ['hive-site'] });
  assert.deepEqual(await layout(), [[['mine', ['agent-hive']], ['tdd-first', ['hive-site']]], []]);
  await store.assign(BUILD, 'agent-hive', null);
  assert.deepEqual(await layout(), [[['mine', []], ['tdd-first', ['hive-site']]], ['agent-hive']]);
  await store.assign(BUILD, 'agent-hive', 'tdd-first');
  assert.deepEqual(await layout(), [[['mine', []], ['tdd-first', ['hive-site', 'agent-hive']]], []]);
  assert.equal(codeOf(await store.assign(BUILD, 'ghost', 'mine')), 'unknown_workspace');
  assert.equal(codeOf(await store.assign(BUILD, 'agent-hive', 'ghost')), 'unknown_version');
  assert.equal(codeOf(await store.createVersion(BUILD, 'tdd-first', 'original')), 'exists');
  assert.equal(codeOf(await store.createVersion(BUILD, 'other', 'ghost')), 'unknown_version');
  await assertUntouched(f);
});

test('renaming a version renames its folder and version.json, and the versions made from it follow (#315)', async (t) => {
  const f = await fixture(t);
  const store = open(f);
  await store.saveFile(BUILD, null, 'SKILL.md', 'x');
  await store.createVersion(BUILD, 'tdd-first', 'mine');
  assert.deepEqual(await store.renameVersion(BUILD, 'mine', 'baseline'), { workspaces: BOTH });
  assert.deepEqual((await item(f, BUILD))?.versions.map((v) => [v.name, v.from]), [['baseline', 'original'], ['tdd-first', 'baseline']]);
  await assert.rejects(stat(buildDir(f, 'mine')));
  assert.equal(codeOf(await store.renameVersion(BUILD, 'baseline', 'tdd-first')), 'exists');
  assert.equal(codeOf(await store.renameVersion(BUILD, 'baseline', 'original')), 'bad_name');
  assert.equal(codeOf(await store.renameVersion(BUILD, 'ghost', 'other')), 'unknown_version');
});

test('reverting a version deletes its folder; with none left the item answers the original files with state original (#315)', async (t) => {
  const f = await fixture(t);
  const store = open(f);
  await store.saveFile(BUILD, null, 'SKILL.md', 'x');
  await store.createVersion(BUILD, 'tdd-first', 'mine');
  assert.deepEqual(await store.revert(BUILD, 'tdd-first'), { workspaces: [] });
  await assert.rejects(stat(buildDir(f, 'tdd-first')));
  assert.deepEqual(await store.revert(BUILD, 'mine'), { workspaces: BOTH });
  const read = await readItem(f, BUILD, null);
  assert.ok(!isRefusal(read));
  assert.deepEqual([read.item.state, read.item.versions, read.item.onOriginal], ['original', [], BOTH]);
  assert.equal(read.files.find((file) => file.path === 'SKILL.md')?.text, SKILL);
  assert.equal(codeOf(await store.revert(BUILD, 'mine')), 'unknown_version');
  await assertUntouched(f);
});

test('saving a repository item creates <home>/custom/<workspace>/<name>/mine used by that workspace only; the repository is untouched (#315)', async (t) => {
  const f = await fixture(t);
  const store = open(f);
  assert.deepEqual(await store.saveFile(DEPLOY, null, 'SKILL.md', 'mine'), { workspaces: ['hive-site'] });
  const dir = join(f.home, 'custom/hive-site/deploy/mine');
  assert.equal(await readFile(join(dir, 'files/SKILL.md'), 'utf8'), 'mine');
  assert.equal(await readFile(join(dir, 'base/SKILL.md'), 'utf8'), REPO_SKILL);
  assert.deepEqual(await json(join(dir, 'version.json')), { name: 'mine', from: 'original', workspaces: ['hive-site'] });
  assert.deepEqual(await store.saveFile(HELPER, null, 'helper.md', 'h'), { workspaces: ['hive-site'] });
  assert.equal(await readFile(join(f.home, 'custom/hive-site/helper/mine/files/helper.md'), 'utf8'), 'h');
  assert.equal((await item(f, DEPLOY))?.state, 'customized');
  await assertUntouched(f);
  await put(f.site, { '.claude/skills/deploy/SKILL.md': `${REPO_SKILL}changed\n` });
  assert.equal((await item(f, DEPLOY))?.state, 'update available', 'the update rule holds for a repository origin too');
});

test('a new Hive-side item gets every workspace and its main file, which gives its kind; a name taken in hive is refused; deleting its last version removes it (#315)', async (t) => {
  const f = await fixture(t);
  const store = open(f);
  assert.deepEqual(await store.createItem('specialist', 'my-reviewer'), { workspaces: BOTH });
  const mine = await item(f, REVIEWER);
  assert.deepEqual([mine?.kind, mine?.userCreated, mine?.state, mine?.files, mine?.onOriginal], ['specialist', true, 'customized', ['my-reviewer.md'], []]);
  const dir = join(f.home, 'custom/hive/my-reviewer/mine');
  assert.equal(await readFile(join(dir, 'files/my-reviewer.md'), 'utf8'), '---\nname: my-reviewer\ndescription: ""\n---\n');
  assert.deepEqual(await json(join(dir, 'version.json')), { name: 'mine', from: null, workspaces: BOTH });
  assert.equal(codeOf(await store.createItem('specialist', 'my-reviewer')), 'name_taken');
  assert.equal(codeOf(await store.createItem('skill', 'my-reviewer')), 'name_taken', "a custom specialist's name, for a skill");
  assert.equal(codeOf(await store.createItem('skill', 'architect')), 'name_taken', "a shipped specialist's name, for a skill");
  assert.equal(codeOf(await store.saveFile(REVIEWER, null, 'my-reviewer.md', 'x')), 'original_locked');
  assert.equal(codeOf(await store.assign(REVIEWER, 'agent-hive', null)), 'unknown_version');
  assert.deepEqual(await store.revert(REVIEWER, 'mine'), { workspaces: BOTH });
  assert.equal(await item(f, REVIEWER), undefined);
  await assert.rejects(stat(join(f.home, 'custom/hive/my-reviewer')));
  await assertUntouched(f);
});

test('a save with from renames the file (.md to .md.liquid); deleteFile removes one file and refuses the main one (#315)', async (t) => {
  const f = await fixture(t);
  const store = open(f);
  await store.saveFile(BUILD, null, 'SKILL.md', 'x');
  assert.deepEqual(await store.saveFile(BUILD, 'mine', 'SKILL.md.liquid', '{{ x }}', 'SKILL.md'), { workspaces: BOTH });
  const paths = async () => {
    const read = await readItem(f, BUILD, 'mine');
    return isRefusal(read) ? read.code : read.files.map((file) => file.path);
  };
  assert.deepEqual(await paths(), ['SKILL.md.liquid', 'scripts/run.sh']);
  assert.deepEqual(await store.deleteFile(BUILD, 'mine', 'scripts/run.sh'), { workspaces: BOTH });
  assert.equal(codeOf(await store.deleteFile(BUILD, 'mine', 'SKILL.md.liquid')), 'bad_path');
  assert.deepEqual(await paths(), ['SKILL.md.liquid']);
});

test('names with / or .., and paths with .. or a leading /, are refused; nothing outside <home>/custom/ changes (#315)', async (t) => {
  const f = await fixture(t);
  const store = open(f);
  for (const name of ['a/b', '..', '../x', 'Mine', 'original']) assert.equal(codeOf(await store.createVersion(BUILD, name, 'original')), 'bad_name', name);
  for (const name of ['a/b', '..', '../x', 'Mine']) assert.equal(codeOf(await store.createItem('skill', name)), 'bad_name', name);
  for (const path of ['../x', '/etc/passwd', 'a/../../b', 'files/../../x']) assert.equal(codeOf(await store.saveFile(BUILD, null, path, 'x')), 'bad_path', path);
  assert.equal(codeOf(await store.saveFile(BUILD, null, 'SKILL.md.liquid', 'x', '../SKILL.md')), 'bad_path');
  for (const id of ['hive:..', 'hive:../../x', 'hive-site:../deploy', '..:x']) {
    assert.equal(codeOf(await store.saveFile(id, null, 'SKILL.md', 'x')), 'unknown_item', id);
  }
  assert.deepEqual(await readdir(f.home), [], 'not even custom/ was created');
  await assertUntouched(f);
});
