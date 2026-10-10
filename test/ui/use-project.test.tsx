import { act, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { forgetProjects, useProject } from '@/hooks/use-project';
import { setLanguage } from '@/i18n';
import type { ProjectView } from '../../src/types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const view = (title: string): ProjectView => ({
  statuses: [], fields: [], builtins: {}, truncated: false,
  items: [{ itemId: 'roadmap:PVTI_1', id: '1', title, body: '', url: 'https://github.com/acme/r/issues/1', labels: [], assignees: [], fields: {}, pullRequests: [] }],
});
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A read the test answers when it wants: what lets it look at the hook while the read is in flight
function pending(): { settle(res: Response): void } {
  const gate = { settle: (_res: Response): void => undefined };
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { gate.settle = resolve; }));
  return gate;
}
const fetchMock = vi.fn(async (_input: RequestInfo | URL): Promise<Response> => jsonRes(view('first')));
const titleOf = (state: ReturnType<typeof useProject>['project']): string | undefined => (state.kind === 'view' ? state.view.items[0].title : undefined);

beforeEach(() => {
  setLanguage('pt');
  forgetProjects();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jsonRes(view('first')));
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('a second open shows the cached view at once and replaces it with the new read (#756)', async () => {
  const first = renderHook(() => useProject('roadmap'));
  await waitFor(() => expect(titleOf(first.result.current.project)).toBe('first'));
  first.unmount();
  const gate = pending();
  const second = renderHook(() => useProject('roadmap'));
  expect(titleOf(second.result.current.project)).toBe('first'); // no lendo…: the cache shows while the read runs
  await act(async () => gate.settle(jsonRes(view('second'))));
  expect(titleOf(second.result.current.project)).toBe('second');
});

test('the cache is per source: another source reads with nothing to show (#756)', async () => {
  const first = renderHook(() => useProject('roadmap'));
  await waitFor(() => expect(titleOf(first.result.current.project)).toBe('first'));
  pending();
  const other = renderHook(() => useProject('notes'));
  expect(other.result.current.project.kind).toBe('loading');
});

test('a reload keeps the rows on screen until the read answers (#756)', async () => {
  const { result } = renderHook(() => useProject('roadmap'));
  await waitFor(() => expect(titleOf(result.current.project)).toBe('first'));
  const gate = pending();
  let reading: Promise<void> = Promise.resolve();
  act(() => { reading = result.current.reload(); });
  expect(titleOf(result.current.project)).toBe('first');
  await act(async () => { gate.settle(jsonRes(view('after'))); await reading; });
  expect(titleOf(result.current.project)).toBe('after');
});

test('a failed read with a cached view keeps the rows and toasts; with none it is the error state (#756)', async () => {
  const { result } = renderHook(() => useProject('roadmap'));
  await waitFor(() => expect(titleOf(result.current.project)).toBe('first'));
  fetchMock.mockImplementation(async () => jsonRes({ error: 'Bad credentials' }, 502));
  await act(() => result.current.reload());
  expect(titleOf(result.current.project)).toBe('first');
  expect(toast.error).toHaveBeenCalledWith('Bad credentials');
  const other = renderHook(() => useProject('notes'));
  await waitFor(() => expect(other.result.current.project).toEqual({ kind: 'error', message: 'Bad credentials' }));
});

test('a slow older read never overwrites the newer cached view (#756)', async () => {
  const { result, unmount } = renderHook(() => useProject('roadmap'));
  await waitFor(() => expect(titleOf(result.current.project)).toBe('first'));
  const older = pending();
  const newer = pending();
  let reads: Promise<void>[] = [];
  act(() => { reads = [result.current.reload(), result.current.reload()]; });
  await act(async () => { newer.settle(jsonRes(view('newer'))); older.settle(jsonRes(view('older'))); await Promise.all(reads); });
  expect(titleOf(result.current.project)).toBe('newer');
  unmount();
  pending();
  expect(titleOf(renderHook(() => useProject('roadmap')).result.current.project)).toBe('newer');
});

test('replaceRow swaps one row of the shown view and of the cache, with no read (#686)', async () => {
  const { result, unmount } = renderHook(() => useProject('roadmap'));
  await waitFor(() => expect(titleOf(result.current.project)).toBe('first'));
  const reads = fetchMock.mock.calls.length;
  const [row] = view('first').items;
  act(() => result.current.replaceRow({ ...row, title: 'written' }));
  expect(titleOf(result.current.project)).toBe('written');
  expect(fetchMock.mock.calls.length).toBe(reads);
  unmount();
  pending();
  expect(titleOf(renderHook(() => useProject('roadmap')).result.current.project)).toBe('written');
});
