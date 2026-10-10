import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ServerPhase } from '@/lib/diagnostics-store';
import { CHANGE_DEBOUNCE_MS, LspClient } from '@/lib/lsp-client';
import { answerInitialize, FakeSocket } from './lsp-socket-fake';

class Doc {
  private text: string;
  private listeners: (() => void)[] = [];
  constructor(text: string) { this.text = text; }
  getValue(): string { return this.text; }
  onDidChangeContent(listener: () => void): { dispose(): void } { this.listeners.push(listener); return { dispose: () => { this.listeners = []; } }; }
  type(text: string): void { this.text = text; for (const l of this.listeners) l(); }
}

let phases: ServerPhase[];
let diagnostics: [string, unknown[]][];
const client = (socket: FakeSocket): LspClient => new LspClient(socket, { phase: (p) => phases.push(p), diagnostics: (uri, list) => diagnostics.push([uri, list]) });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { phases = []; diagnostics = []; FakeSocket.all = []; });
afterEach(() => vi.useRealTimers());

test('after the hello it initializes, then opens what was opened before with file URIs under the root, and reads ready (#780)', async () => {
  const socket = new FakeSocket();
  const lsp = client(socket);
  lsp.open('src/a.ts', 'typescript', new Doc('let a'));
  socket.hello('/w/root');
  expect(socket.methods()).toEqual(['initialize']);
  answerInitialize(socket, { hoverProvider: true });
  await flush();
  expect(socket.methods()).toEqual(['initialize', 'initialized', 'textDocument/didOpen']);
  expect(socket.sent[2].params).toEqual({ textDocument: { uri: 'file:///w/root/src/a.ts', languageId: 'typescript', version: 1, text: 'let a' } });
  expect(phases.at(-1)).toEqual({ phase: 'ready' });
  expect(lsp.capabilities).toEqual({ hoverProvider: true });
  expect([lsp.pathOf('file:///w/root/src/b.ts'), lsp.pathOf('file:///other/c.ts')]).toEqual(['src/b.ts', '/other/c.ts']);
});

test('didChange is debounced to one full text; didSave sends a pending change first; close sends didClose (#780)', async () => {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const lsp = client(socket);
  socket.hello();
  answerInitialize(socket, {});
  await vi.runAllTimersAsync();
  const doc = new Doc('a');
  lsp.open('a.ts', 'typescript', doc);
  doc.type('ab');
  doc.type('abc');
  vi.advanceTimersByTime(CHANGE_DEBOUNCE_MS);
  expect(socket.sent.filter((m) => m.method === 'textDocument/didChange').map((m) => m.params)).toEqual([{ textDocument: { uri: 'file:///w/root/a.ts', version: 2 }, contentChanges: [{ text: 'abc' }] }]);
  doc.type('abcd');
  lsp.saved('a.ts');
  expect(socket.methods().slice(-2)).toEqual(['textDocument/didChange', 'textDocument/didSave']);
  lsp.close('a.ts');
  expect(socket.methods().at(-1)).toBe('textDocument/didClose');
  expect(lsp.size).toBe(0);
});

test('publishDiagnostics reaches the events; a cancelled request sends $/cancelRequest (#780)', async () => {
  const socket = new FakeSocket();
  const lsp = client(socket);
  socket.hello();
  answerInitialize(socket, {});
  await flush();
  socket.fromServer({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///w/root/a.ts', diagnostics: [{ message: 'x' }] } });
  expect(diagnostics).toEqual([['file:///w/root/a.ts', [{ message: 'x' }]]]);
  let cancel = (): void => undefined;
  const token = { isCancellationRequested: false, onCancellationRequested: (l: () => void) => { cancel = l; return { dispose: () => undefined }; } };
  const asked = lsp.request('textDocument/hover', {}, token);
  cancel();
  await expect(asked).rejects.toThrow('cancelled');
  const hover = socket.sent.find((m) => m.method === 'textDocument/hover');
  expect(socket.sent.at(-1)).toEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: hover?.id } });
});

test('a close 4404 reads absent with its reason, 4403 off, 1011 failed; a dispose of its own reads nothing (#780)', () => {
  for (const [code, reason, phase] of [[4404, 'requires node', { phase: 'absent', reason: 'requires node' }], [4403, 'pyright is off in hive', { phase: 'off' }], [1011, 'exit code 3', { phase: 'failed', reason: 'exit code 3' }]] as const) {
    const socket = new FakeSocket();
    client(socket);
    socket.closeWith(code, reason);
    expect(phases.at(-1)).toEqual(phase);
  }
  const socket = new FakeSocket();
  const lsp = client(socket);
  const before = phases.length;
  lsp.dispose();
  socket.closeWith(1005, '');
  expect([socket.isClosed, phases.length]).toEqual([true, before]);
});
