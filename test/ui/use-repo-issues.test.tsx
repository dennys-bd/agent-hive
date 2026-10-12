import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetRepoIssues, useRepoIssues } from '@/hooks/use-repo-issues';
import type { RepoIssues } from '../../src/types';

const answerOf = (state: RepoIssues['state']): RepoIssues => ({ state, total: 0, truncated: false, syncedAt: null, issues: [] });
const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(answerOf(String(input).endsWith('closed') ? 'closed' : 'open')), { status: 200, headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  resetRepoIssues();
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
