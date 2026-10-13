import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { SourcesNav } from '@/components/FlowSources';
import { resetRepositories } from '@/hooks/use-repositories';
import { setLanguage } from '@/i18n';
import { resetViewState } from '@/lib/view-state';
import type { IssuePage as Issue, PrData, ProjectView, RepoIssues, RepoPrs, RepoSummary, SourceConfig, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

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
const PR_8: PrData = { ...PR_PAGE, url: 'https://github.com/acme/site/pull/8', id: 'PR_8', number: 8, title: 'Second slice' };
const PAGE: Issue = { ...OPEN.issues[0], title: 'Pager breaks', repository: 'acme/site', body: 'b', author: 'bia', createdAt: '2026-10-01T09:00:00Z', comments: [], commentCount: 0, pullRequests: [{ number: 7, url: 'https://github.com/acme/site/pull/7', state: 'open' }] };
const VIEW: ProjectView = {
  statuses: [{ name: 'Ready', stage: 'dev' }], fields: [], builtins: { status: 0, labels: 1, assignees: 1 }, truncated: false,
  items: [
    { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: '', url: PAGE.url, repository: 'acme/site', labels: [], assignees: [], fields: {}, pullRequests: [] },
    { itemId: 'roadmap:PVTI_5', id: '5', title: 'Elsewhere', body: '', url: 'https://github.com/acme/else/issues/5', repository: 'acme/else', labels: [], assignees: [], fields: {}, pullRequests: [] },
  ],
};
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks: [], sourceOrder: [], localCount: 0,
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// What each GET answers, by its path; anything else { ok: true }. Later tasks add entries
const ANSWERS: Record<string, unknown> = {
  '/repositories': [SITE], '/repositories/acme/site/issues?state=open': OPEN, '/repositories/acme/site/pulls?state=open': PRS, '/repositories/acme/site/issues/12': PAGE, '/sources/roadmap/project': VIEW,
  '/repositories/acme/site/pulls/7': PR_PAGE, '/repositories/acme/site/pulls/7/review': { reviewed: [], drafts: [] },
  '/repositories/acme/site/pulls/8': PR_8, '/repositories/acme/site/pulls/8/review': { reviewed: [], drafts: [] },
};
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => jsonRes(Object.hasOwn(ANSWERS, String(input)) ? ANSWERS[String(input)] : { ok: true }));

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  resetRepositories();
  resetViewState();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const showFlow = (): void => { fireEvent.click(screen.getByRole('radio', { name: /fluxo/ })); }; // the window opens on Atividades (#746)
const automation = () => within(screen.getByRole('region', { name: 'Automação' }));
const main = () => within(screen.getByRole('main'));

test('picking a repository clears the source pick, todas included, and picking a source clears the repository (#757)', async () => {
  const user = userEvent.setup();
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showFlow();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  expect(automation().getByRole('button', { name: /^site/ })).toHaveAttribute('aria-pressed', 'true');
  expect(automation().getByRole('button', { name: /^roadmap/ })).toHaveAttribute('aria-pressed', 'false');
  expect(automation().getByRole('button', { name: /^todas/ })).toHaveAttribute('aria-pressed', 'false');
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  expect(automation().getByRole('button', { name: /^site/ })).toHaveAttribute('aria-pressed', 'false');
  expect(automation().getByRole('button', { name: /^roadmap/ })).toHaveAttribute('aria-pressed', 'true');
});

