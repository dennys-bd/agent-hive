import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActivitySide } from '@/components/FilesPanel';
import { SearchPane } from '@/components/search/SearchPane';
import { FileOpenerContext, type OpenFile } from '@/components/terminal-tabs';
import { setLanguage } from '@/i18n';
import { activityKey, type TaskActivity } from '@/lib/activities';
import { setSearchPane } from '@/lib/search-query';
import type { SearchEnd, SearchFileResult, SearchLine, Task } from '../../src/types';
import { taskPairOf } from '../fixtures/work';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }) }));
// the editor's buffers: which paths hold unsaved edits is the test's to say
const dirtyPaths = new Set<string>();
vi.mock('@/lib/editor-models', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/editor-models')>()), isDirty: (_id: string, path: string) => dirtyPaths.has(path) }));

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
  vi.mocked(toast).mockClear();
  dirtyPaths.clear();
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

// ---- replace (Task 10) ----
const rows = (count: number): SearchFileResult['matches'] => Array.from({ length: count }, (_, i) => ({ line: i + 1, text: 'x daemonPort y', spans: [[2, 12]] as [number, number][] }));
const fileOf = (path: string, count: number): SearchFileResult => ({ file: path, repo: '', matches: rows(count) });
const CARD = 'src/ui/board/Card.tsx';
const FIVE = [fileOf('src/daemon.ts', 4), fileOf(CARD, 2), fileOf('src/server.ts', 3), fileOf('src/client.ts', 3), fileOf('src/util.ts', 2)];
const fiveEnd = end({ total: 14, files: 5, repos: ['docs'] });
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const changedOf = (...paths: string[]) => paths.map((path, i) => ({ path, previous: `old ${path}`, version: `v${i}`, count: 3 }));
const posts = (): unknown[] => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)));
const searches = (): number => fetchMock.mock.calls.filter(([url]) => url.includes('/search?')).length;

function routes(answer: unknown, put: (body: { path: string }) => Response = () => json({ version: 'v9' })): void {
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') return json(answer);
    if (init?.method === 'PUT') return put(JSON.parse(String(init.body)));
    return done(...FIVE, fiveEnd);
  });
}
const openReplace = (replacement = 'daemonAddress'): void => { withQuery('daemonPort'); setSearchPane({ isReplaceOpen: true, replacement }); };
const groupOf = (name: RegExp): HTMLElement => screen.getByRole('treeitem', { name }).closest('[role=group]') as HTMLElement;

test('with the replace field open every row previews the old struck and the new inserted, on every span of the line', async () => {
  openReplace();
  const many: SearchFileResult = { file: 'src/daemon.ts', repo: '', matches: [{ line: 5, text: 'a daemonPort b daemonPort c daemonPort', spans: [[2, 12], [15, 25], [28, 38]] }] };
  fetchMock.mockImplementation(async () => done(many, end({ total: 3 })));
  render(pane());
  const row = await screen.findByRole('treeitem', { name: /^5 / });
  expect(row.querySelectorAll('mark')).toHaveLength(3);
  expect(row.querySelectorAll('s')).toHaveLength(3);
  expect(row.querySelectorAll('ins')).toHaveLength(3);
  expect(row.querySelector('s')).toHaveTextContent('daemonPort');
  expect(row.querySelector('ins')).toHaveTextContent('daemonAddress');
});

test('an unsaved file keeps the plain highlight, wears the tag and cannot be replaced', async () => {
  dirtyPaths.add(CARD);
  openReplace();
  routes({ changed: [], skipped: [] });
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  const card = screen.getByRole('treeitem', { name: /Card\.tsx/ });
  expect(card).toHaveTextContent('não salvo');
  expect(card).toHaveAttribute('title', 'alterações não salvas no editor: os resultados são do arquivo salvo, e substituir não o altera');
  expect(within(groupOf(/Card\.tsx/)).queryByRole('treeitem', { name: /^1 / })?.querySelector('s')).toBeNull();
  expect(within(groupOf(/Card\.tsx/)).getByRole('treeitem', { name: /^1 / }).querySelector('mark')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'substituir em Card.tsx' })).toBeDisabled();
  expect(within(groupOf(/daemon\.ts/)).getByRole('treeitem', { name: /^1 / }).querySelector('s')).not.toBeNull();
});

