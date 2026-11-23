import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUuid } from './uuid.js';
import { type AgentId, ENV_NAME } from './types.js';

// The agents' shim (#696, #924, #932): one template, assets/bin/shim, rendered per agent with its command, its first-arg passthrough words and
// its any-position passthrough flags, written into <home>/bin/<command> on every boot, as the plugin is: upgrading the Hive changes what every
// terminal's agent does.

/** What a shim is made from (#924, #932): the agent's command, which names the file and the real CLI, its subcommands and its passthrough flags. */
export interface ShimAgent { command: string; subcommands: readonly string[]; shimFlags: readonly string[] }

export const BIN_DIR = 'bin'; // <home>/bin: first on every terminal's PATH
const COMMAND = '__HIVE_COMMAND__';
const SUBCOMMANDS = '__HIVE_SUBCOMMANDS__';
const FLAGS = '__HIVE_FLAGS__';
const SH = '__HIVE_SH__'; // the .cmd twin's sh.exe (#645)
export const BIN_MODE = 0o700; // <home>/bin and <home>/shell (#259): this user only
const SHIM_MODE = 0o755;

/** `assets/bin/shim` in the Hive's own checkout, resolved from dist/src/ as pluginSource is. */
export const shimSource = (): string => fileURLToPath(new URL('../../assets/bin/shim', import.meta.url));

/** `assets/bin/shim.cmd`, the shim's twin on Windows (#645). */
const shimCmdSource = (): string => fileURLToPath(new URL('../../assets/bin/shim.cmd', import.meta.url));

/** How a home's shims are written (#645): the platform, and the POSIX shell (posixShell().shell) the .cmd twin runs the shim under. The
 * caller reads process, so the win32 branch is tested on every OS. */
export interface ShimInstall { platform: NodeJS.Platform; sh: string }

/** The shim as written: the template with the agent's command, and its subcommands and its flags each as one `case` pattern. The values are
 * AGENTS' own, never the user's. */
export const renderShim = (template: string, agent: ShimAgent, sh: string): string =>
  template.replaceAll(COMMAND, agent.command).replaceAll(SUBCOMMANDS, agent.subcommands.join('|')).replaceAll(FLAGS, agent.shimFlags.join('|'))
    .replaceAll(SH, () => sh);

export const shimDir = (home: string): string => join(home, BIN_DIR);
export const shimPath = (home: string, agent: Pick<ShimAgent, 'command'>): string => join(shimDir(home), agent.command);

export const shimCmdPath = (home: string, agent: Pick<ShimAgent, 'command'>): string => `${shimPath(home, agent)}.cmd`;

/** Writes <home>/bin/<command>, executable, and on win32 its .cmd twin (#645), which PATHEXT finds for a program outside the Hive's
 * PowerShell; answers the POSIX shim's path. */
export async function installShim(home: string, agent: ShimAgent, { platform, sh }: ShimInstall): Promise<string> {
  await mkdir(shimDir(home), { recursive: true, mode: BIN_MODE });
  const path = shimPath(home, agent);
  await writeFile(path, renderShim(await readFile(shimSource(), 'utf8'), agent, sh));
  await chmod(path, SHIM_MODE); // writeFile's mode applies only to a new file
  // cmd.exe expands %NAME% while reading a line, so a % in the sh.exe path is written %%
  if (platform === 'win32') await writeFile(shimCmdPath(home, agent), renderShim(await readFile(shimCmdSource(), 'utf8'), agent, sh.replaceAll('%', '%%')));
  return path;
}

// What the shim's read loop cannot take: a line break would split one arg in two, or start a forged one
const LINE_BREAK = /[\r\n]/;

// An env line the shim's export takes as one assignment: a valid name (export would refuse another, or read it as an option) and no line break
const isEnvLine = ([name, value]: readonly [string, string]): boolean => ENV_NAME.test(name) && !LINE_BREAK.test(value);

