import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SPRING_OPEN_MS } from '@/components/tree-drag';
import { ActivitySide, type SideTab } from '@/components/FilesPanel';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { FileIconsContext, type FileIconsSettings } from '@/hooks/use-file-icons';
import { setLanguage } from '@/i18n';
import * as store from '@/lib/diagnostics-store';
import { problemsOf } from './problem-fake';
import type { Task, TaskTree } from '../../src/types';
import type { LocalActivity, TaskActivity } from '@/lib/activities';
import { localPairOf, taskPairOf } from '../fixtures/work';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } })); // the no-bridge toast is observable without a Toaster

// Redesign 07: the activity sidebar's arquivos view, a tree of the worktree with its git marks.
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
// #629: the branch is the activity's; #633: the sidebar takes the whole activity, a task's or a workspace's local one
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1', branch: 'hive/1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const local: LocalActivity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [], sessions: [], kept: [] };
const TREE: TaskTree = { root: '/wt/hive-1-task-1', files: ['src/a.ts', 'src/b.ts', 'README.md', '.env'], marks: { 'src/a.ts': 'M', 'src/b.ts': 'A' }, folders: [], ignored: { files: [], folders: [] } };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith('/tree') ? json(TREE) : new Response(null, { status: 204 })));
const openFile = vi.fn<OpenFile>(() => true); // the dock's file opener (#717)
const side = (tab: SideTab, onTab = vi.fn()) => (
  <FileOpenerContext.Provider value={openFile}><ActivitySide target={target} tab={tab} isShown details={<p>the detail</p>} onTab={onTab} /></FileOpenerContext.Provider>
);
const localSide = (tab: SideTab = 'files') => <FileOpenerContext.Provider value={openFile}><ActivitySide target={local} tab={tab} isShown onTab={vi.fn()} /></FileOpenerContext.Provider>;
const posted = (): string[] => fetchMock.mock.calls.flatMap(([url, init]) => (init?.method === 'POST' ? [`${url} ${String(init.body ?? '')}`] : []));

beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); openFile.mockClear(); vi.mocked(toast.error).mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

test('arquivos shows the branch and the top level, folders first; a double click opens a folder, and its files carry their mark', async () => {
  const user = userEvent.setup();
  render(side('files'));
  expect(screen.getByText('hive/1-task-1')).toBeInTheDocument();
  const src = await screen.findByRole('button', { name: 'src' });
  expect(screen.getAllByRole('button').map((b) => b.textContent).filter((text) => text === 'src' || text === 'README.md')).toEqual(['src', 'README.md']);
  expect(screen.queryByText('.env')).not.toBeInTheDocument();
  expect(src).toHaveAttribute('aria-expanded', 'false');
  await user.dblClick(src);
  const changed = screen.getByRole('button', { name: /^a\.ts/ });
  expect(changed).toHaveAttribute('title', 'src/a.ts');
  expect(changed).toHaveAccessibleName('a.ts, modificado');
  expect(screen.getByRole('button', { name: /^b\.ts/ })).toBeInTheDocument();
});

test('a click on a file opens it in its activity\'s editor pane (#717)', async () => {
  const user = userEvent.setup();
  render(side('files'));
  await user.click(await screen.findByRole('button', { name: 'README.md' }));
  expect(openFile).toHaveBeenCalledWith('I1', 'README.md');
  expect(posted()).toEqual([]);
});

test('the ⋯ shows hidden files, collapses everything and shows the worktree in its folder', async () => {
  const user = userEvent.setup();
  render(side('files'));
  await user.dblClick(await screen.findByRole('button', { name: 'src' }));
  await user.click(screen.getByRole('button', { name: 'mais ações' }));
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'mostrar arquivos ocultos' }));
  expect(screen.getByRole('button', { name: '.env' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'mais ações' }));
  await user.click(screen.getByRole('menuitem', { name: 'recolher tudo' }));
  expect(screen.queryByRole('button', { name: /^a\.ts/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'mais ações' }));
  await user.click(screen.getByRole('menuitem', { name: 'mostrar na pasta' }));
  // mostrar arquivos ocultos also saves the view state (#947), a debounced post a slow run sees land before this line
  expect(posted().filter((post) => post.startsWith('/activities/'))).toEqual(['/activities/a-I1/reveal ']);
});

