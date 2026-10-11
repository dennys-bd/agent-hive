import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EditorPane } from '@/components/EditorPane';
import { EditorLanguagesContext } from '@/components/editor-languages';
import { FileOpenerContext } from '@/components/terminal-tabs';
import { ConsoleContext } from '@/hooks/use-console';
import { setLanguage } from '@/i18n';
import * as store from '@/lib/diagnostics-store';
import { problemsOf } from './problem-fake';
import * as models from '@/lib/editor-models';
import * as fileBase from '@/lib/file-base';
import * as checks from '@/lib/check-session';
import * as lsp from '@/lib/lsp-session';
import { EDITOR_DEFAULTS } from '../../src/types';
import { jsonResponse } from '../fakes';
import { FakeEditor, FakeModel, resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);
vi.mock('@/lib/lsp-session', async (importOriginal) => ({ ...(await importOriginal<object>()), attach: vi.fn(() => () => undefined), setOpener: vi.fn(() => () => undefined), notifySaved: vi.fn() }));
vi.mock('@/lib/check-session', async (importOriginal) => ({ ...(await importOriginal<object>()), attachChecks: vi.fn(() => () => undefined), notifyChecksSaved: vi.fn() }));

const A = 'a-I1';
const PATH = 'src/a.ts';
const fileRead = (text: string, version: string) => ({ status: 200, body: { path: PATH, text, version } });
// What the disk answers: the file's read, its version (null: gone) and the next save's answer
let read: { status: number; body: unknown } = fileRead('one\n', 'v1');
let version: string | null = 'v1';
let saved: (() => Response) | undefined;
let base: unknown = { against: 'head', label: 'HEAD', oid: 'o1', text: 'one\n' }; // what the file-base route answers (#668)
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'PUT') return saved?.() ?? jsonResponse({ version: 'v2' });
  if (init?.method === 'POST') return new Response(null, { status: 204 });
  if (url.includes('/file-base')) return jsonResponse(base);
  if (url.includes('/file-version')) return version === null ? jsonResponse({ error: 'file not found' }, 404) : jsonResponse({ version });
  return jsonResponse(read.body, read.status);
});
const sent = (method: 'PUT' | 'POST'): string[] => fetchMock.mock.calls.flatMap(([url, init]) => (init?.method === method ? [`${url} ${String(init.body)}`] : []));
const pane = () => <EditorPane activityId={A} path={PATH} label="#1 Task 1 · a.ts" active fontFamily="ui-monospace, monospace" workspace="hive" openKey="I1" />;
const ready = async (): Promise<FakeModel> => {
  await waitFor(() => expect(FakeEditor.all).toHaveLength(1));
  return FakeModel.all[0];
};

beforeEach(() => {
  setLanguage('pt');
  read = fileRead('one\n', 'v1');
  version = 'v1';
  saved = undefined;
  base = { against: 'head', label: 'HEAD', oid: 'o1', text: 'one\n' };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  models.closeExcept(new Set());
  fileBase.closeExcept(new Set());
  resetMonacoFakes();
  vi.unstubAllGlobals();
});

test('a file the pane cannot hold shows why, in the pane\'s own words; the bar has no salvar (#717, #780)', async () => {
  const cases: [number, string][] = [[404, 'arquivo não encontrado'], [413, 'arquivo grande demais para o editor'], [415, 'arquivo binário ou fora de UTF-8'], [500, 'disco cheio']];
  for (const [status, text] of cases) {
    read = { status, body: { error: 'disco cheio' } };
    const { unmount } = render(pane());
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: 'salvar' })).not.toBeInTheDocument();
    unmount();
  }
});

test('a save PUTs the buffer over the version read, and a refusal other than 409 shows in the bar, the edits kept; a save over a clean buffer writes nothing (#717)', async () => {
  render(pane());
  const model = await ready();
  expect(screen.getByRole('region', { name: '#1 Task 1 · a.ts' })).toBeInTheDocument();
  act(() => FakeEditor.all[0].onSave());
  expect(sent('PUT')).toHaveLength(0);
  act(() => model.type('two\n'));
  saved = () => jsonResponse({ error: 'disco cheio' }, 500);
  act(() => FakeEditor.all[0].onSave());
  expect(await screen.findByRole('alert')).toHaveTextContent('disco cheio');
  expect(models.isDirty(A, PATH)).toBe(true);
  saved = undefined;
  act(() => FakeEditor.all[0].onSave());
  await waitFor(() => expect(models.isDirty(A, PATH)).toBe(false));
  expect(sent('PUT')).toEqual(new Array<string>(2).fill('/activities/a-I1/file {"path":"src/a.ts","text":"two\\n","version":"v1","format":true}'));
  act(() => FakeEditor.all[0].onSave());
  expect(sent('PUT')).toHaveLength(2);
});

