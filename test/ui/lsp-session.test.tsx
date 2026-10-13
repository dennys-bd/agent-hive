import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as store from '@/lib/diagnostics-store';
import { emitEditorInstall } from '@/lib/editor-install-events';
import { attach, attachKey, resetSessions, setSocketFactory } from '@/lib/lsp-session';
import { EDITOR_DEFAULTS, type EditorConfig } from '../../src/types';
import { answerInitialize, FakeSocket } from './lsp-socket-fake';
import { FakeModel, markers, registered, resetMonacoFakes } from './monaco-fake';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
// #780's tests keep one socket per file: the language-server checkers, on by default, are switched off here
const OFF = { enabled: false, args: [], workspaces: 'all' as const };
const NO_CHECKERS: EditorConfig = { ...EDITOR_DEFAULTS, languages: { typescript: { checkers: { biome: OFF, eslint: OFF, oxlint: OFF } }, python: { checkers: { ruff: OFF } } } };
const input = (path: string, model: FakeModel, editor: EditorConfig = NO_CHECKERS) => ({ activityId: 'a1', workspace: 'hive', path, model: model as never, editor });
const R = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const ready = async (socket: FakeSocket, capabilities: object): Promise<void> => {
  socket.hello('/w/root');
  answerInitialize(socket, capabilities);
  await settle();
  await settle();
};
const serverOf = (socket: FakeSocket): string => socket.url.split('/lsp/')[1].split('?')[0];

beforeEach(() => { FakeSocket.all = []; setSocketFactory((url) => new FakeSocket(url)); });
afterEach(() => { resetSessions(); store.resetDiagnostics(); resetMonacoFakes(); });

test('a TypeScript file opens one socket per binary; providers are registered only for what the server advertises (#780)', async () => {
  const stop = attach(input('src/a.ts', new FakeModel('let a', 'typescript')));
  const stop2 = attach(input('src/b.ts', new FakeModel('let b', 'typescript')));
  expect(FakeSocket.all.map((s) => s.url)).toEqual([`ws://${location.host}/activities/a1/lsp/typescript-language-server?bin=typescript-language-server`]);
  const [socket] = FakeSocket.all;
  await ready(socket, { hoverProvider: true, definitionProvider: true });
  expect(registered.map((r) => `${r.kind}:${r.language}`).sort()).toEqual(['definition:typescript', 'hover:typescript']);
  expect(store.activityStatus('a1')).toMatchObject([{ name: 'typescript-language-server', phase: 'ready', language: 'typescript' }]);
  stop();
  stop2();
  expect(socket.isClosed).toBe(true);
  expect(store.activityStatus('a1')).toEqual([]);
});

test('no socket for a language without a server or checker server, nor for a workspace out of the server\'s scope with its checkers off (#780)', () => {
  attach(input('README.md', new FakeModel('# x', 'markdown')));
  attach(input('a.py', new FakeModel('x', 'python'), { ...NO_CHECKERS, languages: { ...NO_CHECKERS.languages, python: { server: { workspaces: ['web'] }, checkers: { ruff: OFF } } } }));
  expect(FakeSocket.all).toEqual([]);
});

