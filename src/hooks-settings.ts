import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Machine } from './machine.js';
import { APPROVAL_HOLD_MAX_MIN, EDITOR_FILE_MAX } from './types.js';

export const HIVE_DIR = '.hive'; // the workspace's folder for the Hive: only worktrees/ lives there (#202)
export const PROMPTS_DIR = 'prompts';
export const PROTOCOL_DIR = 'protocol'; // <home>/protocol: the files behind every agent's protocol flag (#167)
const HOOKS_FILE = 'hooks.json'; // what every run's hooks settings flag points at

const WORKSPACES_DIR = 'workspaces'; // <home>/protocol/workspaces/<workspace> (#797): apart from the global stage.md / session.md, which a workspace could be named after

/** The protocol files (#167): a stage run is told stage, a free session on a task session, a session with no task local (#256). */
export interface ProtocolPaths {
  stage: string;
  session: string;
  local: string;
}

// One file per protocol kind, in the global folder and in each workspace's (#167, #797, #256)
export const protocolFiles = (dir: string): ProtocolPaths => ({ stage: join(dir, 'stage.md'), session: join(dir, 'session.md'), local: join(dir, 'local.md') });
export const MCP_ROUTE = '/hooks/mcp'; // the Hive's MCP server for its workers (#99): under /hooks/ for the host guard and the UI-header exemption

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

/** The pkill pattern for the agent holding `ptyId`'s MCP config (#696): its file name in the agent's argv, dots escaped, as pkill reads a regex. */
export const mcpConfigPattern = (ptyId: string): string => `${ptyId}\\.mcp\\.json`;

/** Keeps <repo>/.hive/ (the worktrees) out of git, on the machine the workspace's clone is on (#159): once per repo, nothing without a .git/info. */
export async function excludeFromGit(machine: Machine, repo: string): Promise<void> {
  const infoDir = join(repo, '.git', 'info');
  try {
    if (!(await machine.fs.stat(infoDir)).isDirectory()) return;
  } catch {
    return;
  }
  const excludePath = join(infoDir, 'exclude');
  // Only a missing file reads as empty: any other failure (over the cap, unreadable) appends nothing, never glued onto a last pattern
  const current = await machine.fs.readFile(excludePath, { maxBytes: EDITOR_FILE_MAX, encoding: 'utf8' }).catch((err: { code?: unknown }) => (err?.code === 'ENOENT' ? '' : undefined));
  if (current === undefined) return;
  if (current.split('\n').includes(`${HIVE_DIR}/`)) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await machine.fs.appendFile(excludePath, `${separator}${HIVE_DIR}/\n`);
}

/** `assets/plugin` in the Hive's own checkout, resolved from dist/src/ like assets/icon.png does from dist/src/main.js. */
export function pluginSource(): string {
  return fileURLToPath(new URL('../../assets/plugin', import.meta.url));
}

/** A workspace's protocol files (#797): the protocol with the workspace's memory under it, in <home>/protocol/workspaces/<workspace>/. No I/O. */
export function workspaceProtocolPaths(home: string, workspace: string): ProtocolPaths {
  return protocolFiles(join(home, PROTOCOL_DIR, WORKSPACES_DIR, encodeURIComponent(workspace)));
}

/** A protocol with a workspace's memory section under it (#797): what its runs read. */
export const withMemory = (protocol: string, memory: string): string => (memory === '' ? protocol : `${protocol}\n${memory}`);

/** hooks.json in `home`: what every run's hooks settings flag points at; the runner writes it (#924). No I/O. */
export const hooksPath = (home: string): string => join(home, HOOKS_FILE);
