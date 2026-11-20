import { createStream, pack, unpack, type StreamState } from './attachments.js';

export const REMOTE_PROTOCOL_VERSION = 1;
export const CHANNEL = { control: 0, machine: 1, relay: 2 } as const;
export const FIRST_STREAM_CHANNEL = 3;
export const REMOTE_ERROR_CODES = ['link_closed', 'version_mismatch', 'unknown_method', 'cancelled', 'bad_frame', 'internal', 'not_supported'] as const;
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];

export type HelloFrame = { ch: 0; t: 'hello'; version: number; info: unknown };
export type ByeFrame = { ch: 0; t: 'bye'; code?: string; message?: string };
export type StreamFrame = { ch: 0; t: 'open' | 'end'; stream: number };
export type RequestFrame = { ch: number; t: 'req'; id: number; method: string; params: unknown; bin?: number };
export type EventFrame = { ch: number; t: 'event'; id: number; data: unknown; bin?: number };
export type CancelFrame = { ch: number; t: 'cancel'; id: number };
export type ResponseFrame =
  | { ch: number; t: 'res'; id: number; ok: true; result: unknown; bin?: number }
  | { ch: number; t: 'res'; id: number; ok: false; code: string; message: string; data?: unknown; bin?: number };
export type TextFrame = HelloFrame | ByeFrame | StreamFrame | RequestFrame | EventFrame | CancelFrame | ResponseFrame;
export type BinaryFrame = { ch: number; bytes: Uint8Array };

// The mux of #138 section 5, on no transport (#936): frames out through `send`, frames in through `receive`. Pure and free of node: so the
// distro's helper (4.3) and #162's browser link share it; bytes are Uint8Array, never Buffer.
const CHANNEL_BYTES = 4;
type Fields = Record<string, unknown>;
const isRecord = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isString = (v: unknown): v is string => typeof v === 'string';
const isOpt = (v: unknown, check: (x: unknown) => boolean): boolean => v === undefined || check(v);
const isStream = (v: unknown): boolean => isUint(v) && v >= FIRST_STREAM_CHANNEL;

// what each `t` must carry; which channel a call may use is the mux's check
const SHAPES: Record<TextFrame['t'], (f: Fields) => boolean> = {
  hello: (f) => f.ch === CHANNEL.control && typeof f.version === 'number',
  bye: (f) => f.ch === CHANNEL.control && isOpt(f.code, isString) && isOpt(f.message, isString),
  open: (f) => f.ch === CHANNEL.control && isStream(f.stream),
  end: (f) => f.ch === CHANNEL.control && isStream(f.stream),
  req: (f) => isUint(f.id) && isString(f.method) && isOpt(f.bin, isUint),
  event: (f) => isUint(f.id) && isOpt(f.bin, isUint),
  cancel: (f) => isUint(f.id),
  res: (f) => isUint(f.id) && isOpt(f.bin, isUint) && (f.ok === true || (f.ok === false && isString(f.code) && isString(f.message))),
};

export function encode(frame: TextFrame | BinaryFrame): string | Uint8Array {
  if (!('bytes' in frame)) return JSON.stringify(frame);
  const out = new Uint8Array(CHANNEL_BYTES + frame.bytes.length);
  new DataView(out.buffer).setUint32(0, frame.ch);
  out.set(frame.bytes, CHANNEL_BYTES);
  return out;
}

export function decode(data: string | Uint8Array): TextFrame | BinaryFrame | { error: string } {
  if (typeof data !== 'string') {
    if (data.length < CHANNEL_BYTES) return { error: `a binary frame of ${data.length} bytes has no channel` };
    return { ch: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0), bytes: data.subarray(CHANNEL_BYTES) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { error: 'a text frame that is not JSON' };
  }
  // Object.hasOwn: a `t` of "toString" names no shape
  if (!isRecord(parsed) || !isUint(parsed.ch) || !isString(parsed.t) || !Object.hasOwn(SHAPES, parsed.t)) return { error: 'a text frame of no known type' };
  if (!SHAPES[parsed.t as TextFrame['t']](parsed)) return { error: `a malformed ${parsed.t} frame` };
  return parsed as TextFrame;
}

export class RemoteError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.data = data;
  }
}

