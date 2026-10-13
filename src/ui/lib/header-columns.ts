import { RAIL_WIDTH } from '@/components/ViewRail';
import type { ViewLayout } from '@/lib/dock-layout';

/** The header's column widths as CSS (#221); undefined: the column sizes to its content, or is absent. */
export interface HeaderColumns { left?: string; right?: string }

// A side's share of the frame. The header spans the rail plus the frame, and the dock's sizes are percent of the frame alone (DockFrame's
// measure), so pure CSS matches the groups' flexBasis at any window size, with no ResizeObserver and no lag after a resize
const frameShare = (percent: number): string => `(100% - ${RAIL_WIDTH}px) * ${percent} / 100`;

/** The left column spans the rail and the left group while it is open; the right one the right group while the right column shows. */
export function headerColumns(layout: ViewLayout, rightShown: boolean): HeaderColumns {
  return {
    left: layout.open.left ? `calc(${RAIL_WIDTH}px + ${frameShare(layout.sizes.left)})` : undefined,
    right: rightShown ? `calc(${frameShare(layout.sizes.right)})` : undefined,
  };
}
