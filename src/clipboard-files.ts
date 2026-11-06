import { fileURLToPath } from 'node:url';

// Finder's ⌘C puts the files on the pasteboard as a plist (NSFilenamesPboardType, every path) and, for the first one, a file:// URL
// (public.file-url). Electron's clipboard needs no window, but the sandboxed preload cannot reach it, so main reads and this module parses.
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] !== '#') return XML_ENTITIES[name.toLowerCase()] ?? whole;
    return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
  });

const fileUrlPath = (url: string): string | undefined => {
  try {
    return fileURLToPath(url.trim());
  } catch {
    return undefined; // not a file:// URL (text on the clipboard)
  }
};

/** The absolute paths Finder put on the clipboard: the plist's <string> entries, else the single file URL; [] when it holds no files. */
export function parseClipboardFiles(plist: string, fileUrl: string): string[] {
  const paths = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => decodeEntities(match[1])).filter((path) => path.startsWith('/'));
  if (paths.length > 0) return paths;
  const single = fileUrl.trim() === '' ? undefined : fileUrlPath(fileUrl);
  return single ? [single] : [];
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const encodeEntities = (text: string): string => text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);

/** The plist Finder's ⌘C writes as NSFilenamesPboardType (#818): every path a <string>, escaped; what parseClipboardFiles reads back. */
export function clipboardFilesPlist(paths: readonly string[]): string {
  const strings = paths.map((path) => `<string>${encodeEntities(path)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array>${strings}</array></plist>`;
}

export const CLIPBOARD_FILES_MAX = 5000; // a pasteboard plist of more is a runaway selection, not a copy
// Control characters but tab, newline and carriage return: the plist is XML, where the rest are not even valid
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to match control characters
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

// A Windows path is absolute with a drive letter and a separator (`C:\a`, `C:/a`) or as UNC (`\\server\share`); `\a` and `C:a` hang on the
// current drive or directory, so a paste elsewhere would land them somewhere else.
const WIN32_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/;
const isAbsoluteFor = (path: string, platform: NodeJS.Platform): boolean => (platform === 'win32' ? WIN32_ABSOLUTE.test(path) : path.startsWith('/'));

/** Whether the IPC's paths may reach the clipboard (#818, #650): IPC is untrusted, so a non-empty, bounded list of absolute paths (the
 *  platform's own kind) without control characters. */
export const isClipboardPathList = (paths: unknown, platform: NodeJS.Platform): paths is string[] =>
  Array.isArray(paths) && paths.length > 0 && paths.length <= CLIPBOARD_FILES_MAX
  && paths.every((path) => typeof path === 'string' && isAbsoluteFor(path, platform) && !CONTROL_CHARACTERS.test(path));

// A DROPFILES struct (CF_HDROP): uint32 pFiles (offset of the list), POINT pt, BOOL fNC, BOOL fWide, then the list
const DROPFILES_HEADER_BYTES = 20;
const DROPFILES_WIDE_OFFSET = 16;

/** The paths of a CF_HDROP buffer (#650): [] for anything but a well-formed wide list. A list cut before its double null yields only the
 *  paths that end in a null, since the last one may be half a path. */
export function parseDropFiles(buffer: Buffer): string[] {
  if (buffer.length < DROPFILES_HEADER_BYTES) return [];
  const start = buffer.readUInt32LE(0);
  if (start < DROPFILES_HEADER_BYTES || start >= buffer.length || buffer.readInt32LE(DROPFILES_WIDE_OFFSET) === 0) return [];
  const chars = buffer.subarray(start, start + Math.floor((buffer.length - start) / 2) * 2).toString('utf16le');
  const terminated = chars.slice(0, chars.lastIndexOf('\0') + 1);
  const end = terminated.indexOf('\0\0');
  return (end === -1 ? terminated : terminated.slice(0, end)).split('\0').filter((path) => path !== '');
}

/** The CF_HDROP buffer Explorer pastes (#650): the header, each path in UTF-16LE with its null, and the list's closing null. */
export function dropFilesBuffer(paths: readonly string[]): Buffer {
  const header = Buffer.alloc(DROPFILES_HEADER_BYTES);
  header.writeUInt32LE(DROPFILES_HEADER_BYTES, 0);
  header.writeInt32LE(1, DROPFILES_WIDE_OFFSET);
  return Buffer.concat([header, Buffer.from(`${paths.map((path) => `${path}\0`).join('')}\0`, 'utf16le')]);
}
