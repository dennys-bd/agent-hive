import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { DiffView } from '@/components/DiffView';
import { ReviewContext, type ReviewPane } from '@/components/review-context';
import { ReviewSurfaceContext } from '@/components/review-surface';
import { sessionsSurface } from '@/components/sessions-surface';
import type { DiffTab } from '@/components/terminal-tabs';
import type { TaskActivity } from '@/lib/activities';
import type { Session, TaskDiff, DiffScope, FileDiff, ReviewFile } from '../../src/types';
import { jsonResponse } from '../fakes';
import { bareTask, liveOf, taskPairOf, type WithWork } from '../fixtures/work';

export const task: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true,
  worktree: '/wt/hive-1-task-1', branch: 'hive-1-task-1',
};
export const FILES: FileDiff[] = [
  { path: 'src/a.ts', status: 'modified', hash: 'a'.repeat(64), hunks: [{ header: '@@ -1,2 +1,2 @@ intro', lines: [
    { kind: 'context', text: 'one', old: 1, new: 1 }, { kind: 'del', text: 'two', old: 2 }, { kind: 'add', text: '2', new: 2 },
  ] }] },
  { path: 'b.ts', oldPath: 'a-old.ts', status: 'renamed', hash: 'b'.repeat(64), hunks: [] },
  { path: 'img/logo.png', status: 'added', binary: true, hash: 'c'.repeat(64), hunks: [] },
];
export const H = (n: number): string => FILES[n].hash;
export const LABEL = '#1 Task 1 · diff da worktree';
export interface Call { method: string; url: string; body: unknown }
export interface FakeHive { calls: Call[]; diff: TaskDiff; diffError?: string; answers: Record<string, unknown>; review: ReviewFile }

/** A fetch that answers the diff route, records every call, and answers `answers[method url]` (else ok) to the rest. */
export function fakeHive(): FakeHive {
  const hive: FakeHive = { calls: [], diff: { scope: 'worktree', base: 'a1b2c3d (origin/main)', files: FILES }, answers: {}, review: { reviewed: [], drafts: [], threads: [] } };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    hive.calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (url === '/tasks/I1/review') return jsonResponse(hive.review);
    if (url.startsWith('/activities/a-I1/diff')) return hive.diffError === undefined ? jsonResponse(hive.diff) : jsonResponse({ error: hive.diffError }, 413);
    return jsonResponse(hive.answers[`${method} ${url}`] ?? { ok: true });
  }));
  return hive;
}
export const callsTo = (hive: FakeHive, method: string, url: string): Call[] => hive.calls.filter((c) => c.method === method && c.url === url);
// #629: the view model carries the task as stored and its live activity, with the worktree and the branch
export const activityOf = (extra: Partial<Omit<TaskActivity, 'kind'>> = {}): TaskActivity => ({ kind: 'task', ...taskPairOf('I1', liveOf(task)), task: bareTask(task), runs: [], sessions: [], status: 'empty', worker: false, ...extra });
export function renderPane(activity: TaskActivity = activityOf(), scope: DiffScope = 'worktree', active = true) {
  const tab: DiffTab = { kind: 'diff', task: 'I1', scope, title: '#1 Task 1' };
  const onScope = vi.fn();
  const view = render(<DiffView tab={tab} label={LABEL} active={active} activity={activity} onScope={onScope} />);
  return { ...view, onScope, tab };
}
export const SESSION = 'abcdef12-0000-4000-8000-000000000000';
export const SESSIONS: Session[] = [{ id: SESSION, startedAt: 'T', stages: ['dev'], agent: 'claude' as const, lastUsedAt: 'T' }];
/** The task's activity with its session kept in its record (#629). */
export const withSessions = (): Partial<Omit<TaskActivity, 'kind'>> => ({ records: [{ id: 'a-I1', taskIds: ['I1'], sessions: SESSIONS }] });

/** Holds every request to `method url` until release() (#591): what a slow delivery looks like to the pane. */
export function holdRoute(method: string, url: string): { count(): number; release(): void } {
  const inner = globalThis.fetch;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === method && String(input) === url) {
      count += 1;
      await gate;
    }
    return inner(input, init);
  }));
  return { count: () => count, release: () => release() };
}

/** A file or a box as the diff pane renders it (#592): the pane in its context, and the sessions surface built from it. openFile: abrir
 * arquivo's (#717). */
export function inSessionsPane(pane: ReviewPane, ui: ReactNode, openFile: (path: string) => void = vi.fn()): ReactElement {
  const surface = sessionsSurface(pane, { openFile, reviewed: () => false, mark: vi.fn(), submit: { failed: [], unsaved: [], canSubmit: false, submit: vi.fn() } });
  return <ReviewContext.Provider value={pane}><ReviewSurfaceContext.Provider value={surface}>{ui}</ReviewSurfaceContext.Provider></ReviewContext.Provider>;
}
