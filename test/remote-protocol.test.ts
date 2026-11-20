import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pack, unpack } from '../src/remote/attachments.js';
import { decode, encode, type RequestFrame } from '../src/remote/protocol.js';

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
