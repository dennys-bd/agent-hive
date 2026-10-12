import { appendFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents.js'; // temporary (#924): Task 6 moves the shim's install into Claude's runner
import { installShim } from './shim.js';
import { SESSION_PROTOCOL, STAGE_PROTOCOL } from './protocol.js';
import { SECRET_HEADER } from './secret.js';
import { APPROVAL_HOLD_MAX_MIN } from './types.js';

export const HIVE_DIR = '.hive'; // the workspace's folder for the Hive: only worktrees/ lives there (#202)
export const PROMPTS_DIR = 'prompts';
export const PLUGIN_DIR = 'plugin'; // <home>/plugin: what --plugin-dir points every worker at (#100)
export const PROTOCOL_DIR = 'protocol'; // <home>/protocol: the files behind every agent's protocol flag (#167)

const WORKSPACES_DIR = 'workspaces'; // <home>/protocol/workspaces/<workspace> (#797): apart from the global stage.md / session.md, which a workspace could be named after

/** The protocol files (#167): a stage run is told stage, a free session on a task session. */
export interface ProtocolPaths {
  stage: string;
  session: string;
}
const HOME_MODE = 0o700; // the home holds the log, the prompts and the credentials: this user only
const MCP_MODE = 0o600; // the MCP config holds the secret (#467)
const PROTOCOL_FILE_MODE = 0o600; // a workspace's protocol files hold its lessons (#797)
export const HOOK_EVENTS: readonly string[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', // StopFailure: #805, fire-and-forget
];
export const MCP_ROUTE = '/hooks/mcp'; // the Hive's MCP server for its workers (#99): under /hooks/ for the host guard and the UI-header exemption
export const MCP_TOOLS_ALLOW = 'mcp__hive__*'; // Claude Code names the tools mcp__<server>__<tool>; allowed so no call stops at a permission prompt

export interface McpConfig {
  mcpServers: { hive: { type: 'http'; url: string; headers: Record<string, string> } };
}

const HOOK_TIMEOUT_S = 30; // a Stop is answered after the source writes of its dispatch (gh takes seconds); the reply is the continuation
const STATUS_TIMEOUT_S = 2;
const SECONDS_PER_MINUTE = 60;
// The Stop may be held while a stage awaits approval (#268): its curl and Claude Code's own hook timeout outlast the longest hold
export const STOP_HOOK_TIMEOUT_S = APPROVAL_HOLD_MAX_MIN * SECONDS_PER_MINUTE + HOOK_TIMEOUT_S;

// -f: an HTTP error answers nothing on stdout (Express's HTML page, the host guard's JSON would otherwise reach the worker's
// context on UserPromptSubmit / SessionStart); its exit 22 is masked by the `; exit 0` every command ends with. The secret goes as
// curl's header file (#467): hooks.json is shared by every worker, whose env names hive.secret, and only that path reaches curl's argv,
// which every account reads through ps.
function postStdin(port: number, path: string, timeout: number): string {
  return [
    `curl -sf -m ${timeout} -X POST http://127.0.0.1:${port}${path}`,
    `-H "x-hive-pty: $HIVE_PTY_ID"`,
    `-H @"$HIVE_SECRET_FILE"`,
    `-H 'content-type: application/json'`,
    `--noproxy '*'`, // #696: a proxy in the worker's env never sees the secret header: the Hive is on loopback
    `-d @-`,
  ].join(' ');
}

/** The hook command: stdout is what Claude Code reads. Empty (204) means no decision; the JSON of a continuing Stop is the decision. */
export function hookCommand(port: number, timeout = HOOK_TIMEOUT_S): string {
  return `${postStdin(port, '/hooks/event', timeout)}; exit 0`;
}

/** The worker's status line: the Hive replies with the plan limits summary, which is what the worker's tab shows. */
export function statusCommand(port: number): string {
  return `${postStdin(port, '/hooks/status', STATUS_TIMEOUT_S)}; exit 0`;
}

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

/** The pkill pattern for the claude holding `ptyId`'s MCP config (#696): its file name in claude's argv, dots escaped, as pkill reads a regex. */
export const mcpConfigPattern = (ptyId: string): string => `${ptyId}\\.mcp\\.json`;

/** One file per worker next to the prompts, named after the pty id: its path in claude's argv is what killStray / isStrayAlive match
 * now that the prompt no longer carries the id. 0600 in the 0700 home (#467): a new run is a new pty id, so the mode is set at
 * creation. A stale file from an earlier boot holds a secret that no longer opens anything. */
export async function writeMcpConfig(promptsDir: string, ptyId: string, port: number, secret: string, withHive = true): Promise<string> {
  const path = join(promptsDir, `${ptyId}.mcp.json`);
  // a local session (#587): no Hive tools (no task for hive_done), but the path still puts the pty id in claude's argv for killStray
  const config = withHive ? renderMcpConfig(port, ptyId, secret) : { mcpServers: {} };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: MCP_MODE });
  return path; // ponytail: one small file per spawn, never removed; delete it on exit if the home's prompts/ ever gets crowded
}

