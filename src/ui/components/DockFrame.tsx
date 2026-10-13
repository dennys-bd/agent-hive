import { type ReactNode, type RefObject, useRef } from 'react';
import { type DockPanel, DockGroup } from '@/components/DockGroup';
import type { ActiveTabs, PanelId, Side, ViewLayout } from '@/lib/dock-layout';

export interface DockFrameProps {
  layout: ViewLayout; shown: ActiveTabs; panels: DockPanel[]; children: ReactNode;
  onActivate(id: PanelId): void; onMove(id: PanelId, side: Side): void; onResize(side: Side, size: number): void; onClose(side: Side): void;
}

/** The dock frame between the header and the workers footer (#342): the left group, the center column, then the right group, each side
 * group running the frame's full height. There is no bottom group since redesign 05. A panel that changes side lands in another group and
 * remounts. Each group gets its side's open flag and a close for that side (#452). */
export function DockFrame({ layout, shown, panels, children, onActivate, onMove, onResize, onClose }: DockFrameProps) {
  const frame = useRef<HTMLDivElement>(null); // left and right sizes are percent of its width
  const group = (side: Side, measure: RefObject<HTMLElement | null>): ReactNode => (
    <DockGroup
      side={side} size={layout.sizes[side]} panels={panels.filter((panel) => layout.docks[panel.id] === side)} active={shown[side]}
      open={layout.open[side]} measure={measure} onActivate={onActivate} onMove={onMove}
      onResize={(size) => onResize(side, size)} onClose={() => onClose(side)}
    />
  );
  // min-w-0 (#295): as a flex item of DockBody's row, next to the rail, the frame would otherwise take its content's min-content width (a wide
  // tab bar, a terminal, the minimap) and push past the window, so the sides' percentages would be of a wider frame
  return (
    <div ref={frame} className="flex min-h-0 min-w-0 flex-1 flex-row">
      {group('left', frame)}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col"> {/* relative: the console's drawer sits over it (redesign 05) */}
        {children}
      </div>
      {group('right', frame)}
    </div>
  );
}
