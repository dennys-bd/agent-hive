import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRunner } from './agents/runner.js';
import { SESSION_PROTOCOL, STAGE_PROTOCOL } from './protocol.js';
import { installShellInit } from './shell-init.js';
import { APPROVAL_HOLD_MAX_MIN } from './types.js';

export const HIVE_DIR = '.hive'; // the workspace's folder for the Hive: only worktrees/ lives there (#202)
export const PROMPTS_DIR = 'prompts';
export const PROTOCOL_DIR = 'protocol'; // <home>/protocol: the files behind every agent's protocol flag (#167)
const HOOKS_FILE = 'hooks.json'; // what every run's hooks settings flag points at

const WORKSPACES_DIR = 'workspaces'; // <home>/protocol/workspaces/<workspace> (#797): apart from the global stage.md / session.md, which a workspace could be named after

/** The protocol files (#167): a stage run is told stage, a free session on a task session. */
export interface ProtocolPaths {
  stage: string;
  session: string;
}
const HOME_MODE = 0o700; // the home holds the log, the prompts and the credentials: this user only
const MCP_MODE = 0o600; // the MCP config holds the secret (#467)
const PROTOCOL_FILE_MODE = 0o600; // a workspace's protocol files hold its lessons (#797)
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

/** One file per worker next to the prompts, named after the pty id: its path in the agent's argv is what killStray / isStrayAlive match
 * now that the prompt no longer carries the id. 0600 in the 0700 home (#467): a new run is a new pty id, so the mode is set at
 * creation. A stale file from an earlier boot holds a secret that no longer opens anything. `content` is the run's runner's (#924); an empty
 * one is a runner whose server rides its argv (#927, Codex): no file, no path. */
export async function writeMcpConfig(promptsDir: string, ptyId: string, content: string): Promise<string | undefined> {
  if (content === '') return undefined;
  const path = join(promptsDir, `${ptyId}.mcp.json`);
  await writeFile(path, content, { mode: MCP_MODE });
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

// Rewritten on every boot, as hooks.json is: upgrading the Hive changes what every worker is told (#167).
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

/** hooks.json in `home`: what every run's hooks settings flag points at; the runner writes it (#924). No I/O. */
export const hooksPath = (home: string): string => join(home, HOOKS_FILE);

/** The home's runtime files for `port`: prompts/ (the spawn's prompt files), protocol/ (what the agent's protocol flag points at, #167), and each
 * runner's own (#924): Claude's hooks.json and shim, Codex's shim, and shell/ (the terminals' init files, #259). The plugin is not here: each
 * workspace's folder is the render's (#316), and no run loads another (#317). `runners` are the agents boot found. */
export async function prepareHome(
  home: string, port: number, runners: readonly Pick<AgentRunner, 'prepareHome'>[],
): Promise<{ hooksPath: string; promptsDir: string; protocol: ProtocolPaths }> {
  const promptsDir = join(home, PROMPTS_DIR);
  await mkdir(promptsDir, { recursive: true, mode: HOME_MODE }); // first: it creates the home with this user's mode
  for (const runner of runners) await runner.prepareHome(home, port);
  await installShellInit(home); // #259: after the runners' shims, which its functions call; one site for every agent
  const protocol = await writeProtocol(home);
  return { hooksPath: hooksPath(home), promptsDir, protocol };
}
