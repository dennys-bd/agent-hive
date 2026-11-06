import { stat } from 'node:fs/promises';
import { basename, win32 } from 'node:path';
import { AGENTS } from './agents.js';
import { AGENT_IDS, type Exec } from './types.js';
import { childrenOf, listProcesses, type ProcessRow, subtree } from './win-procs.js';

// What runs under a terminal's pty (#696): the pty runs `sh -c`, whose child is the user's shell. Every read goes through `Exec` with argv,
// and a failure answers nothing: a cwd that cannot be read keeps the one the terminal held. On win32 (#638) there is no pgrep or lsof: one
// PowerShell listing of the process table answers instead (src/win-procs.ts), and no cwd is read.

/** The pids of `pid`'s children: pgrep -P in pgrep's order, on win32 the listing's in pid order; [] when it has none or the read fails. */
export async function childPids(pid: number, exec: Exec, platform: NodeJS.Platform): Promise<number[]> {
  try {
    if (platform === 'win32') return childrenOf(await listProcesses(exec), pid);
    const { stdout } = await exec('pgrep', ['-P', String(pid)]);
    return stdout.split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number);
  } catch {
    return [];
  }
}

/** A process's cwd as lsof prints it in field mode (`n<path>`); undefined when lsof fails or names none. */
export async function processCwd(pid: number, exec: Exec): Promise<string | undefined> {
  try {
    const { stdout } = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    return stdout.split('\n').find((line) => line.startsWith('n') && line.length > 1)?.slice(1);
  } catch {
    return undefined;
  }
}

/** A terminal's shell cwd (#696): the shell under the pty's `sh -c`, then its cwd; undefined when the pty, the shell or lsof gives none.
 *  On win32 undefined without a call: no stock Windows tool reads another process's cwd, so the terminal wakes in its start dir (#638). */
export async function shellCwd(ptyPid: number | undefined, exec: Exec, platform: NodeJS.Platform): Promise<string | undefined> {
  if (ptyPid === undefined || platform === 'win32') return undefined;
  const [shell] = await childPids(ptyPid, exec, platform);
  return shell === undefined ? undefined : processCwd(shell, exec);
}

/** Where a terminal wakes (#696): the cwd it held while that directory is still on disk, else its start dir. */
export async function wakeDir(cwd: string, startDir: string): Promise<string> {
  const isDir = await stat(cwd).then((found) => found.isDirectory(), () => false);
  return isDir ? cwd : startDir;
}

// `pgrep -lf -P <pid>`: each child as its pid and its command line (macOS prints the full argv with -f); [] when it has none
async function commandLines(pid: number, exec: Exec): Promise<{ pid: number; line: string }[]> {
  try {
    const { stdout } = await exec('pgrep', ['-lf', '-P', String(pid)]);
    return stdout.split('\n').flatMap((raw) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(raw);
      return match ? [{ pid: Number(match[1]), line: match[2] }] : [];
    });
  } catch {
    return [];
  }
}

const AGENT_COMMANDS = AGENT_IDS.map((id) => AGENTS[id].command);

// The agent a command line runs: its program, or the script an interpreter (node) runs, named as one of AGENTS' commands
function agentIn(line: string): string | undefined {
  const [program = '', script = ''] = line.split(/\s+/);
  const names = [basename(program), basename(script)];
  return AGENT_COMMANDS.find((command) => names.includes(command));
}

// A word with its quotes respected, quotes dropped: `"C:\Users\a b\claude.exe"` is one word
const WIN_WORD = /(?:"[^"]*"|[^\s"])+/g;
// cmd.exe /c's quoted payload is a whole command line ("…\claude.cmd --resume x"): its program ends at the first launchable extension
const WIN_PROGRAM = /^.*?\.(?:exe|cmd|bat)(?=\s|$)/i;
const WIN_EXT = /\.(?:exe|cmd|bat)$/i;

const winName = (word: string): string => win32.basename(WIN_PROGRAM.exec(word)?.[0] ?? word).replace(WIN_EXT, '').toLowerCase();

// win32's agentIn (#638): the program, or the first later word that is not a switch (an interpreter's script, cmd.exe /c's payload), named
// case-insensitively and without .exe/.cmd/.bat as one of AGENTS' commands. Any later word would count `git grep claude`.
function winAgentIn(line: string): string | undefined {
  const [program = '', ...rest] = (line.match(WIN_WORD) ?? []).map((word) => word.replaceAll('"', ''));
  const script = rest.find((word) => !word.startsWith('/') && !word.startsWith('-')) ?? '';
  const names = [winName(program), winName(script)];
  return AGENT_COMMANDS.find((command) => names.includes(command));
}

/** What a terminal's captured runs account for: the session ids the Hive holds and every agent's shim. */
export interface Held { readonly captured: readonly string[]; readonly shims: readonly string[] }

const isShim = (held: Held, line: string): boolean => held.shims.some((shim) => line.includes(shim));

// The agents these lines run that neither a shim nor a captured session holds; `form` is how a line is compared with what is held
function unheld(lines: readonly string[], held: Held, agentOf: (line: string) => string | undefined, form = (line: string): string => line): string[] {
  return lines.flatMap((line) => {
    const agent = agentOf(line);
    const isHeld = isShim(held, form(line)) || held.captured.some((id) => form(line).includes(id));
    return agent === undefined || isHeld ? [] : [agent];
  });
}

// Windows paths compare case-insensitively and with either slash, so a shim's path and a line are compared in one form
const winForm = (text: string): string => text.toLowerCase().replaceAll('/', '\\');

// win32 (#638): Git's bin\sh.exe starts usr\bin\sh.exe and the user's shell sits under that, so the levels are not fixed. The whole subtree
// is read from one listing, a shim's line pruned with all it holds.
async function winStrayAgents(ptyPid: number, held: Held, exec: Exec): Promise<string[]> {
  const rows = await listProcesses(exec).catch((): ProcessRow[] => []);
  const winHeld: Held = { captured: held.captured.map(winForm), shims: held.shims.map(winForm) };
  // only the comparison takes winForm: the agent is read from the line as is, whose cmd.exe /c a slash swap would turn into \c
  const lines = subtree(rows, ptyPid, (row) => isShim(winHeld, winForm(row.line))).map((row) => row.line);
  return unheld(lines, winHeld, winAgentIn, winForm);
}

/** The agents running in a terminal that no captured session accounts for (#696): the shell's children and theirs, whose command is an
 * agent's. A shim's own line is skipped, and so is its child (#932): a registered run is the shim's child, while a refused or passthrough one
 * execs, so it is the shell's. A line naming a captured session's id is the Hive's. On win32 the pty's whole subtree (#638). */
export async function strayAgents(ptyPid: number | undefined, held: Held, exec: Exec, platform: NodeJS.Platform): Promise<string[]> {
  if (ptyPid === undefined) return [];
  if (platform === 'win32') return winStrayAgents(ptyPid, held, exec);
  const [shell] = await childPids(ptyPid, exec, platform);
  if (shell === undefined) return [];
  const children = await commandLines(shell, exec);
  const grandchildren = await Promise.all(children.map(async (child) => (isShim(held, child.line) ? [] : commandLines(child.pid, exec))));
  return unheld([...children, ...grandchildren.flat()].map(({ line }) => line), held, agentIn);
}
