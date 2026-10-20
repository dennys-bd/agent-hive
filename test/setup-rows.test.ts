import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedRows, failedRows, plannedRows, preparedRows, shownBase, startedRows, worktreeRows } from '../src/setup-rows.js';

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
