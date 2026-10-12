import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AWAIT_DIRECTORY_MS, useAwaitedActivity } from '@/components/CopySession';
import type { Task, SessionRef, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { type WithWork, movedWork } from '../fixtures/work';

// nova atividade… (#587): the copy waits for the new activity's directory, and gives up when the activity cannot get one
const S = 'a1b2c3d4-0000-4000-8000-000000000001';
const FROM: SessionRef = { activityId: 'a-I11', sessionId: S }; // #629: the session's record
const task = (itemId: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId, id: itemId, title: itemId, body: '', url: '' }, stage: 'dev', boardColumn: 'dev', auto: true, workspace: 'hive', ...extra,
});
const source = task('I11', { worktree: '/w/11' });
const stateWith = (awaited?: Task): State => movedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [], localCount: 0, activities: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], sourceOrder: [],
  activityRecords: [{ id: 'a-I11', taskIds: ['I11'], sessions: [{ id: S, startedAt: '', stages: ['dev'], agent: 'claude', lastUsedAt: '' }] }], // #629: the source's session is its record's
  tasks: awaited ? [source, awaited] : [source], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const READY = task('N1', { worktree: '/w/n1' });

function awaitN1(initial: State) {
  const onReady = vi.fn();
  const hook = renderHook(({ state }) => useAwaitedActivity(state, onReady), { initialProps: { state: initial } });
  act(() => hook.result.current.await({ from: FROM, taskId: 'N1' }));
  return { onReady, hook };
}

afterEach(() => vi.useRealTimers());

test('the copy opens once the new activity has its directory', () => {
  const { onReady, hook } = awaitN1(stateWith());
  hook.rerender({ state: stateWith(task('N1')) });
  expect(onReady).not.toHaveBeenCalled();
  hook.rerender({ state: stateWith(READY) });
  expect(onReady).toHaveBeenCalledWith({ from: FROM, to: { activityId: 'a-N1' } }); // #629: the new task's live activity
});

test.each([['an error', { error: 'pty: no' }], ['gone missing', { missing: true as const }], ['leaving', { leaving: true as const }]])('the wait ends when the activity gets %s: a directory later opens nothing', (_name, extra) => {
  const { onReady, hook } = awaitN1(stateWith(task('N1')));
  hook.rerender({ state: stateWith(task('N1', extra)) });
  hook.rerender({ state: stateWith(READY) });
  expect(onReady).not.toHaveBeenCalled();
});

test('the wait ends when the user opens another copy or Start dialog', () => {
  const { onReady, hook } = awaitN1(stateWith(task('N1')));
  act(() => hook.result.current.cancel());
  hook.rerender({ state: stateWith(READY) });
  expect(onReady).not.toHaveBeenCalled();
});

test('the wait gives up after AWAIT_DIRECTORY_MS', () => {
  vi.useFakeTimers();
  const { onReady, hook } = awaitN1(stateWith(task('N1')));
  act(() => { vi.advanceTimersByTime(AWAIT_DIRECTORY_MS); });
  hook.rerender({ state: stateWith(READY) });
  expect(onReady).not.toHaveBeenCalled();
});
