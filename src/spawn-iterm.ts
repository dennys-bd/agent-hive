import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { killStray } from './spawn.js';
import type { Exec, WorkerHandle, WorkerHandlers, WorkerLaunch } from './types.js';

const execFileAsync: Exec = promisify(execFile);
const ITERM_APP_ID = 'com.googlecode.iterm2';

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The one shell string in the repo: iTerm types it into a tab, so there is no argv to pass. Everything
// user-controlled goes through shellQuote; the slug is kebab-case by construction.
export function workerCommand(o: WorkerLaunch): string {
  const args = o.claudeArgs.map(shellQuote).join(' ');
  return [
    `cd ${shellQuote(o.repo)} &&`,
    `HIVE_WORKER_ID=${o.workerId} HIVE_PORT=${o.port} claude --worktree=${o.slug}`,
    `--settings ${shellQuote(o.hooksPath)}${args ? ` ${args}` : ''}`,
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
const WRITE_SCRIPT = inSession('tell s to write text (item 2 of argv)');

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

/**
 * A worker in an iTerm2 tab. Output never reaches the panel (onLine is unused) and the exit comes from the
 * `; curl /hooks/exit` at the end of the command, which the server forwards to the pool.
 */
export function spawnItermWorker(launch: WorkerLaunch, handlers: WorkerHandlers): WorkerHandle {
  const report = (err: Error): void => handlers.onLine(`stderr: iTerm: ${err.message}`);
  const session = openItermTab(workerCommand(launch)).catch((err: Error) => {
    report(err); // iTerm missing or refused: the worker never started, free the slot
    handlers.onExit();
    return undefined;
  });
  const withSession = (run: (id: string) => Promise<void>): Promise<void> =>
    session.then((id) => (id === undefined ? undefined : run(id)));
  return {
    send: (text) => void withSession((id) => inTab(id, WRITE_SCRIPT, text)).catch(report),
    end: () => {}, // interactive claude has no stdin to close; the human ends the session in the tab
    kill: () => void killStray(launch.slug).catch(report),
    focus: () => withSession((id) => inTab(id, FOCUS_SCRIPT)),
  };
}
