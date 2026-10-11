import { afterEach, expect, test, vi } from 'vitest';
import { createTaskFromPr } from '@/lib/api';
import { jsonResponse } from '../fakes';

afterEach(() => { vi.unstubAllGlobals(); });

test('createTaskFromPr posts the PR to POST /tasks as pr, in hive, with the caller\'s title, stage and auto, and answers the new task (#67)', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ id: 'HIVE-1', itemId: 'local:1' }, 201));
  vi.stubGlobal('fetch', fetchMock);
  const link = 'https://github.com/acme/app/pull/7';
  expect(await createTaskFromPr({ url: link, title: 'The PR', stage: 'dev', auto: false })).toEqual({ id: 'HIVE-1', itemId: 'local:1' });
  const [path, init] = fetchMock.mock.calls[0];
  expect([String(path), init?.method, new Headers(init?.headers).get('x-hive-ui'), JSON.parse(String(init?.body))])
    .toEqual(['/tasks', 'POST', '1', { title: 'The PR', stage: 'dev', auto: false, pr: link, source: 'hive' }]);
});
