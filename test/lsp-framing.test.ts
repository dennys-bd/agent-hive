import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder, frame } from '../src/lsp-framing.js';
import { absoluteOf, fileUri, paneOf, pathOfUri } from '../src/lsp-uri.js';

test('frame writes Content-Length in bytes; the decoder reads frames split across chunks and two in one chunk (#780)', () => {
  const one = frame({ jsonrpc: '2.0', method: 'é' });
  assert.match(one.toString(), /^Content-Length: \d+\r\n\r\n\{/);
  const seen: unknown[] = [];
  const decode = createDecoder((m) => seen.push(m), () => assert.fail('no error'));
  decode(one.subarray(0, 10));
  decode(Buffer.concat([one.subarray(10), frame({ id: 1 })]));
  assert.deepEqual(seen, [{ jsonrpc: '2.0', method: 'é' }, { id: 1 }]);
});

test('a frame that is not JSON, or a header without Content-Length, is reported and dropped (#780)', () => {
  const errors: string[] = [];
  const decode = createDecoder(() => assert.fail('no message'), (reason) => errors.push(reason));
  decode(Buffer.from('Content-Length: 3\r\n\r\nnot'));
  decode(Buffer.from('X-Other: 1\r\n\r\n{}'));
  assert.deepEqual(errors, ['a frame that is not JSON', 'a frame without Content-Length']);
});

test('file URIs encode each segment; a pane path resolves against the root and back (#780)', () => {
  assert.equal(fileUri('/w/a b/c#.ts'), 'file:///w/a%20b/c%23.ts');
  assert.equal(pathOfUri('file:///w/a%20b/c%23.ts'), '/w/a b/c#.ts');
  assert.equal(pathOfUri('untitled:1'), undefined);
  assert.deepEqual([absoluteOf('/w/root', 'src/a.ts'), absoluteOf('/w/root', '../x/./b.ts'), absoluteOf('/w/root', '/etc/c')], ['/w/root/src/a.ts', '/w/x/b.ts', '/etc/c']);
  assert.deepEqual([paneOf('/w/root', '/w/root/src/a.ts'), paneOf('/w/root', '/w/other.ts')], ['src/a.ts', '/w/other.ts']);
});

test('a header or a body past its cap is fatal once: the stream is ignored after it, and many small chunks still make one body (#780)', () => {
  const fatals: string[] = [];
  const decode = createDecoder(() => assert.fail('no message'), () => assert.fail('no error'), (reason) => fatals.push(reason));
  decode(Buffer.alloc(9 * 1024, 'x'));
  decode(frame({ id: 1 }));
  assert.deepEqual(fatals, ['a frame header past its cap']);
  const big: string[] = [];
  createDecoder(() => assert.fail('no message'), () => assert.fail('no error'), (reason) => big.push(reason))(Buffer.from(`Content-Length: ${65 * 1024 * 1024}\r\n\r\n`));
  assert.deepEqual(big, ['a frame body past its cap']);
  const seen: unknown[] = [];
  const whole = frame({ text: 'y'.repeat(5000) });
  const slow = createDecoder((m) => seen.push(m), () => assert.fail('no error'));
  for (let i = 0; i < whole.length; i += 7) slow(whole.subarray(i, i + 7));
  assert.equal(seen.length, 1);
});
