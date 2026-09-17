import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openItermTab, shellQuote } from './spawn-iterm.js';
import type { Exec } from './types.js';

const execFileAsync: Exec = promisify(execFile);
const DEFAULT_LINUX_TERMINAL = 'x-terminal-emulator'; // the Debian alternative; xterm, urxvt, konsole and xfce4-terminal all take `-e cmd args…`
// Every Mac has Terminal.app: `do script` opens a window running the line, `activate` brings it to the front.
const TERMINAL_APP_SCRIPT = `
on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run`;

export interface TerminalDeps {
  exec: Exec;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

async function openDarwin(command: string, exec: Exec): Promise<void> {
  try {
    await openItermTab(command, exec);
  } catch {
    await exec('osascript', ['-e', TERMINAL_APP_SCRIPT, command]); // iTerm2 missing or refused: a Terminal.app failure propagates
  }
}

/** Opens `argv` in a terminal the user can type into: an iTerm2 tab or a Terminal.app window on macOS, `$TERMINAL` on Linux. */
export async function openTerminal(argv: string[], deps: Partial<TerminalDeps> = {}): Promise<void> {
  const { exec = execFileAsync, platform = process.platform, env = process.env } = deps;
  if (platform === 'darwin') {
    // AppleScript types one line into a shell: the argv becomes a shell string here and only here
    await openDarwin(argv.map(shellQuote).join(' '), exec);
    return;
  }
  if (platform === 'linux') {
    await exec(env.TERMINAL ?? DEFAULT_LINUX_TERMINAL, ['-e', ...argv]);
    return;
  }
  throw new Error(`terminal não suportado em ${platform}`);
}
