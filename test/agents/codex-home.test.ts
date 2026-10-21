import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type AgentRole, agentRoles, codexHome, marketplaceName, pluginCacheDir, prepareCodexWorkspace, readAgent, removeCodexWorkspace, renderRole, roleFile, rolesDir, tomlString } from '../../src/agents/codex-home.js';
import { renderedPlugin } from '../rendered-plugin.js';
import { tempDir } from '../temp-dir.js';

// The Hive's plugin in Codex's shape (#934): where Codex reads it, and the role file each agent becomes.
const INSTRUCTIONS_KEY = 'developer_instructions = ';

test('codexHome is CODEX_HOME, else ~/.codex (#934)', () => {
  assert.equal(codexHome({ CODEX_HOME: '/c' }), '/c');
  assert.equal(codexHome({}), join(homedir(), '.codex'));
  assert.equal(codexHome({ CODEX_HOME: '' }), join(homedir(), '.codex'), 'empty is unset');
});

test('a home\'s marketplace is agent-hive- and the first 8 hex of sha256(home): one per home, with no dot for a -c key to split on (#934)', () => {
  assert.equal(marketplaceName('/h'), `agent-hive-${createHash('sha256').update('/h').digest('hex').slice(0, 8)}`);
  assert.match(marketplaceName('/h'), /^agent-hive-[0-9a-f]{8}$/);
  assert.notEqual(marketplaceName('/h'), marketplaceName('/h2'));
});

test('a plugin folder\'s copy goes to its own marketplace\'s cache, its roles to <parent>/.codex/<folder> (#934, #316)', () => {
  assert.equal(pluginCacheDir('/c', '/h/plugins/a'), join('/c', 'plugins', 'cache', marketplaceName('/h/plugins/a'), 'hive', 'current'));
  assert.equal(rolesDir('/h/plugins/a'), '/h/plugins/.codex/a');
  assert.equal(roleFile('/h/plugins/a', 'planner'), '/h/plugins/.codex/a/planner.toml');
});

test('renderRole writes the instructions as one TOML string, and sandbox_mode only for a read-only agent (#934)', () => {
  const role: AgentRole = { name: 'reader', description: 'Reads.', readOnly: true, instructions: '\nSay "hi" to C:\\work\\x.\n\tThen stop.\n' };
  const lines = renderRole(role).split('\n');
  assert.ok(lines[0].startsWith(INSTRUCTIONS_KEY), lines[0]);
  assert.equal(JSON.parse(lines[0].slice(INSTRUCTIONS_KEY.length)), role.instructions, 'quotes, backslashes, tabs and newlines round-trip');
  assert.deepEqual(lines.slice(1), ['sandbox_mode = "read-only"', '']);
  assert.equal(renderRole({ ...role, readOnly: false }), `${INSTRUCTIONS_KEY}${tomlString(role.instructions)}\n`, 'a writing agent: no sandbox key');
});

const AGENT_NAMES = ['architect', 'build-fixer', 'code-reviewer', 'decomposition-reviewer', 'design-reviewer', 'designer', 'plan-reviewer', 'planner', 'security-reviewer', 'spec-reviewer', 'tdd', 'template-reviewer'];
const RENDERED = await renderedPlugin({ after }); // #416: assets/plugin holds designer.md.liquid; a run reads the delivered designer.md

test('readAgent keeps name, description and the body verbatim, a --- line in the body included; it stops at the second --- (#934)', () => {
  const text = ['---', 'name: fixer', 'description: Fixes: the build.', 'tools: Read, Write', 'model: sonnet', '---', '', 'Body.', '', '---', '', 'After the rule.', ''].join('\n');
  assert.deepEqual(readAgent('fixer.md', text), { name: 'fixer', description: 'Fixes: the build.', readOnly: false, instructions: '\nBody.\n\n---\n\nAfter the rule.\n' });
});

