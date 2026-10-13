import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import type { SourcesNav } from '@/components/FlowSources';
import { forgetProjects } from '@/hooks/use-project';
import { reloadRepositories, resetRepositories } from '@/hooks/use-repositories';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import type { IssuePage as Issue, PrData, RepoIssues, RepoPrs, RepoSummary, SourceConfig, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

// The repository of Dashboard.repos.test.tsx: acme/site with PR #7 and issue #12
const SOURCE: SourceConfig = { name: 'roadmap', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' };
const NAV: SourcesNav = { sources: [SOURCE], auth: 'cli' };
const SITE: RepoSummary = { repository: 'acme/site', url: 'https://github.com/acme/site', workspace: 'hive', openPrs: 2, openIssues: 3, closedIssues: 1, canPush: true, issuesEnabled: true, lastActivity: '2026-10-05T09:00:00Z', syncedAt: '2026-10-05T09:00:00Z' };
const OPEN: RepoIssues = {
  state: 'open', total: 1, truncated: false, syncedAt: '2026-10-05T09:00:00Z',
  issues: [{ number: 12, title: 'Issue 12', url: 'https://github.com/acme/site/issues/12', labels: [], assignees: [], updatedAt: '2026-10-05T09:00:00Z', pullRequests: [] }],
};
const PRS: RepoPrs = {
  counts: { open: 2, merged: 0, closed: 0 }, truncated: false, canPush: true, syncedAt: '2026-10-05T09:00:00Z',
  rows: [{ url: 'https://github.com/acme/site/pull/7', number: 7, title: 'Fix the pager', state: 'open', isDraft: false, mergeState: 'clean', updatedAt: '2026-10-05T09:00:00Z' }],
};
const PR_PAGE: PrData = {
  url: 'https://github.com/acme/site/pull/7', id: 'PR_7', number: 7, title: 'Fix the pager', state: 'open', isDraft: false, mergeState: 'clean', head: 'f'.repeat(40),
  methods: ['squash'], viewer: 'ana', files: [], threads: [], truncated: false, body: 'Fixes the pager.', author: 'bia', createdAt: '2026-10-05T09:00:00Z',
  updatedAt: '2026-10-05T09:00:00Z', headRef: 'fix-pager', baseRef: 'main', commits: 1, additions: 3, deletions: 1, approvals: 0, reviews: [], comments: [], canEdit: true, canPush: true, headOwner: 'acme', baseOwner: 'acme', reviewRequests: [], closes: [],
};
const PAGE: Issue = { ...OPEN.issues[0], title: 'Pager breaks', repository: 'acme/site', body: 'b', author: 'bia', createdAt: '2026-10-01T09:00:00Z', comments: [], commentCount: 0, pullRequests: [] };
// #12 is the roadmap task T12; PR #7 is the hive task B's; A, a hive task, is the selection
const T12: Task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: '', url: PAGE.url, source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const A: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: false, created: true };
const B: Task = { item: { itemId: 'local:2', id: 'HIVE-2', title: 'Fix it', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: false, created: true };
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks: [T12, A, B],
  sourceOrder: [], localCount: 0, activities: [], activityRecords: [{ id: 'r-B', taskIds: [B.item.itemId], sessions: [], prs: [{ url: PR_PAGE.url, state: 'open' }] }],
  usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ANSWERS: Record<string, unknown> = {
  '/repositories': [SITE], '/repositories/acme/site/issues?state=open': OPEN, '/repositories/acme/site/pulls?state=open': PRS, '/repositories/acme/site/issues/12': PAGE,
  '/repositories/acme/site/pulls/7': PR_PAGE, '/repositories/acme/site/pulls/7/review': { reviewed: [], drafts: [] },
};
const answer = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonRes(Object.hasOwn(ANSWERS, String(input)) ? ANSWERS[String(input)] : { ok: true });
const fetchMock = vi.fn(answer);

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  resetRepositories();
  resetViewState();
  forgetProjects();
  fetchMock.mockClear();
  fetchMock.mockImplementation(answer);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

// The selection as App holds it (src/ui/App.tsx), every onSelect recorded
function Home({ initial, calls = [] }: { initial?: Selection; calls?: (Selection | undefined)[] }) {
  const [selected, setSelected] = useState<Selection | undefined>(initial);
  const onSelect = (selection?: Selection): void => {
    calls.push(selection);
    setSelected(selection);
  };
  return <Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} selected={selected} onSelect={onSelect} />;
}

const showFlow = (): void => { fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); }; // the window opens on Atividades (#746)
const showActivities = (): void => { fireEvent.click(screen.getByRole('button', { name: 'atividades' })); };
const automation = () => within(screen.getByRole('region', { name: 'Automação' }));
const main = () => within(screen.getByRole('main'));
const bar = () => within(document.querySelector<HTMLElement>('[data-header-column="center"]')!); // the flow's bar, in the window header (#295)
const panel = () => within(screen.getByRole('complementary', { name: 'detalhe' }));
const right = (): HTMLElement => document.querySelector<HTMLElement>('[data-dock="right"]')!;

