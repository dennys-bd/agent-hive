import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StatusBox } from '@/components/DetailSections';
import { StartedTaskContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Stage, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, bareTask, movedWork, type WithWork } from '../fixtures/work';

const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }];
const sessions = [{ id: SESSION, startedAt: '2026-09-25T10:00:00.000Z', stages: ['dev'], lastUsedAt: '2026-09-25T10:00:00.000Z' }];
// A stage run stopped five minutes (and a few seconds) ago, its start recorded: continuar and reiniciar etapa… both answer. The marks are its
// activity's, the sessions its record's (#629)
const stopped: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true,
  stopped: true, stoppedAt: new Date(Date.now() - 5 * 60_000 - 10_000).toISOString(), stageStart: { stage: 'dev', commit: 'a1b2c3d' },
};
const ACTIVITY = activityIdOf('I1');
const state = (task: WithWork, extra: Partial<State> = {}): State => movedWork<State>({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages, tasks: [task], sourceOrder: [], localCount: 0, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  activities: [], activityRecords: [{ id: ACTIVITY, taskIds: ['I1'], sessions }],
  sourceWorkspaces: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, ...extra,
});
const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
  (String(input).endsWith('/restart') && init?.method !== 'POST' ? reply({ mode: 'reset', branch: 'hive/1-task-1', commits: 1, files: 2 }) : reply({ ok: true })));
const started = vi.fn();
const box = (task: WithWork, s: State = state(task)) =>
  render(<StartedTaskContext.Provider value={started}><StatusBox task={bareTask(task)} state={s} isActivity={false} /></StartedTaskContext.Provider>);
beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); started.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('a stopped task\'s status box reads the time since the stop and offers continuar, which posts continue and hands the task over, and reiniciar etapa…, which opens the restart dialog (#580)', async () => {
  const user = userEvent.setup();
  box(stopped);
  const status = screen.getByRole('region', { name: 'parada' });
  expect(within(status).getByText('etapa dev · 5m')).toBeInTheDocument();
  await user.click(within(status).getByRole('button', { name: 'continuar' }));
  expect(fetchMock).toHaveBeenLastCalledWith(`/activities/${ACTIVITY}/continue`, expect.objectContaining({ method: 'POST' }));
  await waitFor(() => expect(started).toHaveBeenCalledWith('I1'));
  await user.click(within(status).getByRole('button', { name: 'reiniciar etapa…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reiniciar etapa dev' });
  expect(await within(dialog).findByText('1 commit · 2 arquivos · sessão aaaaaaaa')).toBeInTheDocument();
});

test('only continuar without restart offered; neither with the user\'s session on the stage\'s session or a terminal on the task; no time without stoppedAt; no continuar after a free run in the stage (#580, #812)', () => {
  const { stageStart: _start, ...unrecorded } = stopped;
  const { stoppedAt: _at, ...older } = stopped; // stopped before stoppedAt existed
  const own: Worker = { id: 'm1', runId: 'run-1', status: 'working', activityId: ACTIVITY, sessionId: SESSION, freeSession: true };
  const terminal = { terminalId: 'b0000000-0000-4000-8000-000000000002', activityId: ACTIVITY, startedAt: '2026-09-25T10:00:00.000Z', cwd: '/repo' };
  const cases: [WithWork, State, string[]][] = [
    [unrecorded, state(unrecorded), ['continuar']],
    [stopped, state(stopped, { workers: [own] }), []],
    [stopped, state(stopped, { terminals: [terminal] }), []],
    [{ ...stopped, freeSessionStage: 'dev' }, state({ ...stopped, freeSessionStage: 'dev' }), ['reiniciar etapa…']], // #812: no continuar after a free run
    [{ ...unrecorded, freeSessionStage: 'dev' }, state({ ...unrecorded, freeSessionStage: 'dev' }), []],
  ];
  for (const [task, s, expected] of cases) {
    const { unmount } = box(task, s);
    expect(screen.queryAllByRole('button').map((b) => b.textContent)).toEqual(expected);
    unmount();
  }
  box(older);
  expect(screen.getByText('etapa dev')).toBeInTheDocument();
});

test('a task awaiting approval offers aprovar and the feedback box only while no session of it is live: not working, waiting nor backing off; with an open PR (review) and nothing live, still (#772, #829)', () => {
  const awaiting: WithWork = { ...stopped, stopped: undefined, stoppedAt: undefined, approval: { since: '2026-09-25T10:00:00.000Z' } };
  const own = (status: Worker['status']): Worker => ({ id: 'm1', runId: 'run-1', status, activityId: ACTIVITY, sessionId: SESSION, freeSession: true });
  const reviewed = [{ id: ACTIVITY, taskIds: ['I1'], sessions, prs: [{ url: 'https://github.com/acme/r/pull/1', state: 'open' as const }] }];
  const cases: [State, boolean][] = [
    [state(awaiting), true],
    [state(awaiting, { workers: [own('waiting')] }), false],
    [state(awaiting, { workers: [own('working')] }), false],
    [state(awaiting, { workers: [own('backoff')] }), false],
    [state(awaiting, { activityRecords: reviewed }), true],
  ];
  for (const [s, offered] of cases) {
    const { unmount } = box(awaiting, s);
    expect(screen.queryByRole('button', { name: 'aprovar' }) !== null).toBe(offered);
    expect(screen.queryByRole('textbox') !== null).toBe(offered);
    unmount();
  }
});