test('an agent is read-only when its tools have none of Write, Edit, Bash; a tool Codex lacks (Agent) is dropped; no tools list writes (#934)', () => {
  const agent = (tools: string | undefined): string => ['---', 'name: a', 'description: d.', ...(tools === undefined ? [] : [`tools: ${tools}`]), '---', 'x'].join('\n');
  assert.equal(readAgent('a.md', agent('Read, Grep, Glob')).readOnly, true);
  assert.equal(readAgent('a.md', agent('Read, Agent')).readOnly, true);
  assert.equal(readAgent('a.md', agent('Read, Grep, Glob, Bash')).readOnly, false);
  assert.equal(readAgent('a.md', agent('Edit')).readOnly, false);
  assert.equal(readAgent('a.md', agent(undefined)).readOnly, false, 'Claude gives an agent with no tools list every tool');
});

test('readAgent names the file it cannot read: no frontmatter, an unclosed one, no name or no description (#934)', () => {
  assert.throws(() => readAgent('x.md', 'no fence\n'), /x\.md/);
  assert.throws(() => readAgent('x.md', '---\nname: x\n'), /x\.md/);
  assert.throws(() => readAgent('x.md', '---\ndescription: d.\n---\nbody'), /x\.md/);
  assert.throws(() => readAgent('x.md', '---\nname: x\n---\nbody'), /x\.md/);
});

test('readAgent refuses a name that would escape the roles folder or split a -c key, and reads a CRLF file (#934)', () => {
  for (const name of ['../x', 'a.b', 'a=b', 'A']) assert.throws(() => readAgent('x.md', `---\nname: ${name}\ndescription: d.\n---\nbody`), /x\.md/);
  assert.equal(readAgent('x.md', '---\r\nname: x\r\ndescription: d.\r\n---\r\nbody').name, 'x');
});

test('agentRoles reads the twelve agents of the delivered plugin in name order: five read-only, every body whole (#934, #416)', () => {
  const roles = agentRoles(RENDERED);
  assert.deepEqual(roles.map((r) => r.name), AGENT_NAMES);
  assert.deepEqual(roles.filter((r) => r.readOnly).map((r) => r.name), ['architect', 'decomposition-reviewer', 'plan-reviewer', 'spec-reviewer', 'template-reviewer']);
  for (const name of ['build-fixer', 'security-reviewer']) {
    assert.ok(roles.find((r) => r.name === name)?.instructions.includes('\n---\n'), `${name} keeps its body's --- line`);
  }
  assert.ok(roles.find((r) => r.name === 'build-fixer')?.instructions.trimEnd().endsWith('Speed and precision over perfection.'));
  assert.equal(roles.some((r) => /^(model|tools|name): /m.test(r.instructions.split('\n---\n')[0] ?? '')), false, 'no frontmatter line leaks into a body');
});

test('renderRole: architect gets sandbox_mode, tdd none (#934)', () => {
  const roles = agentRoles(RENDERED);
  const role = (name: string): AgentRole => roles.find((r) => r.name === name) ?? assert.fail(name);
  assert.ok(renderRole(role('architect')).endsWith('\nsandbox_mode = "read-only"\n'));
  assert.equal(renderRole(role('tdd')).includes('sandbox_mode'), false);
});

const SKILLS = ['decomposition', 'new-build', 'new-plan', 'new-pr', 'new-spec'];
const USER_CONFIG = 'model = "theirs"\n';
const USER_SKILL = 'their own skill\n';

// A CODEX_HOME as a user has it: their config.toml and a skill of their own, which no boot may touch
async function userCodexHome(t: Parameters<typeof tempDir>[0]): Promise<string> {
  const dir = await tempDir(t, 'codex-');
  await writeFile(join(dir, 'config.toml'), USER_CONFIG);
  await mkdir(join(dir, 'skills', 'mine'), { recursive: true });
  await writeFile(join(dir, 'skills', 'mine', 'SKILL.md'), USER_SKILL);
  return dir;
}

