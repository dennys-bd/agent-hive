import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile, RunOpenerContext } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import type { Task, TaskTree } from '../../src/types';
import type { LocalActivity, TaskActivity } from '@/lib/activities';
import { runShortcut } from '@/lib/dock-layout';
import { localPairOf, taskPairOf } from '../fixtures/work';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The tree's right-click menus (#818): a file's, a folder's and the empty area's, each item with its key (jsdom runs as off macOS)
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1', branch: 'hive/1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const local: LocalActivity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [], sessions: [], kept: [] };
const TREE: TaskTree = { root: '/wt/hive-1-task-1', files: ['src/a.ts', 'README.md', 'Landing.hv.html'], marks: {}, folders: [], ignored: { files: [], folders: [] } };
const TASK_TREE: TaskTree = { ...TREE, checkout: '.hive/worktrees/hive-1-task-1' }; // #131: a local activity's tree has none
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url.endsWith('/tree')) return json(url.includes('/a-I1/') ? TASK_TREE : TREE);
  return url.endsWith('/shell') ? json({ ok: true, ptyId: 'T1' }) : new Response(null, { status: 204 });
});
const openFile = vi.fn<OpenFile>(() => true);
const openRun = vi.fn();
const side = (activity: TaskActivity | LocalActivity = target) => (
  <RunOpenerContext.Provider value={openRun}>
    <FileOpenerContext.Provider value={openFile}><ActivitySide target={activity} tab="files" isShown /></FileOpenerContext.Provider>
  </RunOpenerContext.Provider>
);
const posted = (): string[] => fetchMock.mock.calls.flatMap(([url, init]) => (init?.method === 'POST' ? [`${url} ${String(init.body ?? '')}`] : []));
const menuOf = async (user: ReturnType<typeof userEvent.setup>, el: Element): Promise<string[]> => {
  await user.pointer({ keys: '[MouseRight]', target: el });
  return (await screen.findAllByRole('menuitem')).map((item) => item.textContent ?? '');
};
const CHECKOUT_ITEM = 'copiar caminho a partir do checkout';
const FILE_ITEMS = ['abrir alterações', 'abrir no terminal integrado', 'revelar no FinderCtrl+Alt+R', 'recortarCtrl+X', 'copiarCtrl+C', 'colarCtrl+V', 'copiar caminho', 'copiar caminho relativo', CHECKOUT_ITEM, 'renomearF2', 'excluirDelete'];
const LOCAL_FILE_ITEMS = FILE_ITEMS.filter((item) => item !== CHECKOUT_ITEM);
const FOLDER_ITEMS = ['novo arquivo', 'nova pasta', ...FILE_ITEMS.slice(1)];
const ROOT_ITEMS = ['novo arquivo', 'nova pasta', 'abrir no terminal integrado', 'revelar no FinderCtrl+Alt+R', 'colarCtrl+V'];

beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); openFile.mockClear(); openRun.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('a file\'s menu: abrir alterações, the terminal and reveal, cut, copy and paste, the copy paths and excluir, each with its key; abrir alterações opens its changes pane (#818, #668)', async () => {
  const user = userEvent.setup();
  render(side());
  expect(await menuOf(user, await screen.findByRole('button', { name: 'README.md' }))).toEqual(FILE_ITEMS);
  await user.click(screen.getByRole('menuitem', { name: 'abrir alterações' }));
  expect(openFile).toHaveBeenCalledWith('I1', 'README.md', undefined, { changes: true });
});

test('a local activity\'s file has the same menu, Open Changes included, without copiar caminho a partir do checkout: its root is the checkout (#818, #633, #131)', async () => {
  const user = userEvent.setup();
  render(side(local));
  expect(await menuOf(user, await screen.findByRole('button', { name: 'README.md' }))).toEqual(LOCAL_FILE_ITEMS);
});

test('a folder\'s menu has no abrir alterações; its terminal opens in that folder through the shell route and lands as the task\'s terminal (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  expect(await menuOf(user, await screen.findByRole('button', { name: 'src' }))).toEqual(FOLDER_ITEMS);
  await user.click(screen.getByRole('menuitem', { name: 'abrir no terminal integrado' }));
  expect(posted()).toEqual(['/activities/a-I1/shell {"folder":"src"}']);
  await waitFor(() => expect(openRun).toHaveBeenCalledWith({ ptyId: 'T1', kind: 'terminal', task: 'I1', title: '#1 Task 1' }));
});

