import { vi } from 'vitest';
import { LOCKED_TOOLS, OPTIONAL_TOOLS } from '../../src/types';
import type { McpRead, McpServerRow } from '@/hooks/use-mcp';
import { CATALOGUE, json } from './plugins-fixtures';

/** GET /api/mcp as #333 answers it: the locked tools, then the optional ones (only hive_applied on); a command server for every workspace,
 * connected, and a URL server with a saved header value, scoped to hive-site and not answering. */
export const MCP_READ: McpRead = {
  tools: [
    ...LOCKED_TOOLS.map((name) => ({ name, locked: true, on: true })),
    ...OPTIONAL_TOOLS.map((name) => ({ name, locked: false, on: name === 'hive_applied' })),
  ],
  servers: [
    { name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'], workspace: null, on: true, hasValue: false, state: 'connected' },
    { name: 'figma', url: 'http://127.0.0.1:3845/mcp', authHeader: 'Authorization', workspace: 'hive-site', on: true, hasValue: true, state: 'no_answer' },
  ],
};

type ServerChange = Partial<Pick<McpServerRow, 'on' | 'state' | 'workspace' | 'hasValue'>>;
/** MCP_READ with one server changed. */
export const withServer = (name: string, change: ServerChange): McpRead =>
  ({ ...MCP_READ, servers: MCP_READ.servers.map((server) => (server.name === name ? { ...server, ...change } : server)) });

export interface McpCall { method: string; path: string; body?: unknown }

/** fetch for the mcp screen: GET /api/mcp answers `read()`, GET /api/items the catalogue, any other GET ok; every write is logged in
 * `calls` (synchronously, before its answer) and answered by `write`, ok by default. */
export function stubMcp(read: () => McpRead = () => MCP_READ, write: (call: McpCall) => Response | Promise<Response> = () => json({ ok: true })) {
  const calls: McpCall[] = [];
  const mock = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/mcp') return json(read());
    if (method === 'GET') return json(path === '/api/items' ? CATALOGUE : { ok: true });
    const call: McpCall = init?.body === undefined ? { method, path } : { method, path, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return write(call);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}
