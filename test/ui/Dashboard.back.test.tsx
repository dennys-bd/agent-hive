import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import type { SourcesNav } from '@/components/FlowSources';
import { forgetProjects } from '@/hooks/use-project';
import { resetRepositories } from '@/hooks/use-repositories';
import { setLanguage } from '@/i18n';
import type { IssuePage as Issue, PrData, ProjectView, RepoIssues, RepoPrs, RepoSummary, SourceConfig, State, Worker } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, withPointedWork, type WithWork } from '../fixtures/work';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));
vi.mock('@/hooks/use-task-tree', () => ({ useTaskTree: () => ({ status: 'loading' }) }));

// The repository and the project of Dashboard.repos.test.tsx: acme/site with PR #7 and issue #12, whose page links PR #7
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
const PAGE: Issue = { ...OPEN.issues[0], title: 'Pager breaks', repository: 'acme/site', body: 'b', author: 'bia', createdAt: '2026-10-01T09:00:00Z', comments: [], commentCount: 0, pullRequests: [{ number: 7, url: PR_PAGE.url, state: 'open' }] };
const VIEW: ProjectView = {
  statuses: [{ name: 'Ready', stage: 'dev' }], fields: [], builtins: { status: 0, labels: 1, assignees: 1 }, truncated: false,
  items: [
    { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: '', url: PAGE.url, repository: 'acme/site', labels: [], assignees: [], fields: {}, pullRequests: [] },
    { itemId: 'roadmap:PVTI_5', id: '5', title: 'Elsewhere', body: '', url: 'https://github.com/acme/else/issues/5', repository: 'acme/else', labels: [], assignees: [], fields: {}, pullRequests: [] },
  ],
};
const state: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], stages: [{ name: 'dev', from: { roadmap: ['Ready'] }, prompt: 'x' }], tasks: [], sourceOrder: [], localCount: 0, benchmark: { experiments: [] },
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
// #12 as a task with a running worker: its details link the issue, and under Atividades it is an activity
const TASK: WithWork = { item: { itemId: 'roadmap:PVTI_12', id: '12', title: 'Pager breaks', body: '', url: PAGE.url, source: 'roadmap' }, stage: 'dev', boardColumn: 'Ready', auto: true, workerId: 's1' };
const WORKER: Worker = { id: 's1', status: 'working', activityId: activityIdOf('roadmap:PVTI_12'), runId: 'W1', sessionId: 'abcdef123456', startedAt: '2026-10-05T09:00:00.000Z' };
const working: State = withPointedWork({ ...state, workers: [WORKER], tasks: [TASK] });
// #12's activity holding PR #7 (#69): the task details link it, under Automação and in the activity sidebar
const withPr: State = { ...working, activityRecords: working.activityRecords.map((r) => ({ ...r, prs: [{ url: PR_PAGE.url, state: 'open' as const }] })) };

const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ANSWERS: Record<string, unknown> = {
  '/repositories': [SITE], '/repositories/acme/site/issues?state=open': OPEN, '/repositories/acme/site/pulls?state=open': PRS, '/repositories/acme/site/issues/12': PAGE,
  '/sources/roadmap/project': VIEW, '/repositories/acme/site/pulls/7': PR_PAGE, '/repositories/acme/site/pulls/7/review': { reviewed: [], drafts: [] },
};
const answer = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jsonRes(Object.hasOwn(ANSWERS, String(input)) ? ANSWERS[String(input)] : { ok: true });
const fetchMock = vi.fn(answer); // a POST …/pulls/7/merge answers { ok: true }: GitHub accepted the merge

