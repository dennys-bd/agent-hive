import { RAIL_WIDTH } from '@/components/ViewRail';
import type { ViewLayout } from '@/lib/dock-layout';

/** The header's column widths as CSS (#221, #295). left null: no left column; right undefined: no right column. */
export interface HeaderColumns { left: string | null; right?: string }

// The left side closed out of full screen (header-estados.md): a block holding only the macOS window buttons' space
const CLOSED_LEFT = '72px';

// A side's share of the frame. The header spans the rail plus the frame, and the dock's sizes are percent of the frame alone (DockFrame's
// measure), so pure CSS matches the groups' flexBasis at any window size, with no ResizeObserver and no lag after a resize
const frameShare = (percent: number): string => `(100% - ${RAIL_WIDTH}px) * ${percent} / 100`;

/** The left column spans the rail and the left group while the left side is open. Closed, it is the window buttons' block, or none in full
 * screen, where macOS hides them. The right one spans the right group while the right column shows. */
export function headerColumns(layout: ViewLayout, rightShown: boolean, isFullScreen: boolean): HeaderColumns {
  const closedLeft = isFullScreen ? null : CLOSED_LEFT;
  return {
    left: layout.open.left ? `calc(${RAIL_WIDTH}px + ${frameShare(layout.sizes.left)})` : closedLeft,
    right: rightShown ? `calc(${frameShare(layout.sizes.right)})` : undefined,
  };
}
