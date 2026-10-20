import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Flow } from '@/components/Flow';
import { StartedTaskContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { ActivityRecord, BaseOptions, Task, Worker, Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';

// Iniciar, Continuar and Reiniciar hand their task to the dock once the server took the start (#457): the dock brings it to the center when
// its run appears. A refused start or a cancelled dialog hands nothing.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity' }];
const task = (id: string, extra: Partial<WithWork> = {}): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...extra,
});
const empty: Worker = { id: 's1', status: 'empty' };
const state = (tasks: Task[], activityRecords: ActivityRecord[] = []): State =>
  withPointedWork({ signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [empty], stages, tasks, sourceOrder: [], localCount: 0, activities: [], activityRecords, usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, terminals: [] });
const sessions = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: '2026-09-25T10:00:00.000Z', stages: ['dev'], agent: 'claude' as const, lastUsedAt: '2026-09-25T10:00:00.000Z' }];

const WITH_WORKTREE: BaseOptions = { hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] };
const NO_WORKTREE: BaseOptions = { hasWorktree: false, defaultRef: 'origin/main', tasks: [], local: [], remote: [] };
const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let bases = WITH_WORKTREE;
let refuse = false;
let held: Promise<Response> | undefined; // a start that awaits its spawn and setup (#351)
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/bases')) return reply(bases);
  if (url.endsWith('/restart') && init?.method !== 'POST') return reply({ mode: 'reset', branch: 'hive/1-task-1', commits: 1 });
  if (held && url.endsWith('/start')) return held;
  return refuse ? reply({ error: 'não' }, 409) : reply({ ok: true });
});
const started = vi.fn();
const board = (tasks: Task[], records: ActivityRecord[] = []) => <StartedTaskContext.Provider value={started}><Flow state={state(tasks, records)} /></StartedTaskContext.Provider>;

beforeEach(() => {
  setLanguage('pt');
  bases = WITH_WORKTREE;
  refuse = false;
  held = undefined;
  started.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// The Start dialog's executar etapas, once the bases it read let it go
async function runStages(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const run = within(screen.getByRole('dialog', { name: 'Iniciar #3' })).getByRole('button', { name: /executar etapas/ });
  await waitFor(() => expect(run).toBeEnabled());
  await user.click(run);
}

test('the Start dialog\'s executar etapas hands the task over once the start is taken; a refused start keeps the dialog with the reason and hands nothing (#457)', async () => {
  const user = userEvent.setup();
  render(board([task('3')]));
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  await runStages(user);
  await waitFor(() => expect(started).toHaveBeenCalledWith('I3'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  refuse = true;
  started.mockClear();
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  await runStages(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('não');
  expect(screen.getByRole('dialog', { name: 'Iniciar #3' })).toBeInTheDocument();
  expect(started).not.toHaveBeenCalled();
});

test('cancelar in the Start dialog hands nothing over and posts nothing (#131, #457)', async () => {
  bases = NO_WORKTREE;
  const user = userEvent.setup();
  render(board([task('3')]));
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  await user.click(within(screen.getByRole('dialog', { name: 'Iniciar #3' })).getByRole('button', { name: 'cancelar' }));
  expect(started).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
});

test('continuar hands the task over once the server took it (#283, #457)', async () => {
  const user = userEvent.setup();
  render(board([task('1', { stopped: true })], [{ id: 'a-I1', taskIds: ['I1'], sessions }])); // #629: the session is the record's
  await user.click(screen.getByRole('button', { name: 'continuar' }));
  await waitFor(() => expect(started).toHaveBeenCalledWith('I1'));
});

test('a delete activity stage\'s start runs git, no run: it hands nothing (#210, #457)', async () => {
  const user = userEvent.setup();
  render(board([task('4', { stage: 'done', boardColumn: 'Done' })]));
  await user.click(screen.getByRole('button', { name: 'excluir' }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I4/start', expect.objectContaining({ method: 'POST' })));
  expect(started).not.toHaveBeenCalled();
});

test('the Start dialog stays open on the preparing view while its start sets up, though the task now runs; it closes once the setup leaves the state (#351, #390)', async () => {
  bases = NO_WORKTREE;
  let answer: (res: Response) => void = () => undefined;
  held = new Promise<Response>((resolve) => { answer = resolve; });
  const user = userEvent.setup();
  const { rerender } = render(board([task('3')]));
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  await runStages(user);
  const flow = (t: Task) => <StartedTaskContext.Provider value={started}><Flow state={{ ...state([t]), workers: [{ id: 's1', status: 'working', activityId: activityIdOf('I3'), runId: 'W1' }] }} /></StartedTaskContext.Provider>;
  rerender(flow(task('3', { workerId: 's1', setup: { consoleId: 'setup:I3', step: 'RUN pnpm install', rows: [] } })));
  expect(within(screen.getByRole('dialog', { name: 'Preparando a worktree de #3' })).getByRole('button', { name: 'preparando worktree…' })).toBeDisabled();
  answer(reply({ ok: true }));
  rerender(flow(task('3', { workerId: 's1' }))); // the setup ended with no lastSetup: it passed
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(started).toHaveBeenCalledWith('I3');
});
