import { createMux, decode, RemoteError, type Mux, type TextFrame } from '../src/remote/protocol.js';

export type Side = 'host' | 'machine';
export type Sent = { from: Side; data: string | Uint8Array };

// two muxes whose send calls the other's receive on a microtask; `receive` is called unbound, as createStdioDecoder(mux.receive, …) will
export function pair(): { host: Mux; machine: Mux; sent: Sent[] } {
  const sent: Sent[] = [];
  const muxes: Partial<Record<Side, Mux>> = {};
  const wire = (from: Side, to: Side) => (data: string | Uint8Array): void => {
    sent.push({ from, data });
    queueMicrotask(() => {
      const { receive } = muxes[to]!;
      receive(data);
    });
  };
  muxes.host = createMux(wire('host', 'machine'), { side: 'host' });
  muxes.machine = createMux(wire('machine', 'host'), { side: 'machine' });
  return { host: muxes.host, machine: muxes.machine, sent };
}

// every microtask hop of the pair has run once setImmediate fires
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
export const textFrames = (sent: Sent[], from: Side): TextFrame[] =>
  sent.flatMap((s) => {
    if (s.from !== from) return [];
    const frame = decode(s.data);
    return 'error' in frame || 'bytes' in frame ? [] : [frame];
  });
export const remote = (code: string) => (err: unknown): boolean => err instanceof RemoteError && err.code === code;
