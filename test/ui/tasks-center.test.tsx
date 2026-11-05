import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { Dashboard } from '@/components/Dashboard';
import type { SourcesNav } from '@/components/FlowSources';
import { FIRST_CENTER, type TasksCenter, backOf, centerOfTask, resolveCenter, useTasksCenter } from '@/hooks/use-tasks-center';
import { forgetProjects } from '@/hooks/use-project';
import { setLanguage } from '@/i18n';
import { readView, resetViewState } from '@/lib/view-state';
import { flatten } from '../../src/flows';
import type { Flow, ProjectView, RepoSummary, SourceConfig, Stage, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { FakeWebSocket, resetFakes } from './xterm-fakes';

// #571: two flows, dev in build and review in ship; #3 sits in a stage of no flow
const stage = (name: string, column: string): Stage => ({ name, from: { roadmap: [column] }, prompt: 'x' });
const FLOWS: Flow[] = [{ name: 'build', stages: [stage('dev', 'Ready')], transitions: [] }, { name: 'ship', stages: [stage('review', 'Review')], transitions: [] }];
const ROADMAP: SourceConfig = { name: 'roadmap', qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' };
const NAV: SourcesNav = { sources: [ROADMAP], auth: 'cli' };
const SITE: RepoSummary = { repository: 'acme/site', url: 'https://github.com/acme/site', workspace: 'hive', openPrs: 2, openIssues: 3, closedIssues: 1, canPush: true, issuesEnabled: true, lastActivity: '2026-10-05T09:00:00Z', syncedAt: '2026-10-05T09:00:00Z' };
const task = (n: string, at: string): Task => ({ item: { itemId: `roadmap:PVTI_${n}`, id: n, title: `Issue ${n}`, body: '', url: `https://github.com/acme/r/issues/${n}`, source: 'roadmap' }, stage: at, boardColumn: 'Ready', auto: true });
const STATE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], flows: FLOWS, ...flatten(FLOWS),
  tasks: [task('1', 'dev'), task('2', 'review'), task('3', 'gone')], sourceOrder: [], localCount: 0, benchmark: { experiments: [] },
  activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};

beforeEach(() => setLanguage('pt'));

test('resolveCenter keeps a center whose flow, source and repository exist, and the hive source while it is on; any other reads as the first flow (#571, #572)', () => {
  const live: TasksCenter[] = [{ kind: 'tasks', view: 'flow', flow: 'ship' }, { kind: 'tasks', view: 'outside' }, { kind: 'tasks', view: 'list' }, { kind: 'source', source: 'roadmap' }, { kind: 'source', source: 'hive' }, { kind: 'repo', repository: 'acme/site', tab: 'issues' }];
  for (const center of live) expect(resolveCenter(center, FLOWS, [ROADMAP], [SITE], true)).toBe(center);
  const stale: TasksCenter[] = [{ kind: 'tasks', view: 'flow', flow: 'gone' }, { kind: 'source', source: 'notes' }, { kind: 'repo', repository: 'acme/else', tab: 'prs' }];
  for (const center of stale) expect(resolveCenter(center, FLOWS, [ROADMAP], [SITE], true)).toEqual(FIRST_CENTER);
  expect(resolveCenter({ kind: 'source', source: 'hive' }, FLOWS, [ROADMAP], [SITE], false)).toEqual(FIRST_CENTER);
});

test('centerOfTask places a task in the flow its stage belongs to, else outside (#571)', () => {
  expect(centerOfTask(FLOWS, { stage: 'review' })).toEqual({ kind: 'tasks', view: 'flow', flow: 'ship' });
  expect(centerOfTask(FLOWS, { stage: '' })).toEqual({ kind: 'tasks', view: 'outside' });
  expect(centerOfTask(FLOWS, { stage: 'gone' })).toEqual({ kind: 'tasks', view: 'outside' });
});

