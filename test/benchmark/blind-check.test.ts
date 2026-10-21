import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { blindLeak } from '../../src/benchmark/blind-check.js';
import { prepareRun } from '../../src/benchmark/run-home.js';
import { arm, benchHome, experiment, SETUP } from './fixtures.js';

test('blindLeak finds a forbidden word whole, in any case and with accents, and names where it is (#471)', () => {
  const inputs = [{ where: 'task T1', text: 'An experimental build' }, { where: 'stage spec', text: 'Pick the BRAÇO, then (arm) it' }];
  assert.deepEqual(blindLeak(inputs, ['experiment', 'braço']), { where: 'stage spec', word: 'braço' });
  assert.deepEqual(blindLeak(inputs, ['arm']), { where: 'stage spec', word: 'arm' });
  assert.equal(blindLeak([{ where: 'x', text: 'braços e armas' }], ['braço', 'arm']), undefined);
  assert.equal(blindLeak([{ where: 'x', text: 'axb+c' }], ['a.b', '', ' ']), undefined, 'a word is literal, a blank one never matches');
  assert.deepEqual(blindLeak([{ where: 'x', text: 'see a.b now' }], ['a.b']), { where: 'x', word: 'a.b' });
});

test('with blindness on, experimento in a task body refuses the run naming the task, before any git or file (#471)', async (t) => {
  const env = await benchHome(t);
  const exp = experiment({ blindness: { on: true, forbiddenWords: ['experimento'] }, base: { ...SETUP, tasks: [{ key: 'T1', title: 'One', body: 'Um experimento', blockedBy: [] }] } });
  await assert.rejects(prepareRun(exp, exp.arms[0], 1, env.deps), /"experimento" in task T1/);
  assert.equal(env.calls.length, 0);
  assert.equal(existsSync(join(env.hiveDir, 'benchmark', 'exp-1', 'runs')), false);
});

test('a forbidden word in a copied skill file refuses naming the file (#471)', async (t) => {
  const env = await benchHome(t);
  const exp = experiment({ blindness: { on: true, forbiddenWords: ['arm'] }, arms: [arm('a1', 'A', { items: { 'hive:new-spec': 'terse' } })] });
  await assert.rejects(prepareRun(exp, exp.arms[0], 1, env.deps), /"arm" in custom\/hive\/new-spec\/terse\/files\/SKILL\.md/);
});

test('with blindness off the same words write the home (#471)', async (t) => {
  const env = await benchHome(t);
  const exp = experiment({ blindness: { on: false, forbiddenWords: ['arm', 'experimento'] }, arms: [arm('a1', 'A', { items: { 'hive:new-spec': 'terse' }, tasks: [{ key: 'T1', title: 'One', body: 'Um experimento', blockedBy: [] }] })] });
  const run = await prepareRun(exp, exp.arms[0], 1, env.deps);
  assert.ok(existsSync(join(run.home, 'hive.config.json')));
});