beforeEach(() => {
  setLanguage('pt');
  resetFakes();
  resetRepositories();
  forgetProjects();
  fetchMock.mockClear();
  fetchMock.mockImplementation(answer); // a test's own answers end with it
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => { vi.unstubAllGlobals(); });

// The selection as App holds it (src/ui/App.tsx), every onSelect recorded
function Home({ shown = state, initial, calls = [] }: { shown?: State; initial?: Selection; calls?: (Selection | undefined)[] }) {
  const [selected, setSelected] = useState<Selection | undefined>(initial);
  const onSelect = (selection?: Selection): void => {
    calls.push(selection);
    setSelected(selection);
  };
  return <Dashboard state={shown} locale="pt-BR" tick={0} sources={NAV} selected={selected} onSelect={onSelect} />;
}

const showFlow = (): void => { fireEvent.click(screen.getByRole('button', { name: 'fluxo' })); }; // the window opens on Atividades (#746)
const showActivities = (): void => { fireEvent.click(screen.getByRole('button', { name: 'atividades' })); };
const automation = () => within(screen.getByRole('region', { name: 'Automação' }));
const main = () => within(screen.getByRole('main'));
const bar = () => within(document.querySelector<HTMLElement>('[data-header-column="center"]')!); // the flow's bar, in the window header (#295)
const BACK_KEY = { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }; // goBack off macOS: jsdom is not macOS
const right = (): HTMLElement => document.querySelector<HTMLElement>('[data-dock="right"]')!;
// toggleSideTab is Ctrl+Alt+Shift+E off macOS (#585): opens the activity sidebar on detalhes
const sideKey = (): void => { fireEvent.keyDown(document.body, { key: 'E', code: 'KeyE', ctrlKey: true, altKey: true, shiftKey: true }); };
const backButton = (): HTMLElement | null => bar().queryByTitle(/^voltar( · |$)/); // the back button's title (#911)
// The activity row of #12 under Atividades
const pickActivity = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  showActivities();
  await user.click(within(screen.getByRole('navigation', { name: 'Atividades' })).getByText('#12 Pager breaks').closest('button') as HTMLElement);
};

