import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertBlind, blindTells, bundleFiles, hasTell, pluginSubagents, REDACTED, scrub, writeBundle } from '../../src/benchmark/blind.js';
import type { BenchMetrics } from '../../src/types.js';
import { tempDir } from '../temp-dir.js';
import { arm, experiment } from './fixtures.js';

const EXP = experiment({
  arms: [{ ...arm('a1', 'A'), name: 'Control' }, { ...arm('a2', 'B', { stages: { Build: { prompt: '/superpowers:executing-plans {title}' } }, plugins: ['/plugins/superpowers'] }), name: 'Turbo' }],
  blindness: { on: true, forbiddenWords: ['benchmark'] },
});
const TELLS = blindTells(EXP, ['code-reviewer']);
const METRICS: BenchMetrics = {
  tokens: 5, costUsd: 0, ms: 6, waitingMs: 0, restarts: { count: 1, where: ['RUNTOK-1 build'] }, diff: { files: 1, insertions: 1, deletions: 0 }, tests: { green: 1, total: 1 },
  tasks: [{ key: 'RUNTOK-1', title: 'One', tokens: 5, ms: 6, waitingMs: 0, stages: [], restarts: 1 }],
};

test('blindTells names every arm, each stage skill with and without its slash and namespace, every plugin folder, the pinned subagents and the forbidden words; scrub leaves none and never touches a lone letter (#474)', () => {
  const text = 'Ran /hive:new-build, then new-plan; /superpowers:executing-plans and executing-plans; the Turbo setup beat Control; code-reviewer agreed; benchmark. A and B stay.';
  const scrubbed = scrub(text, TELLS);
  assert.equal(hasTell(scrubbed, TELLS), false, scrubbed);
  assert.ok(scrubbed.startsWith(`Ran ${REDACTED}, then ${REDACTED}; ${REDACTED} and ${REDACTED}; the ${REDACTED} setup beat ${REDACTED}`), scrubbed);
  assert.ok(scrubbed.endsWith('A and B stay.'), scrubbed);
  assert.equal(scrub('renew-plans and plan-b', TELLS), 'renew-plans and plan-b', 'a tell inside a longer word is left alone');
});

test('the bundle holds the scrubbed patch, metrics with task-N keys, findings by collector-N, scenarios with every walk\'s notes and the renamed shots; assertBlind passes on it (#474)', async (t) => {
  const dir = await tempDir(t, 'bundle-');
  await writeFile(join(dir, '1-S1-1.png'), 'png');
  const files = bundleFiles({
    patch: '+ /hive:new-build was here\n', metrics: METRICS,
    collectors: [{ name: 'hive:code-reviewer · quality', status: 'warn', summary: '1 findings', findings: [{ file: 'a.ts', finding: 'superpowers left a TODO' }] }],
    scenarios: [{ id: 'S1', title: 'Sign in', text: 't' }], results: [{ id: 'S1', passed: 1, total: 1, screenshots: ['1-S1-1.png'] }],
    walks: [[{ scenario: 'S1', passed: true, notes: 'the Turbo header showed', screenshots: ['1-S1-1.png'] }]], screens: dir,
  }, TELLS);
  assert.deepEqual(files.map((f) => f.name), ['diff.patch', 'metrics.json', 'findings.json', 'scenarios.json', 'screens/S1-1-1.png']);
  assert.doesNotThrow(() => assertBlind(files, TELLS, ['A', 'B']));
  const text = (name: string): string => files.find((f) => f.name === name)?.text ?? '';
  assert.match(text('findings.json'), /"collector": "collector-1"/);
  assert.equal(text('findings.json').includes('code-reviewer'), false);
  assert.match(text('metrics.json'), /"key": "task-1"/);
  assert.equal(text('metrics.json').includes('RUNTOK'), false);
  assert.match(text('scenarios.json'), /"notes": \[\n\s+"the \[redacted\] header showed"/);
  await writeBundle(join(dir, 'bundle'), files);
  assert.deepEqual((await readdir(join(dir, 'bundle'), { recursive: true })).sort(), ['diff.patch', 'findings.json', 'metrics.json', 'scenarios.json', 'screens', join('screens', 'S1-1-1.png')]);
  assert.equal(await readFile(join(dir, 'bundle', 'diff.patch'), 'utf8'), `+ ${REDACTED} was here\n`);
});

test('assertBlind refuses an arm letter in a name or any tell in a name or a text; a letter in a text passes (#474)', () => {
  for (const name of ['screens/b-1-1.png', 'screens/S1-A-1.png', 'code-reviewer.json']) assert.throws(() => assertBlind([{ name, text: '' }], TELLS, ['A', 'B']), /would name the arm/, name);
  assert.throws(() => assertBlind([{ name: 'diff.patch', text: 'uses executing-plans' }], TELLS, ['A', 'B']), /would name the arm: diff\.patch/);
  assert.doesNotThrow(() => assertBlind([{ name: 'diff.patch', text: 'A B' }, { name: 'screens/S1-1-2.png' }], TELLS, ['A', 'B']));
});

test('pluginSubagents names every agent file of the pinned plugin, rendered or not; none without the folder (#474)', async (t) => {
  const dir = await tempDir(t, 'plugin-');
  await mkdir(join(dir, 'agents'));
  for (const file of ['planner.md', 'code-reviewer.md.liquid', 'README.txt']) await writeFile(join(dir, 'agents', file), '');
  assert.deepEqual(await pluginSubagents(dir), ['code-reviewer', 'planner']);
  assert.deepEqual(await pluginSubagents(join(dir, 'none')), []);
});

test('writeBundle writes a fresh folder (#105)', async (t) => {
  const dir = await tempDir(t, 'blind-');
  await writeFile(join(dir, 'shot.png'), 'png');
  await mkdir(join(dir, 'bundle', 'stale'), { recursive: true });
  await writeBundle(join(dir, 'bundle'), [{ name: 'screens/S1-1-1.png', copyFrom: join(dir, 'shot.png') }, { name: 'diff.patch', text: '+x' }]);
  assert.deepEqual((await readdir(join(dir, 'bundle'), { recursive: true })).sort(), ['diff.patch', 'screens', join('screens', 'S1-1-1.png')]);
});
