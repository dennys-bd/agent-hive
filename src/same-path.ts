import { type Machine, pathsOf } from './machine.js';

/** A machine's flavour is one of two shared objects, so identity tells win32 from the rest without naming a platform. */
export const isWin32Paths = (paths: Machine['paths']): boolean => paths === pathsOf('win32');

/**
 * Whether two paths name the same folder as git and the OS report it (#640). On win32 git prints `C:/…` where the Hive builds `C:\…`:
 * resolve turns `/` into `\`, drops a trailing separator and collapses `..`, and NTFS ignores case. Elsewhere both are resolved and compared
 * exactly, as the filesystems the Hive targets do. No I/O: an 8.3 short name (`RUNNER~1`) is the caller's to resolve with realpath.native.
 */
export function samePath(a: string, b: string, paths: Machine['paths']): boolean {
  if (!isWin32Paths(paths)) return paths.resolve(a) === paths.resolve(b);
  return paths.resolve(a).toLowerCase() === paths.resolve(b).toLowerCase();
}