test('detalhes shows the task\'s detail in place of the tree, with no ⋯ and no git read; the toggle asks for the other view', async () => {
  const user = userEvent.setup();
  const onTab = vi.fn();
  render(side('details', onTab));
  expect(screen.getByText('the detail')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'mais ações' })).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole('radio', { name: 'arquivos' }));
  expect(onTab).toHaveBeenCalledWith('files');
});

// The file tree's drag (#594). jsdom has no DataTransfer: the stub carries what dragstart set to the drop, and a Finder drag's types and files.
const dataTransfer = (files: File[] = []) => {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '',
    types: files.length > 0 ? ['Files'] : [], files, effectAllowed: 'all', dropEffect: 'none',
  };
};
// jsdom has no DragEvent either: altKey set on a plain Event reaches React's synthetic one, as Flow.test.tsx does for clientY
const dropOn = (el: Element, dt: unknown, altKey = false) => fireEvent(el, Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: dt, altKey }));
const drag = (from: Element, to: Element, altKey = false): void => {
  const dt = dataTransfer();
  fireEvent.dragStart(from, { dataTransfer: dt });
  fireEvent.dragOver(to, { dataTransfer: dt });
  dropOn(to, dt, altKey);
  fireEvent.dragEnd(from, { dataTransfer: dt });
};
const finderDrop = (to: Element, files: File[], altKey = false): void => {
  const dt = dataTransfer(files);
  fireEvent.dragOver(to, { dataTransfer: dt });
  dropOn(to, dt, altKey);
};
const moves = (): string[] => posted().filter((line) => line.startsWith('/activities/a-I1/tree/move '));
const moveLine = (sources: string[], into: string, copy = false): string => `/activities/a-I1/tree/move ${JSON.stringify({ sources, into, copy })}`;

test('a drag within the tree always moves, with or without ⌥ held (#594)', async () => {
  render(side('files'));
  const readme = await screen.findByRole('button', { name: 'README.md' });
  const src = screen.getByRole('button', { name: 'src' });
  drag(readme, src);
  drag(readme, src, true);
  expect(moves()).toEqual([moveLine(['README.md'], 'src'), moveLine(['README.md'], 'src')]);
});

test('a drop from Finder always copies, with or without ⌥ held (#594)', async () => {
  vi.stubGlobal('hive', { pathForFile: (file: File) => `/Volumes/elsewhere/${file.name}` });
  render(side('files'));
  const src = await screen.findByRole('button', { name: 'src' });
  finderDrop(src, [new File(['n'], 'notes.txt')]);
  finderDrop(src, [new File(['n'], 'notes.txt')], true);
  expect(moves()).toEqual([moveLine(['/Volumes/elsewhere/notes.txt'], 'src', true), moveLine(['/Volumes/elsewhere/notes.txt'], 'src', true)]);
});

test('a drop on a file row lands in that file\'s folder (#594)', async () => {
  const user = userEvent.setup();
  render(side('files'));
  await user.dblClick(await screen.findByRole('button', { name: 'src' }));
  drag(screen.getByRole('button', { name: 'README.md' }), screen.getByRole('button', { name: /^a\.ts/ }));
  expect(moves()).toEqual([moveLine(['README.md'], 'src')]);
});

test('a drop on the tree\'s empty area lands in the root (#594)', async () => {
  const user = userEvent.setup();
  render(side('files'));
  await user.dblClick(await screen.findByRole('button', { name: 'src' }));
  const a = screen.getByRole('button', { name: /^a\.ts/ });
  drag(a, a.parentElement!);
  expect(moves()).toEqual([moveLine(['src/a.ts'], '')]);
});

