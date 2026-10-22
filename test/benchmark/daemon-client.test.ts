import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonClient } from '../../src/benchmark/daemon-client.js';
import { task } from './fixtures.js';

const SECRET = 'a'.repeat(64);
const ADDRESS = { port: 4321, secret: SECRET };
const enc = new TextEncoder();
const stream = (...chunks: string[]): ReadableStream<Uint8Array> => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(enc.encode(chunk)); } }); // never closed, as /events is not

function fakeFetch(answer: (url: string, init: RequestInit) => Response): { fn: typeof fetch; seen: { url: string; init: RequestInit }[] } {
  const seen: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(input), init });
    return answer(String(input), init);
  }) as typeof fetch;
  return { fn, seen };
}

test('state() and payload() read the first /events frame, past a ping and across chunks, with the home secret (#105)', async () => {
  const state = { tasks: [task(1, 'Spec')], workers: [], activities: [], activityRecords: [], signal: 'green', stages: [{ name: 'Spec' }] };
  const json = JSON.stringify(state);
  const f = fakeFetch(() => new Response(stream(': ping\n\n', `data: ${json.slice(0, 10)}`, `${json.slice(10)}\n\n`)));
  const client = createDaemonClient('/home', { address: () => ADDRESS, fetch: f.fn });
  assert.deepEqual(await client.state(), { tasks: state.tasks, workers: [], activities: [], activityRecords: [] });
  assert.deepEqual(await client.payload(), state);
  assert.equal(f.seen[0].url, 'http://127.0.0.1:4321/events');
  assert.equal((f.seen[0].init.headers as Record<string, string>)['x-hive-secret'], SECRET);
});

test('state() rejects in setup mode, on a refusal and with no daemon, and no message carries the secret (#105)', async () => {
  const client = (answer: () => Response, address: () => typeof ADDRESS | undefined = () => ADDRESS) => createDaemonClient('/home', { address, fetch: fakeFetch(answer).fn });
  const failures = [
    await client(() => new Response(stream('data: {"configured":false}\n\n'))).state().catch((err: Error) => err),
    await client(() => new Response('forbidden', { status: 403 })).state().catch((err: Error) => err),
    await client(() => new Response(''), () => undefined).state().catch((err: Error) => err),
  ];
  assert.deepEqual(failures.map((e) => (e as Error).message), ['GET /events: the daemon is not configured', 'GET /events: HTTP 403', 'the daemon of this home is not running']);
  for (const e of failures) assert.ok(!(e as Error).message.includes(SECRET));
});

test('setAuto POSTs auto true with the secret and the dashboard header, and a refusal rejects naming the route (#105)', async () => {
  const f = fakeFetch((url) => new Response('{}', { status: url.endsWith('local%3A3/auto') ? 409 : 200 }));
  const client = createDaemonClient('/home', { address: () => ADDRESS, fetch: f.fn });
  await client.setAuto('local:2');
  const { url, init } = f.seen[0];
  assert.equal(url, 'http://127.0.0.1:4321/tasks/local%3A2/auto');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(String(init.body)), { auto: true });
  const headers = init.headers as Record<string, string>;
  assert.deepEqual([headers['x-hive-secret'], headers['x-hive-ui'], headers['content-type']], [SECRET, '1', 'application/json']);
  await assert.rejects(client.setAuto('local:3'), /^Error: POST \/tasks\/local:3\/auto: HTTP 409$/);
});

test('setGreen POSTs the green signal with the secret and the dashboard header: a booted daemon opens yellow, which starts no task (#105)', async () => {
  const f = fakeFetch((_url, init) => new Response('{}', { status: JSON.parse(String(init.body)).signal === 'green' ? 200 : 400 }));
  const client = createDaemonClient('/home', { address: () => ADDRESS, fetch: f.fn });
  await client.setGreen();
  const { url, init } = f.seen[0];
  assert.equal(url, 'http://127.0.0.1:4321/signal');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(String(init.body)), { signal: 'green' });
  const headers = init.headers as Record<string, string>;
  assert.deepEqual([headers['x-hive-secret'], headers['x-hive-ui'], headers['content-type']], [SECRET, '1', 'application/json']);
  const refusing = createDaemonClient('/home', { address: () => ADDRESS, fetch: fakeFetch(() => new Response('{}', { status: 503 })).fn });
  await assert.rejects(refusing.setGreen(), /^Error: POST \/signal: HTTP 503$/);
});

