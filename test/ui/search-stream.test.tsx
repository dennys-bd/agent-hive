import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readLines, reduceLine, searchUrl, START, useSearch, type SearchView } from '@/lib/search-stream';
import type { SearchLine, SearchQuery } from '../../src/types';

const QUERY: SearchQuery = { q: 'daemon', isCaseSensitive: false, isWholeWord: false, isRegex: true };
const FILE: SearchLine = { file: 'src/daemon.ts', repo: '', matches: [{ line: 12, text: 'export const daemonPort', spans: [[13, 23]] }, { line: 31, text: 'daemonPort daemonPort', spans: [[0, 10], [11, 21]] }] };
const END: SearchLine = { done: true, total: 3, files: 1, capped: false, repos: ['docs'] };

const enc = new TextEncoder();
const ndjson = (...lines: SearchLine[]): { res: Response; push(line: SearchLine): void; end(): void } => {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
  const push = (line: SearchLine): void => { ctrl.enqueue(enc.encode(`${JSON.stringify(line)}\n`)); };
  lines.forEach(push);
  return { res: new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), push, end: () => ctrl.close() };
};
const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('reduceLine appends a file without touching the old view, keeps the span total, ends in done and turns an error line into error', () => {
  const running = reduceLine(START, FILE);
  expect(START).toEqual({ kind: 'running', files: [], total: 0, repos: [] });
  expect(running).toEqual({ kind: 'running', files: [FILE], total: 3, repos: [] });
  expect(reduceLine(running, END)).toEqual({ kind: 'done', files: [FILE], end: END });
  expect(reduceLine(running, { error: 'bad' })).toEqual({ kind: 'error', message: 'bad', repos: [] });
});

test('readLines joins a line split across two chunks and counts a last line with no line break', async () => {
  const text = `${JSON.stringify(FILE)}\n${JSON.stringify(END)}`;
  const cut = 20;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(text.slice(0, cut))); c.enqueue(enc.encode(text.slice(cut))); c.close(); } });
  const got: SearchLine[] = [];
  await readLines(new Response(body), (line) => got.push(line));
  expect(got).toEqual([FILE, END]);
});

test('searchUrl encodes the activity and the query with 1 / 0 flags', () => {
  expect(searchUrl('a/b', { q: 'x y', isCaseSensitive: true, isWholeWord: false, isRegex: false })).toBe('/activities/a%2Fb/search?q=x+y&case=1&word=0&regex=0');
});

test('three query changes inside 300 ms make one fetch', async () => {
  fetchMock.mockImplementation(async () => ndjson(FILE, END).res);
  const { rerender } = renderHook(({ q }) => useSearch('A1', { ...QUERY, q }, 0), { initialProps: { q: 'd' } });
  rerender({ q: 'da' });
  act(() => { vi.advanceTimersByTime(100); });
  rerender({ q: 'dae' });
  act(() => { vi.advanceTimersByTime(299); });
  expect(fetchMock).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/activities/A1/search?q=dae&case=0&word=0&regex=1');
});

test('a new query aborts the previous search and its late lines never reach the view', async () => {
  const first = ndjson(FILE);
  fetchMock.mockImplementationOnce(async () => first.res).mockImplementation(async () => ndjson({ ...FILE, file: 'second.ts' }, END).res);
  const { result, rerender } = renderHook(({ q }) => useSearch('A1', { ...QUERY, q }, 0), { initialProps: { q: 'one' } });
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  expect(result.current.view).toMatchObject({ kind: 'running', files: [FILE] });
  rerender({ q: 'two' });
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  first.push({ ...FILE, file: 'late.ts' });
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  const view = result.current.view as Extract<SearchView, { kind: 'done' }>;
  expect(view.kind).toBe('done');
  expect(view.files.map((f) => f.file)).toEqual(['second.ts']);
});

test('the view streams: running with the first file before the end, then done', async () => {
  const stream = ndjson(FILE);
  fetchMock.mockImplementation(async () => stream.res);
  const { result } = renderHook(() => useSearch('A1', QUERY, 0));
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  expect(result.current.view).toMatchObject({ kind: 'running', total: 3 });
  stream.push(END);
  stream.end();
  await flush();
  expect(result.current.view).toEqual({ kind: 'done', files: [FILE], end: END });
});

test('a 409 refusal is unavailable, a 500 is an error with its message', async () => {
  const json = (status: number, error: string): Response => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
  fetchMock.mockImplementationOnce(async () => json(409, 'no worktree')).mockImplementationOnce(async () => json(500, 'boom'));
  const { result, rerender } = renderHook(({ q }) => useSearch('A1', { ...QUERY, q }, 0), { initialProps: { q: 'a' } });
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  expect(result.current.view).toEqual({ kind: 'unavailable' });
  rerender({ q: 'b' });
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  expect(result.current.view).toEqual({ kind: 'error', message: 'boom', repos: [] });
});

test('an empty query asks once with no debounce and gives idle with the repos', async () => {
  fetchMock.mockImplementation(async () => ndjson({ done: true, total: 0, files: 0, capped: false, repos: ['docs'] }).res);
  const { result } = renderHook(() => useSearch('A1', { ...QUERY, q: '' }, 0));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.current.view).toEqual({ kind: 'idle', repos: ['docs'] });
});

test('bumping run searches again with the same query', async () => {
  fetchMock.mockImplementation(async () => ndjson(FILE, END).res);
  const { rerender } = renderHook(({ run }) => useSearch('A1', QUERY, run), { initialProps: { run: 0 } });
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  rerender({ run: 1 });
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([searchUrl('A1', QUERY), searchUrl('A1', QUERY)]);
});

test('the view answers the current query only once its own search has started: typing makes it stale, the next stream makes it current', async () => {
  fetchMock.mockImplementation(async () => ndjson(FILE, END).res);
  const { result, rerender } = renderHook(({ q }) => useSearch('A1', { ...QUERY, q }, 0), { initialProps: { q: 'one' } });
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  expect(result.current).toMatchObject({ view: { kind: 'done' }, isCurrent: true });
  rerender({ q: 'two' });
  expect(result.current).toMatchObject({ view: { kind: 'done' }, isCurrent: false });
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  expect(result.current.isCurrent).toBe(true);
});

test('a run bump makes the old view stale too: it holds the files from before the replace', async () => {
  fetchMock.mockImplementation(async () => ndjson(FILE, END).res);
  const { result, rerender } = renderHook(({ run }) => useSearch('A1', QUERY, run), { initialProps: { run: 0 } });
  act(() => { vi.advanceTimersByTime(300); });
  await flush();
  rerender({ run: 1 });
  expect(result.current.isCurrent).toBe(false);
});
