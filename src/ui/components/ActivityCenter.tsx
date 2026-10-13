import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type CenterDrag, useCenterDrag } from '@/components/center-drag';
import { CenterGroup, closePaneOf, closeTab } from '@/components/CenterGroup';
import { ActivityHome } from '@/components/ActivityHome';
import { useConfirmLoss } from '@/components/AgentLossConfirm';
import { type ConfirmLoss, useCloseTab } from '@/components/close-tab-notice';
import { Confirm } from '@/components/Confirm';
import type { PaneContext } from '@/components/PaneHeader';
import { NewRunButton, useNewRunKeys } from '@/components/NewRunButton';
import { SplitBox } from '@/components/SplitBox';
import { type SplitOpen, useSplit, useSplitSameKey } from '@/components/SplitMenu';
import { useSplitTerminalKeys } from '@/components/split-terminal-keys';
import { continueSleeping } from '@/components/sleeping-run';
import { useOpenRun } from '@/components/terminal-tabs';
import type { CenterOps } from '@/hooks/use-center-layouts';
import { t } from '@/i18n';
import { type Activity, sleepingOf, withRestored } from '@/lib/activities';
import { type CenterLayout, type CenterNode, type CenterTabRef, groupsOf, sharesBuffer, type TabGroup } from '@/lib/center-layout';
import { bufferPath } from '@/lib/center-files';
import * as models from '@/lib/editor-models';

interface ActivityCenterProps { activity: Activity; layout?: CenterLayout; ops: CenterOps; fileLinks: boolean; fontFamily: string; pane?: PaneContext;
  onOpenRun(ptyId: string): void; // #759: what the home's rows open, as the sidebar's lines open them
}

// What every node of the tree hands down: the activity, the whole layout's groups and focus, the operations and the drag
interface Shared {
  activity: Activity; groups: TabGroup[]; focused: string; ops: CenterOps; drag: CenterDrag; fileLinks: boolean; fontFamily: string; pane: PaneContext; onSplit: SplitOpen;
  onExit(ptyId: string): void;
  onWake(ptyId: string): void; // a sleeping tab's or pane's click (#672)
  onClose(item: CenterTabRef): void; // a tab's close, through the unsaved-edits confirm (#717)
}

// A child's key: its group's id, or a split's first group's, so a node keeps its element while the tree around it changes
const nodeKey = (node: CenterNode): string => (node.kind === 'group' ? node.id : `split:${groupsOf(node)[0].id}`);

// A node of the tree (#458): a group, or a split of nodes with a divider between each pair (SplitBox, shared with a split tab's panes, #641)
function NodeView({ node, path, shared }: { node: CenterNode; path: number[]; shared: Shared }) {
  if (node.kind === 'group') return <CenterGroup group={node} {...shared} />;
  const render = (child: CenterNode, at: number[]) => <NodeView node={child} path={at} shared={shared} />;
  return <SplitBox split={node} path={path} label={t('center.resize')} onResize={shared.ops.resize} keyOf={nodeKey} render={render} />;
}

// An agent's run, live or sleeping (#672), or a sleeping terminal (#696): its stream's end leaves its tab to the state, which keeps it asleep
// or prunes it. A live terminal whose shell exits by itself is not asleep yet when its stream ends: its tab closes, as the spec asks
const keepsTab = (activity: Activity, ptyId: string): boolean =>
  activity.runs.some((run) => run.ptyId === ptyId && run.kind !== 'terminal') || sleepingOf(activity, ptyId) !== undefined;

const NO_CONTEXT: PaneContext = {}; // the terminal's harness and the tests: no model, no folder

// ⌘W's group (#585): the one holding the keyboard focus, since a terminal takes focus without a pointer down; else the layout's focused one
function closeKeyGroup(layout: CenterLayout): TabGroup | undefined {
  const holder = document.activeElement?.closest('[data-center-group]')?.getAttribute('data-center-group');
  const groups = groupsOf(layout.root);
  return groups.find((group) => group.id === holder) ?? groups.find((group) => group.id === layout.focused);
}

// A tab's close (#452, #614): its X, its middle-click, its menu's Fechar and ⌘W. The last tab holding a file's buffer, its editor or its changes
// tab (#668), asks first over unsaved edits, and descartar drops them with the tab (#717)
function useTabClose(activity: Activity, layout: CenterLayout | undefined, ops: CenterOps, confirmLoss: ConfirmLoss): { close(item: CenterTabRef): void; confirm: ReactNode } {
  const settings = useCloseTab();
  const openRun = useOpenRun();
  const [asking, setAsking] = useState<CenterTabRef>();
  const now = (item: CenterTabRef): void => closeTab(item, activity, ops, settings, confirmLoss, openRun, sharesBuffer(layout, item));
  const close = (item: CenterTabRef): void => {
    const buffer = bufferPath(item);
    if (buffer !== undefined && !sharesBuffer(layout, item) && models.isDirty(activity.activity.id, buffer)) setAsking(item); // a file's, its changes' or an untitled one's (#818)
    else now(item);
  };
  const confirm = (
    <Confirm
      open={asking !== undefined} onOpenChange={(isOpen) => { if (!isOpen) setAsking(undefined); }}
      title={t('confirm.title.discardEdits')} message={t('editor.discardConfirm')} confirmLabel={t('editor.discard')} onConfirm={() => { if (asking) now(asking); }}
    />
  );
  return { close, confirm };
}

