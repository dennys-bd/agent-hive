import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IssuePage } from '@/components/IssuePage';
import { setLanguage } from '@/i18n';
import { slot, WithSlot } from './detail-slot-harness';
import type { IssuePage as Issue, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const URL12 = 'https://github.com/acme/site/issues/12';
const ISSUE: Issue = {
  repository: 'acme/site', number: 12, title: 'Pager breaks', url: URL12, labels: ['bug'], assignees: ['ana'], updatedAt: '2026-10-05T09:00:00Z',
  body: 'The **pager** breaks', author: 'bia', createdAt: '2026-10-01T09:00:00Z',
  pullRequests: [{ number: 7, url: 'https://github.com/acme/site/pull/7', state: 'merged' }, { number: 9, url: 'https://github.com/acme/site/pull/9', state: 'open', checks: 'green' }],
  comments: [
    { author: 'ana', createdAt: '2026-10-02T09:00:00Z', body: 'first', url: `${URL12}#c1` },
    { author: 'bia', createdAt: '2026-10-03T09:00:00Z', body: 'second', url: `${URL12}#c2` },
  ],
  commentCount: 3,
};
const state = (tasks: Task[] = [], extra: Partial<State> = {}): State => ({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks, sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['site'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, ...extra,
});
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonRes(String(input) === '/repositories/acme/site/issues/12' ? ISSUE : { ok: true });
const fetchMock = vi.fn(answer);
beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockReset();
  fetchMock.mockImplementation(answer);
  vi.mocked(toast.error).mockClear();
  onOpenPr.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const onOpenPr = vi.fn();

// With `slotted`, beside the details panel's slot, as the dock mounts it (#64)
const renderPage = (tasks: Task[] = [], extra: Partial<State> = {}, slotted = false) => render(
  <IssuePage state={state(tasks, extra)} issue={{ repository: 'acme/site', number: 12 }} meta="acme/site" workspace="site" header={() => <div>HEADER</div>} onGoTo={vi.fn()} onOpenPr={onOpenPr} />,
  slotted ? { wrapper: WithSlot } : {},
);
const TASK12: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: '', url: URL12, source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };

test('the page reads its issue: the header it came from, the title, the meta, the PR line, the description and the comments, the rest on GitHub (#757)', async () => {
  renderPage();
  expect(await screen.findByRole('heading', { name: 'Pager breaks' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/repositories/acme/site/issues/12');
  expect(screen.getByText('HEADER')).toBeInTheDocument();
  expect(screen.getByText('acme/site · site')).toBeInTheDocument();
  expect(screen.getByText('⇅ 1/2 mergeados')).toBeInTheDocument(); // two closing PRs: the short summary
  expect(screen.getByText('pager')).toBeInTheDocument(); // the description's markdown, its bold included
  const comments = screen.getByRole('region', { name: 'comentários · 3' });
  expect(within(comments).getByText('first')).toBeInTheDocument();
  expect(within(comments).getByRole('link', { name: 'mais 1 no GitHub ›' })).toHaveAttribute('href', URL12);
});

test('abrir PR › opens the first open closing PR on GitHub; on a task, its own next PR (#757)', async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const { unmount } = renderPage();
  await user.click(await screen.findByRole('button', { name: 'abrir PR ›' }));
  expect(open).toHaveBeenCalledWith('https://github.com/acme/site/pull/9', '_blank', 'noreferrer');
  unmount();
  const task: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: '', url: URL12, source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
  renderPage([task], { activityRecords: [{ id: 'A1', taskIds: [task.item.itemId], sessions: [], prs: [{ url: 'https://github.com/acme/site/pull/31', state: 'open' }] }] });
  await user.click(await screen.findByRole('button', { name: 'abrir PR ›' }));
  expect(open).toHaveBeenLastCalledWith('https://github.com/acme/site/pull/31', '_blank', 'noreferrer'); // no dock here: GitHub
  expect(screen.getByText('#31')).toHaveClass('text-review');
  open.mockRestore();
});

test('a failed read with nothing shown is its message and a toast (#757)', async () => {
  fetchMock.mockImplementationOnce(async () => jsonRes({ error: 'Could not resolve to an Issue' }, 502));
  renderPage();
  expect(await screen.findByText('Could not resolve to an Issue')).toBeInTheDocument();
  expect(toast.error).toHaveBeenCalledWith('Could not resolve to an Issue');
});

test('an issue out of the flow: while it is read the slot shows the read line; then the issue\'s own title and its properties, no column of its own (#64)', async () => {
  let answerRead: (res: Response) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answerRead = resolve; }));
  renderPage([], {}, true);
  expect(slot().getByText('lendo…')).toBeInTheDocument();
  answerRead(jsonRes(ISSUE));
  expect(await slot().findByRole('heading', { name: 'Pager breaks' })).toHaveClass('text-[15px]');
  expect(slot().getByRole('button', { name: 'fluxo…' })).toBeInTheDocument();
  expect(slot().getByText('fluxo', { selector: 'dt' })).toBeInTheDocument();
  expect(slot().queryByRole('region', { name: 'atividade' })).not.toBeInTheDocument();
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
});