test('publishDiagnostics sets the model\'s markers and the store\'s problems (#780)', async () => {
  const model = new FakeModel('x', 'python');
  attach(input('a.py', model));
  await ready(FakeSocket.all[0], {});
  FakeSocket.all[0].fromServer({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///w/root/a.py', diagnostics: [{ range: R, message: 'bad', severity: 1 }] } });
  await settle();
  expect(markers.at(-1)).toMatchObject({ model, owner: 'lsp', list: [{ message: 'bad', severity: 8 }] });
  expect(store.fileCounts('a1', 'a.py')).toEqual({ errors: 1, warnings: 0, infos: 0 });
  expect(store.problems('a1')[0].problems[0].source).toBe('pyright');
});

test('a server installed after its client found it absent gets a new socket (#780)', () => {
  attach(input('a.py', new FakeModel('x', 'python')));
  FakeSocket.all[0].closeWith(4404, 'not installed');
  expect(store.activityStatus('a1')).toMatchObject([{ name: 'pyright', phase: 'absent', reason: 'not installed' }]);
  emitEditorInstall({ kind: 'server', id: 'pyright', state: { state: 'installed', version: '1.2.3' } });
  expect(FakeSocket.all).toHaveLength(2);
  expect(store.activityStatus('a1')).toMatchObject([{ name: 'pyright', phase: 'starting' }]);
});

test('when its server dies the squiggles go with it: the model\'s lsp markers are cleared (#780)', async () => {
  const model = new FakeModel('x', 'python');
  attach(input('a.py', model));
  const [socket] = FakeSocket.all;
  await ready(socket, {});
  socket.fromServer({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///w/root/a.py', diagnostics: [{ range: R, message: 'bad', severity: 1 }] } });
  await settle();
  socket.closeWith(1011, 'exit code 3');
  await settle();
  expect(markers.at(-1)).toMatchObject({ model, owner: 'lsp', list: [] });
});

test('a file opened after its client failed starts a new one with the files already there; a ready client is shared (#780)', async () => {
  attach(input('a.py', new FakeModel('x', 'python')));
  const [socket] = FakeSocket.all;
  await ready(socket, {});
  attach(input('c.py', new FakeModel('z', 'python')));
  expect(FakeSocket.all).toHaveLength(1);
  socket.closeWith(1011, 'exit code 3');
  expect(store.activityStatus('a1')).toMatchObject([{ name: 'pyright', phase: 'failed' }]);
  attach(input('b.py', new FakeModel('y', 'python')));
  expect(FakeSocket.all).toHaveLength(2);
  expect(socket.isClosed).toBe(true);
  expect(store.activityStatus('a1')).toMatchObject([{ name: 'pyright', phase: 'starting', language: 'python' }]); // one client, both files on it
});

test('the completion provider gets the server\'s trigger characters (#780)', async () => {
  attach(input('a.py', new FakeModel('x', 'python')));
  await ready(FakeSocket.all[0], { completionProvider: { triggerCharacters: ['.', '('] } });
  const provider = registered.find((r) => r.kind === 'completion')?.provider as { triggerCharacters?: string[] } | undefined;
  expect(provider?.triggerCharacters).toEqual(['.', '(']);
});

test('a Python file attaches to pyright and to ruff, on by default; ruff\'s client registers quick fixes only, owns its markers and sources its problems (#782)', async () => {
  const model = new FakeModel('x', 'python');
  attach(input('a.py', model, EDITOR_DEFAULTS));
  expect(FakeSocket.all.map(serverOf)).toEqual(['pyright', 'ruff']);
  const ruff = FakeSocket.all[1];
  await ready(ruff, { hoverProvider: true, completionProvider: {}, codeActionProvider: true });
  expect(registered.map((r) => `${r.kind}:${r.language}`)).toEqual(['codeAction:python']);
  ruff.fromServer({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///w/root/a.py', diagnostics: [{ range: R, message: 'unused import', severity: 2, code: 'F401' }] } });
  await settle();
  expect(markers.at(-1)).toMatchObject({ model, owner: 'lsp:ruff', list: [{ message: 'unused import' }] });
  expect(store.problems('a1')[0].problems[0]).toMatchObject({ source: 'ruff', code: 'F401', severity: 'warning' });
  expect(store.activityStatus('a1')).toMatchObject([{ name: 'pyright', kind: 'server', language: 'python' }, { name: 'ruff', kind: 'server', phase: 'ready' }]);
});

test('the quick fix provider asks every client of the model whose server offers quick fixes: the language\'s and its checkers\' (#782)', async () => {
  const model = new FakeModel('x', 'python');
  attach(input('a.py', model, EDITOR_DEFAULTS));
  for (const socket of FakeSocket.all) await ready(socket, { codeActionProvider: true });
  const provider = registered.find((r) => r.kind === 'codeAction')?.provider as { provideCodeActions(...args: unknown[]): Promise<unknown> };
  void provider.provideCodeActions(model, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, { markers: [] }, undefined);
  await settle();
  expect(FakeSocket.all.map((s) => s.methods().includes('textDocument/codeAction'))).toEqual([true, true]);
});

test('attachKey names every binary that would serve a file, and changes when a checker is switched off (#782)', () => {
  expect(attachKey('src/a.ts', 'hive', EDITOR_DEFAULTS)).toBe('typescript-language-server biome vscode-eslint-language-server oxlint');
  expect(attachKey('src/a.ts', 'hive', NO_CHECKERS)).toBe('typescript-language-server');
  expect(attachKey('README.md', 'hive', EDITOR_DEFAULTS)).toBeUndefined();
  const withArgs = { ...EDITOR_DEFAULTS, languages: { ...EDITOR_DEFAULTS.languages, typescript: { ...EDITOR_DEFAULTS.languages.typescript, checkers: { biome: { enabled: true, args: ['--colors=off'], workspaces: 'all' as const } } } } };
  expect(attachKey('src/a.ts', 'hive', withArgs)).not.toBe(attachKey('src/a.ts', 'hive', EDITOR_DEFAULTS));
});
