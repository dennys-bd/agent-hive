import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workerCommand } from './spawn-iterm.js';
import { workerEnv } from './spawn.js';
import { openTerminal } from './terminal.js';
import type { Exec, WorkerHandle, WorkerHandlers, WorkerLaunch } from './types.js';

const execFileAsync: Exec = promisify(execFile);
export const TMUX_SOCKET = 'hive'; // a server of the Hive's own: isolated from the user's tmux, born with the worker env
const SESSION_COLS = '200'; // detached, a session would be 80x24 and the scrollback would wrap at 80 when a terminal attaches
const SESSION_ROWS = '50';

export interface TmuxDeps {
  exec: Exec;
  openTerminal(argv: string[]): Promise<void>;
}

const tmuxArgs = (...args: string[]): string[] => ['-L', TMUX_SOCKET, ...args];

/** What the terminal runs to show a worker: `-d` detaches any other client, so the newest terminal wins the size. */
export function attachArgv(slug: string): string[] {
  return ['tmux', ...tmuxArgs('attach', '-d', '-t', slug)];
}

/**
 * A worker in a detached tmux session named after the slug: `claude` gets a real TTY (permission prompts, questions) and
 * the terminal opens only on focus. The command is the same shell string iTerm types; tmux runs it through the shell,
 * so it travels as one argv element. Its `; curl /hooks/exit` trailer reports the natural exit.
 */
export function spawnTmuxWorker(launch: WorkerLaunch, handlers: WorkerHandlers, deps: Partial<TmuxDeps> = {}): WorkerHandle {
  const { exec = execFileAsync, openTerminal: open = openTerminal } = deps;
  const { slug } = launch;
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    handlers.onExit();
  };
  const report = (err: Error): void => handlers.onLine(`stderr: tmux: ${err.message}`);
  const session = exec('tmux', tmuxArgs(
    'new-session', '-d', '-s', slug, '-c', launch.repo, '-x', SESSION_COLS, '-y', SESSION_ROWS, workerCommand(launch),
  ), { env: workerEnv(process.env, launch.workerId, launch.port) }).catch((err: Error) => {
    report(err); // tmux missing or the name taken: the worker never started, free the slot
    exitOnce();
  });
  return {
    send: () => {}, // interactive claude: the human types in the terminal
    end: () => {}, // nothing to close; the session ends with the command
    // kill-session SIGHUPs the shell, so the curl trailer never runs: the handle reports the exit itself, after the kill
    kill: () => void session.then(() => exec('tmux', tmuxArgs('kill-session', '-t', slug))).catch(report).then(() => exitOnce()),
    focus: () => session.then(() => open(attachArgv(slug))),
  };
}
