import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useIssue } from '@/hooks/use-issue';
import { emitReadModelEvent } from '@/lib/review-events';
import type { IssuePage } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const ISSUE: IssuePage = {
  repository: 'acme/site', number: 12, title: 'Pager breaks', url: 'https://github.com/acme/site/issues/12', labels: [], assignees: [], updatedAt: '2026-10-05T09:00:00Z',
  pullRequests: [], body: '', author: 'bia', createdAt: '2026-10-01T09:00:00Z', comments: [], commentCount: 0,
};
const PATH = '/repositories/acme/site/issues/12';
const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(ISSUE), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const opened = async () => {
  const hook = renderHook(() => useIssue('acme/site', 12));
  await waitFor(() => expect(hook.result.current.load.kind).toBe('issue'));
  fetchMock.mockClear();
  return hook;
};

test('the issue page reads again on an issues or a comments change of its repository, whatever issue changed (#182)', async () => {
  await opened();
  for (const kind of ['issues', 'comments']) {
    fetchMock.mockClear();
    await act(async () => { emitReadModelEvent({ repository: 'acme/site', kinds: [kind] }); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(PATH));
  }
});

test('the issue page does not read again on labels or repo, nor on another repository\'s change (#182)', async () => {
  await opened();
  await act(async () => {
    emitReadModelEvent({ repository: 'acme/site', kinds: ['labels', 'repo'] });
    emitReadModelEvent({ repository: 'acme/other', kinds: ['issues', 'comments'] });
  });
  expect(fetchMock).not.toHaveBeenCalledWith(PATH);
});