test('files dropped from Finder post the absolute paths the viewer\'s bridge gives (#594)', async () => {
  vi.stubGlobal('hive', { pathForFile: (file: File) => `/Volumes/elsewhere/${file.name}` });
  render(side('files'));
  finderDrop(await screen.findByRole('button', { name: 'src' }), [new File(['n'], 'notes.txt'), new File(['p'], 'plan.md')]);
  expect(moves()).toEqual([moveLine(['/Volumes/elsewhere/notes.txt', '/Volumes/elsewhere/plan.md'], 'src', true)]);
});

test('without the viewer\'s bridge a Finder drop is refused with a toast and posts nothing (#594)', async () => {
  render(side('files'));
  finderDrop(await screen.findByRole('button', { name: 'src' }), [new File(['n'], 'notes.txt')]);
  expect(toast.error).toHaveBeenCalledWith('arraste arquivos do gerenciador de arquivos para a janela do Hive, não para um navegador');
  expect(moves()).toEqual([]);
});

test('a folder dropped into itself, or an item onto its own folder, posts nothing (#594)', async () => {
  const user = userEvent.setup();
  render(side('files'));
  const src = await screen.findByRole('button', { name: 'src' });
  await user.dblClick(src);
  const readme = screen.getByRole('button', { name: 'README.md' });
  drag(src, src);
  drag(src, screen.getByRole('button', { name: /^a\.ts/ })); // into itself, through one of its files
  drag(readme, readme.parentElement!); // onto its own folder, the root
  expect(moves()).toEqual([]);
});

test('a closed folder hovered while dragging is highlighted, and opens after 600 ms (#594)', async () => {
  render(side('files'));
  const readme = await screen.findByRole('button', { name: 'README.md' });
  const src = screen.getByRole('button', { name: 'src' });
  vi.useFakeTimers();
  try {
    const dt = dataTransfer();
    fireEvent.dragStart(readme, { dataTransfer: dt });
    fireEvent.dragOver(src, { dataTransfer: dt });
    expect(src).toHaveClass('bg-muted');
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS - 1); });
    expect(src).toHaveAttribute('aria-expanded', 'false');
    act(() => { vi.advanceTimersByTime(1); });
    expect(src).toHaveAttribute('aria-expanded', 'true');
    fireEvent.dragEnd(readme, { dataTransfer: dt });
    expect(src).not.toHaveClass('bg-muted');
  } finally {
    vi.useRealTimers();
  }
});

test('a Finder drop on the empty or loading tree lands in the root (#594)', async () => {
  vi.stubGlobal('hive', { pathForFile: (file: File) => `/Volumes/elsewhere/${file.name}` });
  fetchMock.mockImplementationOnce(async (url: string) => (url.endsWith('/tree') ? json({ files: [], marks: {}, ignored: { files: [], folders: [] } }) : new Response(null, { status: 204 })));
  render(side('files'));
  finderDrop(await screen.findByText('sem arquivos'), [new File(['n'], 'notes.txt')]);
  expect(moves()).toEqual([moveLine(['/Volumes/elsewhere/notes.txt'], '', true)]);
});

test('an internal drag shows move and a Finder drag shows copy, whatever ⌥ does (#594)', async () => {
  render(side('files'));
  const src = await screen.findByRole('button', { name: 'src' });
  const dt = dataTransfer();
  fireEvent.dragStart(screen.getByRole('button', { name: 'README.md' }), { dataTransfer: dt });
  expect(dt.effectAllowed).toBe('move');
  fireEvent(src, Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer: dt, altKey: true }));
  expect(dt.dropEffect).toBe('move');
  const finder = dataTransfer([new File(['n'], 'notes.txt')]);
  fireEvent.dragEnter(src, { dataTransfer: finder });
  fireEvent.dragOver(src, { dataTransfer: finder });
  expect(finder.dropEffect).toBe('copy');
});

