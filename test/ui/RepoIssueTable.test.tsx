import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RepoIssueTable } from '@/components/RepoIssueTable';
import { resetRepoIssues } from '@/hooks/use-repo-issues';
import { setLanguage } from '@/i18n';
import { readView } from '@/lib/view-state';
import type { RepoIssue, RepoIssues, RepoSummary, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const SITE: RepoSummary = { repository: 'acme/site', url: 'https://github.com/acme/site', workspace: 'hive', openPrs: 1, openIssues: 2, closedIssues: 1, canPush: true, issuesEnabled: true, syncedAt: '2026-10-05T09:00:00Z' };
const issue = (n: number, extra: Partial<RepoIssue> = {}): RepoIssue => ({
  number: n, title: `Issue ${n}`, url: `https://github.com/acme/site/issues/${n}`, labels: [], assignees: [], updatedAt: '2026-10-05T09:00:00Z', pullRequests: [], ...extra,
});
const OPEN: RepoIssues = {
  state: 'open', total: 2, truncated: false, syncedAt: '2026-10-05T09:00:00Z',
  issues: [issue(12, { labels: ['bug'], assignees: ['ana'] }), issue(30, { pullRequests: [{ number: 7, url: 'https://github.com/acme/site/pull/7', state: 'open', draft: true }] })],
};
const CLOSED: RepoIssues = { state: 'closed', total: 1, truncated: false, syncedAt: '2026-10-05T09:00:00Z', issues: [issue(4)] };
const OTHER: RepoSummary = { ...SITE, repository: 'acme/other', url: 'https://github.com/acme/other' };
const EMPTY: RepoIssues = { state: 'open', total: 0, truncated: false, syncedAt: '2026-10-05T09:00:00Z', issues: [] };
const NEW: RepoSummary = { ...SITE, repository: 'acme/new', url: 'https://github.com/acme/new' };
const UNSYNCED: RepoIssues = { state: 'open', total: 0, truncated: false, syncedAt: null, issues: [] };
// #12 is a task of roadmap, sitting in dev
const TASK: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Issue 12', body: '', url: 'https://github.com/acme/site/issues/12', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks: [TASK], sourceOrder: [], localCount: 0, benchmark: { experiments: [] },
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === '/repositories/acme/site/issues?state=open') return jsonRes(OPEN);
  if (url === '/repositories/acme/site/issues?state=closed') return jsonRes(CLOSED);
  if (url === '/repositories/acme/other/issues?state=open') return jsonRes(EMPTY);
  if (url === '/repositories/acme/new/issues?state=open') return jsonRes(UNSYNCED);
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
  expect(screen.queryByRole('status', { name: 'sincronizando…' })).not.toBeInTheDocument(); // before any answer, never the syncing mark
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

const tracks = (): string[] => screen.getAllByRole('row')[0].style.gridTemplateColumns.split(' ');
const handle = (name: string): HTMLElement => screen.getByRole('separator', { name: `redimensionar ${name}` });
const lines = (): string[] => [...screen.getByTestId('column-dividers').children].map((line) => (line as HTMLElement).style.right);

