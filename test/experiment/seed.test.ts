import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slugFor } from '../../src/tasks.js';
import { forbiddenWords, HANDOFF_DIR, deliverySection, handoffFiles, loadSeed, materializeSample, parseArtboards, parseScenarios, parseStagesSeed, parseTasks, seedHash } from '../../scripts/experiment/seed.js';
import { tempDir } from '../temp-dir.js';

const HANDOFF = ['# Handoff: x', '', '## Medidas comuns', '- uma medida', '', '---', '', '## 1 · Primeira (4a)', '**Escopo**', '- Faz a.', '', '## 2 · Segunda', 'Faz b.', '', '---', '', '## Files', '- x', ''].join('\n');
const SECOND = '## 2 · Segunda\nFaz b.';
const PREAMBLE = 'The handoff answers every question.';
const entry = (key: string, delivery: number, blockedBy: string[] = []) => ({ key, title: `Task ${key}`, delivery, blockedBy });
const stage = (name: string, role?: string, prompt?: string) => ({ name, from: {}, ...(role ? { role } : {}), ...(prompt ? { prompt } : {}) });
const STAGES = [stage('Spec', 'spec', '/{command} {title}'), stage('Plan', 'plan', '/{command}'), stage('Build', 'build', '/{command}'), stage('Merge', undefined, 'merge'), stage('Done')];

test('parseTasks takes each body from the preamble and its own section, and refuses a blocker that is not an earlier task (#105)', () => {
  const tasks = parseTasks({ preamble: PREAMBLE, tasks: [entry('one', 1), entry('two', 2, ['one'])] }, HANDOFF);
  assert.deepEqual(tasks.map((t) => [t.key, t.blockedBy]), [['one', []], ['two', ['one']]]);
  assert.equal(tasks[0].body, `${PREAMBLE}\n\n## 1 · Primeira (4a)\n**Escopo**\n- Faz a.`);
  assert.equal(tasks[1].body, `${PREAMBLE}\n\n${SECOND}`);
  const bad: [unknown, string, RegExp][] = [
    [{ preamble: PREAMBLE, tasks: [entry('two', 2, ['one']), entry('one', 1)] }, HANDOFF, /not an earlier task/],
    [{ preamble: PREAMBLE, tasks: [entry('one', 1), entry('one', 2)] }, HANDOFF, /already taken/],
    [{ preamble: PREAMBLE, tasks: [entry('one', 3)] }, HANDOFF, /no section "## 3 ·"/],
    [{ preamble: PREAMBLE, tasks: [{ ...entry('one', 1), delivery: 'Primeira' }] }, HANDOFF, /section number/],
    [{ preamble: PREAMBLE, tasks: [entry('one', 1)] }, '# Handoff: x\n', /no section "## 1 ·"/],
    [{ tasks: [] }, HANDOFF, /preamble/],
  ];
  for (const [raw, handoff, message] of bad) assert.throws(() => parseTasks(raw, handoff), message);
});

test('deliverySection runs from its heading to the next "## " or "---", and to the end of the file for the last one (#105)', () => {
  assert.equal(deliverySection(HANDOFF, 1), '## 1 · Primeira (4a)\n**Escopo**\n- Faz a.');
  assert.equal(deliverySection(HANDOFF, 2), SECOND);
  assert.equal(deliverySection('## 1 · Só\nFim.\n', 1), '## 1 · Só\nFim.');
  assert.throws(() => deliverySection(`${HANDOFF}\n## 2 · Outra\n`, 2), /more than one section/);
});

