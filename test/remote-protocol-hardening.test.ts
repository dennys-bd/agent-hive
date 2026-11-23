import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMux, RemoteError, type MuxStream } from '../src/remote/protocol.js';
import { pair, settle, remote, type Side } from './remote-pair.js';

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

test('a cancel the transport cannot send still rejects the request with cancelled, and the failure reaches onError (#936)', async () => {
  let broken = false;
  const mux = createMux(() => {
    if (broken) throw new Error('pipe is gone');
  }, { side: 'host' });
  const errors: string[] = [];
  mux.onError((err) => errors.push(err.message));
  const controller = new AbortController();
  const call = mux.request(1, 'x', null, { signal: controller.signal });
  broken = true;
  controller.abort();
  await assert.rejects(call, remote('cancelled'));
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /pipe is gone/);
});

test('a stream whose end the transport cannot send still ends and fires onEnd (#936)', () => {
  let broken = false;
  const mux = createMux(() => {
    if (broken) throw new Error('pipe is gone');
  }, { side: 'host' });
  const stream = mux.openStream();
  let ended = 0;
  stream.onEnd(() => ended++);
  broken = true;
  assert.throws(() => stream.end(), /pipe is gone/);
  assert.equal(ended, 1);
  assert.throws(() => stream.write(Uint8Array.of(1)), RemoteError);
});

test('the peer cannot open again a stream this side ended (#936)', async () => {
  const { host, machine } = pair();
  const errors: string[] = [];
  machine.onError((err) => errors.push(err.code));
  let peerStream: MuxStream | undefined;
  host.onStream((stream) => {
    peerStream = stream;
  });
  const opened = machine.openStream();
  await settle();
  peerStream?.end(); // host ends the machine's stream; its end has not come back
  await settle();
  host.receive(JSON.stringify({ ch: 0, t: 'open', stream: opened.ch }));
  const hostErrors: string[] = [];
  host.onError((err) => hostErrors.push(err.code));
  host.receive(JSON.stringify({ ch: 0, t: 'open', stream: opened.ch }));
  assert.deepEqual(hostErrors, ['bad_frame']);
  assert.deepEqual(errors, []);
});