test('backOf: a page goes back to the list it was opened from, labelled voltar; a list and the tasks view have no way back (#571)', () => {
  const show = vi.fn();
  const issue = { repository: 'acme/site', number: 12 };
  const lists: TasksCenter[] = [FIRST_CENTER, { kind: 'source', source: 'roadmap' }, { kind: 'repo', repository: 'acme/site', tab: 'prs' }];
  for (const center of lists) expect(backOf(center, show)).toBeUndefined();
  const pages: [TasksCenter, TasksCenter][] = [
    [{ kind: 'source', source: 'roadmap', issue }, { kind: 'source', source: 'roadmap' }],
    [{ kind: 'repo', repository: 'acme/site', tab: 'issues', issue }, { kind: 'repo', repository: 'acme/site', tab: 'issues' }],
    [{ kind: 'repo', repository: 'acme/site', tab: 'prs', pr: { repository: 'acme/site', number: 7 } }, { kind: 'repo', repository: 'acme/site', tab: 'prs' }],
  ];
  for (const [page, list] of pages) {
    const back = backOf(page, show);
    expect(back?.label).toBe('voltar');
    back?.onBack();
    expect(show).toHaveBeenLastCalledWith(list);
  }
});

test("useTasksCenter starts on the first flow; show resolves the flow, the source and the repository; goTo shows the task's flow or outside and selects it (#571)", () => {
  const onSelect = vi.fn();
  const { result } = renderHook(() => useTasksCenter(STATE, NAV, [SITE], onSelect));
  expect(result.current.center).toEqual(FIRST_CENTER);
  expect(result.current.flow?.name).toBe('build');
  act(() => result.current.show({ kind: 'tasks', view: 'flow', flow: 'ship' }));
  expect(result.current.flow?.name).toBe('ship');
  act(() => result.current.show({ kind: 'source', source: 'roadmap' }));
  expect(result.current.source).toBe(ROADMAP);
  act(() => result.current.show({ kind: 'repo', repository: 'acme/site', tab: 'prs' }));
  expect(result.current.repo).toBe(SITE);
  act(() => result.current.goTo('roadmap:PVTI_2'));
  expect(result.current.center).toEqual({ kind: 'tasks', view: 'flow', flow: 'ship' });
  expect(onSelect).toHaveBeenLastCalledWith({ taskId: 'roadmap:PVTI_2' });
  act(() => result.current.goTo('roadmap:PVTI_3'));
  expect(result.current.center).toEqual({ kind: 'tasks', view: 'outside' });
  expect(onSelect).toHaveBeenLastCalledWith({ taskId: 'roadmap:PVTI_3' });
});

test('goTo of a task the state does not hold yet shows the first flow, then its own flow and the selection once the state holds it (#571)', () => {
  const onSelect = vi.fn();
  const { result, rerender } = renderHook(({ state }) => useTasksCenter(state, NAV, [SITE], onSelect), { initialProps: { state: { ...STATE, tasks: [] } as State } });
  act(() => result.current.show({ kind: 'source', source: 'roadmap' }));
  act(() => result.current.goTo('roadmap:PVTI_2'));
  expect(result.current.center).toEqual(FIRST_CENTER);
  expect(onSelect).not.toHaveBeenCalled(); // App would drop a selection the state does not hold
  rerender({ state: STATE });
  expect(result.current.center).toEqual({ kind: 'tasks', view: 'flow', flow: 'ship' });
  expect(onSelect).toHaveBeenCalledWith({ taskId: 'roadmap:PVTI_2' });
});

test("a page under a source or a repository is the details panel's page and has a way back; a removed source or repository reads as the first flow (#571)", () => {
  const { result, rerender } = renderHook(({ repos, nav }) => useTasksCenter(STATE, nav, repos, vi.fn()), { initialProps: { repos: [SITE], nav: NAV } });
  act(() => result.current.show({ kind: 'source', source: 'roadmap' }));
  act(() => result.current.openIssue({ repository: 'acme/site', number: 12 }));
  expect(result.current.page).toMatchObject({ kind: 'issue', url: 'https://github.com/acme/site/issues/12' });
  expect(result.current.back?.label).toBe('voltar');
  rerender({ repos: [SITE], nav: { ...NAV, sources: [] } });
  expect(result.current.center).toEqual(FIRST_CENTER);
  expect(result.current.page).toBeUndefined();
  act(() => result.current.openPr({ repository: 'acme/site', number: 7 }));
  expect(result.current.center).toMatchObject({ kind: 'repo', repository: 'acme/site', tab: 'prs' });
  expect(result.current.page).toMatchObject({ kind: 'pr', url: 'https://github.com/acme/site/pull/7' });
  rerender({ repos: [], nav: NAV });
  expect(result.current.center).toEqual(FIRST_CENTER);
  expect(result.current.back).toBeUndefined();
});

