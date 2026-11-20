// The busca pane's search (#868): git grep over the activity's tree root and every nested repository under it, one process per repository,
// read as NDJSON per file. The match colouring is how one process gives both the line and every span git's own ERE matched: -o prints the
// match without its line. Every colour but the match's is pinned to normal (no escape at all), and the match's to an RGB no file plausibly holds.
import type { SearchMatch, SearchQuery } from './types.js';

export const MATCH_START = Buffer.from('\x1b[38;2;1;2;3m');
export const MATCH_END = Buffer.from('\x1b[m');
const NUL = 0x00;
const LF = 0x0a;
const BOM = '﻿';
const FATAL = 'fatal: ';
const PLAIN = ['filename', 'lineNumber', 'column', 'separator', 'selected', 'context', 'function', 'matchContext'];
// -c wins over the user's files: a grep.column=true or a color.grep.match of theirs changes nothing here
const PINS = [...PLAIN.map((slot) => `color.grep.${slot}=normal`), 'color.grep.matchSelected=#010203', 'grep.column=false', 'core.fsmonitor=false'];

export interface GrepLine { file: string; line: number; raw: Buffer; spans: [number, number][] }

/** git grep's argv for `cwd` (#868); paths: the replace's files, taken literally (a `:(top)` is a name). */
export function grepArgs(cwd: string, { q, isCaseSensitive, isWholeWord, isRegex }: SearchQuery, paths?: readonly string[]): string[] {
  const literal = paths === undefined ? [] : ['--literal-pathspecs'];
  const flags = [isRegex ? '-E' : '-F', ...(isCaseSensitive ? [] : ['-i']), ...(isWholeWord ? ['-w'] : [])];
  const scope = paths === undefined ? [] : ['--', ...paths];
  return ['--no-optional-locks', ...literal, '-C', cwd, ...PINS.flatMap((pin) => ['-c', pin]), 'grep', '--color=always', '-z', '-n', '-I', '--untracked', '--exclude-standard', ...flags, '-e', q, ...scope];
}

/** A coloured line without its markers (#868): the raw bytes and each match as a byte span. A start with no end after it, a raw ESC that is
 *  not the exact start marker and a lone reset outside a match all stay the line's own text. */
export function stripMatches(colored: Buffer): { raw: Buffer; spans: [number, number][] } {
  const parts: Buffer[] = [];
  const spans: [number, number][] = [];
  let size = 0;
  let at = 0;
  for (;;) {
    const start = colored.indexOf(MATCH_START, at);
    const end = start < 0 ? -1 : colored.indexOf(MATCH_END, start + MATCH_START.length);
    if (end < 0) break;
    const before = colored.subarray(at, start);
    const match = colored.subarray(start + MATCH_START.length, end);
    parts.push(before, match);
    spans.push([size + before.length, size + before.length + match.length]);
    size += before.length + match.length;
    at = end + MATCH_END.length;
  }
  parts.push(colored.subarray(at));
  return { raw: Buffer.concat(parts), spans };
}

/** Reads git grep -z's records, `path NUL line NUL text LF`, across chunks (#868). A name may hold a newline, so the fields are read in order. */
export function createGrepParser(onLine: (line: GrepLine) => void): { push(chunk: Buffer): void } {
  let pending = Buffer.alloc(0);
  const record = (): boolean => {
    const nameEnd = pending.indexOf(NUL);
    const numberEnd = nameEnd < 0 ? -1 : pending.indexOf(NUL, nameEnd + 1);
    const textEnd = numberEnd < 0 ? -1 : pending.indexOf(LF, numberEnd + 1);
    if (textEnd < 0) return false;
    const { raw, spans } = stripMatches(pending.subarray(numberEnd + 1, textEnd));
    onLine({ file: pending.subarray(0, nameEnd).toString('utf8'), line: Number(pending.subarray(nameEnd + 1, numberEnd).toString('latin1')), raw, spans });
    pending = pending.subarray(textEnd + 1);
    return true;
  };
  return {
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      while (record());
    },
  };
}

const utf16At = (raw: Buffer, byte: number): number => raw.subarray(0, byte).toString('utf8').length;

/** A line as the pane reads it (#868): UTF-16 spans; no CR of a CRLF file; line 1's BOM dropped, as the editor holds it apart. */
export function toWireMatch({ line, raw, spans }: GrepLine): SearchMatch {
  const decoded = raw.toString('utf8');
  const lead = line === 1 && decoded.startsWith(BOM) ? 1 : 0;
  const text = decoded.slice(lead).replace(/\r$/, '');
  const at = (byte: number): number => Math.min(Math.max(utf16At(raw, byte) - lead, 0), text.length);
  return { line, text, spans: spans.map(([start, end]) => [at(start), at(end)]) };
}

export function grepError(stderr: string): string {
  const fatal = stderr.split('\n').find((row) => row.startsWith(FATAL));
  return fatal?.slice(FATAL.length) ?? (stderr.trim() || 'git grep failed');
}
