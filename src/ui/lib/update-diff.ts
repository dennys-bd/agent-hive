// A conflict side read against the merge base (#325, decision 10): no dependency, since a conflict hunk is a few lines. Compiled by the main
// tsc too, so it imports types only, with their .js extension.
import type { DiffHunk, DiffLine } from '../../types.js';

export interface SideLine { mark: ' ' | '+' | '−'; text: string }

/** #984: a clean row's diff header range, "lines a–b": its hunks' first to last new-side number, the old side when the hunks only remove. */
export function diffRange(hunks: readonly DiffHunk[]): { start: number; end: number } | undefined {
  const lines = hunks.flatMap((hunk) => hunk.lines);
  const news = lines.flatMap((line) => (line.new === undefined ? [] : [line.new]));
  const numbers = news.length > 0 ? news : lines.flatMap((line) => (line.old === undefined ? [] : [line.old]));
  return numbers.length === 0 ? undefined : { start: Math.min(...numbers), end: Math.max(...numbers) };
}

/** #984: the one number column of a row diff: a removed line's old number, an added or context line's new one. parseDiff numbers every
 * line on the side it exists on, so the 0 is never shown. */
export const diffLineNumber = (line: DiffLine): number => (line.kind === 'del' ? line.old : line.new) ?? 0;

/** `side` against `base` as a line diff: shared lines ' ', base-only '−', side-only '+', in reading order, removals before additions within
 * a gap. ponytail: an O(n·m) LCS table; a whole-file conflict of a few hundred lines is the ceiling, Myers if one ever grows past that. */
export function sideAgainstBase(base: readonly string[], side: readonly string[]): SideLine[] {
  const width = side.length + 1;
  // common[i * width + j]: the LCS length of base[i..] and side[j..]
  const common = new Uint32Array((base.length + 1) * width);
  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = side.length - 1; j >= 0; j -= 1) {
      common[i * width + j] = base[i] === side[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const lines: SideLine[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < side.length) {
    if (i < base.length && j < side.length && base[i] === side[j]) {
      lines.push({ mark: ' ', text: side[j] });
      i += 1;
      j += 1;
    } else if (i < base.length && (j === side.length || common[(i + 1) * width + j] >= common[i * width + j + 1])) {
      lines.push({ mark: '−', text: base[i] }); // a tie takes the removal first
      i += 1;
    } else {
      lines.push({ mark: '+', text: side[j] });
      j += 1;
    }
  }
  return lines;
}
