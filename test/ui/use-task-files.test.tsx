import { renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, expect, test, vi } from 'vitest';
import { useTaskFiles } from '@/hooks/use-task-files';
import { jsonResponse } from '../fakes';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

test('the task\'s files as the route answers them, once per task; none while loading or with no task; a failure toasts and lists none (#258)', async () => {
  const FILE = { key: 'spec', path: 'docs/spec.md', base: 'worktree' };
  const fetchMock = vi.fn(async (path: string) => (path === '/activities/a-I1/files' ? jsonResponse([FILE]) : jsonResponse({ error: 'boom' }, 500)));
  vi.stubGlobal('fetch', fetchMock);
  const { result, rerender } = renderHook(({ id }) => useTaskFiles(id, 'null'), { initialProps: { id: 'a-I1' as string | undefined } });
  expect(result.current).toEqual([]);
  await waitFor(() => expect(result.current).toEqual([FILE]));
  rerender({ id: 'a-I2' }); // #629: the hook takes the live activity's id
  expect(result.current).toEqual([]);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
  expect(result.current).toEqual([]);
  rerender({ id: undefined });
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/activities/a-I1/files', '/activities/a-I2/files']);
});

test('a new result on the same activity refetches and keeps the current list until the answer (#662)', async () => {
  const SPEC = { key: 'spec', path: 'docs/spec.md', base: 'worktree' };
  const PLAN = { key: 'plan', path: 'docs/plan.md', base: 'worktree' };
  let answer: (files: unknown) => void = () => undefined;
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse([SPEC]))
    .mockReturnValueOnce(new Promise((resolve) => { answer = (files) => resolve(jsonResponse(files)); }));
  vi.stubGlobal('fetch', fetchMock);
  const { result, rerender } = renderHook(({ key }) => useTaskFiles('a-I1', key), { initialProps: { key: '{"spec":"docs/spec.md"}' } });
  await waitFor(() => expect(result.current).toEqual([SPEC]));
  rerender({ key: '{"spec":"docs/spec.md","plan":"docs/plan.md"}' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual([SPEC]); // no flicker while the refetch is in flight
  answer([SPEC, PLAN]);
  await waitFor(() => expect(result.current).toEqual([SPEC, PLAN]));
});
