import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { TaskActivity } from '@/lib/activities';
import { rememberFocus, useFocusedSession, useRememberFocus } from '@/lib/session-focus';
import type { LiveRun } from '../../src/task-runs';
import type { Session, Task } from '../../src/types';
import { taskPairOf } from '../fixtures/work';

const task: Task = { item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true };
const SESSION: Session = { id: 'aaaaaaaa-1', startedAt: 'T', stages: ['dev'], agent: 'claude', lastUsedAt: 'T' };
const AGENT: LiveRun = { ptyId: 'W1', label: 'Claude', kind: 'session' };
const TERMINAL: LiveRun = { ptyId: 'T1', label: 'Terminal', kind: 'terminal' };
const activity: TaskActivity = {
  kind: 'task', ...taskPairOf('I1', {}, { sessions: [SESSION] }), task, runs: [AGENT, TERMINAL],
  sessions: [{ run: AGENT, status: 'working', session: SESSION }], status: 'working', worker: true,
};

test('the session of the run in focus is remembered per activity; a terminal, no run in focus or another activity leave it (#113)', () => {
  const { result, rerender } = renderHook(({ run }: { run?: string }) => {
    useRememberFocus(activity, run);
    return [useFocusedSession('I1'), useFocusedSession('I2')];
  }, { initialProps: {} as { run?: string } });
  expect(result.current).toEqual([undefined, undefined]);
  rerender({ run: 'W1' });
  expect(result.current).toEqual([SESSION.id, undefined]);
  rerender({ run: 'T1' }); // a terminal has no session
  rerender({}); // the design tab itself is shown: shownRun is empty
  expect(result.current).toEqual([SESSION.id, undefined]);
  act(() => rememberFocus('I1', 'bbbbbbbb-2'));
  expect(result.current[0]).toBe('bbbbbbbb-2');
});