test('a picked repository takes the center with its header on the PRs tab and its open PRs; issues shows its open issues; picking a source shows the flow again (#757, #758)', async () => {
  const user = userEvent.setup();
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  expect(await main().findByText('Fix the pager')).toBeInTheDocument();
  expect(main().getByRole('tab', { name: 'PRs 2' })).toHaveAttribute('aria-selected', 'true');
  expect(main().getByText('workspace hive')).toBeInTheDocument();
  await user.click(main().getByRole('tab', { name: 'issues 3' }));
  expect(await main().findByText('Issue 12')).toBeInTheDocument();
  expect(main().getByRole('tab', { name: 'issues 3' })).toHaveAttribute('aria-selected', 'true');
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  expect(main().queryByText('Issue 12')).not.toBeInTheDocument();
  expect(main().getByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true');
});

test('a repository\'s row opens the issue page under the repository header; its issues tab returns to the list (#757)', async () => {
  const user = userEvent.setup();
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await user.click(await main().findByRole('tab', { name: 'issues 3' }));
  await user.click(await main().findByText('Issue 12'));
  expect(await main().findByRole('heading', { name: 'Pager breaks' })).toBeInTheDocument();
  expect(main().getByText('acme/site · hive')).toBeInTheDocument();
  await user.click(main().getByRole('tab', { name: 'issues 3' }));
  expect(await main().findByText('Issue 12')).toBeInTheDocument();
  expect(main().queryByRole('heading', { name: 'Pager breaks' })).not.toBeInTheDocument();
});

test('a native view row opens the issue page under the source header when the Hive lists its repository, else GitHub; the active tab returns to the table (#757)', async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showFlow();
  await automation().findByRole('button', { name: /^site/ }); // the repositories are read
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await user.click(main().getByRole('tab', { name: 'GitHub Project' }));
  await user.click(await main().findByText('Elsewhere'));
  expect(open).toHaveBeenCalledWith('https://github.com/acme/else/issues/5', '_blank', 'noreferrer');
  await user.click(main().getByText('Pager breaks'));
  expect(await main().findByRole('heading', { name: 'Pager breaks' })).toBeInTheDocument();
  expect(main().getByText('roadmap · hive')).toBeInTheDocument();
  expect(main().getByRole('tab', { name: 'GitHub Project' })).toHaveAttribute('aria-selected', 'true');
  await user.click(main().getByRole('tab', { name: 'GitHub Project' }));
  expect(await main().findByText('2 issues · 0 no fluxo')).toBeInTheDocument();
  open.mockRestore();
});

test('a native view row of a task whose repository the Hive does not list goes to the task, not to GitHub (#757)', async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const onSelect = vi.fn();
  const task = { item: { ...VIEW.items[1], source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true } as State['tasks'][number];
  render(<Dashboard state={{ ...state, tasks: [task] }} locale="pt-BR" tick={0} sources={NAV} onSelect={onSelect} />);
  showFlow();
  await automation().findByRole('button', { name: /^site/ });
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await user.click(main().getByRole('tab', { name: 'GitHub Project' }));
  await user.click(await main().findByText('Elsewhere'));
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith({ taskId: 'roadmap:PVTI_5' }));
  expect(open).not.toHaveBeenCalled();
  open.mockRestore();
});

test('a PR row opens its page under the PRs tab; the PRs tab returns to the list (#758)', async () => {
  const user = userEvent.setup();
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await user.click(await main().findByText('Fix the pager'));
  expect(await main().findByRole('heading', { name: 'Fix the pager' })).toBeInTheDocument();
  expect(main().getByRole('tab', { name: 'conversa 0' })).toHaveAttribute('aria-selected', 'true');
  expect(main().getByRole('tab', { name: 'PRs 2' })).toHaveAttribute('aria-selected', 'true');
  await user.click(main().getByRole('tab', { name: 'PRs 2' }));
  expect(await main().findByText('Fix the pager')).toBeInTheDocument();
  expect(main().queryByRole('heading', { name: 'Fix the pager' })).not.toBeInTheDocument();
});

test('a stack part of a listed repository opens its page; one of a repository the Hive does not list opens GitHub (#758)', async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const task = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: '', url: PAGE.url, source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true } as State['tasks'][number];
  const prs = [
    { url: PR_PAGE.url, state: 'open' as const, slice: { k: 1, type: 'stacked' as const } },
    { url: PR_8.url, state: 'open' as const, slice: { k: 2, type: 'stacked' as const } },
    { url: 'https://github.com/acme/else/pull/3', state: 'open' as const },
  ];
  const stacked: State = { ...state, tasks: [task], activityRecords: [{ id: 'r12', taskIds: ['roadmap:PVTI_12'], sessions: [], prs }] };
  render(<Dashboard state={stacked} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await user.click(await main().findByText('Fix the pager'));
  await user.click(await main().findByRole('button', { name: '#3 else' }));
  expect(open).toHaveBeenCalledWith('https://github.com/acme/else/pull/3', '_blank', 'noreferrer');
  await user.click(main().getByRole('button', { name: '2/2 #8 aberto' }));
  expect(await main().findByRole('heading', { name: 'Second slice' })).toBeInTheDocument();
  open.mockRestore();
});

test('an issue page\'s abrir PR › opens the PR\'s page under the PRs tab (#758)', async () => {
  const user = userEvent.setup();
  render(<Dashboard state={state} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await user.click(main().getByRole('tab', { name: 'issues 3' }));
  await user.click(await main().findByText('Issue 12'));
  await user.click(await main().findByRole('button', { name: 'abrir PR ›' }));
  expect(await main().findByRole('heading', { name: 'Fix the pager' })).toBeInTheDocument();
  expect(main().getByRole('tab', { name: 'PRs 2' })).toHaveAttribute('aria-selected', 'true');
});