test('an issue of a task: the slot holds its properties with no title, which the panel draws as the task\'s (#64)', async () => {
  renderPage([TASK12], { activities: [{ id: 'A1', kind: 'task', workspace: 'site', branch: 'hive/12-pager' }], activityRecords: [{ id: 'A1', taskIds: [TASK12.item.itemId], sessions: [] }] }, true);
  expect(await slot().findByText('responsável', { selector: 'dt' })).toBeInTheDocument(); // the fields route answers none: today's rows
  expect(slot().queryByRole('button', { name: 'etapa' })).not.toBeInTheDocument();
  expect(slot().queryByRole('heading')).not.toBeInTheDocument();
  expect(slot().queryByText('hive/12-pager')).not.toBeInTheDocument();
});

test('a failed read shows its message in the slot as well (#64)', async () => {
  fetchMock.mockImplementationOnce(async () => jsonRes({ error: 'Could not resolve to an Issue' }, 502));
  renderPage([], {}, true);
  expect(await slot().findByText('Could not resolve to an Issue')).toBeInTheDocument();
});

test('an issue of a task with PRs: the slot lists them under the properties, and abrir hands the PR to the dashboard\'s opener (#65)', async () => {
  const user = userEvent.setup();
  const pr = 'https://github.com/acme/site/pull/31';
  renderPage([TASK12], { activityRecords: [{ id: 'A1', taskIds: [TASK12.item.itemId], sessions: [], prs: [{ url: pr, state: 'open' }] }] }, true);
  const prs = within(await slot().findByRole('region', { name: 'PRs' }));
  expect(prs.getByText('#31 aberto')).toBeInTheDocument();
  await user.click(prs.getByRole('button', { name: 'abrir' }));
  expect(onOpenPr).toHaveBeenCalledWith(pr);
});

test('a failed read of a task\'s issue still lists its PRs under the message: the details grid leaves them to the slot (#65)', async () => {
  fetchMock.mockImplementationOnce(async () => jsonRes({ error: 'Could not resolve to an Issue' }, 502));
  renderPage([TASK12], { activityRecords: [{ id: 'A1', taskIds: [TASK12.item.itemId], sessions: [], prs: [{ url: 'https://github.com/acme/site/pull/31', state: 'open' }] }] }, true);
  expect(await slot().findByText('Could not resolve to an Issue')).toBeInTheDocument();
  expect(within(slot().getByRole('region', { name: 'PRs' })).getByText('#31 aberto')).toBeInTheDocument();
});

test('an issue out of the flow lists no PRs in the slot (#65)', async () => {
  renderPage([], {}, true);
  expect(await slot().findByRole('button', { name: 'fluxo…' })).toBeInTheDocument();
  expect(slot().queryByRole('region', { name: 'PRs' })).not.toBeInTheDocument();
});
