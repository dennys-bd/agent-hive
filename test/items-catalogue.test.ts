import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pluginSource } from '../src/hooks-settings.js';
import { isRefusal } from '../src/custom-versions.js';
import { readCatalogue, readItem, usageOf } from '../src/items-catalogue.js';
import type { CatalogueItem } from '../src/types.js';
import { ARCHITECT, BUILD, DEPLOY, type Fixture, fixture, HELPER, put, REPO_SPECIALIST, SKILL, SPECIALIST } from './custom-fixture.js';

const find = async (f: Fixture, id: string) => (await readCatalogue(f)).find((i) => i.id === id);
const putVersion = (f: Fixture, folder: string, json: object, files: Record<string, string>) => put(join(f.home, 'custom', folder), { 'version.json': JSON.stringify(json), ...files });

test("the catalogue lists the shipped items under hive, then each workspace's .claude/ items, sorted, with state, files and users (#315)", async (t) => {
  const f = await fixture(t);
  const items = await readCatalogue(f);
  assert.deepEqual(
    items.map((i) => [i.id, i.state]),
    [
      [ARCHITECT, 'original'],
      [BUILD, 'original'],
      [DEPLOY, 'workspace'],
      [HELPER, 'workspace'],
    ],
  );
  const build = items[1];
  assert.deepEqual([build.description, build.files, build.onOriginal, build.userCreated], ['Build it', ['SKILL.md', 'scripts/run.sh'], ['agent-hive', 'hive-site'], false]);
  assert.deepEqual(items[2].onOriginal, ['hive-site'], 'a repository item is used by its own workspace');
});

test('the real shipped plugin lists its five SKILL.md.liquid skills, each with its description, its template file and no error (#317)', async (t) => {
  const f = await fixture(t);
  const skills = (await readCatalogue({ ...f, pluginSource: pluginSource() })).filter((i) => i.kind === 'skill' && i.id.startsWith('hive:'));
  assert.deepEqual(skills.map((i) => i.id.slice('hive:'.length)), ['decomposition', 'new-build', 'new-plan', 'new-pr', 'new-spec']);
  for (const skill of skills) {
    assert.deepEqual(skill.files.filter((file) => file.startsWith('SKILL')), ['SKILL.md.liquid'], skill.id);
    assert.ok(skill.description.length > 40, skill.id);
    assert.equal(skill.error, undefined, skill.id);
  }
});

test('a version whose base/ no longer matches the origin answers update available, and the item names which version has one (#315)', async (t) => {
  const f = await fixture(t);
  const rest = { 'files/SKILL.md': 'mine', 'files/scripts/run.sh': 'echo hi\n', 'base/scripts/run.sh': 'echo hi\n' };
  await putVersion(f, 'hive/new-build/mine', { name: 'mine', from: 'original', workspaces: ['agent-hive'] }, { ...rest, 'base/SKILL.md': SKILL });
  const before = await find(f, BUILD);
  assert.deepEqual([before?.state, before?.versions.map((v) => v.updateAvailable)], ['customized', [false]]);
  const shipped = `${SKILL}A shipped change.\n`;
  await put(f.pluginSource, { 'skills/new-build/SKILL.md': shipped });
  await putVersion(f, 'hive/new-build/fresh', { name: 'fresh', from: 'original', workspaces: ['hive-site'] }, { ...rest, 'base/SKILL.md': shipped });
  const after = await find(f, BUILD);
  assert.equal(after?.state, 'update available');
  assert.deepEqual(
    after?.versions.map((v) => [v.name, v.updateAvailable]),
    [
      ['fresh', false],
      ['mine', true],
    ],
  );
  await put(f.pluginSource, { 'skills/new-build/extra.md': 'x' });
  assert.deepEqual(
    (await find(f, BUILD))?.versions.map((v) => v.updateAvailable),
    [true, true],
    'a file the origin gained counts too',
  );
});

test('a workspace that left the config stays in its version as unknown; a malformed version.json lists the item with an error naming it (#315)', async (t) => {
  const f = await fixture(t);
  await putVersion(f, 'hive/architect/mine', { name: 'mine', from: 'original', workspaces: ['agent-hive', 'gone'] }, { 'files/architect.md': SPECIALIST, 'base/architect.md': SPECIALIST });
  const architect = await find(f, ARCHITECT);
  assert.deepEqual(
    architect?.versions.map((v) => [v.workspaces, v.unknownWorkspaces]),
    [[['agent-hive'], ['gone']]],
  );
  assert.deepEqual(architect?.onOriginal, ['hive-site']);
  await put(join(f.home, 'custom/hive-site/deploy/broken'), { 'version.json': '{' });
  const deploy = await find(f, DEPLOY);
  assert.match(deploy?.error?.message ?? '', /^version broken: /);
  assert.equal(deploy?.state, 'workspace');
});

