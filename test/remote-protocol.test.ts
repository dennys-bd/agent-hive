import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pack, unpack } from '../src/remote/attachments.js';
import { createMux, decode, encode, RemoteError, type Mux, type RequestFrame, type TextFrame } from '../src/remote/protocol.js';

const ALL = Uint8Array.from({ length: 256 }, (_, i) => i);

test('encode and decode round-trip a binary frame of every byte value, its channel big-endian in the first 4 bytes, and a text frame (#936)', () => {
  const wire = encode({ ch: 0x01020304, bytes: ALL });
  assert.ok(wire instanceof Uint8Array);
  assert.deepEqual([...wire.subarray(0, 4)], [1, 2, 3, 4]);
  assert.deepEqual(decode(wire), { ch: 0x01020304, bytes: ALL });
  const req: RequestFrame = { ch: 1, t: 'req', id: 3, method: 'fs.stat', params: { path: '/a' } };
  assert.equal(typeof encode(req), 'string');
  assert.deepEqual(decode(encode(req)), req);
});

test('decode answers an error for what is no frame, and never throws (#936)', () => {
  const bad = ['', '{not json', 'null', '[]', '{"ch":1}', '{"ch":-1,"t":"cancel","id":1}', '{"ch":1,"t":"nope"}', '{"ch":1,"t":"toString"}',
    '{"ch":1,"t":"req","id":1.5,"method":"x"}', '{"ch":1,"t":"res","id":1,"ok":false}', '{"ch":1,"t":"hello","version":1}',
    '{"ch":0,"t":"open","stream":2}', Uint8Array.of(0, 0, 1)];
  for (const data of bad) assert.ok('error' in decode(data), String(data));
});

test('pack puts every Uint8Array, a Buffer included, out as { $bin: i } in order without touching its input, and unpack puts them back (#936)', () => {
  const when = new Date(0);
  const input = { a: [ALL, { b: Buffer.from([1, 2]) }], when, n: null };
  const { value, bins } = pack(input);
  assert.deepEqual(value, { a: [{ $bin: 0 }, { b: { $bin: 1 } }], when, n: null }, 'a Date is no plain object and passes through');
  assert.deepEqual(bins, [ALL, Buffer.from([1, 2])]);
  assert.equal(input.a[0], ALL, 'the input is not mutated');
  const back = unpack(JSON.parse(JSON.stringify(value)), bins);
  assert.deepEqual(back, { value: { a: [ALL, { b: Buffer.from([1, 2]) }], when: '1970-01-01T00:00:00.000Z', n: null } });
  assert.deepEqual(unpack({ $bin: 0, other: 1 }, bins), { value: { $bin: 0, other: 1 } }, 'only an object whose one key is $bin is an attachment');
  assert.deepEqual(unpack({ $bin: 'x' }, bins), { value: { $bin: 'x' } });
  for (const index of [2, -1, 0.5]) assert.ok('error' in unpack([{ $bin: index }], bins), String(index));
});

