// One language server as the page talks to it (#780): one per (activity, server binary). The daemon's hello names the root the documents'
// URIs are built from; then initialize, the documents' open, full-text changes debounced, saves and closes. Its state goes to its events.
import type { Diagnostic, InitializeResult, ServerCapabilities } from 'vscode-languageserver-protocol';
import type { ServerPhase } from '@/lib/diagnostics-store';
import { type CancelToken, createRpc, type Rpc } from '@/lib/lsp-rpc';
import { absoluteOf, fileUri, paneOf, pathOfUri } from '../../lsp-uri';
import { type FormatLog, LSP_CLOSE, type LspHello } from '../../types';

export const CHANGE_DEBOUNCE_MS = 150;

export interface LspSocket { send(data: string): void; close(): void; onmessage: ((event: MessageEvent) => void) | null; onclose: ((event: CloseEvent) => void) | null }
export interface DocModel { getValue(): string; onDidChangeContent(listener: () => void): { dispose(): void } }
export interface ClientEvents { phase(phase: ServerPhase, log?: FormatLog): void; diagnostics(uri: string, diagnostics: Diagnostic[]): void }
interface Doc { uri: string; version: number; model: DocModel; sub: { dispose(): void }; timer?: ReturnType<typeof setTimeout> }

// What the page can do with what a server sends (#780): the five features and nothing else
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    completion: { completionItem: { snippetSupport: true, insertReplaceSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail'] } } },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    publishDiagnostics: {},
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } } },
  },
  workspace: { configuration: true, workspaceFolders: true },
};

const isHello = (value: unknown): value is LspHello => typeof value === 'object' && value !== null && typeof (value as LspHello).root === 'string';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class LspClient {
  capabilities?: ServerCapabilities;
  private root?: string;
  private readonly socket: LspSocket;
  private readonly events: ClientEvents;
  private readonly rpc: Rpc;
  private readonly docs = new Map<string, Doc>(); // by the pane's path
  private readonly queued = new Map<string, { languageId: string; model: DocModel }>(); // opened before ready
  private isReady = false;
  private isDisposed = false;

  constructor(socket: LspSocket, events: ClientEvents) {
    this.socket = socket;
    this.events = events;
    this.rpc = createRpc(socket, (method, params) => this.notification(method, params));
    socket.onmessage = (event) => this.message(event.data);
    socket.onclose = (event) => this.closed(event.code, event.reason);
    events.phase({ phase: 'starting' });
  }

  get size(): number { return this.docs.size + this.queued.size; }
  uriOf(path: string): string { return fileUri(absoluteOf(this.root ?? '/', path)); }
  pathOf(uri: string): string { const path = pathOfUri(uri) ?? uri; return this.root === undefined ? path : paneOf(this.root, path); }
  request<T>(method: string, params: unknown, token?: CancelToken): Promise<T> { return this.rpc.request<T>(method, params, token); }

  open(path: string, languageId: string, model: DocModel): void {
    if (this.docs.has(path) || this.queued.has(path)) return;
    if (this.isReady) this.sendOpen(path, languageId, model);
    else this.queued.set(path, { languageId, model });
  }

  saved(path: string): void {
    const doc = this.docs.get(path);
    if (doc === undefined) return;
    if (doc.timer !== undefined) this.flush(path);
    this.rpc.notify('textDocument/didSave', { textDocument: { uri: doc.uri } });
  }

  close(path: string): void {
    this.queued.delete(path);
    const doc = this.docs.get(path);
    if (doc === undefined) return;
    clearTimeout(doc.timer);
    doc.sub.dispose();
    this.docs.delete(path);
    if (this.isReady) this.rpc.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
  }

  dispose(): void {
    this.isDisposed = true;
    this.stopDocs();
    this.rpc.fail('closed');
    this.socket.close();
  }

  private message(data: unknown): void {
    let parsed: unknown;
    try { parsed = JSON.parse(String(data)); } catch { return; }
    if (this.rpc.receive(parsed)) return;
    if (isHello(parsed) && this.root === undefined) void this.start(parsed);
  }

  private async start(hello: LspHello): Promise<void> {
    this.root = hello.root;
    this.events.phase({ phase: 'starting' }, hello.log);
    try {
      const result = await this.rpc.request<InitializeResult>('initialize', { processId: null, clientInfo: { name: 'agent-hive' }, rootUri: null, capabilities: CLIENT_CAPABILITIES });
      this.capabilities = result.capabilities;
      this.rpc.notify('initialized', {});
      this.isReady = true;
      for (const [path, queued] of this.queued) this.sendOpen(path, queued.languageId, queued.model);
      this.queued.clear();
      this.events.phase({ phase: 'ready' });
    } catch (err) {
      if (!this.isDisposed) this.events.phase({ phase: 'failed', reason: err instanceof Error ? err.message : String(err) });
    }
  }

  private sendOpen(path: string, languageId: string, model: DocModel): void {
    const uri = this.uriOf(path);
    const sub = model.onDidChangeContent(() => this.changed(path));
    this.docs.set(path, { uri, version: 1, model, sub });
    this.rpc.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text: model.getValue() } });
  }

  private changed(path: string): void {
    const doc = this.docs.get(path);
    if (doc === undefined) return;
    clearTimeout(doc.timer);
    this.docs.set(path, { ...doc, timer: setTimeout(() => this.flush(path), CHANGE_DEBOUNCE_MS) });
  }

  private flush(path: string): void {
    const doc = this.docs.get(path);
    if (doc === undefined) return;
    clearTimeout(doc.timer);
    const version = doc.version + 1;
    this.docs.set(path, { ...doc, version, timer: undefined });
    this.rpc.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version }, contentChanges: [{ text: doc.model.getValue() }] });
  }

  private notification(method: string, params: unknown): void {
    if (method !== 'textDocument/publishDiagnostics' || !isRecord(params) || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
    this.events.diagnostics(params.uri, params.diagnostics as Diagnostic[]);
  }

  private stopDocs(): void {
    for (const doc of this.docs.values()) { clearTimeout(doc.timer); doc.sub.dispose(); }
  }

  private closed(code: number, reason: string): void {
    this.isReady = false;
    this.rpc.fail(reason || 'closed');
    this.stopDocs();
    if (this.isDisposed) return; // a close of its own says nothing
    if (code === LSP_CLOSE.absent) this.events.phase({ phase: 'absent', reason });
    else if (code === LSP_CLOSE.outOfScope) this.events.phase({ phase: 'off' });
    else this.events.phase({ phase: 'failed', reason: reason || `closed (${code})` });
  }
}
