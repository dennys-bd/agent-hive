import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task, TaskTree } from '../../src/types';
import type { TaskActivity } from '@/lib/activities';
import { taskPairOf } from '../fixtures/work';

// HIVE-22: what git ignores shows dimmed beside the rest, and an ignored folder's children are read from disk only once it is expanded
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const TREE: TaskTree = { root: '/wt/hive-1-task-1', files: ['README.md'], marks: { 'README.md': 'M' }, folders: [], ignored: { files: ['debug.log'], folders: ['node_modules'] } };
const FOLDER_URL = '/activities/a-I1/tree/folder?path=node_modules';
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url.endsWith('/tree')) return json(TREE);
  return url === FOLDER_URL ? json({ files: ['left-pad.js'], folders: [] }) : new Response(null, { status: 204 });
});
const openFile = vi.fn<OpenFile>(() => true);
const side = () => <FileOpenerContext.Provider value={openFile}><ActivitySide target={target} tab="files" isShown onTab={vi.fn()} /></FileOpenerContext.Provider>;
const urls = (): string[] => fetchMock.mock.calls.map(([url]) => url);

beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); openFile.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('an ignored file\'s name is muted and carries no mark, while a changed file keeps its mark\'s colour (HIVE-22)', async () => {
  render(side());
  const log = await screen.findByRole('button', { name: 'debug.log' });
  expect(within(log).getByText('debug.log')).toHaveClass('text-muted-foreground');
  expect(log.querySelector('[data-git-mark]')).toBeNull();
  expect(within(screen.getByTitle('README.md')).getByText('README.md')).toHaveClass('text-waiting');
});

test('node_modules shows muted and collapsed, is not read until expanded, and a file read from it opens in the editor (HIVE-22)', async () => {
  const user = userEvent.setup();
  render(side());
  const modules = await screen.findByRole('button', { name: 'node_modules' });
  expect(within(modules).getByText('node_modules')).toHaveClass('text-muted-foreground');
  expect(modules).toHaveAttribute('aria-expanded', 'false');
  expect(urls()).not.toContain(FOLDER_URL);
  await user.dblClick(modules);
  await user.click(await screen.findByRole('button', { name: 'left-pad.js' }));
  expect(urls()).toContain(FOLDER_URL);
  expect(openFile).toHaveBeenCalledWith('I1', 'node_modules/left-pad.js');
});
