import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentRunner } from './agents/runner.js';
import { hooksPath, PROMPTS_DIR, PROTOCOL_DIR, type ProtocolPaths, protocolFiles, withMemory, workspaceProtocolPaths } from './hooks-settings.js';
import { PROTOCOL_KINDS, type ProtocolTexts, protocolTexts } from './protocol.js';
import { replaceFile } from './replace-file.js';
import { installShellInit } from './shell-init.js';
import { posixShell } from './posix-shell.js';
import type { OptionalTool } from './types.js';

// The writers of the Hive's own home, host-only through src/home-*.ts, out of hooks-settings.ts (#159).
const HOME_MODE = 0o700; // the home holds the log, the prompts and the credentials: this user only
const MCP_MODE = 0o600; // the MCP config holds the secret (#467)
const PROTOCOL_FILE_MODE = 0o600; // a workspace's protocol files hold its lessons (#797)

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

/** A protocol file's text (#927, #159): the host's own file, handed to the machine as text. A file that cannot be read rejects, and the run
 * fails before any pty. */
export const readProtocolText = (path: string): Promise<string> => readFile(path, 'utf8');

// Rewritten on every boot and every save, as hooks.json is: upgrading the Hive or turning a tool off changes what every worker is told (#167,
// #336). No passage: with no workspace there is no `workspace` to render one with.
async function writeProtocol(home: string, off: readonly OptionalTool[]): Promise<ProtocolPaths> {
  const dir = join(home, PROTOCOL_DIR);
  await mkdir(dir, { recursive: true, mode: HOME_MODE });
  const paths = protocolFiles(dir);
  const texts = protocolTexts(off, []);
  // local.md for symmetry: a local run reads its workspace's (#256)
  await Promise.all(PROTOCOL_KINDS.map((kind) => writeFile(paths[kind], texts[kind])));
  return paths;
}

/** Writes a workspace's protocol files (#797): each protocol (its passages rendered in, #336), then a blank line and `memory` (its rendered
 * section) when there is one. The Hive never reads them back: a hand edit is lost on the next write. */
export async function writeWorkspaceProtocol(home: string, workspace: string, protocol: ProtocolTexts, memory: string): Promise<ProtocolPaths> {
  const paths = workspaceProtocolPaths(home, workspace);
  await mkdir(dirname(paths.stage), { recursive: true, mode: HOME_MODE });
  // temp + rename, as the memory file is: a run starting mid-write reads the old file or the new one, never half; the lessons are private
  const put = async (path: string, text: string): Promise<void> => {
    await writeFile(`${path}.tmp`, text, { mode: PROTOCOL_FILE_MODE });
    await replaceFile(`${path}.tmp`, path);
  };
  await Promise.all(PROTOCOL_KINDS.map((kind) => put(paths[kind], withMemory(protocol[kind], memory))));
  return paths;
}

/** The home's runtime files for `port`: prompts/ (the spawn's prompt files), protocol/ (what the agent's protocol flag points at, #167), and each
 * runner's own (#924): Claude's hooks.json and shim, Codex's shim, and shell/ (the terminals' init files, #259). The plugin is not here: each
 * workspace's folder is the render's (#316), and no run loads another (#317). `runners` are the agents boot found; `off` the tools `mcp.off`
 * turns off (#336). */
export async function prepareHome(
  home: string, port: number, runners: readonly Pick<AgentRunner, 'prepareHome'>[],
  off: readonly OptionalTool[],
): Promise<{ hooksPath: string; promptsDir: string; protocol: ProtocolPaths }> {
  const promptsDir = join(home, PROMPTS_DIR);
  await mkdir(promptsDir, { recursive: true, mode: HOME_MODE }); // first: it creates the home with this user's mode
  for (const runner of runners) await runner.prepareHome(home, port);
  await installShellInit(home, { platform: process.platform, sh: posixShell().shell }); // #259: after the runners' shims, which its functions call; #645: the profile's sh.exe
  const protocol = await writeProtocol(home, off);
  return { hooksPath: hooksPath(home), promptsDir, protocol };
}
