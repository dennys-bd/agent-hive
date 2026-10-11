import { type ReactNode, useRef, useState } from 'react';
import { useNavScroll } from '@/hooks/use-back-stack';
import { t } from '@/i18n';
import { clampWidth, dividerOffsets, tableMinWidth, type WidthColumn } from '@/lib/column-widths';

/** The widths to draw (the saved ones, with the one being dragged), and what a handle calls: `onDrag` draws a width while the pointer moves
 * (undefined: the drag ended), `onResize` saves one (undefined: back to the column's default). */
export interface ColumnWidths { widths: Record<string, number>; onDrag(key: string, width?: number): void; onResize(key: string, width?: number): void }

/** A table's resize state (#756 addendum 2, #59): the width a drag draws before its release saves it. */
export function useColumnWidths(saved: Record<string, number>, onSave: (widths: Record<string, number>) => void): ColumnWidths {
  const [dragging, setDragging] = useState<{ key: string; width: number }>();
  const widths = dragging === undefined ? saved : { ...saved, [dragging.key]: dragging.width };
  const onDrag = (key: string, width?: number): void => setDragging(width === undefined ? undefined : { key, width });
  const onResize = (key: string, width?: number): void =>
    onSave(width === undefined ? Object.fromEntries(Object.entries(saved).filter(([k]) => k !== key)) : { ...saved, [key]: clampWidth(width) });
  return { widths, onDrag, onResize };
}

interface HandleProps { label: string; width: number; right: number; onDrag(width?: number): void; onResize(width?: number): void }

// A column's handle (handoff item 4): 9px on the column's left edge, centred on the gap, its 1px line at the centre. Dragging right narrows
// the column at its right (the handoff's w0 - dx) and the fluid title takes up the difference. The width follows the pointer from where the
// drag began and is saved once, on release: a save per move would rewrite the view state on every pixel. A double-click hands back the default.
function ResizeHandle({ label, width, right, onDrag, onResize }: HandleProps) {
  const drag = useRef<{ x: number; width: number; last: number } | undefined>(undefined);
  const end = (isKept: boolean): void => {
    const done = drag.current;
    drag.current = undefined;
    if (isKept && done !== undefined && done.last !== done.width) onResize(done.last);
    onDrag(undefined);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take pointer drags; a separator between columns is the splitter pattern
    <span
      role="separator" aria-orientation="vertical" aria-label={t('project.col.resize', { column: label })}
      className="group pointer-events-auto absolute inset-y-0 -mr-1 w-[9px] cursor-col-resize touch-none select-none" style={{ right }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, width, last: width }; }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        drag.current = { ...drag.current, last: clampWidth(drag.current.width - (e.clientX - drag.current.x)) };
        onDrag(drag.current.last);
      }}
      onPointerUp={() => end(true)} onPointerCancel={() => end(false)}
      onDoubleClick={() => onResize(undefined)}
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-1 w-px bg-border group-hover:bg-muted-foreground" />
    </span>
  );
}

export interface HeaderHandlesProps<C extends WidthColumn> {
  columns: C[]; trailing?: number; labelOf(column: C): string; onDrag(key: string, width?: number): void; onResize(key: string, width?: number): void;
}

/** Every column's handle, inside the header row (made `relative`). One absolute <th>: it takes no grid track, keeps the row valid HTML,
 * and as a presentation it is not a column header. */
export function HeaderHandles<C extends WidthColumn>({ columns, trailing, labelOf, onDrag, onResize }: HeaderHandlesProps<C>) {
  const offsets = dividerOffsets(columns, trailing);
  return (
    // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a <th> in a <tr> keeps the DOM valid; presentation keeps it out of the column headers
    <th role="presentation" className="pointer-events-none absolute inset-0 p-0">
      {columns.map((c, i) => (
        <ResizeHandle key={c.key} label={labelOf(c)} width={c.width} right={offsets[i]} onDrag={(w) => onDrag(c.key, w)} onResize={(w) => onResize(c.key, w)} />
      ))}
    </th>
  );
}

// The body's dividers (handoff item 4): one overlay under the 34px header instead of a border on every cell, so rows and group rows keep
// their markup; a group row paints over it
function BodyDividers({ columns, trailing }: { columns: WidthColumn[]; trailing?: number }) {
  return (
    <div data-testid="column-dividers" aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-[34px] bottom-0">
      {dividerOffsets(columns, trailing).map((right, i) => <span key={columns[i].key} className="absolute inset-y-0 w-px bg-border" style={{ right }} />)}
    </div>
  );
}

/** A table's scroll area (#59): no visible bar, so header and rows keep one width and the lines align; inside, a box as wide as the table
 * and at least as tall as the area holds the table and the dividers, which move with the columns when it scrolls sideways. No row, no
 * body divider (the handoff's `body: empty ? [] : lines`). */
export function ColumnScroll({ columns, trailing, hasRows, children }: { columns: WidthColumn[]; trailing?: number; hasRows: boolean; children: ReactNode }) {
  const scroller = useNavScroll(); // #911: a back restores this table's scroll
  return (
    <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-width:none]">
      <div className="relative flex-1" style={{ minWidth: tableMinWidth(columns, trailing) }}>
        {children}
        {hasRows && <BodyDividers columns={columns} trailing={trailing} />}
      </div>
    </div>
  );
}
