import { posix, win32 } from 'node:path';

/**
 * Whether two paths name the same folder as git and the OS report it (#640). On win32 git prints `C:/…` where the Hive builds `C:\…`:
 * resolve turns `/` into `\`, drops a trailing separator and collapses `..`, and NTFS ignores case. Elsewhere both are resolved and compared
 * exactly, as the filesystems the Hive targets do. No I/O: an 8.3 short name (`RUNNER~1`) is the caller's to resolve with realpath.native.
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return posix.resolve(a) === posix.resolve(b);
  return win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
}
