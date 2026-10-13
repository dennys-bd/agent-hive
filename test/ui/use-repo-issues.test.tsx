import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetRepoIssues, useRepoIssues } from '@/hooks/use-repo-issues';
import { emitReadModelEvent } from '@/lib/review-events';
import type { RepoIssues } from '../../src/types';

const answerOf = (state: RepoIssues['state']): RepoIssues => ({ state, total: 0, truncated: false, syncedAt: null, issues: [] });
const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(answerOf(String(input).endsWith('closed') ? 'closed' : 'open')), { status: 200, headers: { 'content-type': 'application/json' } }));
const OPEN_PATH = '/repositories/acme/site/issues?state=open';

beforeEach(() => {
  resetRepoIssues();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('switching the state never shows the previous state\'s issues, not even for one render (#757)', async () => {
  const seen: (RepoIssues['state'] | undefined)[] = [];
  const { result, rerender } = renderHook(({ state }: { state: RepoIssues['state'] }) => {
    const out = useRepoIssues('acme/site', state);
    seen.push(out.issues?.state);
    return out;
  }, { initialProps: { state: 'open' as RepoIssues['state'] } });
  await waitFor(() => expect(result.current.issues?.state).toBe('open'));
  seen.length = 0;
  await act(async () => { rerender({ state: 'closed' }); });
  await waitFor(() => expect(result.current.issues?.state).toBe('closed'));
  expect(seen).not.toContain('open');
});

test('a readModel event of its repository with issues reads the list again; another repository, or only other kinds, does not (#182)', async () => {
  const { result } = renderHook(() => useRepoIssues('acme/site', 'open'));
  await waitFor(() => expect(result.current.issues?.state).toBe('open'));
  fetchMock.mockClear();
  await act(async () => {
    emitReadModelEvent({ repository: 'acme/other', kinds: ['issues'] });
    emitReadModelEvent({ repository: 'acme/site', kinds: ['comments', 'labels', 'repo'] });
  });
  expect(fetchMock).not.toHaveBeenCalledWith(OPEN_PATH);
  await act(async () => { emitReadModelEvent({ repository: 'acme/site', kinds: ['comments', 'issues'] }); });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(OPEN_PATH));
});
