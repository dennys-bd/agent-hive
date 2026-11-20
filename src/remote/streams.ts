// The stream channels of the mux (#936): raw bytes both ways on a channel of their own. Free of node: like the rest of src/remote/.
export interface MuxStream { readonly ch: number; write(bytes: Uint8Array): void; end(): void; onData(cb: (bytes: Uint8Array) => void): void; onEnd(cb: () => void): void }
export type StreamState = { handle: MuxStream; deliver(bytes: Uint8Array): void; finish(): void };
// runs one user callback; the mux's guard reports its throw instead of letting it stop the loop it is in
export type Guard = (run: () => void) => void;

// one stream channel; onEnd fires once, however the stream ended: its own end(), the peer's, or the mux closing. The caller builds the
// error a write after the end throws, so this file needs no RemoteError
export function createStream(ch: number, write: (bytes: Uint8Array) => void, end: () => void, endedError: () => Error, guard: Guard): StreamState {
  const dataCbs: ((bytes: Uint8Array) => void)[] = [];
  const endCbs: (() => void)[] = [];
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    for (const cb of endCbs) guard(cb);
  };
  const handle: MuxStream = {
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
      for (const cb of dataCbs) guard(() => cb(bytes));
    },
    finish,
  };
}
