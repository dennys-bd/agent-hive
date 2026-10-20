import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mergeCell } from '@/components/RepoPrRow';
import { RepoIssueTable } from '@/components/RepoIssueTable';
import { RepoPrTable } from '@/components/RepoPrTable';
import { resetRepoIssues } from '@/hooks/use-repo-issues';
import { emitReadModelEvent } from '@/lib/review-events';
import { setLanguage } from '@/i18n';
import { readView, resetViewState } from '@/lib/view-state';
import type { PrRow, RepoPrs, RepoSummary, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';

const SITE: RepoSummary = { repository: 'acme/site', url: 'https://github.com/acme/site', workspace: 'hive', openPrs: 3, openIssues: 2, closedIssues: 1, canPush: true, issuesEnabled: true, syncedAt: null };
const LINK = 'https://github.com/acme/site/pull/';
const row = (n: number, extra: Partial<PrRow> = {}): PrRow => ({ url: `${LINK}${n}`, number: n, title: `PR ${n}`, state: 'open', isDraft: false, mergeState: 'clean', updatedAt: '2026-10-05T09:00:00Z', ...extra });
const OPEN: RepoPrs = {
  counts: { open: 3, merged: 1, closed: 0 }, truncated: false, canPush: true, syncedAt: '2026-10-05T09:00:00Z',
  rows: [row(7, { checks: 'success', decision: 'approved' }), row(8, { isDraft: true, mergeState: 'draft' }), row(9, { checks: 'failure', decision: 'changes', mergeState: 'conflicts' })],
};
const MERGED: RepoPrs = { canPush: true, syncedAt: '2026-10-05T09:00:00Z', counts: { open: 3, merged: 1, closed: 0 }, truncated: true, rows: [row(5, { state: 'merged', mergeState: 'unknown' })] };
const OTHER: RepoSummary = { ...SITE, repository: 'acme/other', url: 'https://github.com/acme/other' };
const EMPTY: RepoPrs = { counts: { open: 0, merged: 0, closed: 0 }, truncated: false, canPush: true, syncedAt: '2026-10-05T09:00:00Z', rows: [] };
const NEW: RepoSummary = { ...SITE, repository: 'acme/new', url: 'https://github.com/acme/new' };
const UNSYNCED: RepoPrs = { ...EMPTY, syncedAt: null };
const OPEN_PATH = '/repositories/acme/site/pulls?state=open';
// #12 is a task of roadmap whose stack is #6 (merged) then #7
const TASK: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Issue 12', body: '', url: 'https://github.com/acme/site/issues/12', source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const STACK = [{ url: `${LINK}6`, state: 'merged' as const, slice: { k: 1, type: 'stacked' as const } }, { url: `${LINK}7`, state: 'open' as const, slice: { k: 2, type: 'stacked' as const } }];
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks: [TASK], sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [{ id: 'a-12', taskIds: ['roadmap:PVTI_12'], sessions: [], prs: STACK }], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const jsonRes = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const answer = async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url === '/repositories/acme/site/pulls?state=open') return jsonRes(OPEN);
  if (url === '/repositories/acme/other/pulls?state=open') return jsonRes(EMPTY);
  if (url === '/repositories/acme/new/pulls?state=open') return jsonRes(UNSYNCED);
  return jsonRes(url === '/repositories/acme/site/pulls?state=merged' ? MERGED : { ok: true });
};
const fetchMock = vi.fn(answer);
beforeEach(() => {
  setLanguage('pt');
  resetRepoIssues();
  fetchMock.mockReset();
  fetchMock.mockImplementation(answer);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderTable = (onOpen?: (read: PrRow) => void) => render(<RepoPrTable state={state} summary={SITE} onTab={vi.fn()} onOpen={onOpen} />);
const rowOf = (text: string) => within(screen.getByText(text).closest('tr') as HTMLElement);

test('the list reads the open PRs: the segments, the columns, each cell\'s state and tone, a draft\'s dashes, the stack and the task, the footer (#758)', async () => {
  renderTable();
  expect(await screen.findByText('PR 7')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/repositories/acme/site/pulls?state=open');
  expect(screen.getByRole('radio', { name: 'abertos 3' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('radio', { name: 'mergeados' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['PR', 'estado', 'checks', 'review', 'merge', 'pilha', 'tarefa', 'atualizado']);
  const seven = rowOf('PR 7');
  expect(seven.getByText('aberto')).toHaveClass('text-review');
  expect(seven.getByText('✓')).toHaveClass('text-working');
  expect(seven.getByText('aprovado')).toHaveClass('text-working');
  expect(seven.getByText('pronto')).toHaveClass('text-working');
  expect(seven.getByText('2/2')).toHaveClass('tabular-nums');
  expect(seven.getByText('#12')).toHaveClass('text-foreground');
  const eight = rowOf('PR 8');
  expect(eight.getByText('rascunho')).toHaveClass('text-muted-foreground');
  expect(eight.getAllByText('—')).toHaveLength(3); // review, merge and task
  const nine = rowOf('PR 9');
  expect(nine.getByText('✕')).toHaveClass('text-destructive');
  expect(nine.getByText('mudanças pedidas')).toHaveClass('text-waiting');
  expect(nine.getByText('conflito')).toHaveClass('text-destructive');
  expect(screen.getByText('3 abertos')).toBeInTheDocument();
  expect(screen.getByText('↵ abre o PR')).toBeInTheDocument();
});

test('the merge cell takes the first that holds: a draft, conflicts, failing checks, not approved, then ready on clean or hooks, else empty (#758)', () => {
  const cell = (extra: Partial<PrRow>) => mergeCell({ ...row(1, { decision: 'approved' }), ...extra });
  expect(cell({ isDraft: true, mergeState: 'conflicts' })).toBe('draft');
  expect(cell({ mergeState: 'conflicts', checks: 'failure' })).toBe('conflict');
  expect(cell({ checks: 'failure' })).toBe('failing');
  expect(cell({ mergeState: 'unstable' })).toBe('failing');
  expect(cell({ decision: 'changes' })).toBe('review');
  expect(cell({ decision: undefined })).toBe('review');
  expect([cell({}), cell({ mergeState: 'hooks' })]).toEqual(['ready', 'ready']);
  expect([cell({ mergeState: 'blocked' }), cell({ mergeState: 'behind' }), cell({ mergeState: 'unknown' })]).toEqual(['none', 'none', 'none']);
});

test('mergeados reads the merged PRs; past the first 100 the footer says so (#758)', async () => {
  const user = userEvent.setup();
  renderTable();
  await screen.findByText('PR 7');
  await user.click(screen.getByRole('radio', { name: 'mergeados' }));
  expect(await screen.findByText('PR 5')).toBeInTheDocument();
  expect(rowOf('PR 5').getByText('mergeado')).toHaveClass('text-muted-foreground');
  expect(fetchMock).toHaveBeenCalledWith('/repositories/acme/site/pulls?state=merged');
  expect(screen.getByText(/mostrando os primeiros 100/)).toBeInTheDocument();
});

test('a row click and ↵ on a focused row open the PR; ⇧↵ opens it on GitHub (#758)', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn<(read: PrRow) => void>();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  renderTable(onOpen);
  await user.click(await screen.findByText('PR 9'));
  (screen.getByText('PR 7').closest('tr') as HTMLElement).focus();
  await user.keyboard('{Enter}');
  expect(onOpen.mock.calls.map(([read]) => read.number)).toEqual([9, 7]);
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  expect(open).toHaveBeenCalledWith(`${LINK}7`, '_blank', 'noreferrer');
  expect(onOpen).toHaveBeenCalledTimes(2);
  open.mockRestore();
});

test('a fork whose workspace sends PRs to the original shows the empty states with a link to it, issues — when off; an original says your PRs; no push rights reads sem permissão; a workflow awaiting approval ◷ (#854)', async () => {
  const user = userEvent.setup();
  const onRepository = vi.fn();
  const FORK: RepoSummary = { ...SITE, repository: 'me/site', role: 'fork', pr: 'original', fork: { parent: 'acme/site' }, canPush: true, issuesEnabled: false };
  const prs = render(<RepoPrTable state={state} summary={FORK} onTab={vi.fn()} onRepository={onRepository} />);
  expect(screen.getByText('nenhum PR em me/site. neste workspace, os PRs dos agentes vão para o original.')).toBeInTheDocument();
  expect(screen.queryAllByRole('separator')).toHaveLength(0); // ForkEmpty renders no table
  expect(screen.getByRole('tab', { name: /issues/ })).toHaveTextContent('issues —');
  await user.click(screen.getByRole('button', { name: 'abrir acme/site ›' }));
  expect(onRepository).toHaveBeenCalledWith('acme/site');
  prs.unmount();
  const issues = render(<RepoIssueTable state={state} summary={FORK} onTab={vi.fn()} onRepository={onRepository} />);
  expect(screen.getByText('as issues estão desativadas em me/site. as issues deste workspace ficam no original.')).toBeInTheDocument();
  expect(screen.queryAllByRole('separator')).toHaveLength(0); // ForkEmpty renders no table
  issues.unmount();
  fetchMock.mockImplementation(async () => jsonRes({ ...OPEN, canPush: false, rows: [row(7, { checks: 'awaiting', decision: 'approved' })] }));
  render(<RepoPrTable state={state} summary={{ ...SITE, role: 'original', pr: 'original' }} onTab={vi.fn()} />);
  expect(await screen.findByText('3 abertos · seus PRs no original')).toBeInTheDocument();
  expect(rowOf('PR 7').getByText('sem permissão')).toHaveClass('text-muted-foreground');
  expect(rowOf('PR 7').getByText('◷')).toHaveClass('text-muted-foreground');
});

test('a PR whose checks still run shows the spinner in the waiting tone, not a dot; reduced motion stills it (#48)', async () => {
  fetchMock.mockImplementation(async () => jsonRes({ ...OPEN, rows: [row(7, { checks: 'pending', decision: 'approved' })] }));
  renderTable();
  const spinner = (await screen.findByText('PR 7')).closest('tr')?.querySelector('[data-testid="spinner"]');
  expect(spinner?.parentElement).toHaveClass('text-waiting');
  expect(spinner).toHaveClass('animate-spin', 'motion-reduce:animate-none');
  expect(rowOf('PR 7').queryByText('●')).toBeNull();
});

const tracks = (): string[] => screen.getAllByRole('row')[0].style.gridTemplateColumns.split(' ');
const handle = (name: string): HTMLElement => screen.getByRole('separator', { name: `redimensionar ${name}` });

test('a drag on a PR column\'s left-edge handle saves its width for the repository\'s PRs and keeps its issues\' widths; a remount reads it; another repository, empty, keeps the defaults and draws no body divider (#59)', async () => {
  resetViewState({ repoLists: { 'acme/site': { issues: { labels: 102 } } } });
  const { unmount } = renderTable();
  await screen.findByText('PR 7');
  expect(tracks()).toEqual(['minmax(160px,1fr)', '80px', '56px', '120px', '112px', '56px', '64px', '80px']);
  expect(screen.getAllByRole('separator').map((h) => h.getAttribute('aria-label'))).toEqual([
    'redimensionar estado', 'redimensionar checks', 'redimensionar review', 'redimensionar merge', 'redimensionar pilha', 'redimensionar tarefa', 'redimensionar atualizado',
  ]);
  expect(screen.getByTestId('column-dividers').children).toHaveLength(7);
  fireEvent.pointerDown(handle('review'), { pointerId: 1, clientX: 0 });
  fireEvent.pointerMove(handle('review'), { pointerId: 1, clientX: -40 });
  fireEvent.pointerUp(handle('review'), { pointerId: 1, clientX: -40 });
  expect(tracks()[3]).toBe('160px'); // dragged left: wider
  expect(readView('repoLists')).toEqual({ 'acme/site': { issues: { labels: 102 }, prs: { review: 160 } } });
  unmount();
  const again = renderTable();
  await screen.findByText('PR 7');
  expect(tracks()[3]).toBe('160px');
  again.unmount();
  render(<RepoPrTable state={state} summary={OTHER} onTab={vi.fn()} />);
  await waitFor(() => expect(screen.queryByText('lendo…')).not.toBeInTheDocument());
  expect(tracks()[3]).toBe('120px');
  expect(screen.queryByTestId('column-dividers')).not.toBeInTheDocument();
  expect(screen.getAllByRole('separator')).toHaveLength(7);
});

test('a readModel event of its repository naming pulls or issues reads the list again; another repository, or only other kinds, does not (#186)', async () => {
  renderTable();
  await screen.findByText('PR 7');
  fetchMock.mockClear();
  await act(async () => {
    emitReadModelEvent({ repository: 'acme/other', kinds: ['pulls', 'issues'] });
    emitReadModelEvent({ repository: 'acme/site', kinds: ['comments', 'labels', 'repo'] });
  });
  expect(fetchMock).not.toHaveBeenCalledWith(OPEN_PATH);
  for (const kind of ['pulls', 'issues']) {
    fetchMock.mockClear();
    await act(async () => { emitReadModelEvent({ repository: 'acme/site', kinds: [kind] }); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(OPEN_PATH));
  }
});

test('a list the model never synced shows sincronizando… in place of the open count and as the body, never an empty table (#186)', async () => {
  render(<RepoPrTable state={state} summary={NEW} onTab={vi.fn()} />);
  const radios = screen.getByRole('radiogroup');
  await waitFor(() => expect(within(radios).getAllByTitle('sincronizando…')).toHaveLength(1));
  expect(within(radios).getByRole('radio', { name: 'abertos' })).toBeInTheDocument(); // no count that reads as a number of PRs
  expect(screen.getAllByRole('status', { name: 'sincronizando…' })).toHaveLength(1); // announced once, by the body
  expect(within(screen.getByRole('table')).getByRole('status', { name: 'sincronizando…' })).toHaveClass('text-muted-foreground');
  expect(screen.getAllByRole('row')).toHaveLength(2); // the header and the syncing row
});

test('the header\'s GitHub opens the repository\'s pulls; a fork\'s opens the fork\'s own, never the original\'s (#352)', async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const { unmount } = renderTable();
  await user.click(screen.getByRole('button', { name: 'GitHub' }));
  expect(open).toHaveBeenCalledWith('https://github.com/acme/site/pulls', '_blank', 'noreferrer');
  unmount();
  const FORK: RepoSummary = { ...SITE, repository: 'me/site', url: 'https://github.com/me/site', role: 'fork', pr: 'original', fork: { parent: 'acme/site' } };
  render(<RepoPrTable state={state} summary={FORK} onTab={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'GitHub' }));
  expect(open).toHaveBeenLastCalledWith('https://github.com/me/site/pulls', '_blank', 'noreferrer');
  open.mockRestore();
});
