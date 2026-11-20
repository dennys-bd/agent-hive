import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { SearchPane } from '@/components/search/SearchPane';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import { activityKey, type TaskActivity } from '@/lib/activities';
import { setSearchPane } from '@/lib/search-query';
import type { SearchEnd, SearchFileResult, SearchLine, Task } from '../../src/types';
import { taskPairOf } from '../fixtures/work';

const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const target: TaskActivity = { kind: 'task', ...taskPairOf('I1', { slug: 'hive-1-task-1', branch: 'hive/1-task-1' }), task, runs: [], sessions: [], status: 'empty', worker: false };
const FILE: SearchFileResult = {
  file: 'src/daemon.ts', repo: '',
  matches: [
    { line: 12, text: 'export const daemonPort = await freePort();', spans: [[13, 23]] },
    { line: 31, text: 'log.info(daemonPort, daemonPort);', spans: [[9, 19], [21, 31]] },
  ],
};
const end = (extra: Partial<SearchEnd> = {}): SearchLine => ({ done: true, total: 3, files: 1, capped: false, repos: [], ...extra });

const enc = new TextEncoder();
interface Stream { res: Response; push(line: SearchLine): void; end(): void }
const stream = (...lines: SearchLine[]): Stream => {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
  const push = (line: SearchLine): void => { ctrl.enqueue(enc.encode(`${JSON.stringify(line)}\n`)); };
  lines.forEach(push);
  return { res: new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), push, end: () => ctrl.close() };
};
const done = (...lines: SearchLine[]): Response => { const s = stream(...lines); s.end(); return s.res; };

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const openFile = vi.fn<OpenFile>(() => true);
const pane = () => <FileOpenerContext.Provider value={openFile}><SearchPane target={target} isShown /></FileOpenerContext.Provider>;
const withQuery = (q: string, extra: { isRegex?: boolean } = {}): void => setSearchPane({ query: { q, isCaseSensitive: false, isWholeWord: false, isRegex: extra.isRegex ?? false } });

beforeEach(() => {
  setLanguage('pt');
  fetchMock.mockReset();
  openFile.mockClear();
  setSearchPane({ query: { q: '', isCaseSensitive: false, isWholeWord: false, isRegex: false }, replacement: '', isReplaceOpen: false });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

test('with no query the field shows its placeholder, and the note names the nested repositories and the key that lists the files', async () => {
  fetchMock.mockImplementation(async () => done(end({ total: 0, files: 0, repos: ['docs'] })));
  render(pane());
  expect(screen.getByRole('textbox', { name: 'buscar nos arquivos' })).toHaveAttribute('placeholder', 'buscar');
  const note = await screen.findByText(/^busca no conteúdo dos arquivos desta worktree e de/);
  expect(note).toHaveTextContent('busca no conteúdo dos arquivos desta worktree e de docs, os mesmos que Ctrl+Shift+P lista.');
  expect(within(note).getByText('docs').tagName).toBe('B');
  expect(screen.getByText(/abre o arquivo na linha\./)).toHaveTextContent('Enter abre o arquivo na linha.');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByText('hive/1-task-1')).toBeInTheDocument();
});

test('while the search runs the summary counts so far and the spinner turns; at the end it counts results and files', async () => {
  const s = stream(FILE);
  fetchMock.mockImplementation(async () => s.res);
  withQuery('daemonPort');
  const { container } = render(pane());
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('buscando · 3 resultados até agora'));
  expect(container.querySelector('svg.motion-safe\\:animate-spin')).not.toBeNull();
  s.push(end());
  s.end();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('3 resultados em 1 arquivo'));
  expect(container.querySelector('svg.motion-safe\\:animate-spin')).toBeNull();
});

test('the results are a tree: the file with its folder and count, each line with its match marked, and the chevron folds the rows', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async () => done(FILE, end()));
  withQuery('daemonPort');
  render(pane());
  const file = await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  const tree = screen.getByRole('tree', { name: 'resultados' });
  expect(file).toHaveTextContent('daemon.ts');
  expect(file).toHaveTextContent('src');
  expect(file).toHaveTextContent('3');
  const row = within(tree).getByRole('treeitem', { name: /^12 / });
  expect(row).toHaveTextContent('12export const daemonPort = await freePort();');
  expect(row.querySelector('mark')).toHaveTextContent('daemonPort');
  expect(within(tree).getByRole('treeitem', { name: /^31 / }).querySelectorAll('mark')).toHaveLength(2);
  await user.click(file.querySelector('svg') as SVGElement);
  expect(file).toHaveAttribute('aria-expanded', 'false');
  expect(within(tree).queryByRole('treeitem', { name: /^12 / })).not.toBeInTheDocument();
});

test('no results: the summary says so and the note counts the files searched', async () => {
  fetchMock.mockImplementation(async () => done(end({ total: 0, files: 0, searched: 1284 })));
  withQuery('daemonPrt');
  render(pane());
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('nenhum resultado'));
  expect(screen.getByText(/^nada em 1\.284 arquivos\./)).toBeInTheDocument();
  expect(screen.queryByRole('tree')).not.toBeInTheDocument();
});

test('capped: the summary reads more than 2.000 and the strip tells to refine', async () => {
  fetchMock.mockImplementation(async () => done(FILE, end({ total: 2000, capped: true })));
  withQuery('daemon');
  render(pane());
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('mais de 2.000 resultados'));
  expect(screen.getByText('mostrando os primeiros 2.000. refine a busca para ver o resto.')).toBeInTheDocument();
});

