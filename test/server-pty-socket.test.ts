import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createPtyHost, type PtyHost } from '../src/pty-host.js';
import { newSecret, SECRET_HEADER, secretCookie } from '../src/secret.js';
import { attachPtySocket } from '../src/server-pty-socket.js';
import { fakePtys } from './fakes.js';
import { SECRET } from './secret-client.js';

const WORKER = '0b6f3c1e-5d2a-4c8b-9e7f-1a2b3c4d5e6f';
const PTY_PATH = `/ptys/${WORKER}/pty`;

interface FakeHost {
  host: PtyHost;
  subscribed: string[];
  written: string[];
  sizes: [number, number][];
  unsubscribed: number;
  emit(data: string): void;
  exit(): void;
}

// A PtyHost that knows WORKER only, whose scrollback is 'scrollback'. It records every subscribe, write, resize and unsubscribe; the test
// plays the pty's output and its exit.
function fakeHost(): FakeHost {
  let listeners: { onData(data: string): void; onExit(exitCode: number): void }[] = [];
  const fake: FakeHost = {
    subscribed: [], written: [], sizes: [], unsubscribed: 0,
    emit: (data) => { for (const l of listeners) l.onData(data); },
    exit: () => { for (const l of listeners) l.onExit(0); },
    host: {
      spawn: () => undefined,
      adopt: () => undefined,
      has: (ptyId) => ptyId === WORKER,
      write: (_ptyId, data) => { fake.written.push(data); return true; },
      resize: (_ptyId, cols, rows) => { fake.sizes.push([cols, rows]); return true; },
      subscribe: (ptyId, onData, onExit) => {
        if (ptyId !== WORKER) return undefined;
        fake.subscribed.push(ptyId);
        onData('scrollback');
        listeners = [...listeners, { onData, onExit }];
        return () => { fake.unsubscribed += 1; };
      },
      kill: () => false,
      pid: () => undefined,
      restore: () => undefined,
      forget: () => undefined,
    },
  };
  return fake;
}

// A bare http.Server on a free port with the pty socket attached. `configured: false` plays setup mode; `bound: false` a port() that
// listen() has not set yet.
async function serve(t: TestContext, { configured = true, bound = true, host }: { configured?: boolean; bound?: boolean; host?: PtyHost } = {}): Promise<{ port: number; fake: FakeHost; attached: string[] }> {
  const fake = fakeHost();
  const attached: string[] = [];
  const lsp = { attach: async (ws: { close(code: number, reason: string): void }, activityId: string, server: string, binary: string) => { attached.push(`${activityId} ${server} ${binary}`); ws.close(1000, 'bye'); } };
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const socket = attachPtySocket(server, { ptys: host ?? fake.host, port: () => (bound ? port : undefined), isConfigured: () => configured, secret: SECRET, lsp });
  t.after(async () => {
    socket.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port, fake, attached };
}

interface Dialed { status: number; ws: WebSocket; received: string[]; closed: Promise<number> }

// Dials a socket and settles on the handshake: 101 once it is open, or the refusal's status, in which case `open` never fired. `received`
// (text frames as text, a binary one as '<binary>') and `closed` are wired first, so a frame that arrives together with the 101 is kept.
function dial(port: number, path: string, headers: Record<string, string>): Promise<Dialed> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const received: string[] = [];
  ws.on('message', (data, isBinary) => received.push(isBinary ? '<binary>' : data.toString()));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ status: 101, ws, received, closed }));
    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      resolve({ status: res.statusCode ?? 0, ws, received, closed });
    });
    ws.on('error', reject); // a late error after the settle lands here and is ignored
  });
}

const fromBoard = (port: number): Record<string, string> => ({ origin: `http://127.0.0.1:${port}`, [SECRET_HEADER]: SECRET });

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

