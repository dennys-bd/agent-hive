import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useReview } from '@/hooks/use-review';
import { jsonResponse } from '../fakes';

afterEach(() => vi.unstubAllGlobals());

test('another task drops the previous task\'s review at once, before its own read answers (#591)', async () => {
  const first = { reviewed: [], drafts: [], threads: [], defaultSession: 'new' };
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (String(input) === '/tasks/A/review' ? Promise.resolve(jsonResponse(first)) : new Promise<Response>(() => undefined))));
  const { result, rerender } = renderHook(({ taskId }) => useReview(taskId), { initialProps: { taskId: 'A' } });
  await waitFor(() => expect(result.current.review).toEqual(first));
  rerender({ taskId: 'B' });
  expect(result.current.review).toBeUndefined();
});
