import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type AgentRole, codexHome, marketplaceName, pluginCacheDir, renderRole, roleFile, tomlString } from '../../src/agents/codex-home.js';

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
