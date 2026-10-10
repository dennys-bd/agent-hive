import { type IncomingMessage, type Server, STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import type { LspHost } from './lsp-host.js';
import type { PtyHost } from './pty-host.js';
import { matchesSecret, presentedSecret } from './secret.js';
import { parsePtyMessage } from './terminal-wire.js';

// The terminal over one WebSocket per viewer (#407): the pty's output goes out as text frames, keys and sizes come in as
// JSON. It replaces an SSE stream and two POSTs per terminal. Those held Chromium's 6 HTTP/1.1 connections per host and left every other
// fetch of the page waiting, while a WebSocket sits outside that pool. Same URL the stream had, on the daemon's own port. The language servers' sockets (#780) ride the same port and checks.

const PTY_PATH = /^\/ptys\/([^/]+)\/pty$/;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409; // setup mode, as every run route answers
const NORMAL_CLOSURE = 1000; // the pty exited; the page reads any close as the run's end

export interface PtySocketDeps {
  ptys: PtyHost;
  port(): number | undefined; // read per upgrade: undefined until listen() binds, and nothing is admitted then
  isConfigured(): boolean;
  secret: string; // this boot's secret (#467): the main window's cookie carries it on the upgrade
  lsp: Pick<LspHost, 'attach'>; // the language servers' sockets (#780)
}

export interface PtySocket {
  close(): void; // terminates every open terminal: closeAllConnections() does not reach an upgraded socket
}

/** The daemon's two addresses as `host:port` (#407): the HTTP middleware's Host check, and the pty socket's Host and Origin checks. */
export const allowedHosts = (port: number | undefined): string[] => (port === undefined ? [] : [`127.0.0.1:${port}`, `localhost:${port}`]);

const LSP_PATH = /^\/activities\/([^/]+)\/lsp\/([^/]+)$/;
type Route = { kind: 'pty'; ptyId: string } | { kind: 'lsp'; activityId: string; server: string; binary: string };

const decoded = (segment: string): string | undefined => {
  try { return decodeURIComponent(segment); } catch { return undefined; }
};

// The route of an upgrade's path (#570: /ptys/:id/pty; #780: /activities/:id/lsp/:server?bin=); undefined for any other path or a bad escape
function routeOf(url: string | undefined): Route | undefined {
  const [path, query = ''] = (url ?? '').split('?');
  const pty = PTY_PATH.exec(path);
  const ptyId = pty ? decoded(pty[1]) : undefined;
  if (ptyId !== undefined) return { kind: 'pty', ptyId };
  const lsp = LSP_PATH.exec(path);
  const [activityId, server] = lsp ? [decoded(lsp[1]), decoded(lsp[2])] : [];
  const binary = new URLSearchParams(query).get('bin');
  return activityId && server && binary ? { kind: 'lsp', activityId, server, binary } : undefined;
}

// The worker an upgrade may attach to, or the status that refuses it. Host stops DNS rebinding, as the HTTP middleware does. Origin stops
// a page on another site: a browser applies no CORS to a WebSocket and a page cannot send x-hive-ui on one, so without it any site open in
// the user's browser could type into a worker's terminal. A missing or `null` Origin (a file:// page, a sandboxed frame) is refused. The
// secret stops a process that is not a page (#467): the main window's cookie carries it. All three run before the path, so a refused client
// learns nothing about which workers exist.
function admit(req: IncomingMessage, { ptys, port, isConfigured, secret }: PtySocketDeps): Route | { status: number } {
  const at = port();
  if (at === undefined) return { status: HTTP_FORBIDDEN }; // nothing is admitted before listen() binds
  const hosts = allowedHosts(at);
  if (!hosts.includes(req.headers.host ?? '')) return { status: HTTP_FORBIDDEN };
  if (!hosts.some((host) => req.headers.origin === `http://${host}`)) return { status: HTTP_FORBIDDEN };
  if (!matchesSecret(secret, presentedSecret(req, at))) return { status: HTTP_FORBIDDEN };
  const route = routeOf(req.url);
  if (route === undefined) return { status: HTTP_NOT_FOUND };
  if (!isConfigured()) return { status: HTTP_CONFLICT };
  // an LSP socket's own checks (installed, in scope) answer after the handshake, as a close with a reason the page shows
  return route.kind === 'lsp' || ptys.has(route.ptyId) ? route : { status: HTTP_NOT_FOUND };
}

// A refusal is a bare status line before any handshake: the client never gets a WebSocket, and the socket goes once the line is written
function refuse(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

// One viewer of a pty: the scrollback, then every chunk, as text frames; the pty's exit closes with 1000, and the client's close unsubscribes.
// The first frame is always the replay (#831), empty when the ring is: the page reads from it where the replay ends and live output
// starts. An ended run with no tail sends no frame, only its close.
// Its keys and sizes come in as JSON on the same socket, so they keep the order typed. Anything else is dropped with the socket kept open:
// a bad frame never kills a terminal.
function connect(ws: WebSocket, ptyId: string, ptys: PtyHost): void {
  let isReplayed = false;
  const stop = ptys.subscribe(ptyId, (data) => { isReplayed = true; ws.send(data); }, () => ws.close(NORMAL_CLOSURE));
  if (!stop) return void ws.close(NORMAL_CLOSURE); // the pty exited between the upgrade's check and the handshake
  // subscribe hands a live ring over before it returns, and only a non-empty one. An ended run's (#672) has closed the socket by now: its
  // tail, if any, then the close, and no frame after it
  if (!isReplayed && ws.readyState === ws.OPEN) ws.send('');
  ws.on('message', (raw, isBinary) => {
    const message = isBinary ? undefined : parsePtyMessage(raw.toString());
    // node-pty throws (EBADF) on a pty whose fd closed before its exit landed; a throw in a ws listener is uncaught and would end the daemon
    // with every worker. The pty is going anyway: its exit closes this socket.
    try {
      if (message?.type === 'input') ptys.write(ptyId, message.data);
      else if (message?.type === 'resize') ptys.resize(ptyId, message.cols, message.rows); // the last resize of any viewer wins (#251)
    } catch {
      return;
    }
  });
  ws.on('close', stop);
  ws.on('error', () => undefined); // an 'error' with no listener throws in the daemon; ws closes the socket itself, and close unsubscribes
}

/** Serves the pty socket on `server`'s upgrades (#407); every other upgrade is refused. Returns what the daemon's close() calls. */
export function attachPtySocket(server: Server, deps: PtySocketDeps): PtySocket {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy()); // a client that resets mid-handshake must not throw in the daemon
    const admitted = admit(req, deps);
    if ('status' in admitted) return refuse(socket, admitted.status);
    wss.handleUpgrade(req, socket, head, (ws) => (admitted.kind === 'pty' ? connect(ws, admitted.ptyId, deps.ptys) : void deps.lsp.attach(ws, admitted.activityId, admitted.server, admitted.binary)));
  });
  return {
    close: () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