test('parseStagesSeed needs one stage per role, each calling {command}, and {command} nowhere else (#105)', () => {
  assert.equal(parseStagesSeed({ claudeArgs: [], stages: STAGES }).stages.length, 5);
  const bad: [unknown[], RegExp][] = [
    [[...STAGES.slice(0, 3), stage('Merge', undefined, '/{command}')], /no role/],
    [[stage('Spec', 'spec', 'no command'), ...STAGES.slice(1)], /must call \{command\}/],
    [[stage('Spec', 'review', '/{command}'), ...STAGES.slice(1)], /role" must be one of/],
    [[...STAGES, stage('Again', 'build', '/{command}')], /exactly one stage must have the role build/],
    [STAGES.slice(1), /role spec/],
  ];
  for (const [stages, message] of bad) assert.throws(() => parseStagesSeed({ claudeArgs: [], stages }), message);
  assert.throws(() => parseStagesSeed({ stages: STAGES }), /claudeArgs/);
});

test('parseScenarios reads each "## S<n> · title" with its text up to the next one (#105)', () => {
  const md = '# Scenarios\n\nIntro.\n\n## S1 · Open\nDelivery: 1\nSteps:\n1. Click.\nExpected: shown.\n\n## S2 · Filter\nDelivery: 2\nSteps:\n1. Pick.\nExpected: fewer.\n';
  assert.deepEqual(parseScenarios(md), [
    { id: 'S1', title: 'Open', text: 'Delivery: 1\nSteps:\n1. Click.\nExpected: shown.' },
    { id: 'S2', title: 'Filter', text: 'Delivery: 2\nSteps:\n1. Pick.\nExpected: fewer.' },
  ]);
  assert.throws(() => parseScenarios('# nothing\n'), /no "## S<n>/);
});

test('parseArtboards takes unique 4x ids with a PNG name, a title, a delivery and whether a live agent is needed (#105)', () => {
  const ok = [{ id: '4a', file: '4a-padrao.png', title: 'padrao', delivery: 1, live: false }, { id: '4c2', file: '4c2-executar.png', title: 'chip', delivery: 6, live: false }];
  assert.deepEqual(parseArtboards(ok), ok);
  const bad: [unknown, RegExp][] = [
    [{}, /array/], [[{ ...ok[0], id: '5a' }], /id/], [[ok[0], ok[0]], /twice/], [[{ ...ok[0], title: '' }], /title/],
    [[{ ...ok[0], file: '../x.png' }], /file/], [[{ ...ok[0], delivery: 0 }], /delivery/], [[{ ...ok[0], live: 'no' }], /live/],
  ];
  for (const [raw, message] of bad) assert.throws(() => parseArtboards(raw), message);
});

async function writeSeed(dir: string, pngs: string[]): Promise<void> {
  await mkdir(join(dir, 'handoff', 'png'), { recursive: true });
  await writeFile(join(dir, 'handoff', 'README.md'), HANDOFF);
  await writeFile(join(dir, 'tasks.json'), JSON.stringify({ preamble: PREAMBLE, tasks: [entry('one', 1)] }));
  await writeFile(join(dir, 'stages.json'), JSON.stringify({ claudeArgs: [], stages: STAGES }));
  await writeFile(join(dir, 'scenarios.md'), '## S1 · Open\nDelivery: 1\nSteps:\n1. Open.\nExpected: shown.\n');
  await writeFile(join(dir, 'sample-state.json'), '{"tasks": []}');
  await writeFile(join(dir, 'artboards.json'), JSON.stringify([{ id: '4a', file: '4a-a.png', title: 'a', delivery: 1, live: false }, { id: '4b', file: '4b-b.png', title: 'b', delivery: 6, live: false }]));
  for (const file of pngs) await writeFile(join(dir, 'handoff', 'png', file), 'png');
}

test('loadSeed fails fast naming every handoff screen that is not in the folder, and lists them once there (#105)', async (t) => {
  const dir = await tempDir(t, 'seed-');
  await writeSeed(dir, ['4a-a.png']);
  await assert.rejects(loadSeed(dir), /missing handoff screens: 4b-b\.png \(expected under handoff\/png\/\)/);
  await writeFile(join(dir, 'handoff', 'png', '4b-b.png'), 'png');
  const seed = await loadSeed(dir);
  assert.deepEqual(seed.screens, [join(dir, 'handoff', 'png', '4a-a.png'), join(dir, 'handoff', 'png', '4b-b.png')]);
  assert.deepEqual([seed.tasks.length, seed.scenarios.length, seed.artboards.length], [1, 1, 2]);
  await writeFile(join(dir, 'tasks.json'), JSON.stringify({ preamble: 'This is an experiment.', tasks: [entry('one', 1)] }));
  await assert.rejects(loadSeed(dir), /a worker would read "experiment" in tasks\[0\]/);
});

test('seedHash changes when a seed file changes or is renamed, the handoff HTML included, and ignores a .DS_Store (#105)', async (t) => {
  const dir = await tempDir(t, 'seed-');
  await mkdir(join(dir, 'seed', 'handoff'), { recursive: true });
  await writeFile(join(dir, 'seed', 'tasks.json'), '{}');
  await writeFile(join(dir, 'seed', 'handoff', 'README.md'), '# a');
  await writeFile(join(dir, 'seed', 'handoff', 'Monitor.dc.html'), '<x>');
  const hash = (): Promise<string> => seedHash(join(dir, 'seed'));
  const first = await hash();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await hash(), first);
  await writeFile(join(dir, 'seed', 'handoff', 'README.md'), '# b');
  const second = await hash();
  assert.notEqual(second, first);
  await rename(join(dir, 'seed', 'tasks.json'), join(dir, 'seed', 'tasks2.json'));
  const third = await hash();
  assert.notEqual(third, second);
  await writeFile(join(dir, 'seed', 'handoff', '.DS_Store'), 'junk');
  assert.equal(await hash(), third);
  await writeFile(join(dir, 'seed', 'handoff', 'Monitor.dc.html'), '<y>');
  assert.notEqual(await hash(), third);
});

test('materializeSample gives each activity the slug the Hive would and turns {worktree} into a folder under the eval checkout (#105)', () => {
  const raw = {
    tasks: [
      { item: { itemId: 'local:1', id: 'MON-1', title: 'Board view', body: '', url: '' }, stage: 'Build' },
      { item: { itemId: 'local:2', id: 'MON-2', title: 'No worktree', body: '', url: '' }, stage: 'Spec' },
    ],
    activities: [{ id: 'act-1', kind: 'task', workspace: 'agent-hive', worktree: '{worktree}' }, { id: 'act-2', kind: 'task', workspace: 'agent-hive' }],
    activityRecords: [{ id: 'act-1', taskIds: ['local:1'], sessions: [] }, { id: 'act-2', taskIds: ['local:2'], sessions: [] }],
  };
  const { state, worktrees } = materializeSample(raw, '/repo/eval');
  const activities = state.activities as { slug: string; worktree?: string }[];
  assert.deepEqual(activities.map((a) => a.slug), [slugFor(raw.tasks[0].item), slugFor(raw.tasks[1].item)]);
  assert.deepEqual(worktrees, [join('/repo/eval', '.hive', 'worktrees', activities[0].slug)]);
  assert.equal(activities[1].worktree, undefined);
  assert.equal(raw.activities[0].worktree, '{worktree}', 'the seed object is left as it was');
});

test('forbiddenWords finds what would tell a worker it is an experiment, past pnpm test, hive test and run-commands.ts (#105)', () => {
  assert.deepEqual(forbiddenWords('Run `pnpm test`, then reaproveita run-commands.ts. Nobody is watching this session.'), ['run']);
  assert.deepEqual(forbiddenWords('This Experiment has two arms; benchmark the tests. {runBranch} testsGreen'), ['experiment', 'arms', 'benchmark', 'tests']);
  assert.deepEqual(forbiddenWords('vitest · de hive test'), []);
  assert.deepEqual(forbiddenWords('Execute `pnpm test` and call hive_done {"testsGreen": true}.'), []);
});

test('handoffFiles lists the whole handoff folder as laid out under the docs baseline at agent/handoff_monitor/, and skips a .DS_Store (#105, #79)', async (t) => {
  const dir = await tempDir(t, 'seed-');
  const handoff = join(dir, 'handoff');
  await mkdir(join(handoff, 'png'), { recursive: true });
  for (const name of ['README.md', 'Monitor Redesign.dc.html', 'support.js', '.DS_Store', join('png', '4a-padrao.png')]) await writeFile(join(handoff, name), 'x');
  assert.deepEqual(await handoffFiles(dir), [
    { from: join(handoff, 'Monitor Redesign.dc.html'), to: `${HANDOFF_DIR}/Monitor Redesign.dc.html` },
    { from: join(handoff, 'README.md'), to: `${HANDOFF_DIR}/README.md` },
    { from: join(handoff, 'png', '4a-padrao.png'), to: `${HANDOFF_DIR}/png/4a-padrao.png` },
    { from: join(handoff, 'support.js'), to: `${HANDOFF_DIR}/support.js` },
  ]);
});
