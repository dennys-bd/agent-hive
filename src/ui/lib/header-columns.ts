import { RAIL_WIDTH } from '@/components/ViewRail';
import type { ViewLayout } from '@/lib/dock-layout';

/** The header's column widths as CSS (#221, #295). right undefined: no right column. */
export interface HeaderColumns { left: string; right?: string }

// The left side closed in a window (#295): the macOS window buttons end at 80px (x 14, three 12px lights, two 8px gaps); 12px more keeps
// panel-left off them, the gap the full-screen inset keeps from the edge
const CLOSED_WINDOW_LEFT = '92px';

// A side's share of the frame. The header spans the rail plus the frame, and the dock's sizes are percent of the frame alone (DockFrame's
// measure), so pure CSS matches the groups' flexBasis at any window size, with no ResizeObserver and no lag after a resize
const frameShare = (percent: number): string => `(100% - ${RAIL_WIDTH}px) * ${percent} / 100`;

/** The left column spans the rail and the left group while the left side is open. Closed, it is the window buttons' block in a window, and
 * the rail's own width in full screen, where macOS hides them, so panel-left sits over the rail's icons. The right one spans the right group
 * while the right column shows. */
export function headerColumns(layout: ViewLayout, rightShown: boolean, isFullScreen: boolean): HeaderColumns {
  const closedLeft = isFullScreen ? `${RAIL_WIDTH}px` : CLOSED_WINDOW_LEFT;
  return {
    left: layout.open.left ? `calc(${RAIL_WIDTH}px + ${frameShare(layout.sizes.left)})` : closedLeft,
    right: rightShown ? `calc(${frameShare(layout.sizes.right)})` : undefined,
  };
}