test('each column but the issue has a handle on its left edge, a divider at the same offset; a drag saves the width for the repository\'s issues, a remount reads it, another repository keeps the defaults (#59)', async () => {
  const { unmount } = renderTable();
  await screen.findByText('Issue 12');
  expect(tracks()).toEqual(['minmax(160px,1fr)', '132px', '40px', '112px', '120px', '80px']);
  expect(screen.getAllByRole('separator').map((h) => h.getAttribute('aria-label'))).toEqual([
    'redimensionar labels', 'redimensionar resp.', 'redimensionar no fluxo', 'redimensionar PR', 'redimensionar atualizado',
  ]);
  expect(handle('labels').style.right).toBe('550px'); // 18 + 4×12 + 484
  expect(lines()).toEqual(['550px', '406px', '354px', '230px', '98px']);
  const scroller = screen.getByRole('table').parentElement?.parentElement;
  expect(scroller).toHaveClass('[scrollbar-width:none]');
  expect(scroller?.parentElement).toHaveClass('flex-1');
  fireEvent.pointerDown(handle('labels'), { pointerId: 1, clientX: 100 });
  fireEvent.pointerMove(handle('labels'), { pointerId: 1, clientX: 130 });
  fireEvent.pointerUp(handle('labels'), { pointerId: 1, clientX: 130 });
  expect(tracks()[1]).toBe('102px');
  expect(rowOf('Issue 12').style.gridTemplateColumns).toBe(tracks().join(' '));
  expect(readView('repoLists')).toEqual({ 'acme/site': { issues: { labels: 102 } } });
  unmount();
  const again = renderTable();
  await screen.findByText('Issue 12');
  expect(tracks()[1]).toBe('102px');
  again.unmount();
  render(<RepoIssueTable state={state} summary={OTHER} onTab={vi.fn()} />);
  await waitFor(() => expect(screen.queryByText('lendo…')).not.toBeInTheDocument());
  expect(tracks()[1]).toBe('132px');
});

test('an empty list, or a search that leaves no row, draws no body divider; the handles stay (#59)', async () => {
  const user = userEvent.setup();
  const { unmount } = renderTable();
  await screen.findByText('Issue 12');
  expect(screen.getByTestId('column-dividers')).toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: 'buscar no repositório' }), 'nada');
  expect(screen.queryByTestId('column-dividers')).not.toBeInTheDocument();
  expect(screen.getAllByRole('separator')).toHaveLength(5);
  unmount();
  render(<RepoIssueTable state={state} summary={OTHER} onTab={vi.fn()} />);
  await waitFor(() => expect(screen.queryByText('lendo…')).not.toBeInTheDocument());
  expect(screen.queryByTestId('column-dividers')).not.toBeInTheDocument();
  expect(screen.getAllByRole('separator')).toHaveLength(5);
});

test('a list the model never synced shows sincronizando… in place of each count and as the body, never an empty table (#182)', async () => {
  render(<RepoIssueTable state={state} summary={NEW} onTab={vi.fn()} />);
  const radios = screen.getByRole('radiogroup');
  await waitFor(() => expect(within(radios).getAllByTitle('sincronizando…')).toHaveLength(2));
  expect(within(radios).queryByText('2')).not.toBeInTheDocument(); // no count that reads as a number of issues
  expect(screen.getAllByRole('status', { name: 'sincronizando…' })).toHaveLength(1); // announced once, by the body; the counts' marks are silent
  expect(within(screen.getByRole('table')).getByRole('status', { name: 'sincronizando…' })).toHaveClass('text-muted-foreground');
  expect(screen.getAllByRole('row')).toHaveLength(2); // the header and the syncing row
  expect(screen.queryByText('lendo…')).not.toBeInTheDocument();
});

test('a synced list with no issue is an empty table, with no syncing mark (#182)', async () => {
  render(<RepoIssueTable state={state} summary={OTHER} onTab={vi.fn()} />);
  await waitFor(() => expect(screen.queryByText('lendo…')).not.toBeInTheDocument());
  expect(screen.queryByRole('status', { name: 'sincronizando…' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(1);
});

test('the header\'s GitHub opens the repository\'s issues; a fork\'s opens the fork\'s own, never the original\'s (#352)', async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const { unmount } = renderTable();
  await user.click(screen.getByRole('button', { name: 'GitHub' }));
  expect(open).toHaveBeenCalledWith('https://github.com/acme/site/issues', '_blank', 'noreferrer');
  unmount();
  const FORK: RepoSummary = { ...SITE, repository: 'me/site', url: 'https://github.com/me/site', role: 'fork', fork: { parent: 'acme/site' } };
  render(<RepoIssueTable state={state} summary={FORK} onTab={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'GitHub' }));
  expect(open).toHaveBeenLastCalledWith('https://github.com/me/site/issues', '_blank', 'noreferrer');
  open.mockRestore();
});
