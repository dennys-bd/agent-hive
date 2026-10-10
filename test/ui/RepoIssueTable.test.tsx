import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RepoIssueTable } from '@/components/RepoIssueTable';
import { resetRepoIssues } from '@/hooks/use-repo-issues';
import { setLanguage } from '@/i18n';
import type { RepoIssue, RepoIssues, RepoSummary, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const SITE: RepoSummary = { repository: 'acme/site', url: 'https://github.com/acme/site', workspace: 'hive', openPrs: 1, openIssues: 2, closedIssues: 1, canPush: true, issuesEnabled: true };
const issue = (n: number, extra: Partial<RepoIssue> = {}): RepoIssue => ({
  number: n, title: `Issue ${n}`, url: `https://github.com/acme/site/issues/${n}`, labels: [], assignees: [], updatedAt: '2026-10-05T09:00:00Z', pullRequests: [], ...extra,
});
const OPEN: RepoIssues = {
  state: 'open', total: 2, truncated: false,
  issues: [issue(12, { labels: ['bug'], assignees: ['ana'] }), issue(30, { pullRequests: [{ number: 7, url: 'https://github.com/acme/site/pull/7', state: 'open', draft: true }] })],
};
const CLOSED: RepoIssues = { state: 'closed', total: 1, truncated: false, issues: [issue(4)] };
// #12 is a task of roadmap, sitting in dev
const TASK: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Issue 12', body: '', url: 'https://github.com/acme/site/issues/12', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks: [TASK], sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === '/repositories/acme/site/issues?state=open') return jsonRes(OPEN);
  if (url === '/repositories/acme/site/issues?state=closed') return jsonRes(CLOSED);
  return jsonRes(url === '/repositories' ? [SITE] : { ok: true });
};
const fetchMock = vi.fn(answer);
beforeEach(() => {
  setLanguage('pt');
  resetRepoIssues();
  fetchMock.mockReset();
  fetchMock.mockImplementation(answer);
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderTable = (onOpen?: (issue: RepoIssue) => void) => render(<RepoIssueTable state={state} summary={SITE} onTab={vi.fn()} onOpen={onOpen} />);
const rowOf = (text: string): HTMLElement => screen.getByText(text).closest('tr') as HTMLElement;
const numbers = (): (string | null)[] => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByText(/^#\d+$/)[0].textContent);

test('the list reads the open issues: GitHub\'s counts, each column, a task\'s stage or out of the flow, a draft PR, the footer (#757)', async () => {
  renderTable();
  expect(await screen.findByText('Issue 12')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/repositories/acme/site/issues?state=open');
  expect(screen.getByRole('radio', { name: 'abertas 2' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('radio', { name: 'fechadas 1' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['issue', 'labels', 'resp.', 'no fluxo', 'PR', 'atualizado']);
  const twelve = within(rowOf('Issue 12'));
  expect(twelve.getByText('bug')).toBeInTheDocument();
  expect(twelve.getByText('AN')).toHaveAttribute('title', 'ana');
  expect(twelve.getByText('dev')).toHaveClass('text-foreground');
  expect(within(rowOf('Issue 30')).getByText('fora do fluxo')).toHaveClass('text-muted-foreground');
  expect(within(rowOf('Issue 30')).getByText('#7 rascunho')).toHaveClass('text-muted-foreground');
  expect(screen.getByText('2 de 2')).toBeInTheDocument();
  expect(screen.getByText('↵ abre a issue')).toBeInTheDocument();
});

test('fechadas reads the closed issues; the search matches the title or #number, case-insensitive (#757)', async () => {
  const user = userEvent.setup();
  renderTable();
  await screen.findByText('Issue 12');
  const search = screen.getByRole('textbox', { name: 'buscar no repositório' });
  await user.type(search, 'ISSUE 3');
  expect(numbers()).toEqual(['#30']);
  await user.clear(search);
  await user.type(search, '#12');
  expect(numbers()).toEqual(['#12']);
  await user.clear(search);
  await user.click(screen.getByRole('radio', { name: 'fechadas 1' }));
  expect(await screen.findByText('Issue 4')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/repositories/acme/site/issues?state=closed');
});

test('lendo… shows only while nothing is cached: a list read before shows at once while it reads again (#757)', async () => {
  let settle: (res: Response) => void = () => undefined;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { settle = resolve; }));
  const { unmount } = renderTable();
  expect(screen.getByText('lendo…')).toBeInTheDocument();
  settle(jsonRes(OPEN));
  await screen.findByText('Issue 12');
  unmount();
  fetchMock.mockImplementationOnce(() => new Promise<Response>(() => undefined));
  renderTable();
  expect(screen.getByText('Issue 12')).toBeInTheDocument();
  expect(screen.queryByText('lendo…')).not.toBeInTheDocument();
});

test('a failed read keeps the list it had and toasts (#757)', async () => {
  const user = userEvent.setup();
  renderTable();
  await screen.findByText('Issue 12');
  fetchMock.mockImplementation(async () => jsonRes({ error: 'Bad credentials' }, 502));
  await user.click(screen.getByRole('button', { name: 'atualizar' }));
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Bad credentials'));
  expect(screen.getByText('Issue 12')).toBeInTheDocument();
});

test('a row click and ↵ on a focused row open its issue page; ⇧↵ opens it on GitHub (#757)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn<(issue: RepoIssue) => void>();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  renderTable(onOpen);
  await user.click(await screen.findByText('Issue 30'));
  rowOf('Issue 12').focus();
  await user.keyboard('{Enter}');
  expect(onOpen.mock.calls.map(([read]) => read.number)).toEqual([30, 12]);
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  expect(open).toHaveBeenCalledWith('https://github.com/acme/site/issues/12', '_blank', 'noreferrer');
  expect(onOpen).toHaveBeenCalledTimes(2);
  open.mockRestore();
});
