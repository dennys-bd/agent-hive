import { act, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useDetachedLayout } from '@/hooks/use-detached-layout';
import { setLanguage } from '@/i18n';
import { activitiesOf } from '@/lib/activities';
import { type CenterLayout, type CenterTabRef, groupsOf } from '@/lib/center-layout';
import * as models from '@/lib/editor-models';
import { resetViewState } from '@/lib/view-state';
import type { MovedTab } from '../../src/tab-carry';
import type { State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS } from '../../src/types';
import { withWork } from '../fixtures/work';
import { resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// A detached window's layout (#553) over a fake bridge: the activity A, listed by its worktree; window:open delivered by the test
const task: Task = { item: { itemId: 'A', id: '1', title: 'Task A', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true };
const BASE: State = {
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], flows: [], stages: [], tasks: [task], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [],
  usage: [], budget: {}, usageRules: [], disabledRules: [], transitions: [], workspaces: [], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {},
  deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
};
const LIST = activitiesOf(withWork(BASE, 'A', { worktree: '/a' }));
const ID = LIST[0].activity.id; // the models' key; the moved tab names the activity's key, A
const DIFF: CenterTabRef = { kind: 'diff', scope: 'worktree' };
const FILE: CenterTabRef = { kind: 'file', path: 'src/a.ts' };
const CARRY = { text: 'mine\n', base: 'v1' };
const tabsOf = (layout?: CenterLayout): CenterTabRef[] => (layout === undefined ? [] : groupsOf(layout.root).flatMap((group) => group.tabs));

let open: (value: unknown) => void;
const dock = vi.fn(async (_tab: MovedTab): Promise<void> => undefined);
const tabsChanged = vi.fn();

beforeEach(() => {
  setLanguage('pt');
  resetViewState();
  dock.mockReset();
  dock.mockImplementation(async () => undefined);
  tabsChanged.mockClear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('hive', { onOpen: (callback: (value: unknown) => void) => { open = callback; }, dock, tabsChanged });
});
afterEach(() => {
  models.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = () => renderHook(() => useDetachedLayout(LIST, LIST[0]));
const arrive = async (value: unknown): Promise<void> => { await act(async () => { open(value); }); };

test('a window:open of the activity opens its tab picked in the focused group, a carry seeding its buffer dirty; one of another activity or malformed is dropped with console.error (#553)', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = mount();
  await arrive({ activity: 'B', ref: DIFF });
  await arrive({ activity: 'A', ref: { kind: 'pr', number: 1 } });
  expect([result.current.layout, error.mock.calls.length]).toEqual([undefined, 2]);
  await arrive({ activity: 'A', ref: DIFF });
  await arrive({ activity: 'A', ref: FILE, carry: CARRY });
  await waitFor(() => expect(tabsOf(result.current.layout)).toEqual([DIFF, FILE]));
  expect(groupsOf(result.current.layout!.root)[0].active).toBe(1);
  expect([models.isDirty(ID, 'src/a.ts'), models.textOf(ID, 'src/a.ts')]).toEqual([true, 'mine\n']);
});

test('tabsChanged reports nothing before the first tab, then the refs after each open and close; isEmpty only once a layout that held a tab holds none (#553)', async () => {
  const { result } = mount();
  expect([tabsChanged.mock.calls.length, result.current.isEmpty]).toEqual([0, false]);
  await arrive({ activity: 'A', ref: DIFF });
  await waitFor(() => expect(tabsChanged).toHaveBeenLastCalledWith([DIFF]));
  await arrive({ activity: 'A', ref: FILE });
  await waitFor(() => expect(tabsChanged).toHaveBeenLastCalledWith([DIFF, FILE]));
  act(() => result.current.close('diff:worktree'));
  await waitFor(() => expect(tabsChanged).toHaveBeenLastCalledWith([FILE]));
  act(() => result.current.close('file:src/a.ts'));
  await waitFor(() => expect(tabsChanged).toHaveBeenLastCalledWith([]));
  expect(result.current.isEmpty).toBe(true);
});

test('dock sends the activity, the ref and a dirty buffer\'s carry, then closes the tab and drops its model; a rejection keeps the tab dirty and shows the toast (#553)', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = mount();
  await arrive({ activity: 'A', ref: FILE, carry: CARRY });
  await waitFor(() => expect(tabsOf(result.current.layout)).toEqual([FILE]));
  dock.mockRejectedValueOnce(new Error('aba inválida'));
  let isDocked = true;
  await act(async () => { isDocked = await result.current.dock(FILE); });
  expect([isDocked, tabsOf(result.current.layout), models.isDirty(ID, 'src/a.ts')]).toEqual([false, [FILE], true]);
  expect(toast.error).toHaveBeenCalledWith('Não foi possível voltar a aba para a janela principal');
  expect(error).toHaveBeenCalled();
  await act(async () => { isDocked = await result.current.dock(FILE); });
  expect(dock).toHaveBeenLastCalledWith({ activity: 'A', ref: FILE, carry: CARRY });
  expect([isDocked, result.current.layout, models.baseOf(ID, 'src/a.ts')]).toEqual([true, undefined, undefined]);
});

test('dockAll docks every tab in the layout\'s order and stops at the first rejection, leaving the tabs left (#553)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = mount();
  await arrive({ activity: 'A', ref: DIFF });
  await arrive({ activity: 'A', ref: FILE });
  await waitFor(() => expect(tabsOf(result.current.layout)).toEqual([DIFF, FILE]));
  dock.mockRejectedValueOnce(new Error('aba inválida'));
  let isDone = true;
  await act(async () => { isDone = await result.current.dockAll(); });
  expect([isDone, dock.mock.calls.length, tabsOf(result.current.layout)]).toEqual([false, 1, [DIFF, FILE]]);
  await act(async () => { isDone = await result.current.dockAll(); });
  expect([isDone, dock.mock.calls.map(([tab]) => tab.ref), result.current.isEmpty]).toEqual([true, [DIFF, DIFF, FILE], true]);
});

test('a second dock of a tab still docking, or a second dockAll while one runs, waits for the first and sends nothing again (#553)', async () => {
  const { result } = mount();
  await arrive({ activity: 'A', ref: FILE, carry: CARRY });
  await waitFor(() => expect(tabsOf(result.current.layout)).toEqual([FILE]));
  let settle: () => void = () => undefined;
  dock.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
  let answers: boolean[] = [];
  await act(async () => {
    const both = Promise.all([result.current.dock(FILE), result.current.dockAll(), result.current.dockAll()]);
    settle();
    answers = await both;
  });
  expect([answers, dock.mock.calls.length, result.current.isEmpty]).toEqual([[true, true, true], 1, true]);
});
