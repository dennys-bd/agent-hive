import { PtyTab } from '@/components/PtyTab';
import { SplitBox } from '@/components/SplitBox';
import { activityRunTab, tabLabel } from '@/components/terminal-tabs';
import type { CenterOps } from '@/hooks/use-center-layouts';
import { t } from '@/i18n';
import { type Activity, sleepingOf } from '@/lib/activities';
import { refKey, type RunRef } from '@/lib/center-layout';
import type { PaneNode } from '@/lib/pane-split';
import { leaves } from '@/lib/split-tree';

// An unfocused pane of a split tab (#641): dimmed as iTerm dims its inactive panes, by opacity alone, since colour is for status
// (docs/agent/design-system.md)
const DIMMED = 0.6;

interface TerminalProps { activity: Activity; active: boolean; fileLinks: boolean; fontFamily: string; onExit(ptyId: string): void; onWake(ptyId: string): void }
export interface TerminalSplitProps extends TerminalProps { item: RunRef; ops: CenterOps }

// One run's xterm, a sleeping run's dimmed and read-only (#672); nothing while its run is gone, a broadcast before the layout drops it
function RunTerminal({ ptyId, focused, activity, active, fileLinks, fontFamily, onExit, onWake }: TerminalProps & { ptyId: string; focused: boolean }) {
  const sleeping = sleepingOf(activity, ptyId);
  const run = activity.runs.find((r) => r.ptyId === ptyId) ?? sleeping?.run;
  if (run === undefined) return null;
  const tab = activityRunTab(activity, run);
  // #696: a terminal sleeps and wakes in its own id: its pane remounts on each change, connecting to the ring it left or the new shell
  const key = run.kind === 'terminal' && sleeping !== undefined ? `${ptyId}:asleep` : ptyId;
  return (
    <PtyTab
      key={key} tab={tab} activityId={activity.activity.id} label={tabLabel(tab)} active={active} focused={focused} fileLinks={fileLinks} fontFamily={fontFamily}
      onExit={onExit} isAsleep={sleeping !== undefined} onWake={() => onWake(ptyId)}
    />
  );
}

// A child's key: its run, or a split's first run, so a pane keeps its terminal while the tree around it changes
const paneKey = (node: PaneNode): string => (node.kind === 'pane' ? node.ptyId : `split:${leaves(node)[0].ptyId}`);

interface PaneViewProps {
  node: PaneNode; path: number[]; focused: string; terminal: TerminalProps;
  onFocus(ptyId: string): void; onResize(path: readonly number[], sizes: number[]): void;
}

function PaneView({ node, path, focused, terminal, onFocus, onResize }: PaneViewProps) {
  if (node.kind === 'split') {
    const render = (child: PaneNode, at: number[]) => <PaneView node={child} path={at} focused={focused} terminal={terminal} onFocus={onFocus} onResize={onResize} />;
    return <SplitBox split={node} path={path} label={t('center.resizePanes')} onResize={onResize} keyOf={paneKey} render={render} />;
  }
  const isFocused = node.ptyId === focused;
  return (
    <div
      data-pane={node.ptyId} data-focused={isFocused ? 'true' : undefined} onPointerDownCapture={() => onFocus(node.ptyId)}
      style={{ opacity: isFocused ? 1 : DIMMED }} className="flex min-h-0 min-w-0 flex-1"
    >
      <RunTerminal ptyId={node.ptyId} focused={isFocused} {...terminal} />
    </div>
  );
}

/** A run tab's body (#457, #641): its one terminal as before, or its panes side by side and stacked with the groups' dividers between them,
 * one PtyTab each. The tab shows and hides as a whole; inside it, the focused pane takes the keys and the others are dimmed. A pointer down
 * in a pane (capture phase, as the group's, so a terminal's own handlers cannot hide it) focuses it. A pane's stream ending is onExit's, as a
 * tab's is. */
export function TerminalSplit({ item, ops, ...terminal }: TerminalSplitProps) {
  const { panes } = item;
  // ponytail: React never moves a component to another parent, so a pane whose place in the tree changes (the first split, the collapse
  // back to one, a nesting around it) remounts its PtyTab; connectPty replays the scrollback and the run redraws for the new size. Portals
  // over long-lived xterms if that redraw ever matters
  if (panes === undefined) return <RunTerminal ptyId={item.ptyId} focused {...terminal} />;
  const key = refKey(item);
  const onFocus = (ptyId: string): void => {
    if (ptyId !== panes.focused) ops.focusPane(key, ptyId);
  };
  const { active } = terminal;
  // Collapsed as PtyTab collapses a hidden tab: an inline zero basis and opacity, every terminal and its stream kept mounted
  return (
    <div style={{ flex: active ? '1 1 0%' : '0 0 0%', opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' }} className="flex min-h-0 min-w-0 overflow-hidden">
      <PaneView node={panes.root} path={[]} focused={panes.focused} terminal={terminal} onFocus={onFocus} onResize={(path, sizes) => ops.resizePane(key, path, sizes)} />
    </div>
  );
}
