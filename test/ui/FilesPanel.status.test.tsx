import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import * as store from '@/lib/diagnostics-store';
import { problemsOf } from './problem-fake';
import type { FolderEntries, Task, TaskTree } from '../../src/types';
import type { TaskActivity } from '@/lib/activities';
import { taskPairOf } from '../fixtures/work';

// #903: a collapsed folder's name shows the worst status under it, a deleted file's included, though the file has no row
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const TREE: TaskTree = {
  root: '/wt/hive-1-task-1',
  files: ['warned/w.ts', 'changed/deep/c.ts', 'kept/k.ts', 'mixed/n.ts', 'mixed/c.ts', 'plain/p.ts'],
  marks: { 'changed/deep/c.ts': 'M', 'kept/gone.ts': 'D', 'mixed/n.ts': 'A', 'mixed/c.ts': 'M' },
  folders: [], ignored: { files: [], folders: ['vendor'] },
};
const FOLDER = '/activities/a-I1/tree/folder?path=';
// vendor is a nested repository: its own marks reach the folders above them once the folder holding them is read
const FOLDERS: Record<string, FolderEntries> = {
  [`${FOLDER}vendor`]: { files: [], folders: ['sub'], repo: { marks: {}, ignored: [] } },
  [`${FOLDER}vendor%2Fsub`]: { files: ['a.md'], folders: [], repo: { marks: { 'a.md': 'M' }, ignored: [] } },
};
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url.endsWith('/tree')) return json(TREE);
  const folder = FOLDERS[url];
  return folder ? json(folder) : new Response(null, { status: 204 });
});
const openFile = vi.fn<OpenFile>(() => true);
const side = () => <FileOpenerContext.Provider value={openFile}><ActivitySide target={target} tab="files" isShown onTab={vi.fn()} /></FileOpenerContext.Provider>;
const nameOf = (path: string, name = path): HTMLElement => within(screen.getByTitle(path)).getByText(name);

beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); openFile.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('a collapsed folder takes the worst status under it: a warning, an M deep down, a deleted file with no row, M over A; a plain one stays plain (#903)', async () => {
  const user = userEvent.setup();
  store.setClient('k', 'a-I1', 'typescript-language-server', { phase: 'ready' });
  store.setDiagnostics('k', 'warned/w.ts', problemsOf('warned/w.ts', { warnings: 2 }));
  render(side());
  await screen.findByTitle('warned');
  expect(nameOf('warned')).toHaveClass('text-waiting');
  expect(nameOf('changed')).toHaveClass('text-git-modified');
  expect(nameOf('kept')).toHaveClass('text-git-deleted');
  expect(nameOf('mixed')).toHaveClass('text-git-modified');
  expect(nameOf('plain')).toHaveClass('text-foreground');
  await user.dblClick(screen.getByTitle('kept'));
  expect(nameOf('kept/k.ts', 'k.ts')).toHaveClass('text-foreground');
  expect(screen.queryByTitle('kept/gone.ts')).toBeNull();
});

test('a changed file read from a nested repository colours the folders above it, an ignored one included (#1, #903)', async () => {
  const user = userEvent.setup();
  render(side());
  await user.dblClick(await screen.findByTitle('vendor'));
  expect(nameOf('vendor')).toHaveClass('text-muted-foreground');
  await user.dblClick(await screen.findByTitle('vendor/sub'));
  await screen.findByTitle('vendor/sub/a.md');
  expect(nameOf('vendor/sub', 'sub')).toHaveClass('text-git-modified');
  expect(nameOf('vendor')).toHaveClass('text-git-modified');
});
