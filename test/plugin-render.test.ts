import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { marketplaceName, pluginCacheDir, rolesDir } from '../src/agents/codex-home.js';
import { listFiles } from '../src/item-sources.js';
import { pluginSource } from '../src/hooks-settings.js';
import { deliveredName, hasDeclarations, parseTemplate, renderTemplate } from '../src/template.js';
import { createPluginRender, NoPluginFolderError, PLUGINS_DIR, pluginRenderPath, type PluginRender, type RenderConfig } from '../src/plugin-render.js';
import { put, snapshot } from './custom-fixture.js';
import { tempDir } from './temp-dir.js';

// Each workspace's plugin folder (#316): the shipped plugin, the workspace's versions over it, every template rendered for it
const X_TEMPLATE = [
  '---', 'name: x', 'description: X', 'variables:', '  delivery:', '    values: [stacked, single]', '    default: single', '    workspaces:', '      a: stacked', '---',
  '{% if delivery == "stacked" %}A{% else %}B{% endif %}', '',
].join('\n');
const BROKEN_X = '---\nname: x\ndescription: X\n---\n{{ missing }}\n'; // its body starts on line 5; strictVariables refuses it there
const Y_SKILL = '---\nname: y\ndescription: Y\n---\nY.\n';
const DESIGNER = '---\nname: designer\ndescription: Designs.\n---\nYou design.\n';
const EDITED = '---\nname: designer\ndescription: Designs.\n---\nEdited.\n';
const SHIPPED = { '.claude-plugin/plugin.json': '{"name":"hive","version":"0.1.0"}', 'skills/x/SKILL.md.liquid': X_TEMPLATE, 'skills/y/SKILL.md': Y_SKILL, 'agents/designer.md': DESIGNER };

interface Rig { home: string; source: string; codex: string; repo: string; logs: string[]; create(source?: string): PluginRender }

async function rig(t: TestContext, shipped: Record<string, string> = SHIPPED): Promise<Rig> {
  const [home, source, codex, repo] = await Promise.all(['home-', 'plugin-', 'codex-', 'repo-'].map((prefix) => tempDir(t, prefix)));
  await put(source, shipped);
  const logs: string[] = [];
  const create = (from = source): PluginRender => createPluginRender({ home, pluginSource: from, log: { error: (line) => logs.push(line) }, env: { CODEX_HOME: codex } });
  return { home, source, codex, repo, logs, create };
}

const config = (repo: string, ...names: string[]): RenderConfig => ({ comb: { workspaces: names.map((name) => ({ name, path: repo })) } });
const version = (home: string, item: string, name: string, workspaces: string[], files: Record<string, string>, from: string | null = 'original') =>
  put(join(home, 'custom', 'hive', item, name), { 'version.json': JSON.stringify({ name, from, workspaces }), ...Object.fromEntries(Object.entries(files).map(([path, text]) => [`files/${path}`, text])) });
const text = (r: Rig, workspace: string, path: string): Promise<string> => readFile(join(pluginRenderPath(r.home, workspace), path), 'utf8');
const isThere = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

test('pluginRenderPath is <home>/plugins/<encoded name>, and throws for a name that would leave it or take a dot entry\'s place (#316)', () => {
  assert.equal(pluginRenderPath('/h', 'a'), join('/h', PLUGINS_DIR, 'a'));
  for (const name of ['', '.', '..', '.codex', '.tmp-a']) assert.throws(() => pluginRenderPath('/h', name), name);
});

test('with no version and no user item, a workspace\'s folder is the shipped plugin with every template rendered with its defaults, path for path (#316, #317)', async (t) => {
  const r = await rig(t);
  await r.create(pluginSource()).write(config(r.repo, 'a'));
  const shipped = await snapshot(pluginSource());
  assert.ok(Object.keys(shipped).some((path) => path.endsWith('.liquid')), 'the shipped plugin has templates');
  const decode = (bytes: string | undefined): string => Buffer.from(bytes ?? '', 'base64').toString('utf8');
  // #338: a .md whose header has declarations is rendered too, under its own name
  const isTemplate = (path: string, raw: string): boolean => path.endsWith('.liquid') || (path.endsWith('.md') && hasDeclarations(parseTemplate(raw).header));
  const expected = Object.fromEntries(Object.entries(shipped).map(([path, bytes]) => {
    if (!isTemplate(path, decode(bytes))) return [path, bytes];
    const result = renderTemplate(parseTemplate(decode(bytes)), 'a');
    if (!result.ok) return assert.fail(`${path}: ${result.errors[0]?.message}`);
    return [deliveredName(path), Buffer.from(result.text).toString('base64')];
  }));
  const delivered = await snapshot(pluginRenderPath(r.home, 'a'));
  assert.deepEqual(delivered, expected);
  for (const [path, bytes] of Object.entries(delivered)) assert.doesNotMatch(decode(bytes), /^basedOn:/m, `${path} is delivered with its basedOn`);
  // Codex's role reader parses an agent's header line by line: the delivery only takes the basedOn lines out
  const BASED_ON_LINES = /^basedOn:\n(?: {2}- .*\n)+/m;
  for (const path of Object.keys(shipped).filter((p) => p.startsWith('agents/') && p.endsWith('.md'))) {
    assert.equal(decode(delivered[path]), decode(shipped[path]).replace(BASED_ON_LINES, ''), path);
  }
});