test('an invalid regex puts git\'s reason in an alert, the regex switch on and the field in the destructive border; with regex off the bare reason', async () => {
  fetchMock.mockImplementation(async () => done({ error: "command line, 'a(': Unmatched ( or \\(" }));
  withQuery('a(', { isRegex: true });
  render(pane());
  expect(await screen.findByRole('alert')).toHaveTextContent("regex inválida: command line, 'a(': Unmatched ( or \\(");
  expect(screen.getByRole('switch', { name: 'regex' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('textbox', { name: 'buscar nos arquivos' }).parentElement).toHaveClass('border-destructive');
  expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('an invalid regex with regex off shows the bare reason', async () => {
  fetchMock.mockImplementation(async () => done({ error: 'boom' }));
  withQuery('a(');
  render(pane());
  expect(await screen.findByRole('alert')).toHaveTextContent(/^boom$/);
});

test('an activity with no worktree shows the note alone: no field, no summary', async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'no worktree' }), { status: 409, headers: { 'content-type': 'application/json' } }));
  render(pane());
  expect(await screen.findByText('a atividade em foco não tem worktree.')).toBeInTheDocument();
  expect(screen.getByText('abra uma atividade com worktree para buscar nos arquivos dela.')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('a match row opens the file at its line and column, and the results stay', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async () => done(FILE, end()));
  withQuery('daemonPort');
  render(pane());
  await user.click(await screen.findByRole('treeitem', { name: /^12 / }));
  expect(openFile).toHaveBeenCalledWith(activityKey(target), 'src/daemon.ts', { line: 12, col: 14 });
  expect(screen.getByRole('tree', { name: 'resultados' })).toBeInTheDocument();
});

test('clicking a toggle flips it and the next search asks with it on', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async () => done(FILE, end()));
  withQuery('daemonPort');
  render(pane());
  const toggle = screen.getByRole('switch', { name: 'diferenciar maiúsculas' });
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  await waitFor(() => expect(fetchMock.mock.calls.map(([url]) => url)).toContain(`/activities/${encodeURIComponent(target.activity.id)}/search?q=daemonPort&case=1&word=0&regex=0`));
});

test('typing in the field changes the query the next search asks with', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async () => done(end({ total: 0, files: 0 })));
  render(pane());
  await user.type(screen.getByRole('textbox', { name: 'buscar nos arquivos' }), 'abc');
  await waitFor(() => expect(fetchMock.mock.calls.map(([url]) => url).some((url) => url.includes('q=abc&'))).toBe(true));
});

test('the sidebar mounts the pane for the busca tab, in English too', async () => {
  setLanguage('en');
  fetchMock.mockImplementation(async () => done(end({ total: 0, files: 0 })));
  render(<FileOpenerContext.Provider value={openFile}><ActivitySide target={target} tab="search" isShown details={<p>the detail</p>} /></FileOpenerContext.Provider>);
  expect(screen.getByRole('textbox', { name: 'search in files' })).toHaveAttribute('placeholder', 'search');
  expect(await screen.findByText(/^searches the contents of the files in this worktree, the same ones/)).toBeInTheDocument();
});

const keyedPane = (onReplaceAll: () => void) => (
  <FileOpenerContext.Provider value={openFile}>
    <button type="button">outside</button>
    <SearchPane target={target} isShown onReplaceAll={onReplaceAll} />
  </FileOpenerContext.Provider>
);

test('with the focus in the pane Alt+C, Alt+W and Alt+R flip match case, whole word and regex', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async () => done(end({ total: 0, files: 0 })));
  render(keyedPane(vi.fn()));
  await user.click(screen.getByRole('textbox', { name: 'buscar nos arquivos' }));
  await user.keyboard('{Alt>}c{/Alt}{Alt>}w{/Alt}{Alt>}r{/Alt}');
  for (const name of ['diferenciar maiúsculas', 'palavra inteira', 'regex']) {
    expect(screen.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true');
  }
});

test('with the focus outside the pane the same keys change nothing', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async () => done(end({ total: 0, files: 0 })));
  render(keyedPane(vi.fn()));
  await user.click(screen.getByRole('button', { name: 'outside' }));
  await user.keyboard('{Alt>}c{/Alt}{Alt>}w{/Alt}{Alt>}r{/Alt}');
  for (const toggle of screen.getAllByRole('switch')) expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('Ctrl+Alt+Enter in the field replaces all once the search is done, and does nothing while it runs', async () => {
  const user = userEvent.setup();
  const onReplaceAll = vi.fn();
  const s = stream(FILE);
  fetchMock.mockImplementation(async () => s.res);
  withQuery('daemonPort');
  setSearchPane({ isReplaceOpen: true });
  render(keyedPane(onReplaceAll));
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  await user.click(screen.getByRole('textbox', { name: 'buscar nos arquivos' }));
  await user.keyboard('{Control>}{Alt>}{Enter}{/Alt}{/Control}');
  expect(onReplaceAll).not.toHaveBeenCalled();
  s.push(end());
  s.end();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('3 resultados em 1 arquivo'));
  await user.keyboard('{Control>}{Alt>}{Enter}{/Alt}{/Control}');
  expect(onReplaceAll).toHaveBeenCalledOnce();
});