test('state() rejects a frame that does not parse with a fixed message that quotes none of it (#473)', async () => {
  const f = fakeFetch(() => new Response(stream('data: {"tasks":[{"title":"private words"\n\n')));
  const err = await createDaemonClient('/home', { address: () => ADDRESS, fetch: f.fn }).state().catch((e: Error) => e);
  assert.equal((err as Error).message, 'GET /events: the first frame does not parse');
});

test('sleepRuns POSTs the pty ids to /ptys/sleep and continueActivity POSTs /activities/:id/continue, with the secret and the dashboard header; a refusal names the route (#472)', async () => {
  const f = fakeFetch((url) => new Response('{}', { status: url.includes('act%2F9') ? 409 : 200 }));
  const client = createDaemonClient('/home', { address: () => ADDRESS, fetch: f.fn });
  await client.sleepRuns(['r1', 'r2']);
  await client.continueActivity('act-1');
  assert.deepEqual(f.seen.map(({ url, init }) => [url, init.method, JSON.parse(String(init.body))]), [
    ['http://127.0.0.1:4321/ptys/sleep', 'POST', { ptyIds: ['r1', 'r2'] }],
    ['http://127.0.0.1:4321/activities/act-1/continue', 'POST', {}],
  ]);
  for (const { init } of f.seen) {
    const headers = init.headers as Record<string, string>;
    assert.deepEqual([headers['x-hive-secret'], headers['x-hive-ui'], headers['content-type']], [SECRET, '1', 'application/json']);
  }
  await assert.rejects(client.continueActivity('act/9'), /^Error: POST \/activities\/act\/9\/continue: HTTP 409$/);
});

test('state() carries the daemon\'s slept list when the frame has one, and none when it does not (#472)', async () => {
  const frame = { tasks: [], workers: [], activities: [], activityRecords: [] };
  const slept = [{ ptyId: 'r1', agent: 'claude', kind: 'stage', cause: 'all', at: 1 }];
  const read = async (body: object) => createDaemonClient('/home', { address: () => ADDRESS, fetch: fakeFetch(() => new Response(stream(`data: ${JSON.stringify(body)}\n\n`))).fn }).state();
  assert.deepEqual((await read({ ...frame, slept })).slept, slept);
  assert.equal((await read(frame)).slept, undefined);
  assert.equal((await read({ ...frame, slept: 'x' })).slept, undefined);
});

test('interventions() GETs /benchmark-run with the home secret and keeps the four fields of each intervention; a refusal rejects naming the route (#475)', async () => {
  const done = { at: '2026-10-22T10:00:00.000Z', action: 'POST /tasks/:id/approve', detail: '/tasks/RUN-1/approve', by: 'user' };
  const f = fakeFetch(() => Response.json({ marker: {}, interventions: [{ ...done, body: 'the user\'s words' }, { at: 1 }] }));
  const client = createDaemonClient('/home', { address: () => ADDRESS, fetch: f.fn });
  assert.deepEqual(await client.interventions(), [done]);
  assert.equal(f.seen[0].url, 'http://127.0.0.1:4321/benchmark-run');
  assert.equal((f.seen[0].init.headers as Record<string, string>)['x-hive-secret'], SECRET);
  const plain = createDaemonClient('/home', { address: () => ADDRESS, fetch: fakeFetch(() => new Response('', { status: 404 })).fn });
  await assert.rejects(plain.interventions(), /^Error: GET \/benchmark-run: HTTP 404$/);
});