test('the hive source is a center while it is on, with no SourceConfig resolved; once it is off it reads as the first flow (#572)', () => {
  const { result, rerender } = renderHook(({ nav }) => useTasksCenter(STATE, nav, [SITE], vi.fn()), { initialProps: { nav: NAV } });
  act(() => result.current.show({ kind: 'source', source: 'hive' }));
  expect(result.current.center).toEqual({ kind: 'source', source: 'hive' });
  expect(result.current.source).toBeUndefined();
  rerender({ nav: { ...NAV, hiveSource: false } });
  expect(result.current.center).toEqual(FIRST_CENTER);
});

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./xterm-fakes')).FakeTerminal }));
vi.mock('@xterm/addon-fit', async () => ({ FitAddon: (await import('./xterm-fakes')).FakeFitAddon }));
vi.mock('@/hooks/use-comments', () => ({ useComments: () => ({ kind: 'unsupported' }) }));
vi.mock('@/hooks/use-task-files', () => ({ useTaskFiles: () => [] }));

const VIEW: ProjectView = {
  statuses: [{ name: 'Ready', stage: 'dev' }, { name: 'Review', stage: 'review' }], fields: [], builtins: {}, truncated: false,
  items: STATE.tasks.map((c) => ({ itemId: c.item.itemId, id: c.item.id, title: c.item.title, body: '', url: c.item.url, status: 'Ready', labels: [], assignees: [], fields: {}, pullRequests: [] })),
};
const jsonRes = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  forgetProjects();
  resetFakes();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => jsonRes(String(input) === '/sources/roadmap/project' ? VIEW : { ok: true })));
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const showTasks = (): void => { fireEvent.click(screen.getByRole('button', { name: 'tarefas' })); }; // the window opens on Atividades (#746)
const main = () => within(screen.getByRole('main'));
const bar = () => within(document.querySelector<HTMLElement>('[data-header-column="center"]')!);
const automation = () => within(screen.getByRole('region', { name: 'Tarefas' }));
const stageNode = (name: string): Element | null => document.querySelector(`[aria-label="fluxograma"] [data-stage="${name}"]`);
const goToRow = async (user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> => {
  await user.click(within((await main().findByText(title)).closest('tr')!).getByRole('button', { name: /›$/ }));
};

test("a source row opens its table under the source header, with no tabs; the first flow's row shows its flowchart (#571)", async () => {
  const user = userEvent.setup();
  render(<Dashboard state={STATE} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showTasks();
  expect(stageNode('dev')).not.toBeNull();
  expect(stageNode('review')).toBeNull();
  expect(bar().getByText('todas as sources')).toBeInTheDocument();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  expect(await main().findByText('Issue 2')).toBeInTheDocument();
  expect(bar().getByText('github project · acme')).toBeInTheDocument();
  expect(bar().queryAllByRole('tab')).toEqual([]);
  expect(automation().getByRole('button', { name: /^roadmap/ })).toHaveAttribute('aria-pressed', 'true');
  await user.click(automation().getByRole('button', { name: /^build/ }));
  expect(stageNode('dev')).not.toBeNull();
  expect(automation().getByRole('button', { name: /^build/ })).toHaveAttribute('aria-pressed', 'true');
});

test('the task column on a task of the second flow shows that flowchart and selects it; on a task in no flow, the outside placeholder (#571)', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<Dashboard state={STATE} locale="pt-BR" tick={0} sources={NAV} onSelect={onSelect} />);
  showTasks();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await goToRow(user, 'Issue 2');
  expect(stageNode('review')).not.toBeNull();
  expect(stageNode('dev')).toBeNull();
  expect(onSelect).toHaveBeenCalledWith({ taskId: 'roadmap:PVTI_2' });
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await goToRow(user, 'Issue 3');
  expect(main().getByText('em breve')).toHaveClass('text-muted-foreground');
  expect(document.querySelector('[aria-label="fluxograma"]')).toBeNull();
  expect(onSelect).toHaveBeenCalledWith({ taskId: 'roadmap:PVTI_3' });
});