// ⌘W / Window → Close (#585): main's menu sends it and the preload hands it to this callback. It closes the shown tab as its X does, notice,
// sleep and the unsaved-edits confirm included (#614, #717); on a split tab only its focused pane, iTerm's ⌘W (#641). With no tab it does
// nothing, since the close key never closes the window (#612). The menu's accelerator is the only key: a renderer listener for ⌘W would fire twice
function useCloseKey(activity: Activity, layout: CenterLayout | undefined, ops: CenterOps, close: (item: CenterTabRef) => void, confirmLoss: ConfirmLoss): void {
  const settings = useCloseTab();
  const openRun = useOpenRun();
  useEffect(() => window.hive?.onCloseKey(() => {
    const group = layout && closeKeyGroup(layout);
    const shown = group?.tabs[group.active];
    if (shown === undefined) return;
    if (shown.kind === 'run' && shown.panes !== undefined) closePaneOf(shown.panes.focused, activity, ops, settings, confirmLoss, openRun);
    else close(shown);
  }), [activity, layout, ops, settings, openRun, close, confirmLoss]);
}

/** The picked activity as the window's center (#457, #458): its layout's tree of groups (its bar moved to the window header, #221), split side by
 * side and one above the other by the tab menu or a drag, each group a tab strip over its tabs' views (runs' terminals and the task's diffs).
 * With no tab left, the strip keeps only its + over the activity's home (#759). A run's terminal is an attach of its own, so the Terminal panel may show the same run at
 * once. A tab moved to another group remounts there, still one attach per run in the layout. */
export function ActivityCenter({ activity: given, layout, ops, fileLinks, fontFamily, pane = NO_CONTEXT, onOpenRun }: ActivityCenterProps) {
  const activity = withRestored(given, layout); // #696: the sleeping tabs a restart left
  const latest = useRef({ ops, activity });
  useEffect(() => {
    latest.current = { ops, activity };
  });
  // Stable: PtyTab reconnects whenever its onExit changes (#457). A terminal whose stream ended leaves the layout: its pane on a split tab
  // (#641), else its tab, as its X does. An agent's tab stays: the state turns it asleep or prunes it (#672)
  const onExit = useCallback((ptyId: string) => {
    const { ops: now, activity: shown } = latest.current;
    if (!keepsTab(shown, ptyId)) now.closePane(ptyId);
  }, []);
  // A sleeping tab's click (#672): its session continues in a new run that takes the tab over
  const onWake = useCallback((ptyId: string) => continueSleeping(latest.current.activity, ptyId, latest.current.ops), []);
  const drag = useCenterDrag(ops.land);
  const onSplit = useSplit(activity, layout, ops); // one pending split for the whole center: the menu's and the key's (#536)
  useSplitSameKey(activity, layout, onSplit);
  useSplitTerminalKeys(activity, layout, ops); // ⌘D / ⌘⇧D split the focused run tab inside itself (#641)
  const newFile = (): void => ops.open({ kind: 'untitled', n: models.nextUntitled() });
  const newSessionDialog = useNewRunKeys(activity, newFile); // #257: the dialog its key and the +'s nova sessão… open
  const loss = useConfirmLoss(); // #696: the agent confirm before a terminal's tab sleeps it
  const closer = useTabClose(activity, layout, ops, loss.confirm);
  useCloseKey(activity, layout, ops, closer.close, loss.confirm);
  // #759: with no tab the strip keeps only its + (nothing to split, no group to drop on, so no data-center-strip), over the activity's home
  const body = layout === undefined
    ? (
      <>
        <div className="flex h-[34px] shrink-0 items-stretch border-b"><NewRunButton activity={activity} onNewFile={newFile} /></div>
        <ActivityHome activity={activity} onOpenRun={onOpenRun} />
      </>
    )
    : (
      <div data-center-root className="flex min-h-0 min-w-0 flex-1">
        <NodeView
          node={layout.root} path={[]}
          shared={{ activity, groups: groupsOf(layout.root), focused: layout.focused, ops, drag, fileLinks, fontFamily, pane, onSplit, onExit, onWake, onClose: closer.close }}
        />
      </div>
    );
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}{closer.confirm}{loss.dialog}{newSessionDialog}</div>;
}
