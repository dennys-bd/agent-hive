import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useReview } from '@/hooks/use-review';
import { emitReviewEvent, localReview, taskReview } from '@/lib/review-events';
import { jsonResponse } from '../fakes';

afterEach(() => vi.unstubAllGlobals());

test('another task drops the previous task\'s review at once, before its own read answers (#591)', async () => {
  const first = { reviewed: [], drafts: [], threads: [], defaultSession: 'new' };
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (String(input) === '/tasks/A/review' ? Promise.resolve(jsonResponse(first)) : new Promise<Response>(() => undefined))));
  const { result, rerender } = renderHook(({ key }) => useReview(key), { initialProps: { key: taskReview('A') } });
  await waitFor(() => expect(result.current.review).toEqual(first));
  rerender({ key: taskReview('B') });
  expect(result.current.review).toBeUndefined();
});

test('a local review reads /workspaces/<ws>/review and reads again on its own event only, never on a task\'s nor another workspace\'s (#345)', async () => {
  const fetchMock = vi.fn(async (_url: string) => jsonResponse({ reviewed: [], drafts: [], threads: [] }));
  vi.stubGlobal('fetch', fetchMock);
  renderHook(() => useReview(localReview('hive')));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock.mock.calls[0][0]).toBe('/workspaces/hive/review');
  act(() => emitReviewEvent(taskReview('hive')));
  act(() => emitReviewEvent(localReview('site')));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  act(() => emitReviewEvent(localReview('hive')));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});