test('a Settings save that renames the shown flow brings the first flow back (#571)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Dashboard state={STATE} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showTasks();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await goToRow(user, 'Issue 2');
  expect(stageNode('review')).not.toBeNull();
  rerender(<Dashboard state={{ ...STATE, flows: [FLOWS[0], { ...FLOWS[1], name: 'deliver' }] }} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  expect(stageNode('dev')).not.toBeNull();
  expect(stageNode('review')).toBeNull();
});

test('the outside placeholder has exibir with no voltas rows, counting only the stageless tasks; its choice is the flowchart\'s too (#574)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState());
  const user = userEvent.setup();
  const stageless: Task = { item: { itemId: 'roadmap:PVTI_4', id: '4', title: 'Issue 4', body: '', url: 'https://github.com/acme/r/issues/4', source: 'roadmap' }, boardColumn: 'Ready', auto: true };
  render(<Dashboard state={{ ...STATE, tasks: [...STATE.tasks, stageless] }} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showTasks();
  await user.click(automation().getByRole('button', { name: /^roadmap/ }));
  await goToRow(user, 'Issue 3'); // a stage of no flow: the outside view
  await user.click(bar().getByRole('button', { name: 'exibir' }));
  let pop = within(screen.getByRole('dialog'));
  expect(pop.queryByRole('radiogroup', { name: 'voltas' })).not.toBeInTheDocument();
  expect(pop.queryByRole('radiogroup', { name: 'rótulos das voltas' })).not.toBeInTheDocument();
  expect(pop.getByRole('checkbox', { name: 'roadmap' }).closest('label')).toHaveTextContent(/1$/); // #4 alone has no stage
  await user.click(pop.getByRole('checkbox', { name: 'hive' }));
  expect(bar().getByText('roadmap')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await user.click(automation().getByRole('button', { name: /^build/ }));
  expect(stageNode('dev')).not.toBeNull();
  expect(bar().getByText('roadmap')).toBeInTheDocument(); // one value for every view
  await user.click(bar().getByRole('button', { name: 'exibir' }));
  pop = within(screen.getByRole('dialog'));
  expect(pop.getByRole('radiogroup', { name: 'voltas' })).toBeInTheDocument();
  expect(pop.getByRole('checkbox', { name: 'hive' })).not.toBeChecked();
});

test('⌥0 opens todas em lista, the list with its groups, and ⌥1 the hive source, while the tasks view shows (#572, #577)', () => {
  render(<Dashboard state={STATE} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showTasks();
  fireEvent.keyDown(window, { key: '™', code: 'Digit0', altKey: true });
  expect(automation().getByRole('button', { name: /^todas em lista/ })).toHaveAttribute('aria-pressed', 'true');
  const list = within(main().getByRole('table', { name: 'todas em lista' }));
  expect([...list.getAllByRole('button')].filter((b) => b.hasAttribute('aria-expanded')).map((b) => b.textContent)).toEqual(['build1', 'ship1', 'sem fluxosem etapas · nenhum worker conduz1']); // #3's stage belongs to no flow
  expect(main().queryByText('em breve')).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: '™', code: 'Digit1', altKey: true });
  expect(automation().getByRole('button', { name: /^hive/ })).toHaveAttribute('aria-pressed', 'true');
  expect(bar().getByText('hive')).toHaveClass('font-semibold');
});

test('mostrar só esta in a source\'s ⋯ leaves only that source on: the header legend names it and the center stays (#572)', async () => {
  resetViewState();
  onTestFinished(() => resetViewState());
  const user = userEvent.setup();
  render(<Dashboard state={STATE} locale="pt-BR" tick={0} sources={NAV} onSelect={() => {}} />);
  showTasks();
  automation().getByRole('button', { name: 'ações de roadmap' }).focus();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('menuitem', { name: 'mostrar só esta' }));
  expect(bar().getByText('roadmap')).toBeInTheDocument(); // the legend: the one source on (#574 decision 10)
  expect(stageNode('dev')).not.toBeNull();
  expect(readView('flowView')).toMatchObject({ sourcesOff: ['hive'] });
});
