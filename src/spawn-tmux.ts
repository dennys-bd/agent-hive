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
  let killing: Promise<void> | undefined;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    handlers.onExit();
  };
  const report = (err: Error): void => handlers.onError(`tmux: ${err.message}`);
  // tmux missing or the name taken: the pool reports the rejection (spawnFailed). No onExit: there never was a session.
  const started = exec('tmux', tmuxArgs(
    'new-session', '-d', '-s', slug, '-c', launch.repo, '-x', SESSION_COLS, '-y', SESSION_ROWS, workerCommand(launch),
  ), { env: workerEnv(process.env, launch.workerId, launch.port) }).then(() => undefined, (err: Error) => {
    throw new Error(`tmux: ${err.message}`);
  });
  // One kill per handle (a Stop racing the card's kill would fail on the gone session and put a false error in the bar). It resolves
  // once kill-session returned: tmux only answers after the session is destroyed, so a new-session of the same name may follow.
  // kill-session SIGHUPs the shell and the curl trailer never runs: the handle reports the exit itself, after the kill.
  const kill = (): Promise<void> => {
    killing ??= started.catch(() => undefined)
      .then(() => exec('tmux', tmuxArgs('kill-session', '-t', slug)))
      .then(() => undefined, report)
      .then(exitOnce);
    return killing;
  };
  return { started, kill, focus: () => started.then(() => open(attachArgv(slug))) };
}
