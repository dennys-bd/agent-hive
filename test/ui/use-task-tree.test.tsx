import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useTaskTree } from '@/hooks/use-task-tree';
import { emitTreeEvent } from '@/lib/tree-events';
import { treeChanged } from '@/lib/tree-place';
import type { TaskTree } from '../../src/types';

const TREE: TaskTree = { root: '/wt', files: ['src/a.ts'], marks: {}, folders: [], ignored: { files: ['debug.log'], folders: ['docs', 'node_modules'] } };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_url: string) => json(TREE));
const reads = (): number => fetchMock.mock.calls.length;
const flush = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('reads the tree once when shown and never again on a timer (#502)', async () => {
  vi.useFakeTimers();
  renderHook(() => useTaskTree('a-I1', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(reads()).toBe(1);
});

test('a tree event of its activity with a path the tree draws, a new path or no paths reads again; one for another activity does not (#502)', async () => {
  const { result } = renderHook(() => useTaskTree('a-I1', true));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  act(() => emitTreeEvent({ type: 'tree', activityId: 'a-other', paths: ['src/a.ts'] }));
  await flush();
  expect(reads()).toBe(1);
  for (const paths of [['src/a.ts'], ['src/new.ts'], undefined]) {
    const before = reads();
    act(() => emitTreeEvent({ type: 'tree', activityId: 'a-I1', ...(paths ? { paths } : {}) }));
    await flush();
    expect(reads()).toBe(before + 1);
  }
});

test('an event whose every path is an ignored file or in an ignored folder, a nested repository\'s own included, reads nothing (#502)', async () => {
  const { result } = renderHook(() => useTaskTree('a-I1', true));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  act(() => emitTreeEvent({ type: 'tree', activityId: 'a-I1', paths: ['debug.log', 'node_modules/pkg/index.js', 'docs'] })); // Q1 (a)
  await flush();
  expect(reads()).toBe(1);
});

test('a window focus and a tree operation read again; reads asked for while one flies give one more after it, never a pile (#502, #818)', async () => {
  let release = (): void => undefined;
  fetchMock.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return json(TREE); });
  renderHook(() => useTaskTree('a-I1', true));
  act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); treeChanged('a-I1'); });
  expect(reads()).toBe(1);
  await act(async () => { release(); });
  await flush();
  expect(reads()).toBe(2);
  act(() => { window.dispatchEvent(new Event('focus')); });
  await flush();
  expect(reads()).toBe(3);
});