// The drop target shows as one block, as in VS Code's explorer: the whole tree for the root, else the folder's row and its visible descendants
const treeArea = (): HTMLElement => screen.getByTestId('files-tree');
const isMarked = (el: Element): boolean => el.getAttribute('data-drop-target') === 'true';

test('hovering a top-level file, or the empty area, marks the whole tree as the target and no row (#594)', async () => {
  const user = userEvent.setup();
  render(side('files'));
  const src = await screen.findByRole('button', { name: 'src' });
  await user.dblClick(src);
  const readme = screen.getByRole('button', { name: 'README.md' });
  const dt = dataTransfer();
  fireEvent.dragStart(src, { dataTransfer: dt });
  fireEvent.dragOver(readme, { dataTransfer: dt });
  expect(isMarked(treeArea())).toBe(true);
  expect([src, readme, screen.getByRole('button', { name: /^a\.ts/ })].some(isMarked)).toBe(false);
  fireEvent.dragLeave(treeArea(), { dataTransfer: dt, relatedTarget: document.body });
  expect(isMarked(treeArea())).toBe(false);
  fireEvent.dragOver(readme.parentElement!, { dataTransfer: dt });
  expect(isMarked(treeArea())).toBe(true);
});

test('hovering a nested file marks its folder row and its visible descendants as one block, and drop and dragend clear it (#594)', async () => {
  const user = userEvent.setup();
  render(side('files'));
  const src = await screen.findByRole('button', { name: 'src' });
  await user.dblClick(src);
  const [a, b] = [screen.getByRole('button', { name: /^a\.ts/ }), screen.getByRole('button', { name: /^b\.ts/ })];
  const readme = screen.getByRole('button', { name: 'README.md' });
  const dt = dataTransfer();
  fireEvent.dragStart(readme, { dataTransfer: dt });
  fireEvent.dragOver(a, { dataTransfer: dt });
  expect([src, a, b].map(isMarked)).toEqual([true, true, true]);
  expect([readme, treeArea()].some(isMarked)).toBe(false);
  dropOn(a, dt);
  expect([src, a, b, readme, treeArea()].some(isMarked)).toBe(false);
  fireEvent.dragStart(readme, { dataTransfer: dt }); // a drop ends the drag's state
  fireEvent.dragOver(src, { dataTransfer: dt });
  expect([src, a, b].map(isMarked)).toEqual([true, true, true]);
  fireEvent.dragEnd(readme, { dataTransfer: dt });
  expect([src, a, b, treeArea()].some(isMarked)).toBe(false);
});

test('a Finder drag entering after an internal drag that never ended is not taken for it (#594)', async () => {
  vi.stubGlobal('hive', { pathForFile: (file: File) => `/Volumes/elsewhere/${file.name}` });
  render(side('files'));
  const src = await screen.findByRole('button', { name: 'src' });
  fireEvent.dragStart(screen.getByRole('button', { name: 'README.md' }), { dataTransfer: dataTransfer() }); // no dragend
  const dt = dataTransfer([new File(['n'], 'notes.txt')]);
  fireEvent.dragEnter(src, { dataTransfer: dt });
  dropOn(src, dt);
  expect(moves()).toEqual([moveLine(['/Volumes/elsewhere/notes.txt'], 'src', true)]);
});

test('a Finder drop whose files the bridge gives no path for toasts an error and posts nothing (#594)', async () => {
  vi.stubGlobal('hive', { pathForFile: () => '' });
  render(side('files'));
  finderDrop(await screen.findByRole('button', { name: 'src' }), [new File(['n'], 'notes.txt')]);
  expect(toast.error).toHaveBeenCalledWith('arraste arquivos do gerenciador de arquivos para a janela do Hive, não para um navegador');
  expect(moves()).toEqual([]);
});

// ⌘V in the tree (#594): Finder's files, read by main through the bridge, are copied into the focused row's folder.
const withClipboard = (paths: string[]) => {
  const clipboardFiles = vi.fn(async () => paths);
  vi.stubGlobal('hive', { pathForFile: () => '', clipboardFiles });
  return clipboardFiles;
};
const pasteOn = async (el: Element): Promise<void> => { await act(async () => { fireEvent.paste(el); }); };

