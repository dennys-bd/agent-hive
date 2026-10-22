import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import * as models from '@/lib/editor-models';
import type { Task, TaskTree } from '../../src/types';
import type { TaskActivity } from '@/lib/activities';
import { taskPairOf } from '../fixtures/work';
vi.mock('@/hooks/use-tree-lease', () => ({ useTreeLease: () => undefined })); // #502: the lease's POST is none of this file's requests

// The tree's selection (#818): a click selects one row, ⌘-click (Ctrl off macOS, as jsdom runs) toggles one, ⇧-click ranges; a drag takes it.
// The tree lists docs and src as folders, docs first, then README.md
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const TREE: TaskTree = { root: '/wt/hive-1-task-1', files: ['src/a.ts', 'src/b.ts', 'README.md', 'docs/x.md'], marks: {}, folders: [], ignored: { files: [], folders: [] } };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
let moveAnswer = (): Response => new Response(null, { status: 204 });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith('/tree') ? json(TREE) : moveAnswer()));
const openFile = vi.fn<OpenFile>(() => true);
const side = () => <FileOpenerContext.Provider value={openFile}><ActivitySide target={target} tab="files" isShown /></FileOpenerContext.Provider>;
const posted = (): string[] => fetchMock.mock.calls.flatMap(([url, init]) => (init?.method === 'POST' ? [`${url} ${String(init.body ?? '')}`] : []));
const selected = (): string[] => screen.getAllByRole('button').filter((b) => b.hasAttribute('data-selected')).map((b) => b.getAttribute('data-tree-path') ?? '');
// jsdom has no DataTransfer: the stub carries what dragstart set to the drop (FilesPanel.test.tsx's)
const dataTransfer = () => {
  const data = new Map<string, string>();
  return { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', types: [], files: [], effectAllowed: 'all', dropEffect: 'none' };
};
const drag = (from: Element, to: Element): void => {
  const dt = dataTransfer();
  fireEvent.dragStart(from, { dataTransfer: dt });
  fireEvent.dragOver(to, { dataTransfer: dt });
  fireEvent(to, Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: dt }));
  fireEvent.dragEnd(from, { dataTransfer: dt });
};

beforeEach(() => {
  setLanguage('pt');
  moveAnswer = () => new Response(null, { status: 204 });
  fetchMock.mockClear();
  openFile.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

test('a click selects one row and opens a file; Ctrl-click toggles a row; Shift-click selects every visible row from the anchor; only the plain click opens (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  const src = await screen.findByRole('button', { name: 'src' });
  await user.dblClick(src);
  await user.click(screen.getByRole('button', { name: /^a\.ts/ }));
  expect(selected()).toEqual(['src/a.ts']);
  await user.keyboard('[ControlLeft>]');
  await user.click(screen.getByRole('button', { name: 'README.md' }));
  await user.keyboard('[/ControlLeft]');
  expect(selected()).toEqual(['src/a.ts', 'README.md']);
  await user.keyboard('[ShiftLeft>]');
  await user.click(src);
  await user.keyboard('[/ShiftLeft]');
  expect(selected()).toEqual(['src', 'src/a.ts', 'src/b.ts', 'README.md']); // from README.md, the anchor, up to src: docs stays out
  expect(openFile.mock.calls).toEqual([['I1', 'src/a.ts']]);
});

test('a drag of a selected row moves the whole selection; a row out of it moves alone (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  const readme = await screen.findByRole('button', { name: 'README.md' });
  await user.click(readme);
  await user.keyboard('[ControlLeft>]');
  await user.click(screen.getByRole('button', { name: 'src' }));
  await user.keyboard('[/ControlLeft]');
  drag(readme, screen.getByRole('button', { name: 'docs' }));
  drag(screen.getByRole('button', { name: 'docs' }), screen.getByRole('button', { name: 'src' }));
  expect(posted()).toEqual([
    `/activities/a-I1/tree/move ${JSON.stringify({ sources: ['README.md', 'src'], into: 'docs', copy: false })}`,
    `/activities/a-I1/tree/move ${JSON.stringify({ sources: ['docs'], into: 'src', copy: false })}`,
  ]);
});

test('a move the server answered makes the moved items\' open tabs follow them (#818)', async () => {
  moveAnswer = () => json({ moved: ['src/README.md'], from: ['README.md'] });
  const heard: string[][] = [];
  const stop = models.onRenamed((...args) => heard.push(args));
  render(side());
  drag(await screen.findByRole('button', { name: 'README.md' }), screen.getByRole('button', { name: 'src' }));
  await waitFor(() => expect(heard).toEqual([['a-I1', 'README.md', 'src/README.md']]));
  stop();
});
