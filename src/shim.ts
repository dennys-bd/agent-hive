import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The agents' shim (#696, #924, #932): one template, assets/bin/shim, rendered per agent with its command, its first-arg passthrough words and
// its any-position passthrough flags, written into <home>/bin/<command> on every boot, as the plugin is: upgrading the Hive changes what every
// terminal's agent does.

/** What a shim is made from (#924, #932): the agent's command, which names the file and the real CLI, its subcommands and its passthrough flags. */
export interface ShimAgent { command: string; subcommands: readonly string[]; shimFlags: readonly string[] }

export const BIN_DIR = 'bin'; // <home>/bin: first on every terminal's PATH
const COMMAND = '__HIVE_COMMAND__';
const SUBCOMMANDS = '__HIVE_SUBCOMMANDS__';
const FLAGS = '__HIVE_FLAGS__';
const BIN_MODE = 0o700;
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
