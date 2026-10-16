// A conflict side read against the merge base (#325, decision 10): no dependency, since a conflict hunk is a few lines. Compiled by the main
// tsc too; it imports nothing.

export interface SideLine { mark: ' ' | '+' | '−'; text: string }

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
