import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// same relative path main.ts uses from dist/src/main.js
const ICON = fileURLToPath(new URL('../../assets/icon.png', import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_WIDTH_OFFSET = 16;
const IHDR_HEIGHT_OFFSET = 20;
const MIN_DOCK_ICON_PX = 512;

test('assets/icon.png is a square PNG large enough for the Dock', async () => {
  const png = await readFile(ICON);
  assert.deepEqual(png.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  const width = png.readUInt32BE(IHDR_WIDTH_OFFSET);
  const height = png.readUInt32BE(IHDR_HEIGHT_OFFSET);
  assert.equal(width, height);
  assert.ok(width >= MIN_DOCK_ICON_PX, `icon is ${width}px, expected >= ${MIN_DOCK_ICON_PX}`);
});
