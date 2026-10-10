// One language server process (#780), shared by every client of its (folder, binary). The host rewrites each client's request ids so answers
// go back to their sender, sends initialize once with the root, answers every request the server makes itself, and keeps the process's end:
// a client's shutdown and exit never reach the server.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { type ChannelInfo, type ConsoleStore, commandLine, crlf, failLine, runHeader } from './console.js';
import { createDecoder, frame } from './lsp-framing.js';
import { fileUri } from './lsp-uri.js';
import { type FormatLog, LSP_CLOSE } from './types.js';

export interface LspPeer { send(message: object): void; close(code: number, reason: string): void }
export interface ProcessSpec {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  root: string; // initialize's root
  shown: string; // the run's command line: the catalog's binary and its args, never an install path
  channel: ChannelInfo; label: string; consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  onGone(): void; // the process ended: the host forgets it
  graceMs?: number; // each wait of a stop, before SIGTERM and again before SIGKILL; a test shortens it
  configuration?: unknown; // what the host answers each workspace/configuration item with; null when absent (#782: eslint's settings)
  afterInitialized?: object[]; // notifications the host writes once, right after the first initialized (#794: the JSON server's schemas)
  notice?: string; // a line of the run after the command (#794: why the JSON schemas are missing)
}
export interface LspProcess {
  readonly log: FormatLog;
  join(peer: LspPeer): void;
  leave(peer: LspPeer): number; // the clients left
  fromPeer(peer: LspPeer, message: unknown): void;
  stop(closing?: { code: number; reason: string }): Promise<void>; // `closing` is how the clients' sockets close, else 1000
}

type Id = string | number;
interface Message { id?: Id | null; method?: string; params?: unknown; result?: unknown; error?: unknown }
interface Asked { peer: LspPeer; id: Id }

const STOP_GRACE_MS = 2_000;
const KILL_ATTEMPTS = ['SIGTERM', 'SIGKILL'] as const; // a server that ignores SIGTERM must not hold stopAll forever
const METHOD_NOT_FOUND = -32601;
const NORMAL_CLOSURE = 1000;
const REASON_MAX = 120; // a close reason is at most 123 bytes
const INIT_ID = 'hive-initialize';
const SHUTDOWN_ID = 'hive-shutdown';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasId = (m: Message): m is Message & { id: Id } => m.id !== undefined && m.id !== null;