// Under the repository: its issue #12's page (T12's)
async function openIssue12(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await bar().findByRole('tab', { name: 'issues 3' }));
  await user.click(await main().findByText('Issue 12'));
}

test('an issue page shows its task in the panel ahead of the selection, with its workspace and source; a list shows the selection again; a PR page shows the PR\'s task (#64)', async () => {
  const user = userEvent.setup();
  const calls: (Selection | undefined)[] = [];
  render(<Home initial={{ taskId: A.item.itemId }} calls={calls} />);
  showFlow();
  expect(panel().getByRole('heading', { name: 'HIVE-1 Task A' })).toBeInTheDocument();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await openIssue12(user);
  expect(await panel().findByRole('heading', { name: '#12 Pager breaks' })).toBeInTheDocument();
  expect(panel().getByText('hive · roadmap')).toBeInTheDocument();
  expect(await panel().findByText('responsável', { selector: 'dt' })).toBeInTheDocument(); // the page's block, in third place
  expect(main().queryByRole('complementary')).not.toBeInTheDocument();
  await user.click(bar().getByRole('tab', { name: 'PRs 2' }));
  expect(await panel().findByRole('heading', { name: 'HIVE-1 Task A' })).toBeInTheDocument();
  await user.click(await main().findByText('Fix the pager'));
  expect(await panel().findByRole('heading', { name: 'HIVE-2 Fix it' })).toBeInTheDocument();
  expect(await panel().findByRole('region', { name: 'este PR' })).toBeInTheDocument(); // a hive task's PR: the this PR block (#66)
  expect(panel().queryByText('acme/site')).not.toBeInTheDocument(); // the repository block is a PR without a task's
  await user.click(automation().getByRole('button', { name: /^todas/ }));
  expect(panel().getByRole('heading', { name: 'HIVE-1 Task A' })).toBeInTheDocument();
  expect(calls).toEqual([]); // the selection never changed: leaving the pages restores it
});

test('opening a page opens the panel holding Detalhes; closed, it stays closed on that page and opens with the next one (#64)', async () => {
  const user = userEvent.setup();
  render(<Home />); // no selection: the right panel starts closed
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  expect(screen.queryByRole('tab', { name: 'Detalhes' })).not.toBeInTheDocument();
  await user.click(await main().findByText('Fix the pager'));
  expect(await screen.findByRole('tab', { name: 'Detalhes' })).toHaveAttribute('aria-selected', 'true');
  await user.click(within(right()).getByRole('button', { name: 'Fechar painel' }));
  await user.click(await main().findByRole('tab', { name: 'arquivos 0' }));
  expect(screen.queryByRole('tab', { name: 'Detalhes' })).not.toBeInTheDocument();
  await openIssue12(user);
  expect(await screen.findByRole('tab', { name: 'Detalhes' })).toHaveAttribute('aria-selected', 'true');
});

test('with a page open and the center under Atividades the panel shows the selection; back on the flow, the page\'s task again (#64, #596)', async () => {
  const user = userEvent.setup();
  render(<Home initial={{ taskId: A.item.itemId }} />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await openIssue12(user);
  expect(await panel().findByRole('heading', { name: '#12 Pager breaks' })).toBeInTheDocument();
  showActivities();
  const hidden = within(screen.getByRole('complementary', { name: 'detalhe', hidden: true }));
  expect(hidden.getByRole('heading', { name: 'HIVE-1 Task A', hidden: true })).toBeInTheDocument();
  expect(screen.queryByText('responsável', { selector: 'dt' })).not.toBeInTheDocument(); // the slot is empty, the page renders no portal
  showFlow();
  expect(panel().getByRole('heading', { name: '#12 Pager breaks' })).toBeInTheDocument();
  expect(await panel().findByText('responsável', { selector: 'dt' })).toBeInTheDocument();
});

test('a PR page whose repository the last read no longer lists gives no page mode: the panel shows the selection (#64)', async () => {
  const user = userEvent.setup();
  render(<Home initial={{ taskId: A.item.itemId }} />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await user.click(await main().findByText('Fix the pager'));
  expect(await panel().findByRole('heading', { name: 'HIVE-2 Fix it' })).toBeInTheDocument();
  fetchMock.mockImplementation(async (input, init) => (String(input) === '/repositories' ? jsonRes([]) : answer(input, init)));
  await act(async () => { await reloadRepositories(); });
  expect(panel().getByRole('heading', { name: 'HIVE-1 Task A' })).toBeInTheDocument();
  expect(main().queryByRole('heading', { name: 'Fix the pager' })).not.toBeInTheDocument();
});