/** Keeps <repo>/.hive/ (the worktrees) out of git: once per repo, nothing without a .git/info. */
export async function excludeFromGit(repo: string): Promise<void> {
  const infoDir = join(repo, '.git', 'info');
  try {
    if (!(await stat(infoDir)).isDirectory()) return;
  } catch {
    return;
  }
  const excludePath = join(infoDir, 'exclude');
  const current = await readFile(excludePath, 'utf8').catch(() => '');
  if (current.split('\n').includes(`${HIVE_DIR}/`)) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(excludePath, `${separator}${HIVE_DIR}/\n`);
}

/** `assets/plugin` in the Hive's own checkout, resolved from dist/src/ like assets/icon.png does from dist/src/main.js. */
export function pluginSource(): string {
  return fileURLToPath(new URL('../../assets/plugin', import.meta.url));
}

// Wiped and re-copied on every boot: upgrading the Hive refreshes the skills of every repository it drives, and a skill deleted
// upstream stops existing downstream instead of lingering. Nothing under the home's plugin/ is ever edited by hand.
async function copyPlugin(home: string): Promise<string> {
  const pluginDir = join(home, PLUGIN_DIR);
  await rm(pluginDir, { recursive: true, force: true });
  await cp(pluginSource(), pluginDir, { recursive: true });
  return pluginDir;
}

// Rewritten on every boot, as hooks.json and plugin/ are: upgrading the Hive changes what every worker is told (#167).
async function writeProtocol(home: string): Promise<ProtocolPaths> {
  const dir = join(home, PROTOCOL_DIR);
  await mkdir(dir, { recursive: true, mode: HOME_MODE });
  const paths = { stage: join(dir, 'stage.md'), session: join(dir, 'session.md') };
  await Promise.all([writeFile(paths.stage, STAGE_PROTOCOL), writeFile(paths.session, SESSION_PROTOCOL)]);
  return paths;
}

/** A workspace's protocol files (#797): the protocol with the workspace's memory under it, in <home>/protocol/workspaces/<workspace>/. No I/O. */
export function workspaceProtocolPaths(home: string, workspace: string): ProtocolPaths {
  const dir = join(home, PROTOCOL_DIR, WORKSPACES_DIR, encodeURIComponent(workspace));
  return { stage: join(dir, 'stage.md'), session: join(dir, 'session.md') };
}

/** Writes a workspace's protocol files (#797): each protocol, then a blank line and `memory` (its rendered section) when there is one. The Hive
 * never reads them back: a hand edit is lost on the next write. */
export async function writeWorkspaceProtocol(home: string, workspace: string, memory: string): Promise<ProtocolPaths> {
  const paths = workspaceProtocolPaths(home, workspace);
  await mkdir(dirname(paths.stage), { recursive: true, mode: HOME_MODE });
  const told = (protocol: string): string => (memory === '' ? protocol : `${protocol}\n${memory}`);
  // temp + rename, as the memory file is: a run starting mid-write reads the old file or the new one, never half; the lessons are private
  const put = async (path: string, text: string): Promise<void> => {
    await writeFile(`${path}.tmp`, text, { mode: PROTOCOL_FILE_MODE });
    await rename(`${path}.tmp`, path);
  };
  await Promise.all([put(paths.stage, told(STAGE_PROTOCOL)), put(paths.session, told(SESSION_PROTOCOL))]);
  return paths;
}

/** The home's runtime files for `port`: hooks.json (what --settings points every worker at), prompts/ (the spawn's prompt files),
 * plugin/ (the Hive's own skills and agents, what --plugin-dir points at), protocol/ (what the agent's protocol flag points at, #167), and
 * bin/claude (the shim every terminal's PATH starts with, #696). */
export async function prepareHome(home: string, port: number): Promise<{ hooksPath: string; promptsDir: string; pluginDir: string; protocol: ProtocolPaths }> {
  const promptsDir = join(home, PROMPTS_DIR);
  const hooksPath = join(home, 'hooks.json');
  await mkdir(promptsDir, { recursive: true, mode: HOME_MODE });
  await writeFile(hooksPath, `${JSON.stringify(renderHooksSettings(port), null, 2)}\n`);
  const pluginDir = await copyPlugin(home);
  const protocol = await writeProtocol(home);
  await installShim(home, AGENTS.claude); // #696: the claude every terminal finds first on its PATH
  return { hooksPath, promptsDir, pluginDir, protocol };
}
