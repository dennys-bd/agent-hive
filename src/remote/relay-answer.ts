// The Hive's end of the hooks and MCP relay (#940): repeats what the machine's listener forwarded against the Hive's own server on
// loopback, and streams the answer back as events. node:http, not fetch, because fetch cannot set Host.
import { request as httpRequest } from 'node:http';
import { isRecord, isString } from './frames.js';
import { CHANNEL, RemoteError, type Mux, type RequestContext } from './protocol.js';
import { isRelayHeaders, isRelayPath, relayableHeaders, type RelayHeaders } from './relay-headers.js';

type RelayCall = { method: string; path: string; headers: RelayHeaders; body: Uint8Array };

function parseCall(params: unknown): RelayCall {
  if (!isRecord(params) || !isString(params.method) || !isString(params.path) || !isRelayPath(params.path) || !isRelayHeaders(params.headers) || !(params.body instanceof Uint8Array)) {
    throw new RemoteError('bad_request', 'the relayed request is malformed');
  }
  return { method: params.method, path: params.path, headers: params.headers, body: params.body };
}

function repeat(call: RelayCall, port: number, ctx: RequestContext): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // the Host the Hive's own guard expects, whatever the caller wrote
    const headers = { ...relayableHeaders(call.headers, ['host', 'content-length', 'cookie']), host: `127.0.0.1:${port}`, 'content-length': String(call.body.length) };
    const out = httpRequest({ host: '127.0.0.1', port, method: call.method, path: call.path, headers }, (res) => {
      ctx.emit({ head: { status: res.statusCode ?? 502, headers: relayableHeaders(res.headers) } });
      // ponytail: the mux has no flow control, so a stalled client buffers the stream here; upgrade is pause/resume once the mux reports backpressure. No cap on concurrent relayed requests either: add one with the same upgrade.
      res.on('data', (chunk: Uint8Array) => ctx.emit({ chunk }));
      res.on('end', () => { ctx.signal.removeEventListener('abort', onAbort); resolve({}); });
      res.on('error', (err) => reject(new RemoteError('relay_failed', err.message)));
    });
    out.on('error', (err) => reject(new RemoteError('relay_failed', err.message)));
    const onAbort = (): void => { out.destroy(); };
    if (ctx.signal.aborted) out.destroy();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    out.end(call.body);
  });
}

export function answerRelay(mux: Mux, { port }: { port: number }): void {
  mux.onRequest(CHANNEL.relay, (method, params, ctx) => {
    if (method !== 'http') throw new RemoteError('unknown_method', 'the relay answers http only');
    return repeat(parseCall(params), port, ctx);
  });
}
