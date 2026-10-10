import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_TERMINAL_WINDOW, insideRect, parsePtyMessage, readBounds, sizeIn, writeBounds } from '../src/terminal-wire.js';
import { tempDir } from './temp-dir.js';

test('readBounds gives the default when the file is missing or not a bounds record, and what writeBounds stored otherwise', async (t) => {
  const dir = await tempDir(t, 'bounds-');
  const file = join(dir, 'terminal-bounds.json');
  assert.deepEqual(await readBounds(file), DEFAULT_TERMINAL_WINDOW);
  assert.deepEqual(DEFAULT_TERMINAL_WINDOW, { width: 1000, height: 640 });
  await writeFile(file, '{ nope');
  assert.deepEqual(await readBounds(file), DEFAULT_TERMINAL_WINDOW);
  await writeFile(file, JSON.stringify({ x: 1, y: 2, width: 0, height: 10 }));
  assert.deepEqual(await readBounds(file), DEFAULT_TERMINAL_WINDOW, 'a zero width is not a window');
  await writeBounds(file, { x: 120, y: 80, width: 1000, height: 640 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { x: 120, y: 80, width: 1000, height: 640 });
  await writeFile(file, JSON.stringify({ x: 120, y: 80, width: 1000, height: 640, extra: true }));
  assert.deepEqual(await readBounds(file), { x: 120, y: 80, width: 1000, height: 640 }, 'only the four keys come back');
});

test('insideRect: a point inside the rectangle or on its edge is in, one pixel past it is out; moved by the board\'s content bounds, the same point can fall off (#252)', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };
  assert.equal(insideRect({ x: 50, y: 40 }, rect), true);
  assert.equal(insideRect({ x: 10, y: 20 }, rect), true, 'the top-left corner');
  assert.equal(insideRect({ x: 110, y: 70 }, rect), true, 'the bottom-right corner');
  assert.equal(insideRect({ x: 111, y: 40 }, rect), false);
  assert.equal(insideRect({ x: 50, y: 19 }, rect), false);
  const onScreen = { ...rect, x: rect.x + 200, y: rect.y + 100 }; // the board's content sits at (200, 100)
  assert.equal(insideRect({ x: 50, y: 40 }, onScreen), false);
  assert.equal(insideRect({ x: 250, y: 140 }, onScreen), true);
});

test('parsePtyMessage reads the terminal socket\'s input and resize, rebuilt from their known keys (#407)', () => {
  assert.deepEqual(parsePtyMessage('{"type":"input","data":"ls\\r"}'), { type: 'input', data: 'ls\r' });
  assert.deepEqual(parsePtyMessage('{"type":"input","data":""}'), { type: 'input', data: '' });
  assert.deepEqual(parsePtyMessage('{"type":"resize","cols":120,"rows":40,"extra":1}'), { type: 'resize', cols: 120, rows: 40 });
});

test('parsePtyMessage answers undefined, never a throw, for what is not JSON, not an object, of an unknown type, or carries a bad field (#407)', () => {
  const bad = [
    '', 'ls', '"input"', 'null', '[]', '{"data":"ls"}', '{"type":"exec","data":"rm -rf ~"}',
    '{"type":"input"}', '{"type":"input","data":5}',
    '{"type":"resize"}', '{"type":"resize","cols":0,"rows":40}', '{"type":"resize","cols":1.5,"rows":40}', '{"type":"resize","cols":"120","rows":40}',
    '{"type":"resize","cols":1001,"rows":40}', '{"type":"resize","cols":120,"rows":501}', // #808: past the cap, which would grow the host's fallback for good
  ];
  for (const raw of bad) assert.equal(parsePtyMessage(raw), undefined, raw);
});

test('sizeIn reads a run-opening body\'s size, rebuilt from cols and rows; anything else is no size, never a throw (#808)', () => {
  assert.deepEqual(sizeIn({ kind: 'terminal', size: { cols: 132, rows: 41, extra: 1 } }), { cols: 132, rows: 41 });
  const none = [undefined, null, 'x', {}, { size: null }, { size: '132x41' }, { size: { cols: 0, rows: 41 } }, { size: { cols: 132 } }, { size: { cols: '132', rows: 41 } }, { size: { cols: 1e9, rows: 41 } }, { size: { cols: 132, rows: 1e9 } }];
  assert.deepEqual(sizeIn({ size: { cols: 1000, rows: 500 } }), { cols: 1000, rows: 500 }); // the cap itself still passes
  for (const body of none) assert.equal(sizeIn(body), undefined, JSON.stringify(body));
});
