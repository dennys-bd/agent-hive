// Where the editor draws an annotation (#327): a card or a one-line note in the margin, a dot on a map row, a wavy underline in the text.
// Pure, so the rules are tested without Monaco; compiled by the main tsc too, hence the .js imports.
import type { LintAnnotation, Severity } from '../../template-lint.js';
import type { MapBlock, TemplateMap } from '../../template-map.js';
import type { Decoration, LookClass } from './template-view.js';

/** The card's fixed height in the margin (px): Annotations.tsx draws it this tall, so the layout knows what it covers. */
export const CARD_HEIGHT = 104;
export const NOTE_HEIGHT = 20;
export interface MarginSlot { kind: 'card' | 'note'; top: number }

const overlaps = (a: number, b: number, height: number): boolean => a < b + height && b < a + height;

/** Each annotation's slot, in order: a note when a chip, or an earlier card, starts within the card's height; a card otherwise. Notes of one
 * stretch stack downwards.
 * ponytail: a note never moves out of a chip's way, so a chip on the annotation's own line still meets it */
export function layoutMargin(chipTops: readonly number[], tops: readonly number[], cardHeight: number = CARD_HEIGHT): MarginSlot[] {
  const slots: MarginSlot[] = [];
  for (const top of tops) {
    const hitsChip = chipTops.some((chip) => chip >= top && chip < top + cardHeight);
    const hitsCard = slots.some((slot) => slot.kind === 'card' && overlaps(slot.top, top, cardHeight));
    const stacked = slots.filter((slot) => slot.kind === 'note' && slot.top >= top && slot.top < top + cardHeight).length;
    slots.push(!hitsChip && !hitsCard ? { kind: 'card', top } : { kind: 'note', top: top + stacked * NOTE_HEIGHT });
  }
  return slots;
}

interface Row { line: number; endLine: number; children: readonly MapBlock[] }

// A block's rows as BlockMap draws them: one per block, one per branch of a chain, its end marker in the last branch
function rowsOf(block: MapBlock): Row[] {
  if (block.kind === 'introduction') return [{ line: block.line, endLine: block.endLine, children: [] }];
  if (block.kind === 'heading') return [{ line: block.line, endLine: block.endLine, children: block.children }];
  const { branches } = block;
  return branches.map((branch, index) => ({
    line: branch.line,
    endLine: index + 1 < branches.length ? branches[index + 1].line - 1 : block.endLine,
    children: branch.children,
  }));
}

// The innermost row whose lines hold `line`; undefined for a line no block holds
function rowAt(blocks: readonly MapBlock[], line: number): number | undefined {
  const row = blocks.flatMap(rowsOf).find((r) => line >= r.line && line <= r.endLine);
  return row === undefined ? undefined : (rowAt(row.children, line) ?? row.line);
}

/** Each map row's annotations, keyed by the row's line: a header line's go to the first block (visual mode hides the header); a line no block
 * holds draws no dot, though the counter still counts it. */
export function dotsOf(map: TemplateMap, bodyLine: number, list: readonly LintAnnotation[]): ReadonlyMap<number, readonly LintAnnotation[]> {
  const first = map.blocks.flatMap(rowsOf).at(0)?.line;
  return list.reduce((dots, annotation) => {
    const row = annotation.line < bodyLine ? first : rowAt(map.blocks, annotation.line);
    return row === undefined ? dots : new Map(dots).set(row, [...(dots.get(row) ?? []), annotation]);
  }, new Map<number, readonly LintAnnotation[]>());
}

const UNDERLINE: Record<Severity, LookClass> = { yellow: 'template-annotation-yellow', red: 'template-annotation-red' };
const FIRST_TEXT = /\S/;

/** A wavy underline per annotated line, from its first non-blank column to its end, in the severity's colour; a blank line has none. */
export function underlinesOf(list: readonly LintAnnotation[], text: string): Decoration[] {
  const lines = text.split('\n');
  return list.flatMap((annotation): Decoration[] => {
    const start = (lines[annotation.line - 1] ?? '').search(FIRST_TEXT);
    return start < 0 ? [] : [{ line: annotation.line, from: start + 1, className: UNDERLINE[annotation.severity] }];
  });
}
