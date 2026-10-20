import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { usePlugins } from '@/hooks/use-plugins';
import { CATALOGUE, itemOf, json, stubFetch } from './plugins-fixtures';

afterEach(() => vi.unstubAllGlobals());
const bodyOf = (call: unknown[] | undefined): unknown => JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));

test('the catalogue is read on entering the view, never before, and again on every entry; the screen starts on the skills list (#313)', async () => {
  const fetchMock = stubFetch();
  const { result, rerender } = renderHook(({ isShown }) => usePlugins(isShown), { initialProps: { isShown: false } });
  expect(fetchMock).not.toHaveBeenCalled();
  rerender({ isShown: true });
  await waitFor(() => expect(result.current.items).toEqual(CATALOGUE));
  expect(result.current.screen).toEqual({ kind: 'list', section: 'skills' });
  rerender({ isShown: false });
  rerender({ isShown: true });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // no polling: entries only
});

test('a create under hive sends kind and name, under a workspace its origin too, then opens the new item and reads the catalogue again (#313)', async () => {
  const fetchMock = stubFetch((body) => json(itemOf(`${(body as { origin?: string }).origin ?? 'hive'}:fresh`), 201));
  const { result } = renderHook(() => usePlugins(true));
  await waitFor(() => expect(result.current.items).toBeDefined());
  let error: unknown = 'unset';
  await act(async () => { error = await result.current.create({ kind: 'skill', name: 'fresh', origin: 'hive' }); });
  expect(error).toBeUndefined();
  expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ kind: 'skill', name: 'fresh' });
  expect(result.current.screen).toEqual({ kind: 'item', id: 'hive:fresh' });
  await act(async () => { await result.current.create({ kind: 'specialist', name: 'fresh', origin: 'hive-site' }); });
  expect(bodyOf(fetchMock.mock.calls.at(-2))).toEqual({ kind: 'specialist', name: 'fresh', origin: 'hive-site' });
  expect(result.current.screen).toEqual({ kind: 'item', id: 'hive-site:fresh' });
  expect(fetchMock).toHaveBeenCalledTimes(5); // read, create, read, create, read
});

test("a refused create answers its status's copy and stays on the list; a failed or malformed read sets hasFailed (#313)", async () => {
  for (const [status, key] of [[400, 'plugins.new.badName'], [409, 'plugins.new.taken'], [404, 'plugins.new.unknownWorkspace'], [500, 'plugins.new.failed']] as const) {
    stubFetch(() => json({ error: 'the server words' }, status));
    const { result, unmount } = renderHook(() => usePlugins(true));
    await waitFor(() => expect(result.current.items).toBeDefined());
    let error: unknown;
    await act(async () => { error = await result.current.create({ kind: 'skill', name: 'x', origin: 'hive' }); });
    expect(error).toBe(key);
    expect(result.current.screen.kind).toBe('list');
    unmount();
  }
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'see hive.log' }, 500)));
  const failed = renderHook(() => usePlugins(true));
  await waitFor(() => expect(failed.result.current.hasFailed).toBe(true));
  failed.unmount();
  vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true })));
  const odd = renderHook(() => usePlugins(true));
  await waitFor(() => expect(odd.result.current.hasFailed).toBe(true));
  expect(odd.result.current.items).toBeUndefined();
});

test("the list's workspace filter is dropped on another section's list and on leaving the view, kept on the same list (#313, decision 12)", async () => {
  stubFetch();
  const { result, rerender } = renderHook(({ isShown }) => usePlugins(isShown), { initialProps: { isShown: true } });
  await waitFor(() => expect(result.current.items).toBeDefined());
  act(() => result.current.setFilter('hive-site'));
  act(() => result.current.open({ kind: 'list', section: 'skills' }));
  expect(result.current.filter).toBe('hive-site');
  act(() => result.current.open({ kind: 'list', section: 'specialists' }));
  expect(result.current.filter).toBeUndefined();
  act(() => result.current.setFilter('hive-site'));
  rerender({ isShown: false });
  expect(result.current.filter).toBeUndefined();
});

test('a read that answers after a newer one is dropped: the newer catalogue stays (#313)', async () => {
  const answers: Array<(r: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve))));
  const { result, rerender } = renderHook(({ isShown }) => usePlugins(isShown), { initialProps: { isShown: true } });
  rerender({ isShown: false });
  rerender({ isShown: true });
  await waitFor(() => expect(answers).toHaveLength(2));
  await act(async () => answers[1]?.(json([itemOf('hive:fresh')])));
  await act(async () => answers[0]?.(json(CATALOGUE)));
  expect(result.current.items?.map((i) => i.id)).toEqual(['hive:fresh']);
});

test('reload reads the catalogue again and lands its answer (#325)', async () => {
  let catalogue = CATALOGUE;
  const fetchMock = stubFetch(undefined, () => catalogue);
  const { result } = renderHook(() => usePlugins(true));
  await waitFor(() => expect(result.current.items).toEqual(CATALOGUE));
  catalogue = [itemOf('hive:fresh')];
  await act(async () => { await result.current.reload(); });
  expect(result.current.items).toEqual([itemOf('hive:fresh')]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('open to another screen kind closes the new-item field or the server form; the same kind keeps it (#334)', async () => {
  stubFetch();
  const { result } = renderHook(() => usePlugins(true));
  await waitFor(() => expect(result.current.items).toBeDefined());
  act(() => result.current.setCreating(true));
  act(() => result.current.open({ kind: 'list', section: 'specialists' }));
  expect(result.current.isCreating).toBe(true);
  act(() => result.current.open({ kind: 'mcp' }));
  expect(result.current.isCreating).toBe(false);
  act(() => result.current.setCreating(true));
  act(() => result.current.open({ kind: 'mcp' }));
  expect(result.current.isCreating).toBe(true);
});