// A workspace's plugin folder as the render leaves it: here the shipped plugin, under <home>/plugins/<name>
async function workspaceFolder(home: string, name: string): Promise<string> {
  const dir = join(home, 'plugins', name);
  await cp(RENDERED, dir, { recursive: true });
  return dir;
}

test('prepareCodexWorkspace copies the folder into its marketplace\'s cache and writes one role per agent under rolesDir; config.toml and skills/ stay (#934, #316)', async (t) => {
  const codex = await userCodexHome(t);
  const dir = await workspaceFolder(await tempDir(t, 'home-'), 'a');
  await prepareCodexWorkspace(dir, { CODEX_HOME: codex });
  const cache = pluginCacheDir(codex, dir);
  assert.deepEqual((await readdir(join(cache, 'skills'))).sort(), SKILLS);
  for (const skill of SKILLS) {
    assert.equal(await readFile(join(cache, 'skills', skill, 'SKILL.md'), 'utf8'), await readFile(join(dir, 'skills', skill, 'SKILL.md'), 'utf8'), skill);
  }
  assert.deepEqual((await readdir(rolesDir(dir))).sort(), AGENT_NAMES.map((name) => `${name}.toml`));
  for (const role of agentRoles(dir)) assert.equal(await readFile(roleFile(dir, role.name), 'utf8'), renderRole(role), role.name);
  assert.equal(await readFile(join(codex, 'config.toml'), 'utf8'), USER_CONFIG);
  assert.deepEqual(await readdir(join(codex, 'skills')), ['mine']);
  assert.equal(await readFile(join(codex, 'skills', 'mine', 'SKILL.md'), 'utf8'), USER_SKILL);
  assert.deepEqual((await readdir(codex)).sort(), ['config.toml', 'plugins', 'skills'], 'nothing else written under CODEX_HOME');
});

test('a second prepare replaces what the first left in the cache and in the roles: a file the folder no longer has goes (#934, #316)', async (t) => {
  const codex = await userCodexHome(t);
  const dir = await workspaceFolder(await tempDir(t, 'home-'), 'a');
  await prepareCodexWorkspace(dir, { CODEX_HOME: codex });
  const cache = pluginCacheDir(codex, dir);
  await writeFile(join(cache, 'stale.md'), 'old');
  await writeFile(roleFile(dir, 'gone'), 'old');
  await prepareCodexWorkspace(dir, { CODEX_HOME: codex });
  assert.equal((await readdir(cache)).includes('stale.md'), false);
  assert.equal((await readdir(rolesDir(dir))).includes('gone.toml'), false);
  assert.deepEqual((await readdir(join(cache, 'skills'))).sort(), SKILLS);
});

test('two workspaces get two marketplaces; one\'s prepare leaves the other\'s copy, and removing one leaves the other whole (#934, #316)', async (t) => {
  const codex = await userCodexHome(t);
  const home = await tempDir(t, 'home-');
  const [a, b] = [await workspaceFolder(home, 'a'), await workspaceFolder(home, 'b')];
  await prepareCodexWorkspace(a, { CODEX_HOME: codex });
  await prepareCodexWorkspace(b, { CODEX_HOME: codex });
  await prepareCodexWorkspace(a, { CODEX_HOME: codex });
  assert.notEqual(marketplaceName(a), marketplaceName(b));
  assert.deepEqual((await readdir(join(codex, 'plugins', 'cache'))).sort(), [marketplaceName(a), marketplaceName(b)].sort());
  assert.deepEqual((await readdir(join(pluginCacheDir(codex, b), 'skills'))).sort(), SKILLS);
  await removeCodexWorkspace(a, { CODEX_HOME: codex });
  assert.deepEqual(await readdir(join(codex, 'plugins', 'cache')), [marketplaceName(b)]);
  assert.deepEqual(await readdir(join(home, 'plugins', '.codex')), ['b'], 'a\'s roles went with it');
});
