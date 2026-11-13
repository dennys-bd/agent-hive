import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApprovalActions } from '@/components/ApprovalActions';
import { DecompositionHost } from '@/components/DecompositionDialog';
import { StatusBox } from '@/components/DetailSections';
import { Flow } from '@/components/Flow';
import { CreateTargetsContext, HIVE_ONLY } from '@/lib/create-targets';
import { closeDecomposition, useDecompositionWrite } from '@/hooks/use-decomposition-write';
import { setLanguage } from '@/i18n';
import type { DecompositionPreview, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';
import { firstFlow } from './flow-of.js';

// criar issues in place of aprovar (#865): the detail's button and the A key open the same confirm, and nothing is approved.
const since = '2026-10-09T10:00:00.000Z';
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'goal', boardColumn: 'Goals', auto: true };
const base: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed([{ name: 'goal', from: { board: ['Goals'] }, prompt: '/hive:decomposition {url}', approval: true }], [{ from: 'goal', to: 'end', when: 'approved' }]), tasks: [task], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: { board: {} }, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT,
  approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const pending = (syncs: State['syncs'] = { board: {} }): State => withWork({ ...base, syncs }, 'I1', { approval: { since } }, { result: { decomposition: 'decomposition.md' } });
const PREVIEW: DecompositionPreview = { title: 'Task 1', issues: 2, blockers: 0, suggestions: 0, problems: [], warnings: [], repository: 'acme/site', sources: [{ name: 'board', statuses: ['Goals'], column: 'Goals' }] };
const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
  new Response(JSON.stringify(init?.method === 'POST' ? { ok: true } : PREVIEW), { status: 200, headers: { 'content-type': 'application/json' } }));
const posts = (): string[] => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url));

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('A on a task whose decomposition is not on GitHub opens the host\'s create issues dialog and approves nothing (#865, #781)', async () => {
  render(<><Flow state={pending()} flow={firstFlow(pending())} /><DecompositionHost /></>);
  fireEvent.keyDown(screen.getByText('#1 Task 1').closest('li')!, { key: 'a' });
  expect(await screen.findByRole('dialog', { name: 'Criar issues' })).toBeInTheDocument();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(posts()).toEqual([]);
});

test('the status box shows criar issues in place of aprovar and opens the host\'s dialog; without it, aprovar (#865, #781)', async () => {
  const user = userEvent.setup();
  const activity = { id: 'a-I1', approval: { since } };
  const { unmount } = render(<><ApprovalActions task={task} activity={activity} createsIssues /><DecompositionHost /></>);
  expect(screen.queryByRole('button', { name: 'aprovar' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'criar issues' }));
  expect(await screen.findByRole('dialog', { name: 'Criar issues' })).toBeInTheDocument();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  unmount();
  render(<ApprovalActions task={task} activity={activity} />);
  expect(screen.getByRole('button', { name: 'aprovar' })).toBeInTheDocument();
});

test('neither mount point renders a dialog of its own: it opens the store\'s entry with the task\'s ref, and only the host shows it (#781)', async () => {
  const user = userEvent.setup();
  render(<ApprovalActions task={task} activity={{ id: 'a-I1', approval: { since } }} createsIssues />);
  await user.click(screen.getByRole('button', { name: 'criar issues' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(renderHook(() => useDecompositionWrite('a-I1')).result.current).toMatchObject({ isOpen: true, ref: '#1' });
});

test('A on a pending decomposition in a Comb with no GitHub source and the hive on opens the dialog and approves nothing; with the hive off it approves (#784)', async () => {
  const { unmount } = render(<><Flow state={pending({})} flow={firstFlow(pending({}))} /><DecompositionHost /></>);
  fireEvent.keyDown(screen.getByText('#1 Task 1').closest('li')!, { key: 'a' });
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(posts()).toEqual([]);
  unmount();
  act(() => closeDecomposition('a-I1')); // the store outlives the render
  render(<CreateTargetsContext.Provider value={{ ...HIVE_ONLY, hiveSource: false }}><Flow state={pending({})} flow={firstFlow(pending({}))} /><DecompositionHost /></CreateTargetsContext.Provider>);
  fireEvent.keyDown(screen.getByText('#1 Task 1').closest('li')!, { key: 'a' });
  await waitFor(() => expect(posts()).toEqual([expect.stringMatching(/\/approve$/)]));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('the status box reads criar tarefas in place of aprovar for a hive goal with the hive on, criar issues for a GitHub goal with a sync, aprovar with the hive off and no sync (#784)', () => {
  const { rerender } = render(<StatusBox task={task} state={pending({})} isActivity={false} />);
  expect(screen.getByRole('button', { name: 'criar tarefas' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'aprovar' })).toBeNull();
  const github: Task = { ...task, item: { ...task.item, source: 'board', url: 'https://github.com/acme/site/issues/1' } };
  rerender(<StatusBox task={github} state={{ ...pending(), tasks: [github] }} isActivity={false} />);
  expect(screen.getByRole('button', { name: 'criar issues' })).toBeInTheDocument();
  rerender(<CreateTargetsContext.Provider value={{ ...HIVE_ONLY, hiveSource: false }}><StatusBox task={task} state={pending({})} isActivity={false} /></CreateTargetsContext.Provider>);
  expect(screen.getByRole('button', { name: 'aprovar' })).toBeInTheDocument();
});
