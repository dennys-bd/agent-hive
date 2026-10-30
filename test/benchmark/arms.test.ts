import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armFrom, checkArm, checkRemove, checkTargets, isArmRefusal, isLocked, nextLetter, stageCall } from '../../src/benchmark/arms.js';
import { arm, experiment } from './fixtures.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

test('nextLetter takes the first free letter A–Z and none past Z (#459)', () => {
  assert.equal(nextLetter([arm('a1', 'A'), arm('a3', 'C')]), 'B');
  assert.equal(nextLetter(LETTERS.map((l, i) => arm(`a${i}`, l))), undefined);
});

test('armFrom: from base the overrides are empty, from an arm they are its own, tasks included; an unknown arm is 404, a 27th arm 409 (#459)', () => {
  const tasks = [{ key: 'T1', title: 'One', body: '', blockedBy: [] }];
  const e = experiment({ arms: [arm('a1', 'A', { plugins: ['p'], tasks })] });
  assert.deepEqual(armFrom(e, 'base', 'xnew00001'), { id: 'xnew00001', letter: 'B', name: 'Arm B', overrides: {} });
  assert.deepEqual(armFrom(e, 'a1', 'xnew00001'), { id: 'xnew00001', letter: 'B', name: 'Arm B', overrides: { plugins: ['p'], tasks } });
  const unknown = armFrom(e, 'nope', 'xnew00001');
  assert.ok(isArmRefusal(unknown) && unknown.status === 404 && unknown.error === 'unknown_arm');
  const full = armFrom(experiment({ arms: LETTERS.map((l, i) => arm(`a${i}`, l)) }), 'base', 'xnew00001');
  assert.ok(isArmRefusal(full) && full.status === 409 && full.error === 'no_letter');
});

test('checkArm and checkTargets answer 404 for an unknown arm; checkRemove refuses the last arm with 409 (#459)', () => {
  const e = experiment();
  assert.equal((checkArm(e, 'a2') as { id: string }).id, 'a2');
  assert.equal((checkArm(e, 'nope') as { status: number }).status, 404);
  assert.equal(checkTargets(e, ['a1', 'a2']), undefined);
  assert.equal(checkTargets(e, ['a1', 'nope'])?.status, 404);
  assert.equal(checkRemove(e, 'a2'), undefined);
  assert.equal(checkRemove(e, 'nope')?.status, 404);
  assert.equal(checkRemove(experiment({ arms: [arm('a1', 'A')] }), 'a1')?.error, 'last_arm');
});

test('isLocked holds while running or sleeping only (#459)', () => {
  assert.deepEqual((['draft', 'running', 'sleeping', 'done'] as const).map((status) => isLocked(experiment({ status }))), [false, true, true, false]);
});

test("stageCall: a skill stage's /hive:<skill>, a prompt's opening command, else its first /hive call; none on an action (#536)", () => {
  assert.equal(stageCall({ action: 'skill', skill: 'new-plan' }), '/hive:new-plan');
  assert.equal(stageCall({ prompt: '/superpowers:executing-plans {id}' }), '/superpowers:executing-plans');
  assert.equal(stageCall({ prompt: 'write the spec, then run /hive-spec on it' }), '/hive-spec');
  assert.equal(stageCall({ prompt: 'open the PR with a summary' }), undefined);
  assert.equal(stageCall({ action: 'commands' }), undefined);
});
