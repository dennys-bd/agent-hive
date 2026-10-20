// Ask the agent in the editor (#331): the proposal look, the buffer's look with the hunk's added lines put in after its deleted ones, both
// marked as whole lines, and the chip "agent proposal". Pure: TemplateText draws it as it draws any look.
import type { DiffHunk } from '../../types';
import { t } from '@/i18n';
import type { Chip, Decoration, LineRange, TextLook } from '@/lib/template-view';

/** A selection's whole lines, 1-based and inclusive, as POST /api/items/:id/assist takes them. */
export interface LineSelection { startLine: number; endLine: number }
interface Change { at: number; deleted: string[]; added: string[] } // at: the buffer's first changed line

// The hunk in buffer lines: the deleted ones start at their own number. With none, the added ones go before the buffer line the first of
// them takes, since every line before a change keeps its number
function changeOf(hunk: DiffHunk): Change {
  const deleted = hunk.lines.filter((line) => line.kind === 'del');
  const added = hunk.lines.filter((line) => line.kind === 'add');
  return { at: deleted[0]?.old ?? added[0]?.new ?? 1, deleted: deleted.map((line) => line.text), added: added.map((line) => line.text) };
}

/** The lines a proposal marks in its look, the deleted ones then the added ones: the answer line names them. */
export function markedLines(hunk: DiffHunk): { from: number; to: number } {
  const { at, deleted, added } = changeOf(hunk);
  return { from: at, to: at + deleted.length + added.length - 1 };
}

/** The proposal over `base`, an editable look whose text is the buffer. The base's hidden ranges, marks, chips and lineOf after the deleted
 * lines move down by the added ones; the ones on a deleted line, or around an insertion, go. dimmed stays: it holds source lines, and is
 * empty outside "view as", where no proposal is shown. */
export function proposalLook(base: TextLook, hunk: DiffHunk): TextLook {
  const { at, deleted, added } = changeOf(hunk);
  const end = at + deleted.length; // the first buffer line after the deleted ones
  const shift = (line: number): number => (line >= end ? line + added.length : line);
  const isKept = ({ from, to }: LineRange): boolean => to < at || from >= end;
  const lines = base.text.split('\n');
  const marks: Decoration[] = [
    ...deleted.map((_, i): Decoration => ({ line: at + i, className: 'template-proposal-old', isBackground: true })),
    ...added.map((_, i): Decoration => ({ line: end + i, className: 'template-proposal-new', isBackground: true })),
  ];
  const chip: Chip = { line: added.length > 0 ? end : at, label: t('plugins.assist.proposal') };
  return {
    text: [...lines.slice(0, end - 1), ...added, ...lines.slice(end - 1)].join('\n'),
    hidden: base.hidden.filter(isKept).map((range) => ({ from: shift(range.from), to: shift(range.to) })),
    decorations: [...base.decorations.filter((d) => isKept({ from: d.line, to: d.line })).map((d) => ({ ...d, line: shift(d.line) })), ...marks],
    chips: [...base.chips.filter((c) => isKept({ from: c.line, to: c.line })).map((c) => ({ ...c, line: shift(c.line) })), chip],
    dimmed: base.dimmed,
    lineOf: (source) => shift(base.lineOf(source)),
  };
}
