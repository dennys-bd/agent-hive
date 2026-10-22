import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useIgnoredFolders } from '@/hooks/use-ignored-folders';
import { emitTreeEvent } from '@/lib/tree-events';

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_url: string) => json({ files: [], folders: [] }));
const folderUrl = (path: string): string => `/activities/a-I1/tree/folder?path=${encodeURIComponent(path)}`;
const EXPANDED: ReadonlySet<string> = new Set(['dist', 'docs', 'docs/agent', 'node_modules']);
const IGNORED = ['dist', 'docs', 'node_modules'];
const ALL = ['dist', 'docs', 'docs/agent', 'node_modules'].map(folderUrl);
const flush = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const readsSince = (from: number): string[] => fetchMock.mock.calls.slice(from).map(([url]) => url).sort();

beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('reads every expanded ignored folder when shown, and never again on a timer (#502)', async () => {
  vi.useFakeTimers();
  renderHook(() => useIgnoredFolders('a-I1', true, EXPANDED, IGNORED));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(readsSince(0)).toEqual([...ALL].sort());
});

test('a tree event of its activity reads again only the expanded folders a path lies in; a path elsewhere or another activity reads none; no paths reads all (#502)', async () => {
  renderHook(() => useIgnoredFolders('a-I1', true, EXPANDED, IGNORED));
  await flush();
  let from = fetchMock.mock.calls.length;
  act(() => emitTreeEvent({ type: 'tree', activityId: 'a-I1', paths: ['node_modules/pkg/index.js'] }));
  await flush();
  expect(readsSince(from)).toEqual([folderUrl('node_modules')]);
  from = fetchMock.mock.calls.length;
  act(() => emitTreeEvent({ type: 'tree', activityId: 'a-I1', paths: ['src/a.ts'] }));
  act(() => emitTreeEvent({ type: 'tree', activityId: 'a-other' }));
  await flush();
  expect(readsSince(from)).toEqual([]);
  act(() => emitTreeEvent({ type: 'tree', activityId: 'a-I1' }));
  await flush();
  expect(readsSince(from)).toEqual([...ALL].sort());
});

test('a nested repository\'s push, paths [repo], reads the expanded folders under it; a window focus reads every expanded folder (#502, #1)', async () => {
  renderHook(() => useIgnoredFolders('a-I1', true, EXPANDED, IGNORED));
  await flush();
  let from = fetchMock.mock.calls.length;
  act(() => emitTreeEvent({ type: 'tree', activityId: 'a-I1', paths: ['docs'] }));
  await flush();
  expect(readsSince(from)).toEqual([folderUrl('docs'), folderUrl('docs/agent')]);
  from = fetchMock.mock.calls.length;
  act(() => { window.dispatchEvent(new Event('focus')); });
  await flush();
  expect(readsSince(from)).toEqual([...ALL].sort());
});
