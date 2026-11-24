import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateWorkspaceVariables } from '../src/plugin-variables-migrate.js';
import { put, snapshot } from './custom-fixture.js';
import { tempDir } from './temp-dir.js';

// The boot migration of #621 (decisions 7 to 10) over a temp home: a shipped plugin of three skills that declare specsDir, versions of them
// in the custom store, and a checkout
const skill = (name: string, declaration: string): string => `---\nname: ${name}\ndescription: ${name}\nvariables:\n  specsDir: ${declaration}\n---\n{{ specsDir }}\n`;
const SHIPPED = (name: string): string => skill(name, '{ default: docs/hive/specs }');
const valued = (name: string, values: Record<string, string>): string =>
  skill(name, `{ default: docs/hive/specs, workspaces: { ${Object.entries(values).map(([w, v]) => `${w}: ${v}`).join(', ')} } }`);

interface Rig { home: string; repo: string; lines: string[]; migrate(raw?: unknown): Promise<unknown> }
type Raw = { comb: { workspaces: { variables?: unknown }[] } };

async function rig(t: TestContext, names: readonly string[] = ['app']): Promise<Rig> {
  const [home, plugin, repo] = await Promise.all(['vars-home-', 'vars-plugin-', 'vars-repo-'].map((prefix) => tempDir(t, prefix)));
  await put(plugin, { '.claude-plugin/plugin.json': '{"name":"hive","version":"0.1.0"}', ...Object.fromEntries(['a', 'b', 'c'].map((n) => [`skills/${n}/SKILL.md.liquid`, SHIPPED(n)])) });
  const raw = { comb: { prefix: 'HIVE', workspaces: names.map((name) => ({ name, path: repo })) } };
  await writeFile(join(home, 'hive.config.json'), JSON.stringify(raw));
  const lines: string[] = [];
  const log = { info: (line: string) => void lines.push(line), error: (line: string) => void lines.push(`error: ${line}`) };
  return { home, repo, lines, migrate: (given = raw) => migrateWorkspaceVariables(given, { home, pluginSource: plugin, log }) };
}

const storeDir = (r: Rig, item: string, name: string): string => join(r.home, 'custom', 'hive', item, name);
// A version of skill `item` in the store: version.json, its file, and the base it was made from (the shipped text)
const version = (r: Rig, item: string, name: string, workspaces: string[], text: string, from: string | null = 'original'): Promise<void> =>
  put(storeDir(r, item, name), { 'version.json': JSON.stringify({ name, from, workspaces }), 'files/SKILL.md.liquid': text, 'base/SKILL.md.liquid': SHIPPED(item) });
const fileOf = (r: Rig, item: string, name: string): Promise<string> => readFile(join(storeDir(r, item, name), 'files', 'SKILL.md.liquid'), 'utf8');
const workspacesOf = async (r: Rig, item: string, name: string): Promise<string[]> =>
  (JSON.parse(await readFile(join(storeDir(r, item, name), 'version.json'), 'utf8')) as { workspaces: string[] }).workspaces;
const savedVariables = async (r: Rig): Promise<unknown[]> =>
  (JSON.parse(await readFile(join(r.home, 'hive.config.json'), 'utf8')) as Raw).comb.workspaces.map((w) => w.variables);

test('a value one version holds moves to the workspace and leaves the template; the version, now its base byte for byte, goes back to the original and stays in the store (#621, decisions 7 to 10)', async (t) => {
  const r = await rig(t);
  await version(r, 'a', 'mine', ['app'], valued('a', { app: 'design/specs' }));
  const next = (await r.migrate()) as Raw;
  assert.deepEqual(next.comb.workspaces.map((w) => w.variables), [{ specsDir: 'design/specs' }]);
  assert.deepEqual(await savedVariables(r), [{ specsDir: 'design/specs' }]);
  assert.equal(await fileOf(r, 'a', 'mine'), SHIPPED('a'));
  assert.deepEqual(await workspacesOf(r, 'a', 'mine'), [], 'the version stays, assigned to nothing');
  assert.deepEqual(r.lines, [
    'migrated variable specsDir of app to the workspace: design/specs',
    "b/SKILL.md.liquid now renders the workspace's specsDir for app",
    "c/SKILL.md.liquid now renders the workspace's specsDir for app",
    "a back on the Hive's original for app",
  ]);
});

test('the most common value moves and a divergent one stays as that template\'s override; a tie takes the first item in catalogue order (#621, decision 8)', async (t) => {
  const r = await rig(t, ['app', 'site']);
  await version(r, 'a', 'mine', ['app', 'site'], valued('a', { app: 'x/specs', site: 'one' }));
  await version(r, 'b', 'mine', ['app', 'site'], valued('b', { app: 'y/specs', site: 'two' }));
  await version(r, 'c', 'mine', ['app'], valued('c', { app: 'y/specs' }));
  await r.migrate();
  assert.deepEqual(await savedVariables(r), [{ specsDir: 'y/specs' }, { specsDir: 'one' }]);
  assert.equal(await fileOf(r, 'a', 'mine'), valued('a', { app: 'x/specs' }), 'a keeps app\'s divergent value; site\'s equal one went');
  assert.equal(await fileOf(r, 'b', 'mine'), valued('b', { site: 'two' }));
  assert.equal(await fileOf(r, 'c', 'mine'), SHIPPED('c'));
  assert.ok(r.lines.includes('kept specsDir of app as an override in a/SKILL.md.liquid'));
  assert.ok(r.lines.includes('kept specsDir of site as an override in b/SKILL.md.liquid'));
  assert.deepEqual(await Promise.all([workspacesOf(r, 'a', 'mine'), workspacesOf(r, 'b', 'mine'), workspacesOf(r, 'c', 'mine')]), [['app', 'site'], ['app', 'site'], []]);
});