test('a paste with a folder row focused copies the clipboard\'s files into that folder (#594)', async () => {
  withClipboard(['/Volumes/x/a.txt', '/Volumes/x/b.txt']);
  render(side('files'));
  const src = await screen.findByRole('button', { name: 'src' });
  src.focus();
  await pasteOn(src);
  expect(moves()).toEqual([moveLine(['/Volumes/x/a.txt', '/Volumes/x/b.txt'], 'src', true)]);
});

test('a paste with a nested file row focused copies into its folder (#594)', async () => {
  withClipboard(['/Volumes/x/a.txt']);
  const user = userEvent.setup();
  render(side('files'));
  await user.dblClick(await screen.findByRole('button', { name: 'src' }));
  await pasteOn(screen.getByRole('button', { name: /^a\.ts/ }));
  expect(moves()).toEqual([moveLine(['/Volumes/x/a.txt'], 'src', true)]);
});

test('a paste with no row focused copies into the root (#594)', async () => {
  withClipboard(['/Volumes/x/a.txt']);
  render(side('files'));
  await screen.findByRole('button', { name: 'src' });
  await pasteOn(screen.getByTestId('files-tree'));
  expect(moves()).toEqual([moveLine(['/Volumes/x/a.txt'], '', true)]);
});

test('a paste of a top-level file row copies into the root (#594)', async () => {
  withClipboard(['/Volumes/x/a.txt']);
  render(side('files'));
  await pasteOn(await screen.findByRole('button', { name: 'README.md' }));
  expect(moves()).toEqual([moveLine(['/Volumes/x/a.txt'], '', true)]);
});

test('a paste with no Finder files on the clipboard posts nothing (#594)', async () => {
  const clipboardFiles = withClipboard([]);
  render(side('files'));
  await pasteOn(await screen.findByRole('button', { name: 'src' }));
  expect(clipboardFiles).toHaveBeenCalled();
  expect(moves()).toEqual([]);
});

test('a paste outside the Electron viewer posts nothing (#594)', async () => {
  render(side('files'));
  await pasteOn(await screen.findByRole('button', { name: 'src' }));
  expect(moves()).toEqual([]);
});

test('a paste outside the tree does not read the clipboard (#594)', async () => {
  const clipboardFiles = withClipboard(['/Volumes/x/a.txt']);
  render(<><input aria-label="elsewhere" />{side('files')}</>);
  await screen.findByRole('button', { name: 'src' });
  await pasteOn(screen.getByLabelText('elsewhere'));
  expect(clipboardFiles).not.toHaveBeenCalled();
  expect(moves()).toEqual([]);
});

// #633: a workspace's local activity shows its checkout, arquivos alone: it has no task to detail nor a diff route
test('a local activity shows its checkout\'s tree and the ⋯, with no arquivos | detalhes toggle and no detail, even when the tab is detalhes (#633)', async () => {
  render(localSide('details'));
  expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'mais ações' })).toBeInTheDocument();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/activities/local%3Ahive/tree');
});

test('a drag in a local activity\'s tree posts to its own tree/move (#633)', async () => {
  render(localSide());
  drag(await screen.findByRole('button', { name: 'README.md' }), screen.getByRole('button', { name: 'src' }));
  expect(posted()).toEqual([`/activities/local%3Ahive/tree/move ${JSON.stringify({ sources: ['README.md'], into: 'src', copy: false })}`]);
});

// #754: the files tree's icons, through the context App.tsx provides; the real Material chunk loads (vitest runs through Vite)
const LOAD_MS = 15_000; // the real chunk globs ~1250 SVGs: slow to transform when the suite runs in parallel
const MATERIAL: FileIconsSettings = { set: 'material', scope: 'all', muted: false, theme: 'dark' };
const withIcons = (icons: FileIconsSettings) => <FileIconsContext.Provider value={icons}>{side('files')}</FileIconsContext.Provider>;
const iconOf = (row: HTMLElement): HTMLImageElement | null => row.querySelector('img');