export interface RequestContext { signal: AbortSignal; emit(data: unknown): void }
export type RequestHandler = (method: string, params: unknown, ctx: RequestContext) => unknown | Promise<unknown>;
export interface MuxStream { readonly ch: number; write(bytes: Uint8Array): void; end(): void; onData(cb: (bytes: Uint8Array) => void): void; onEnd(cb: () => void): void }
export interface Mux {
  request(ch: number, method: string, params: unknown, opts?: { signal?: AbortSignal; onEvent?: (data: unknown) => void }): Promise<unknown>;
  onRequest(ch: number, handler: RequestHandler): void;
  hello(info: unknown): void;
  onHello(cb: (info: unknown) => void): void;
  openStream(): MuxStream;
  onStream(cb: (stream: MuxStream) => void): void;
  receive(data: string | Uint8Array): void; // never throws
  close(code?: string): void;
  onClose(cb: (code: string | undefined) => void): void;
  onError(cb: (err: RemoteError) => void): void;
}

type PackedFrame = RequestFrame | EventFrame | ResponseFrame;
type CallFrame = PackedFrame | CancelFrame;
type Outcome = { ok: true; result: unknown } | { ok: false; code: string; message: string; data?: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (err: RemoteError) => void; onEvent?: (data: unknown) => void; detach: () => void };
type RequestOpts = { signal?: AbortSignal; onEvent?: (data: unknown) => void };

const linkClosed = (): RemoteError => new RemoteError('link_closed', 'the link is closed');
const cancelled = (signal?: AbortSignal): RemoteError =>
  new RemoteError('cancelled', signal?.reason instanceof Error ? signal.reason.message : 'the request was cancelled');
// a type guard, since `t` alone does not narrow StreamFrame's two-literal `t` out of the union
const isControl = (frame: TextFrame): frame is HelloFrame | ByeFrame | StreamFrame =>
  frame.t === 'hello' || frame.t === 'bye' || frame.t === 'open' || frame.t === 'end';
const isRequestChannel = (ch: number): boolean => ch === CHANNEL.machine || ch === CHANNEL.relay;
const payloadOf = (frame: PackedFrame): unknown =>
  frame.t === 'req' ? frame.params : frame.t === 'event' ? frame.data : frame.ok ? frame.result : frame.data;

// a node error's own code (ENOENT) crosses as it is; a RemoteError's data lets 3.3 rebuild a MachineError's stderr, stdout and killed
function failure(err: unknown): Outcome {
  const code = isRecord(err) && isString(err.code) ? err.code : 'internal';
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, code, message, data: err instanceof RemoteError ? err.data : undefined };
}

class MuxCore {
  readonly closeCbs: ((code: string | undefined) => void)[] = [];
  readonly errorCbs: ((err: RemoteError) => void)[] = [];
  readonly helloCbs: ((info: unknown) => void)[] = [];
  readonly streamCbs: ((stream: MuxStream) => void)[] = [];
  private readonly send: (data: string | Uint8Array) => void;
  private readonly firstId: number;
  private nextId: number;
  private nextStream: number;
  private closed = false;
  private readonly streams = new Map<number, StreamState>();
  private readonly pending = new Map<number, Pending>();
  private readonly running = new Map<number, AbortController>();
  private readonly handlers = new Map<number, RequestHandler>();
  private readonly awaiting = new Map<number, { frame: PackedFrame; bins: readonly Uint8Array[] }>();

  constructor(send: (data: string | Uint8Array) => void, side: 'host' | 'machine') {
    this.send = send;
    this.firstId = this.nextId = side === 'host' ? 1 : 2;
    this.nextStream = FIRST_STREAM_CHANNEL + this.firstId - 1; // host 3, machine 4
  }