test('the flow on roadmap with #12 selected → issue → PR → issue → PR: one back shows that flow, #12 still selected, onSelect not called (#380)', async () => {
  const user = userEvent.setup();
  const calls: (Selection | undefined)[] = [];
  render(<Home shown={withPr} initial={{ taskId: 'roadmap:PVTI_12' }} calls={calls} />);
  showFlow();
  await automation().findByRole('button', { name: /^site/ }); // the repositories are read: the links open pages, not GitHub
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await user.click(screen.getByRole('link', { name: 'site#12' })); // the details' issue link
  expect(await main().findByRole('heading', { name: 'Pager breaks' })).toBeInTheDocument();
  await user.click(await main().findByRole('button', { name: 'abrir PR ›' }));
  expect(await main().findByRole('heading', { name: 'Fix the pager' })).toBeInTheDocument();
  await user.click(await main().findByRole('button', { name: 'tarefa #12 · site' })); // the PR page's task link
  expect(await main().findByRole('heading', { name: 'Pager breaks' })).toBeInTheDocument();
  await user.click(await main().findByRole('button', { name: 'abrir PR ›' }));
  expect(await main().findByRole('heading', { name: 'Fix the pager' })).toBeInTheDocument();
  await user.click(bar().getByRole('button', { name: 'fluxo · roadmap' })); // ‹ is aria-hidden: the name is the label
  expect(main().queryByRole('heading', { name: 'Fix the pager' })).not.toBeInTheDocument();
  expect(bar().getByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true');
  expect(automation().getByRole('button', { name: /^roadmap/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('heading', { name: '#12 Pager breaks' })).toBeInTheDocument(); // the details, still on the task
  expect(calls).toEqual([]); // an unchanged selection is not picked again: its panel stays as the user left it
});

test('the flow on hive → a repository\'s issue whose task is roadmap\'s: back reads fluxo · todas and shows every source, so the task is in it (#380)', async () => {
  const user = userEvent.setup();
  render(<Home shown={working} />);
  showFlow();
  await user.click(automation().getByRole('button', { name: /^hive/ }));
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await user.click(await bar().findByRole('tab', { name: 'issues 3' }));
  await user.click(await main().findByText('Issue 12'));
  expect(await main().findByRole('heading', { name: 'Pager breaks' })).toBeInTheDocument();
  await user.click(bar().getByRole('button', { name: 'fluxo · todas' }));
  expect(main().queryByRole('heading', { name: 'Pager breaks' })).not.toBeInTheDocument();
  expect(bar().getByText('todas as sources')).toBeInTheDocument(); // the flow's header
  expect(automation().getByRole('button', { name: /^todas/ })).toHaveAttribute('aria-pressed', 'true');
});

test('a PR with no task, opened from a repository\'s PR list, goes back to the flow keeping its pick (#380)', async () => {
  const user = userEvent.setup();
  render(<Home />);
  showFlow();
  await automation().findByRole('button', { name: /^site/ });
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await user.click(automation().getByRole('button', { name: /^site/ }));
  await user.click(await main().findByText('Fix the pager'));
  expect(await main().findByRole('heading', { name: 'Fix the pager' })).toBeInTheDocument();
  await user.click(bar().getByRole('button', { name: 'fluxo · roadmap' }));
  expect(main().queryByRole('heading', { name: 'Fix the pager' })).not.toBeInTheDocument();
  expect(bar().getByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true');
  expect(automation().getByRole('button', { name: /^roadmap/ })).toHaveAttribute('aria-pressed', 'true');
});

test('an issue opened from the GitHub Project table goes back to the flow, not the table, by ⌘[ too (#380)', async () => {
  const user = userEvent.setup();
  render(<Home />);
  showFlow();
  await automation().findByRole('button', { name: /^site/ });
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await user.click(bar().getByRole('tab', { name: 'GitHub Project' }));
  await user.click(await main().findByText('Pager breaks'));
  expect(await main().findByRole('heading', { name: 'Pager breaks' })).toBeInTheDocument();
  expect(bar().getByRole('button', { name: 'fluxo · roadmap' })).toBeInTheDocument();
  expect(fireEvent.keyDown(window, BACK_KEY)).toBe(false); // ⌘[ on macOS
  expect(await bar().findByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true');
  expect(main().queryByText('2 issues · 0 no fluxo')).not.toBeInTheDocument();
  expect(main().queryByRole('heading', { name: 'Pager breaks' })).not.toBeInTheDocument();
});

test('an issue opened from the Atividades view goes back to the flow, not to that view (#380)', async () => {
  const user = userEvent.setup();
  render(<Home shown={working} />);
  showFlow();
  await automation().findByRole('button', { name: /^site/ });
  await pickActivity(user);
  sideKey();
  await user.click(within(right()).getByRole('link', { name: 'site#12' }));
  expect(await main().findByRole('heading', { name: 'Pager breaks' })).toBeInTheDocument();
  await user.click(bar().getByRole('button', { name: 'fluxo · todas' }));
  expect(main().queryByRole('heading', { name: 'Pager breaks' })).not.toBeInTheDocument(); // main() is found: Automação shows
  expect(bar().getByText('todas as sources')).toBeInTheDocument();
});

test('the flow, a repository\'s lists and the GitHub Project table show no back button (#380)', async () => {
  const user = userEvent.setup();
  render(<Home />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await main().findByText('Fix the pager');
  expect(backButton()).toBeNull();
  await user.click(bar().getByRole('tab', { name: 'issues 3' }));
  await main().findByText('Issue 12');
  expect(backButton()).toBeNull();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  expect(backButton()).toBeNull(); // the flow
  await user.click(bar().getByRole('tab', { name: 'GitHub Project' }));
  await main().findByText('2 issues · 0 no fluxo');
  expect(backButton()).toBeNull();
});

// The PR page's merge button (#69): PR_PAGE allows squash alone
const merge = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.click(await main().findByRole('button', { name: 'squash e merge' }));
};

test('a PR opened from the GitHub Project (the task details\' PR link) and merged with the Hive\'s button goes back to the flow on roadmap (#69, #380)', async () => {
  const user = userEvent.setup();
  render(<Home shown={withPr} initial={{ taskId: 'roadmap:PVTI_12' }} />);
  showFlow();
  await automation().findByRole('button', { name: /^site/ });
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await user.click(bar().getByRole('tab', { name: 'GitHub Project' }));
  await main().findByText('Elsewhere'); // the table's row out of the flow
  await user.click(screen.getByRole('link', { name: '#7' }));
  expect(await main().findByRole('heading', { name: 'Fix the pager' })).toBeInTheDocument();
  expect(bar().getByRole('button', { name: 'fluxo · roadmap' })).toBeInTheDocument();
  await merge(user);
  expect(await bar().findByRole('tab', { name: 'fluxo' })).toHaveAttribute('aria-selected', 'true');
  expect(main().queryByText('Elsewhere')).not.toBeInTheDocument();
  expect(main().queryByRole('heading', { name: 'Fix the pager' })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/repositories/acme/site/pulls/7/merge', expect.objectContaining({ method: 'POST' }));
});

test('a PR opened from the repository\'s PR list and merged goes back to the flow (#69, #380)', async () => {
  const user = userEvent.setup();
  render(<Home shown={withPr} initial={{ taskId: 'roadmap:PVTI_12' }} />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await user.click(await main().findByText('Fix the pager'));
  expect(await bar().findByRole('button', { name: 'fluxo · todas' })).toBeInTheDocument();
  await merge(user);
  expect(await bar().findByText('todas as sources')).toBeInTheDocument();
  expect(main().queryByRole('heading', { name: 'Fix the pager' })).not.toBeInTheDocument();
});

test('a PR opened from the Atividades view and merged goes back to the flow under Automação (#69, #380)', async () => {
  const user = userEvent.setup();
  render(<Home shown={withPr} />);
  showFlow();
  await automation().findByRole('button', { name: /^site/ }); // the repositories are read: the PR opens as a page, not on GitHub
  await pickActivity(user);
  sideKey();
  await user.click(within(right()).getByRole('link', { name: '#7' }));
  expect(await bar().findByRole('button', { name: 'fluxo · todas' })).toBeInTheDocument();
  await merge(user);
  expect(await bar().findByText('todas as sources')).toBeInTheDocument();
  expect(main().queryByRole('heading', { name: 'Fix the pager' })).not.toBeInTheDocument(); // main() is found: Automação shows
});

test('a merge GitHub refuses keeps the PR page, with its message and the way back; a PR seen merged on atualizar keeps it too, read only (#69)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async (input, init) => (
    init?.method === 'POST' && String(input).endsWith('/merge') ? jsonRes({ error: 'gh api graphql: Pull request is in a merge queue' }, 502) : answer(input, init)
  ));
  render(<Home />);
  showFlow();
  await user.click(await automation().findByRole('button', { name: /^site/ }));
  await user.click(await main().findByText('Fix the pager'));
  await merge(user);
  expect(await within(main().getByRole('region', { name: 'mergear' })).findByRole('alert')).toHaveTextContent('Pull request is in a merge queue');
  expect(main().getByRole('heading', { name: 'Fix the pager' })).toBeInTheDocument();
  expect(bar().getByRole('button', { name: 'fluxo · todas' })).toBeInTheDocument();
  fetchMock.mockImplementation(async (input, init) => (String(input) === '/repositories/acme/site/pulls/7' ? jsonRes({ ...PR_PAGE, state: 'merged' }) : answer(input, init)));
  await user.click(bar().getByRole('button', { name: 'atualizar' }));
  expect(await main().findByText('mergeado: só leitura')).toBeInTheDocument();
  expect(main().getByRole('heading', { name: 'Fix the pager' })).toBeInTheDocument();
  expect(bar().getByRole('button', { name: 'fluxo · todas' })).toBeInTheDocument();
  expect(main().queryByRole('region', { name: 'mergear' })).not.toBeInTheDocument();
});
