// The machine's end of the hooks and MCP relay (#940): a loopback listener a hook's curl or an MCP client talks to, forwarded over the mux
// to the Hive. No timeout and no buffering here: every hook's `curl -m` bounds a request, and a lost link loses the hook.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isRecord } from '../remote/frames.js';
import { CHANNEL, type Mux } from '../remote/protocol.js';
import { isRelayHeaders, isRelayPath, relayableHeaders } from './relay-headers.js';

export const RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MIN_STATUS = 100;
const MAX_STATUS = 999;

const sendJson = (res: ServerResponse, status: number, error: string, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify({ error }));
};

// the rest of a refused body is drained unread, so the client can still read the 413
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 413, 'body too large', { connection: 'close' });
  req.resume();
}

// null when the body is over the cap
function readBody(req: IncomingMessage): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size > RELAY_MAX_BODY_BYTES) return;
      size += chunk.length;
      if (size > RELAY_MAX_BODY_BYTES) { chunks.length = 0; resolve(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// the head an answerer sent, or null when it is no head a response can start with
function parseHead(data: unknown): { status: number; headers: Record<string, string | string[]> } | null {
  if (!isRecord(data) || !Number.isInteger(data.status) || !isRelayHeaders(data.headers)) return null;
  const status = data.status as number;
  return status >= MIN_STATUS && status <= MAX_STATUS ? { status, headers: relayableHeaders(data.headers) } : null;
}

function forward(mux: Mux, req: IncomingMessage, res: ServerResponse, body: Uint8Array): void {
  const controller = new AbortController();
  // a client gone before the end cancels the request on the Hive's side too
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const unreachable = (): void => {
    controller.abort();
    if (!res.headersSent) sendJson(res, 502, 'the Hive could not be reached');
    else res.destroy();
  };
  let headSent = false;
  const onEvent = (data: unknown): void => {
    if (!isRecord(data) || res.destroyed || res.writableEnded) return;
    if (data.head !== undefined && !headSent) {
      const head = parseHead(data.head);
      if (head === null) { unreachable(); return; }
      try {
        res.writeHead(head.status, head.headers);
        res.flushHeaders(); // an event stream must start before its first chunk
        headSent = true;
      } catch {
        unreachable();
      }
    } else if (data.chunk instanceof Uint8Array && headSent) {
      // ponytail: the mux has no flow control, so a stalled client buffers the stream here; upgrade is pause/resume once the mux reports backpressure. No cap on concurrent relayed requests either: add one with the same upgrade.
      res.write(data.chunk);
    }
  };
  const params = { method: req.method ?? 'GET', path: req.url ?? '/', headers: relayableHeaders(req.headers, ['cookie']), body };
  mux.request(CHANNEL.relay, 'http', params, { signal: controller.signal, onEvent }).then(
    () => { if (headSent) res.end(); else if (!res.writableEnded) unreachable(); },
    () => { if (!res.writableEnded && !res.destroyed) unreachable(); },
  );
}

export function listenRelay(mux: Mux, { port }: { port: number }): Promise<{ port: number; close(): Promise<void> }> {
  let bound = port;
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) return sendJson(res, 403, 'forbidden host');
    if (!isRelayPath(req.url ?? '')) return sendJson(res, 404, 'not found');
    // a worker always sends it: refusing before the body keeps an unauthenticated flood from ever reaching the Hive
    if (req.headers['x-hive-secret'] === undefined) return sendJson(res, 403, 'missing secret');
    if (Number(req.headers['content-length']) > RELAY_MAX_BODY_BYTES) return tooLarge(req, res);
    readBody(req).then(
      (body) => (body === null ? tooLarge(req, res) : forward(mux, req, res, body)),
      () => res.destroy(),
    );
  });
  return new Promise((resolve, reject) => {
    // kept after listen: an error later must reach nothing, not the process
    server.on('error', reject);
    server.listen(bound, '127.0.0.1', () => {
      bound = (server.address() as AddressInfo).port;
      resolve({ port: bound, close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }) });
    });
  });
}
