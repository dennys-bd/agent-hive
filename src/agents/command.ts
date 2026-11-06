// Where an agent's binary is (#633), node-side: agents.ts is imported by the page (#924) and must not reach node:fs or node:path. On win32
// Claude's native installer leaves claude.exe in %USERPROFILE%\.local\bin, often off PATH; Codex is an npm .cmd, found through PATH only.
import path from 'node:path';
import { AGENTS } from '../agents.js';
import { envValue, findExec } from '../exec-path.js';
import type { AgentId } from '../types.js';

/** The folders searched before PATH for `name`: on win32 Claude's install folder, none when USERPROFILE is unset; every other name, and
 *  every name on darwin and linux, none. */
export function agentDirs(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32' || name !== AGENTS.claude.command) return [];
  const profile = envValue(env, 'USERPROFILE');
  return profile ? [path.win32.join(profile, '.local', 'bin')] : [];
}

/** The word the pty's launch line starts the agent with. On win32 an .exe's full path. Anything else (a .cmd, or a name found nowhere)
 *  stays bare: sh.exe runs the extensionless sh shim npm installs beside every .cmd, and the .cmd runner's verbatim line would not survive
 *  MSYS's re-quoting. */
export function agentCommand(id: AgentId, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, isFile?: (file: string) => boolean): string {
  const name = AGENTS[id].command;
  const found = findExec(name, { platform, env, dirs: agentDirs(name, platform, env), isFile });
  return found !== undefined && path.win32.extname(found).toLowerCase() === '.exe' ? found : name;
}
