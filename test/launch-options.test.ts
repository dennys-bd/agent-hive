import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { CLAUDE_ALIASES, CLAUDE_VERSIONS } from '../src/agents/claude-models.js';
import { PLUGIN_DIR, pluginSource } from '../src/hooks-settings.js';
import { launchRun, parseCodexModels, registerLaunchOptionsRoute, specializedAgents } from '../src/launch-options.js';
import { createPluginRender, type PluginRender } from '../src/plugin-render.js';
import type { TaskRouteDeps } from '../src/server-tasks.js';
import type { Exec, LaunchOptions } from '../src/types.js';
import { put } from './custom-fixture.js';
import { send, settingsBody, startReviews } from './review-server.js';
import { tempDir } from './temp-dir.js';

// #257: what the new session dialog lists, read each time it opens
const CODEX_MODELS = JSON.stringify({ models: [
  { slug: 'gpt-hidden', display_name: 'GPT hidden', visibility: 'hide' },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list' },
] });
// git answers nothing; `codex debug models` answers `codex()`
const withCodex = (codex: () => string): Exec => async (file) => ({ stdout: file === 'codex' ? codex() : '' });

test('parseCodexModels lists visible slugs first, hidden after, display_name as the hint; an entry with no usable slug drops (#257)', () => {
  const stdout = JSON.stringify({ models: [
    { slug: 'gpt-old', display_name: 'GPT old', visibility: 'hide' },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list' },
    { slug: '-bad', visibility: 'list' },
    { display_name: 'no slug' },
    { slug: 'gpt-5.6-terra-mini', display_name: 'gpt-5.6-terra-mini', visibility: 'list' },
  ] });
  assert.deepEqual(parseCodexModels(stdout), [{ id: 'gpt-5.6-terra', hint: 'GPT-5.6 Terra' }, { id: 'gpt-5.6-terra-mini' }, { id: 'gpt-old', hint: 'GPT old' }]);
  assert.deepEqual(parseCodexModels(JSON.stringify([{ slug: 'gpt-x' }])), [{ id: 'gpt-x' }], 'a bare list reads too');
  assert.throws(() => parseCodexModels('not json'));
});

test('specializedAgents lists the Hive plugin\'s agents as hive:<name>, sorted by file, with the body Codex gets (#257)', () => {
  const agents = specializedAgents(pluginSource());
  assert.ok(agents.length > 0);
  assert.ok(agents.every((a) => a.name.startsWith('hive:') && a.description !== '' && a.instructions !== ''));
  assert.ok(agents.some((a) => a.name === 'hive:designer'));
});

test('GET /launch-options lists Claude\'s hand-kept models, Codex\'s in visible-then-hidden order, the plugin\'s agents for both and each agent\'s config args (#257)', async (t) => {
  const { base } = await startReviews(t, { exec: withCodex(() => CODEX_MODELS) });
  const { workspaces: _saved, ...rest } = settingsBody('');
  const agentArgs = { claude: ['--permission-mode', 'auto'], codex: ['--sandbox', 'workspace-write'] };
  assert.equal((await send(base, 'POST', '/settings', { ...rest, agentArgs })).status, 200, 'an API save that omits workspaces keeps them');
  const res = await send(base, 'GET', '/launch-options');
  assert.equal(res.status, 200);
  const options = (await res.json()) as LaunchOptions;
  assert.deepEqual([options.claude.aliases, options.claude.versions], [[...CLAUDE_ALIASES], [...CLAUDE_VERSIONS]]);
  assert.deepEqual([options.codex.aliases, options.codex.versions.map((m) => m.id)], [[], ['gpt-5.6-terra', 'gpt-hidden']]);
  const agents = specializedAgents(pluginSource()).map(({ name, description }) => ({ name, description }));
  assert.deepEqual([options.claude.specializedAgents, options.codex.specializedAgents], [agents, agents]);
  assert.deepEqual([options.claude.args, options.codex.args], [agentArgs.claude, agentArgs.codex]);
});

test('a codex debug models that fails or prints no JSON gives Codex no models and still answers 200 (#257)', async (t) => {
  for (const codex of [() => { throw new Error('codex: command not found'); }, () => 'Usage: codex debug'] as const) {
    const { base } = await startReviews(t, { exec: withCodex(codex) });
    const res = await send(base, 'GET', '/launch-options');
    assert.equal(res.status, 200);
    const options = (await res.json()) as LaunchOptions;
    assert.deepEqual(options.codex.versions, []);
    assert.deepEqual(options.claude.versions, [...CLAUDE_VERSIONS]);
  }
});

