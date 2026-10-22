import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task, TaskTree } from '../../src/types';
import type { TaskActivity } from '@/lib/activities';
import { taskPairOf } from '../fixtures/work';

// #502: the shown files sidebar holds a lease on its tree, and a tree event of its activity redraws it
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const TREE: TaskTree = { root: '/wt/hive-1-task-1', files: ['README.md'], marks: {}, folders: [], ignored: { files: [], folders: ['node_modules'] } };
let tree = TREE;
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith('/tree') ? json(tree) : new Response(null, { status: 204 })));
const requests = (): [string, string][] => fetchMock.mock.calls.map(([url, init]) => [init?.method ?? 'GET', url]);
const side = () => <FileOpenerContext.Provider value={vi.fn<OpenFile>(() => true)}><ActivitySide target={target} tab="files" isShown /></FileOpenerContext.Provider>;

beforeEach(() => { setLanguage('pt'); tree = TREE; fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('the shown files sidebar posts a lease on its tree and deletes it when it unmounts (#502)', async () => {
  const { unmount } = render(side());
  await screen.findByTitle('README.md');
  expect(requests()).toContainEqual(['POST', '/activities/a-I1/tree/watch']);
  unmount();
  expect(requests().some(([method, url]) => method === 'DELETE' && url.startsWith('/activities/a-I1/tree/watch/'))).toBe(true);
});
