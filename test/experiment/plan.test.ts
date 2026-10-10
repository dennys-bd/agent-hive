import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  endAttempt, experimentDir, isMeasured, latest, newExperimentId, newManifest, newToken, openAttempts, parseManifest, requireExperimentId,
  resumeManifest, runBranch, seedDrift, runHome, runOrder, runPrefix, runRef, startAttempt, stateRoot,
} from '../../scripts/experiment/plan.js';

const NIGHT = new Date(2026, 9, 1, 21, 30);
const base = { id: 'skills-x', source: 'src0', baseline: 'abc' };

test('runOrder lists the pairs as slots, A1 B1 A2 B2 (#105)', () => {
  assert.deepEqual(runOrder(2).map((r) => r.id), ['a1', 'b1', 'a2', 'b2']);
  assert.deepEqual(runOrder(0), []);
});

test('a token names the branch, the home and the task prefix, and says nothing of the arm (#105)', () => {
  assert.equal(runBranch('3fa2c1'), 'feat/monitor-view-3fa2c1');
  assert.equal(runHome('/state', '3fa2c1'), join('/state', 'homes', '3fa2c1'));
  assert.equal(runPrefix('3fa2c1'), 'M3FA2C1');
  assert.match(runPrefix('3fa2c1'), /^[A-Za-z][A-Za-z0-9]{0,9}$/, 'a valid Comb prefix');
});

test('newToken draws 6 hex characters and draws again on a clash or a bad draw (#105)', () => {
  const draws = ['abc123', 'zzzzzz', 'def456'];
  assert.equal(newToken(new Set(['abc123']), () => draws.shift() ?? ''), 'def456');
  assert.match(newToken(new Set()), /^[0-9a-f]{6}$/);
  assert.throws(() => newToken(new Set(['abc123']), () => 'abc123'), /token/);
});

test('startAttempt, endAttempt, latest and isMeasured follow a slot through its attempts, leaving the manifest given unchanged (#105)', () => {
  const m0 = newManifest({ ...base, seedHash: 'h', runs: 1, now: NIGHT });
  const m1 = startAttempt(m0, runRef('a', 1), 'aaaaaa', NIGHT, false);
  assert.equal(isMeasured(m1, runRef('a', 1)), false);
  const m2 = endAttempt(startAttempt(m1, runRef('b', 1), 'bbbbbb', NIGHT, true), 'aaaaaa', 'done');
  assert.deepEqual(latest(m2, runRef('b', 1)), { token: 'bbbbbb', arm: 'b', n: 1, startedAt: NIGHT.toISOString(), unpaired: true });
  assert.equal(isMeasured(m2, runRef('a', 1)), true);
  assert.deepEqual(m0.attempts, []);
  assert.deepEqual(openAttempts(m2).map((a) => a.token), ['bbbbbb']);
});

test('resumeManifest refuses a changed seed, marks every open attempt interrupted, and takes a new --runs (#105)', () => {
  const started = startAttempt(newManifest({ ...base, seedHash: 'f'.repeat(64), runs: 1, now: NIGHT }), runRef('a', 1), 'aaaaaa', NIGHT, false);
  assert.throws(() => resumeManifest(started, 'e'.repeat(64), undefined), /seed changed.*ffffffff → eeeeeeee/);
  const resumed = resumeManifest(started, 'f'.repeat(64), 3);
  assert.deepEqual([resumed.runs, resumed.attempts[0].outcome, isMeasured(resumed, runRef('a', 1))], [3, 'interrupted', false]);
  assert.equal(started.attempts[0].outcome, undefined);
});

test('newManifest records source, baseline, hash, plan and no attempt; ids carry the local time (#105)', () => {
  assert.deepEqual(newManifest({ ...base, seedHash: 'h', runs: 2, now: NIGHT }), { ...base, seedHash: 'h', runs: 2, createdAt: NIGHT.toISOString(), attempts: [] });
  assert.equal(newExperimentId(NIGHT), 'skills-20261001-2130');
});

test('requireExperimentId takes a folder-safe id and refuses anything else (#105)', () => {
  assert.equal(requireExperimentId('skills-20261001-2130'), 'skills-20261001-2130');
  for (const bad of ['', '../x', 'Skills', '-x', 'a/b', 'x'.repeat(49)]) assert.throws(() => requireExperimentId(bad), /--experiment/, bad);
});

test('the state folder is outside the repo: XDG_STATE_HOME when it is absolute, else .local/state under the home passed in (#105)', () => {
  assert.equal(stateRoot({ XDG_STATE_HOME: '/xdg' }, '/h'), join('/xdg', 'agent-hive-lab'));
  for (const env of [{}, { XDG_STATE_HOME: '' }, { XDG_STATE_HOME: 'relative/dir' }]) assert.equal(stateRoot(env, '/h'), join('/h', '.local', 'state', 'agent-hive-lab'));
  assert.equal(experimentDir('/state', 'skills-x'), join('/state', 'experiments', 'skills-x'));
});

test('parseManifest reads what newManifest wrote and refuses anything else (#105)', () => {
  const m = startAttempt(newManifest({ ...base, seedHash: 'h', runs: 2, now: NIGHT }), runRef('a', 1), 'aaaaaa', NIGHT, false);
  assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(m))), m);
  for (const bad of [{ ...m, baseline: '-x' }, { ...m, baseline: 'a..b' }, { ...m, baseline: 'a b' }, { ...m, source: '--upload-pack=x' }, { ...m, source: 'HEAD@{1}' }, { ...m, id: '../x' }, { ...m, id: 'Skills X' }]) assert.throws(() => parseManifest(bad), /manifest/, JSON.stringify(bad));
  for (const bad of [null, {}, { ...m, runs: '2' }, { ...m, source: undefined }, { ...m, attempts: undefined }, { ...m, attempts: [{ token: 'x' }] }, { ...m, attempts: [{ ...m.attempts[0], token: '../../x' }] }, { ...m, attempts: [{ ...m.attempts[0], token: 'AAAAAA' }] }]) assert.throws(() => parseManifest(bad), /manifest/);
});

test('seedDrift names a changed seed for a re-judge instead of refusing it: finished runs are judged against today\'s scenarios and handoff (#105)', () => {
  const m = newManifest({ id: 'skills-x', source: 's', baseline: 'b', seedHash: 'a42b2fc7aaaa', runs: 1, now: new Date('2026-10-05T00:00:00Z') });
  assert.equal(seedDrift(m, 'a42b2fc7aaaa'), undefined);
  assert.equal(seedDrift(m, '1ea20388bbbb'), 'experiment skills-x: the seed changed since its runs (a42b2fc7 → 1ea20388); judging them against the current scenarios, handoff and sample');
});
