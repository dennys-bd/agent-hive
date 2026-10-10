import { PlusIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import type { DiffHunk, DiffLine } from '../../types';
import { t } from '@/i18n';
import { type DiffLayout, type SplitRow, splitRows } from '@/lib/diff-rows';

type Side = 'old' | 'new';
const SIGN: Record<DiffLine['kind'], string> = { context: ' ', add: '+', del: '-' };
// One status token at two strengths (#591): the gutter (both number columns) at 30%, the body (sign and code) at 12%, so the numbers read
// as part of the line while the code stays legible; a context line carries none.
const GUTTER: Record<DiffLine['kind'], string> = { context: 'text-empty', add: 'bg-working/30 text-foreground', del: 'bg-destructive/30 text-foreground' };
const BODY: Record<DiffLine['kind'], string> = { context: '', add: 'bg-working/12', del: 'bg-destructive/12' };
const SIGN_TEXT: Record<DiffLine['kind'], string> = { context: 'text-muted-foreground', add: 'text-working', del: 'text-destructive' };
const NUMBER = 'relative select-none px-2 text-right align-top';
const SIGN_CELL = 'select-none text-center align-top';
const CODE = 'whitespace-pre pr-3';
// A half's code is clipped at its column, so a long line never runs over the other half; unified lets it overflow into the pane's scroll
const HALF_CODE = `${CODE} overflow-hidden`;
// Centred on the gutter's right border, where the 30% tint turns to the body's 12%: the new number cell's unified, the half's number cell
// side by side, so it sits at one x on every line. Above the next cell, whose tint would paint over its right half.
const MARK = 'absolute right-0 z-[1] translate-x-1/2';
// A selected line's 3px ring bar, at the +'s x
const BAR = `${MARK} pointer-events-none inset-y-0 w-[3px] bg-ring`;
const Bar = () => <span aria-hidden="true" data-slot="selection-bar" className={BAR} />;
/** The + on a line (#591): shown on hover, or, while a drag runs, only on the line it started from. */
export type Plus = 'hover' | 'shown' | 'hidden';
const PLUS: Record<Plus, string> = { hover: 'invisible group-hover:visible focus-visible:visible', shown: 'visible', hidden: 'invisible' };
// Fixed widths (#591), so every file's code starts at the same x instead of each table sizing its numbers to its own; the code takes the rest
const HALF_COLS = ['w-11', 'w-[18px]', ''];
const COLS: Record<DiffLayout, string[]> = { unified: ['w-11', 'w-11', 'w-[18px]', ''], split: [...HALF_COLS, ...HALF_COLS] };
export const ROW_SPAN: Record<DiffLayout, number> = { unified: COLS.unified.length, split: COLS.split.length };

/** The columns of a diff table (#591): used with table-fixed, whose widths come from the first row or these cols. */
export function DiffCols({ layout }: { layout: DiffLayout }) {
  // biome-ignore lint/suspicious/noArrayIndexKey: the columns are a fixed list whose order is their identity
  return <colgroup>{COLS[layout].map((width, index) => <col key={index} className={width} />)}</colgroup>;
}

/** A hunk's selected lines by their index in hunk.lines (#591); `start` is the line under the +. */
export interface HunkRange { from: number; to: number; start: number }

/** What a hunk's rows need from the pane (#591): the selection, the gutter's comment, and what shows under a line. `index` is the line's
 * position in hunk.lines; side by side, each half passes its own line's, and `below` is asked per half with its side. */
export interface HunkView {
  canComment?: boolean; // false on a read-only pane (#592): no + on any line
  range?: HunkRange; plus(index: number): Plus; select(index: number): void; begin(index: number): void; extend(index: number): void; below(line: DiffLine, side?: Side): ReactNode;
}

// The 16×16 + on ring in the hovered line's gutter (#591), at MARK: a click comments the line, a drag from it selects a range. Its label names
// the old side on a deleted line, so a deleted and an added line with one number never share a name.
function Gutter({ line, side, index, view }: { line: DiffLine; side: Side; index: number; view: HunkView }) {
  const n = line[side] ?? 0;
  return (
    <button
      type="button" aria-label={side === 'old' ? t('review.commentOld', { n }) : t('review.comment', { n })}
      className={`${PLUS[view.plus(index)]} ${MARK} top-0.5 flex size-4 items-center justify-center rounded-sm bg-ring text-white`}
      onPointerDown={(event) => { event.preventDefault(); view.begin(index); }}
    >
      <PlusIcon className="size-3" />
    </button>
  );
}

// The start line carries the + alone: the bar begins on the next selected line, so the two never draw on one line
const hasUnifiedBar = (range: HunkRange | undefined, index: number): boolean =>
  range !== undefined && index >= range.from && index <= range.to && index !== range.start;

// Side by side (#591): the half the selection's + is in, from the row under it to the last selected row, rows where that half is empty
// included, so the bar never breaks; the other half has none. Which half each row's bar is in, if any.
function splitBars(rows: SplitRow[], hunk: DiffHunk, range?: HunkRange): (Side | undefined)[] {
  if (range === undefined) return rows.map(() => undefined);
  const side: Side = hunk.lines[range.start]?.kind === 'del' ? 'old' : 'new';
  const at = rows.map((row) => { const line = row[side]; return line === undefined ? -1 : hunk.lines.indexOf(line); });
  const selected = at.map((index) => index >= range.from && index <= range.to);
  const first = selected.indexOf(true);
  const last = selected.lastIndexOf(true);
  return at.map((index, row) => (first !== -1 && row >= first && row <= last && index !== range.start ? side : undefined));
}

// A click selects a line and the pointer passing over one extends a drag (#591)
const lineHandlers = (view: HunkView | undefined, index: number | undefined) =>
  (view === undefined || index === undefined ? {} : { onClick: () => view.select(index), onPointerEnter: () => view.extend(index) });

function UnifiedRow({ line, index, view }: { line: DiffLine; index: number; view?: HunkView }) {
  const side: Side = line.kind === 'del' ? 'old' : 'new';
  const { kind } = line;
  return (
    <tr className="group" {...lineHandlers(view, index)}>
      <td className={`${NUMBER} ${GUTTER[kind]}`}>{line.old ?? ''}</td>
      <td className={`${NUMBER} ${GUTTER[kind]}`}>
        {hasUnifiedBar(view?.range, index) && <Bar />}{view && view.canComment !== false && <Gutter line={line} side={side} index={index} view={view} />}{line.new ?? ''}
      </td>
      <td className={`${SIGN_CELL} ${BODY[kind]} ${SIGN_TEXT[kind]}`}>{SIGN[kind]}</td>
      <td className={`${CODE} ${BODY[kind]}`}>{line.text}</td>
    </tr>
  );
}

interface HalfProps { line?: DiffLine; side: Side; index?: number; view?: HunkView; hasGutter: boolean; isBarred: boolean }

function Half({ line, side, index, view, hasGutter, isBarred }: HalfProps) {
  const kind = line?.kind ?? 'context';
  const handlers = lineHandlers(view, index);
  return (
    <>
      <td className={`${NUMBER} ${GUTTER[kind]}`} {...handlers}>
        {isBarred && <Bar />}
        {hasGutter && line !== undefined && view !== undefined && view.canComment !== false && index !== undefined && <Gutter line={line} side={side} index={index} view={view} />}
        {line?.[side] ?? ''}
      </td>
      <td className={`${SIGN_CELL} ${BODY[kind]} ${SIGN_TEXT[kind]}`} {...handlers}>{line === undefined ? '' : SIGN[kind]}</td>
      <td className={`${HALF_CODE} ${BODY[kind]}`} {...handlers}>{line?.text ?? ''}</td>
    </>
  );
}

// A side-by-side row (#591): the + on the new half when it has a line, and a second one on the old half of a deleted line (paired or alone);
// a context row's line sits on both halves and gets one +
function SplitRowView({ row, hunk, view, bar }: { row: SplitRow; hunk: DiffHunk; view?: HunkView; bar?: Side }) {
  const at = (line?: DiffLine): number | undefined => (line === undefined ? undefined : hunk.lines.indexOf(line));
  return (
    <tr className="group">
      <Half line={row.old} side="old" index={at(row.old)} view={view} hasGutter={row.old?.kind === 'del'} isBarred={bar === 'old'} />
      <Half line={row.new} side="new" index={at(row.new)} view={view} hasGutter={row.new !== undefined} isBarred={bar === 'new'} />
    </tr>
  );
}

const isShown = (node: ReactNode): boolean => node !== null && node !== undefined && node !== false;

// The cells under a line (#591): its gutter tint on the number columns and its body tint under the sign and the code, where the content
// starts, so the row reads as part of the line above it
function BelowCells({ line, node, gutter }: { line: DiffLine; node: ReactNode; gutter: number }) {
  return (
    <>
      <td colSpan={gutter} className={GUTTER[line.kind]} />
      <td colSpan={2} className={`px-2 py-1 pl-[18px] ${BODY[line.kind]}`}>{node}</td>
    </>
  );
}

function Below({ line, node }: { line: DiffLine; node: ReactNode }) {
  return isShown(node) ? <tr><BelowCells line={line} node={node} gutter={2} /></tr> : null;
}

// Side by side (#591), what shows under a row sits in the half of its anchor's side, the other half's cell empty; a context row's one
// line is asked once per side, since a selection begun on a deleted line can end on it
function SplitBelow({ row, view }: { row: SplitRow; view: HunkView }) {
  const halves = ([['old', row.old], ['new', row.new]] as const).map(([side, line]) => ({ side, line, node: line === undefined ? null : view.below(line, side) }));
  if (!halves.some(({ node }) => isShown(node))) return null;
  return (
    <tr>
      {halves.map(({ side, line, node }) => (line !== undefined && isShown(node)
        ? <BelowCells key={side} line={line} node={node} gutter={1} />
        : <td key={side} colSpan={HALF_COLS.length} />))}
    </tr>
  );
}

const lineKey = (line: DiffLine): string => `${line.old ?? ''}:${line.new ?? ''}`;
const rowKey = (row: SplitRow): string => `${row.old?.old ?? ''}:${row.new?.new ?? ''}`;

/** A hunk (#270, #591): its header on task, muted, then its lines unified or side by side, each followed by what the pane shows under it. */
export function HunkRows({ hunk, layout, view }: { hunk: DiffHunk; layout: DiffLayout; view?: HunkView }) {
  const span = ROW_SPAN[layout];
  const rows = layout === 'split' ? splitRows(hunk) : [];
  const bars = splitBars(rows, hunk, view?.range);
  return (
    <>
      <tr><td colSpan={span} className="bg-card px-2 text-muted-foreground">{hunk.header}</td></tr>
      {layout === 'unified'
        ? hunk.lines.map((line, index) => (
          <Fragment key={lineKey(line)}>
            <UnifiedRow line={line} index={index} view={view} />
            {view && <Below line={line} node={view.below(line)} />}
          </Fragment>
        ))
        : rows.map((row, index) => (
          <Fragment key={rowKey(row)}>
            <SplitRowView row={row} hunk={hunk} view={view} bar={bars[index]} />
            {view && <SplitBelow row={row} view={view} />}
          </Fragment>
        ))}
    </>
  );
}