test('a version that moved on raises mudou no disco over unsaved edits: manter o meu keeps them on the disk\'s version, recarregar takes the disk\'s text; a clean buffer follows the disk by itself (#717)', async () => {
  const user = userEvent.setup();
  render(pane());
  const model = await ready();
  act(() => model.type('mine\n'));
  version = 'v2';
  fireEvent.focus(window);
  expect(await screen.findByRole('status')).toHaveTextContent('mudou no disco');
  await user.click(screen.getByRole('button', { name: 'manter o meu' }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect([models.isDirty(A, PATH), models.baseOf(A, PATH), model.getValue()]).toEqual([true, 'v2', 'mine\n']);
  version = 'v3';
  read = fileRead('theirs\n', 'v3');
  fireEvent.focus(window);
  await user.click(await screen.findByRole('button', { name: 'recarregar' }));
  await waitFor(() => expect(model.getValue()).toBe('theirs\n'));
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  version = 'v4';
  read = fileRead('again\n', 'v4');
  fireEvent.focus(window);
  await waitFor(() => expect(model.getValue()).toBe('again\n'));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('a save the disk refused with 409 raises the same strip; a file gone from the disk says so and keeps the buffer (#717)', async () => {
  render(pane());
  const model = await ready();
  act(() => model.type('mine\n'));
  saved = () => jsonResponse({ error: 'o arquivo mudou no disco', version: 'v9' }, 409);
  act(() => FakeEditor.all[0].onSave());
  expect(await screen.findByRole('status')).toHaveTextContent('mudou no disco');
  version = null;
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('arquivo não encontrado'));
  expect(screen.queryByRole('button', { name: 'recarregar' })).not.toBeInTheDocument();
  expect([model.getValue(), models.isDirty(A, PATH)]).toEqual(['mine\n', true]);
});

test('the pane carries its activity and path, what the search reads as the focus (#697)', async () => {
  render(pane());
  await ready(); // a pane unmounted before its file is read would open the model into the next test
  const region = screen.getByRole('region', { name: '#1 Task 1 · a.ts' });
  expect([region.dataset.fileActivity, region.dataset.filePath]).toEqual([A, PATH]);
});

test('⌘S saves formatted and ⌥⌘S as typed; a failed format shows formatação falhou with ver log, which opens its console run, until the next save (#749)', async () => {
  const user = userEvent.setup();
  const openConsole = vi.fn();
  render(<ConsoleContext.Provider value={openConsole}>{pane()}</ConsoleContext.Provider>);
  const model = await ready();
  act(() => model.type('two\n'));
  saved = () => jsonResponse({ version: 'v2', formatError: 'exit code 2', formatLog: { channel: 'format:hive:ruff', run: 'r1' } });
  act(() => FakeEditor.all[0].onSave());
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('formatação falhou');
  expect(alert).toHaveAttribute('title', 'exit code 2');
  await user.click(screen.getByRole('button', { name: 'ver log' }));
  expect(openConsole).toHaveBeenCalledWith('format:hive:ruff', 'r1', true);
  act(() => model.type('three\n'));
  saved = () => jsonResponse({ version: 'v3' });
  act(() => FakeEditor.all[0].onSaveUnformatted());
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(sent('PUT')).toEqual([
    '/activities/a-I1/file {"path":"src/a.ts","text":"two\\n","version":"v1","format":true}',
    '/activities/a-I1/file {"path":"src/a.ts","text":"three\\n","version":"v2","format":false}',
  ]);
});

test('without a console (no Dashboard) a failed format shows its words alone (#749)', async () => {
  render(pane());
  const model = await ready();
  act(() => model.type('two\n'));
  saved = () => jsonResponse({ version: 'v2', formatError: 'exit code 2', formatLog: { channel: 'format:hive:ruff', run: 'r1' } });
  act(() => FakeEditor.all[0].onSave());
  expect(await screen.findByRole('alert')).toHaveTextContent('formatação falhou');
  expect(screen.queryByRole('button', { name: 'ver log' })).not.toBeInTheDocument();
});

test('the model attaches to its language server with the editor config; a save tells it (#780)', async () => {
  render(pane());
  const model = await ready();
  expect(lsp.attach).toHaveBeenCalledWith({ activityId: A, workspace: 'hive', path: PATH, model, editor: EDITOR_DEFAULTS });
  act(() => model.type('two\n'));
  act(() => FakeEditor.all[0].onSave());
  await waitFor(() => expect(lsp.notifySaved).toHaveBeenCalledWith(A, PATH));
  expect(checks.attachChecks).toHaveBeenCalledWith({ activityId: A, workspace: 'hive', path: PATH, model, editor: EDITOR_DEFAULTS });
  expect(checks.notifyChecksSaved).toHaveBeenCalledWith(A, PATH);
});

test('the bar shows the server starting, its name once ready, failed with ver log, or none with instalar; the counts sit in the problems button (#780, #782)', async () => {
  const user = userEvent.setup();
  const openLanguage = vi.fn();
  const openConsole = vi.fn();
  render(
    <ConsoleContext.Provider value={openConsole}>
      <EditorLanguagesContext.Provider value={{ editor: EDITOR_DEFAULTS, openLanguage }}>{pane()}</EditorLanguagesContext.Provider>
    </ConsoleContext.Provider>,
  );
  expect(screen.queryByTestId('server-status')).not.toBeInTheDocument();
  act(() => { store.setClient('k', A, 'typescript-language-server', { phase: 'starting' }, { channel: 'lsp:hive:ts', run: 'r1' }); store.bindFile(A, PATH, 'k', 'typescript'); });
  expect(screen.getByText('typescript-language-server · iniciando')).toBeInTheDocument();
  act(() => { store.setClient('k', A, 'typescript-language-server', { phase: 'ready' }); store.setDiagnostics('k', PATH, problemsOf(PATH, { errors: 1, infos: 2 })); });
  expect(screen.getByTestId('server-status')).toHaveTextContent(/^typescript-language-server$/);
  const counts = screen.getByRole('button', { name: 'problemas' });
  expect(counts).toHaveTextContent(/^1 erro\s*·\s*2 info$/);
  expect(within(counts).getByText('1 erro')).toHaveClass('text-destructive');
  expect(within(counts).getByText('2 info')).toHaveClass('text-review');
  act(() => store.setClient('k', A, 'typescript-language-server', { phase: 'failed', reason: 'spawn node ENOENT' }));
  expect(screen.getByText('typescript-language-server falhou')).toHaveAttribute('title', 'spawn node ENOENT');
  expect(counts).toHaveTextContent(/^problemas$/);
  await user.click(within(screen.getByTestId('server-status')).getByRole('button', { name: 'ver log' }));
  expect(openConsole).toHaveBeenCalledWith('lsp:hive:ts', 'r1', true);
  act(() => store.setClient('k', A, 'typescript-language-server', { phase: 'absent', reason: 'not installed' }));
  expect(screen.getByText('sem language server')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'instalar typescript-language-server' }));
  expect(openLanguage).toHaveBeenCalledWith('typescript');
  act(() => store.setClient('k', A, 'typescript-language-server', { phase: 'off' }));
  expect(screen.queryByTestId('server-status')).not.toBeInTheDocument();
});

test('the bar shows one entry per checker: ready and running with their dots, failed in red with ver log, one not in the project left out (#850); the problems button is pressed while open (#782)', async () => {
  const user = userEvent.setup();
  const openConsole = vi.fn();
  render(<ConsoleContext.Provider value={openConsole}>{pane()}</ConsoleContext.Provider>);
  await ready();
  act(() => {
    store.setClient('b', A, 'biome', { phase: 'ready' }, undefined, 'biome');
    store.bindFile(A, PATH, 'b', 'typescript');
    store.setClient('e', A, 'eslint', { phase: 'absent', reason: 'not installed' }, undefined, 'eslint');
    store.bindFile(A, PATH, 'e', 'typescript');
    store.bindChecks(A, PATH, ['tsc']);
    store.checkStarted(A, 'tsc', '');
  });
  expect(screen.getByText('biome')).toBeInTheDocument();
  expect(screen.queryByText('eslint')).not.toBeInTheDocument();
  expect(screen.getByText('tsc')).toBeInTheDocument();
  act(() => store.setCheck(A, 'tsc', { state: 'failed', reason: 'exit code 2', log: { channel: 'check:hive:tsc', run: 'r9' } }, ''));
  expect(screen.getByText('tsc falhou')).toHaveAttribute('title', 'exit code 2');
  await user.click(screen.getByRole('button', { name: 'ver log' }));
  expect(openConsole).toHaveBeenCalledWith('check:hive:tsc', 'r9', true);
  const button = screen.getByRole('button', { name: 'problemas' });
  expect(button).toHaveAttribute('aria-pressed', 'false');
  await user.click(button);
  expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(button).toHaveClass('bg-accent');
  expect(button).toHaveClass('h-5'); // a 20px control in the 24px bar (#946)
  expect(button.parentElement).toHaveClass('h-6');
});

test('a Settings save that leaves this file\'s server as it was does not reconnect it; one that turns it off detaches (#780)', async () => {
  const attached = vi.mocked(lsp.attach);
  const detach = vi.fn();
  attached.mockClear();
  attached.mockReturnValue(detach);
  const withEditor = (editor: typeof EDITOR_DEFAULTS) => <EditorLanguagesContext.Provider value={{ editor, openLanguage: vi.fn() }}>{pane()}</EditorLanguagesContext.Provider>;
  const { rerender } = render(withEditor(EDITOR_DEFAULTS));
  await ready();
  await waitFor(() => expect(attached).toHaveBeenCalledTimes(1));
  rerender(withEditor({ ...EDITOR_DEFAULTS, formatOnSave: { ...EDITOR_DEFAULTS.formatOnSave } }));
  expect(attached).toHaveBeenCalledTimes(1);
  expect(detach).not.toHaveBeenCalled();
  const OFF = { enabled: false, args: [], workspaces: 'all' as const };
  rerender(withEditor({ ...EDITOR_DEFAULTS, languages: { typescript: { server: { workspaces: [] }, checkers: { biome: OFF, eslint: OFF, oxlint: OFF } } } }));
  expect(detach).toHaveBeenCalledTimes(1);
  expect(attached).toHaveBeenCalledTimes(1);
});

test('each version poll asks the file\'s base too, HEAD by default, and the store keeps its answer (#668)', async () => {
  render(pane());
  await ready();
  fireEvent.focus(window);
  await waitFor(() => expect(fileBase.baseOf(A, PATH)).toEqual({ against: 'head', label: 'HEAD', oid: 'o1', text: 'one\n' }));
  expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/activities/a-I1/file-base?path=src%2Fa.ts&against=head');
});

test('the editor marks its buffer\'s changes against the base in the gutter, and its unmount clears them (#668)', async () => {
  base = { against: 'head', label: 'HEAD', oid: 'o1', text: 'zero\n' };
  const { unmount } = render(pane());
  await ready();
  const editor = FakeEditor.all[0];
  await waitFor(() => expect(editor.decorations.map((d) => d.options.linesDecorationsClassName)).toEqual(['hive-change-modify']));
  unmount();
  expect(editor.decorations).toEqual([]);
});

test('the problems button opens the list under the code and its × closes it; a click on a problem opens its file through the pane\'s opener (#782)', async () => {
  const user = userEvent.setup();
  const openFile = vi.fn(() => true);
  render(<FileOpenerContext.Provider value={openFile}>{pane()}</FileOpenerContext.Provider>);
  await ready();
  act(() => store.setCheck(A, 'tsc', { state: 'done', scope: 'project', diagnostics: [{ path: 'src/Column.tsx', line: 9, column: 14, severity: 'error', message: "Cannot find name 'x'." }] }, ''));
  expect(screen.queryByRole('region', { name: 'problemas' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'problemas' }));
  await user.click(within(screen.getByRole('region', { name: 'problemas' })).getByRole('button', { name: /Cannot find name/ }));
  expect(openFile).toHaveBeenCalledWith('I1', 'src/Column.tsx', { line: 9, col: 14 });
  await user.click(screen.getByRole('button', { name: 'fechar problemas' }));
  expect(screen.queryByRole('region', { name: 'problemas' })).not.toBeInTheDocument();
});
