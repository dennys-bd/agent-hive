import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonClient } from '../../scripts/experiment/daemon-client.js';
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
