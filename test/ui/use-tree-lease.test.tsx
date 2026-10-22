import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LEASE_RENEW_MS, useTreeLease } from '@/hooks/use-tree-lease';

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
const calls = (): [string, string, string | undefined][] => fetchMock.mock.calls.map(([url, init]) => [init?.method ?? 'GET', url, init?.body as string | undefined]);
const leaseOf = (body: string | undefined): string => (JSON.parse(body ?? '{}') as { lease: string }).lease;

beforeEach(() => { vi.useFakeTimers(); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('a shown sidebar posts its lease at once and every 10 s, the same lease each time; hidden, it deletes that lease and posts no more (#502)', async () => {
  const { rerender } = renderHook(({ shown }) => useTreeLease('a-I1', shown), { initialProps: { shown: true } });
  await act(async () => { await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 2); });
  const posts = calls();
  expect(posts.map(([method, url]) => [method, url])).toEqual(Array(3).fill(['POST', '/activities/a-I1/tree/watch']));
  const leases = new Set(posts.map(([, , body]) => leaseOf(body)));
  expect(leases.size).toBe(1);
  const [lease] = [...leases];
  rerender({ shown: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 3); });
  expect(calls().slice(3)).toEqual([['DELETE', `/activities/a-I1/tree/watch/${encodeURIComponent(lease)}`, undefined]]);
});

test('a failed post goes to the console and the next renewal posts again (#502)', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'down' }), { status: 500 }));
  renderHook(() => useTreeLease('a-I1', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(error).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS); });
  expect(calls().filter(([method]) => method === 'POST')).toHaveLength(2);
});

test('a switch of activity deletes the old activity\'s lease and posts a fresh one for the new activity; an unmount deletes it (#502)', async () => {
  const { rerender, unmount } = renderHook(({ id }) => useTreeLease(id, true), { initialProps: { id: 'a-I1' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const first = leaseOf(calls()[0][2]);
  rerender({ id: 'a-I2' });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const [deleted, posted] = calls().slice(1);
  expect(deleted).toEqual(['DELETE', `/activities/a-I1/tree/watch/${encodeURIComponent(first)}`, undefined]);
  expect([posted[0], posted[1]]).toEqual(['POST', '/activities/a-I2/tree/watch']);
  expect(leaseOf(posted[2])).not.toBe(first);
  unmount();
  expect(calls().at(-1)?.[0]).toBe('DELETE');
});