test('an upgrade from a foreign, missing or null Origin, another port\'s origin, a wrong Host, or before the port is bound is refused with 403: it never opens and the pty host is never subscribed; the same dial from the board\'s origin opens (#407)', async (t) => {
  const { port, fake } = await serve(t);
  const refused: Record<string, string>[] = [
    { origin: 'http://evil.example' },
    {}, // no Origin at all
    { origin: 'null' }, // a file:// page or a sandboxed frame
    { origin: `http://127.0.0.1:${port + 1}` },
    { ...fromBoard(port), host: `evil.example:${port}` }, // DNS rebinding: the right Origin cannot save a foreign Host
  ];
  for (const headers of refused) {
    assert.equal((await dial(port, PTY_PATH, headers)).status, 403, JSON.stringify(headers));
  }
  assert.deepEqual(fake.subscribed, []);
  const early = await serve(t, { bound: false });
  assert.equal((await dial(early.port, PTY_PATH, fromBoard(early.port))).status, 403, 'no port bound yet: nothing is admitted');
  assert.deepEqual(early.fake.subscribed, []);
  const board = await dial(port, PTY_PATH, fromBoard(port));
  assert.equal(board.status, 101, 'the positive control: the gate does not refuse everything');
  board.ws.close();
});

test('from the board\'s own origin, an unknown worker or another path is 404 and a daemon in setup mode 409: it never opens and the pty host is never subscribed (#407)', async (t) => {
  const { port, fake } = await serve(t);
  for (const path of ['/ptys/nope/pty', '/events', `/ptys/${WORKER}`, `${PTY_PATH}/input`, '/', `/ptys/%E0%A4%A/pty`]) {
    assert.equal((await dial(port, path, fromBoard(port))).status, 404, path);
  }
  const setup = await serve(t, { configured: false });
  assert.equal((await dial(setup.port, PTY_PATH, fromBoard(setup.port))).status, 409);
  assert.deepEqual([fake.subscribed, setup.fake.subscribed], [[], []]);
});

test('an admitted socket gets the scrollback, then the live output, as text frames, and a close with 1000 when the pty exits; a page on localhost is admitted too (#407)', async (t) => {
  const { port, fake } = await serve(t);
  const { received, closed } = await dial(port, PTY_PATH, fromBoard(port));
  await until(() => received.length === 1);
  fake.emit('live\r\n');
  await until(() => received.length === 2);
  fake.exit();
  assert.equal(await closed, 1000);
  assert.deepEqual(received, ['scrollback', 'live\r\n']);
  const local = await dial(port, PTY_PATH, { origin: `http://localhost:${port}`, host: `localhost:${port}`, [SECRET_HEADER]: SECRET });
  assert.equal(local.status, 101);
  local.ws.close();
});

test('a client that closes its socket unsubscribes from the pty host (#407)', async (t) => {
  const { port, fake } = await serve(t);
  const { ws } = await dial(port, PTY_PATH, fromBoard(port));
  await until(() => fake.subscribed.length === 1);
  ws.close();
  await until(() => fake.unsubscribed === 1);
});

test('input and resize messages reach the pty in the order sent; a binary frame or a message that is not JSON, of an unknown type or with a bad field is dropped and the socket stays open (#407)', async (t) => {
  const { port, fake } = await serve(t);
  const { ws } = await dial(port, PTY_PATH, fromBoard(port));
  ws.send('{"type":"input","data":"ls"}');
  for (const bad of ['not json', '{"type":"input","data":5}', '{"type":"resize","cols":0,"rows":40}', '{"type":"exec","data":"rm -rf ~"}']) ws.send(bad);
  ws.send(Buffer.from('{"type":"input","data":"binary"}'), { binary: true });
  ws.send('{"type":"resize","cols":120,"rows":40}');
  ws.send('{"type":"input","data":"\\r"}');
  await until(() => fake.written.length === 2);
  assert.deepEqual(fake.written, ['ls', '\r']);
  assert.deepEqual(fake.sizes, [[120, 40]], 'the last resize of any viewer wins (#251): the socket passes each one on');
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
});

test('a pty whose resize or write throws (its fd closing under a racing exit) never takes the daemon down: the socket stays open (#407)', async (t) => {
  const { port, fake } = await serve(t);
  fake.host.resize = () => { throw new Error('EBADF'); };
  fake.host.write = () => { throw new Error('EBADF'); };
  const { ws } = await dial(port, PTY_PATH, fromBoard(port));
  ws.send('{"type":"resize","cols":120,"rows":40}');
  ws.send('{"type":"input","data":"ls"}');
  await sleep(50);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
});

