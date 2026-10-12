import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, parseConfig } from '../src/config.js';
import { migrateConfig, migrateRetiredKeys, migrateTransitions, migrateDefaultAgent, migrateFileIcons, migrateOnClose, migrateStageActions, migrateWorkspaces, migrateCreateIn, transitionsOf } from '../src/config-migrate.js';
import { combConfig, FILTER, LOCAL_STAGES } from './fakes.js';
import { tempDir } from './temp-dir.js';

const DEV = { name: 'dev', command: 'pnpm dev', env: { PORT: '3000' } };
const TEST = { name: 'test', command: 'pnpm test', env: {} };
const LINT = { name: 'lint', command: 'pnpm lint', env: {} };

// #755: no migration past #511's: what migrateWorkspaces writes is refused naming the keys that replaced command and workspaces
const GONE = 'hive.config.json: "comb.commands[0].command" is gone: a command holds "impls" (one { "workspace", "command" } per workspace, null for the other workspaces) and "menu"';

// A hive.config.json from before #511: each workspace carries its own commands and its setup timeout in minutes.
const legacy = (workspaces: unknown[]): Record<string, unknown> => {
  const raw = combConfig({ workspaces, stages: LOCAL_STAGES }); // no source: the stages name none
  return { ...raw, comb: { ...(raw.comb as Record<string, unknown>), commands: undefined } };
};
const combOf = (raw: unknown): Record<string, unknown> => (raw as { comb: Record<string, unknown> }).comb;

