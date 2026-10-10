// What the editor pane holds as text (#717, #668): UTF-8 only and no NUL early on, since a lossy decode would corrupt the file on save. The
// editor's read decodes the file's bytes; the base route checks git's stdout, which execFile has already decoded.

const NUL_SCAN = 8192; // a NUL this early says binary, as git's own check does
const REPLACEMENT = '�'; // what a UTF-8 decode writes for a byte it cannot read

/** The bytes as text, or undefined for what the pane cannot hold: a NUL early on, or anything that is not UTF-8. ignoreBOM keeps a BOM in the
 * text, so the save writes it back (#717). */
export function decodeText(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, NUL_SCAN).includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** git's stdout as the editor would hold it (#668), or undefined for a binary or not-UTF-8 blob.
 * ponytail: execFile decodes as it reads, so a byte that is not UTF-8 shows only as U+FFFD, and a file that holds a real U+FFFD reads as not
 * UTF-8 too; read the blob as bytes (an Exec that answers a Buffer) if that ever bites. */
export function holdableText(text: string): string | undefined {
  return text.slice(0, NUL_SCAN).includes('\0') || text.includes(REPLACEMENT) ? undefined : text;
}
