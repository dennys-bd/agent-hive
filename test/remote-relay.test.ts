import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { answerRelay } from '../src/remote/relay-answer.js';
import { listenRelay, RELAY_MAX_BODY_BYTES } from '../src/remote/relay-listen.js';
import { pair, settle } from './remote-pair.js';

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: unknown };

// a stand-in for the Hive's server: json parsed as the real one does, every request recorded
async function startFake(routes: (app: express.Express, seen: Seen[]) => void): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const app = express();
  const seen: Seen[] = [];
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: req.body }); next(); });
  routes(app, seen);
  // express's own 413 is the answer under test; its default handler would also log it
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).end(); });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

async function withRelay(routes: (app: express.Express, seen: Seen[]) => void, run: (ctx: { relayPort: number; fakePort: number; seen: Seen[]; host: ReturnType<typeof pair>['host'] }) => Promise<void>): Promise<void> {
  const fake = await startFake(routes);
  const { host, machine } = pair();
  answerRelay(host, { port: fake.port });
  const relay = await listenRelay(machine, { port: 0 });
  try {
    await run({ relayPort: relay.port, fakePort: fake.port, seen: fake.seen, host });
  } finally {
    await relay.close();
    fake.server.closeAllConnections();
    await new Promise((resolve) => fake.server.close(resolve));
  }
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };
const call = (port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('a hook POST reaches the Hive with its headers, body and the Hive\'s own Host, and the answer comes back (#940)', async () => {
  await withRelay((app) => app.post('/hooks/event', (_req, res) => res.status(201).json({ ok: true })), async ({ relayPort, fakePort, seen }) => {
    const reply = await call(relayPort, { method: 'POST', path: '/hooks/event', headers: { 'content-type': 'application/json', 'x-hive-pty': 'p1', 'x-hive-secret': 's3' }, body: '{"a":1}' });
    assert.equal(reply.status, 201);
    assert.deepEqual(JSON.parse(reply.body), { ok: true });
    assert.equal(seen[0]!.headers['x-hive-pty'], 'p1');
    assert.equal(seen[0]!.headers['x-hive-secret'], 's3');
    assert.equal(seen[0]!.headers.host, `127.0.0.1:${fakePort}`);
    assert.deepEqual(seen[0]!.body, { a: 1 });
  });
});

test('a response the Hive holds for 2 s still arrives (#940)', async () => {
  await withRelay((app) => app.get('/hooks/slow', (_req, res) => { setTimeout(() => res.send('late'), 2000); }), async ({ relayPort }) => {
    const started = Date.now();
    const reply = await call(relayPort, { path: '/hooks/slow' });
    assert.equal(reply.body, 'late');
    assert.ok(Date.now() - started >= 1900);
  });
});

test('an event stream arrives chunk by chunk, the first before the Hive ends (#940)', async () => {
  let fakeEnded = false;
  await withRelay((app) => app.get('/hooks/sse', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: 1\n\n');
    setTimeout(() => { res.write('data: 2\n\n'); fakeEnded = true; res.end(); }, 400);
  }), async ({ relayPort }) => {
    const chunks: string[] = [];
    let firstBeforeEnd = false;
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: relayPort, path: '/hooks/sse', headers: { host: `127.0.0.1:${relayPort}` } }, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        res.on('data', (c: Buffer) => { if (chunks.length === 0) firstBeforeEnd = !fakeEnded; chunks.push(c.toString()); });
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    assert.ok(firstBeforeEnd);
    assert.equal(chunks.join(''), 'data: 1\n\ndata: 2\n\n');
  });
});

test('a client that hangs up mid-response ends the request on the Hive (#940)', async () => {
  let closedUnfinished: Promise<boolean> = Promise.resolve(false);
  await withRelay((app) => app.get('/hooks/hang', (_req, res) => {
    closedUnfinished = new Promise((resolve) => res.on('close', () => resolve(!res.writableFinished)));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: 1\n\n');
  }), async ({ relayPort }) => {
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port: relayPort, path: '/hooks/hang', headers: { host: `127.0.0.1:${relayPort}` } }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => undefined);
      req.end();
    });
    assert.equal(await closedUnfinished, true);
  });
});

test('mcp-session-id crosses both ways untouched (#940)', async () => {
  await withRelay((app) => app.post('/hooks/mcp', (req, res) => { res.set('mcp-session-id', `back-${String(req.headers['mcp-session-id'])}`).send('ok'); }), async ({ relayPort, seen }) => {
    const reply = await call(relayPort, { method: 'POST', path: '/hooks/mcp', headers: { 'mcp-session-id': 'abc' }, body: '{}' });
    assert.equal(seen[0]!.headers['mcp-session-id'], 'abc');
    assert.equal(reply.headers['mcp-session-id'], 'back-abc');
  });
});

test('a 3 MB JSON body gets the Hive\'s own 413, not a 502 (#940)', async () => {
  await withRelay((app) => app.post('/hooks/big', (_req, res) => res.send('ok')), async ({ relayPort }) => {
    const body = JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) });
    const reply = await call(relayPort, { method: 'POST', path: '/hooks/big', headers: { 'content-type': 'application/json' }, body });
    assert.equal(reply.status, 413);
  });
});

test('the listener refuses a foreign Host, a path outside /hooks/, drops cookies, and answers 502 once the link is closed (#940)', async () => {
  await withRelay((app) => app.get('/hooks/x', (_req, res) => res.send('ok')), async ({ relayPort, seen, host }) => {
    assert.equal((await call(relayPort, { path: '/hooks/x', headers: { host: `evil.example:${relayPort}` } })).status, 403);
    assert.equal((await call(relayPort, { path: '/api/x' })).status, 404);
    assert.equal((await call(relayPort, { path: '/hooks/x', headers: { host: `localhost:${relayPort}`, cookie: 'a=b' } })).status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.headers.cookie, undefined);
    host.close();
    await settle();
    const reply = await call(relayPort, { path: '/hooks/x' });
    assert.equal(reply.status, 502);
    assert.equal(typeof JSON.parse(reply.body).error, 'string');
  });
});

test('a body over RELAY_MAX_BODY_BYTES gets 413 from the listener and never reaches the Hive (#940)', async () => {
  await withRelay((app) => app.post('/hooks/huge', (_req, res) => res.send('ok')), async ({ relayPort, seen }) => {
    const reply = await call(relayPort, { method: 'POST', path: '/hooks/huge', headers: { 'content-type': 'application/json' }, body: Buffer.alloc(RELAY_MAX_BODY_BYTES + 1, 0x61) });
    assert.equal(reply.status, 413);
    await sleep(50);
    assert.equal(seen.length, 0);
  });
});
