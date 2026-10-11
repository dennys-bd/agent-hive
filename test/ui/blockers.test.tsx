import { afterEach, expect, test, vi } from 'vitest';
import { editBlocker, findBlockerCandidates } from '@/lib/blockers-api';
import type { BlockerChange, BlockerRef, ItemBlockers } from '../../src/types';
import { jsonResponse } from '../fakes';

afterEach(() => vi.unstubAllGlobals());

test('editBlocker posts the change to the item\'s blockers route and resolves to the answered blockers (#56)', async () => {
  const blockers: ItemBlockers = { blockedBy: [{ id: '7', title: 'T7', state: 'open' }], blocking: [] };
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ blockers }));
  vi.stubGlobal('fetch', fetchMock);
  const change: BlockerChange = { action: 'add', kind: 'blockedBy', ref: '#7' };
  expect(await editBlocker('work', 'work:PVTI_1', change)).toEqual(blockers);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/sources/work/items/work%3APVTI_1/blockers');
  expect([init?.method, JSON.parse(String(init?.body)), new Headers(init?.headers).get('x-hive-ui')]).toEqual(['POST', change, '1']);
});

test('editBlocker rejects with the answer\'s code and status, for the caller to map to its copy (#56)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'no such issue or task to relate', code: 'blockers.unknownRef' }, 404)));
  await expect(editBlocker('hive', 'local:1', { action: 'add', kind: 'blockedBy', ref: 'HIVE-9' })).rejects.toMatchObject({ code: 'blockers.unknownRef', status: 404 });
});

test('findBlockerCandidates gets the candidates route with the text as q and the caller\'s signal, resolving to the refs (#57)', async () => {
  const candidates: BlockerRef[] = [{ id: '31', title: 'Pager', state: 'open' }];
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ candidates }));
  vi.stubGlobal('fetch', fetchMock);
  const controller = new AbortController();
  expect(await findBlockerCandidates('work', 'work:PVTI_1', 'pager #2', controller.signal)).toEqual(candidates);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/sources/work/items/work%3APVTI_1/blockers/candidates?q=pager%20%232');
  expect(init?.signal).toBe(controller.signal);
});
