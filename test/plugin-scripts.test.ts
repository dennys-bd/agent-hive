import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseTweaks } from '../src/design-tweaks.js';
import { pluginSource } from '../src/hooks-settings.js';
import { tempDir } from './temp-dir.js';

// The plugin's two scripts (#241), run as an agent runs them and imported for their pure parts. The browser step of import-dc.mjs is not
// run: CI has no Chrome.
const run = promisify(execFile);
const SCRIPTS = join(pluginSource(), 'scripts');
interface CheckHv { parseTweaks(raw: unknown): unknown; checkFolder(folder: string): Promise<string[]> }
const load = async <T>(name: string): Promise<T> => (await import(pathToFileURL(join(SCRIPTS, name)).href)) as T;

const screen = (body = '<section id="state-default"><h2>default</h2></section>', tweaks = '{}'): string => [
  '<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<script type="application/json" id="hv-tweaks">${tweaks}</script>`, '</head>', '<body>', body, '</body>', '</html>', '',
].join('\n');

async function check(folder: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run(process.execPath, [join(SCRIPTS, 'check-hv.mjs'), folder]);
    return { code: 0, stdout };
  } catch (err) {
    const { code, stdout } = err as { code: number; stdout: string };
    return { code, stdout };
  }
}

const VALID = { layout: { options: ['board', 'list'], default: 'board', group: 'look' }, auto: { type: 'boolean', default: true }, title: { type: 'text', default: 'Flow' }, gap: { type: 'number', default: 8, min: 0, max: 24, step: 4 } };
// The same blocks through both copies of the rules: valid, and one per refusal
const BLOCKS: unknown[] = [
  {}, VALID, null, [], { Bad: { type: 'boolean', default: true } }, { a: { options: [], default: 'x' } }, { a: { options: ['x', 'x'], default: 'x' } },
  { a: { options: ['x'], default: 'y' } }, { a: { type: 'number', default: 5, min: 10, max: 0 } }, { a: { type: 'number', default: 1, step: 0 } },
  { a: { type: 'color', default: 'red' } }, { a: { type: 'text', default: 't'.repeat(201) } }, { a: { type: 'boolean', default: true, group: 1 } },
  Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`t${i}`, { type: 'boolean', default: false }])),
];

test('check-hv.mjs prints nothing and exits 0 on a clean folder, the plugin\'s skeleton included (#241)', async (t) => {
  const folder = await tempDir(t, 'hv-');
  await writeFile(join(folder, 'home.hv.html'), screen('<section id="state-empty"><h2>empty</h2><img src="logo.svg" alt=""></section>', JSON.stringify(VALID)));
  await copyFile(join(pluginSource(), 'reference', 'skeleton.hv.html'), join(folder, 'skeleton.hv.html'));
  assert.deepEqual(await check(folder), { code: 0, stdout: '' });
});

test('check-hv.mjs prints one line per finding and exits 1: a URL, a parent path, fetch, a missing tag, a symbolic link, a broken and an invalid block (#241)', async (t) => {
  const folder = await tempDir(t, 'hv-');
  await writeFile(join(folder, 'a.hv.html'), screen('<img src="https://x.test/a.png">\n<a href="../b.html">b</a>\n<script>fetch("data.json")</script>'));
  await writeFile(join(folder, 'b.hv.html'), screen().replace('</head>\n', ''));
  await writeFile(join(folder, 'c.hv.html'), screen(undefined, '{"layout":'));
  await writeFile(join(folder, 'd.hv.html'), screen(undefined, '{"layout":{"options":[],"default":"x"}}'));
  await symlink(join(folder, 'a.hv.html'), join(folder, 'link.html'));
  const { code, stdout } = await check(folder);
  const lines = stdout.trim().split('\n');
  assert.equal(code, 1);
  for (const expected of [
    /link\.html: a symbolic link$/, /^a\.hv\.html:9: reaches outside/, /^a\.hv\.html:10: reaches outside/, /^a\.hv\.html:11: reaches outside/,
    /^b\.hv\.html: <\/head> is missing or out of order$/, /^c\.hv\.html: the hv-tweaks block is not JSON$/, /^d\.hv\.html: hv-tweaks: layout: options must be/,
  ]) assert.ok(lines.some((line) => expected.test(line)), `${expected} not in:\n${stdout}`);
  assert.equal(lines.length, 7, stdout);
});

test('check-hv.mjs\'s tweak rules answer as src/design-tweaks.ts does on the same blocks, reasons included (#241)', async () => {
  const script = await load<CheckHv>('check-hv.mjs');
  for (const raw of BLOCKS) assert.deepEqual(script.parseTweaks(raw), parseTweaks(raw), JSON.stringify(raw)?.slice(0, 80));
});
