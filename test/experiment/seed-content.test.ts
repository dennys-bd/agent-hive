import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { loadState } from '../../src/state-store.js';
import { armStages } from '../../scripts/experiment/arm-config.js';
import { runBranch } from '../../scripts/experiment/plan.js';
import { assertWorkerText, deliverySection, forbiddenWords, loadSeed, materializeSample, parseArtboards, parseScenarios, parseStagesSeed, parseTasks, SEED_DIR, screenPath, seedHash } from '../../scripts/experiment/seed.js';
import { assertClean, missingStates } from '../../scripts/experiment/snapshot.js';
import { tempDir } from '../temp-dir.js';
import { rulesOf } from './rules.js';

const read = (name: string): Promise<string> => readFile(join(SEED_DIR, name), 'utf8');

test('the handoff is the designer\'s Portuguese Monitor View README, whole, and it never names the scenarios (#105)', async () => {
  const handoff = await read(join('handoff', 'README.md'));
  assert.match(handoff, /^# Handoff: monitor e saúde/);
  for (const part of ['Monitor Redesign.dc.html', '## Medidas comuns', '00-LEIA-ANTES.md', '`png/`']) assert.ok(handoff.includes(part), part);
  assert.ok(!/scenario|cenário/i.test(handoff), 'the workers read this file');
  assert.deepEqual(handoff.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(0, 4)), ['## M', '## 1', '## 2', '## 3', '## 4', '## 5', '## 6', '## 7', '## 8', '## F']);
});

test('tasks.json has the eight deliveries in order, each with its own section and the blockers of the README graph (1 → 2 → 3 → 4; 5, 6, 7 after 1; 8 free) (#105)', async () => {
  const handoff = await read(join('handoff', 'README.md'));
  const tasks = parseTasks(JSON.parse(await read('tasks.json')), handoff);
  assert.deepEqual(tasks.map((t) => t.delivery), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Object.fromEntries(tasks.map((t) => [t.key, t.blockedBy])), {
    grid: [], pins: ['grid'], actions: ['pins'], organize: ['actions'], sides: ['grid'], commands: ['grid'], files: ['grid'], health: [],
  });
  for (const task of tasks) {
    assert.ok(task.body.endsWith(deliverySection(handoff, task.delivery)), task.key);
    assert.ok(task.body.includes('answers every question'));
    for (const path of ['docs/agent/handoff_monitor/README.md', 'docs/agent/handoff_monitor/Monitor Redesign.dc.html', 'docs/agent/handoff_monitor/png/', 'docs/agent/design-handoff/00-LEIA-ANTES.md']) assert.ok(task.body.includes(path), `${task.key} names ${path}`);
    for (const other of tasks.filter((t) => t !== task)) assert.ok(!task.body.includes(`## ${other.delivery} · `), `${task.key} carries ${other.key}`);
  }
  assert.equal(new Set(tasks.map((t) => t.title)).size, 8);
});

test('artboards.json lists the 12 screens of the README, each with its PNG, and only 4c, 4g and 4h need a live state (#105)', async () => {
  const handoff = await read(join('handoff', 'README.md'));
  const artboards = parseArtboards(JSON.parse(await read('artboards.json')));
  const sections = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ n, text: deliverySection(handoff, n) }));
  assert.deepEqual(artboards.map((a) => a.id).sort(), [...new Set(sections.flatMap((x) => x.text.match(/\b4[a-k]\d?\b/g) ?? []))].sort());
  for (const a of artboards) {
    assert.equal(a.delivery, sections.find((x) => new RegExp(`\\b${a.id}\\b`).test(x.text.split('\n')[0] + x.text))?.n, `${a.id} delivery`);
    assert.equal(a.file, `${a.id}-${a.title}.png`);
  }
  assert.deepEqual(artboards.filter((a) => a.live).map((a) => a.id), ['4c', '4g', '4h']);
});

