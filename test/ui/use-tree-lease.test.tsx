import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { onTreeChanged } from '@/lib/tree-place';
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

test('the first successful post reads the tree once: a change before the watch started is not lost; a plain renewal reads nothing (#502)', async () => {
  const read = vi.fn();
  const stop = onTreeChanged('a-I1', read);
  renderHook(() => useTreeLease('a-I1', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 2); });
  expect(read).toHaveBeenCalledTimes(1);
  stop();
});

test('a post that succeeds after a failed one reads the tree again, the lease having lapsed meanwhile (#502)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const read = vi.fn();
  const stop = onTreeChanged('a-I1', read);
  fetchMock.mockImplementationOnce(async () => new Response(null, { status: 500 }));
  renderHook(() => useTreeLease('a-I1', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(read).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS); });
  expect(read).toHaveBeenCalledTimes(1);
  stop();
});

test('a renewal later than the daemon\'s TTL (throttled timers) reads the tree again (#502)', async () => {
  const read = vi.fn();
  const stop = onTreeChanged('a-I1', read);
  renderHook(() => useTreeLease('a-I1', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  read.mockClear();
  vi.setSystemTime(Date.now() + 60_000);
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
  expect(read).toHaveBeenCalledTimes(1);
  stop();
});

test('window focus and a tab turning visible post the lease at once (#502)', async () => {
  renderHook(() => useTreeLease('a-I1', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const before = calls().length;
  await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
  expect(calls().length).toBe(before + 1);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
  expect(calls().length).toBe(before + 2); // jsdom's document is visible
  expect(calls().at(-1)?.[0]).toBe('POST');
});
