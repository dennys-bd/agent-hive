import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { leaveFlow, takeToFlow } from '@/components/tasks/flow-actions';
import { jsonResponse } from '../fakes';
import type { Task } from '../../src/types';

const TASK: Task = { item: { itemId: 'gh/a b#1', id: '1', title: 'Flaky', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
let answer = (): Response => jsonResponse({ ok: true });
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer());

beforeEach(() => { answer = () => jsonResponse({ ok: true }); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('takeToFlow posts move-to with the stage and resolves undefined when the route accepts', async () => {
  await expect(takeToFlow(TASK, 'spec')).resolves.toBeUndefined();
  const [url, init] = fetchMock.mock.calls[0];
  expect([url, init?.method, JSON.parse(String(init?.body))]).toEqual(['/tasks/gh%2Fa%20b%231/move-to', 'POST', { stage: 'spec' }]);
});

test('leaveFlow posts leave-flow and resolves undefined when the route accepts', async () => {
  await expect(leaveFlow(TASK)).resolves.toBeUndefined();
  const [url, init] = fetchMock.mock.calls[0];
  expect([url, init?.method]).toEqual(['/tasks/gh%2Fa%20b%231/leave-flow', 'POST']);
});

test('a refusal resolves to the route message', async () => {
  answer = () => jsonResponse({ error: 'a worker está executando' }, 409);
  await expect(takeToFlow(TASK, 'spec')).resolves.toBe('a worker está executando');
  await expect(leaveFlow(TASK)).resolves.toBe('a worker está executando');
});
