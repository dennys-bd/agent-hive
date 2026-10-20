import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcp, serversFor } from '../src/mcp-settings.js';
import { MCP_DEFAULTS, type McpSettings } from '../src/types.js';

// The mcp key (#333): the parse in the shape of reviewer-config.ts (the key, or the first problem as a sentence), and a run's servers
const WORKSPACES = ['hive', 'hive-site'];
const EXAMPLE = {
  off: ['hive_remember'],
  servers: [
    { name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'], workspace: null, on: true },
    { name: 'github', url: 'https://api.githubcopilot.com/mcp/', authHeader: 'Authorization', workspace: null, on: true },
    { name: 'figma', url: 'http://127.0.0.1:3845/mcp', workspace: 'hive-site', on: false },
  ],
};
const ONE = { name: 'docs', url: 'https://mcp.example.com/mcp', workspace: null, on: true };
const at = (servers: unknown[], off: unknown = []): McpSettings | string => parseMcp({ off, servers }, WORKSPACES);
const NAME = '"mcp.servers[0].name" must be 1 to 32 lowercase letters, digits, _ or -, start with a letter, and not be hive';
const URL_MESSAGE = '"mcp.servers[0].url" must be an http or https URL';

test('parseMcp accepts the spec\'s example as written, a command\'s args default to [] and a repeat in off is dropped (#333)', () => {
  assert.deepEqual(parseMcp(EXAMPLE, WORKSPACES), EXAMPLE);
  assert.deepEqual(parseMcp(MCP_DEFAULTS, WORKSPACES), MCP_DEFAULTS);
  assert.deepEqual(at([{ name: 'x', command: 'mcp-x', workspace: 'hive', on: true }], ['hive_applied', 'hive_applied']),
    { off: ['hive_applied'], servers: [{ name: 'x', command: 'mcp-x', args: [], workspace: 'hive', on: true }] });
});

test('parseMcp refuses a locked or unknown tool in off, naming the key and listing the optional tools (#333)', () => {
  const only = 'only hive_remember, hive_applied, hive_create_task can be turned off';
  assert.equal(at([], ['hive_done']), `"mcp.off" holds hive_done: ${only}`);
  assert.equal(at([], ['hive_nope']), `"mcp.off" holds hive_nope: ${only}`);
  assert.equal(at([], 'hive_remember'), '"mcp.off" must be an array of tool names');
  for (const raw of [undefined, null, [], 'x']) assert.equal(parseMcp(raw, WORKSPACES), '"mcp" must be an object with off and servers', JSON.stringify(raw));
  assert.equal(parseMcp({ off: [] }, WORKSPACES), '"mcp.servers" must be an array');
});

test('parseMcp refuses each malformed server naming its index, a duplicate name, and a workspace the Comb does not have, naming the server (#333)', () => {
  const refused: [unknown, string][] = [
    [{ ...ONE, command: 'npx' }, '"mcp.servers[0]" must have exactly one of command or url'],
    [{ name: 'docs', workspace: null, on: true }, '"mcp.servers[0]" must have exactly one of command or url'],
    [{ ...ONE, name: 'Docs' }, NAME], [{ ...ONE, name: 'hive' }, NAME], [{ ...ONE, name: 'a.b' }, NAME], [{ ...ONE, name: 'x'.repeat(33) }, NAME], [{ ...ONE, name: 7 }, NAME],
    [{ name: 'docs', command: '--evil', workspace: null, on: true }, '"mcp.servers[0].command" must be a program name or path, not starting with -'],
    [{ name: 'docs', command: ' ', workspace: null, on: true }, '"mcp.servers[0].command" must be a program name or path, not starting with -'],
    [{ name: 'docs', command: 'npx', args: 'x', workspace: null, on: true }, '"mcp.servers[0].args" must be an array of strings'],
    [{ name: 'docs', command: 'npx', authHeader: 'Authorization', workspace: null, on: true }, '"mcp.servers[0].authHeader" is only for a url server'],
    [{ ...ONE, url: 'file:///etc/passwd' }, URL_MESSAGE], [{ ...ONE, url: 'not a url' }, URL_MESSAGE],
    [{ ...ONE, authHeader: 'Bad Header' }, '"mcp.servers[0].authHeader" must be an HTTP header name'],
    [{ ...ONE, on: 'yes' }, '"mcp.servers[0].on" must be true or false'],
    [{ ...ONE, workspace: 7 }, '"mcp.servers[0].workspace" must be null or a workspace name'],
    [{ ...ONE, workspace: 'gone' }, '"mcp.servers": docs is scoped to gone, which no longer exists'],
    ['x', '"mcp.servers[0]" must be an object with name, command or url, workspace, on'],
  ];
  for (const [server, message] of refused) assert.equal(at([server]), message, JSON.stringify(server));
  assert.equal(at([ONE, ONE]), '"mcp.servers[1].name" must be unique');
});

test('serversFor keeps the switched-on servers of every workspace and of the run\'s, in config order, each header value from credentials.json (#333)', () => {
  const mcp: McpSettings = { off: [], servers: [
    { name: 'all', command: 'npx', args: ['x'], workspace: null, on: true },
    { name: 'a', url: 'https://a.example/mcp', authHeader: 'Authorization', workspace: 'hive', on: true },
    { name: 'b', url: 'https://b.example/mcp', workspace: 'hive-site', on: true },
    { name: 'idle', command: 'npx', args: [], workspace: null, on: false },
    { name: 'novalue', url: 'https://n.example/mcp', authHeader: 'X-Key', workspace: null, on: true },
    { name: 'constructor', url: 'https://c.example/mcp', authHeader: 'X-Key', workspace: null, on: true },
  ] };
  const credentials = { mcp: { a: { value: 'Bearer t0k' }, b: { value: 'never sent: b has no authHeader' } } };
  assert.deepEqual(serversFor(mcp, credentials, 'hive'), [
    { name: 'all', command: 'npx', args: ['x'] },
    { name: 'a', url: 'https://a.example/mcp', header: { name: 'Authorization', value: 'Bearer t0k' } },
    { name: 'novalue', url: 'https://n.example/mcp' }, // authHeader with no stored value: sent without the header
    { name: 'constructor', url: 'https://c.example/mcp' }, // an inherited key is no stored value
  ]);
  assert.deepEqual(serversFor(mcp, credentials, 'hive-site').map((s) => s.name), ['all', 'b', 'novalue', 'constructor']);
  assert.deepEqual(serversFor(mcp, {}, 'other'), [{ name: 'all', command: 'npx', args: ['x'] }, { name: 'novalue', url: 'https://n.example/mcp' }, { name: 'constructor', url: 'https://c.example/mcp' }]);
});
