// The bytes inside a request, an event or an answer (#936): out as { $bin: i } plus that many binary frames, back as the Uint8Array. No
// base64, so a 1 MiB readFile crosses as 1 MiB. Stream channels (the other way bytes cross) live here too. Apart from protocol.ts for its
// length; free of node: as it is.
type Plain = Record<string, unknown>;

// only what JSON.parse builds and callers write by hand: a Date or a class instance keeps its own toJSON
const isPlain = (value: unknown): value is Plain => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// reserved, not escaped (the spec's `$bin` row): no machine method's argument or answer has this shape
const isAttachment = (value: Plain): value is { $bin: number } => {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === '$bin' && typeof value.$bin === 'number';
};

export function pack(value: unknown): { value: unknown; bins: Uint8Array[] } {
  const bins: Uint8Array[] = [];
  const walk = (v: unknown): unknown => {
    if (v instanceof Uint8Array) {
      bins.push(v);
      return { $bin: bins.length - 1 };
    }
    if (Array.isArray(v)) return v.map(walk);
    if (!isPlain(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, walk(x)]));
  };
  return { value: walk(value), bins };
}

export function unpack(value: unknown, bins: readonly Uint8Array[]): { value: unknown } | { error: string } {
  let missing: number | undefined;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isPlain(v)) return v;
    if (!isAttachment(v)) return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, walk(x)]));
    const bytes = bins[v.$bin];
    if (bytes === undefined) missing = v.$bin;
    return bytes;
  };
  const out = walk(value);
  return missing === undefined ? { value: out } : { error: `attachment ${missing} is not among the frame's ${bins.length}` };
}

export type StreamHandle = { readonly ch: number; write(bytes: Uint8Array): void; end(): void; onData(cb: (bytes: Uint8Array) => void): void; onEnd(cb: () => void): void };
export type StreamState = { handle: StreamHandle; deliver(bytes: Uint8Array): void; finish(): void };

// one stream channel; onEnd fires once, however the stream ended: its own end(), the peer's, or the mux closing. The caller builds the
// error a write after the end throws, so this file needs no RemoteError (and no import cycle with protocol.ts)
export function createStream(ch: number, write: (bytes: Uint8Array) => void, end: () => void, endedError: () => Error): StreamState {
  const dataCbs: ((bytes: Uint8Array) => void)[] = [];
  const endCbs: (() => void)[] = [];
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    for (const cb of endCbs) cb();
  };
  const handle: StreamHandle = {
    ch,
    write: (bytes) => {
      if (ended) throw endedError();
      write(bytes);
    },
    end: () => {
      if (ended) return;
      end();
      finish();
    },
    onData: (cb) => void dataCbs.push(cb),
    onEnd: (cb) => void endCbs.push(cb),
  };
  return {
    handle,
    deliver: (bytes) => {
      for (const cb of dataCbs) cb(bytes);
    },
    finish,
  };
}