test('a version whose text still differs from its base, or made from another version or from nothing, keeps the workspace (#621, decision 9)', async (t) => {
  const r = await rig(t);
  await version(r, 'a', 'mine', ['app'], valued('a', { app: 'd/specs' }).replace('{{ specsDir }}', 'Read {{ specsDir }}.'));
  await version(r, 'b', 'tuned', ['app'], valued('b', { app: 'd/specs' }), 'mine');
  await version(r, 'c', 'mine', ['app'], valued('c', { app: 'd/specs' }), null);
  await r.migrate();
  assert.deepEqual(await savedVariables(r), [{ specsDir: 'd/specs' }]);
  assert.equal(await fileOf(r, 'b', 'tuned'), SHIPPED('b'), 'the value left all the same');
  assert.deepEqual(await Promise.all([workspacesOf(r, 'a', 'mine'), workspacesOf(r, 'b', 'tuned'), workspacesOf(r, 'c', 'mine')]), [['app'], ['app'], ['app']]);
});

test('a version whose header the old panel rewrote through yaml still goes back to the original once its value left: the header compares by its data, the body by its text (#621, decision 9)', async (t) => {
  const r = await rig(t);
  const header = (description: string, list: string, specsDir: string): string => `---\nname: a\ndescription: ${description}\nlevels: ${list}\nvariables:\n  specsDir: ${specsDir}\n---\n{{ specsDir }}\n`;
  const base = header('a ', '[none, always]', '{ default: docs/hive/specs }');
  await put(storeDir(r, 'a', 'mine'), {
    'version.json': JSON.stringify({ name: 'mine', from: 'original', workspaces: ['app'] }),
    'files/SKILL.md.liquid': header('a', '[ none, always ]', '{ default: docs/hive/specs, workspaces: { app: design/specs } }'),
    'base/SKILL.md.liquid': base,
  });
  await version(r, 'b', 'mine', ['app'], valued('b', { app: 'design/specs' }).replace('{{ specsDir }}\n', '{{ specsDir }} \n'));
  await r.migrate();
  assert.deepEqual(await savedVariables(r), [{ specsDir: 'design/specs' }]);
  assert.deepEqual(await workspacesOf(r, 'a', 'mine'), [], 'a header equal in data is the base\'s');
  assert.deepEqual(await workspacesOf(r, 'b', 'mine'), ['app'], 'a body that differs, by one space, is not');
});

test('a config whose workspaces all have variables comes back as given, and nothing is read or written (#621, decision 7)', async (t) => {
  const r = await rig(t);
  await version(r, 'a', 'mine', ['app'], valued('a', { app: 'design/specs' }));
  const raw = { comb: { workspaces: [{ name: 'app', path: r.repo, variables: {} }] } };
  const before = await snapshot(r.home);
  assert.equal(await r.migrate(raw), raw);
  assert.deepEqual(await snapshot(r.home), before);
  assert.deepEqual(r.lines, []);
});

test('the config is written before any template: when it cannot be, every template keeps its values and the boot runs on the moved ones (#621, decision 7)', async (t) => {
  const r = await rig(t);
  await version(r, 'a', 'mine', ['app'], valued('a', { app: 'design/specs' }));
  await mkdir(join(r.home, 'hive.config.json.tmp')); // the write's temp path taken by a folder, on every OS
  const next = (await r.migrate()) as Raw;
  assert.deepEqual(next.comb.workspaces.map((w) => w.variables), [{ specsDir: 'design/specs' }]);
  assert.equal(await fileOf(r, 'a', 'mine'), valued('a', { app: 'design/specs' }));
  assert.deepEqual(await workspacesOf(r, 'a', 'mine'), ['app']);
  assert.ok(r.lines.some((line) => line.startsWith('error: variables migration: hive.config.json not written')), r.lines.join('\n'));
});

test('a version whose template does not parse is logged and left as it is, its value not counted; the others still migrate (#621, decision 10)', async (t) => {
  const r = await rig(t);
  const broken = '---\nname: a\nvariables:\n  specsDir: { default: 3, workspaces: { app: other } }\n---\n{{ specsDir }}\n';
  await version(r, 'a', 'mine', ['app'], broken);
  await version(r, 'b', 'mine', ['app'], valued('b', { app: 'design/specs' }));
  await r.migrate();
  assert.deepEqual(await savedVariables(r), [{ specsDir: 'design/specs' }]);
  assert.equal(await fileOf(r, 'a', 'mine'), broken);
  assert.deepEqual(await workspacesOf(r, 'a', 'mine'), ['app']);
  assert.ok(r.lines.includes('error: variables migration: a/SKILL.md.liquid for app does not parse (line 4); a version mine is left as it is'), r.lines.join('\n'));
});

test('a .claude/ item of the checkout is never read for a value nor written (#621, decision 8a)', async (t) => {
  const r = await rig(t);
  await put(r.repo, { '.claude/skills/own/SKILL.md.liquid': valued('own', { app: 'local/specs' }) });
  const before = await snapshot(r.repo);
  await r.migrate();
  assert.deepEqual(await savedVariables(r), [{}]);
  assert.deepEqual(await snapshot(r.repo), before);
});
