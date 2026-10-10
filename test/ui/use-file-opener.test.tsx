import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useFileOpener } from '@/hooks/use-file-opener';
import type { LocalActivity } from '@/lib/activities';
import { jsonResponse } from '../fakes';
import { localPairOf } from '../fixtures/work';

// #818: a path that climbs out of a local activity's checkout resolves against the tree's root, read from the tree route, and opens in the
// editor pane: the IDE it went to before is gone
const local: LocalActivity = { kind: 'local', ...localPairOf('site'), workspace: 'site', runs: [], sessions: [], kept: [] };
const fetchMock = vi.fn(async (_url: string) => jsonResponse({ root: '/work/site', files: [], marks: {}, folders: [], ignored: { files: [], folders: [] } }));

beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('a relative path out of a local activity\'s checkout opens as an absolute path against the tree\'s root, posting nothing (#818)', async () => {
  const open = vi.fn();
  const { result } = renderHook(() => useFileOpener([local], open));
  expect(result.current('local/site', '../shared/notes.md')).toBe(true);
  await waitFor(() => expect(open).toHaveBeenCalledWith('local/site', '/work/shared/notes.md', 'file'));
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/activities/local%3Asite/tree']);
});
