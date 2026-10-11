import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { FolderEntries, Task, TaskTree } from '../../src/types';
import type { TaskActivity } from '@/lib/activities';
import { taskPairOf } from '../fixtures/work';

// HIVE-22: what git ignores shows dimmed beside the rest, and an ignored folder's children are read from disk only once it is expanded
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const TREE: TaskTree = { root: '/wt/hive-1-task-1', files: ['README.md'], marks: { 'README.md': 'M' }, folders: [], ignored: { files: ['debug.log'], folders: ['docs', 'node_modules'] } };
const FOLDER = '/activities/a-I1/tree/folder?path=';
const FOLDER_URL = `${FOLDER}node_modules`;
// #1: docs is a nested repository, so the route answers its view of each of its folders
const FOLDERS: Record<string, FolderEntries> = {
  [FOLDER_URL]: { files: ['left-pad.js'], folders: [] },
  [`${FOLDER}docs`]: { files: ['README.md'], folders: ['agent'], repo: { marks: {}, ignored: [] } },
  [`${FOLDER}docs%2Fagent`]: { files: ['foo.md', 'old.log'], folders: [], repo: { marks: { 'foo.md': 'M' }, ignored: ['old.log'] } },
};
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url.endsWith('/tree')) return json(TREE);
  const folder = FOLDERS[url];
  return folder ? json(folder) : new Response(null, { status: 204 });
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
  expect(within(screen.getByTitle('README.md')).getByText('README.md')).toHaveClass('text-git-modified');
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

test('a nested repository is not read while collapsed; expanded, its changed file shows the M mark, a tracked one plain and one it ignores dimmed, docs itself taking the M over its dimming (#1, #903)', async () => {
  const user = userEvent.setup();
  render(side());
  const docs = await screen.findByRole('button', { name: 'docs' });
  expect(urls().filter((url) => url.startsWith(`${FOLDER}docs`))).toEqual([]);
  await user.dblClick(docs);
  await user.dblClick(await screen.findByRole('button', { name: 'agent' }));
  const foo = await screen.findByTitle('docs/agent/foo.md');
  expect(within(foo).getByText('foo.md')).toHaveClass('text-git-modified');
  expect(foo.querySelector('[data-git-mark]')).toHaveTextContent('M');
  expect(within(screen.getByTitle('docs/agent/old.log')).getByText('old.log')).toHaveClass('text-muted-foreground');
  expect(within(screen.getByTitle('docs/README.md')).getByText('README.md')).toHaveClass('text-foreground');
  // #903: the M under it wins over the dimming
  expect(within(docs).getByText('docs')).toHaveClass('text-git-modified');
});
