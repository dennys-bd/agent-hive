import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedRows, failedRows, nestedEndedRows, nestedFailedRows, nestedStartedRows, plannedRows, preparedRows, shownBase, startedRows, worktreeRows } from '../src/setup-rows.js';

// The rows of a worktree preparation as the Start dialog shows them (#390).
const AT = '2026-10-19T10:00:00.000Z';
const LATER = Date.parse(AT) + 1500;
const prepared = () => preparedRows(worktreeRows('hive/1-task-1', 'origin/main', AT), LATER);

test('the worktree and branch rows run from the mark and are done once the worktree is made: the worktree with its time, the branch with none (#390)', () => {
  assert.deepEqual(worktreeRows('hive/1-task-1', 'origin/main', AT), [
    { kind: 'worktree', status: 'running', startedAt: AT }, { kind: 'branch', status: 'running', startedAt: AT, branch: 'hive/1-task-1', base: 'origin/main' },
  ]);
  assert.deepEqual(prepared(), [{ kind: 'worktree', status: 'done', durationMs: 1500 }, { kind: 'branch', status: 'done', branch: 'hive/1-task-1', base: 'origin/main' }]);
  assert.equal(preparedRows(prepared(), LATER).length, 2);
});

test('the plan lists a row per expanded step, a RUN by its command and anything else as describeStep writes it; skipped steps are done with no time; the next queued one starts and its report ends it (#390)', () => {
  const planned = plannedRows(prepared(), ['COPY .env', 'RUN pnpm install', 'RUN pnpm build'], 1);
  assert.deepEqual(planned.slice(2), [
    { kind: 'step', status: 'done', header: 'COPY .env', label: 'COPY .env' },
    { kind: 'step', status: 'queued', header: 'RUN pnpm install', label: 'pnpm install' },
    { kind: 'step', status: 'queued', header: 'RUN pnpm build', label: 'pnpm build' },
  ]);
  const running = startedRows(planned, AT);
  assert.deepEqual(running[3], { kind: 'step', status: 'running', header: 'RUN pnpm install', label: 'pnpm install', startedAt: AT });
  const failed = endedRows(running, { kind: 'RUN', index: 1, durationMs: 40, ok: false, code: 1 });
  assert.deepEqual(failed[3], { kind: 'step', status: 'failed', header: 'RUN pnpm install', label: 'pnpm install', durationMs: 40, code: '1' });
  assert.equal(failedRows(failed, LATER), failed, 'already failed: the same list');
});

test('a failure no row was running for fails the next queued row, else the last; running rows fail with their time (#390)', () => {
  assert.deepEqual(failedRows(plannedRows(prepared(), ['RUN a', 'RUN b'], 1), LATER).map((r) => r.status), ['done', 'done', 'done', 'failed'], 'a stop between a and b');
  assert.deepEqual(failedRows(prepared(), LATER).map((r) => r.status), ['done', 'failed'], 'a LOAD that does not read: no step row');
  assert.deepEqual(failedRows(worktreeRows('b', 'origin/main', AT), LATER), [
    { kind: 'worktree', status: 'failed', durationMs: 1500 }, { kind: 'branch', status: 'failed', branch: 'b', base: 'origin/main' },
  ], 'a git refusal: both rows, no code');
});

test('shownBase: the start\'s chosen base, else the workspace\'s base branch on its remote, else the remote (#390)', () => {
  assert.equal(shownBase('hive/11-parent', { remote: 'origin', branch: 'main' }), 'hive/11-parent');
  assert.equal(shownBase(undefined, { remote: 'upstream', branch: 'dev' }), 'upstream/dev');
  assert.equal(shownBase(undefined, { remote: 'origin' }), 'origin');
});

const NESTED = () => worktreeRows('hive/1-task-1', 'origin/main', AT, ['docs', 'wiki']);

test('the nested rows queue after the branch row, one per path with its header; prepared ends only the worktree and branch rows, the plan keeps them before the steps (#450)', () => {
  assert.deepEqual(NESTED().slice(2), [
    { kind: 'nested', status: 'queued', label: 'docs', header: 'nested docs' }, { kind: 'nested', status: 'queued', label: 'wiki', header: 'nested wiki' },
  ]);
  const ready = preparedRows(NESTED(), LATER);
  assert.deepEqual(ready.map((r) => r.status), ['done', 'done', 'queued', 'queued']);
  const running = nestedStartedRows(ready, 'docs', AT);
  assert.equal(preparedRows(running, LATER), running, 'a running nested row is not the worktree\'s to end');
  assert.deepEqual(plannedRows(running, ['RUN a'], 0).map((r) => r.kind), ['worktree', 'branch', 'nested', 'nested', 'step']);
  assert.deepEqual(worktreeRows('b', 'origin/main', AT), worktreeRows('b', 'origin/main', AT, []), 'no nested repo: #390\'s two rows');
});

test('a nested row starts, ends from a base or reused with the task\'s branch, and fails, by its path; a path with no row is the same list; a run\'s failure fails a running one (#450)', () => {
  const rows = preparedRows(NESTED(), LATER);
  const docs = nestedStartedRows(rows, 'docs', AT);
  assert.deepEqual(docs[2], { kind: 'nested', status: 'running', label: 'docs', header: 'nested docs', startedAt: AT });
  assert.deepEqual(nestedEndedRows(docs, 'docs', { base: 'origin/main' }, 'hive/1-task-1', LATER)[2],
    { kind: 'nested', status: 'done', label: 'docs', header: 'nested docs', durationMs: 1500, branch: 'hive/1-task-1', base: 'origin/main' });
  assert.deepEqual(nestedEndedRows(docs, 'docs', { reused: true }, 'hive/1-task-1', LATER)[2],
    { kind: 'nested', status: 'done', label: 'docs', header: 'nested docs', durationMs: 1500, branch: 'hive/1-task-1' });
  assert.deepEqual(nestedFailedRows(rows, 'wiki', LATER)[3], { kind: 'nested', status: 'failed', label: 'wiki', header: 'nested wiki' }, 'refused before it started: no time');
  assert.equal(nestedStartedRows(rows, 'ee', AT), rows);
  assert.deepEqual(failedRows(docs, LATER).map((r) => r.status), ['done', 'done', 'failed', 'queued']);
  assert.equal(failedRows(docs, LATER)[2]?.durationMs, 1500);
});
