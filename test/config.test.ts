import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyColumns, legacyConfig, loadConfig, loadConfigIfPresent, loadConfigOrLegacy, parseConfig } from '../src/config.js';
import { COLUMNS } from './fakes.js';

const GITHUB = { board: { type: 'github', owner: '@me', number: 6 }, columns: COLUMNS };

test('parseConfig applies defaults on top of a minimal config', () => {
  const config = parseConfig({ ...GITHUB });
  assert.equal(config.maxConcurrent, 2);
  assert.equal(config.port, 47821);
  assert.deepEqual(config.claudeArgs, []);
  assert.deepEqual(config.budget, {});
  assert.deepEqual(config.usageRules, []);
  assert.equal(config.workers, 'embedded');
  assert.equal(config.epics, 'ignore');
  assert.equal(config.logLevel, 'info');
});

test('parseConfig accepts workers embedded or iterm and rejects anything else', () => {
  assert.equal(parseConfig({ ...GITHUB, workers: 'iterm' }).workers, 'iterm');
  assert.throws(() => parseConfig({ ...GITHUB, workers: 'tmux' }), /"workers" must be one of: embedded, iterm/);
});

test('parseConfig accepts epics ignore or queue and rejects anything else', () => {
  assert.equal(parseConfig({ ...GITHUB, epics: 'queue' }).epics, 'queue');
  assert.equal(parseConfig({ ...GITHUB, epics: 'ignore' }).epics, 'ignore');
  assert.throws(() => parseConfig({ ...GITHUB, epics: 'label' }), /"epics" must be one of: ignore, queue/);
});

test('parseConfig accepts logLevel info or debug and rejects anything else', () => {
  assert.equal(parseConfig({ ...GITHUB, logLevel: 'debug' }).logLevel, 'debug');
  assert.equal(parseConfig({ ...GITHUB, logLevel: 'info' }).logLevel, 'info');
  assert.throws(() => parseConfig({ ...GITHUB, logLevel: 'trace' }), /"logLevel" must be one of: info, debug/);
  assert.throws(() => parseConfig({ ...GITHUB, logLevel: true }), /"logLevel" must be one of: info, debug/);
});

test('parseConfig accepts language pt or en, leaves the key absent when unset and rejects anything else', () => {
  assert.equal(parseConfig({ ...GITHUB, language: 'en' }).language, 'en');
  assert.equal(parseConfig({ ...GITHUB, language: 'pt' }).language, 'pt');
  assert.equal('language' in parseConfig({ ...GITHUB }), false, 'absent stays absent so writeConfigFile keeps the file clean');
  assert.throws(() => parseConfig({ ...GITHUB, language: 'fr' }), /"language" must be one of: pt, en/);
  assert.throws(() => parseConfig({ ...GITHUB, language: 'pt-BR' }), /"language" must be one of: pt, en/);
  assert.throws(() => parseConfig({ ...GITHUB, language: true }), /"language" must be one of: pt, en/);
});

test('parseConfig keeps explicit values', () => {
  const config = parseConfig({
    board: { type: 'github', owner: 'acme', number: 3 },
    columns: COLUMNS,
    maxConcurrent: 4, port: 5000, claudeArgs: ['--model', 'sonnet'],
  });
  assert.equal(config.maxConcurrent, 4);
  assert.deepEqual(config.claudeArgs, ['--model', 'sonnet']);
});

test('parseConfig accepts a github or a markdown board', () => {
  assert.deepEqual(parseConfig({ board: { type: 'github', owner: 'acme', number: 6 }, columns: COLUMNS }).board, { type: 'github', owner: 'acme', number: 6 });
  assert.deepEqual(parseConfig({ board: { type: 'markdown', path: 'docs/board.md' }, columns: COLUMNS }).board, { type: 'markdown', path: 'docs/board.md' });
});