function failureOf(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit code ${code}`;
  return signal === null ? 'exited' : `killed by ${signal}`;
}

// The server's own requests the host answers (#780): every server runs on its defaults and reads the project's config files
function hostAnswer(method: string, params: unknown, root: string, configuration: unknown = null): { result: unknown } | undefined {
  switch (method) {
    case 'workspace/configuration': return { result: (isRecord(params) && Array.isArray(params.items) ? params.items : []).map(() => configuration) };
    case 'client/registerCapability': case 'client/unregisterCapability': case 'window/workDoneProgress/create': case 'window/showMessageRequest':
      return { result: null };
    case 'workspace/workspaceFolders': return { result: [{ uri: fileUri(root), name: basename(root) }] };
    case 'workspace/applyEdit': return { result: { applied: false } };
    default: return undefined;
  }
}

class ServerProcess implements LspProcess {
  readonly log: FormatLog;
  private readonly spec: ProcessSpec;
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  private readonly peers = new Set<LspPeer>();
  private readonly pending = new Map<string, Asked>(); // the host's id → the client's
  private waiting: Asked[] = []; // initialize asked before the first one answered
  private init?: { result?: unknown; error?: unknown };
  private next = 0;
  private isInitializing = false;
  private isInitialized = false;
  private isStopping = false;
  private closing?: { code: number; reason: string };
  private isGone = false;

  constructor(spec: ProcessSpec) {
    this.spec = spec;
    this.log = { channel: spec.channel.id, run: randomUUID() };
    spec.consoleStore.begin(spec.channel, this.log.run, runHeader(spec.label, new Date()));
    this.append(`${commandLine(`> ${spec.shown}`)}\r\n`);
    if (spec.notice !== undefined) this.append(`${spec.notice}\r\n`);
    this.child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.child.stdout?.on('data', createDecoder((m) => this.fromServer(m), (reason) => this.append(`${failLine(reason)}\r\n`), (reason) => { this.append(`${failLine(reason)}\r\n`); this.child.kill('SIGKILL'); }));
    this.child.stderr?.on('data', (chunk: Buffer) => this.append(crlf(chunk.toString('utf8'))));
    this.child.stdin?.on('error', () => undefined); // EPIPE once the server died: its close tells
    this.child.on('error', (err: NodeJS.ErrnoException) => this.end(err.code === 'ENOENT' ? `spawn ${spec.shown.split(' ')[0]} ENOENT` : `failed to run (${err.code ?? 'unknown'})`));
    this.child.on('close', (code, signal) => this.end(this.isStopping ? undefined : failureOf(code, signal)));
  }

  join(peer: LspPeer): void { this.peers.add(peer); }

  leave(peer: LspPeer): number {
    this.peers.delete(peer);
    for (const [key, asked] of this.pending) if (asked.peer === peer) this.pending.delete(key);
    this.waiting = this.waiting.filter((asked) => asked.peer !== peer);
    return this.peers.size;
  }

  fromPeer(peer: LspPeer, raw: unknown): void {
    if (!isRecord(raw) || this.isGone || typeof raw.method !== 'string') return; // a client never answers the server: its requests stop here
    const message = raw as unknown as Message & { method: string }; // shape checked field by field below
    if (!hasId(message)) {
      this.notifyFromPeer(peer, message);
      return;
    }
    if (message.method === 'shutdown') {
      peer.send({ jsonrpc: '2.0', id: message.id, result: null });
      return;
    }
    if (message.method === 'initialize') {
      this.initialize({ peer, id: message.id }, message.params);
      return;
    }
    this.write({ ...message, id: this.track(peer, message.id) });
  }

  stop(closing?: { code: number; reason: string }): Promise<void> {
    if (this.isGone) return Promise.resolve();
    this.isStopping = true;
    this.closing = closing;
    this.write({ id: SHUTDOWN_ID, method: 'shutdown' });
    const grace = this.spec.graceMs ?? STOP_GRACE_MS;
    const timers = KILL_ATTEMPTS.map((signal, i) => setTimeout(() => this.child.kill(signal), grace * (i + 1)));
    return this.exited.finally(() => timers.forEach(clearTimeout));
  }

  private notifyFromPeer(peer: LspPeer, message: Message & { method: string }): void {
    if (message.method === 'exit') return; // the host owns the process's end
    if (message.method === 'initialized') {
      if (this.isInitialized) return;
      this.isInitialized = true;
      this.write(message);
      for (const notification of this.spec.afterInitialized ?? []) this.write(notification); // a server takes configuration only once initialized
      return;
    }
    if (message.method === '$/cancelRequest') {
      this.cancel(peer, message.params);
      return;
    }
    this.write(message);
  }

  private track(peer: LspPeer, id: Id): string {
    const hostId = `h${this.next}`;
    this.next += 1;
    this.pending.set(hostId, { peer, id });
    return hostId;
  }

  private cancel(peer: LspPeer, params: unknown): void {
    const id = isRecord(params) ? params.id : undefined;
    const hostId = [...this.pending].find(([, asked]) => asked.peer === peer && asked.id === id)?.[0];
    if (hostId !== undefined) this.write({ method: '$/cancelRequest', params: { id: hostId } });
  }

  private initialize(asked: Asked, params: unknown): void {
    if (this.init) {
      this.answerInit(asked);
      return;
    }
    this.waiting = [...this.waiting, asked];
    if (this.isInitializing) return;
    this.isInitializing = true;
    const root = this.spec.root;
    const folders = [{ uri: fileUri(root), name: basename(root) }];
    this.write({ id: INIT_ID, method: 'initialize', params: { ...(isRecord(params) ? params : {}), processId: process.pid, rootPath: root, rootUri: fileUri(root), workspaceFolders: folders } });
  }

  private answerInit({ peer, id }: Asked): void {
    peer.send({ jsonrpc: '2.0', id, ...(this.init?.error === undefined ? { result: this.init?.result } : { error: this.init.error }) });
  }

  private fromServer(raw: unknown): void {
    if (!isRecord(raw)) return;
    const message = raw as unknown as Message;
    if (message.method === undefined) {
      this.response(message);
      return;
    }
    if (hasId(message)) {
      this.serverRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      for (const peer of this.peers) peer.send(message);
    } else if ((message.method === 'window/logMessage' || message.method === 'window/showMessage') && isRecord(message.params) && typeof message.params.message === 'string') {
      this.append(crlf(`${message.params.message}\n`));
    }
  }

  private response(message: Message): void {
    const key = String(message.id);
    if (key === INIT_ID) {
      this.init = { result: message.result, error: message.error };
      const waiting = this.waiting;
      this.waiting = [];
      for (const asked of waiting) this.answerInit(asked);
      return;
    }
    if (key === SHUTDOWN_ID) {
      this.write({ method: 'exit' });
      return;
    }
    const asked = this.pending.get(key);
    if (asked === undefined) return;
    this.pending.delete(key);
    asked.peer.send({ ...message, id: asked.id });
  }

  private serverRequest(id: Id, method: string, params: unknown): void {
    const answer = hostAnswer(method, params, this.spec.root, this.spec.configuration);
    this.write(answer ? { id, result: answer.result } : { id, error: { code: METHOD_NOT_FOUND, message: `${method} is not handled by the Hive` } });
  }

  private write(message: object): void {
    if (!this.isGone && this.child.stdin?.writable) this.child.stdin.write(frame({ jsonrpc: '2.0', ...message }));
  }

  private append(text: string): void { this.spec.consoleStore.append(this.log.run, text); }

  // Once: a spawn failure fires error, then close
  private end(failure: string | undefined): void {
    if (this.isGone) return;
    this.isGone = true;
    if (failure !== undefined) this.append(`${failLine(failure)}\r\n`);
    this.spec.consoleStore.end(this.log.run, failure === undefined ? 0 : 1);
    const { code, reason } = failure === undefined ? (this.closing ?? { code: NORMAL_CLOSURE, reason: 'stopped' }) : { code: LSP_CLOSE.crashed, reason: failure };
    for (const peer of this.peers) peer.close(code, reason.slice(0, REASON_MAX));
    this.peers.clear();
    this.spec.onGone();
  }
}

/** A server process started now (#780): its console run begins with the header and the command. */
export const createLspProcess = (spec: ProcessSpec): LspProcess => new ServerProcess(spec);
