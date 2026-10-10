// A diff's rows as the pane draws them (#591): the counts a file, the list and the bar show, and the side-by-side pairing. Pure.
import type { DiffHunk, DiffLine } from '../../types.js'; // src/ui/lib is compiled by the root tsc too (#591)

export type DiffLayout = 'unified' | 'split';
export interface Counts { add: number; del: number }
export interface SplitRow { old?: DiffLine; new?: DiffLine }

export function countsOf(hunks: DiffHunk[]): Counts {
  const lines = hunks.flatMap((h) => h.lines);
  return { add: lines.filter((l) => l.kind === 'add').length, del: lines.filter((l) => l.kind === 'del').length };
}

// The hunk cut into runs: each context line alone, and each deleted stretch with the added stretch right after it
function runsOf(lines: DiffLine[]): DiffLine[][] {
  const runs: DiffLine[][] = []; // built locally, never shared, so pushing is not a mutation of anything the caller holds
  for (const line of lines) {
    const last = runs.at(-1);
    const joins = last !== undefined && line.kind !== 'context' && last[0].kind !== 'context' && !(line.kind === 'del' && last.at(-1)?.kind === 'add');
    if (joins) last.push(line);
    else runs.push([line]);
  }
  return runs;
}

function pairRun(run: DiffLine[]): SplitRow[] {
  if (run[0].kind === 'context') return [{ old: run[0], new: run[0] }];
  const dels = run.filter((l) => l.kind === 'del');
  const adds = run.filter((l) => l.kind === 'add');
  return Array.from({ length: Math.max(dels.length, adds.length) }, (_, i) => ({
    ...(dels[i] === undefined ? {} : { old: dels[i] }), ...(adds[i] === undefined ? {} : { new: adds[i] }),
  }));
}

/** Side by side (#591): a deleted run and the added run after it paired row by row, the longer leaving empty cells; context on both. */
export const splitRows = (hunk: DiffHunk): SplitRow[] => runsOf(hunk.lines).flatMap(pairRun);
