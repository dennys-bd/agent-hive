// The `mcp` key of hive.config.json (#333), out of config.ts, which is over 400 lines: the optional Hive tools turned off and the external
// MCP servers every run of their scope gets. The problem comes back as a sentence; config.ts adds the file's name, the routes answer it as is.
import type { RunMcpServer } from './agents/runner.js';
import { type Credentials, type ExternalMcpServer, type McpSettings, OPTIONAL_TOOLS, type OptionalTool } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const SHAPE = '"mcp" must be an object with off and servers';
// A key of Claude's mcpServers, a segment of Codex's mcp_servers.<name> TOML path (no dot) and of Claude's mcp__<name>__* tool names
const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const HIVE_SERVER = 'hive'; // the Hive's own server's name
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];
const URL_PROTOCOLS = ['http:', 'https:']; // Claude's http type and Codex's url both speak Streamable HTTP

function parseOff(raw: unknown): OptionalTool[] | string {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) return '"mcp.off" must be an array of tool names';
  const bad = raw.find((name) => !OPTIONAL_TOOLS.includes(name as OptionalTool));
  if (bad !== undefined) return `"mcp.off" holds ${bad}: only ${OPTIONAL_TOOLS.join(', ')} can be turned off`;
  return [...new Set(raw as OptionalTool[])];
}

// A command server's argv, never a shell string; no leading '-', since the probe spawns it and an agent runs it
function commandPart(raw: Record<string, unknown>, field: string): { command: string; args: string[] } | string {
  const { command, args = [] } = raw;
  if (typeof command !== 'string' || command.trim() === '' || command.startsWith('-')) return `"${field}.command" must be a program name or path, not starting with -`;
  // A relative path would resolve inside a task's worktree, whose files the task's own agent can write
  if (command.includes('/') && !command.startsWith('/')) return `"${field}.command" must be a bare program name or an absolute path, not a relative one`;
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return `"${field}.args" must be an array of strings`;
  if (raw.authHeader !== undefined) return `"${field}.authHeader" is only for a url server`;
  return { command, args: args as string[] };
}

function urlPart(raw: Record<string, unknown>, field: string): { url: string; authHeader?: string } | string {
  const { url, authHeader } = raw;
  if (typeof url !== 'string' || !URL.canParse(url) || !URL_PROTOCOLS.includes(new URL(url).protocol)) return `"${field}.url" must be an http or https URL`;
  const { username, password, protocol, hostname } = new URL(url);
  if (username !== '' || password !== '') return `"${field}.url" must not carry a user name or password`;
  if (authHeader !== undefined && protocol === 'http:' && !LOOPBACK_HOSTS.includes(hostname)) return `"${field}.url" must be https when authHeader is set, unless the host is this machine`;
  if (authHeader !== undefined && (typeof authHeader !== 'string' || !HEADER_NAME.test(authHeader))) return `"${field}.authHeader" must be an HTTP header name`;
  return { url, ...(authHeader === undefined ? {} : { authHeader }) };
}

function parseServer(raw: unknown, field: string, workspaces: readonly string[]): ExternalMcpServer | string {
  if (!isRecord(raw)) return `"${field}" must be an object with name, command or url, workspace, on`;
  const { name, workspace, on } = raw;
  if (typeof name !== 'string' || !SERVER_NAME.test(name) || name === HIVE_SERVER) return `"${field}.name" must be 1 to 32 lowercase letters, digits, _ or -, start with a letter, and not be hive`;
  if (('command' in raw) === ('url' in raw)) return `"${field}" must have exactly one of command or url`;
  const part = 'command' in raw ? commandPart(raw, field) : urlPart(raw, field);
  if (typeof part === 'string') return part;
  if (workspace !== null && typeof workspace !== 'string') return `"${field}.workspace" must be null or a workspace name`;
  // The form never sends mcp, so a workspace rename cannot carry the scope along: the save is refused, naming the server
  if (workspace !== null && !workspaces.includes(workspace)) return `"mcp.servers": ${name} is scoped to ${workspace}, which no longer exists`;
  if (typeof on !== 'boolean') return `"${field}.on" must be true or false`;
  return { name, ...part, workspace, on };
}

/** The parsed key, or the first problem as a sentence without the file's name. `workspaces`: the Comb's workspace names. */
export function parseMcp(raw: unknown, workspaces: readonly string[]): McpSettings | string {
  if (!isRecord(raw)) return SHAPE;
  const off = parseOff(raw.off);
  if (typeof off === 'string') return off;
  if (!Array.isArray(raw.servers)) return '"mcp.servers" must be an array';
  const parsed = raw.servers.map((server: unknown, i) => parseServer(server, `mcp.servers[${i}]`, workspaces));
  const problem = parsed.find((s): s is string => typeof s === 'string');
  if (problem !== undefined) return problem;
  const servers = parsed as ExternalMcpServer[];
  const twice = servers.findIndex((s, i) => servers.findIndex((t) => t.name === s.name) !== i);
  return twice < 0 ? { off, servers } : `"mcp.servers[${twice}].name" must be unique`;
}

// The stored value, only an own key: a server named constructor must not read Object.prototype's
const storedValue = (credentials: Credentials, name: string): string | undefined =>
  (credentials.mcp && Object.hasOwn(credentials.mcp, name) ? credentials.mcp[name].value : undefined);

/** A server as a run (or the probe) receives it: a URL server's header only with authHeader and a stored value. */
export function runServer(server: ExternalMcpServer, credentials: Credentials): RunMcpServer {
  if ('command' in server) return { name: server.name, command: server.command, args: server.args };
  const value = server.authHeader === undefined ? undefined : storedValue(credentials, server.name);
  return { name: server.name, url: server.url, ...(server.authHeader !== undefined && value !== undefined ? { header: { name: server.authHeader, value } } : {}) };
}

/** The servers a run of `workspace` gets: switched on, scoped to every workspace or to this one, in config order. */
export const serversFor = (mcp: McpSettings, credentials: Credentials, workspace: string): RunMcpServer[] =>
  mcp.servers.filter((s) => s.on && (s.workspace === null || s.workspace === workspace)).map((s) => runServer(s, credentials));
