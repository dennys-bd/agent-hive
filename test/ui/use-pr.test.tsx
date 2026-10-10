import { act as run, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { prPath, prReadError, UNKNOWN_RETRY_MS, usePr } from '@/hooks/use-pr';
import { emitPrReviewEvent } from '@/lib/review-events';
import type { PrData } from '../../src/types';
import { fakePrHive, type FakePrHive, PR, PR2, prData, ROUTE } from './pr-harness';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } })); // the toasts are observable without a Toaster

let hive: FakePrHive;
beforeEach(() => { hive = fakePrHive(); vi.mocked(toast.error).mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const gets = (url: string): number => hive.calls.filter((c) => c.method === 'GET' && c.url === url).length;

test('prPath names a PR\'s routes under its repository, by the number its link holds (#758)', () => {
  expect(prPath(PR)).toBe(ROUTE);
  expect(prPath(PR2, '/review')).toBe('/repositories/acme/app/pulls/9/review');
});

test('usePr reads the PR and its file; a refresh keeps the PR shown until its answer; a prReview event of the link reads the file again (#592, #758)', async () => {
  const { result } = renderHook(() => usePr(PR, true));
  await waitFor(() => expect(result.current.load.status).toBe('ready'));
  await waitFor(() => expect(result.current.review).toEqual(hive.review));
  expect(gets(ROUTE)).toBe(1);
  run(() => { void result.current.refresh(); });
  expect(result.current.load.status).toBe('ready');
  await waitFor(() => expect(gets(ROUTE)).toBe(2));
  emitPrReviewEvent(PR2);
  emitPrReviewEvent(PR);
  await waitFor(() => expect(gets(`${ROUTE}/review`)).toBe(2));
});

test('an answer that is no PR reads as an error, never as a PR (#592)', async () => {
  hive.pr = { ok: true } as unknown as PrData;
  const { result } = renderHook(() => usePr(PR, true));
  await waitFor(() => expect(result.current.load).toEqual({ status: 'error', message: 'invalid answer from the server' }));
});

test('GitHub still computing mergeability: the PR is read once more after 3 s, and only once (#592)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hive.pr = prData({ mergeState: 'unknown' });
  renderHook(() => usePr(PR, true));
  await waitFor(() => expect(gets(ROUTE)).toBe(1));
  await run(async () => { await vi.advanceTimersByTimeAsync(UNKNOWN_RETRY_MS); });
  await waitFor(() => expect(gets(ROUTE)).toBe(2));
  await run(async () => { await vi.advanceTimersByTimeAsync(UNKNOWN_RETRY_MS * 2); });
  expect(gets(ROUTE)).toBe(2);
});

test('a PR answer whose reviews, comments, body or approvals are malformed reads as an error, never a crash (#758)', async () => {
  for (const bad of [{ reviews: null }, { comments: 'x' }, { body: null }, { approvals: '1' }]) {
    hive.pr = { ...prData(), ...bad } as unknown as PrData;
    const { result, unmount } = renderHook(() => usePr(PR, true));
    await waitFor(() => expect(result.current.load).toEqual({ status: 'error', message: 'invalid answer from the server' }));
    unmount();
  }
});

test('the unknown-mergeability retry is armed again for another PR: a new url is read once more too (#592)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hive.pr = prData({ mergeState: 'unknown' });
  const { rerender } = renderHook(({ url }) => usePr(url, true), { initialProps: { url: PR } });
  await waitFor(() => expect(gets(ROUTE)).toBe(1));
  await run(async () => { await vi.advanceTimersByTimeAsync(UNKNOWN_RETRY_MS); });
  await waitFor(() => expect(gets(ROUTE)).toBe(2));
  const other = '/repositories/acme/app/pulls/9';
  hive.pr = prData({ url: PR2, mergeState: 'unknown' });
  rerender({ url: PR2 });
  await waitFor(() => expect(gets(other)).toBe(1));
  await run(async () => { await vi.advanceTimersByTimeAsync(UNKNOWN_RETRY_MS); });
  await waitFor(() => expect(gets(other)).toBe(2));
});

const failed = (status?: number): Error => Object.assign(new Error('gh api graphql: raw GitHub text'), status === undefined ? {} : { status });
const GITHUB = "Couldn't read this PR from GitHub. Try again in a moment.";

test('prReadError names a failed read by its status alone: 404, 409, 413 and 502 their own copy; anything else, a network failure included, unexpected (#849)', () => {
  expect([404, 409, 413, 502].map((status) => prReadError(failed(status)))).toEqual([
    'This PR was not found on GitHub.', 'The PR changed while it was read. Refresh.', "This PR's diff is too large to show.", GITHUB,
  ]);
  expect([prReadError(failed(500)), prReadError(failed(400)), prReadError(failed()), prReadError(new TypeError('Failed to fetch')), prReadError('boom')])
    .toEqual(Array(5).fill('Unexpected error.'));
});

test('a failed first read shows the error screen with the human copy and no toast (#849)', async () => {
  hive.answers[`GET ${ROUTE}`] = { status: 404, body: { error: 'PR não encontrado' } };
  const { result } = renderHook(() => usePr(PR, true));
  await waitFor(() => expect(result.current.load).toEqual({ status: 'error', message: 'This PR was not found on GitHub.' }));
  await waitFor(() => expect(result.current.review).toEqual(hive.review));
  expect(toast.error).not.toHaveBeenCalled();
});

test('a failed refresh after a read keeps the PR and shows one toast with the human copy, never GitHub\'s text (#849)', async () => {
  const { result } = renderHook(() => usePr(PR, true));
  await waitFor(() => expect(result.current.load.status).toBe('ready'));
  hive.answers[`GET ${ROUTE}`] = { status: 502, body: { error: "gh api graphql: Could not resolve head ref 'feature'" } };
  await run(async () => { await result.current.refresh(); });
  expect(result.current.load.status).toBe('ready');
  expect(vi.mocked(toast.error).mock.calls).toEqual([[GITHUB]]);
});

test('a failed read of the review file toasts the human copy (#849)', async () => {
  hive.answers[`GET ${ROUTE}/review`] = { status: 500, body: { error: 'EACCES: permission denied' } };
  renderHook(() => usePr(PR, true));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Unexpected error.'));
});