test('src/remote/protocol.ts, attachments.ts and stdio-frames.ts hold no node: import (#936)', async () => {
  for (const file of ['protocol.ts', 'attachments.ts', 'stdio-frames.ts']) {
    // dist/test/ → the repo root; the source is read, not the compiled output
    const text = await readFile(new URL(`../../src/remote/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /(from|import\()\s*['"]node:/, file);
  }
});

type Side = 'host' | 'machine';
type Sent = { from: Side; data: string | Uint8Array };

// two muxes whose send calls the other's receive on a microtask; `receive` is called unbound, as createStdioDecoder(mux.receive, …) will
function pair(): { host: Mux; machine: Mux; sent: Sent[] } {
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
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const textFrames = (sent: Sent[], from: Side): TextFrame[] =>
  sent.flatMap((s) => {
    if (s.from !== from) return [];
    const frame = decode(s.data);
    return 'error' in frame || 'bytes' in frame ? [] : [frame];
  });
const remote = (code: string) => (err: unknown): boolean => err instanceof RemoteError && err.code === code;

test('a request on channel 1 resolves with the handler\'s result; a throw arrives as a RemoteError with its code and data; a plain one as internal; no handler as unknown_method (#936)', async () => {
  const { host, machine } = pair();
  machine.onRequest(1, (method, params) => {
    if (method === 'echo') return params;
    if (method === 'later') return Promise.resolve({ later: params });
    if (method === 'enoent') throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    if (method === 'exec') return Promise.reject(new RemoteError('exec_failed', 'exit 1', { stderr: Uint8Array.of(0xff), killed: false }));
    throw new Error('plain');
  });
  assert.deepEqual(await host.request(1, 'echo', { a: [1, 'x'] }), { a: [1, 'x'] });
  assert.deepEqual(await host.request(1, 'later', 2), { later: 2 });
  await assert.rejects(host.request(1, 'enoent', null), (err: unknown) => remote('ENOENT')(err) && (err as Error).message === 'no such file');
  const failed = await host.request(1, 'exec', null).catch((err: unknown) => err);
  assert.ok(remote('exec_failed')(failed));
  assert.deepEqual((failed as RemoteError).data, { stderr: Uint8Array.of(0xff), killed: false });
  await assert.rejects(host.request(1, 'other', null), remote('internal'));
  await assert.rejects(host.request(2, 'fetch', null), remote('unknown_method'));
  await assert.rejects(host.request(3, 'x', null), RangeError);
  assert.throws(() => machine.onRequest(0, () => null), RangeError);
});

test('events reach onEvent in order, bytes included, before the result (#936)', async () => {
  const { host, machine } = pair();
  machine.onRequest(1, async (_method, _params, ctx) => {
    ctx.emit('a');
    ctx.emit({ chunk: Uint8Array.of(0, 255) });
    await settle();
    ctx.emit('c');
    return 'done';
  });
  const seen: unknown[] = [];
  seen.push(await host.request(1, 'run', null, { onEvent: (data) => seen.push(data) }));
  assert.deepEqual(seen, ['a', { chunk: Uint8Array.of(0, 255) }, 'c', 'done']);
});

test('a Uint8Array of every byte value, nested in params and in the result, arrives byte-equal as binary frames; concurrent requests keep their own bytes (#936)', async () => {
  const { host, machine, sent } = pair();
  machine.onRequest(1, async (method, params) => {
    await settle();
    return { method, got: params };
  });
  const [one, two] = await Promise.all([
    host.request(1, 'one', { file: 'a.bin', chunks: [ALL, { inner: Buffer.from(ALL) }] }),
    host.request(1, 'two', { file: 'b.bin', chunks: [Uint8Array.of(7), { inner: new Uint8Array(0) }] }),
  ]);
  assert.deepEqual(one, { method: 'one', got: { file: 'a.bin', chunks: [ALL, { inner: ALL }] } });
  assert.deepEqual(two, { method: 'two', got: { file: 'b.bin', chunks: [Uint8Array.of(7), { inner: new Uint8Array(0) }] } });
  assert.equal(sent.filter((s) => typeof s.data !== 'string').length, 8, 'two attachments each way per request, never base64 in the text');
});

test('aborting a request\'s signal rejects it with cancelled, aborts the handler\'s signal, and a late answer is dropped (#936)', async () => {
  const { host, machine, sent } = pair();
  let handlerSignal: AbortSignal | undefined;
  let answer!: (value: unknown) => void;
  machine.onRequest(1, (_method, _params, ctx) => {
    handlerSignal = ctx.signal;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const errors: RemoteError[] = [];
  host.onError((err) => errors.push(err));
  const controller = new AbortController();
  const running = host.request(1, 'run', null, { signal: controller.signal });
  await settle();
  controller.abort();
  await assert.rejects(running, remote('cancelled'));
  await settle();
  assert.equal(handlerSignal?.aborted, true);
  answer('late');
  await settle();
  assert.deepEqual(textFrames(sent, 'machine').filter((f) => f.t === 'res'), [], 'the late answer is never sent');
  assert.deepEqual(errors, []);
  await assert.rejects(host.request(1, 'run', null, { signal: AbortSignal.abort() }), remote('cancelled'), 'an aborted signal sends nothing');
});

test('ids are odd from host and even from machine, and a request from each side at once resolves both (#936)', async () => {
  const { host, machine, sent } = pair();
  host.onRequest(1, (method) => `host:${method}`);
  machine.onRequest(1, (method) => `machine:${method}`);
  const answers = await Promise.all([host.request(1, 'a', null), machine.request(1, 'b', null), host.request(1, 'c', null), machine.request(1, 'd', null)]);
  assert.deepEqual(answers, ['machine:a', 'host:b', 'machine:c', 'host:d']);
  const ids = (from: Side) => textFrames(sent, from).flatMap((f) => (f.t === 'req' ? [f.id] : []));
  assert.deepEqual([ids('host'), ids('machine')], [[1, 3], [2, 4]]);
});

test('close rejects every pending request with link_closed, aborts the peer\'s running handlers once the bye arrives, and request after close rejects at once; onClose fires once on each side (#936)', async () => {
  const { host, machine, sent } = pair();
  let aborted = 0;
  const hang: Parameters<Mux['onRequest']>[1] = (_method, _params, ctx) =>
    new Promise(() => ctx.signal.addEventListener('abort', () => {
      aborted += 1;
    }));
  machine.onRequest(1, hang);
  host.onRequest(1, () => new Promise(() => undefined));
  const closes: Record<Side, (string | undefined)[]> = { host: [], machine: [] };
  host.onClose((code) => closes.host.push(code));
  machine.onClose((code) => closes.machine.push(code));
  const pending = [host.request(1, 'a', null), host.request(1, 'b', null), machine.request(1, 'c', null)];
  await settle();
  host.close('quit');
  const before = sent.filter((s) => s.from === 'host').length;
  await Promise.all(pending.map((p) => assert.rejects(p, remote('link_closed'))));
  assert.equal(aborted, 2);
  await assert.rejects(host.request(1, 'later', null), remote('link_closed'));
  host.close();
  await settle();
  assert.equal(sent.filter((s) => s.from === 'host').length, before, 'send is never called after close');
  assert.deepEqual(closes, { host: ['quit'], machine: ['quit'] });
});

test('a malformed string, a stray binary frame, an answer to an id never sent, a call on channel 0 and a $bin past the attachments reach onError as bad_frame; receive never throws (#936)', () => {
  const host = createMux(() => undefined, { side: 'host' });
  const codes: string[] = [];
  host.onError((err) => codes.push(err.code));
  const bad = [
    '{not json',
    JSON.stringify({ ch: 1, t: 'req', id: -1, method: 'x', params: null }),
    encode({ ch: 1, bytes: ALL }),
    Uint8Array.of(0, 0),
    JSON.stringify({ ch: 1, t: 'res', id: 1, ok: true, result: null }), // odd, but this side has sent nothing yet
    JSON.stringify({ ch: 1, t: 'res', id: 2, ok: true, result: null }), // even: the machine's own parity
    JSON.stringify({ ch: 0, t: 'req', id: 2, method: 'x', params: null }),
    JSON.stringify({ ch: 1, t: 'req', id: 2, method: 'x', params: { $bin: 0 } }),
  ];
  for (const data of bad) assert.doesNotThrow(() => host.receive(data));
  assert.deepEqual(codes, bad.map(() => 'bad_frame'));
});
