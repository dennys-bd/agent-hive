// #984: which of the Hive's own hunks (base → shipped) a clean row of an update comes from. A clean row is a -U0 hunk of the user's text
// (mine → result) on lines the user never edited, so the user's edits above it shift it into base's lines by exactly what they added
// and removed.
import { diffTexts, type Hunk, numberedDiff } from './custom-merge-git.js';
import type { DiffHunk } from './types.js';

/** The row diff's context: one line around each change, as the screen draws it. */
export const CONTEXT = 1;
const OLD_RANGE = /^@@ -(\d+)(?:,(\d+))?/;

/** Lines `start`..`end` of a text, 1-based and inclusive. */
export interface Span { start: number; end: number }
type Passage = Pick<Hunk, 'fromAbove' | 'removed'>;

/** A passage's lines: its removed ones; a pure insertion has none, so the two lines around its point, which a -U1 hunk there holds. */
export const spanOf = ({ fromAbove, removed }: Passage): Span =>
  removed.length === 0 ? { start: fromAbove, end: fromAbove + 1 } : { start: fromAbove + 1, end: fromAbove + removed.length };

/** A passage of the user's text moved into base's lines: every `toBase` hunk (base → mine, -U0) ending at or above it shifts it. */
export function inBase(passage: Passage, toBase: readonly Hunk[]): Passage {
  const above = toBase.filter((hunk) => hunk.toAbove + hunk.added.length <= passage.fromAbove);
  const shift = above.reduce((sum, hunk) => sum + hunk.removed.length - hunk.added.length, 0);
  return { fromAbove: passage.fromAbove + shift, removed: passage.removed };
}

// A hunk's old side from its header: lines a..a+b-1, b being 1 when left out; b = 0 only comes with an empty old text, the point after a
function oldSpan({ header }: DiffHunk): Span {
  const [, start = '0', count = '1'] = OLD_RANGE.exec(header) ?? [];
  const from = Number(start);
  return count === '0' ? { start: from, end: from + 1 } : { start: from, end: from + Number(count) - 1 };
}

/** The hunks whose old side meets `span`. */
export const hunksAt = (span: Span, hunks: readonly DiffHunk[]): DiffHunk[] =>
  hunks.filter((hunk) => {
    const old = oldSpan(hunk);
    return old.start <= span.end && span.start <= old.end;
  });

/** A file's four texts in an update, each the empty text where that side has no file. */
export interface FileTexts { mine: Buffer; base: Buffer; hive: Buffer; result: Buffer }

/** Each row's diff, in the rows' order: the shipped hunks at its passage in base. A row no shipped hunk meets cannot happen by
 * construction; it falls back to the user's own diff to the result at its lines, so an open row never renders empty. */
export async function rowDiffs(dir: string, texts: FileTexts, rows: readonly Hunk[]): Promise<DiffHunk[][]> {
  if (rows.length === 0) return [];
  const shipped = await numberedDiff(dir, texts.base, texts.hive, CONTEXT);
  const toBase = texts.mine.equals(texts.base) ? [] : await diffTexts(dir, texts.base, texts.mine);
  const kept = rows.map((row) => hunksAt(spanOf(inBase(row, toBase)), shipped));
  if (kept.every((hunks) => hunks.length > 0)) return kept;
  const own = await numberedDiff(dir, texts.mine, texts.result, CONTEXT);
  return rows.map((row, n) => (kept[n].length > 0 ? kept[n] : hunksAt(spanOf(row), own)));
}
