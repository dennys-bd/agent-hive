// The column-divider mechanism's arithmetic (#59, handoff items 4 and 5), shared by the Project table and the repository's lists. The title
// is fluid, so only the right side of the row is known: every offset is measured from the row's right edge, as the handoff's table() does.

/** A resizable column: its key in the saved widths and its width in px. */
export interface WidthColumn { key: string; width: number }

export const COLUMN_GAP = 12; // the rows' gap-3
export const ROW_PADDING = 12; // the rows' px-3, each side
export const TITLE_MIN = 160; // past this the table scrolls sideways
const MIN_RESIZE = 40; // a dragged column keeps room for a chip's edge
const MAX_RESIZE = 480; // #756 addendum 2: and never takes the whole pane

const sum = (values: number[]): number => values.reduce((total, v) => total + v, 0);
const tracks = (columns: WidthColumn[], trailing?: number): number[] => [...columns.map((c) => c.width), ...(trailing === undefined ? [] : [trailing])];

/** A dragged or saved width, whole px within 40–480. */
export const clampWidth = (px: number): number => Math.min(MAX_RESIZE, Math.max(MIN_RESIZE, Math.round(px)));

/** The columns at their saved widths, clamped: a hand-edited or old value never draws past 40–480px. */
export const withWidths = <C extends WidthColumn>(columns: C[], widths: Record<string, number>): C[] =>
  columns.map((c) => (Object.hasOwn(widths, c.key) ? { ...c, width: clampWidth(widths[c.key]) } : c));

/** The grid: the title fluid from 160px, each column, then the trailing one (the Project's action), which has no handle. */
export const gridTemplate = (columns: WidthColumn[], trailing?: number): string =>
  [`minmax(${TITLE_MIN}px,1fr)`, ...tracks(columns, trailing).map((w) => `${w}px`)].join(' ');

/** Past this the table scrolls sideways: the title at its least, every track, a gap before each and both paddings. */
export function tableMinWidth(columns: WidthColumn[], trailing?: number): number {
  const all = tracks(columns, trailing);
  return TITLE_MIN + sum(all) + all.length * COLUMN_GAP + 2 * ROW_PADDING;
}

/** Each column's left edge as a `right` offset in px: the padding, half a gap, every track from it to the end and the gaps between them. */
export function dividerOffsets(columns: WidthColumn[], trailing?: number): number[] {
  const all = tracks(columns, trailing);
  return columns.map((_, j) => ROW_PADDING + COLUMN_GAP / 2 + (all.length - 1 - j) * COLUMN_GAP + sum(all.slice(j)));
}

/** Saved widths as stored in the view state; anything else is undefined, which a reader takes as no saved width. */
export function parseWidths(value: unknown): Record<string, number> | undefined {
  const isRecord = typeof value === 'object' && value !== null && !Array.isArray(value);
  return isRecord && Object.values(value).every((v) => typeof v === 'number') ? (value as Record<string, number>) : undefined;
}
