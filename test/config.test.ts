import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, parseConfig } from '../src/config.js';

test('parseConfig applies defaults on top of a minimal config', () => {
  const config = parseConfig({ project: { owner: '@me', number: 6 } });
  assert.deepEqual(config.status, { queue: 'Ready', working: 'In progress', review: 'In review' });
  assert.equal(config.maxConcurrent, 2);
  assert.equal(config.port, 47821);
  assert.deepEqual(config.claudeArgs, []);
  assert.equal(config.promptTemplate, DEFAULT_CONFIG.promptTemplate);
});

test('parseConfig keeps explicit values', () => {
  const config = parseConfig({
    project: { owner: 'acme', number: 3 },
    status: { queue: 'Todo', working: 'Doing', review: 'Review' },
    maxConcurrent: 4, port: 5000, claudeArgs: ['--model', 'sonnet'], promptTemplate: '{title}',
  });
  assert.equal(config.status.queue, 'Todo');
  assert.equal(config.maxConcurrent, 4);
  assert.deepEqual(config.claudeArgs, ['--model', 'sonnet']);
  assert.equal(config.promptTemplate, '{title}');
});

test('parseConfig rejects missing or wrong-typed fields with the field name', () => {
  assert.throws(() => parseConfig({}), /project\.owner/);
  assert.throws(() => parseConfig({ project: { owner: '@me' } }), /project\.number/);
  assert.throws(() => parseConfig({ project: { owner: '@me', number: 1 }, maxConcurrent: '3' }), /maxConcurrent/);
  assert.throws(() => parseConfig({ project: { owner: '@me', number: 1 }, claudeArgs: 'x' }), /claudeArgs/);
  assert.throws(() => parseConfig({ project: { owner: '@me', number: 1 }, status: { queue: 1 } }), /status\.queue/);
});

test('loadConfig reads hive.config.json from the repo and reports a missing file clearly', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  await assert.rejects(loadConfig(repo), /hive\.config\.json/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ project: { owner: '@me', number: 9 } }));
  const config = await loadConfig(repo);
  assert.equal(config.project.number, 9);
});