  request(ch: number, method: string, params: unknown, opts: RequestOpts = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(linkClosed());
    if (!isRequestChannel(ch)) return Promise.reject(new RangeError(`channel ${ch} takes no request`));
    const { signal, onEvent } = opts;
    if (signal?.aborted) return Promise.reject(cancelled(signal));
    const id = this.nextId;
    this.nextId += 2;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        this.sendText({ ch, t: 'cancel', id });
        reject(cancelled(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, onEvent, detach: () => signal?.removeEventListener('abort', onAbort) });
      this.sendPacked(params, (value, extra) => ({ ch, t: 'req', id, method, params: value, ...extra }));
    });
  }

  onRequest(ch: number, handler: RequestHandler): void {
    if (!isRequestChannel(ch)) throw new RangeError(`channel ${ch} takes no request handler`);
    this.handlers.set(ch, handler);
  }

  receive(data: string | Uint8Array): void {
    if (this.closed) return;
    try {
      const frame = decode(data);
      if ('error' in frame) this.fail(frame.error);
      else if ('bytes' in frame) this.onBinary(frame);
      else this.onText(frame);
    } catch (err) {
      // a listener's own throw must not escape into the transport's read loop
      this.report(err);
    }
  }

  close(code?: string): void {
    this.shutdown(code, true);
  }

  hello(info: unknown): void {
    this.sendText({ ch: CHANNEL.control, t: 'hello', version: REMOTE_PROTOCOL_VERSION, info });
  }

  openStream(): MuxStream {
    if (this.closed) throw linkClosed();
    const ch = this.nextStream;
    this.nextStream += 2;
    const stream = this.addStream(ch);
    this.sendText({ ch: CHANNEL.control, t: 'open', stream: ch });
    return stream;
  }

  private addStream(ch: number): MuxStream {
    const sendBytes = (bytes: Uint8Array): void => {
      if (!this.closed) this.send(encode({ ch, bytes }));
    };
    const sendEnd = (): void => {
      this.streams.delete(ch);
      this.sendText({ ch: CHANNEL.control, t: 'end', stream: ch });
    };
    const state = createStream(ch, sendBytes, sendEnd, () => new RemoteError('link_closed', `stream ${ch} has ended`));
    this.streams.set(ch, state);
    return state.handle;
  }

  private onHelloFrame({ version, info }: HelloFrame): void {
    // the mux checks, not each caller, so neither the helper (4.3) nor 5.3 can forget it
    if (version !== REMOTE_PROTOCOL_VERSION) this.shutdown('version_mismatch', true, `the peer speaks protocol version ${version}, this side ${REMOTE_PROTOCOL_VERSION}`);
    else for (const cb of this.helloCbs) cb(info);
  }

  private onOpen(ch: number): void {
    // the peer opens on its own parity, so it never takes a channel this side's openStream will
    if (ch % 2 === this.nextStream % 2 || this.streams.has(ch)) {
      this.fail(`the peer cannot open stream ${ch}`);
      return;
    }
    const stream = this.addStream(ch);
    for (const cb of this.streamCbs) cb(stream);
  }

  private onEnd(ch: number): void {
    const stream = this.streams.get(ch);
    if (stream === undefined) {
      this.fail(`the end of stream ${ch}, which is not open`);
      return;
    }
    this.streams.delete(ch);
    stream.finish();
  }

  private sendText(frame: TextFrame): void {
    if (!this.closed) this.send(encode(frame));
  }

  private sendPacked(payload: unknown, build: (value: unknown, extra: { bin?: number }) => PackedFrame): void {
    if (this.closed) return;
    const { value, bins } = pack(payload);
    const frame = build(value, bins.length > 0 ? { bin: bins.length } : {});
    // one synchronous run: on an ordered transport nothing comes between a frame and its attachments
    this.send(encode(frame));
    for (const bytes of bins) this.send(encode({ ch: frame.ch, bytes }));
  }

  private onBinary({ ch, bytes }: BinaryFrame) {
    if (ch >= FIRST_STREAM_CHANNEL) {
      const stream = this.streams.get(ch);
      if (stream === undefined) this.fail(`a binary frame on stream ${ch}, which is not open`);
      else stream.deliver(bytes);
      return;
    }
    const waiting = this.awaiting.get(ch);
    if (!isRequestChannel(ch) || waiting === undefined) return this.fail(`a binary frame on channel ${ch} with no frame waiting for it`);
    const bins = [...waiting.bins, bytes];
    if (bins.length < (waiting.frame.bin ?? 0)) {
      this.awaiting.set(ch, { frame: waiting.frame, bins });
      return;
    }
    this.awaiting.delete(ch);
    this.dispatch(waiting.frame, bins);
  }

  private onText(frame: TextFrame) {
    if (frame.ch >= FIRST_STREAM_CHANNEL) return this.fail(`a text frame on stream channel ${frame.ch}`);
    if (this.awaiting.delete(frame.ch)) this.fail(`a frame on channel ${frame.ch} before the attachments of the one before it`);
    if (isControl(frame)) return this.onControl(frame);
    if (!isRequestChannel(frame.ch)) return this.fail(`a ${frame.t} frame on channel ${frame.ch}`);
    if (frame.t !== 'cancel' && (frame.bin ?? 0) > 0) {
      this.awaiting.set(frame.ch, { frame, bins: [] });
      return;
    }
    this.dispatch(frame, []);
  }

  private onControl(frame: HelloFrame | ByeFrame | StreamFrame): void {
    if (frame.t === 'bye') this.shutdown(frame.code, false);
    else if (frame.t === 'hello') this.onHelloFrame(frame);
    else if (frame.t === 'open') this.onOpen(frame.stream);
    else this.onEnd(frame.stream);
  }

  private dispatch(frame: CallFrame, bins: readonly Uint8Array[]) {
    if (frame.t === 'cancel') return this.cancelRunning(frame.id);
    const payload = unpack(payloadOf(frame), bins);
    if ('error' in payload) return this.fail(payload.error);
    if (frame.t === 'req') this.serve(frame, payload.value);
    else if (frame.t === 'event') this.callOf(frame.id)?.onEvent?.(payload.value);
    else this.settle(frame, payload.value);
  }

  // an id this side sent but no longer waits for (cancelled) is a late answer, dropped quietly; one it never sent is a protocol error
  private callOf(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    const sent = id % 2 === this.firstId % 2 && id >= this.firstId && id < this.nextId;
    if (entry === undefined && !sent) this.fail(`an answer to request ${id}, which this side never sent`);
    return entry;
  }

  private settle(frame: ResponseFrame, value: unknown): void {
    const entry = this.callOf(frame.id);
    if (entry === undefined) return;
    this.pending.delete(frame.id);
    entry.detach();
    if (frame.ok) entry.resolve(value);
    else entry.reject(new RemoteError(frame.code, frame.message, value));
  }

  private serve({ ch, id, method }: RequestFrame, params: unknown) {
    const handler = this.handlers.get(ch);
    if (handler === undefined) return this.answer(ch, id, { ok: false, code: 'unknown_method', message: `no handler on channel ${ch} for ${method}` });
    const controller = new AbortController();
    this.running.set(id, controller);
    // cancelled or closed: whatever the handler still emits or answers is dropped
    const live = (): boolean => this.running.get(id) === controller;
    const ctx: RequestContext = {
      signal: controller.signal,
      emit: (data) => {
        if (live()) this.sendPacked(data, (value, extra) => ({ ch, t: 'event', id, data: value, ...extra }));
      },
    };
    // through then(), so a handler that throws at once is answered as one that rejects
    Promise.resolve()
      .then(() => handler(method, params, ctx))
      .then((result): Outcome => ({ ok: true, result }), failure)
      .then((outcome) => {
        if (!live()) return;
        this.running.delete(id);
        this.answer(ch, id, outcome);
      })
      .catch((err: unknown) => this.report(err));
  }

  private answer(ch: number, id: number, outcome: Outcome): void {
    if (outcome.ok) this.sendPacked(outcome.result, (value, extra) => ({ ch, t: 'res', id, ok: true, result: value, ...extra }));
    else this.sendPacked(outcome.data, (value, extra) => ({ ch, t: 'res', id, ok: false, code: outcome.code, message: outcome.message, data: value, ...extra }));
  }

  private cancelRunning(id: number): void {
    const controller = this.running.get(id);
    if (controller === undefined) return; // already answered: the cancel crossed the answer
    this.running.delete(id);
    controller.abort(new RemoteError('cancelled', 'the caller cancelled the request'));
  }

  private shutdown(code: string | undefined, sayBye: boolean, message?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (sayBye) this.send(encode({ ch: CHANNEL.control, t: 'bye', ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) }));
    } finally {
      this.teardown(code);
    }
  }

  private teardown(code: string | undefined): void {
    const closedError = linkClosed();
    for (const entry of this.pending.values()) {
      entry.detach();
      entry.reject(closedError);
    }
    for (const controller of this.running.values()) controller.abort(closedError);
    this.pending.clear();
    this.running.clear();
    this.awaiting.clear();
    for (const stream of this.streams.values()) stream.finish();
    this.streams.clear();
    for (const cb of this.closeCbs) cb(code);
  }

  private report(err: unknown): void {
    const error = err instanceof RemoteError ? err : new RemoteError('internal', err instanceof Error ? err.message : String(err));
    for (const cb of this.errorCbs) cb(error);
  }

  private fail(message: string): void {
    this.report(new RemoteError('bad_frame', message));
  }
}

export function createMux(send: (data: string | Uint8Array) => void, opts: { side: 'host' | 'machine' }): Mux {
  const core = new MuxCore(send, opts.side);
  // bound arrows, so a method handed on alone (createStdioDecoder(mux.receive, …)) keeps its mux
  return {
    hello: (info) => core.hello(info),
    onHello: (cb) => void core.helloCbs.push(cb),
    openStream: () => core.openStream(),
    onStream: (cb) => void core.streamCbs.push(cb),
    request: (ch, method, params, requestOpts) => core.request(ch, method, params, requestOpts),
    onRequest: (ch, handler) => core.onRequest(ch, handler),
    receive: (data) => core.receive(data),
    close: (code) => core.close(code),
    onClose: (cb) => void core.closeCbs.push(cb),
    onError: (cb) => void core.errorCbs.push(cb),
  };
}