test('a pre-#511 file moves each workspace\'s commands into comb.commands and turns setupTimeoutMinutes into setupTimeout (#511)', () => {
  const raw = legacy([
    { name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', setup: 'RUN a', setupTimeoutMinutes: 7, commands: [DEV, TEST] },
    { name: 'web', path: '/web', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', setup: 'RUN b', commands: [{ ...DEV }, LINT] },
  ]);
  const migrated = migrateWorkspaces(raw);
  assert.deepEqual(combOf(migrated).workspaces, [
    { name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', setup: 'RUN a', setupTimeout: '7m' },
    { name: 'web', path: '/web', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', setup: 'RUN b', setupTimeout: '5m' },
  ], 'minutes kept; an absent key with a setup meant the old 5 min');
  assert.deepEqual(combOf(migrated).commands, [
    { ...DEV, workspaces: ['hive', 'web'] }, { ...TEST, workspaces: ['hive'] }, { ...LINT, workspaces: ['web'] },
  ]);
  assert.throws(() => parseConfig(migrated), { message: GONE });
  assert.ok(Array.isArray(combOf(raw).workspaces) && 'commands' in (combOf(raw).workspaces as object[])[0], 'the input is not mutated');
});

test('a same-named but different command in a later workspace is renamed <name> (<workspace>) (#511)', () => {
  const migrated = migrateWorkspaces(legacy([
    { name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', commands: [DEV] },
    { name: 'web', path: '/web', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', commands: [{ ...DEV, command: 'vite' }] },
  ]));
  assert.deepEqual(combOf(migrated).commands, [{ ...DEV, workspaces: ['hive'] }, { ...DEV, name: 'dev (web)', command: 'vite', workspaces: ['web'] }]);
  assert.throws(() => parseConfig(migrated), { message: GONE });
});

test('a workspace with no setup gets no setupTimeout; a non-number setupTimeoutMinutes is carried for the parser to refuse (#511)', () => {
  const migrated = migrateWorkspaces(legacy([{ name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', commands: [] }]));
  assert.deepEqual(combOf(migrated).workspaces, [{ name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }]);
  assert.deepEqual(combOf(migrated).commands, []);
  const odd = migrateWorkspaces(legacy([{ name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', setup: 'RUN a', setupTimeoutMinutes: 'x', commands: [] }]));
  assert.throws(() => parseConfig(odd), { message: 'hive.config.json: "comb.workspaces[0].setupTimeout" must be a timeout like "30s", "10m" or "1h", up to 24h' });
});

test('migrateWorkspaces is idempotent, and a current-shape file comes back as the same reference (#511)', () => {
  const raw = legacy([{ name: 'hive', path: '/repo', env: {}, setup: 'RUN a', commands: [DEV] }]);
  assert.deepEqual(migrateWorkspaces(migrateWorkspaces(raw)), migrateWorkspaces(raw));
  const current = combConfig();
  assert.equal(migrateWorkspaces(current), current);
});

test('non-object input and a file without comb.workspaces come back untouched (#511)', () => {
  for (const raw of [null, 7, 'x', [], {}, { comb: {} }, { comb: { workspaces: 'no' } }]) assert.equal(migrateWorkspaces(raw), raw, JSON.stringify(raw));
});

test('readConfig applies the migration in memory: loadConfig meets comb.commands, now refused (#755), and the file on disk is unchanged (#511)', async (t) => {
  const home = await tempDir(t, 'home-');
  const text = JSON.stringify(legacy([{ name: 'hive', path: '/repo', env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', commands: [DEV] }]));
  await writeFile(join(home, 'hive.config.json'), text);
  await assert.rejects(loadConfig(home), { message: GONE }, 'comb.commands[0] exists only once migrated');
  assert.equal(await readFile(join(home, 'hive.config.json'), 'utf8'), text);
});

test('migrateOnClose turns the two #198 switches into onClose: only menu bar off + stop on close is quit; the old keys go (#513)', () => {
  const base = { comb: {} };
  assert.deepEqual(migrateOnClose({ ...base, menuBar: true, stopOnClose: false }), { ...base, onClose: 'menuBar' });
  assert.deepEqual(migrateOnClose({ ...base, menuBar: true, stopOnClose: true }), { ...base, onClose: 'menuBar' });
  assert.deepEqual(migrateOnClose({ ...base, menuBar: false, stopOnClose: true }), { ...base, onClose: 'quit' });
  assert.deepEqual(migrateOnClose({ ...base, menuBar: false, stopOnClose: false }), { ...base, onClose: 'menuBar' }, 'workers kept running: the tray comes back');
  assert.deepEqual(migrateOnClose({ ...base, menuBar: 'yes' }), { ...base, onClose: 'menuBar' }, 'garbage is the non-destructive choice');
  assert.deepEqual(migrateOnClose({ ...base, onClose: 'quit', menuBar: true }), { ...base, onClose: 'quit' }, 'a present onClose wins');
  const today = { ...base, onClose: 'quit' };
  assert.equal(migrateOnClose(today), today, 'nothing to do: same reference');
  const neither = { ...base };
  assert.equal(migrateOnClose(neither), neither, 'no key at all: the parser names onClose');
  assert.equal(migrateOnClose(null), null);
});

test('migrateConfig runs both migrations (#511, #513)', () => {
  const migrated = migrateConfig({ comb: { workspaces: [{ name: 'a', path: '/a', commands: [] }] }, menuBar: false, stopOnClose: true }) as Record<string, unknown>;
  assert.equal(migrated.onClose, 'quit');
  assert.equal('commands' in ((migrated.comb as { workspaces: Record<string, unknown>[] }).workspaces[0]), false);
});

// A pre-#515 stage: one action per source, on start and on finish, over two sources.
const OLD_STAGE = {
  name: 'dev', from: { work: ['Ready'], notes: ['todo'] }, prompt: 'x', model: 'opus',
  onStart: { work: { type: 'move', column: 'In progress' } },
  onFinish: { work: { type: 'close' }, notes: { type: 'move', column: 'review' } },
};
const oldFile = (stages: unknown[]): Record<string, unknown> => combConfig({ stages });

test('migrateStageActions wraps each single onStart / onFinish action in a one-element list, and keeps everything else (#515)', () => {
  const raw = oldFile([OLD_STAGE, { name: 'gate', from: {}, prompt: '' }]);
  const migrated = migrateStageActions(raw) as Record<string, unknown>;
  const [dev, gate] = combOf(migrated).stages as Record<string, unknown>[];
  assert.deepEqual(dev, {
    ...OLD_STAGE,
    onStart: { work: [{ type: 'move', column: 'In progress' }] },
    onFinish: { work: [{ type: 'close' }], notes: [{ type: 'move', column: 'review' }] },
  });
  assert.deepEqual(gate, { name: 'gate', from: {}, prompt: '' });
  assert.deepEqual({ ...migrated, comb: { ...combOf(migrated), stages: [] } }, { ...raw, comb: { ...combOf(raw), stages: [] } }, 'the rest of the file is kept');
  assert.deepEqual((combOf(raw).stages as Record<string, unknown>[])[0], OLD_STAGE, 'the input is not mutated');
});

test('migrateStageActions is idempotent; a list-shape file or one without stages comes back as the same reference (#515)', () => {
  const raw = oldFile([OLD_STAGE]);
  const once = migrateStageActions(raw);
  assert.deepEqual(migrateStageActions(once), once);
  assert.equal(migrateStageActions(once), once);
  const current = combConfig();
  assert.equal(migrateStageActions(current), current);
  for (const odd of [null, 7, 'x', [], {}, { comb: {} }, { comb: { stages: 'no' } }]) assert.equal(migrateStageActions(odd), odd, JSON.stringify(odd));
});

test('malformed stage actions pass through for the parser to name them (#515)', () => {
  const odd = [
    { name: 'a', from: { work: ['Ready'] }, onFinish: { work: 'Done' } },
    { name: 'b', from: { work: ['Ready'] }, onStart: null },
    'not a stage',
  ];
  const raw = oldFile(odd);
  assert.equal(migrateStageActions(raw), raw);
  const mixed = oldFile([OLD_STAGE, ...odd]);
  assert.deepEqual((combOf(migrateStageActions(mixed)).stages as unknown[]).slice(1), odd);
  const pre286 = combConfig({ source: { type: 'github', owner: 'acme', number: 6, filter: FILTER }, stages: [{ name: 'a', from: { board: ['Ready'] }, onFinish: { board: 'Done' } }] });
  assert.throws(() => parseConfig(migrateConfig(pre286)), /"comb\.transitions\[0\]\.sources\.board" must be a non-empty array of actions/); // #134: onFinish is the transition's sources now
});

test('migrateConfig chains the stage actions after the others (#511, #513, #515)', () => {
  const migrated = migrateConfig({ ...oldFile([OLD_STAGE]), onClose: undefined, menuBar: false, stopOnClose: true }) as Record<string, unknown>;
  assert.equal(migrated.onClose, 'quit');
  assert.deepEqual(((combOf(migrated).stages as Record<string, unknown>[])[0]).onStart, { work: [{ type: 'move', column: 'In progress' }] });
  const board = { type: 'github', owner: 'acme', number: 6, filter: FILTER };
  const file = combConfig({ source: board, stages: [{ name: 'dev', from: { board: ['Ready'] }, prompt: 'x', onStart: { board: { type: 'move', column: 'In progress' } }, onFinish: { board: { type: 'close' } } }] });
  // the fixture's own derived flow is dropped: the migration derives it after the single actions became lists
  const old = { ...file, comb: { ...(file.comb as Record<string, unknown>), transitions: undefined } };
  const { comb } = parseConfig(migrateConfig(old));
  assert.deepEqual(comb.stages[0], { name: 'dev', from: { board: ['Ready'] }, prompt: 'x', onStart: { board: [{ type: 'move', column: 'In progress' }] } });
  assert.deepEqual(comb.transitions[0].sources, { board: [{ type: 'close' }] }, '#134: the listed onFinish became the transition\'s sources');
});

test('migrateDefaultAgent gives a pre-#516 file defaultAgent: claude and nothing else; stages keep no agent (#516)', () => {
  const { defaultAgent: _gone, ...raw } = oldFile([{ name: 'dev', from: {}, prompt: 'x' }]);
  const migrated = migrateDefaultAgent(raw) as Record<string, unknown>;
  assert.deepEqual(migrated, { ...raw, defaultAgent: 'claude' });
  assert.equal('defaultAgent' in raw, false, 'the input is not mutated');
  assert.equal('agent' in (combOf(migrated).stages as Record<string, unknown>[])[0], false);
});

test('migrateDefaultAgent returns the same reference when defaultAgent is present, and passes a non-object through (#516)', () => {
  const file = oldFile([]);
  assert.equal(migrateDefaultAgent(file), file);
  const bad = { ...file, defaultAgent: 'codex' };
  assert.equal(migrateDefaultAgent(bad), bad, 'a wrong value is the parser\'s to name');
  assert.equal(migrateDefaultAgent(null), null);
  const list: unknown[] = [];
  assert.equal(migrateDefaultAgent(list), list);
});

test('migrateConfig chains the default agent last: a pre-#513, pre-#515, pre-#516 file parses with defaultAgent claude (#516)', () => {
  const full: Record<string, unknown> = { ...oldFile([OLD_STAGE]), onClose: undefined, menuBar: false, stopOnClose: true };
  const { defaultAgent: _gone, ...raw } = full;
  const migrated = migrateConfig(raw) as Record<string, unknown>;
  assert.deepEqual([migrated.onClose, migrated.defaultAgent], ['quit', 'claude']);
  assert.equal(migrateConfig(migrated), migrated, 'idempotent: a migrated file comes back as the same reference');
});

test('migrateFileIcons gives a pre-#754 file the form defaults; a present key, a wrong one included, comes back as the same reference (#754)', () => {
  const { fileIcons: _gone, ...raw } = oldFile([]);
  assert.deepEqual(migrateFileIcons(raw), { ...raw, fileIcons: { set: 'material', scope: 'all', muted: true } });
  assert.equal('fileIcons' in raw, false, 'the input is not mutated');
  const file = oldFile([]);
  assert.equal(migrateFileIcons(file), file);
  const bad = { ...file, fileIcons: { set: 'seti' } };
  assert.equal(migrateFileIcons(bad), bad, "a wrong value is the parser's to name");
  assert.equal(migrateFileIcons(null), null);
  const list: unknown[] = [];
  assert.equal(migrateFileIcons(list), list);
});

test('migrateConfig fills fileIcons last: a pre-#516, pre-#754 file parses with both defaults, and a migrated file comes back as the same reference (#754)', () => {
  const { defaultAgent: _agent, fileIcons: _icons, ...raw } = combConfig({ stages: LOCAL_STAGES });
  const migrated = migrateConfig(raw);
  const parsed = parseConfig(migrated);
  assert.deepEqual([parsed.defaultAgent, parsed.fileIcons], ['claude', { set: 'material', scope: 'all', muted: true }]);
  assert.equal(migrateConfig(migrated), migrated, 'idempotent');
});

test('a comb with no transitions gets them from its stages: approved after an approval stage, passed after commands or CI, done otherwise, the last to end, each with its onFinish as sources; feedback loops on prompt stages with approval, a gate\'s to the nearest earlier prompt stage; idempotent (#134)', () => {
  const stages = [
    { name: 'Spec', from: {}, prompt: '/spec', approval: true, onFinish: { board: [{ type: 'move', column: 'Ready' }] } },
    { name: 'Build', from: {}, prompt: '/build', visible: 3 },
    { name: 'Checks', from: {}, action: 'commands', commands: ['lint'] },
    { name: 'CI', from: {}, action: 'waitForCi', ciChecks: 'all', rerunOnce: false },
    { name: 'PR', from: {}, approval: true, onFinish: { board: [{ type: 'close' }] } },
  ];
  const migrated = migrateTransitions({ comb: { stages } }) as { comb: { transitions: unknown[] } };
  assert.deepEqual(migrated.comb.transitions, [
    { from: 'Spec', to: 'Build', when: 'approved', sources: { board: [{ type: 'move', column: 'Ready' }] } },
    { from: 'Build', to: 'Checks', when: 'done' },
    { from: 'Checks', to: 'CI', when: 'verdict', verdict: 'passed' },
    { from: 'CI', to: 'PR', when: 'verdict', verdict: 'passed' },
    { from: 'PR', to: 'end', when: 'approved', sources: { board: [{ type: 'close' }] } },
    { from: 'Spec', to: 'Spec', when: 'feedback', session: 'previous' },
    { from: 'PR', to: 'Build', when: 'feedback', session: { continueOf: 'Build' } },
  ]);
  assert.deepEqual((migrated as unknown as { comb: { stages: Record<string, unknown>[] } }).comb.stages.map((s) => 'onFinish' in s), [false, false, false, false, false], 'onFinish moved to the transitions (#134)');
  assert.deepEqual((migrated as unknown as { comb: { stages: Record<string, unknown>[] } }).comb.stages.map((s) => 'visible' in s), [false, false, false, false, false], 'visible left the stage (#134)');
  assert.equal(migrateTransitions(migrated), migrated, 'a comb with transitions comes back as it is');
  assert.deepEqual(transitionsOf([{ name: 'Gate', from: {}, approval: true }, { name: 'Build', from: {}, prompt: '/b' }]), [
    { from: 'Gate', to: 'Build', when: 'approved' }, { from: 'Build', to: 'end', when: 'done' },
  ], 'a gate with no earlier prompt stage gets no feedback transition');
  const malformed = { comb: { stages: [1] } };
  assert.equal(migrateTransitions(malformed), malformed, 'the parser names a malformed stage');
});

test('migrateRetiredKeys also drops maxConcurrent, which lives in the state now (#727)', () => {
  assert.deepEqual(migrateRetiredKeys({ maxConcurrent: 2, theme: 'dark' }), { theme: 'dark' });
  assert.deepEqual(migrateRetiredKeys({ maxConcurrent: 2, shortcuts: { toggleAuto: null } }), { shortcuts: {} });
});

test('migrateRetiredKeys drops a leftover shortcuts.toggleAuto, whose operation is gone, and keeps the other keys; a file without it is the same reference (#727)', () => {
  const raw = { shortcuts: { toggleAuto: 'CmdOrCtrl+Shift+A', viewFlow: null }, theme: 'dark' };
  assert.deepEqual(migrateRetiredKeys(raw), { shortcuts: { viewFlow: null }, theme: 'dark' });
  const clean = { shortcuts: {}, theme: 'dark' };
  assert.equal(migrateRetiredKeys(clean), clean);
});

test('a pre-#846 Comb gains hiveSource true and createIn hive, today\'s behaviour; present keys are kept, wrong ones for the parser (#846)', () => {
  const raw = combConfig({ stages: LOCAL_STAGES });
  const { hiveSource: _h, createIn: _c, ...comb } = combOf(raw);
  const old = { ...raw, comb };
  assert.deepEqual(combOf(migrateCreateIn(old)), { hiveSource: true, createIn: 'hive', ...comb });
  assert.equal(migrateCreateIn(raw), raw, 'both present: the same reference');
  assert.equal(combOf(migrateCreateIn({ ...raw, comb: { ...comb, hiveSource: 'no' } })).hiveSource, 'no');
  for (const odd of [null, 7, 'x', {}, { comb: 'x' }]) assert.equal(migrateCreateIn(odd), odd, JSON.stringify(odd));
  assert.equal(parseConfig(migrateConfig(old)).comb.createIn, 'hive', 'readConfig\'s chain runs it');
});
