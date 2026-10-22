import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prBody } from '../../src/benchmark/pr.js';
import { aggregate } from '../../src/benchmark/report.js';
import { bestRun, endedRuns, prTitle, suggestBranch } from '../../src/benchmark/pr-pick.js';
import type { BenchRun, Experiment } from '../../src/types.js';
import { experiment, run } from './fixtures.js';

const AT = '2026-10-22T08:00:00.000Z';
// A run judged with these scores, done unless the patch says otherwise
const judged = (token: string, scores: number[], patch: Partial<BenchRun> = {}): BenchRun => run(token, {
  status: 'done', ...patch,
  evaluation: { at: AT, collectors: [], scenarios: [], judge: { agent: 'claude', rubricHash: 'r'.repeat(64), scores: scores.map((score, i) => ({ dimension: `d${i}`, score, evidence: '' })) } },
});
const withRuns = (...rounds: BenchRun[][]): Experiment => experiment({ rounds: rounds.map((runs, i) => ({ n: i + 1, runs })) });
const tokensOf = (tokens: number): Pick<BenchRun, 'metrics'> => ({
  metrics: { tokens, costUsd: 0, ms: 0, waitingMs: 0, restarts: { count: 0, where: [] }, diff: { files: 0, insertions: 0, deletions: 0 }, tests: { green: 0, total: 0 }, tasks: [] },
});

test('bestRun: the highest mean judge score; a tie goes to done, then to fewer tokens, then to the earlier round (#477)', () => {
  assert.equal(bestRun(withRuns([judged('aaaa1', [4, 4]), judged('bbbb1', [5, 4])]))?.token, 'bbbb1');
  assert.equal(bestRun(withRuns([judged('aaaa1', [5, 4], { status: 'timeout' }), judged('bbbb1', [4, 5])]))?.token, 'bbbb1', 'done first');
  assert.equal(bestRun(withRuns([judged('aaaa1', [4], tokensOf(3_000_000)), judged('bbbb1', [4], tokensOf(2_000_000))]))?.token, 'bbbb1', 'fewer tokens');
  assert.equal(bestRun(withRuns([judged('aaaa1', [4], tokensOf(1)), judged('bbbb1', [4])]))?.token, 'aaaa1', 'a run with no metrics counts as the most tokens');
  assert.equal(bestRun(withRuns([judged('aaaa1', [4])], [judged('bbbb2', [4], { round: 2 })]))?.token, 'aaaa1', 'the earlier round');
});

test('bestRun: with no judged run, the first ended one; with none ended, none. Every ended status counts, a live one never (#477)', () => {
  const live = (['queued', 'running', 'waiting', 'sleeping'] as const).map((status, i) => run(`live${i}`, { status }));
  assert.equal(bestRun(withRuns(live)), undefined);
  assert.equal(bestRun(withRuns([run('aaaa1', { status: 'running' }), run('bbbb1', { status: 'interrupted' }), run('cccc1', { status: 'done' })]))?.token, 'bbbb1');
  const ended = withRuns([run('aaaa1', { status: 'error' }), run('bbbb1', { status: 'timeout' }), run('cccc1', { status: 'sleeping' })], [run('dddd2', { status: 'done', round: 2 })]);
  assert.deepEqual(endedRuns(ended).map((r) => r.token), ['aaaa1', 'bbbb1', 'dddd2']);
});

test('suggestBranch kebabs the experiment\'s name under feat/, without accents and capped, and prTitle is feat: and the name (#477)', () => {
  assert.equal(suggestBranch('Skills do plugin'), 'feat/skills-do-plugin');
  assert.equal(suggestBranch('  Ação: rápida!  '), 'feat/acao-rapida');
  assert.equal(suggestBranch('***'), 'feat/experiment');
  assert.equal(suggestBranch('x'.repeat(80)), `feat/${'x'.repeat(60)}`);
  assert.equal(prTitle('Skills do plugin'), 'feat: Skills do plugin');
});


const MIN = 60_000;
const NOW = Date.parse('2026-10-22T09:00:00.000Z');
const measured = (): BenchRun => run('aaaa1', {
  status: 'done', delivered: 1, endedAt: AT,
  metrics: { tokens: 2_500_000, costUsd: 33, ms: 288 * MIN, waitingMs: 0, restarts: { count: 0, where: [] }, diff: { files: 1, insertions: 1, deletions: 0 }, tests: { green: 10, total: 10 }, tasks: [] },
  evaluation: { at: AT, collectors: [], scenarios: [], judge: { agent: 'claude', rubricHash: 'r'.repeat(64), scores: [{ dimension: 'fidelity', score: 4, evidence: '' }, { dimension: 'behavior', score: 5, evidence: '' }] } },
});

test('prBody without the summary: the line and the run\'s task titles, nothing of the report (#477)', () => {
  assert.equal(prBody(withRuns([measured()]), measured(), undefined), 'Opened from a benchmark run.\n\n- One\n');
});

test('prBody with the summary: the experiment, the arm, the run and its round, the arm\'s medians and the hash prefixes, no link (#477)', () => {
  const e = withRuns([measured()]);
  assert.equal(prBody(e, measured(), aggregate(e, 'in', NOW)), [
    'Opened from a benchmark run.', '',
    'Experiment Skills, arm A · arm A, run aaaa1, round 1.', '',
    '- tokens: 2.5M', '- cost: $33', '- time: 4h48', '- tests green: 1/1', '- fidelity: 4', '- behavior: 5', '',
    'seed ssssss · tasks tttttt · plugin pppppp', '',
  ].join('\n'));
});
