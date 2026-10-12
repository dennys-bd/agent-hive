import { expect, test } from 'vitest';
import type { TaskActivity } from '@/lib/activities';
import { anchorOf, defaultSessionOf, EMPTY_REVIEW, reviewSessions } from '@/lib/review-view';
import type { Task, DiffLine } from '../../src/types';
import { taskPairOf } from '../fixtures/work';

const AT = (h: number): string => `2026-09-29T${String(h).padStart(2, '0')}:00:00.000Z`;
const task: Task = { item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true };
// The task's sessions, in its record (#629)
const sessions = [{ id: 'aaaaaaaa-1', startedAt: AT(1), stages: ['dev'], agent: 'claude' as const, lastUsedAt: AT(5) }, { id: 'bbbbbbbb-2', startedAt: AT(2), stages: ['dev'], agent: 'claude' as const, lastUsedAt: AT(3) }];
const activity: TaskActivity = {
  kind: 'task', task, runs: [], sessions: [{ run: { ptyId: 'W1', label: 'Claude', kind: 'session' }, status: 'working', session: sessions[1] }], status: 'working', worker: false,
  ...taskPairOf('I1', {}, { sessions }),
};

test('reviewSessions lists the task\'s sessions with the status of the worker running each; the default session is the saved one, else the most recent (#591)', () => {
  const sessions = reviewSessions(activity);
  expect(sessions.map((s) => [s.id, s.status])).toEqual([['aaaaaaaa-1', 'empty'], ['bbbbbbbb-2', 'working']]);
  expect(defaultSessionOf(EMPTY_REVIEW, sessions)).toBe('aaaaaaaa-1');
  expect(defaultSessionOf({ ...EMPTY_REVIEW, defaultSession: 'bbbbbbbb-2' }, sessions)).toBe('bbbbbbbb-2');
  expect(defaultSessionOf({ ...EMPTY_REVIEW, defaultSession: 'gone' }, sessions)).toBe('aaaaaaaa-1');
  expect(defaultSessionOf(EMPTY_REVIEW, [])).toBe('new');
});

test('anchorOf takes the new side unless every line is deleted, and the side\'s lines for the range and excerpt (#591)', () => {
  const lines: DiffLine[] = [{ kind: 'context', text: 'one', old: 1, new: 1 }, { kind: 'del', text: 'two', old: 2 }, { kind: 'add', text: '2', new: 2 }];
  expect(anchorOf('worktree', 'a.ts', lines)).toEqual({ scope: 'worktree', path: 'a.ts', side: 'new', start: 1, end: 2, excerpt: ['one', '2'] });
  expect(anchorOf('stage', 'a.ts', [lines[1]])).toEqual({ scope: 'stage', path: 'a.ts', side: 'old', start: 2, end: 2, excerpt: ['two'] });
  expect(anchorOf('stage', 'a.ts', [])).toBeUndefined();
});
