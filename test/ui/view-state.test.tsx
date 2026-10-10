import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadViewState, readView, resetViewState, VIEW_WRITE_DELAY_MS, writeView } from '@/lib/view-state';
import { VIEW_KEYS } from '../../src/view-state';

// The dashboard's view state (#484): one load before the first render, synchronous reads, one debounced post per key, a flush on pagehide.
const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply({ ok: true }));
// Each POST as [path, body, keepalive, x-hive-ui]
const posts = (): [string, unknown, boolean, string | undefined][] => fetchMock.mock.calls
  .filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => [String(url), JSON.parse(String(init?.body)), init?.keepalive === true, new Headers(init?.headers).get('x-hive-ui') ?? undefined]);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  resetViewState();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('loadViewState reads GET /view-state into the snapshot; readView answers from it synchronously (#484)', async () => {
  fetchMock.mockImplementation(async () => reply({ splitEdge: 'bottom', consoleHeight: 300 }));
  expect(await loadViewState()).toEqual({ splitEdge: 'bottom', consoleHeight: 300 });
  expect(fetchMock).toHaveBeenCalledWith('/view-state');
  expect([readView('splitEdge'), readView('consoleHeight'), readView('dockLayout')]).toEqual(['bottom', 300, undefined]);
});

test('a failed load is logged and reads every key as undefined, so every consumer shows its defaults (#484)', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  resetViewState({ splitEdge: 'bottom' });
  fetchMock.mockRejectedValueOnce(new TypeError('offline'));
  expect(await loadViewState()).toEqual({});
  expect(VIEW_KEYS.map((key) => readView(key))).toEqual(VIEW_KEYS.map(() => undefined));
  expect(error).toHaveBeenCalled();
});

test('a load that answers anything but a plain object reads as {}, so readView never throws (#484)', async () => {
  for (const body of [null, [1], 'x']) {
    fetchMock.mockImplementationOnce(async () => reply(body));
    expect(await loadViewState()).toEqual({});
    expect(readView('splitEdge')).toBeUndefined();
  }
});

test('three writes of one key within the delay post once, with the last value; the snapshot holds each value at once (#484)', async () => {
  writeView('consoleHeight', 200);
  await vi.advanceTimersByTimeAsync(VIEW_WRITE_DELAY_MS - 1);
  writeView('consoleHeight', 300);
  await vi.advanceTimersByTimeAsync(VIEW_WRITE_DELAY_MS - 1);
  writeView('consoleHeight', 400);
  expect(readView('consoleHeight')).toBe(400);
  expect(posts()).toEqual([]);
  await vi.advanceTimersByTimeAsync(VIEW_WRITE_DELAY_MS);
  expect(posts()).toEqual([['/view-state/consoleHeight', { value: 400 }, false, '1']]);
});

test('different keys post separately, each with its own value (#484)', async () => {
  writeView('splitEdge', 'bottom');
  writeView('lastWorkspace', 'site');
  await vi.advanceTimersByTimeAsync(VIEW_WRITE_DELAY_MS);
  expect(posts()).toEqual([
    ['/view-state/splitEdge', { value: 'bottom' }, false, '1'],
    ['/view-state/lastWorkspace', { value: 'site' }, false, '1'],
  ]);
});

test('pagehide posts every pending key at once with keepalive and the x-hive-ui header; nothing posts again after the delay (#484)', async () => {
  const layout = { docks: { automation: 'left', activities: 'left', detail: 'right' } };
  writeView('dockLayout', layout);
  writeView('splitEdge', 'right');
  window.dispatchEvent(new Event('pagehide'));
  expect(posts()).toEqual([
    ['/view-state/dockLayout', { value: layout }, true, '1'],
    ['/view-state/splitEdge', { value: 'right' }, true, '1'],
  ]);
  await vi.advanceTimersByTimeAsync(VIEW_WRITE_DELAY_MS);
  expect(posts()).toHaveLength(2);
});

test('a post that fails is reported with console.error naming the key, and the snapshot keeps the value (#484)', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fetchMock.mockImplementation(async () => reply({ error: 'view state not written' }, 500));
  writeView('stageFilters', { dev: [] });
  await vi.advanceTimersByTimeAsync(VIEW_WRITE_DELAY_MS);
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith('view state: stageFilters not saved', expect.any(Error)));
  expect(readView('stageFilters')).toEqual({ dev: [] });
});
