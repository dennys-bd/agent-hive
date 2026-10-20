import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUuid } from './uuid.js';
import type { AgentId } from './types.js';

// The agents' shim (#696, #924, #932): one template, assets/bin/shim, rendered per agent with its command, its first-arg passthrough words and
// its any-position passthrough flags, written into <home>/bin/<command> on every boot, as the plugin is: upgrading the Hive changes what every
// terminal's agent does.

/** What a shim is made from (#924, #932): the agent's command, which names the file and the real CLI, its subcommands and its passthrough flags. */
export interface ShimAgent { command: string; subcommands: readonly string[]; shimFlags: readonly string[] }

export const BIN_DIR = 'bin'; // <home>/bin: first on every terminal's PATH
const COMMAND = '__HIVE_COMMAND__';
const SUBCOMMANDS = '__HIVE_SUBCOMMANDS__';
const FLAGS = '__HIVE_FLAGS__';
export const BIN_MODE = 0o700; // <home>/bin and <home>/shell (#259): this user only
const SHIM_MODE = 0o755;

/** `assets/bin/shim` in the Hive's own checkout, resolved from dist/src/ as pluginSource is. */
export const shimSource = (): string => fileURLToPath(new URL('../../assets/bin/shim', import.meta.url));

/** The shim as written: the template with the agent's command, and its subcommands and its flags each as one `case` pattern. The values are
 * AGENTS' own, never the user's. */
export const renderShim = (template: string, agent: ShimAgent): string =>
  template.replaceAll(COMMAND, agent.command).replaceAll(SUBCOMMANDS, agent.subcommands.join('|')).replaceAll(FLAGS, agent.shimFlags.join('|'));

export const shimDir = (home: string): string => join(home, BIN_DIR);
export const shimPath = (home: string, agent: Pick<ShimAgent, 'command'>): string => join(shimDir(home), agent.command);

/** Writes <home>/bin/<command>, executable; answers its path. */
export async function installShim(home: string, agent: ShimAgent): Promise<string> {
  await mkdir(shimDir(home), { recursive: true, mode: BIN_MODE });
  const path = shimPath(home, agent);
  await writeFile(path, renderShim(await readFile(shimSource(), 'utf8'), agent));
  await chmod(path, SHIM_MODE); // writeFile's mode applies only to a new file
  return path;
}

// What the shim's read loop cannot take: a line break would split one arg in two, or start a forged one
const LINE_BREAK = /[\r\n]/;

/** The register's answer (#696): the run id, then each arg claude gets before the user's own on a line of its own, which the shim reads as data
 * and never evaluates. Undefined when an arg holds a line break: the route refuses the register rather than send a split arg. */
export const capturedReply = (runId: string, args: string[]): string | undefined =>
  (args.some((arg) => LINE_BREAK.test(arg)) ? undefined : [runId, ...args].join('\n'));

/** What the args the shim posted run (#347): a new conversation, or a resume, with the session id they name when they name one. */
export type ShimResume = { kind: 'new' } | { kind: 'resume'; sessionId?: string };

const NEW: ShimResume = { kind: 'new' };
const resumed = (sessionId: string | undefined): ShimResume => (sessionId === undefined ? { kind: 'resume' } : { kind: 'resume', sessionId });
const CLAUDE_RESUMES = ['-r', '--resume', '-c', '--continue', '--session-id'];
const CLAUDE_ID_FLAGS = ['-r', '--resume', '--session-id'];
const flagOf = (arg: string): string => (arg.startsWith('--') ? arg.split('=')[0] : arg);

// The uuid a value flag of Claude's names, `--flag <id>` or `--flag=<id>`: only a uuid can be a session id (namedSession); the last one wins
function claudeId(args: readonly string[]): string | undefined {
  return args.flatMap((arg, i) => {
    const flag = flagOf(arg);
    const value = flag === arg ? args[i + 1] : arg.slice(flag.length + 1);
    return CLAUDE_ID_FLAGS.includes(flag) && isUuid(value) ? [value] : [];
  }).at(-1);
}

// Claude: --fork-session starts a new conversation the Hive names, unless the user names it with --session-id: a second one in the reply
// would leave the worker on an id the run never uses
function claudeResume(args: readonly string[]): ShimResume {
  const flags = args.map(flagOf);
  if (!flags.some((flag) => CLAUDE_RESUMES.includes(flag))) return NEW;
  return flags.includes('--fork-session') && !flags.includes('--session-id') ? NEW : resumed(claudeId(args));
}

// Codex: the resume subcommand, first as the shim reads a subcommand; fork stays a passthrough (#932)
const codexResume = (args: readonly string[]): ShimResume => (args[0] === 'resume' ? resumed(args.slice(1).find((arg) => isUuid(arg))) : NEW);

// One reader per agent: a new agent fails to compile until it has one
const RESUME_READERS: Record<AgentId, (args: readonly string[]) => ShimResume> = { claude: claudeResume, codex: codexResume };

/** The resume the args the shim posted ask for (#347). The shim parses nothing (sh cannot parse an argv safely): it posts every arg whole. */
export const resumeOf = (agent: AgentId, args: readonly string[]): ShimResume => RESUME_READERS[agent](args);
