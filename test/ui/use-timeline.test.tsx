import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useTimeline } from '@/hooks/use-timeline';
import type { TimelineEvent } from '../../src/server-timeline';
import { jsonResponse } from '../fakes';

vi.mock('@/hooks/use-timeline', async (importOriginal) => importOriginal()); // test/ui/setup.ts replaces it in every other file

const EVENTS: TimelineEvent[] = [{ kind: 'pr', ts: '2026-09-29T16:52:00.000Z', pr: 515 }];
const LIST = { kind: 'list', timeline: { events: EVENTS } } as const;
const EMPTY = { kind: 'list', timeline: { events: [] } } as const;

afterEach(() => vi.unstubAllGlobals());

test('loading first, then the list the route answers, read by the encoded item id (#961)', async () => {
  const fetchMock = vi.fn(async (_path: string) => jsonResponse({ events: EVENTS }));
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useTimeline('work:PVTI 1', 'dev:0:false'));
  expect(result.current.read).toEqual({ kind: 'loading' });
  await waitFor(() => expect(result.current.read).toEqual(LIST));
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/tasks/work%3APVTI%201/timeline']);
});

test('a 503 and an answer of another shape are the failed state; retry reads again, with the skeleton meanwhile (#961)', async () => {
  const answers = [jsonResponse({ error: 'the usage store is off' }, 503), jsonResponse({}), jsonResponse({ events: [] })];
  const fetchMock = vi.fn(async (_path: string) => answers.shift()!);
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useTimeline('I1', 'dev:0:false'));
  await waitFor(() => expect(result.current.read).toEqual({ kind: 'error' }));
  act(() => result.current.retry());
  expect(result.current.read).toEqual({ kind: 'loading' });
  await waitFor(() => expect(result.current.read).toEqual({ kind: 'error' })); // {} carries no events
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.read).toEqual(EMPTY));
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('a new run key reads again and keeps the list until the answer replaces it; the same key reads nothing (#961)', async () => {
  const pending: ((res: Response) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve); })));
  const { result, rerender } = renderHook(({ runKey }) => useTimeline('I1', runKey), { initialProps: { runKey: 'dev:0:true' } });
  await act(async () => { pending[0](jsonResponse({ events: [] })); });
  await waitFor(() => expect(result.current.read).toEqual(EMPTY));
  rerender({ runKey: 'dev:1:false' });
  expect(pending).toHaveLength(2);
  expect(result.current.read).toEqual(EMPTY);
  await act(async () => { pending[1](jsonResponse({ events: EVENTS })); });
  await waitFor(() => expect(result.current.read).toEqual(LIST));
  rerender({ runKey: 'dev:1:false' });
  expect(pending).toHaveLength(2);
});

test('a late answer is dropped: the one for another task, and an older read of the same task (#961)', async () => {
  const pending: Record<string, ((res: Response) => void)[]> = {};
  vi.stubGlobal('fetch', vi.fn((path: string) => new Promise<Response>((resolve) => { pending[path] = [...(pending[path] ?? []), resolve]; })));
  const { result, rerender } = renderHook(({ id, runKey }) => useTimeline(id, runKey), { initialProps: { id: 'I1', runKey: 'a' } });
  rerender({ id: 'I1', runKey: 'b' });
  rerender({ id: 'I2', runKey: 'b' });
  await act(async () => { pending['/tasks/I2/timeline'][0](jsonResponse({ events: [] })); });
  await waitFor(() => expect(result.current.read).toEqual(EMPTY));
  await act(async () => {
    pending['/tasks/I1/timeline'][0](jsonResponse({ events: EVENTS }));
    pending['/tasks/I1/timeline'][1](jsonResponse({ events: EVENTS }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(result.current.read).toEqual(EMPTY);
});
