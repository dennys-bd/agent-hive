import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useComments } from '@/hooks/use-comments';
import { jsonResponse } from '../fakes';

const COMMENT = { author: 'dennys-bd', createdAt: '2026-09-20T10:00:00Z', body: 'lgtm', url: 'https://github.com/acme/r/issues/1#issuecomment-1' };

afterEach(() => vi.unstubAllGlobals());

test('loading first, then the list the route answers for the task; null is a board without comments; no task, no call', async () => {
  const fetchMock = vi.fn(async (path: string) => jsonResponse(path === '/tasks/I1/comments' ? [COMMENT] : null));
  vi.stubGlobal('fetch', fetchMock);
  const { result, rerender } = renderHook(({ id }) => useComments(id), { initialProps: { id: 'I1' as string | undefined } });
  expect(result.current).toEqual({ kind: 'loading' });
  await waitFor(() => expect(result.current).toEqual({ kind: 'list', comments: [COMMENT] }));
  rerender({ id: 'I2' });
  await waitFor(() => expect(result.current).toEqual({ kind: 'unsupported' }));
  rerender({ id: undefined });
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/tasks/I1/comments', '/tasks/I2/comments']);
});

test('a refusal is the error state carrying the route\'s message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'github api: HTTP 502' }, 502)));
  const { result } = renderHook(() => useComments('I1'));
  await waitFor(() => expect(result.current).toEqual({ kind: 'error', message: 'github api: HTTP 502' }));
});

test('an answer for a task that is no longer selected is dropped', async () => {
  const pending: Record<string, (res: Response) => void> = {};
  vi.stubGlobal('fetch', vi.fn((path: string) => new Promise<Response>((resolve) => { pending[path] = resolve; })));
  const { result, rerender } = renderHook(({ id }) => useComments(id), { initialProps: { id: 'I1' } });
  rerender({ id: 'I2' });
  await act(async () => { pending['/tasks/I2/comments'](jsonResponse([])); });
  await waitFor(() => expect(result.current).toEqual({ kind: 'list', comments: [] }));
  await act(async () => {
    pending['/tasks/I1/comments'](jsonResponse([COMMENT]));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(result.current).toEqual({ kind: 'list', comments: [] });
});