test('parseConfig reads the legacy project field as a github board', () => {
  assert.deepEqual(parseConfig({ project: { owner: '@me', number: 9 }, columns: COLUMNS }).board, { type: 'github', owner: '@me', number: 9 });
  // an explicit board wins over a leftover project
  const both = parseConfig({ project: { owner: '@me', number: 9 }, board: { type: 'markdown', path: 'b.md' }, columns: COLUMNS });
  assert.equal(both.board.type, 'markdown');
});

test('parseConfig rejects missing or wrong-typed fields with the field name', () => {
  assert.throws(() => parseConfig({ columns: COLUMNS }), /"board"/);
  assert.throws(() => parseConfig({ board: { type: 'github', owner: '@me' }, columns: COLUMNS }), /board\.number/);
  assert.throws(() => parseConfig({ board: { type: 'github', number: 1 }, columns: COLUMNS }), /board\.owner/);
  assert.throws(() => parseConfig({ board: { type: 'markdown' }, columns: COLUMNS }), /board\.path/);
  assert.throws(() => parseConfig({ board: { type: 'asana', id: 1 }, columns: COLUMNS }), /board\.type.*github, markdown/);
  assert.throws(() => parseConfig({ project: { owner: '@me' }, columns: COLUMNS }), /project\.number/);
  assert.throws(() => parseConfig({ ...GITHUB, maxConcurrent: '3' }), /maxConcurrent/);
  assert.throws(() => parseConfig({ ...GITHUB, claudeArgs: 'x' }), /claudeArgs/);
});

test('loadConfig reads hive.config.json from the repo, including a legacy project file, and reports a missing file clearly', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  await assert.rejects(loadConfig(repo), /hive\.config\.json/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ project: { owner: '@me', number: 9 }, columns: COLUMNS }));
  assert.deepEqual((await loadConfig(repo)).board, { type: 'github', owner: '@me', number: 9 });
});

test('loadConfigIfPresent returns undefined only when the file is missing', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  assert.equal(await loadConfigIfPresent(repo), undefined);
  await writeFile(join(repo, 'hive.config.json'), '{not json');
  await assert.rejects(loadConfigIfPresent(repo), /JSON inválido/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ board: { type: 'markdown', path: 'board.md' }, columns: COLUMNS }));
  assert.deepEqual((await loadConfigIfPresent(repo))?.board, { type: 'markdown', path: 'board.md' });
});

test('parseConfig reads budget, leaves absent limits absent and defaults to {}', () => {
  assert.deepEqual(parseConfig({ ...GITHUB }).budget, {});
  assert.deepEqual(parseConfig({ ...GITHUB, budget: {} }).budget, {});
  assert.deepEqual(parseConfig({ ...GITHUB, budget: { maxTokensPerHour: 50_000 } }).budget, { maxTokensPerHour: 50_000 });
  assert.deepEqual(
    parseConfig({ ...GITHUB, budget: { maxTokensPerHour: 0, maxTokensPerDay: 1_000_000 } }).budget,
    { maxTokensPerHour: 0, maxTokensPerDay: 1_000_000 },
  );
});

test('parseConfig rejects a budget that is not an object or has a non-integer limit, naming the field', () => {
  assert.throws(() => parseConfig({ ...GITHUB, budget: 5 }), { message: 'hive.config.json: "budget" must be an object' });
  assert.throws(() => parseConfig({ ...GITHUB, budget: [] }), /"budget" must be an object/);
  assert.throws(() => parseConfig({ ...GITHUB, budget: null }), /"budget" must be an object/);
  assert.throws(
    () => parseConfig({ ...GITHUB, budget: { maxTokensPerHour: 1.5 } }),
    { message: 'hive.config.json: "budget.maxTokensPerHour" must be a non-negative integer' },
  );
  assert.throws(() => parseConfig({ ...GITHUB, budget: { maxTokensPerDay: -1 } }), /budget\.maxTokensPerDay/);
  assert.throws(() => parseConfig({ ...GITHUB, budget: { maxTokensPerDay: '10' } }), /budget\.maxTokensPerDay/);
});