test('the empty area\'s menu is the root\'s: the terminal and reveal at the root, and paste; its reveal posts no path (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  await screen.findByRole('button', { name: 'src' });
  expect(await menuOf(user, screen.getByTestId('files-tree'))).toEqual(ROOT_ITEMS);
  await user.click(screen.getByRole('menuitem', { name: /^revelar no Finder/ }));
  expect(posted()).toEqual(['/activities/a-I1/reveal ']);
});

test('copiar caminho puts the tree\'s root and the path on the clipboard (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  await menuOf(user, await screen.findByRole('button', { name: 'README.md' }));
  await user.click(screen.getByRole('menuitem', { name: 'copiar caminho' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('/wt/hive-1-task-1/README.md'));
});

test('copiar caminho relativo puts the path alone on the clipboard (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  await menuOf(user, await screen.findByRole('button', { name: 'README.md' }));
  await user.click(screen.getByRole('menuitem', { name: 'copiar caminho relativo' }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('README.md'));
});

test('copiar caminho a partir do checkout puts the checkout and the path on the clipboard, from a file\'s and a folder\'s menu (#131)', async () => {
  const user = userEvent.setup();
  render(side());
  await menuOf(user, await screen.findByRole('button', { name: 'README.md' }));
  await user.click(screen.getByRole('menuitem', { name: CHECKOUT_ITEM }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('.hive/worktrees/hive-1-task-1/README.md'));
  await menuOf(user, screen.getByRole('button', { name: 'src' }));
  await user.click(screen.getByRole('menuitem', { name: CHECKOUT_ITEM }));
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('.hive/worktrees/hive-1-task-1/src'));
});

test('the treeCopyCheckoutPath shortcut copies the focused row from the checkout in a task\'s tree, and does nothing in a local activity\'s (#131)', async () => {
  userEvent.setup(); // installs the clipboard stub readText reads
  const { unmount } = render(side());
  (await screen.findByRole('button', { name: 'README.md' })).focus();
  runShortcut('treeCopyCheckoutPath');
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('.hive/worktrees/hive-1-task-1/README.md'));
  unmount();
  await navigator.clipboard.writeText('untouched'); // the stub cannot read back an empty string
  render(side(local));
  (await screen.findByRole('button', { name: 'README.md' })).focus();
  runShortcut('treeCopyCheckoutPath');
  await new Promise((resolve) => setTimeout(resolve, 0)); // let a stray async write land before reading
  expect(await navigator.clipboard.readText()).toBe('untouched');
});

test('excluir with two rows selected keeps the selection, asks about both, and confirming posts them to the trash (#818)', async () => {
  const user = userEvent.setup();
  render(side());
  const readme = await screen.findByRole('button', { name: 'README.md' });
  await user.click(readme);
  await user.keyboard('[ControlLeft>]');
  await user.click(screen.getByRole('button', { name: 'src' }));
  await user.keyboard('[/ControlLeft]');
  await menuOf(user, readme);
  await user.click(screen.getByRole('menuitem', { name: /^excluir/ }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('mover 2 itens para a lixeira?');
  await user.click(screen.getByRole('button', { name: 'mover para a lixeira' }));
  expect(posted()).toEqual(['/activities/a-I1/tree/trash {"paths":["README.md","src"]}']);
});

test('a Hive design\'s menu starts with abrir no painel do editor, which opens it in the editor pane; other files never show it (#109)', async () => {
  const user = userEvent.setup();
  render(side());
  expect(await menuOf(user, await screen.findByRole('button', { name: 'Landing.hv.html' }))).toEqual(['abrir no painel do editor', ...FILE_ITEMS]);
  await user.click(screen.getByRole('menuitem', { name: 'abrir no painel do editor' }));
  expect(openFile).toHaveBeenCalledWith('I1', 'Landing.hv.html', undefined, { editor: true });
});