test('launchRun puts the config\'s args before the session\'s, the model, and the agent with its instructions; no picks adds only the config\'s (#257)', () => {
  const roles = () => [{ name: 'hive:designer', description: 'Designs.', instructions: 'Design.' }];
  assert.deepEqual(launchRun({ model: 'opus', specializedAgent: 'hive:designer', args: ['--verbose'] }, ['--permission-mode', 'auto'], roles), {
    model: 'opus', extraArgs: ['--permission-mode', 'auto', '--verbose'], specializedAgent: { name: 'hive:designer', instructions: 'Design.' },
  });
  assert.deepEqual(launchRun(undefined, ['--permission-mode', 'auto'], roles), { extraArgs: ['--permission-mode', 'auto'] });
  assert.deepEqual(launchRun({ model: '--settings', args: ['ok'] }, [], roles), { extraArgs: ['ok'] }, 'a value out of shape never reaches the argv');
});

test('launchRun refuses an agent the plugin no longer has, or a plugin it cannot read, naming why (#257)', () => {
  const roles = () => [{ name: 'hive:designer', description: 'Designs.', instructions: 'Design.' }];
  assert.deepEqual(launchRun({ specializedAgent: 'hive:gone' }, [], roles), { refusal: 'specialized agent hive:gone is no longer in the Hive plugin' });
  const broken = (): never => { throw new Error('designer.md: no frontmatter between two --- lines'); };
  assert.deepEqual(launchRun({ specializedAgent: 'hive:designer' }, [], broken), { refusal: 'the Hive plugin\'s agents could not be read: designer.md: no frontmatter between two --- lines' });
});

const HELPER = '---\nname: helper\ndescription: Helps.\n---\nHelp.\n';
const EDITED = '---\nname: designer\ndescription: Designs.\n---\nEdited.\n';

// A home whose render delivered a user-created agent (helper) and an edited designer to workspace a only, with the boot's fallback copy
async function renderedHome(t: TestContext): Promise<{ render: PluginRender; workspaces: { name: string; path: string }[] }> {
  const [home, repo, codex] = await Promise.all(['home-', 'repo-', 'codex-'].map((prefix) => tempDir(t, prefix)));
  await cp(pluginSource(), join(home, PLUGIN_DIR), { recursive: true });
  await put(join(home, 'custom', 'hive'), {
    'helper/v1/version.json': JSON.stringify({ name: 'v1', from: null, workspaces: ['a'] }),
    'helper/v1/files/helper.md': HELPER,
    'designer/v1/version.json': JSON.stringify({ name: 'v1', from: 'original', workspaces: ['a'] }),
    'designer/v1/files/designer.md': EDITED,
  });
  const workspaces = [{ name: 'a', path: repo }, { name: 'b', path: repo }];
  const render = createPluginRender({ home, pluginSource: pluginSource(), log: { error: () => undefined }, env: { CODEX_HOME: codex } });
  await render.write({ comb: { workspaces } });
  return { render, workspaces };
}

test('GET /launch-options?workspace= lists the agents delivered to that workspace; an unknown workspace, or none, lists the fallback\'s (#316)', async (t) => {
  const { render, workspaces } = await renderedHome(t);
  const app = express();
  registerLaunchOptionsRoute(app, {
    requireLive: (() => ({ runtime: { config: { agentArgs: { claude: [], codex: [] }, comb: { workspaces } } } })) as unknown as TaskRouteDeps['requireLive'],
    exec: async () => ({ stdout: '[]' }),
    log: { info: () => undefined, error: () => undefined, debug: () => undefined },
    language: () => 'en',
    plugin: render,
  });
  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const names = async (query: string): Promise<string[]> =>
    ((await (await fetch(`${base}/launch-options${query}`)).json()) as LaunchOptions).claude.specializedAgents.map((a) => a.name);
  assert.ok((await names('?workspace=a')).includes('hive:helper'));
  for (const query of ['?workspace=b', '', '?workspace=gone']) {
    const listed = await names(query);
    assert.equal(listed.includes('hive:helper'), false, query);
    assert.ok(listed.includes('hive:designer'), query);
  }
});

test('launchRun over a workspace folder\'s agents gives Codex the delivered body of an edited agent; another workspace gets the shipped one (#316)', async (t) => {
  const { render } = await renderedHome(t);
  const edited = launchRun({ specializedAgent: 'hive:designer' }, [], () => specializedAgents(render.dir('a')));
  assert.deepEqual('refusal' in edited ? edited : edited.specializedAgent, { name: 'hive:designer', instructions: 'Edited.\n' });
  const shipped = launchRun({ specializedAgent: 'hive:designer' }, [], () => specializedAgents(render.dir('b')));
  assert.notEqual('refusal' in shipped ? undefined : shipped.specializedAgent?.instructions, 'Edited.\n');
});
