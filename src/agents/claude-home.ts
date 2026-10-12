// Claude Code's own files (#924, out of hooks-settings.ts and worker-lsp.ts): the hooks settings every run's --settings reads, the MCP
// config each run's --mcp-config reads, the language-server plugin its LSP tool reads at launch (#803), and the shim (#696).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTS } from '../agents.js';
import { hookCommand, hooksPath, MCP_ROUTE, statusCommand, STOP_HOOK_TIMEOUT_S } from '../hooks-settings.js';
import { SECRET_HEADER } from '../secret.js';
import { installShim } from '../shim.js';
import type { LspServers, McpServer } from './runner.js';

export const HOOK_EVENTS: readonly string[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', // StopFailure: #805, fire-and-forget
];
const MCP_TOOLS_ALLOW = 'mcp__hive__*'; // Claude Code names the tools mcp__<server>__<tool>; allowed so no call stops at a permission prompt
const LSP_MANIFEST = { name: 'hive-lsp', description: 'The language servers the Hive installed, for this workspace (#803)', version: '1.0.0' };

export interface McpConfig {
  mcpServers: { hive: { type: 'http'; url: string; headers: Record<string, string> } };
}

// Every file here as the Hive always wrote it: two-space JSON and a final newline
const asFile = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function renderHooksSettings(port: number): {
  hooks: Record<string, unknown[]>; statusLine: { type: 'command'; command: string }; permissions: { allow: string[] };
} {
  const command = hookCommand(port);
  const stop = { type: 'command', command: hookCommand(port, STOP_HOOK_TIMEOUT_S), timeout: STOP_HOOK_TIMEOUT_S }; // #268
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [{ ...(event === 'PostToolUse' ? { matcher: 'Bash' } : {}), hooks: [event === 'Stop' ? stop : { type: 'command', command }] }],
    ]),
  );
  // --settings precedence replaces the user's own status line inside the workers; the reply keeps the tab useful
  return { hooks, statusLine: { type: 'command', command: statusCommand(port) }, permissions: { allow: [MCP_TOOLS_ALLOW] } };
}

/** The worker's MCP config: the Hive's own server over HTTP, the pty id (the identity the hooks use too) and this boot's secret as
 *  literal headers (#99, #467). Claude Code documents ${VAR} expansion in .mcp.json headers, but nothing for a file passed with
 *  --mcp-config, so the value itself goes in. */
export function renderMcpConfig(port: number, ptyId: string, secret: string): McpConfig {
  return { mcpServers: { hive: { type: 'http', url: `http://127.0.0.1:${port}${MCP_ROUTE}`, headers: { 'x-hive-pty': ptyId, [SECRET_HEADER]: secret } } } };
}

/** A run's MCP config file (#924): the Hive's server, or none for a local session (#587), whose file still puts the pty id in the argv. */
export const claudeMcpConfig = ({ port, ptyId, secret, withHive }: McpServer): string =>
  asFile(withHive ? renderMcpConfig(port, ptyId, secret) : { mcpServers: {} });

/** A workspace's language-server plugin (#803): its manifest and its .lsp.json, each path relative to the plugin's folder. */
export const claudeLspPlugin = (servers: LspServers): { path: string; content: string }[] => [
  { path: join('.claude-plugin', 'plugin.json'), content: asFile(LSP_MANIFEST) },
  { path: '.lsp.json', content: asFile(servers) },
];

/** Claude's files in the home for `port` (#924): hooks.json, what --settings points every run at, and its shim (#696). Rewritten on every boot:
 * upgrading the Hive changes what every worker gets. */
export async function prepareClaudeHome(home: string, port: number): Promise<void> {
  await writeFile(hooksPath(home), asFile(renderHooksSettings(port)));
  await installShim(home, AGENTS.claude);
}
