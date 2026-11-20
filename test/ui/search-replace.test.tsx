import { afterEach, expect, test, vi } from 'vitest';
import { setWriteGate, WriteCancelled } from '@/lib/api';
import { fileSpans, replaceIn, segmentsOf, undoReplace } from '@/lib/search-replace';
import type { ReplaceAnswer, SearchFileResult } from '../../src/types';

const QUERY = { q: 'port', isCaseSensitive: false, isWholeWord: false, isRegex: false };
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); setWriteGate(undefined); });

test('segmentsOf cuts the text at every span and gives each match the replacement', () => {
  const match = { line: 1, text: 'a port b port', spans: [[2, 6], [9, 13]] as [number, number][] };
  expect(segmentsOf(match, 'x')).toEqual([
    { kind: 'text', text: 'a ' }, { kind: 'match', text: 'port', replacement: 'x' },
    { kind: 'text', text: ' b ' }, { kind: 'match', text: 'port', replacement: 'x' },
  ]);
});

test('segmentsOf without a replacement leaves the matches bare, and a span at either end gives no empty text', () => {
  const segments = segmentsOf({ line: 1, text: 'port-port', spans: [[0, 4], [5, 9]] }, undefined);
  expect(segments).toEqual([{ kind: 'match', text: 'port' }, { kind: 'text', text: '-' }, { kind: 'match', text: 'port' }]);
});

test('segmentsOf keeps $1 literal', () => {
  expect(segmentsOf({ line: 1, text: 'port', spans: [[0, 4]] }, '$1')).toEqual([{ kind: 'match', text: 'port', replacement: '$1' }]);
});

test('fileSpans counts every span of every row', () => {
  const file: SearchFileResult = { file: 'a.ts', repo: '', matches: [{ line: 1, text: 'port port', spans: [[0, 4], [5, 9]] }, { line: 2, text: 'port', spans: [[0, 4]] }] };
  expect(fileSpans(file)).toBe(3);
});

test('replaceIn posts the request to the activity\'s replace route with the CSRF header', async () => {
  vi.stubGlobal('fetch', fetchMock);
  const answer: ReplaceAnswer = { changed: [], skipped: [] };
  fetchMock.mockResolvedValue(json(answer));
  await expect(replaceIn('a/1', { query: QUERY, replacement: 'x', files: ['a.ts'] })).resolves.toEqual(answer);
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe('/activities/a%2F1/search/replace');
  expect(init?.method).toBe('POST');
  expect(init?.headers).toMatchObject({ 'x-hive-ui': '1' });
  expect(JSON.parse(String(init?.body))).toEqual({ query: QUERY, replacement: 'x', files: ['a.ts'] });
});

test('replaceIn sends nothing when run mode\'s gate is cancelled', async () => {
  vi.stubGlobal('fetch', fetchMock);
  setWriteGate({ ask: () => Promise.reject(new WriteCancelled()), written: vi.fn() });
  await expect(replaceIn('a', { query: QUERY, replacement: 'x', files: ['a.ts'] })).rejects.toBeInstanceOf(WriteCancelled);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('undoReplace puts each previous text back over the answered version, and a 409 skips only that file', async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (_url, init) => (JSON.parse(String(init?.body)).path === 'b.ts' ? json({ error: 'changed' }, 409) : json({ version: 'v3' })));
  const skipped = await undoReplace('a', [
    { path: 'a.ts', previous: 'old a', version: 'v1', count: 1 },
    { path: 'b.ts', previous: 'old b', version: 'v2', count: 2 },
  ]);
  expect(skipped).toEqual(['b.ts']);
  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])).toEqual([
    ['/activities/a/file', 'PUT', { path: 'a.ts', text: 'old a', version: 'v1', format: false }],
    ['/activities/a/file', 'PUT', { path: 'b.ts', text: 'old b', version: 'v2', format: false }],
  ]);
});

test('undoReplace rethrows a refusal that is not a conflict', async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(json({ error: 'read only' }, 403));
  await expect(undoReplace('a', [{ path: 'a.ts', previous: 'x', version: 'v', count: 1 }])).rejects.toThrow('read only');
});
