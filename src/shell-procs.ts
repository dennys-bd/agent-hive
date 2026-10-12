import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { AGENTS } from './agents.js';
import { AGENT_IDS, type Exec } from './types.js';

// What runs under a terminal's pty (#696): the pty runs `sh -c`, whose child is the user's shell. Every read goes through `Exec` with argv,
// and a failure answers nothing: a cwd that cannot be read keeps the one the terminal held.

/** The pids of `pid`'s children (pgrep -P), in pgrep's order; [] when it has none or pgrep fails. */
export async function childPids(pid: number, exec: Exec): Promise<number[]> {
  try {
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

/** A terminal's shell cwd (#696): the shell under the pty's `sh -c`, then its cwd; undefined when the pty, the shell or lsof gives none. */
export async function shellCwd(ptyPid: number | undefined, exec: Exec): Promise<string | undefined> {
  if (ptyPid === undefined) return undefined;
  const [shell] = await childPids(ptyPid, exec);
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

// The agent a command line runs: its program, or the script an interpreter (node) runs, named as one of AGENTS' commands
function agentIn(line: string): string | undefined {
  const [program = '', script = ''] = line.split(/\s+/);
  const names = [basename(program), basename(script)];
  return AGENT_IDS.map((id) => AGENTS[id].command).find((command) => names.includes(command));
}

/** The agents running in a terminal that no captured session accounts for (#696): the shell's children and theirs, whose command is an
 * agent's. A shim's own line is skipped, and so is its child (#932): a registered run is the shim's child, while a refused or passthrough one
 * execs, so it is the shell's. A line naming a captured session's id is the Hive's. */
export async function strayAgents(ptyPid: number | undefined, o: { captured: readonly string[]; shims: readonly string[] }, exec: Exec): Promise<string[]> {
  if (ptyPid === undefined) return [];
  const [shell] = await childPids(ptyPid, exec);
  if (shell === undefined) return [];
  const isShim = (line: string): boolean => o.shims.some((shim) => line.includes(shim));
  const children = await commandLines(shell, exec);
  const grandchildren = await Promise.all(children.map(async (child) => (isShim(child.line) ? [] : commandLines(child.pid, exec))));
  return [...children, ...grandchildren.flat()].flatMap(({ line }) => {
    const agent = agentIn(line);
    const isHeld = isShim(line) || o.captured.some((id) => line.includes(id));
    return agent === undefined || isHeld ? [] : [agent];
  });
}
