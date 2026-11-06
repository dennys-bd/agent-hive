// file:// URIs of the paths a language server reads (#780), shared by the daemon (initialize's root) and the page (each model's document).
// A path is POSIX, or a Windows drive path told by its shape (#642). No node import and no platform: the page reads it too.

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const DRIVE_SEGMENT = /^[A-Za-z]:$/;
const SEPARATORS = /[\\/]/;

/** A Windows absolute path (#642): a drive letter, a colon, a separator. A UNC path is not one (out of #642). */
export const isDrivePath = (path: string): boolean => DRIVE_PATH.test(path);

// Native, its letter upper-cased (#642): a server may write c%3A, and the path must match the root the daemon sent, C:\…
const nativeDrive = (drive: string, rest: readonly string[]): string => `${drive.toUpperCase()}\\${rest.join('\\')}`;

/** An absolute path as a file:// URI, each segment percent-encoded; a drive path as RFC 8089 writes it, file:///C:/…, its C: raw (#642). */
export function fileUri(path: string): string {
  if (!isDrivePath(path)) return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
  const [drive, ...rest] = path.split(SEPARATORS);
  return `file:///${[drive, ...rest.map(encodeURIComponent)].join('/')}`;
}

/** A file:// URI's absolute path; undefined for another scheme or a bad escape. A drive's, its C: raw or escaped, reads back native (#642). */
export function pathOfUri(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  try {
    const segments = uri.slice('file://'.length).split('/').map(decodeURIComponent);
    const [lead, drive, ...rest] = segments;
    return lead === '' && drive !== undefined && DRIVE_SEGMENT.test(drive) ? nativeDrive(drive, rest) : segments.join('/');
  } catch {
    return undefined;
  }
}

// '.' and empty segments dropped, each '..' takes back the one before it and never more: the root's parent is the root
function resolved(parts: readonly string[]): string[] {
  const kept: string[] = []; // local to this call, so the push below mutates nothing shared
  for (const part of parts) {
    if (part === '..') kept.pop();
    else if (part !== '' && part !== '.') kept.push(part);
  }
  return kept;
}

/** A path as the pane names it (#697: relative to the root, `../`, or absolute), absolute against `root` and normalised. On a drive root
 *  (#642) the pane's `/` and the root's `\` both split, and the result is native, never above the drive. */
export function absoluteOf(root: string, path: string): string {
  if (!isDrivePath(root)) return `/${resolved((path.startsWith('/') ? path : `${root}/${path}`).split('/')).join('/')}`;
  const [drive, ...rest] = (isDrivePath(path) ? path : `${root}\\${path}`).split(SEPARATORS);
  return nativeDrive(drive, resolved(rest));
}

// Under a drive root (#642): the letter compared in either case, as pathOfUri upper-cases it and a root may not; relative with '/', as the wire wants
function paneOnDrive(root: string, path: string): string {
  const isUnder = path.slice(0, 1).toUpperCase() === root.slice(0, 1).toUpperCase() && path.slice(1).startsWith(`${root.slice(1)}\\`);
  return isUnder ? path.slice(root.length + 1).replaceAll('\\', '/') : path;
}

/** An absolute path as the pane names it: relative under `root`, absolute outside it. */
export function paneOf(root: string, path: string): string {
  if (isDrivePath(root)) return paneOnDrive(root, path);
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
