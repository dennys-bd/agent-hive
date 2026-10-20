import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeMcpConfig, renderMcpConfig } from '../../src/agents/claude-home.js';
import type { RunMcpServer } from '../../src/agents/runner.js';
import { SECRET } from '../secret-client.js';

// The run's --mcp-config file (#333): the Hive's server for a task's run, then every external server of the run's workspace
const EXTERNAL: RunMcpServer[] = [
  { name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'] },
  { name: 'github', url: 'https://api.githubcopilot.com/mcp/', header: { name: 'Authorization', value: 'Bearer t0k' } },
  { name: 'figma', url: 'http://127.0.0.1:3845/mcp' },
];
const ENTRIES = {
  playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] },
  github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer t0k' } },
  figma: { type: 'http', url: 'http://127.0.0.1:3845/mcp' },
};
const SERVER = { port: 4242, ptyId: 'W1', secret: SECRET, withHive: true, external: EXTERNAL };

test('a task run\'s MCP file holds the Hive\'s server, then every external one: a command as stdio, a URL as http with its header (#333)', () => {
  assert.deepEqual(JSON.parse(claudeMcpConfig(SERVER)), { mcpServers: { ...renderMcpConfig(4242, 'W1', SECRET).mcpServers, ...ENTRIES } });
});

test('a local session\'s file holds only the external servers; with none it lists no server, as before (#333, #587)', () => {
  assert.deepEqual(JSON.parse(claudeMcpConfig({ ...SERVER, withHive: false })), { mcpServers: ENTRIES });
  assert.deepEqual(JSON.parse(claudeMcpConfig({ ...SERVER, withHive: false, external: [] })), { mcpServers: {} });
});
