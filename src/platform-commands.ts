// The features that call an OS tool (#658). The platform is a parameter, so the mapping is tested without faking the OS and each call site
// stays one line. Every value is an argv element for execFile, never part of a shell string.
import { dirname } from 'node:path';

export type PlatformCommand = readonly [file: string, args: readonly string[]];

/** Shut down when done (#233). Neither needs sudo: macOS asks for the Automation permission on the first run, and logind lets a local
 *  active session power off. Either can refuse (an app with unsaved work, an SSH session, a polkit denial); the caller shows the refusal. */
export function shutdownCommand(platform: NodeJS.Platform): PlatformCommand {
  if (platform === 'darwin') return ['osascript', ['-e', 'tell application "System Events" to shut down']];
  if (platform === 'linux') return ['systemctl', ['poweroff']];
  throw new Error(`Shutdown is not supported on ${platform}`);
}

/** Keep awake (#226): the command holds the power assertion until it is killed, and ends on its own when the daemon's pid does, so a crash
 *  leaves nothing behind. caffeinate -di keeps the display and the machine awake. Linux's idle:sleep keeps the machine awake but does not
 *  guarantee the display stays on: a known gap, the titles keep the handoff's wording. */
export function keepAwakeCommand(platform: NodeJS.Platform, pid: number): PlatformCommand {
  if (platform === 'darwin') return ['caffeinate', ['-di', '-w', String(pid)]];
  if (platform === 'linux') return ['systemd-inhibit', ['--what=idle:sleep', '--why=Agent Hive keep awake', 'tail', `--pid=${pid}`, '-f', '/dev/null']];
  throw new Error(`Keep awake is not supported on ${platform}`);
}

/** The files tree's reveal (#629). xdg-open opens the folder itself instead of selecting it in its parent as open -R does: D-Bus
 *  FileManager1.ShowItems would select it, but it depends on the file manager and needs a fallback. A file would be launched by xdg-open,
 *  so for one (#818) it opens the file's folder. */
export function revealCommand(platform: NodeJS.Platform, path: string, isFile = false): PlatformCommand {
  if (platform === 'darwin') return ['open', ['-R', path]];
  if (platform === 'linux') return ['xdg-open', [isFile ? dirname(path) : path]];
  throw new Error(`Reveal is not supported on ${platform}`);
}

/** The files tree's delete (#818): to the system trash, so Finder's Put Back still works. /usr/bin/trash ships with macOS 14 and later and
 *  takes the paths alone (each is absolute, so none reads as an option); gio comes with GLib. A missing binary fails the execFile, and the
 *  route answers 500 with its words, as reveal does. */
export function trashCommand(platform: NodeJS.Platform, paths: readonly string[]): PlatformCommand {
  if (platform === 'darwin') return ['/usr/bin/trash', [...paths]];
  if (platform === 'linux') return ['gio', ['trash', '--', ...paths]];
  throw new Error(`Trash is not supported on ${platform}`);
}
