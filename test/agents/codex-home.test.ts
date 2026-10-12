import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type AgentRole, agentRoles, codexHome, marketplaceName, pluginCacheDir, prepareCodexHome, readAgent, renderRole, roleFile, tomlString } from '../../src/agents/codex-home.js';
import { pluginSource } from '../../src/hooks-settings.js';
import { tempDir } from '../temp-dir.js';

// The Hive's plugin in Codex's shape (#934): where Codex reads it, and the role file each agent becomes.
const INSTRUCTIONS_KEY = 'developer_instructions = ';

test('codexHome is CODEX_HOME, else ~/.codex (#934)', () => {
  assert.equal(codexHome({ CODEX_HOME: '/c' }), '/c');
  assert.equal(codexHome({}), join(homedir(), '.codex'));
});

test('a home\'s marketplace is agent-hive- and the first 8 hex of sha256(home): one per home, with no dot for a -c key to split on (#934)', () => {
  assert.equal(marketplaceName('/h'), `agent-hive-${createHash('sha256').update('/h').digest('hex').slice(0, 8)}`);
  assert.match(marketplaceName('/h'), /^agent-hive-[0-9a-f]{8}$/);
  assert.notEqual(marketplaceName('/h'), marketplaceName('/h2'));
});

test('the plugin goes to <codexHome>/plugins/cache/<marketplace>/hive/current, a role to <home>/codex/agents/<name>.toml (#934)', () => {
  assert.equal(pluginCacheDir('/c', '/h'), join('/c', 'plugins', 'cache', marketplaceName('/h'), 'hive', 'current'));
  assert.equal(roleFile('/h', 'planner'), '/h/codex/agents/planner.toml');
});

test('renderRole writes the instructions as one TOML string, and sandbox_mode only for a read-only agent (#934)', () => {
  const role: AgentRole = { name: 'reader', description: 'Reads.', readOnly: true, instructions: '\nSay "hi" to C:\\work\\x.\n\tThen stop.\n' };
  const lines = renderRole(role).split('\n');
  assert.ok(lines[0].startsWith(INSTRUCTIONS_KEY), lines[0]);
  assert.equal(JSON.parse(lines[0].slice(INSTRUCTIONS_KEY.length)), role.instructions, 'quotes, backslashes, tabs and newlines round-trip');
  assert.deepEqual(lines.slice(1), ['sandbox_mode = "read-only"', '']);
  assert.equal(renderRole({ ...role, readOnly: false }), `${INSTRUCTIONS_KEY}${tomlString(role.instructions)}\n`, 'a writing agent: no sandbox key');
});

const AGENT_NAMES = ['architect', 'build-fixer', 'code-reviewer', 'design-reviewer', 'designer', 'plan-reviewer', 'planner', 'security-reviewer', 'spec-reviewer', 'tdd'];

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

test('agentRoles reads the ten agents of assets/plugin in name order: three read-only, every body whole (#934)', () => {
  const roles = agentRoles(pluginSource());
  assert.deepEqual(roles.map((r) => r.name), AGENT_NAMES);
  assert.deepEqual(roles.filter((r) => r.readOnly).map((r) => r.name), ['architect', 'plan-reviewer', 'spec-reviewer']);
  for (const name of ['build-fixer', 'security-reviewer']) {
    assert.ok(roles.find((r) => r.name === name)?.instructions.includes('\n---\n'), `${name} keeps its body's --- line`);
  }
  assert.ok(roles.find((r) => r.name === 'build-fixer')?.instructions.trimEnd().endsWith('Speed and precision over perfection.'));
  assert.equal(roles.some((r) => /^(model|tools|name): /m.test(r.instructions.split('\n---\n')[0] ?? '')), false, 'no frontmatter line leaks into a body');
});

test('renderRole: architect gets sandbox_mode, tdd none (#934)', () => {
  const roles = agentRoles(pluginSource());
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

test('prepareCodexHome copies the five skills into Codex\'s cache and writes one role per agent; config.toml and skills/ stay as they were (#934)', async (t) => {
  const codex = await userCodexHome(t);
  const home = await tempDir(t, 'home-');
  await prepareCodexHome(home, { CODEX_HOME: codex });
  const cache = pluginCacheDir(codex, home);
  assert.deepEqual((await readdir(join(cache, 'skills'))).sort(), SKILLS);
  for (const skill of SKILLS) {
    assert.equal(await readFile(join(cache, 'skills', skill, 'SKILL.md'), 'utf8'), await readFile(join(pluginSource(), 'skills', skill, 'SKILL.md'), 'utf8'), skill);
  }
  assert.deepEqual((await readdir(join(home, 'codex', 'agents'))).sort(), AGENT_NAMES.map((name) => `${name}.toml`));
  for (const role of agentRoles(pluginSource())) assert.equal(await readFile(roleFile(home, role.name), 'utf8'), renderRole(role), role.name);
  assert.equal(await readFile(join(codex, 'config.toml'), 'utf8'), USER_CONFIG);
  assert.deepEqual(await readdir(join(codex, 'skills')), ['mine']);
  assert.equal(await readFile(join(codex, 'skills', 'mine', 'SKILL.md'), 'utf8'), USER_SKILL);
  assert.deepEqual((await readdir(codex)).sort(), ['config.toml', 'plugins', 'skills'], 'nothing else written under CODEX_HOME');
});

test('a second boot replaces what the first left in the cache and in the roles: a file the plugin no longer has goes (#934)', async (t) => {
  const codex = await userCodexHome(t);
  const home = await tempDir(t, 'home-');
  await prepareCodexHome(home, { CODEX_HOME: codex });
  const cache = pluginCacheDir(codex, home);
  await writeFile(join(cache, 'stale.md'), 'old');
  await writeFile(roleFile(home, 'gone'), 'old');
  await prepareCodexHome(home, { CODEX_HOME: codex });
  assert.equal((await readdir(cache)).includes('stale.md'), false);
  assert.equal((await readdir(join(home, 'codex', 'agents'))).includes('gone.toml'), false);
  assert.deepEqual((await readdir(join(cache, 'skills'))).sort(), SKILLS);
});

test('two homes on one CODEX_HOME get two marketplaces, and one\'s boot leaves the other\'s copy (#934)', async (t) => {
  const codex = await userCodexHome(t);
  const [one, two] = [await tempDir(t, 'home-'), await tempDir(t, 'home-')];
  await prepareCodexHome(one, { CODEX_HOME: codex });
  await prepareCodexHome(two, { CODEX_HOME: codex });
  await prepareCodexHome(one, { CODEX_HOME: codex });
  assert.notEqual(marketplaceName(one), marketplaceName(two));
  assert.deepEqual((await readdir(join(codex, 'plugins', 'cache'))).sort(), [marketplaceName(one), marketplaceName(two)].sort());
  assert.deepEqual((await readdir(join(pluginCacheDir(codex, two), 'skills'))).sort(), SKILLS);
});
