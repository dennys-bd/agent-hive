import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApprovalActions } from '@/components/ApprovalActions';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { DecompositionPreview, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withWork } from '../fixtures/work';

// criar issues in place of aprovar (#865): the detail's button and the A key open the same confirm, and nothing is approved.
const since = '2026-10-09T10:00:00.000Z';
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'goal', boardColumn: 'Goals', auto: true };
const base: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'goal', from: { board: ['Goals'] }, prompt: '/hive:decomposition {url}', approval: true }],
  transitions: [{ from: 'goal', to: 'end', when: 'approved' }], tasks: [task], sourceOrder: [], localCount: 0, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'],
  sourceWorkspaces: {}, commands: {}, syncs: { board: {} }, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT,
  approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const pending = (): State => withWork(base, 'I1', { approval: { since } }, { result: { decomposition: 'decomposition.md' } });
const PREVIEW: DecompositionPreview = { title: 'Task 1', issues: 2, blockers: 0, suggestions: 0, problems: [], repository: 'acme/site', sources: [{ name: 'board', statuses: ['Goals'], column: 'Goals' }] };
const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
  new Response(JSON.stringify(init?.method === 'POST' ? { ok: true } : PREVIEW), { status: 200, headers: { 'content-type': 'application/json' } }));
const posts = (): string[] => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url));

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('A on a task whose decomposition is not on GitHub opens the create issues dialog and approves nothing (#865)', async () => {
  render(<Flow state={pending()} />);
  fireEvent.keyDown(screen.getByText('#1 Task 1').closest('li')!, { key: 'a' });
  expect(await screen.findByRole('dialog', { name: 'Criar issues' })).toBeInTheDocument();
  expect(posts()).toEqual([]);
});

test('the status box shows criar issues in place of aprovar and opens the same dialog; without it, aprovar (#865)', async () => {
  const user = userEvent.setup();
  const activity = { id: 'a-I1', approval: { since } };
  const { unmount } = render(<ApprovalActions task={task} activity={activity} createsIssues />);
  expect(screen.queryByRole('button', { name: 'aprovar' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'criar issues' }));
  expect(await screen.findByRole('dialog', { name: 'Criar issues' })).toBeInTheDocument();
  unmount();
  render(<ApprovalActions task={task} activity={activity} />);
  expect(screen.getByRole('button', { name: 'aprovar' })).toBeInTheDocument();
});