test('a header that does not parse still lists the item, with the error (#315)', async (t) => {
  const f = await fixture(t);
  await put(f.site, { '.claude/skills/broken/SKILL.md': '---\nname: [unclosed\n---\nBody\n' });
  const broken = await find(f, 'hive-site:broken');
  assert.ok(broken?.error?.message, 'the parse error is on the item');
  assert.deepEqual(broken?.files, ['SKILL.md']);
});

test("readItem answers the original's files and refuses an unknown item or version (#315)", async (t) => {
  const f = await fixture(t);
  const original = await readItem(f, BUILD, null);
  assert.ok(!isRefusal(original));
  assert.deepEqual(
    [original.version, original.files],
    [
      null,
      [
        { path: 'SKILL.md', text: SKILL },
        { path: 'scripts/run.sh', text: 'echo hi\n' },
      ],
    ],
  );
  for (const id of ['hive:nope', 'hive:..', 'ghost:deploy', 'hive', 'hive:skill:new-build']) {
    const read = await readItem(f, id, null);
    assert.equal(isRefusal(read) ? read.code : undefined, 'unknown_item', id);
  }
  const ghost = await readItem(f, BUILD, 'ghost');
  assert.equal(isRefusal(ghost) ? ghost.code : undefined, 'unknown_version');
});

test('a repository that ships a skill and a specialist of one name lists the skill, and the specialist with "name taken by a skill" (#315)', async (t) => {
  const f = await fixture(t);
  await put(f.site, { '.claude/agents/deploy.md': REPO_SPECIALIST });
  const deploys = (await readCatalogue(f)).filter((i) => i.id === DEPLOY);
  assert.deepEqual(
    deploys.map((i) => [i.kind, i.state, i.error?.message]),
    [
      ['skill', 'workspace', undefined],
      ['specialist', 'workspace', 'name taken by a skill'],
    ],
  );
  assert.deepEqual(deploys[1]?.files, ['deploy.md']);
  const read = await readItem(f, DEPLOY, null);
  assert.equal(isRefusal(read) ? read.code : read.item.kind, 'skill', 'the id addresses the skill');
});

const target = (id: string, kind: CatalogueItem['kind']): Pick<CatalogueItem, 'id' | 'origin' | 'kind' | 'name'> => {
  const [origin = '', name = ''] = id.split(':');
  return { id, origin, kind, name };
};

test('usageOf: a skill a stage runs, a caller by /hive:name, by hive:name and by /name, and an item named by nobody; a path or a longer name is no call (#313)', () => {
  const items = [target('hive:new-build', 'skill'), target('hive:new-pr', 'skill'), target('hive:architect', 'specialist'), target('hive-site:deploy', 'skill'), target('hive:lonely', 'skill')];
  const texts = [
    'Open the PR with `/hive:new-pr`, after hive:architect reviews.\n', // new-build calls new-pr and the specialist
    'Deploy the preview first: `/deploy`, never /tmp or deploy.\n', // new-pr calls the repository's skill by its command, in inline code (the references of src/template-refs.ts)
    'Read docs/new-pr.md, never new-build-fast.\n', // neither is a call
    '',
    '',
  ];
  const stages = [{ name: 'build', prompt: '/hive:new-build {url}' }, { name: 'wait' }, { name: 'ship', prompt: 'run /deploy then stop' }];
  assert.deepEqual(usageOf(items, texts, stages), [
    [{ kind: 'stage', stage: 'build' }],
    [{ kind: 'caller', id: 'hive:new-build' }],
    [{ kind: 'caller', id: 'hive:new-build' }],
    [{ kind: 'stage', stage: 'ship' }, { kind: 'caller', id: 'hive:new-pr' }],
    [],
  ]);
});

test('readCatalogue answers each item with its usage, from the stages given and the main texts; without stages none runs anything (#313)', async (t) => {
  const f = await fixture(t);
  await put(f.pluginSource, { 'skills/new-build/SKILL.md': `${SKILL}Dispatch hive:architect.\n` });
  const items = await readCatalogue(f, [{ name: 'build', prompt: '/hive:new-build {url}' }]);
  assert.deepEqual(items.map((i) => [i.id, i.usage]), [
    [ARCHITECT, [{ kind: 'caller', id: BUILD }]],
    [BUILD, [{ kind: 'stage', stage: 'build' }]],
    [DEPLOY, []],
    [HELPER, []],
  ]);
  assert.deepEqual((await readCatalogue(f)).find((i) => i.id === BUILD)?.usage, []);
});
