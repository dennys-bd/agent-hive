import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStdioDecoder, encodeStdioFrame } from '../src/remote/stdio-frames.js';

const ALL = Uint8Array.from({ length: 256 }, (_, i) => i);
const TEXT = '{"ch":1,"t":"req","id":1,"method":"fs.readFile","params":"ação 🐝"}';

function decoder(opts?: { maxFrameBytes?: number }) {
  const frames: (string | Uint8Array)[] = [];
  const errors: string[] = [];
  const { push } = createStdioDecoder((frame) => frames.push(frame), (message) => errors.push(message), opts);
  return { frames, errors, push };
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  parts.reduce((at, part) => {
    out.set(part, at);
    return at + part.length;
  }, 0);
  return out;
};

test('a text frame and a binary frame of every byte value, split at every byte offset, yield the same two frames (#936)', () => {
  assert.deepEqual([...encodeStdioFrame(Uint8Array.of(9)).subarray(0, 5)], [0, 0, 0, 2, 1], 'big-endian length of kind + body, then kind 1');
  const stream = concat(encodeStdioFrame(TEXT), encodeStdioFrame(ALL));
  for (let cut = 0; cut <= stream.length; cut += 1) {
    const d = decoder();
    d.push(stream.subarray(0, cut));
    d.push(stream.subarray(cut));
    assert.deepEqual(d.frames, [TEXT, ALL], `cut at ${cut}`);
    assert.deepEqual(d.errors, []);
  }
});

test('two frames in one chunk yield both in order; an empty text and an empty binary frame round-trip (#936)', () => {
  const d = decoder();
  d.push(concat(encodeStdioFrame('a'), encodeStdioFrame(Uint8Array.of(1)), encodeStdioFrame(''), encodeStdioFrame(new Uint8Array(0))));
  assert.deepEqual(d.frames, ['a', Uint8Array.of(1), '', new Uint8Array(0)]);
  assert.deepEqual(d.errors, []);
});

test('a header over maxFrameBytes and an unknown kind each call onError once, and later chunks yield nothing (#936)', () => {
  const exact = decoder({ maxFrameBytes: 9 });
  exact.push(encodeStdioFrame('12345678'));
  assert.deepEqual(exact.frames, ['12345678'], 'a length at the cap is a frame');
  const over = decoder({ maxFrameBytes: 8 });
  over.push(encodeStdioFrame('12345678'));
  over.push(encodeStdioFrame('a'));
  assert.deepEqual([over.frames, over.errors.length], [[], 1]);
  const huge = decoder();
  huge.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0)); // 4 GiB announced: refused from the header alone, before any body arrives
  huge.push(encodeStdioFrame('a'));
  assert.deepEqual([huge.frames, huge.errors.length], [[], 1]);
  const kind = decoder();
  kind.push(concat(Uint8Array.of(0, 0, 0, 2, 7, 0), encodeStdioFrame('a')));
  assert.deepEqual([kind.frames, kind.errors.length], [[], 1]);
  const empty = decoder();
  empty.push(concat(Uint8Array.of(0, 0, 0, 0, 0), encodeStdioFrame('a')));
  assert.deepEqual([empty.frames, empty.errors.length], [[], 1], 'a length of 0 has no kind byte');
});

test('multi-byte UTF-8 split across chunks decodes whole, fed one byte at a time (#936)', () => {
  const d = decoder();
  for (const byte of encodeStdioFrame('ação 🐝')) d.push(Uint8Array.of(byte));
  assert.deepEqual(d.frames, ['ação 🐝']);
});
