// A server's state (#333): asked only when GET /api/mcp asks, never in the background. A command server is spawned from its argv (no shell)
// and asked MCP's initialize over stdio, a URL server over Streamable HTTP with its header; the client, and so the child, is closed whatever
// the answer. Anything but an initialize within the timeout is no_answer, the error's class in hive.log at debug, never its message or the header value.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RunMcpServer } from './agents/runner.js';
import { type ExecLookup, findExec } from './exec-path.js';
import type { Logger } from './log.js';
import { withoutHiveEnv } from './spawn.js';

export type ProbeAnswer = 'connected' | 'no_answer';
export type Probe = (server: RunMcpServer) => Promise<ProbeAnswer>;
export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_CACHE_MS = 30_000;
const CLIENT_INFO = { name: 'hive-probe', version: '1.0.0' };

// platform and env: the command's lookup (#633), the daemon's unless a test gives its own
export interface ProbeOptions { timeoutMs: number; cwd: string; log: Pick<Logger, 'debug'>; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }

// The SDK's default env for a stdio child is a handful of names, too few for npx; the Hive's own minus what no child may inherit
const childEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(withoutHiveEnv(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined));

/** The command a stdio server is spawned with (#633): on win32 the full path findExec gives, an .exe's or a .cmd's, since the SDK spawns
 *  through cross-spawn, which wraps a .cmd in cmd.exe with its own escaping. A name found nowhere, and every name on darwin and linux, as
 *  written: a missing command fails in the probe as it always did. */
export const probeCommand = (command: string, lookup: ExecLookup): string => findExec(command, lookup) ?? command;

function transportFor(server: RunMcpServer, cwd: string, lookup: ExecLookup): Transport {
  if ('command' in server) return new StdioClientTransport({ command: probeCommand(server.command, lookup), args: server.args, cwd, env: childEnv(), stderr: 'ignore' });
  const headers: Record<string, string> = server.header ? { [server.header.name]: server.header.value } : {};
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
}

export async function probeServer(server: RunMcpServer, { timeoutMs, cwd, log, platform = process.platform, env = process.env }: ProbeOptions): Promise<ProbeAnswer> {
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transportFor(server, cwd, { platform, env }), { timeout: timeoutMs }); // connect sends initialize under this timeout
    return 'connected';
  } catch (err) {
    log.debug(`mcp probe ${server.name}: no answer (${err instanceof Error ? err.constructor.name : typeof err})`); // never err.message: an HTTP error can echo the response body or the header
    return 'no_answer';
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Each server's answer, kept PROBE_CACHE_MS per name; a server whose definition or header value changed is probed afresh. Memory only.
 * A removed server's entry stays until the process ends (a few bytes per name). */
export function cachedProbe(probe: Probe, now: () => number = Date.now): Probe {
  const kept = new Map<string, { key: string; at: number; answer: Promise<ProbeAnswer> }>();
  return (server) => {
    const key = JSON.stringify(server);
    const hit = kept.get(server.name);
    if (hit && hit.key === key && now() - hit.at < PROBE_CACHE_MS) return hit.answer;
    const answer = probe(server);
    kept.set(server.name, { key, at: now(), answer });
    return answer;
  };
}