test('an upgrade with the right Host and Origin but no secret, another value or another port\'s cookie is refused with 403 before the path is read: an unknown worker is 403 too, not 404; the port\'s own cookie opens (#467)', async (t) => {
  const { port, fake } = await serve(t);
  const board = { origin: `http://127.0.0.1:${port}` };
  const refused: [string, Record<string, string>][] = [
    [PTY_PATH, board],
    ['/ptys/nope/pty', board], // 404 with the secret: without it, nothing about which workers exist
    [PTY_PATH, { ...board, [SECRET_HEADER]: newSecret() }],
    [PTY_PATH, { ...board, cookie: `${secretCookie(port + 1)}=${SECRET}` }],
  ];
  for (const [path, headers] of refused) {
    assert.equal((await dial(port, path, headers)).status, 403, `${path} ${JSON.stringify(Object.keys(headers))}`);
  }
  assert.deepEqual(fake.subscribed, []);
  const page = await dial(port, PTY_PATH, { ...board, cookie: `${secretCookie(port)}=${SECRET}` });
  assert.equal(page.status, 101, 'the viewer\'s page: the browser sends the cookie on the upgrade');
  page.ws.close();
});

test('an agent run that ended is admitted: the socket replays its kept transcript and closes with 1000 (#672)', async (t) => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn(WORKER, ['/bin/sh', '-c', 'claude'], '/wt', {}, {});
  ptys[0].emit('bye\r\n');
  ptys[0].exit();
  const { port } = await serve(t, { host });
  const { status, received, closed } = await dial(port, PTY_PATH, fromBoard(port));
  assert.equal(status, 101);
  assert.equal(await closed, 1000);
  assert.deepEqual(received, ['bye\r\n']);
});

test('the LSP path goes to the LSP host after the same Host, Origin and secret checks; one without bin is a 404 (#780)', async (t) => {
  const { port, attached } = await serve(t);
  const path = `/activities/${encodeURIComponent('local:hive')}/lsp/pyright?bin=pyright-langserver`;
  assert.equal((await dial(port, path, { origin: `http://127.0.0.1:${port}` })).status, 403);
  assert.equal((await dial(port, path, { origin: 'http://evil.example', [SECRET_HEADER]: SECRET })).status, 403);
  assert.equal((await dial(port, path, { ...fromBoard(port), host: 'evil.example' })).status, 403);
  assert.equal((await dial(port, '/activities/a/lsp/pyright', fromBoard(port))).status, 404);
  assert.equal((await dial(port, '/activities/a/lsp/pyright/extra?bin=x', fromBoard(port))).status, 404);
  assert.deepEqual(attached, []);
  const ok = await dial(port, path, fromBoard(port));
  assert.equal(ok.status, 101);
  await ok.closed;
  assert.deepEqual(attached, ['local:hive pyright pyright-langserver']);
});

const ZSH = ['/bin/sh', '-c', 'zsh'];

test('a live pty with an empty ring sends an empty text frame first, then its live output: the first frame is always the replay (#831)', async (t) => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn(WORKER, ZSH, '/wt', {});
  const { port } = await serve(t, { host });
  const { ws, received } = await dial(port, PTY_PATH, fromBoard(port));
  await until(() => received.length === 1);
  ptys[0].emit('$ ');
  await until(() => received.length === 2);
  assert.deepEqual(received, ['', '$ ']);
  ws.close();
});

test('a live pty with a ring sends the ring as its first frame and no empty one besides (#831)', async (t) => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn(WORKER, ZSH, '/wt', {});
  ptys[0].emit('old\r\n');
  const { port } = await serve(t, { host });
  const { ws, received } = await dial(port, PTY_PATH, fromBoard(port));
  await until(() => received.length === 1);
  ptys[0].emit('$ ');
  await until(() => received.length === 2);
  assert.deepEqual(received, ['old\r\n', '$ ']);
  ws.close();
});

test('an ended run with no tail gets no frame at all, only the close: nothing goes out after its socket closed (#831, #672)', async (t) => {
  const { spawnPty, ptys } = fakePtys();
  const host = createPtyHost(spawnPty);
  host.spawn(WORKER, ['/bin/sh', '-c', 'claude'], '/wt', {}, {});
  ptys[0].exit();
  const { port } = await serve(t, { host });
  const { status, received, closed } = await dial(port, PTY_PATH, fromBoard(port));
  assert.equal(status, 101);
  assert.equal(await closed, 1000);
  assert.deepEqual(received, []);
});
