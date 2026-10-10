import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_MAIN_WINDOW, readMainWindowBounds, writeMainWindowBounds } from '../src/main-window-bounds.js';
import { tempDir, type AfterHost } from './temp-dir.js';

const PRIMARY = { x: 0, y: 0, width: 1440, height: 900 };
const SECOND = { x: 1440, y: 0, width: 1920, height: 1080 }; // to the right of the primary display, as a second monitor sits (#398)

async function tempFile(t: AfterHost): Promise<string> {
  const dir = await tempDir(t, 'main-window-bounds-');
  return join(dir, 'main-window-bounds.json');
}

test('writeMainWindowBounds then readMainWindowBounds round-trips the rectangle and both flags', async (t) => {
  const file = await tempFile(t);
  const saved = { x: 100, y: 80, width: 1300, height: 840, maximized: true, fullScreen: false };
  writeMainWindowBounds(file, saved);
  assert.deepEqual(await readMainWindowBounds(file, [PRIMARY]), saved);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
});

test('readMainWindowBounds gives the default (1280x820, centred, normal) when the file is missing', async (t) => {
  const file = await tempFile(t);
  assert.deepEqual(await readMainWindowBounds(file, [PRIMARY]), DEFAULT_MAIN_WINDOW);
  assert.deepEqual(DEFAULT_MAIN_WINDOW, { width: 1280, height: 820, maximized: false, fullScreen: false });
});

test('readMainWindowBounds gives the default when the JSON is corrupt or the wrong shape', async (t) => {
  const file = await tempFile(t);
  await writeFile(file, '{ not json');
  assert.deepEqual(await readMainWindowBounds(file, [PRIMARY]), DEFAULT_MAIN_WINDOW);
  await writeFile(file, JSON.stringify({ x: 1, y: 2, width: 1000, height: 700 })); // no maximized / fullScreen
  assert.deepEqual(await readMainWindowBounds(file, [PRIMARY]), DEFAULT_MAIN_WINDOW, 'missing flags: not a main window bounds record');
  await writeFile(file, JSON.stringify({ x: 1, y: 2, width: 1000, height: 700, maximized: 'yes', fullScreen: false }));
  assert.deepEqual(await readMainWindowBounds(file, [PRIMARY]), DEFAULT_MAIN_WINDOW, 'maximized must be a boolean');
  await writeFile(file, JSON.stringify({ x: 1, y: 2, width: 0, height: 700, maximized: false, fullScreen: false }));
  assert.deepEqual(await readMainWindowBounds(file, [PRIMARY]), DEFAULT_MAIN_WINDOW, 'a zero width is not a window');
});

test('readMainWindowBounds gives the default when the saved rectangle\'s centre lands on no connected display', async (t) => {
  const file = await tempFile(t);
  // a display unplugged since the last run: this rectangle's centre (2600, 300) sat on a monitor that is gone
  writeMainWindowBounds(file, { x: 2500, y: 100, width: 200, height: 400, maximized: false, fullScreen: false });
  assert.deepEqual(await readMainWindowBounds(file, [PRIMARY]), DEFAULT_MAIN_WINDOW);
});

test('readMainWindowBounds keeps the saved bounds when the window is only partly off-screen but its centre is still on a display', async (t) => {
  const file = await tempFile(t);
  const partlyOff = { x: -50, y: -20, width: 300, height: 200, maximized: false, fullScreen: true }; // centre at (100, 80): on PRIMARY
  writeMainWindowBounds(file, partlyOff);
  assert.deepEqual(await readMainWindowBounds(file, [PRIMARY]), partlyOff);
});

test('readMainWindowBounds works across several work areas: a centre on the second display is kept too', async (t) => {
  const file = await tempFile(t);
  const onSecond = { x: 1500, y: 50, width: 400, height: 300, maximized: false, fullScreen: false }; // centre at (1700, 200): on SECOND
  writeMainWindowBounds(file, onSecond);
  assert.deepEqual(await readMainWindowBounds(file, [PRIMARY, SECOND]), onSecond);
});
