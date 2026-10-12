import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useFileOpener } from '@/hooks/use-file-opener';
import type { LocalActivity, TaskActivity } from '@/lib/activities';
import type { Task } from '../../src/types';
import { jsonResponse } from '../fakes';
import { localPairOf, taskPairOf } from '../fixtures/work';

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

const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const tasked: TaskActivity = { kind: 'task', ...taskPairOf('I1', { worktree: '/w/hive-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };

test('a .hv.html opens in the design pane, any case, unless the click asks for the editor, a preview or the changes; any other file still opens the editor (#109)', () => {
  const open = vi.fn();
  const { result } = renderHook(() => useFileOpener([tasked], open));
  result.current('I1', 'design/Landing.hv.html');
  result.current('I1', '/w/hive-1/design/OLD.HV.HTML');
  result.current('I1', 'design/Landing.hv.html', undefined, { editor: true });
  result.current('I1', 'design/Landing.hv.html', undefined, { changes: true });
  result.current('I1', 'design/Landing.hv.html', undefined, { preview: true });
  result.current('I1', 'design/page.html');
  expect(open.mock.calls).toEqual([
    ['I1', 'design/Landing.hv.html', 'design'], ['I1', 'design/OLD.HV.HTML', 'design'], ['I1', 'design/Landing.hv.html', 'file'],
    ['I1', 'design/Landing.hv.html', 'changes'], ['I1', 'design/Landing.hv.html', 'preview'], ['I1', 'design/page.html', 'file'],
  ]);
});