test('parseConfig reads usageRules as written', () => {
  const usageRules = [{ percent: 50, maxWorkers: 4 }, { percent: 80, signal: 'yellow' }, { percent: 90, maxWorkers: 0, signal: 'red' }];
  assert.deepEqual(parseConfig({ ...GITHUB, usageRules }).usageRules, usageRules);
  assert.deepEqual(parseConfig({ ...GITHUB, usageRules: [] }).usageRules, []);
});

test('parseConfig rejects bad usage rules naming the field', () => {
  const rules = (usageRules: unknown) => () => parseConfig({ ...GITHUB, usageRules });
  assert.throws(rules('x'), /"usageRules" must be an array/);
  assert.throws(rules([5]), /"usageRules\[0\]" must be an object/);
  assert.throws(rules([{ percent: 101, signal: 'red' }]), /"usageRules\[0\]\.percent" must be an integer from 0 to 100/);
  assert.throws(rules([{ percent: -1, signal: 'red' }]), /usageRules\[0\]\.percent/);
  assert.throws(rules([{ percent: 1.5, signal: 'red' }]), /usageRules\[0\]\.percent/);
  assert.throws(rules([{ signal: 'red' }]), /usageRules\[0\]\.percent/);
  assert.throws(rules([{ percent: 50, signal: 'blue' }]), /"usageRules\[0\]\.signal" must be one of: green, yellow, red/);
  assert.throws(rules([{ percent: 50, maxWorkers: -1 }]), /usageRules\[0\]\.maxWorkers/);
  assert.throws(rules([{ percent: 50, signal: 'red' }, { percent: 60 }]), /"usageRules\[1\]" must set "maxWorkers" or "signal"/);
});

test('parseConfig reads columns as written, keeps absent optional keys absent and rejects the bad ones naming the index', () => {
  const columns = [
    { name: 'spec', weight: 5, from: ['Backlog'], onFinish: 'Ready', prompt: '/hive-spec {url}', session: 'new', model: 'opus' },
    { name: 'dev', weight: 1, from: ['Ready'], onStart: 'In progress', onFinish: 'In review', prompt: '/hive-build {url}', session: 'continue' },
    { name: 'review', weight: 0, from: ['In review'] },
  ];
  assert.deepEqual(parseConfig({ ...GITHUB, columns }).columns, columns);
  assert.equal('session' in parseConfig({ ...GITHUB, columns }).columns[2], false, 'absent stays absent: new is the default at use');
  const bad = (columns: unknown) => () => parseConfig({ ...GITHUB, columns });
  assert.throws(bad(undefined), { message: 'hive.config.json: "columns" is required' });
  assert.throws(bad([]), { message: 'hive.config.json: "columns" must be a non-empty array' });
  assert.throws(bad('x'), /"columns" must be a non-empty array/);
  assert.throws(bad([5]), /"columns\[0\]" must be an object/);
  assert.throws(bad([{ weight: 1, from: [] }]), /"columns\[0\]\.name" must be a non-empty string/);
  assert.throws(bad([{ name: 'a', from: ['x'] }]), /"columns\[0\]\.weight" must be a non-negative integer/);
  assert.throws(bad([{ name: 'a', weight: -1, from: ['x'] }]), /columns\[0\]\.weight/);
  assert.throws(bad([{ name: 'a', weight: 1 }]), /"columns\[0\]\.from" must be an array of strings/);
  assert.throws(bad([{ name: 'a', weight: 1, from: [1] }]), /columns\[0\]\.from/);
  assert.throws(bad([{ name: 'a', weight: 1, from: ['x'], session: 'resume' }]), /"columns\[0\]\.session" must be one of: new, continue/);
  assert.throws(bad([{ name: 'a', weight: 1, from: ['x'], prompt: 7 }]), /columns\[0\]\.prompt/);
  assert.throws(bad([{ name: 'a', weight: 1, from: ['x'], onStart: '' }]), /columns\[0\]\.onStart/);
  assert.throws(bad([{ name: 'a', weight: 1, from: ['x'] }, { name: 'a', weight: 1, from: [] }]), { message: 'hive.config.json: "columns[1].name" must be unique' });
  assert.throws(bad([{ name: 'a', weight: 1, from: [] }]), { message: 'hive.config.json: "columns" must have at least one column with "from"' });
});

