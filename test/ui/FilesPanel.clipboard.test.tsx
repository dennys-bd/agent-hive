import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task, TaskTree } from '../../src/types';
import type { LocalActivity, TaskActivity } from '@/lib/activities';
import { localPairOf, taskPairOf } from '../fixtures/work';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The tree's clipboard (#818): ⌘C / ⌘X / ⌘V reach it as the container's DOM events; the pasteboard is the bridge's stub
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const local: LocalActivity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [], sessions: [], kept: [] };
const TREE: TaskTree = { root: '/wt/hive-1-task-1', files: ['src/a.ts', 'README.md'], marks: {}, folders: [], ignored: { files: [], folders: [] } };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith('/tree') ? json(TREE) : new Response(null, { status: 204 })));
const openFile = vi.fn<OpenFile>(() => true);
const board = { files: [] as string[] };
const writeClipboardFiles = vi.fn(async (paths: string[]) => { board.files = paths; });
const clipboardFiles = vi.fn(async () => board.files);
const side = (activity: TaskActivity | LocalActivity = target) => <FileOpenerContext.Provider value={openFile}><ActivitySide target={activity} tab="files" isShown /></FileOpenerContext.Provider>;
const posted = (): string[] => fetchMock.mock.calls.flatMap(([url, init]) => (init?.method === 'POST' ? [`${url} ${String(init.body ?? '')}`] : []));
const moveLine = (sources: string[], into: string, copy: boolean, id = 'a-I1'): string => `/activities/${encodeURIComponent(id)}/tree/move ${JSON.stringify({ sources, into, copy })}`;
const fire = async (kind: 'copy' | 'cut' | 'paste', el: Element): Promise<void> => { await act(async () => { fireEvent[kind](el); }); };

beforeEach(() => {
  setLanguage('pt');
  board.files = [];
  fetchMock.mockClear();
  writeClipboardFiles.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('hive', { pathForFile: () => '', clipboardFiles, writeClipboardFiles });
});
afterEach(() => { vi.unstubAllGlobals(); });

test('⌘C puts the focused row on the pasteboard by its absolute path; ⌘V on a folder copies it there (#818)', async () => {
  render(side());
  await fire('copy', await screen.findByRole('button', { name: 'README.md' }));
  expect(writeClipboardFiles).toHaveBeenCalledWith(['/wt/hive-1-task-1/README.md']);
  await fire('paste', screen.getByRole('button', { name: 'src' }));
  expect(posted()).toEqual([moveLine(['/wt/hive-1-task-1/README.md'], 'src', true)]);
});

test('⌘X then ⌘V in the same activity moves by the relative paths, and the mark goes with it: a second ⌘V copies (#818)', async () => {
  render(side());
  await fire('cut', await screen.findByRole('button', { name: 'README.md' }));
  const src = screen.getByRole('button', { name: 'src' });
  await fire('paste', src);
  await fire('paste', src);
  expect(posted()).toEqual([moveLine(['README.md'], 'src', false), moveLine(['/wt/hive-1-task-1/README.md'], 'src', true)]);
});

test('a cut pasted in another activity is a copy, the originals staying (#818)', async () => {
  render(<>{side()}{side(local)}</>);
  const [taskTree, localTree] = screen.getAllByTestId('files-tree');
  await fire('cut', await within(taskTree).findByRole('button', { name: 'README.md' }));
  await fire('paste', await within(localTree).findByRole('button', { name: 'src' }));
  expect(posted()).toEqual([moveLine(['/wt/hive-1-task-1/README.md'], 'src', true, 'local:hive')]);
});

test('⌘C on a selected row copies the whole selection (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  await user.click(await screen.findByRole('button', { name: 'README.md' }));
  await user.keyboard('[ControlLeft>]');
  await user.click(screen.getByRole('button', { name: 'src' }));
  await user.keyboard('[/ControlLeft]');
  await fire('copy', screen.getByRole('button', { name: 'src' }));
  expect(writeClipboardFiles).toHaveBeenCalledWith(['/wt/hive-1-task-1/README.md', '/wt/hive-1-task-1/src']);
});

test('without the viewer\'s bridge ⌘C puts the relative paths on the clipboard as text (#818)', async () => {
  vi.stubGlobal('hive', undefined);
  userEvent.setup(); // its clipboard stub
  render(side());
  await fire('copy', await screen.findByRole('button', { name: 'README.md' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('README.md'));
});
