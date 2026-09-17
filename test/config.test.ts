import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, loadConfigIfPresent, parseConfig } from '../src/config.js';

const GITHUB = { type: 'github', owner: '@me', number: 6 };

test('parseConfig applies defaults on top of a minimal config', () => {
  const config = parseConfig({ board: GITHUB });
  assert.deepEqual(config.status, { queue: 'Ready', working: 'In progress', review: 'In review' });
  assert.equal(config.maxConcurrent, 2);
  assert.equal(config.port, 47821);
  assert.deepEqual(config.claudeArgs, []);
  assert.equal(config.promptTemplate, DEFAULT_CONFIG.promptTemplate);
  assert.deepEqual(config.budget, {});
  assert.deepEqual(config.usageRules, []);
  assert.equal(config.workers, 'embedded');
  assert.equal(config.epics, 'ignore');
  assert.equal(config.logLevel, 'info');
});

test('parseConfig accepts workers embedded or iterm and rejects anything else', () => {
  assert.equal(parseConfig({ board: GITHUB, workers: 'iterm' }).workers, 'iterm');
  assert.throws(() => parseConfig({ board: GITHUB, workers: 'tmux' }), /"workers" must be one of: embedded, iterm/);
});

test('parseConfig accepts epics ignore or queue and rejects anything else', () => {
  assert.equal(parseConfig({ board: GITHUB, epics: 'queue' }).epics, 'queue');
  assert.equal(parseConfig({ board: GITHUB, epics: 'ignore' }).epics, 'ignore');
  assert.throws(() => parseConfig({ board: GITHUB, epics: 'label' }), /"epics" must be one of: ignore, queue/);
});

test('parseConfig accepts logLevel info or debug and rejects anything else', () => {
  assert.equal(parseConfig({ board: GITHUB, logLevel: 'debug' }).logLevel, 'debug');
  assert.equal(parseConfig({ board: GITHUB, logLevel: 'info' }).logLevel, 'info');
  assert.throws(() => parseConfig({ board: GITHUB, logLevel: 'trace' }), /"logLevel" must be one of: info, debug/);
  assert.throws(() => parseConfig({ board: GITHUB, logLevel: true }), /"logLevel" must be one of: info, debug/);
});

test('parseConfig accepts language pt or en, leaves the key absent when unset and rejects anything else', () => {
  assert.equal(parseConfig({ board: GITHUB, language: 'en' }).language, 'en');
  assert.equal(parseConfig({ board: GITHUB, language: 'pt' }).language, 'pt');
  assert.equal('language' in parseConfig({ board: GITHUB }), false, 'absent stays absent so writeConfigFile keeps the file clean');
  assert.throws(() => parseConfig({ board: GITHUB, language: 'fr' }), /"language" must be one of: pt, en/);
  assert.throws(() => parseConfig({ board: GITHUB, language: 'pt-BR' }), /"language" must be one of: pt, en/);
  assert.throws(() => parseConfig({ board: GITHUB, language: true }), /"language" must be one of: pt, en/);
});

test('parseConfig keeps explicit values', () => {
  const config = parseConfig({
    board: { type: 'github', owner: 'acme', number: 3 },
    status: { queue: 'Todo', working: 'Doing', review: 'Review' },
    maxConcurrent: 4, port: 5000, claudeArgs: ['--model', 'sonnet'], promptTemplate: '{title}',
  });
  assert.equal(config.status.queue, 'Todo');
  assert.equal(config.maxConcurrent, 4);
  assert.deepEqual(config.claudeArgs, ['--model', 'sonnet']);
  assert.equal(config.promptTemplate, '{title}');
});

test('parseConfig accepts a github or a markdown board', () => {
  assert.deepEqual(parseConfig({ board: { type: 'github', owner: 'acme', number: 6 } }).board, { type: 'github', owner: 'acme', number: 6 });
  assert.deepEqual(parseConfig({ board: { type: 'markdown', path: 'docs/board.md' } }).board, { type: 'markdown', path: 'docs/board.md' });
});

test('parseConfig reads the legacy project field as a github board', () => {
  assert.deepEqual(parseConfig({ project: { owner: '@me', number: 9 } }).board, { type: 'github', owner: '@me', number: 9 });
  // an explicit board wins over a leftover project
  const both = parseConfig({ project: { owner: '@me', number: 9 }, board: { type: 'markdown', path: 'b.md' } });
  assert.equal(both.board.type, 'markdown');
});

