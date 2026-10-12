import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents.js';

// An agent's shim (#696, #924): assets/bin/<command>, with the agent's subcommands in its passthrough pattern, written into <home>/bin on every
// boot, as the plugin is: upgrading the Hive changes what every terminal's agent does.

/** What a shim is made from (#924): the agent's command, which names the template and the file, and its subcommands. */
export interface ShimAgent { command: string; subcommands: readonly string[] }

export const BIN_DIR = 'bin'; // <home>/bin: first on every terminal's PATH
const SUBCOMMANDS = '__HIVE_SUBCOMMANDS__';
const BIN_MODE = 0o700;
const SHIM_MODE = 0o755;

/** `assets/bin/<command>` in the Hive's own checkout, resolved from dist/src/ as pluginSource is. */
export const shimSource = (agent: Pick<ShimAgent, 'command'>): string => fileURLToPath(new URL(`../../assets/bin/${agent.command}`, import.meta.url));

/** The shim as written: the template with the agent's subcommands as one `case` pattern. */
export const renderShim = (template: string, agent: Pick<ShimAgent, 'subcommands'>): string => template.replace(SUBCOMMANDS, agent.subcommands.join('|'));

export const shimDir = (home: string): string => join(home, BIN_DIR);
export const shimPath = (home: string, agent: Pick<ShimAgent, 'command'>): string => join(shimDir(home), agent.command);

/** Writes <home>/bin/<command>, executable; answers its path. */
export async function installShim(home: string, agent: ShimAgent): Promise<string> {
  await mkdir(shimDir(home), { recursive: true, mode: BIN_MODE });
  const path = shimPath(home, agent);
  await writeFile(path, renderShim(await readFile(shimSource(agent), 'utf8'), agent));
  await chmod(path, SHIM_MODE); // writeFile's mode applies only to a new file
  return path;
}

/** What claude gets before the user's own args in a captured session (#696): a free session's (#283): the MCP, the hooks, the plugin, the
 * workspace's language-server plugin when it has one (#803), the protocol on a task's activity only, then the global claudeArgs and the
 * session id the Hive chose, in runArgs' order. --settings right after --mcp-config ends its list, as ptyCommand orders them. */
export interface CapturedLaunch { sessionId: string; mcpPath: string; hooksPath: string; pluginDir: string; lspPluginDir?: string; protocolPath?: string; claudeArgs: string[] }

export const capturedArgs = (o: CapturedLaunch): string[] => [
  '--mcp-config', o.mcpPath, '--settings', o.hooksPath, '--plugin-dir', o.pluginDir,
  ...(o.lspPluginDir === undefined ? [] : ['--plugin-dir', o.lspPluginDir]),
  ...(o.protocolPath === undefined ? [] : [AGENTS.claude.protocolFlag, o.protocolPath]),
  ...o.claudeArgs, '--session-id', o.sessionId,
];

// What the shim's read loop cannot take: a line break would split one arg in two, or start a forged one
const LINE_BREAK = /[\r\n]/;

/** The register's answer (#696): the run id, then each arg claude gets before the user's own on a line of its own, which the shim reads as data
 * and never evaluates. Undefined when an arg holds a line break: the route refuses the register rather than send a split arg. */
export const capturedReply = (runId: string, args: string[]): string | undefined =>
  (args.some((arg) => LINE_BREAK.test(arg)) ? undefined : [runId, ...args].join('\n'));
