import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isStrayAlive, killStray } from './spawn.js';
import type { Exec, WorkerHandle, WorkerHandlers, WorkerLaunch } from './types.js';

const execFileAsync: Exec = promisify(execFile);
const ITERM_APP_ID = 'com.googlecode.iterm2';
const KILL_POLL_MS = 200;
const KILL_TIMEOUT_MS = 10_000;
const KILL_POLLS = KILL_TIMEOUT_MS / KILL_POLL_MS;

export interface ItermDeps {
  exec: Exec;
  sleep(ms: number): Promise<void>;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The one shell string in the repo: iTerm types it into a tab, so there is no argv to pass. Everything user-controlled goes
// through shellQuote; the args are the reducer's (workerArgs), quoted one by one.
export function workerCommand(o: WorkerLaunch): string {
  return [
    `cd ${shellQuote(o.repo)} &&`,
    `HIVE_WORKER_ID=${o.workerId} HIVE_PORT=${o.port} claude --settings ${shellQuote(o.hooksPath)}`,
    ...o.args.map(shellQuote),
    `"$(cat ${shellQuote(o.promptPath)})";`,
    `curl -s -m 2 -X POST http://127.0.0.1:${o.port}/hooks/exit -H 'x-hive-worker: ${o.workerId}' >/dev/null`,
  ].join(' ');
}

const OPEN_TAB_SCRIPT = `
on run argv
  tell application id "${ITERM_APP_ID}"
    activate
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current tab of current window
      write text (item 1 of argv)
      return unique id
    end tell
  end tell
end run`;

// Finds the session by its unique id (argv 1) and runs `action` on it; "not found" when the tab is gone.
const inSession = (action: string): string => `
on run argv
  tell application id "${ITERM_APP_ID}"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is (item 1 of argv) then
            ${action}
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
    return "not found"
  end tell
end run`;

const FOCUS_SCRIPT = inSession('activate\n            select t\n            set index of w to 1');

async function osascript(script: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script, ...args]);
  return stdout.trim();
}

/** Opens an iTerm2 tab typing `text` (a shell string) and resolves to the session's unique id. `terminal.ts` reuses it for the attach. */
export async function openItermTab(text: string, exec: Exec = execFileAsync): Promise<string> {
  const { stdout } = await exec('osascript', ['-e', OPEN_TAB_SCRIPT, text]);
  return stdout.trim();
}

async function inTab(sessionId: string, script: string, ...args: string[]): Promise<void> {
  if ((await osascript(script, sessionId, ...args)) !== 'ok') throw new Error(`iTerm session ${sessionId} not found`);
}

// pgrep by slug every 200 ms until nothing matches: the tab's shell only reaches its curl trailer once claude is gone, and a
// respawn of the same slug must not race the old process. False past the cap.
async function waitGone(slug: string, exec: Exec, wait: ItermDeps['sleep']): Promise<boolean> {
  for (let i = 0; i < KILL_POLLS; i += 1) {
    if (!(await isStrayAlive(slug, exec))) return true;
    await wait(KILL_POLL_MS);
  }
  return false;
}

/**
 * A worker in an iTerm2 tab. The exit comes from the `; curl /hooks/exit` at the end of the command, which the server
 * forwards to the pool; a kill goes through pkill by slug and resolves once pgrep no longer finds the process.
 */
export function spawnItermWorker(launch: WorkerLaunch, handlers: WorkerHandlers, deps: Partial<ItermDeps> = {}): WorkerHandle {
  const { exec = execFileAsync, sleep: wait = sleep } = deps;
  const report = (err: Error): void => handlers.onError(`iTerm: ${err.message}`);
  // iTerm missing or refused: the pool reports the rejection (spawnFailed). No onExit: the tab never existed.
  const session = openItermTab(workerCommand(launch), exec).then((id) => id, (err: Error) => {
    throw new Error(`iTerm: ${err.message}`);
  });
  let killing: Promise<void> | undefined;
  const kill = (): Promise<void> => {
    killing ??= killStray(launch.slug, exec)
      .then(() => waitGone(launch.slug, exec, wait))
      .then((gone) => {
        if (!gone) handlers.onError('kill: worker still alive after 10s');
      }, report);
    return killing;
  };
  return { started: session.then(() => undefined), kill, focus: () => session.then((id) => inTab(id, FOCUS_SCRIPT)) };
}
