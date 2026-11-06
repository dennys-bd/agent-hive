// The features that call an OS tool (#658). The platform is a parameter, so the mapping is tested without faking the OS and each call site
// stays one line. Every value is an argv element for execFile, never part of a shell string.
import { dirname, win32 } from 'node:path';

export type PlatformCommand = readonly [file: string, args: readonly string[]];

// Windows' own tools by full path (#646), never through PATH, where a user's folder could shadow them; pwsh is only the user's terminal.
const windowsDir = (): string => process.env.SystemRoot ?? 'C:\\Windows';
const system32 = (...parts: string[]): string => win32.join(windowsDir(), 'System32', ...parts);

/** A PowerShell single-quoted literal: inside one only a quote is special, and PowerShell reads the curly ones as quotes too. */
const psLiteral = (value: string): string => `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;

/** -EncodedCommand, not -Command: under -Command every argument after the script is read as code, and the Windows command-line quoting
 *  of PowerShell 5.1 breaks on the double quotes Explorer's /select needs. Base64 of UTF-16LE has no character to quote. */
function powerShell(lines: readonly string[]): PlatformCommand {
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
  return [system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]];
}

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, in decimal: PowerShell 5.1 reads 0x80000003 as a negative Int32, no uint
const KEEP_AWAKE_FLAGS = 2147483651;

function windowsKeepAwake(pid: number): PlatformCommand {
  if (!Number.isInteger(pid)) throw new Error(`Not a pid: ${pid}`);
  return powerShell([
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -Namespace AgentHive -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
    `[void][AgentHive.Power]::SetThreadExecutionState(${KEEP_AWAKE_FLAGS})`,
    `Wait-Process -Id ${pid}`,
  ]);
}

// ponytail: OnlyErrorDialogs is the only UIOption that lets VisualBasic pick the recycle bin, so a locked file shows Windows' own retry
// dialog in the user's session and the route waits on it; a P/Invoke of SHFileOperation with FOF_NOERRORUI if that ever blocks a run.
function windowsTrash(paths: readonly string[]): PlatformCommand {
  return powerShell([
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `foreach ($p in @(${paths.map(psLiteral).join(', ')})) {`,
    "  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    "  else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    '}',
  ]);
}

/** Shut down when done (#233). Neither needs sudo: macOS asks for the Automation permission on the first run, and logind lets a local
 *  active session power off. Either can refuse (an app with unsaved work, an SSH session, a polkit denial); the caller shows the refusal. */
export function shutdownCommand(platform: NodeJS.Platform): PlatformCommand {
  if (platform === 'darwin') return ['osascript', ['-e', 'tell application "System Events" to shut down']];
  if (platform === 'linux') return ['systemctl', ['poweroff']];
  if (platform === 'win32') return [system32('shutdown.exe'), ['/s', '/t', '0']];
  throw new Error(`Shutdown is not supported on ${platform}`);
}

/** Keep awake (#226): the command holds the power assertion until it is killed, and ends on its own when the daemon's pid does, so a crash
 *  leaves nothing behind. caffeinate -di keeps the display and the machine awake. Linux's idle:sleep keeps the machine awake but does not
 *  guarantee the display stays on: a known gap, the titles keep the handoff's wording. Windows holds both, as macOS does (#646). */
export function keepAwakeCommand(platform: NodeJS.Platform, pid: number): PlatformCommand {
  if (platform === 'darwin') return ['caffeinate', ['-di', '-w', String(pid)]];
  if (platform === 'linux') return ['systemd-inhibit', ['--what=idle:sleep', '--why=Agent Hive keep awake', 'tail', `--pid=${pid}`, '-f', '/dev/null']];
  if (platform === 'win32') return windowsKeepAwake(pid);
  throw new Error(`Keep awake is not supported on ${platform}`);
}

/** The files tree's reveal (#629). xdg-open opens the folder itself instead of selecting it in its parent as open -R does: D-Bus
 *  FileManager1.ShowItems would select it, but it depends on the file manager and needs a fallback. A file would be launched by xdg-open,
 *  so for one (#818) it opens the file's folder. */
export function revealCommand(platform: NodeJS.Platform, path: string, isFile = false): PlatformCommand {
  if (platform === 'darwin') return ['open', ['-R', path]];
  if (platform === 'linux') return ['xdg-open', [isFile ? dirname(path) : path]];
  // explorer.exe exits 1 even when it opened the folder, so Start-Process runs it and answers 0; a path holds no ", so the quotes are safe
  if (platform === 'win32') return powerShell([`Start-Process -FilePath ${psLiteral(win32.join(windowsDir(), 'explorer.exe'))} -ArgumentList ('/select,"' + ${psLiteral(path)} + '"')`]);
  throw new Error(`Reveal is not supported on ${platform}`);
}

/** The files tree's delete (#818): to the system trash, so Finder's Put Back still works. /usr/bin/trash ships with macOS 14 and later and
 *  takes the paths alone (each is absolute, so none reads as an option); gio comes with GLib. A missing binary fails the execFile, and the
 *  route answers 500 with its words, as reveal does. */
export function trashCommand(platform: NodeJS.Platform, paths: readonly string[]): PlatformCommand {
  if (platform === 'darwin') return ['/usr/bin/trash', [...paths]];
  if (platform === 'linux') return ['gio', ['trash', '--', ...paths]];
  if (platform === 'win32') return windowsTrash(paths);
  throw new Error(`Trash is not supported on ${platform}`);
}