test('a SKILL.md.liquid with a conditional reaches each workspace as SKILL.md with its own branch, and no .liquid file is left (#316)', async (t) => {
  const r = await rig(t);
  await r.create().write(config(r.repo, 'a', 'b'));
  assert.ok((await text(r, 'a', 'skills/x/SKILL.md')).endsWith('\n---\nA\n'));
  assert.ok((await text(r, 'b', 'skills/x/SKILL.md')).endsWith('\n---\nB\n'));
  for (const ws of ['a', 'b']) assert.deepEqual((await listFiles(pluginRenderPath(r.home, ws))).filter((p) => p.endsWith('.liquid')), [], ws);
});

test('an agent\'s version replaces agents/<name>.md in its workspace only; a version holding <name>.md.liquid leaves no shipped <name>.md beside the rendered one (#316)', async (t) => {
  const r = await rig(t);
  await version(r.home, 'designer', 'v1', ['a'], { 'designer.md': EDITED });
  await version(r.home, 'designer', 'v2', ['b'], { 'designer.md.liquid': '---\nname: designer\ndescription: Designs.\n---\nFor {{ workspace }}.\n' });
  await r.create().write(config(r.repo, 'a', 'b', 'c'));
  assert.equal(await text(r, 'a', 'agents/designer.md'), EDITED);
  assert.equal(await text(r, 'b', 'agents/designer.md'), '---\nname: designer\ndescription: Designs.\n---\nFor b.\n');
  assert.equal(await isThere(join(pluginRenderPath(r.home, 'b'), 'agents', 'designer.md.liquid')), false);
  assert.equal(await text(r, 'c', 'agents/designer.md'), DESIGNER, 'a workspace no version lists keeps the original');
});

test('a plain .md agent with basedOn is delivered under its own name without it and its body untouched; a plain .md without declarations stays byte for byte; a malformed one is left out (#338, decision 10)', async (t) => {
  const credited = '---\nname: planner\ndescription: Plans.\nmodel: opus\nbasedOn:\n  - { name: a, repo: b, ref: c, license: d, url: e }\n---\nPlan {{ x }}.\n';
  const r = await rig(t, { ...SHIPPED, 'agents/planner.md': credited, 'agents/broken.md': '---\nname: broken\ndescription: B\nbasedOn: x\n---\nB.\n' });
  await r.create().write(config(r.repo, 'a'));
  assert.equal(await text(r, 'a', 'agents/planner.md'), '---\nname: planner\ndescription: Plans.\nmodel: opus\n---\nPlan {{ x }}.\n', 'a .md is not Liquid: its body is delivered as is');
  assert.equal(await text(r, 'a', 'agents/designer.md'), DESIGNER);
  assert.equal(await text(r, 'a', 'skills/y/SKILL.md'), Y_SKILL);
  assert.equal(await isThere(join(pluginRenderPath(r.home, 'a'), 'agents', 'broken.md')), false, 'a .md that does not render is a failed item, as a .liquid one');
  assert.ok(r.logs.some((line) => line.startsWith('plugin render a: agents/broken.md:4 ')), r.logs.join('\n'));
});

test('a user-created skill is delivered to the workspace its version lists, and to no other (#316)', async (t) => {
  const r = await rig(t);
  await version(r.home, 'mine', 'v1', ['a'], { 'SKILL.md': '---\nname: mine\ndescription: Mine\n---\nMine.\n' }, null);
  await r.create().write(config(r.repo, 'a', 'b'));
  assert.equal(await isThere(join(pluginRenderPath(r.home, 'a'), 'skills', 'mine', 'SKILL.md')), true);
  assert.equal(await isThere(join(pluginRenderPath(r.home, 'b'), 'skills', 'mine')), false);
});

test('write(config, [\'a\']) leaves b\'s folder untouched: same inode, same mtime (#316)', async (t) => {
  const r = await rig(t);
  const render = r.create();
  await render.write(config(r.repo, 'a', 'b'));
  const before = await stat(join(pluginRenderPath(r.home, 'b'), 'skills', 'y', 'SKILL.md'));
  await version(r.home, 'designer', 'v1', ['a'], { 'designer.md': EDITED });
  await render.write(config(r.repo, 'a', 'b'), ['a']);
  const after = await stat(join(pluginRenderPath(r.home, 'b'), 'skills', 'y', 'SKILL.md'));
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
  assert.equal(await text(r, 'a', 'agents/designer.md'), EDITED, 'a was rewritten');
});