test('replace-all asks first: files, occurrences, scope and the unsaved file left out; confirming posts without it', async () => {
  const user = userEvent.setup();
  dirtyPaths.add(CARD);
  openReplace();
  routes({ changed: changedOf('src/daemon.ts'), skipped: [] });
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  await user.click(screen.getByRole('button', { name: 'substituir tudo' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Substituir em 4 arquivos')).toBeInTheDocument();
  expect(within(dialog).getByText('hive/1-task-1 + docs')).toBeInTheDocument();
  expect(dialog).toHaveTextContent('12 ocorrências de daemonPort por daemonAddress. Card.tsx tem alterações não salvas no editor e fica de fora.');
  expect(posts()).toHaveLength(0);
  await user.click(within(dialog).getByRole('button', { name: 'substituir' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toEqual({
    query: { q: 'daemonPort', isCaseSensitive: false, isWholeWord: false, isRegex: false }, replacement: 'daemonAddress',
    files: ['src/daemon.ts', 'src/server.ts', 'src/client.ts', 'src/util.ts'],
  });
});

test('a file\'s replace posts that file alone without asking, and the notice names it', async () => {
  const user = userEvent.setup();
  openReplace();
  routes({ changed: [{ path: 'src/daemon.ts', previous: 'old', version: 'v1', count: 4 }], skipped: [] });
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  await user.click(screen.getByRole('button', { name: 'substituir em daemon.ts' }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect((posts()[0] as { files: string[] }).files).toEqual(['src/daemon.ts']);
  expect(vi.mocked(toast).mock.calls[0]?.[0]).toBe('substituído em daemon.ts');
  expect(vi.mocked(toast).mock.calls[0]?.[1]).toMatchObject({ description: '4 ocorrências.' });
});

test('replace-all\'s notice counts files and occurrences, and its undo puts every previous text back; a 409 is named', async () => {
  const user = userEvent.setup();
  openReplace();
  const paths = ['src/daemon.ts', 'src/server.ts', 'src/client.ts', 'src/util.ts'];
  routes({ changed: changedOf(...paths), skipped: [] }, (body) => (body.path === 'src/server.ts' ? json({ error: 'changed', version: 'v' }, 409) : json({ version: 'v9' })));
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  await user.click(screen.getByRole('button', { name: 'substituir tudo' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'substituir' }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  const [title, options] = vi.mocked(toast).mock.calls[0] as [string, { description: string; action: { label: string; onClick(): void } }];
  expect(title).toBe('substituído em 4 arquivos');
  expect(options.description).toBe('12 ocorrências. as tabs abertas desses arquivos recarregaram.');
  expect(options.action.label).toBe('desfazer');
  options.action.onClick();
  await waitFor(() => expect(toast).toHaveBeenCalledWith('não desfeito em src/server.ts: o arquivo mudou no disco'));
  const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)));
  expect(puts.map((p: { path: string }) => p.path)).toEqual(paths);
  expect(puts[0]).toMatchObject({ text: 'old src/daemon.ts', version: 'v0', format: false });
});

test('a file the replace left out is named in the notice', async () => {
  const user = userEvent.setup();
  openReplace();
  routes({ changed: changedOf('src/daemon.ts'), skipped: [{ path: 'big.json', reason: 'too_large' }] });
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  await user.click(screen.getByRole('button', { name: 'substituir em daemon.ts' }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  expect(vi.mocked(toast).mock.calls[0]?.[1]).toMatchObject({ description: '3 ocorrências. ficaram de fora: big.json' });
});

test('replace-all is disabled while the search runs, with an error, with no results and with no query', async () => {
  openReplace();
  const s = stream(FIVE[0] as SearchFileResult);
  fetchMock.mockImplementation(async () => s.res);
  const running = render(pane());
  expect(await screen.findByRole('button', { name: 'substituir tudo' })).toBeDisabled();
  running.unmount();
  fetchMock.mockImplementation(async () => done({ error: 'boom' }));
  const failed = render(pane());
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'substituir tudo' })).toBeDisabled();
  failed.unmount();
  fetchMock.mockImplementation(async () => done(end({ total: 0, files: 0 })));
  const empty = render(pane());
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('nenhum resultado'));
  expect(screen.getByRole('button', { name: 'substituir tudo' })).toBeDisabled();
  empty.unmount();
  withQuery('');
  setSearchPane({ isReplaceOpen: true });
  render(pane());
  expect(screen.getByRole('button', { name: 'substituir tudo' })).toBeDisabled();
});

test('after a replace the search runs again with the same query', async () => {
  const user = userEvent.setup();
  openReplace();
  routes({ changed: changedOf('src/daemon.ts'), skipped: [] });
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  const before = searches();
  await user.click(screen.getByRole('button', { name: 'substituir em daemon.ts' }));
  await waitFor(() => expect(searches()).toBe(before + 1));
  expect(fetchMock.mock.calls.filter(([url]) => url.includes('/search?')).at(-1)?.[0]).toContain('q=daemonPort&');
});

test('a file that failed in the replace is named apart from the ones left out', async () => {
  const user = userEvent.setup();
  openReplace();
  routes({ changed: changedOf('src/daemon.ts'), skipped: [{ path: 'big.json', reason: 'too_large' }, { path: 'src/server.ts', reason: 'failed' }] });
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  await user.click(screen.getByRole('button', { name: 'substituir em daemon.ts' }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  expect(vi.mocked(toast).mock.calls[0]?.[1]).toMatchObject({ description: '3 ocorrências. ficaram de fora: big.json falharam: src/server.ts' });
});

test('the undo goes on past a failed file and names the failed and the changed apart', async () => {
  const user = userEvent.setup();
  openReplace();
  const paths = ['src/daemon.ts', 'src/server.ts', 'src/client.ts'];
  routes({ changed: changedOf(...paths), skipped: [] }, (body) => (body.path === 'src/daemon.ts' ? json({ error: 'EACCES' }, 500) : body.path === 'src/server.ts' ? json({ error: 'changed' }, 409) : json({ version: 'v9' })));
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  await user.click(screen.getByRole('button', { name: 'substituir tudo' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'substituir' }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  (vi.mocked(toast).mock.calls[0]?.[1] as unknown as { action: { onClick(): void } }).action.onClick();
  await waitFor(() => expect(toast).toHaveBeenCalledWith('não desfeito em src/server.ts: o arquivo mudou no disco'));
  expect(toast.error).toHaveBeenCalledWith('não desfeito em src/daemon.ts: a escrita falhou');
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(3);
});

test('a replace refused for too many matches says so in the page\'s language', async () => {
  const user = userEvent.setup();
  openReplace();
  fetchMock.mockImplementation(async (_url, init) => (init?.method === 'POST' ? json({ error: 'too many', code: 'too_many_matches' }, 413) : done(...FIVE, fiveEnd)));
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  await user.click(screen.getByRole('button', { name: 'substituir em daemon.ts' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('mais de 2.000 ocorrências nesses arquivos: refine a busca antes de substituir'));
});

test('while the query changed and its search has not started, replace-all and the file replaces are off', async () => {
  const user = userEvent.setup();
  openReplace();
  routes({ changed: [], skipped: [] });
  render(pane());
  await screen.findByRole('treeitem', { name: /daemon\.ts/ });
  await waitFor(() => expect(screen.getByRole('button', { name: 'substituir tudo' })).toBeEnabled());
  await user.type(screen.getByRole('textbox', { name: 'buscar nos arquivos' }), 'x');
  expect(screen.getByRole('button', { name: 'substituir tudo' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'substituir em daemon.ts' })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'substituir tudo' })).toBeEnabled());
});