test('with the icons off (none), no row has an icon or a slot (#754)', async () => {
  render(withIcons({ ...MATERIAL, set: 'none' }));
  await screen.findByRole('button', { name: 'src' });
  expect(screen.getByTestId('files-tree').querySelector('img, [data-file-icon]')).toBeNull();
});

test('with Material, a folder row and a file row each show a decorative icon between the caret and the name (#754)', async () => {
  render(withIcons(MATERIAL));
  const src = await screen.findByRole('button', { name: 'src' });
  const readme = screen.getByRole('button', { name: 'README.md' });
  await waitFor(() => expect(iconOf(src)).not.toBeNull(), { timeout: LOAD_MS });
  expect(iconOf(readme)?.getAttribute('src')).toBeTruthy();
  expect(iconOf(src)).toHaveAttribute('alt', '');
  expect(iconOf(src)).toHaveAttribute('draggable', 'false');
  expect(iconOf(src)).not.toHaveClass('file-icon-muted');
  expect(src).toHaveAccessibleName('src'); // decorative: the row's name is unchanged
  const slot = src.querySelector('[data-file-icon]');
  expect(slot?.previousElementSibling?.querySelector('svg')).not.toBeNull(); // the caret's column comes first
  expect(slot?.nextElementSibling).toHaveTextContent('src');
});

test('with folders only, the folder row has an icon and a file row keeps an empty slot, so the names stay aligned (#754)', async () => {
  render(withIcons({ ...MATERIAL, scope: 'folders' }));
  const src = await screen.findByRole('button', { name: 'src' });
  await waitFor(() => expect(iconOf(src)).not.toBeNull(), { timeout: LOAD_MS });
  const readme = screen.getByRole('button', { name: 'README.md' });
  expect(iconOf(readme)).toBeNull();
  expect(readme.querySelector('[data-file-icon]')).not.toBeNull();
});

test('muted icons carry the muted class (#754)', async () => {
  render(withIcons({ ...MATERIAL, muted: true }));
  const src = await screen.findByRole('button', { name: 'src' });
  await waitFor(() => expect(iconOf(src)).toHaveClass('file-icon-muted'), { timeout: LOAD_MS });
});

test('a row shows the most severe count then its git letter, each in its colour; the name by priority; a folder with an error is destructive; nothing while not ready (#780)', async () => {
  const user = userEvent.setup();
  store.setClient('k', 'a-I1', 'typescript-language-server', { phase: 'ready' });
  store.setDiagnostics('k', 'src/a.ts', problemsOf('src/a.ts', { errors: 1, warnings: 3 }));
  store.setDiagnostics('k', 'src/b.ts', problemsOf('src/b.ts', { warnings: 2 }));
  render(side('files'));
  const src = await screen.findByTitle('src');
  expect(within(src).getByText('src')).toHaveClass('text-destructive');
  await user.dblClick(src);
  const marks = (row: HTMLElement): [string | null, string | undefined][] =>
    [...row.querySelectorAll('[data-diag-count], [data-git-mark]')].map((el) => [el.textContent, el.className.match(/text-\w+/)?.[0]]);
  const a = screen.getByTitle('src/a.ts');
  const b = screen.getByTitle('src/b.ts');
  expect(within(a).getByText('a.ts')).toHaveClass('text-destructive');
  expect(marks(a)).toEqual([['1', 'text-destructive'], ['M', 'text-waiting']]);
  expect(within(b).getByText('b.ts')).toHaveClass('text-waiting');
  expect(marks(b)).toEqual([['2', 'text-waiting'], ['A', 'text-working']]);
  act(() => store.setClient('k', 'a-I1', 'typescript-language-server', { phase: 'starting' }));
  expect(within(screen.getByTitle('src/b.ts')).getByText('b.ts')).toHaveClass('text-working');
  expect(document.querySelector('[data-diag-count]')).toBeNull();
});