test('a render error with a previous folder leaves it byte for byte and logs path, line and message, no home path (#316)', async (t) => {
  const r = await rig(t);
  const render = r.create();
  await render.write(config(r.repo, 'a'));
  const kept = await snapshot(pluginRenderPath(r.home, 'a'));
  await put(r.source, { 'skills/x/SKILL.md.liquid': BROKEN_X });
  await render.write(config(r.repo, 'a'), ['a']);
  assert.deepEqual(await snapshot(pluginRenderPath(r.home, 'a')), kept);
  assert.ok(r.logs.some((line) => line.startsWith('plugin render a: skills/x/SKILL.md.liquid:5 ') && line.includes('missing')), r.logs.join('\n'));
  assert.ok(r.logs.every((line) => !line.includes(r.home)), 'no home path in a log line');
});

test('with no previous folder, a failing skill is left out and every other item is written (#316)', async (t) => {
  const r = await rig(t, { ...SHIPPED, 'skills/x/SKILL.md.liquid': BROKEN_X });
  await r.create().write(config(r.repo, 'a'));
  const dir = pluginRenderPath(r.home, 'a');
  assert.equal(await isThere(join(dir, 'skills', 'x')), false);
  assert.equal(await text(r, 'a', 'skills/y/SKILL.md'), Y_SKILL);
  assert.equal(await text(r, 'a', 'agents/designer.md'), DESIGNER);
});

test('dir() throws NoPluginFolderError until a write lands, and for a workspace never written; a launch awaiting ready() after a queued write sees the new folder (#316, #317)', async (t) => {
  const r = await rig(t);
  const render = r.create();
  assert.throws(() => render.dir('a'), NoPluginFolderError);
  void render.write(config(r.repo, 'a'));
  await render.ready();
  assert.equal(render.dir('a'), pluginRenderPath(r.home, 'a'));
  assert.throws(() => render.dir('gone'), { name: 'NoPluginFolderError', message: 'workspace gone has no plugin folder' });
  assert.equal(await text(r, 'a', 'skills/y/SKILL.md'), Y_SKILL);
});

test('a folder an earlier boot left counts as the previous one: dir() answers it before any write, and a failing first write keeps it (#316)', async (t) => {
  const r = await rig(t, { ...SHIPPED, 'skills/x/SKILL.md.liquid': BROKEN_X });
  const dir = pluginRenderPath(r.home, 'a');
  await put(dir, { 'marker.md': 'from an earlier boot' });
  const render = r.create();
  assert.equal(render.dir('a'), dir);
  await render.write(config(r.repo, 'a'));
  assert.equal(await readFile(join(dir, 'marker.md'), 'utf8'), 'from an earlier boot');
});

test('a crash\'s .tmp-a and .old-a are removed by the next write of a (#316)', async (t) => {
  const r = await rig(t);
  const root = join(r.home, PLUGINS_DIR);
  await put(root, { '.tmp-a/half.md': 'x', '.old-a/old.md': 'x' });
  await r.create().write(config(r.repo, 'a'));
  assert.deepEqual([await isThere(join(root, '.tmp-a')), await isThere(join(root, '.old-a'))], [false, false]);
});

test('a full write sweeps a workspace no longer in the config, with its Codex cache and roles; a kept one stays (#316)', async (t) => {
  const r = await rig(t);
  const render = r.create();
  await render.write(config(r.repo, 'a', 'b'));
  const [a, b] = [pluginRenderPath(r.home, 'a'), pluginRenderPath(r.home, 'b')];
  assert.equal(await isThere(pluginCacheDir(r.codex, b)), true, 'b had its copy');
  await render.write(config(r.repo, 'a'));
  assert.equal(await isThere(b), false);
  assert.equal(await isThere(join(r.codex, 'plugins', 'cache', marketplaceName(b))), false);
  assert.equal(await isThere(rolesDir(b)), false);
  assert.throws(() => render.dir('b'), NoPluginFolderError);
  assert.deepEqual([await isThere(a), await isThere(pluginCacheDir(r.codex, a)), await isThere(rolesDir(a))], [true, true, true]);
});

test('a write the catalogue cannot read logs the class only and never rejects (#316)', async (t) => {
  const r = await rig(t);
  await mkdir(join(r.home, 'custom'), { recursive: true });
  await writeFile(join(r.home, 'custom', 'hive'), 'a file where a folder goes'); // readdir of custom/hive throws ENOTDIR
  await r.create().write(config(r.repo, 'a'));
  assert.ok(r.logs.some((line) => /^plugin render: not written \(\w+\)$/.test(line)), r.logs.join('\n'));
});
