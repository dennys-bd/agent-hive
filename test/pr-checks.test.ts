import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksOf, checkState, decisionOf, headRollup, rollupFields } from '../src/pr-checks.js';

const AT = '2026-10-07T10:00:00Z';
const LATER = '2026-10-07T11:00:00Z';
const run = (name: string, status: string, conclusion: string | null, completedAt: string | null = AT) =>
  ({ __typename: 'CheckRun', name, status, conclusion, detailsUrl: `https://github.com/acme/app/runs/${name}`, completedAt });
const context = (name: string, state: string) => ({ __typename: 'StatusContext', context: name, state, targetUrl: `https://ci.example/${name}`, createdAt: LATER });

test('checkState buckets GitHub\'s conclusions and states as its own rollup does; anything else is pending (#758)', () => {
  assert.deepEqual(['SUCCESS', 'NEUTRAL', 'SKIPPED'].map((raw) => checkState(raw)), ['success', 'success', 'success']);
  assert.deepEqual(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].map((raw) => checkState(raw)), Array(6).fill('failure'));
  assert.deepEqual(['PENDING', 'EXPECTED', 'NEW_ONE', null, 7].map((raw) => checkState(raw)), Array(5).fill('pending'));
});

test('checksOf reads check runs and status contexts, a run not completed as pending, the latest completion; none without a rollup or a check (#758)', () => {
  const skipped: string[] = [];
  const rollup = { state: 'PENDING', contexts: { nodes: [run('test', 'COMPLETED', 'SUCCESS'), run('lint', 'IN_PROGRESS', null, null), context('deploy', 'FAILURE'), { __typename: 'Mystery' }] } };
  assert.deepEqual(checksOf(rollup, (reason) => skipped.push(reason)), {
    state: 'pending', at: LATER, items: [
      { name: 'test', state: 'success', url: 'https://github.com/acme/app/runs/test', at: AT },
      { name: 'lint', state: 'pending', url: 'https://github.com/acme/app/runs/lint' },
      { name: 'deploy', state: 'failure', url: 'https://ci.example/deploy', at: LATER },
    ],
  });
  assert.deepEqual(skipped, ['unreadable check (Mystery)']);
  assert.equal(checksOf(undefined), undefined);
  assert.equal(checksOf({ state: 'SUCCESS', contexts: { nodes: [] } }), undefined);
});

test('headRollup reads the rollup off the head commit; decisionOf shortens reviewDecision, null reading none (#758)', () => {
  assert.deepEqual(headRollup({ nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }), { state: 'SUCCESS' });
  assert.equal(headRollup({ nodes: [{ commit: { statusCheckRollup: null } }] }), undefined);
  assert.equal(headRollup({ nodes: [] }), undefined);
  assert.deepEqual(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', null, 'NEW'].map((raw) => decisionOf(raw)), ['approved', 'changes', 'pending', undefined, undefined]);
});

test('a check run\'s startedAt and a pending status context\'s createdAt reach startedAt; a finished status context has none; the query asks startedAt (#914)', () => {
  const rollup = { state: 'PENDING', contexts: { nodes: [{ ...run('test', 'IN_PROGRESS', null, null), startedAt: AT }, context('deploy', 'PENDING'), context('docs', 'SUCCESS')] } };
  assert.deepEqual(checksOf(rollup)?.items.map((c) => [c.name, c.startedAt, c.at]), [['test', AT, undefined], ['deploy', LATER, LATER], ['docs', undefined, LATER]]);
  assert.match(rollupFields(), /detailsUrl startedAt completedAt/);
});