test('every artboard of artboards.json has its PNG under handoff/png, as the designer made it (#105)', async () => {
  for (const a of parseArtboards(JSON.parse(await read('artboards.json')))) {
    const bytes = await readFile(screenPath(SEED_DIR, a.file));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${a.file} is a PNG`);
  }
});

test('stages.json: Spec and Plan three at a time, Build two, one Merge that folds the run branch in, the same explicit allowlist, no approval (#105)', async () => {
  const seed = parseStagesSeed(JSON.parse(await read('stages.json')));
  assert.deepEqual(seed.stages.map((s) => [s.name, s.role, s.session, s.maxWorkers, s.approval]), [
    ['Spec', 'spec', undefined, 3, undefined], ['Plan', 'plan', 'continue', 3, undefined], ['Build', 'build', 'continue', 2, undefined],
    ['Merge', undefined, 'continue', 1, undefined], ['Done', undefined, undefined, undefined, undefined],
  ]);
  const byName = Object.fromEntries(seed.stages.map((s) => [String(s.name), s]));
  const prompt = (name: string): string => String(byName[name].prompt ?? '');
  assert.equal(byName.Done.prompt, undefined);
  for (const word of ['git merge origin/{runBranch}', '--no-ff', 'pnpm test', 'Execute `pnpm test`', 'git push origin HEAD:{runBranch}', 'hive_done', '"testsGreen"']) assert.ok(prompt('Merge').includes(word), word);
  for (const name of ['Spec', 'Plan', 'Build', 'Merge']) assert.ok(prompt(name).includes('{runBranch}'), name);
  for (const name of ['Spec', 'Plan', 'Build']) assert.ok(prompt(name).includes('Nobody is watching this session.'), name);
  assert.match(prompt('Build'), /do not open a pull request/i);
  const args = seed.claudeArgs;
  // dontAsk: what would need a prompt (a `${var}` Claude Code cannot check, a `git -c`) is refused at once, so no night waits on one
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  const allowed = rulesOf(args, '--allowedTools');
  const denied = rulesOf(args, '--disallowedTools');
  const wanted = ['Read(./**)', 'Edit(./**)', 'Write(./**)', 'Glob', 'Grep', 'Task', 'Skill', 'TodoWrite', 'mcp__hive__*', 'Bash(git merge:*)', 'Bash(git switch:*)', 'Bash(git fetch:*)', 'Bash(git branch:*)',
    'Bash(pnpm test:*)', 'Bash(pnpm install:*)', 'Bash(pnpm build:*)'];
  for (const tool of wanted) assert.ok(allowed.includes(tool), tool);
  for (const tool of ['Read', 'Edit', 'Write', 'Bash(git:*)', 'Bash(pnpm:*)', 'Bash(node:*)', 'Bash(npx:*)', 'Bash(sed:*)', 'Bash(find:*)']) assert.ok(!allowed.includes(tool), `${tool} is not allowed bare`);
  assert.ok(!allowed.some((tool) => tool.startsWith('Bash(git push')), 'the push is the run\'s own, added by runConfig (worker-rules.ts)');
  for (const tool of ['Bash(git push -*)', 'Bash(git push * -*)', 'Bash(git push *main*)', 'Bash(git -* push*)']) assert.ok(denied.includes(tool), `${tool} is denied`);
  assert.ok(!args.some((a) => /dangerously|bypassPermissions/.test(a)), 'no permission bypass');
});

test('scenarios.md holds 8 to 16 scenarios, S1 to Sn, each for one delivery with steps and an expected result, covering all eight (#105)', async () => {
  const scenarios = parseScenarios(await readFile(join(SEED_DIR, 'scenarios.md'), 'utf8'));
  assert.ok(scenarios.length >= 8 && scenarios.length <= 16, String(scenarios.length));
  assert.deepEqual(scenarios.map((s) => s.id), scenarios.map((_, i) => `S${i + 1}`));
  const covered = new Set<number>();
  for (const s of scenarios) {
    const delivery = /^Delivery: ([1-8])$/m.exec(s.text);
    assert.ok(delivery, `${s.id} names its delivery`);
    covered.add(Number(delivery[1]));
    assert.match(s.text, /^Steps:/m, s.id);
    assert.match(s.text, /^Expected:/m, s.id);
    assert.ok(!/data-testid|\.tsx|querySelector|className/.test(s.text), `${s.id} names an implementation`);
  }
  assert.deepEqual([...covered].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// The evaluation boots with no session, so "todas ativas" is always empty: a scenario that needs a Monitor panel pins it first (#105)
test('every scenario that needs a Monitor panel pins activities from the left panel (⌘B) in its own steps, and none takes panels from "todas ativas" (#105)', async () => {
  const scenarios = parseScenarios(await readFile(join(SEED_DIR, 'scenarios.md'), 'utf8'));
  const needsPanel = /(?<!left |right |side )\bpanels?\b|⋯/i;
  for (const s of scenarios) {
    const steps = s.text.slice(s.text.indexOf('Steps:'), s.text.indexOf('Expected:'));
    assert.ok(!/(under|from) "todas ativas"/i.test(s.text), `${s.id} takes panels from "todas ativas"`);
    if (needsPanel.test(s.text)) assert.ok(/⌘B/.test(steps) && /\bpin/i.test(steps) && /"fixadas"/.test(steps), `${s.id} needs a panel and does not pin one first`);
  }
});

// The plan's version of this test goes through loadSeed, which needs the handoff screens and the sample: this reads the same parts directly
test('nothing a worker reads tells it this is an experiment, in either arm (#105)', async () => {
  const handoff = await read(join('handoff', 'README.md'));
  const seed = { handoff, tasks: parseTasks(JSON.parse(await read('tasks.json')), handoff), stages: parseStagesSeed(JSON.parse(await read('stages.json'))) };
  assert.doesNotThrow(() => assertWorkerText(seed));
  for (const arm of ['a', 'b'] as const) {
    const prompts = armStages(seed.stages, arm, runBranch('abc123')).map((s) => String(s.prompt ?? ''));
    for (const prompt of prompts) assert.deepEqual(forbiddenWords(prompt), [], prompt.slice(0, 40));
  }
});

test('the lint config the baseline carries names no experiment path, and leaves docs/ to the ignore file (#105, #79)', async () => {
  const repo = join(SEED_DIR, '..', '..', '..', '..');
  const biome = await readFile(join(repo, 'biome.json'), 'utf8');
  assert.ok(!/experiment|seeds\//i.test(biome), 'biome.json names the harness'); // "test" is ordinary there: its overrides target the test files
  // The handoff, with the designer's support.js, sits in the docs worktree: lint skips it because git ignores docs/
  assert.ok(biome.includes('"useIgnoreFile": true') && !biome.includes('docs/'), biome);
  assert.ok((await readFile(join(repo, '.gitignore'), 'utf8')).split('\n').includes('/docs/'));
});

test('the Merge prompt says origin is a local repository on this machine, so its push and fetch never reach GitHub (#105)', async () => {
  const stages = parseStagesSeed(JSON.parse(await readFile(join(SEED_DIR, 'stages.json'), 'utf8')));
  const merge = String(stages.stages.find((s) => s.name === 'Merge')?.prompt);
  assert.match(merge, /`origin` is a local git repository on this machine/);
  assert.match(merge, /not GitHub/);
  assert.deepEqual(forbiddenWords(merge), []);
});

test('sample-state.json loads at today\'s schema as activities in the seed stages, holds nothing of this machine, and covers what the scenarios need (#105)', async (t) => {
  const text = await read('sample-state.json');
  assertClean(text, { username: userInfo().username, home: homedir() });
  const raw = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(missingStates(raw), []);
  const { state, worktrees } = materializeSample(raw, '/repo/eval');
  const home = await tempDir(t, 'sample-');
  await writeFile(join(home, 'state.json'), JSON.stringify(state));
  const loaded = await loadState(home);
  const stages = parseStagesSeed(JSON.parse(await read('stages.json'))).stages.map((s) => s.name);
  assert.equal(loaded.tasks.length, (raw.tasks as unknown[]).length);
  assert.equal(worktrees.length, loaded.tasks.length, 'every sample task has an activity with a worktree');
  for (const task of loaded.tasks) {
    assert.ok(stages.includes(task.stage), task.item.id);
    assert.deepEqual([task.auto, task.item.url, task.item.body], [false, '', ''], task.item.id);
  }
});

test('loadSeed reads the whole committed seed, screens and sample included, and seedHash names it (#105)', async () => {
  const seed = await loadSeed();
  assert.deepEqual([seed.tasks.length, seed.artboards.length, seed.screens.length], [8, 12, 12]);
  assert.ok(seed.scenarios.length >= 8);
  assert.match(await seedHash(), /^[0-9a-f]{64}$/);
});

test('the Merge prompt sends a merge that did not land to hive_stop, never to hive_done: Done means the delivery is on the run branch (#105)', async () => {
  const stages = parseStagesSeed(JSON.parse(await readFile(join(SEED_DIR, 'stages.json'), 'utf8')));
  const merge = String(stages.stages.find((s) => s.name === 'Merge')?.prompt);
  assert.match(merge, /call hive_stop with no reason/);
  assert.match(merge, /Call hive_done only once the push went through/);
  assert.doesNotMatch(merge, /"merged": (true|false)/);
  assert.deepEqual(forbiddenWords(merge), []);
});