/** The register's answer (#696, #876): the run id, the count of env lines in decimal, each NAME=value, then each arg the agent gets before the
 * user's own on a line of its own. The shim reads all of it as data and never evaluates it; a count, not a marker line, since an arg could
 * equal any marker. Undefined when an env line or an arg would not survive: the route refuses the register rather than send it. */
export const capturedReply = (runId: string, env: readonly (readonly [string, string])[], args: readonly string[]): string | undefined =>
  (env.every(isEnvLine) && !args.some((arg) => LINE_BREAK.test(arg))
    ? [runId, String(env.length), ...env.map(([name, value]) => `${name}=${value}`), ...args].join('\n')
    : undefined);

export const REFUSED_LINE = 'refused'; // #953: the reply's first line on a refused account; no run id (a uuid) can equal it
/** The register's refusal the shim exits on (#953): the marker, then the message's first line, which names no token. A 200: curl -f drops a 4xx body. */
export const refusedReply = (message: string): string => `${REFUSED_LINE}\n${message.split(/[\r\n]/)[0] ?? ''}`;

/** What the args the shim posted run (#347): a new conversation, or a resume, with the session id they name when they name one. */
export type ShimResume = { kind: 'new' } | { kind: 'resume'; sessionId?: string };

const NEW: ShimResume = { kind: 'new' };
const resumed = (sessionId: string | undefined): ShimResume => (sessionId === undefined ? { kind: 'resume' } : { kind: 'resume', sessionId });
const CLAUDE_RESUMES = ['-r', '--resume', '-c', '--continue', '--session-id'];
const CLAUDE_ID_FLAGS = ['-r', '--resume', '--session-id'];
const flagOf = (arg: string): string => (arg.startsWith('--') ? arg.split('=')[0] : arg);

// The uuid a value flag names, `--flag <id>` or `--flag=<id>`: only a uuid can be a session id (namedSession); the last one wins. Claude's
// and Copilot's flags share the shape (#876)
function flagId(args: readonly string[], flags: readonly string[]): string | undefined {
  return args.flatMap((arg, i) => {
    const flag = flagOf(arg);
    const value = flag === arg ? args[i + 1] : arg.slice(flag.length + 1);
    return flags.includes(flag) && isUuid(value) ? [value] : [];
  }).at(-1);
}

// Claude: --fork-session starts a new conversation the Hive names, unless the user names it with --session-id: a second one in the reply
// would leave the worker on an id the run never uses. A named fork runs its --session-id, never the session it forks from
function claudeResume(args: readonly string[]): ShimResume {
  const flags = args.map(flagOf);
  if (!flags.some((flag) => CLAUDE_RESUMES.includes(flag))) return NEW;
  if (!flags.includes('--fork-session')) return resumed(flagId(args, CLAUDE_ID_FLAGS));
  return flags.includes('--session-id') ? resumed(flagId(args, ['--session-id'])) : NEW;
}

// Codex: the resume subcommand, first as the shim reads a subcommand; fork stays a passthrough (#932)
const codexResume = (args: readonly string[]): ShimResume => (args[0] === 'resume' ? resumed(args.slice(1).find((arg) => isUuid(arg))) : NEW);

// Copilot (#876): --session-id is the run's id whether it continues a session or starts one (spike §3); --continue and the picker name none
const COPILOT_RESUMES = ['--resume', '--continue', '--session-id'];
const COPILOT_ID_FLAGS = ['--resume', '--session-id'];
const copilotResume = (args: readonly string[]): ShimResume =>
  (args.some((arg) => COPILOT_RESUMES.includes(flagOf(arg))) ? resumed(flagId(args, COPILOT_ID_FLAGS)) : NEW);

// One reader per agent: a new agent fails to compile until it has one
const RESUME_READERS: Record<AgentId, (args: readonly string[]) => ShimResume> = { claude: claudeResume, codex: codexResume, copilot: copilotResume };

/** The resume the args the shim posted ask for (#347). The shim parses nothing (sh cannot parse an argv safely): it posts every arg whole. */
export const resumeOf = (agent: AgentId, args: readonly string[]): ShimResume => RESUME_READERS[agent](args);