test('parseConfig rejects missing or wrong-typed fields with the field name', () => {
  assert.throws(() => parseConfig({}), /"board"/);
  assert.throws(() => parseConfig({ board: { type: 'github', owner: '@me' } }), /board\.number/);
  assert.throws(() => parseConfig({ board: { type: 'github', number: 1 } }), /board\.owner/);
  assert.throws(() => parseConfig({ board: { type: 'markdown' } }), /board\.path/);
  assert.throws(() => parseConfig({ board: { type: 'asana', id: 1 } }), /board\.type.*github, markdown/);
  assert.throws(() => parseConfig({ project: { owner: '@me' } }), /project\.number/);
  assert.throws(() => parseConfig({ board: GITHUB, maxConcurrent: '3' }), /maxConcurrent/);
  assert.throws(() => parseConfig({ board: GITHUB, claudeArgs: 'x' }), /claudeArgs/);
  assert.throws(() => parseConfig({ board: GITHUB, status: { queue: 1 } }), /status\.queue/);
});

test('loadConfig reads hive.config.json from the repo, including a legacy project file, and reports a missing file clearly', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  await assert.rejects(loadConfig(repo), /hive\.config\.json/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ project: { owner: '@me', number: 9 } }));
  assert.deepEqual((await loadConfig(repo)).board, { type: 'github', owner: '@me', number: 9 });
});

test('loadConfigIfPresent returns undefined only when the file is missing', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  assert.equal(await loadConfigIfPresent(repo), undefined);
  await writeFile(join(repo, 'hive.config.json'), '{not json');
  await assert.rejects(loadConfigIfPresent(repo), /JSON inválido/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ board: { type: 'markdown', path: 'board.md' } }));
  assert.deepEqual((await loadConfigIfPresent(repo))?.board, { type: 'markdown', path: 'board.md' });
});

test('markdown boards reject status values with "|" or line breaks; github boards do not care', () => {
  const md = { type: 'markdown', path: 'board.md' };
  const message = 'hive.config.json: "status.working" must not contain "|" or line breaks for markdown boards';
  assert.throws(() => parseConfig({ board: md, status: { working: 'In | progress' } }), { message });
  assert.throws(() => parseConfig({ board: md, status: { working: 'In\nprogress' } }), { message });
  assert.throws(() => parseConfig({ board: md, status: { review: 'Rev\riew' } }), /status\.review/);
  assert.equal(parseConfig({ board: GITHUB, status: { working: 'In | progress' } }).status.working, 'In | progress');
});

test('parseConfig reads budget, leaves absent limits absent and defaults to {}', () => {
  assert.deepEqual(parseConfig({ board: GITHUB }).budget, {});
  assert.deepEqual(parseConfig({ board: GITHUB, budget: {} }).budget, {});
  assert.deepEqual(parseConfig({ board: GITHUB, budget: { maxTokensPerHour: 50_000 } }).budget, { maxTokensPerHour: 50_000 });
  assert.deepEqual(
    parseConfig({ board: GITHUB, budget: { maxTokensPerHour: 0, maxTokensPerDay: 1_000_000 } }).budget,
    { maxTokensPerHour: 0, maxTokensPerDay: 1_000_000 },
  );
});

test('parseConfig rejects a budget that is not an object or has a non-integer limit, naming the field', () => {
  assert.throws(() => parseConfig({ board: GITHUB, budget: 5 }), { message: 'hive.config.json: "budget" must be an object' });
  assert.throws(() => parseConfig({ board: GITHUB, budget: [] }), /"budget" must be an object/);
  assert.throws(() => parseConfig({ board: GITHUB, budget: null }), /"budget" must be an object/);
  assert.throws(
    () => parseConfig({ board: GITHUB, budget: { maxTokensPerHour: 1.5 } }),
    { message: 'hive.config.json: "budget.maxTokensPerHour" must be a non-negative integer' },
  );
  assert.throws(() => parseConfig({ board: GITHUB, budget: { maxTokensPerDay: -1 } }), /budget\.maxTokensPerDay/);
  assert.throws(() => parseConfig({ board: GITHUB, budget: { maxTokensPerDay: '10' } }), /budget\.maxTokensPerDay/);
});

test('parseConfig reads usageRules as written', () => {
  const usageRules = [{ percent: 50, maxWorkers: 4 }, { percent: 80, signal: 'yellow' }, { percent: 90, maxWorkers: 0, signal: 'red' }];
  assert.deepEqual(parseConfig({ board: GITHUB, usageRules }).usageRules, usageRules);
  assert.deepEqual(parseConfig({ board: GITHUB, usageRules: [] }).usageRules, []);
});

test('parseConfig rejects bad usage rules naming the field', () => {
  const rules = (usageRules: unknown) => () => parseConfig({ board: GITHUB, usageRules });
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
