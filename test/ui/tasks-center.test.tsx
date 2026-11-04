import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SourcesNav } from '@/components/FlowSources';
import { FIRST_CENTER, type TasksCenter, backOf, centerOfPick, centerOfTask, resolveCenter, useTasksCenter } from '@/hooks/use-tasks-center';
import { setLanguage } from '@/i18n';
import { flatten } from '../../src/flows';
import type { Flow, RepoSummary, SourceConfig, Stage, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';

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

test('resolveCenter keeps a center whose flow, source and repository exist and reads any other as the first flow (#571)', () => {
  const live: TasksCenter[] = [{ kind: 'tasks', view: 'flow', flow: 'ship' }, { kind: 'tasks', view: 'outside' }, { kind: 'source', source: 'roadmap' }, { kind: 'repo', repository: 'acme/site', tab: 'issues' }];
  for (const center of live) expect(resolveCenter(center, FLOWS, [ROADMAP], [SITE])).toBe(center);
  const stale: TasksCenter[] = [{ kind: 'tasks', view: 'flow', flow: 'gone' }, { kind: 'source', source: 'notes' }, { kind: 'source', source: 'hive' }, { kind: 'repo', repository: 'acme/else', tab: 'prs' }];
  for (const center of stale) expect(resolveCenter(center, FLOWS, [ROADMAP], [SITE])).toEqual(FIRST_CENTER);
});

test('centerOfTask places a task in the flow its stage belongs to, else outside; todas and hive pick the first flow, a source its table (#571)', () => {
  expect(centerOfTask(FLOWS, { stage: 'review' })).toEqual({ kind: 'tasks', view: 'flow', flow: 'ship' });
  expect(centerOfTask(FLOWS, { stage: '' })).toEqual({ kind: 'tasks', view: 'outside' });
  expect(centerOfTask(FLOWS, { stage: 'gone' })).toEqual({ kind: 'tasks', view: 'outside' });
  expect([centerOfPick(undefined), centerOfPick('hive')]).toEqual([FIRST_CENTER, FIRST_CENTER]);
  expect(centerOfPick('roadmap')).toEqual({ kind: 'source', source: 'roadmap' });
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
