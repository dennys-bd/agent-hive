import { useEffect, useRef, useState } from 'react';
import { openNew } from '@/components/NewRunButton';
import { useOpenRun } from '@/components/terminal-tabs';
import type { CenterOps } from '@/hooks/use-center-layouts';
import { type Activity, canOpenIn } from '@/lib/activities';
import { type CenterLayout, groupsOf, refKey } from '@/lib/center-layout';
import { onShortcutKey } from '@/lib/dock-layout';
import type { Axis } from '@/lib/split-tree';
import type { OperationId } from '../../types';

// iTerm's two keys (#641): vertical puts the new pane on the right of a vertical divider (a row), horizontal puts it below (a column)
const KEYS: ReadonlyArray<[Axis, OperationId]> = [['row', 'splitTerminalVertical'], ['column', 'splitTerminalHorizontal']];

interface PendingPane { anchor: string; key: string; axis: Axis }

/** ⌘D and ⌘⇧D (#641): the focused group's run tab split inside itself with a new terminal, opened as the + opens one. The open is posted,
 * then the answered run's tab is awaited: the run opener puts it in the focused group once the run is live, a broadcast after the answer,
 * and only then is it folded into the anchor tab's focused pane, as useSplit waits before its land. Nothing on a diff, a PR, the console or
 * an activity that opens nothing. Mounted with the center, so the keys act only while an activity shows. */
export function useSplitTerminalKeys(activity: Activity, layout: CenterLayout | undefined, ops: CenterOps): void {
  const openRun = useOpenRun();
  const { splitPane } = ops;
  const [pending, setPending] = useState<PendingPane>(); // ponytail: one split in flight; a second key before the first run shows replaces it
  const isLanded = pending !== undefined && layout !== undefined
    && groupsOf(layout.root).some((group) => group.tabs.some((tab) => refKey(tab) === pending.key));
  useEffect(() => {
    if (pending === undefined || !isLanded) return;
    setPending(undefined);
    splitPane(pending.anchor, pending.key, pending.axis);
  }, [pending, isLanded, splitPane]);
  const latest = useRef<(axis: Axis) => void>(() => undefined);
  useEffect(() => {
    latest.current = (axis) => {
      const group = layout === undefined ? undefined : groupsOf(layout.root).find((g) => g.id === layout.focused);
      const shown = group?.tabs[group.active];
      if (shown?.kind !== 'run' || !canOpenIn(activity)) return;
      const anchor = refKey(shown);
      openNew(activity, 'terminal', openRun, (key) => setPending({ anchor, key, axis }));
    };
  });
  useEffect(() => onShortcutKey(KEYS, (axis) => latest.current(axis)), []);
}
