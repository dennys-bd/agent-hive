import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from '../../scripts/experiment/files.js';
import { endAttempt, newManifest, runRef, startAttempt } from '../../scripts/experiment/plan.js';
import { aggregate, clickRates, renderReport, type RunRecord, stat, writeReport } from '../../scripts/experiment/report.js';
import type { Judge, Metrics, Outcome } from '../../scripts/experiment/types.js';
import { tempDir } from '../temp-dir.js';

const T0 = '2026-10-01T22:00:00.000Z';
const NIGHT = new Date(T0);
const judge = (fidelity: number | null, behaviour: number | null, code: number): Judge => ({
  model: 'm', scores: { fidelity: { score: fidelity, reason: '' }, behaviour: { score: behaviour, reason: '' }, code: { score: code, reason: '' }, specAndPlan: { score: 5, reason: '' }, tests: { score: 5, reason: '' } },
});
const metrics = (token: string, outcome: Outcome, tokens: number, reason?: string): Metrics => ({
  token, outcome, ...(reason ? { reason } : {}), startedAt: T0, endedAt: '2026-10-01T23:00:00.000Z',
  tasks: [], tokens, ms: 600_000, waitingMs: 0, buildRestarts: 1, diff: { files: 1, insertions: 10, deletions: 5 },
});
const click = (scenario: string, passed: boolean) => ({ scenario, passed, notes: '', screenshots: [] });
const RECORDS: RunRecord[] = [
  { ref: runRef('a', 1), token: 'aaaaa1', metrics: metrics('aaaaa1', 'done', 100), evaluation: { booted: true, testsGreen: true }, clicks: [click('S1', true), click('S2', true), click('S3', false)], judge: judge(8, 7, 6), shots: ['aaaaa1/screens/S1-1.png'] },
  { ref: runRef('a', 2), token: 'aaaaa2', metrics: { ...metrics('aaaaa2', 'timeout', 300), unpaired: true }, evaluation: { booted: false, testsGreen: false, reason: 'build failed: tsc' }, judge: judge(null, null, 4), shots: [] },
  { ref: runRef('b', 1), token: 'bbbbb1', metrics: metrics('bbbbb1', 'done', 200), evaluation: { booted: true, testsGreen: true }, clicks: [click('S1', false), click('S2', true), click('S3', true)], judge: judge(6, 9, 8), shots: [] },
  { ref: runRef('b', 2), token: 'bbbbb2', metrics: metrics('bbbbb2', 'error', 50, 'MBBBBB2-1: spawn failed'), shots: [] },
];
const manifestOf = (runs: number) => newManifest({ id: 'skills-x', source: 'src0', baseline: 'abc123', docsSource: 'dsrc0', docsBaseline: 'dabc123', seedHash: 'h', runs, now: NIGHT });

test('stat is the mean, min and max of the values, and nothing for none (#105)', () => {
  assert.deepEqual(stat([4, 6, 8]), { mean: 6, min: 4, max: 8, n: 3 });
  assert.deepEqual(stat([5]), { mean: 5, min: 5, max: 5, n: 1 });
  assert.equal(stat([]), undefined);
});

test('aggregate takes each measure per arm over the runs that have it, a null score and a missing evaluation skipped (#105)', () => {
  const rows = Object.fromEntries(aggregate(RECORDS).map((r) => [r.label, r.arms]));
  assert.deepEqual(rows.tokens, { a: { mean: 200, min: 100, max: 300, n: 2 }, b: { mean: 125, min: 50, max: 200, n: 2 } });
  assert.deepEqual(rows['score: fidelity'].a, { mean: 8, min: 8, max: 8, n: 1 });
  assert.deepEqual(rows['score: code'].b, { mean: 8, min: 8, max: 8, n: 1 });
  assert.deepEqual(rows['clicks passed (%)'].a, { mean: 67, min: 67, max: 67, n: 1 });
  assert.deepEqual(rows['tests green (1/0)'].a, { mean: 0.5, min: 0, max: 1, n: 2 });
});

test('clickRates counts each scenario passed over the runs that clicked it, per arm (#105)', () => {
  assert.deepEqual(clickRates(RECORDS), [
    { scenario: 'S1', arms: { a: { passed: 1, total: 1 }, b: { passed: 0, total: 1 } } },
    { scenario: 'S2', arms: { a: { passed: 1, total: 1 }, b: { passed: 1, total: 1 } } },
    { scenario: 'S3', arms: { a: { passed: 0, total: 1 }, b: { passed: 1, total: 1 } } },
  ]);
});

test('renderReport maps every token to its arm and slot, flags unpaired, and lists interrupted attempts (#105)', () => {
  const interrupted = endAttempt(startAttempt(manifestOf(2), runRef('a', 2), 'dead01', NIGHT, false), 'dead01', 'done');
  const manifest = { ...interrupted, attempts: interrupted.attempts.map((a) => ({ ...a, outcome: 'interrupted' as const })) };
  const report = renderReport(manifest, RECORDS);
  for (const part of [
    '# Skills A/B experiment skills-x', 'Arm A: the repository commands', 'Arm B: the plugin skills', '| tokens | 200 | 100–300 | 125 | 50–200 |', '| S1 | 1/1 | 0/1 |',
    '| A2 | `aaaaa2` | timeout, unpaired, did not boot |', '| B2 | `bbbbb2` | error (MBBBBB2-1: spawn failed), not evaluated |',
    '[S1-1.png](aaaaa1/screens/S1-1.png)', '- A2 `dead01`', '`feat/monitor-view-dead01`',
  ]) assert.ok(report.includes(part), part);
});

test('writeReport reads each slot latest attempt folder, a slot with none as not run (#105)', async (t) => {
  const dir = await tempDir(t, 'report-');
  await mkdir(join(dir, 'aaaaa1', 'screens'), { recursive: true });
  await writeJson(join(dir, 'aaaaa1', 'metrics.json'), RECORDS[0].metrics);
  await writeFile(join(dir, 'aaaaa1', 'screens', 'S1-1.png'), 'png');
  await writeReport(dir, endAttempt(startAttempt(manifestOf(1), runRef('a', 1), 'aaaaa1', NIGHT, false), 'aaaaa1', 'done'));
  const report = await readFile(join(dir, 'report.md'), 'utf8');
  for (const part of ['| A1 | `aaaaa1` | done, not evaluated |', '| B1 | – | not run |', '[S1-1.png](aaaaa1/screens/S1-1.png)']) assert.ok(report.includes(part), part);
});
