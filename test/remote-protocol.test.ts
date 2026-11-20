import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { pack, unpack } from '../src/remote/attachments.js';
import { createMux, decode, encode, FIRST_STREAM_CHANNEL, REMOTE_PROTOCOL_VERSION, RemoteError, type Mux, type MuxStream, type RequestFrame, type TextFrame } from '../src/remote/protocol.js';

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
  assert.ok('error' in unpack([{ $bin: 2 }], bins), 'an index past the attachments');
  for (const index of [-1, 0.5, 1e300]) assert.deepEqual(unpack({ $bin: index }, bins), { value: { $bin: index } }, `${index} is no attachment index`);
});

test('no file under src/remote/ holds a node: import (#936)', async () => {
  // dist/test/ → the repo root; the source is read, not the compiled output
  const dir = new URL('../../src/remote/', import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith('.ts'));
  assert.ok(files.length >= 5, files.join());
  for (const file of files) assert.doesNotMatch(await readFile(new URL(file, dir), 'utf8'), /(from|import\()\s*['"]node:/, file);
});

test('a binary frame is delivered as a copy that owns its buffer, and a bin count past 64 is no frame (#936)', () => {
  const frame = decode(encode({ ch: 1, bytes: Uint8Array.of(5, 6, 7) }));
  assert.ok('bytes' in frame);
  assert.equal(frame.bytes.byteOffset, 0);
  assert.equal(frame.bytes.byteLength, frame.bytes.buffer.byteLength);
  const req = (bin: number) => JSON.stringify({ ch: 1, t: 'req', id: 1, method: 'x', params: null, bin });
  assert.ok(!('error' in decode(req(64))));
  assert.ok('error' in decode(req(65)));
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

test('a matching hello reaches onHello with the peer\'s info, nothing waits for it, and a listener\'s throw reaches onError as internal (#936)', async () => {
  const { host, machine } = pair();
  machine.onRequest(1, () => 'early');
  assert.equal(await host.request(1, 'x', null), 'early', 'a request before any hello goes out at once');
  const infos: unknown[] = [];
  host.onHello((info) => infos.push(info));
  machine.hello({ platform: 'linux', relayPort: 4100 });
  await settle();
  assert.deepEqual(infos, [{ platform: 'linux', relayPort: 4100 }]);
  const codes: string[] = [];
  host.onError((err) => codes.push(err.code));
  host.onHello(() => {
    throw new Error('a listener fails');
  });
  assert.doesNotThrow(() => host.receive(JSON.stringify({ ch: 0, t: 'hello', version: REMOTE_PROTOCOL_VERSION, info: null })));
  assert.deepEqual(codes, ['internal']);
});

test('a hello with another version closes both sides with version_mismatch, naming both versions, and reaches no onHello (#936)', async () => {
  const { host, machine, sent } = pair();
  const closes: Record<Side, (string | undefined)[]> = { host: [], machine: [] };
  host.onClose((code) => closes.host.push(code));
  machine.onClose((code) => closes.machine.push(code));
  let heard = false;
  host.onHello(() => {
    heard = true;
  });
  const other = REMOTE_PROTOCOL_VERSION + 1;
  host.receive(JSON.stringify({ ch: 0, t: 'hello', version: other, info: {} })); // as if the machine had sent it
  await settle();
  assert.deepEqual(closes, { host: ['version_mismatch'], machine: ['version_mismatch'] });
  assert.equal(heard, false);
  const bye = textFrames(sent, 'host').find((f) => f.t === 'bye');
  assert.ok(bye?.t === 'bye' && bye.message?.includes(String(other)) && bye.message.includes(String(REMOTE_PROTOCOL_VERSION)), JSON.stringify(bye));
});

test('a stream opened on one side reaches onStream on the other, carries every byte value both ways, and end() reaches onEnd once (#936)', async () => {
  const { host, machine } = pair();
  const opened: MuxStream[] = [];
  machine.onStream((stream) => opened.push(stream));
  const out = host.openStream();
  assert.equal(out.ch, FIRST_STREAM_CHANNEL);
  assert.equal(host.openStream().ch, FIRST_STREAM_CHANNEL + 2, 'the host takes the odd channels');
  assert.equal(machine.openStream().ch, FIRST_STREAM_CHANNEL + 1, 'the machine the even ones');
  await settle();
  const back = opened.find((stream) => stream.ch === out.ch)!;
  const atMachine: number[][] = [];
  const atHost: number[][] = [];
  let ends = 0;
  back.onData((bytes) => atMachine.push([...bytes]));
  back.onEnd(() => {
    ends += 1;
  });
  out.onData((bytes) => atHost.push([...bytes]));
  out.write(ALL);
  back.write(Uint8Array.from(ALL).reverse());
  await settle();
  assert.deepEqual(atMachine, [[...ALL]]);
  assert.deepEqual(atHost, [[...ALL].reverse()]);
  out.end();
  out.end();
  await settle();
  assert.equal(ends, 1);
  assert.throws(() => out.write(ALL), remote('link_closed'));
});

test('a text frame on a stream channel, a binary frame on a channel never opened, an open of this side\'s parity, an unknown end and a malformed string reach onError as bad_frame; the mux stays open (#936)', async () => {
  const { host, machine } = pair();
  const opened: MuxStream[] = [];
  machine.onStream((stream) => opened.push(stream));
  const codes: string[] = [];
  machine.onError((err) => codes.push(err.code));
  const out = host.openStream();
  await settle();
  const bad = [
    JSON.stringify({ ch: out.ch, t: 'event', id: 1, data: null }),
    encode({ ch: 9, bytes: ALL }),
    JSON.stringify({ ch: 0, t: 'open', stream: 4 }), // even: the machine's own channels
    JSON.stringify({ ch: 0, t: 'end', stream: 9 }),
    '{"ch":',
  ];
  for (const data of bad) assert.doesNotThrow(() => machine.receive(data));
  assert.deepEqual(codes, bad.map(() => 'bad_frame'));
  const got: number[][] = [];
  opened[0].onData((bytes) => got.push([...bytes]));
  out.write(Uint8Array.of(1, 2));
  await settle();
  assert.deepEqual(got, [[1, 2]]);
});

test('close ends every open stream on both sides, and openStream after close throws link_closed (#936)', async () => {
  const { host, machine } = pair();
  const ended: Side[] = [];
  machine.onStream((stream) => stream.onEnd(() => ended.push('machine')));
  const out = host.openStream();
  out.onEnd(() => ended.push('host'));
  await settle();
  host.close();
  await settle();
  assert.deepEqual(ended.sort(), ['host', 'machine']);
  assert.throws(() => host.openStream(), remote('link_closed'));
});

test('both sides ending a stream at once raise no error and fire both onEnd (#936)', async () => {
  const { host, machine } = pair();
  const errors: string[] = [];
  host.onError((err) => errors.push(err.code));
  machine.onError((err) => errors.push(err.code));
  const ends: Side[] = [];
  let back: MuxStream | undefined;
  machine.onStream((stream) => {
    back = stream;
    stream.onEnd(() => ends.push('machine'));
  });
  const out = host.openStream();
  out.onEnd(() => ends.push('host'));
  await settle();
  out.write(Uint8Array.of(1));
  back?.write(Uint8Array.of(2)); // in flight when the peer's end lands
  out.end();
  back?.end();
  await settle();
  assert.deepEqual(errors, []);
  assert.deepEqual(ends.sort(), ['host', 'machine']);
});

test('a result that cannot be sent is answered internal; a req whose $bin the frame lacks is answered bad_frame and reported (#936)', async () => {
  const { host, machine } = pair();
  machine.onRequest(1, (method) => {
    if (method === 'big') return { n: 1n };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    return cycle;
  });
  await assert.rejects(host.request(1, 'big', null), remote('internal'));
  await assert.rejects(host.request(1, 'cycle', null), remote('internal'));
  const codes: string[] = [];
  machine.onError((err) => codes.push(err.code));
  const seen: unknown[] = [];
  const fake = createMux((data) => void seen.push(data), { side: 'host' });
  const pending = fake.request(1, 'x', null);
  fake.receive(JSON.stringify({ ch: 1, t: 'res', id: 1, ok: true, result: null }));
  await pending;
  machine.receive(JSON.stringify({ ch: 1, t: 'req', id: 1, method: 'x', params: { $bin: 0 } }));
  assert.deepEqual(codes, ['bad_frame']);
  await settle();
});

test('an unusable req from the peer is answered bad_frame to the caller (#936)', async () => {
  const sent: string[] = [];
  const machine = createMux((data) => void sent.push(String(data)), { side: 'machine' });
  machine.onRequest(1, () => null);
  const codes: string[] = [];
  machine.onError((err) => codes.push(err.code));
  machine.receive(JSON.stringify({ ch: 1, t: 'req', id: 1, method: 'x', params: { $bin: 0 } }));
  await settle();
  const answer = JSON.parse(sent[0]) as { t: string; ok: boolean; code: string; id: number };
  assert.deepEqual([answer.t, answer.ok, answer.code, answer.id, codes], ['res', false, 'bad_frame', 1, ['bad_frame']]);
});

test('request rolls back when sending throws: it rejects, leaves nothing pending and detaches the abort listener (#936)', async () => {
  const { host } = pair();
  await assert.rejects(host.request(1, 'x', { n: 1n }), TypeError);
  const sent: unknown[] = [];
  let broken = true;
  const mux = createMux((data) => {
    if (broken) throw new Error('pipe is gone');
    sent.push(data);
  }, { side: 'host' });
  const controller = new AbortController();
  await assert.rejects(mux.request(1, 'x', null, { signal: controller.signal }), /pipe is gone/);
  broken = false;
  controller.abort();
  assert.deepEqual(sent, [], 'no cancel goes out for a request that never left');
});

test('a throwing callback never escapes receive and never skips teardown (#936)', async () => {
  const { host, machine } = pair();
  const codes: string[] = [];
  const closes: (string | undefined)[] = [];
  host.onError((err) => codes.push(err.code));
  host.onError(() => {
    throw new Error('onError itself throws');
  });
  host.onClose((code) => closes.push(code));
  const out = host.openStream();
  out.onEnd(() => {
    throw new Error('onEnd throws');
  });
  const second = host.openStream();
  const ended: number[] = [];
  second.onEnd(() => ended.push(second.ch));
  await settle();
  assert.doesNotThrow(() => machine.close('bye'));
  await settle();
  assert.deepEqual(closes, ['bye']);
  assert.deepEqual(ended, [second.ch]);
  assert.deepEqual(codes, ['internal']);
});

test('a peer cannot hold more than 256 streams open, reuse this side\'s id parity or repeat a running id; each is bad_frame and the mux stays open (#936)', async () => {
  const machine = createMux(() => undefined, { side: 'machine' });
  const codes: string[] = [];
  let opened = 0;
  machine.onError((err) => codes.push(err.code));
  machine.onStream(() => {
    opened += 1;
  });
  for (let i = 0; i < 257; i += 1) machine.receive(JSON.stringify({ ch: 0, t: 'open', stream: 3 + 2 * i }));
  assert.deepEqual([opened, codes], [256, ['bad_frame']]);
  codes.length = 0;
  machine.onRequest(1, () => new Promise(() => undefined));
  const req = (id: number) => JSON.stringify({ ch: 1, t: 'req', id, method: 'x', params: null });
  machine.receive(req(2)); // the machine's own parity
  machine.receive(req(1));
  machine.receive(req(1)); // already running
  assert.deepEqual(codes, ['bad_frame', 'bad_frame']);
});

test('a method echoed in unknown_method and a received failure\'s code and message are cut (#936)', async () => {
  const { host } = pair();
  const err = await host.request(2, 'm'.repeat(5000), null).catch((e: unknown) => e);
  assert.ok(err instanceof RemoteError && err.message.length < 300, String((err as Error).message.length));
  const sent: string[] = [];
  const caller = createMux((data) => void sent.push(String(data)), { side: 'host' });
  const pending = caller.request(1, 'x', null);
  caller.receive(JSON.stringify({ ch: 1, t: 'res', id: 1, ok: false, code: 'c'.repeat(5000), message: 'm'.repeat(5000) }));
  const failed = (await pending.catch((e: unknown) => e)) as RemoteError;
  assert.deepEqual([failed.code.length, failed.message.length], [1024, 1024]);
});
