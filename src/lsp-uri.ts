// file:// URIs of the paths a language server reads (#780), shared by the daemon (initialize's root) and the page (each model's document).
// macOS only, so a path is POSIX. No node import: the page reads it too.

/** An absolute path as a file:// URI, each segment percent-encoded. */
export const fileUri = (path: string): string => `file://${path.split('/').map(encodeURIComponent).join('/')}`;

/** A file:// URI's absolute path; undefined for another scheme or a bad escape. */
export function pathOfUri(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  try {
    return uri.slice('file://'.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    return undefined;
  }
}

/** A path as the pane names it (#697: relative to the root, `../`, or absolute), absolute against `root` and normalised. */
export function absoluteOf(root: string, path: string): string {
  const kept: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${root}/${path}`).split('/')) {
    if (part === '..') kept.pop();
    else if (part !== '' && part !== '.') kept.push(part);
  }
  return `/${kept.join('/')}`;
}

/** An absolute path as the pane names it: relative under `root`, absolute outside it. */
export const paneOf = (root: string, path: string): string => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);
