import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import * as models from '@/lib/editor-models';
import type { Task, TaskTree } from '../../src/types';
import type { TaskActivity } from '@/lib/activities';
import { taskPairOf } from '../fixtures/work';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The inline name (#818): new file, new folder and rename in the row; and the tree's keys, live only with the focus in the tree (jsdom runs
// as off macOS: rename F2, delete Delete)
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const TREE: TaskTree = { root: '/wt/hive-1-task-1', files: ['src/a.ts', 'README.md'], marks: {}, folders: [], ignored: { files: [], folders: [] } };
const TAKEN = 'a file or folder with this name already exists';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let isTaken = false;
let isHeld = false;
let answerCreate: ((res: Response) => void) | undefined; // set by a test that holds tree/create open
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/tree')) return json(TREE);
  const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string; to?: string };
  if (url.endsWith('/tree/create') && answerCreate === undefined && isHeld) return new Promise<Response>((resolve) => { answerCreate = resolve; });
  if (url.endsWith('/tree/create')) return isTaken ? json({ error: TAKEN }, 409) : json({ path: body.path });
  if (url.endsWith('/tree/rename')) return json({ path: body.to });
  return new Response(null, { status: 204 });
});
const openFile = vi.fn<OpenFile>(() => true);
const side = () => <FileOpenerContext.Provider value={openFile}><ActivitySide target={target} tab="files" isShown /></FileOpenerContext.Provider>;
const posted = (): string[] => fetchMock.mock.calls.flatMap(([url, init]) => (init?.method === 'POST' ? [`${url} ${String(init.body ?? '')}`] : []));
const nameInput = (): HTMLInputElement | null => screen.queryByRole('textbox', { name: 'nome' });

beforeEach(() => { setLanguage('pt'); isTaken = false; isHeld = false; answerCreate = undefined; fetchMock.mockClear(); openFile.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('nova pasta from a folder\'s menu: the input at the top of that folder; Enter posts tree/create with the name, a / making the folders between, and opens nothing (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  await user.pointer({ keys: '[MouseRight]', target: await screen.findByRole('button', { name: 'src' }) });
  await user.click(await screen.findByRole('menuitem', { name: 'nova pasta' }));
  const input = await screen.findByRole('textbox', { name: 'nome' });
  expect(screen.getByRole('button', { name: 'src' })).toHaveAttribute('aria-expanded', 'true');
  await user.type(input, 'lib/util{Enter}');
  expect(posted()).toEqual(['/activities/a-I1/tree/create {"path":"src/lib/util","kind":"folder"}']);
  await waitFor(() => expect(nameInput()).toBeNull());
  expect(openFile).not.toHaveBeenCalled();
});

test('novo arquivo on the empty area makes a file at the root and opens it in the editor pane (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  await screen.findByRole('button', { name: 'src' });
  await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('files-tree') });
  await user.click(await screen.findByRole('menuitem', { name: 'novo arquivo' }));
  await user.type(await screen.findByRole('textbox', { name: 'nome' }), 'notes.md{Enter}');
  expect(posted()).toEqual(['/activities/a-I1/tree/create {"path":"notes.md","kind":"file"}']);
  await waitFor(() => expect(openFile).toHaveBeenCalledWith('I1', 'notes.md'));
});

test('a refused name stays on its input with the server\'s words under it; Esc cancels and posts nothing more (#818)', async () => {
  isTaken = true;
  const user = userEvent.setup();
  render(side());
  await screen.findByRole('button', { name: 'src' });
  await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('files-tree') });
  await user.click(await screen.findByRole('menuitem', { name: 'novo arquivo' }));
  await user.type(await screen.findByRole('textbox', { name: 'nome' }), 'README.md{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent(TAKEN);
  expect(nameInput()).toHaveValue('README.md');
  await user.keyboard('{Escape}');
  expect(nameInput()).toBeNull();
  expect(posted()).toHaveLength(1);
});

test('F2 with a row focused renames it in place, its stem selected; Enter posts tree/rename and its open tabs follow (#818)', async () => {
  const user = userEvent.setup();
  const heard: string[][] = [];
  const stop = models.onRenamed((...args) => heard.push(args));
  render(side());
  (await screen.findByRole('button', { name: 'README.md' })).focus();
  await user.keyboard('{F2}');
  const input = await screen.findByRole('textbox', { name: 'nome' }) as HTMLInputElement;
  expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['README.md', 0, 6]);
  await user.clear(input);
  await user.type(input, 'DOCS.md{Enter}');
  expect(posted()).toEqual(['/activities/a-I1/tree/rename {"from":"README.md","to":"DOCS.md"}']);
  await waitFor(() => expect(heard).toEqual([['a-I1', 'README.md', 'DOCS.md']]));
  stop();
});

test('the tree\'s keys act only with the focus in the tree: F2 in a field outside does nothing; Delete on a row asks, and Enter confirms the dialog (#818)', async () => {
  const user = userEvent.setup();
  render(<><input aria-label="elsewhere" />{side()}</>);
  const readme = await screen.findByRole('button', { name: 'README.md' });
  await user.click(screen.getByLabelText('elsewhere'));
  await user.keyboard('{F2}');
  expect(nameInput()).toBeNull();
  readme.focus();
  await user.keyboard('{Delete}');
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('mover README.md para a lixeira?');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(posted()).toEqual(['/activities/a-I1/tree/trash {"paths":["README.md"]}']));
  expect(nameInput()).toBeNull();
});

test('a double Enter posts once: the second is ignored while the first is pending, so no false refusal reopens the input after it succeeded (#818)', async () => {
  const user = userEvent.setup();
  isHeld = true;
  render(side());
  await screen.findByRole('button', { name: 'src' });
  await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('files-tree') });
  await user.click(await screen.findByRole('menuitem', { name: 'novo arquivo' }));
  await user.type(await screen.findByRole('textbox', { name: 'nome' }), 'notes.md{Enter}{Enter}');
  expect(posted()).toEqual(['/activities/a-I1/tree/create {"path":"notes.md","kind":"file"}']);
  answerCreate?.(json({ path: 'notes.md' }));
  await waitFor(() => expect(nameInput()).toBeNull());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(openFile).toHaveBeenCalledTimes(1);
});
