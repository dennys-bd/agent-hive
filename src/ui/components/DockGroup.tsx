import { XIcon } from 'lucide-react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { Divider } from '@/components/Divider';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { type MessageKey, t } from '@/i18n';
import { isLocked, type PanelId, type Side, SIDE_BOUNDS, SIDES } from '@/lib/dock-layout';

/** One panel as the dock sees it (#342): its tab's title, its header actions (shown while it is the active tab) and its body. It always has
 * a tab: only the whole group closes (#452). */
export interface DockPanel {
  id: PanelId; title: string; actions?: ReactNode; body: ReactNode;
  ownHeader?: boolean; // the body draws its own header (redesign 07, 03, 09), in place of the group's when hasOwnHeaders says so
}

export interface DockGroupProps {
  side: Side; size: number; panels: DockPanel[]; active?: PanelId; open: boolean; measure: RefObject<HTMLElement | null>;
  onActivate(id: PanelId): void; onMove(id: PanelId, side: Side): void; onResize(size: number): void; onClose(): void;
}

const STEP = 5; // percent per arrow key on a group's divider

// No group header when the bodies draw their own: a panel alone, or only Automação and Atividades, the two views the window header switches
// between (#533, #699). A panel docked beside them keeps the tabs, the one way to reach it.
const hasOwnHeaders = (panels: DockPanel[]): boolean => panels.every((panel) => panel.ownHeader) && (panels.length === 1 || panels.every((panel) => isLocked(panel.id)));

// Per side (#342): the divider's axis and arrows (the one pointing away from the group's edge widens it), the pointer's share of the rect
// DockFrame measures (the frame), the group's flex direction, and its copy.
interface Geometry {
  axis: 'vertical' | 'horizontal'; keys: Record<string, number>; direction: string; label: MessageKey; move: MessageKey;
  toValue(rect: DOMRect, clientX: number, clientY: number): number;
}
const GEOMETRY: Record<Side, Geometry> = {
  left: {
    axis: 'vertical', keys: { ArrowRight: STEP, ArrowLeft: -STEP }, direction: 'flex-row', label: 'dock.resize.left', move: 'dock.moveLeft',
    toValue: (rect, clientX) => ((clientX - rect.left) / rect.width) * 100,
  },
  right: {
    axis: 'vertical', keys: { ArrowLeft: STEP, ArrowRight: -STEP }, direction: 'flex-row', label: 'dock.resize.right', move: 'dock.moveRight',
    toValue: (rect, clientX) => ((rect.right - clientX) / rect.width) * 100,
  },
};

// Collapsed with an inline opacity and a zero basis, not the `hidden` attribute or a class: dom-accessibility-api refuses a name to a
// `hidden` element even under getByRole's own `hidden: true`, and Tailwind's classes never reach a computed style under jsdom (PtyTab.tsx).
const SHOWN: CSSProperties = { flex: '1 1 0%', opacity: 1, pointerEvents: 'auto' };
const COLLAPSED: CSSProperties = { flex: '0 0 0%', opacity: 0, pointerEvents: 'none' };
const COLLAPSED_GROUP: CSSProperties = { flexBasis: 0, opacity: 0, pointerEvents: 'none' };

interface DockTabProps { panel: DockPanel; side: Side; selected: boolean; isAlone: boolean; onActivate(id: PanelId): void; onMove(id: PanelId, side: Side): void }

// A tab (#342): its title activates it, and a right-click on it offers the two other sides (drag-to-dock is out of scope). A tab never
// closes (#452): it only moves between panels. Automação and Atividades stay on the left (#458): no menu offers to move them.
// A panel's only tab has nothing to switch to: it reads as the panel's plain title, muted, never as a selected chip (redesign 06)
function DockTab({ panel, side, selected, isAlone, onActivate, onMove }: DockTabProps) {
  const look = isAlone ? 'bg-transparent font-normal text-muted-foreground hover:bg-transparent dark:hover:bg-transparent' : undefined;
  const tab = (
    <Button type="button" role="tab" aria-selected={selected} size="xs" variant={selected && !isAlone ? 'secondary' : 'ghost'} className={look} onClick={() => onActivate(panel.id)}>
      {panel.title}
    </Button>
  );
  if (isLocked(panel.id)) return tab;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{tab}</ContextMenuTrigger>
      <ContextMenuContent>
        {SIDES.filter((other) => other !== side).map((other) => (
          <ContextMenuItem key={other} onSelect={() => onMove(panel.id, other)}>{t(GEOMETRY[other].move)}</ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface GroupHeaderProps { side: Side; panels: DockPanel[]; active?: PanelId; onActivate(id: PanelId): void; onMove(id: PanelId, side: Side): void; onClose(): void }

// The group's header (#342, #452): one tab per docked panel, then the active panel's own actions (the terminal's +, #292), then the
// panel's X, which closes the whole group.
function GroupHeader({ side, panels, active, onActivate, onMove, onClose }: GroupHeaderProps) {
  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      <div role="tablist" aria-orientation="horizontal" className="flex min-w-0 flex-1 items-center gap-1">
        {panels.map((panel) => <DockTab key={panel.id} panel={panel} side={side} selected={panel.id === active} isAlone={panels.length === 1} onActivate={onActivate} onMove={onMove} />)}
      </div>
      {panels.find((panel) => panel.id === active)?.actions}
      <Button type="button" size="icon-xs" variant="ghost" aria-label={t('dock.close')} onClick={onClose}><XIcon /></Button>
    </div>
  );
}

/** One side's group of docked panels (#342), which is the panel the user opens and closes (#452). The divider on its inner edge, then the
 * header, then every body. Only the active one shows; the others stay mounted, collapsed, so switching tabs never remounts a terminal.
 * Closed, the group keeps every body mounted but shows nothing, no header and no divider, so no empty strip is left and terminal streams
 * keep running. The element order never changes with `open`: the header and the divider are placeholders when absent. */
export function DockGroup({ side, size, panels, active, open, measure, onActivate, onMove, onResize, onClose }: DockGroupProps) {
  if (panels.length === 0) return null;
  const geometry = GEOMETRY[side];
  const divider = open && (
    <Divider
      axis={geometry.axis} value={size} min={SIDE_BOUNDS[side].min} max={SIDE_BOUNDS[side].max} keys={geometry.keys}
      label={t(geometry.label)} measure={measure} toValue={geometry.toValue} onChange={onResize}
    />
  );
  const content = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {open && !hasOwnHeaders(panels) && <GroupHeader side={side} panels={panels} active={active} onActivate={onActivate} onMove={onMove} onClose={onClose} />}
      {panels.map((panel) => (
        <div key={panel.id} style={open && panel.id === active ? SHOWN : COLLAPSED} className="flex min-h-0 min-w-0 flex-col overflow-hidden">{panel.body}</div>
      ))}
    </div>
  );
  return (
    <div data-dock={side} style={open ? { flexBasis: `${size}%` } : COLLAPSED_GROUP} className={`flex min-h-0 min-w-0 shrink-0 overflow-hidden ${geometry.direction}`}>
      {side === 'left' ? <>{content}{divider}</> : <>{divider}{content}</>}
    </div>
  );
}
