// The machine's end of the hooks and MCP relay (#940): a loopback listener a hook's curl or an MCP client talks to, forwarded over the mux
// to the Hive. No timeout and no buffering here: every hook's `curl -m` bounds a request, and a lost link loses the hook.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isRecord } from './frames.js';
import { CHANNEL, type Mux } from './protocol.js';
import { relayableHeaders } from './relay-headers.js';

export const RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024;
const HOOKS_PREFIX = '/hooks/';

const sendJson = (res: ServerResponse, status: number, error: string, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify({ error }));
};

// null when the body is over the cap; the rest of an oversized body is drained unread, so the client can still read the 413
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

function forward(mux: Mux, req: IncomingMessage, res: ServerResponse, body: Uint8Array): void {
  const controller = new AbortController();
  // a client gone before the end cancels the request on the Hive's side too
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  let headSent = false;
  const onEvent = (data: unknown): void => {
    if (!isRecord(data) || res.destroyed) return;
    if (isRecord(data.head) && !headSent) {
      headSent = true;
      res.writeHead(Number(data.head.status), relayableHeaders(isRecord(data.head.headers) ? (data.head.headers as Record<string, string | string[]>) : {}));
      res.flushHeaders(); // an event stream must start before its first chunk
    } else if (data.chunk instanceof Uint8Array && headSent) {
      res.write(data.chunk);
    }
  };
  const params = { method: req.method ?? 'GET', path: req.url ?? '/', headers: relayableHeaders(req.headers, ['cookie']), body };
  mux.request(CHANNEL.relay, 'http', params, { signal: controller.signal, onEvent }).then(
    () => res.end(),
    (err: unknown) => {
      if (controller.signal.aborted && res.destroyed) return;
      if (headSent) res.destroy();
      else sendJson(res, 502, err instanceof Error ? err.message : String(err));
    },
  );
}

export function listenRelay(mux: Mux, { port }: { port: number }): Promise<{ port: number; close(): Promise<void> }> {
  let bound = port;
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${bound}` && req.headers.host !== `localhost:${bound}`) return sendJson(res, 403, 'forbidden host');
    if (!(req.url ?? '').startsWith(HOOKS_PREFIX)) return sendJson(res, 404, 'not found');
    readBody(req).then(
      (body) => (body === null ? sendJson(res, 413, 'body too large', { connection: 'close' }) : forward(mux, req, res, body)),
      () => res.destroy(),
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(bound, '127.0.0.1', () => {
      bound = (server.address() as AddressInfo).port;
      resolve({ port: bound, close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }) });
    });
  });
}
