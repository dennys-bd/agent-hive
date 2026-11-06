import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import { selectInTree } from '@/lib/tree-place';
import type { Task, TaskTree } from '../../src/types';
import type { TaskActivity } from '@/lib/activities';
import { taskPairOf } from '../fixtures/work';
vi.mock('@/hooks/use-tree-lease', () => ({ useTreeLease: () => undefined })); // #502: the lease's POST is none of this file's requests

// #718: the tree follows the active file: its folders open, its row selected and scrolled into view. The tree lists src (lib/a.ts, b.ts)
// and README.md, nothing ignored; the decision table is use-tree-reveal.test.tsx's
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const TREE: TaskTree = { root: '/wt/hive-1-task-1', files: ['src/lib/a.ts', 'src/b.ts', 'README.md'], marks: {}, folders: [], ignored: { files: [], folders: [] } };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith('/tree') ? json(TREE) : new Response(null, { status: 204 })));
const openFile = vi.fn<OpenFile>(() => true);
const side = (activeFile?: string) => (
  <FileOpenerContext.Provider value={openFile}><ActivitySide target={target} tab="files" isShown activeFile={activeFile} /></FileOpenerContext.Provider>
);
const row = (name: string): HTMLElement => screen.getByRole('button', { name });
const selected = (): string[] => screen.getAllByRole('button').filter((b) => b.hasAttribute('data-selected')).map((b) => b.getAttribute('data-tree-path') ?? '');
const flush = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
let scrolled: string[] = []; // the tree paths scrollIntoView was called on, in order

beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  scrolled = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { scrolled.push(this.getAttribute('data-tree-path') ?? ''); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('the tree reveals the active file when it mounts: its folders open, its row selected and scrolled into view, nearest (#718)', async () => {
  render(side('src/lib/a.ts'));
  await screen.findByRole('button', { name: 'a.ts' });
  expect(row('src')).toHaveAttribute('aria-expanded', 'true');
  expect(row('lib')).toHaveAttribute('aria-expanded', 'true');
  expect(selected()).toEqual(['src/lib/a.ts']);
  await waitFor(() => expect(scrolled).toEqual(['src/lib/a.ts']));
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
});

test('a change of the active file reveals it, replacing the selection; its folder collapsed stays collapsed while the active file stays (#718)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(side('README.md'));
  await waitFor(() => expect(selected()).toEqual(['README.md']));
  rerender(side('src/lib/a.ts'));
  await screen.findByRole('button', { name: 'a.ts' });
  expect(selected()).toEqual(['src/lib/a.ts']);
  await user.dblClick(row('src'));
  rerender(side('src/lib/a.ts'));
  await flush();
  expect(row('src')).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'a.ts' })).not.toBeInTheDocument();
});

test('a selectInTree call scrolls its row into view too (#718)', async () => {
  render(side());
  await screen.findByRole('button', { name: 'src' });
  act(() => selectInTree('a-I1', 'src/b.ts'));
  await screen.findByRole('button', { name: 'b.ts' });
  await waitFor(() => expect(scrolled).toEqual(['src/b.ts']));
});

test('no active file, or an absolute one, leaves the expanded folders and the selection as they were (#718)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(side());
  await user.click(await screen.findByRole('button', { name: 'README.md' }));
  rerender(side('/elsewhere/x.ts'));
  await flush();
  rerender(side(undefined));
  await flush();
  expect(selected()).toEqual(['README.md']);
  expect(row('src')).toHaveAttribute('aria-expanded', 'false');
  expect(scrolled).toEqual([]);
});