test('parseConfig reads columns[].visible as a non-negative integer, leaves it absent when unset and rejects the rest naming the index', () => {
  const column = (visible?: unknown) => ({ name: 'a', weight: 1, from: ['x'], ...(visible === undefined ? {} : { visible }) });
  assert.equal('visible' in parseConfig({ ...GITHUB, columns: [column()] }).columns[0], false, 'absent stays absent: no limit, and the file stays clean');
  assert.equal(parseConfig({ ...GITHUB, columns: [column(0)] }).columns[0].visible, 0, '0 is kept as written: no limit either');
  assert.equal(parseConfig({ ...GITHUB, columns: [column(3)] }).columns[0].visible, 3);
  for (const bad of [-1, 1.5, '5', null]) {
    assert.throws(() => parseConfig({ ...GITHUB, columns: [column(bad)] }), { message: 'hive.config.json: "columns[0].visible" must be a non-negative integer' }, JSON.stringify(bad));
  }
});

test('legacyColumns turns status and promptTemplate into the one-column pipeline of today, with defaults for what is missing', () => {
  assert.deepEqual(legacyColumns({ status: { queue: 'Todo', working: 'Doing', review: 'Review' }, promptTemplate: '/ship #{id}' }), [
    { name: 'fila', weight: 1, visible: 5, session: 'new', from: ['Todo'], onStart: 'Doing', onFinish: 'Review', prompt: '/ship #{id}' },
  ]);
  const [defaults] = legacyColumns({});
  assert.deepEqual([defaults.from, defaults.onStart, defaults.onFinish], [['Ready'], 'In progress', 'In review']);
  assert.match(defaults.prompt ?? '', /^Task #\{number\}: \{title\}/);
  assert.equal(legacyColumns({ status: { queue: '' } })[0].from[0], 'Ready', 'an empty value falls back too');
  assert.equal(defaults.visible, 5, 'a new column in the user\'s eyes: same default as the editor');
});

test('legacyConfig proposes a config for a file without columns and is undefined for a file that has them or that is broken', () => {
  const proposed = legacyConfig({ board: { type: 'markdown', path: 'b.md' }, status: { queue: 'Todo' }, maxConcurrent: 3 });
  assert.equal(proposed?.maxConcurrent, 3);
  assert.deepEqual(proposed?.columns[0].from, ['Todo']);
  assert.equal(legacyConfig({ ...GITHUB }), undefined, 'has columns: parseConfig is the way');
  assert.equal(legacyConfig({ status: {} }), undefined, 'no board: nothing to propose');
  assert.equal(legacyConfig('x'), undefined);
});

test('loadConfigOrLegacy reads a legacy file as its proposal, a current file as is, undefined when missing, and still rejects a broken one', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  assert.equal(await loadConfigOrLegacy(repo), undefined);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ board: { type: 'markdown', path: 'b.md' }, promptTemplate: '/x {url}' }));
  assert.equal((await loadConfigOrLegacy(repo))?.columns[0].prompt, '/x {url}');
  await assert.rejects(loadConfigIfPresent(repo), /"columns" is required/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ ...GITHUB, maxConcurrent: 4 }));
  assert.equal((await loadConfigOrLegacy(repo))?.maxConcurrent, 4);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ board: { type: 'markdown' } }));
  await assert.rejects(loadConfigOrLegacy(repo), /board\.path/);
});
