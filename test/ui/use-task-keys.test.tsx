import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { takeFeedbackRequest } from '@/components/ApprovalActions';
import { Flow } from '@/components/Flow';
import { letterOf } from '@/hooks/use-task-keys';
import { setLanguage } from '@/i18n';
import type { BaseOptions, Stage, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, movedWork, type WithWork } from '../fixtures/work';

const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'review', from: { board: ['In review'] } }];
const task = (id: string, stage: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '' }, stage, boardColumn: 'Ready', auto: true, ...extra,
});
const state = (tasks: WithWork[]): State => movedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const face = (title: string): HTMLElement => screen.getByText(title).closest('li')!;
const bases: BaseOptions = { hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] };
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(input).endsWith('/bases') ? bases : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
const posts = (): string[] => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url));
const since = '2026-09-25T10:00:00.000Z';

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('the arrows move the focus between tasks: up and down in a stage, left and right to the closest stage with a task (#585)', () => {
  render(<Flow state={state([task('1', 'dev'), task('2', 'dev'), task('3', 'review')])} />);
  face('#1 Task 1').focus();
  fireEvent.keyDown(face('#1 Task 1'), { key: 'ArrowDown' });
  expect(face('#2 Task 2')).toHaveFocus();
  fireEvent.keyDown(face('#2 Task 2'), { key: 'ArrowRight' });
  expect(face('#3 Task 3')).toHaveFocus();
  fireEvent.keyDown(face('#3 Task 3'), { key: 'ArrowLeft' }); // jsdom lays every task at 0: the first one is the nearest
  expect(face('#1 Task 1')).toHaveFocus();
  fireEvent.keyDown(face('#1 Task 1'), { key: 'ArrowUp' }); // the stage's top: the focus stays
  expect(face('#1 Task 1')).toHaveFocus();
});

test('Enter on a focused task opens its details as a click does (#585)', () => {
  const onOpen = vi.fn();
  render(<Flow state={state([task('1', 'dev')])} onOpen={onOpen} />);
  fireEvent.keyDown(face('#1 Task 1'), { key: 'Enter' });
  expect(onOpen).toHaveBeenCalledWith('I1');
});

test('F opens the details of a task awaiting approval and asks for its inline feedback box; with no approval it does nothing (#585)', () => {
  const onOpen = vi.fn();
  const { rerender } = render(<Flow state={state([task('1', 'dev')])} onOpen={onOpen} />);
  expect(fireEvent.keyDown(face('#1 Task 1'), { key: 'f' })).toBe(true); // no approval: no feedback, the key goes on
  expect([onOpen.mock.calls.length, takeFeedbackRequest('I1')]).toEqual([0, false]);
  rerender(<Flow state={state([task('1', 'dev', { approval: { since } })])} onOpen={onOpen} />);
  expect(fireEvent.keyDown(face('#1 Task 1'), { key: 'f' })).toBe(false);
  expect(onOpen).toHaveBeenCalledWith('I1');
  expect(takeFeedbackRequest('I1')).toBe(true);
});

test('A and F do nothing on a task awaiting approval while a session of it waits: the user answers there, and the keys go on (#829)', () => {
  const onOpen = vi.fn();
  const waiting: Worker = { id: 's1', status: 'waiting', activityId: activityIdOf('I1'), runId: 'W1', freeSession: true };
  render(<Flow state={{ ...state([task('1', 'dev', { approval: { since } })]), workers: [waiting] }} onOpen={onOpen} />);
  expect(fireEvent.keyDown(face('#1 Task 1'), { key: 'a' })).toBe(true);
  expect(fireEvent.keyDown(face('#1 Task 1'), { key: 'f' })).toBe(true);
  expect([onOpen.mock.calls.length, takeFeedbackRequest('I1'), posts()]).toEqual([0, false, []]);
});

test('F on a task in a manual gate with no session at all opens its details on the feedback box too (#685)', () => {
  const onOpen = vi.fn();
  const gated: State = { ...state([task('1', 'gate', { approval: { since } })]), stages: [{ name: 'gate', from: { board: ['Ready'] }, approval: true }] };
  render(<Flow state={gated} onOpen={onOpen} />);
  expect(fireEvent.keyDown(face('#1 Task 1'), { key: 'f' })).toBe(false);
  expect(onOpen).toHaveBeenCalledWith('I1');
  expect(takeFeedbackRequest('I1')).toBe(true);
});

test('a letter runs the task menu\'s own item: A approves, S flips auto, I opens run stages; a letter whose item is absent does nothing (#585)', async () => {
  const { rerender } = render(<Flow state={state([task('1', 'dev', { approval: { since } })])} />);
  fireEvent.keyDown(face('#1 Task 1'), { key: 'a' });
  fireEvent.keyDown(face('#1 Task 1'), { key: 's' });
  await waitFor(() => expect(posts()).toEqual(['/activities/a-I1/approve', '/tasks/I1/auto']));
  rerender(<Flow state={state([task('1', 'dev')])} />);
  expect(fireEvent.keyDown(face('#1 Task 1'), { key: 'a' })).toBe(true); // no approval: no item, the key goes on
  fireEvent.keyDown(face('#1 Task 1'), { key: 'i' });
  expect(await screen.findByRole('dialog', { name: 'Iniciar #1' })).toBeInTheDocument();
  expect(posts()).toEqual(['/activities/a-I1/approve', '/tasks/I1/auto']);
});

test('nothing on a key inside the task: its own button keeps it (#585)', () => {
  render(<Flow state={state([task('1', 'dev', { approval: { since } })])} />);
  fireEvent.keyDown(within(face('#1 Task 1')).getByRole('button', { name: 'aprovar' }), { key: 's' });
  expect(posts()).toEqual([]);
});

test('letterOf: a bare letter, and Shift+F10 for the menu off macOS only (#585)', () => {
  const press = (key: string, shiftKey = false) => ({ key, shiftKey, metaKey: false, ctrlKey: false, altKey: false });
  expect([letterOf(press('I'), true), letterOf(press('m'), false), letterOf(press('x'), false)]).toEqual(['runStages', 'taskMenu', undefined]);
  expect([letterOf(press('F10', true), false), letterOf(press('F10', true), true), letterOf(press('A', true), false)]).toEqual(['taskMenu', undefined, undefined]);
  expect(letterOf({ ...press('ш'), code: 'KeyI' }, true)).toBe('runStages'); // a Cyrillic layout: the key's position decides
});
