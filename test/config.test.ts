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
