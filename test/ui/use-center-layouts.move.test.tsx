import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useCenterLayouts } from '@/hooks/use-center-layouts';
import { setLanguage } from '@/i18n';
import type { TaskActivity } from '@/lib/activities';
import { type CenterLayout, type CenterTabRef, groupsOf } from '@/lib/center-layout';
import * as models from '@/lib/editor-models';
import { applyCarry } from '@/lib/tab-carry';
import { resetViewState } from '@/lib/view-state';
import type { MovedTab } from '../../src/tab-carry';
import type { Task } from '../../src/types';
import { jsonResponse } from '../fakes';
import { taskPairOf } from '../fixtures/work';
import { resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// The main window's move (#554) over a fake bridge: task I1's activity, its stored layout, src/a.ts's buffer dirty
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const ACTIVITY: TaskActivity = { kind: 'task', ...taskPairOf('I1'), task, runs: [], sessions: [], status: 'empty', worker: false };
const ID = ACTIVITY.activity.id; // the models' key; the moved tab names the activity's key, I1
const DIFF: CenterTabRef = { kind: 'diff', scope: 'worktree' };
const FILE: CenterTabRef = { kind: 'file', path: 'src/a.ts' };
const CHANGES: CenterTabRef = { kind: 'changes', path: 'src/a.ts' };
const CARRY = { text: 'mine\n', base: 'v1' };
const layoutOf = (...tabs: CenterTabRef[]): CenterLayout => ({ root: { kind: 'group', id: 'g1', tabs, active: tabs.length - 1 }, focused: 'g1' });
const tabsOf = (layout?: CenterLayout): CenterTabRef[] => (layout === undefined ? [] : groupsOf(layout.root).flatMap((group) => group.tabs));
const moveToWindow = vi.fn(async (_tab: MovedTab): Promise<void> => undefined);

beforeEach(() => {
  setLanguage('pt');
  moveToWindow.mockReset();
  moveToWindow.mockImplementation(async () => undefined);
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
  vi.stubGlobal('hive', { moveToWindow });
});
afterEach(() => {
  models.closeExcept(new Set());
  resetMonacoFakes();
  resetViewState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = async (layout: CenterLayout) => {
  resetViewState({ centerLayouts: { I1: layout } });
  await applyCarry(ID, FILE, CARRY); // the file's buffer, dirty
  return renderHook(() => useCenterLayouts([ACTIVITY], ACTIVITY, undefined));
};

test('moveToWindow on a dirty file sends the activity\'s key, the ref and its carry, and only once main took it closes the tab and drops its model (#554)', async () => {
  const { result } = await mount(layoutOf(DIFF, FILE));
  let isMoved = false;
  await act(async () => { isMoved = await result.current.moveToWindow('file:src/a.ts'); });
  expect(moveToWindow).toHaveBeenCalledWith({ activity: 'I1', ref: FILE, carry: CARRY });
  expect([isMoved, tabsOf(result.current.layout), models.baseOf(ID, 'src/a.ts')]).toEqual([true, [DIFF], undefined]);
});

test('a rejected moveToWindow keeps the tab, still dirty, shows the toast and logs the raw error (#554)', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  moveToWindow.mockRejectedValueOnce(new Error('aba inválida'));
  const { result } = await mount(layoutOf(DIFF, FILE));
  let isMoved = true;
  await act(async () => { isMoved = await result.current.moveToWindow('file:src/a.ts'); });
  expect([isMoved, tabsOf(result.current.layout), models.isDirty(ID, 'src/a.ts')]).toEqual([false, [DIFF, FILE], true]);
  expect(toast.error).toHaveBeenCalledWith('Não foi possível mover a aba para uma janela');
  expect(error).toHaveBeenCalled();
});

test('moveToWindow refuses a shared buffer and a key the layout does not hold without asking main; a tab already moving is sent once (#554)', async () => {
  const { result } = await mount(layoutOf(FILE, CHANGES));
  let answers: boolean[] = [];
  await act(async () => { answers = [await result.current.moveToWindow('file:src/a.ts'), await result.current.moveToWindow('diff:worktree')]; });
  expect([answers, moveToWindow.mock.calls.length]).toEqual([[false, false], 0]);
  act(() => result.current.close('changes:src/a.ts'));
  let release: () => void = () => undefined;
  moveToWindow.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  let first: Promise<boolean> = Promise.resolve(false);
  let second: Promise<boolean> = Promise.resolve(false);
  act(() => { first = result.current.moveToWindow('file:src/a.ts'); second = result.current.moveToWindow('file:src/a.ts'); });
  expect(moveToWindow).toHaveBeenCalledTimes(1);
  await act(async () => { release(); await first; });
  expect([await second, tabsOf(result.current.layout)]).toEqual([true, []]);
});

test('a changes tab opened while the move is in flight keeps the buffer: the file tab leaves, its model stays (#554)', async () => {
  let release: () => void = () => undefined;
  moveToWindow.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const { result } = await mount(layoutOf(DIFF, FILE));
  let moving: Promise<boolean> = Promise.resolve(false);
  act(() => { moving = result.current.moveToWindow('file:src/a.ts'); });
  act(() => result.current.open(CHANGES));
  await act(async () => { release(); await moving; });
  expect([tabsOf(result.current.layout), models.isDirty(ID, 'src/a.ts')]).toEqual([[DIFF, CHANGES], true]);
});

test('two tabs placed in one batch both land in the activity\'s layout, the last one picked (#554)', async () => {
  const { result } = await mount(layoutOf(DIFF));
  act(() => {
    result.current.place(ACTIVITY, FILE);
    result.current.place(ACTIVITY, { kind: 'run', ptyId: 'W1' });
  });
  const layout = result.current.layouts.I1;
  expect(tabsOf(layout).map((ref) => ref.kind)).toEqual(['diff', 'file', 'run']);
});
