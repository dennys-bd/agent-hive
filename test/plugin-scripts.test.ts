import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

interface Prop { prop: string; editor?: string; options?: string[]; default: unknown }
interface BrowserDeps { env: Record<string, string | undefined>; platform: string; home: string; isExecutable(path: string): Promise<boolean>; list(dir: string): Promise<string[]> }
interface ImportDc {
  readProps(html: string): Prop[]; draftBlock(props: Prop[]): Record<string, unknown>; snapshotsOf(props: Prop[]): { file: string; prop?: string; value?: unknown }[];
  withValue(html: string, prop: string, value: unknown): string; stripped(html: string): string; coloursOf(html: string): string; findBrowser(deps: BrowserDeps): Promise<string | undefined>;
}
const attr = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
// A small export in Claude Design's shape (docs/agent/design_handoff_fluxo_abas/Fluxo.dc.html): data-props on the dc script, and two props
// only the component's script defaults
const EXPORT = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"><script src="./support.js"></script></head><body>',
  '<x-dc><div style="background:#111418;color:#e6e6e6" onclick="go()" data-dc-node="1">{{ label }}</div></x-dc>',
  `<script type="text/x-dc" data-dc-script data-props="${attr(JSON.stringify({ $preview: { width: 1440, height: 900 }, overlay: { editor: 'enum', options: ['menu', 'hive roadmap'], default: 'menu' }, loading: { editor: 'boolean', default: false } }))}">`,
  "class Component extends DCLogic { renderVals() { const t = this.props.pageTitle ?? 'Fluxo'; const n = this.props.count ?? 3; return { label: t }; } }",
  '</script></body></html>',
].join('\n');

test('import-dc.mjs reads the export\'s data-props and its props.<name> ?? <literal> defaults into a draft block that parses, and names one snapshot per value of each prop (#241)', async () => {
  const dc = await load<ImportDc>('import-dc.mjs');
  const props = dc.readProps(EXPORT);
  const block = dc.draftBlock(props);
  assert.deepEqual(block, {
    overlay: { options: ['menu', 'hive roadmap'], default: 'menu' }, loading: { type: 'boolean', default: false },
    'page-title': { type: 'text', default: 'Fluxo' }, count: { type: 'number', default: 3 },
  });
  assert.equal(parseTweaks(block).ok, true);
  assert.deepEqual(dc.snapshotsOf(props).map((s) => s.file), [
    'default.html', 'overlay-menu.html', 'overlay-hive-roadmap.html', 'loading-true.html', 'loading-false.html', 'page-title-fluxo.html', 'count-3.html',
  ]);
});

test('import-dc.mjs rewrites one prop\'s default in a copy, strips scripts, data-dc-* and on* attributes from a snapshot, and counts the literal colours (#241)', async () => {
  const dc = await load<ImportDc>('import-dc.mjs');
  assert.deepEqual(dc.readProps(dc.withValue(EXPORT, 'overlay', 'hive roadmap')).map((p) => [p.prop, p.default]), [['overlay', 'hive roadmap'], ['loading', false], ['pageTitle', 'Fluxo'], ['count', 3]]);
  assert.equal(dc.readProps(dc.withValue(EXPORT, 'pageTitle', 'Board')).find((p) => p.prop === 'pageTitle')?.default, 'Board');
  assert.equal(dc.stripped('<div onclick="go()" data-dc-node="1" class="a onboarding">onboarding<script>x()</script></div>'), '<div class="a onboarding">onboarding</div>');
  assert.equal(dc.coloursOf(`${EXPORT}<p style="color:#E6E6E6">&#039;</p>`), '#e6e6e6 2\n#111418 1\n');
});

test('import-dc.mjs looks for the browser on PATH, then the system Chrome, then Playwright\'s newest Chromium, and finds none without them (#241)', async () => {
  const dc = await load<ImportDc>('import-dc.mjs');
  const home = join(tmpdir(), 'no-home'); // never read: list and isExecutable are fakes
  const cache = join(home, 'Library/Caches/ms-playwright');
  const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const newest = join(cache, 'chromium-1200', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const older = join(cache, 'chromium-1100', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium');
  const deps = (executables: string[]): BrowserDeps => ({
    env: { PATH: ['/opt/a', '/opt/b'].join(delimiter) }, platform: 'darwin', home,
    isExecutable: async (path) => executables.includes(path), list: async (dir) => (dir === cache ? ['chromium-1100', 'chromium-1200', 'ffmpeg-1011'] : []),
  });
  assert.equal(await dc.findBrowser(deps(['/opt/b/google-chrome', system, newest])), '/opt/b/google-chrome');
  assert.equal(await dc.findBrowser(deps([system, newest])), system);
  assert.equal(await dc.findBrowser(deps([older, newest])), newest);
  assert.equal(await dc.findBrowser(deps([])), undefined);
});
