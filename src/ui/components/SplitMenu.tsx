import { ChevronDownIcon, Columns2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AGENT_IDS } from '../../types';
import { KeyHint } from '@/components/KeyHint';
import { agentName, type NewRunKind, openNew, RUN_AGENT, SEGMENT, SEGMENT_TRACK } from '@/components/NewRunButton';
import { useOpenRun } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CenterOps } from '@/hooks/use-center-layouts';
import { t } from '@/i18n';
import { type Activity, canOpenIn, type RunTarget } from '@/lib/activities';
import { type CenterLayout, groupsOf, refKey, type TabGroup } from '@/lib/center-layout';
import { onShortcutKey } from '@/lib/dock-layout';
import { readView, writeView } from '@/lib/view-state';

/** Where a split puts the new pane (#536): a viewer's habit, kept in the view state like the layouts (#458, #484), never a setting. */
export type SplitEdge = 'right' | 'bottom';
const NEW_PANE_SHARE = 44; // the handoff's minmax(0,1.3fr) minmax(0,1fr): the old pane 56, the new one 44

// 'bottom' reads as bottom; anything else, nothing stored included, as right
export const readSplitEdge = (): SplitEdge => (readView('splitEdge') === 'bottom' ? 'bottom' : 'right');

const writeSplitEdge = (edge: SplitEdge): void => writeView('splitEdge', edge);

/** The kind a same-type split repeats (#536): a terminal for a shell, the agent for an agent session, the focused pane's on a split tab
 * (#641); none while the group shows a diff, the console or a run already gone. */
export function sameKind(activity: Activity, group: TabGroup): NewRunKind | undefined {
  const shown = group.tabs[group.active];
  const ptyId = shown?.kind === 'run' ? (shown.panes?.focused ?? shown.ptyId) : undefined;
  const run = activity.runs.find((r) => r.ptyId === ptyId);
  if (run === undefined) return undefined;
  return run.kind === 'terminal' ? 'terminal' : RUN_AGENT;
}

/** A split's pick: a new session of `kind`, its pane beside `group`. */
export type SplitOpen = (kind: NewRunKind, group: string) => void;
interface PendingSplit { key: string; group: string; edge: SplitEdge }

/** A split (#536): posts the open as the + does, then waits for the answered run's tab. The run opener puts it in the focused group once
 * the run is live, a broadcast after the answer; only then does land move it to the viewer's edge of `group`, the new pane taking 44. */
export function useSplit(target: RunTarget, layout: CenterLayout | undefined, ops: CenterOps): SplitOpen {
  const openRun = useOpenRun();
  const { land } = ops;
  const [pending, setPending] = useState<PendingSplit>(); // ponytail: one split in flight; a second pick before the first run shows replaces it
  const isOpened = pending !== undefined && layout !== undefined
    && groupsOf(layout.root).some((group) => group.tabs.some((tab) => refKey(tab) === pending.key));
  useEffect(() => {
    if (pending === undefined || !isOpened) return;
    setPending(undefined);
    land(pending.key, { kind: 'edge', group: pending.group, edge: pending.edge, share: NEW_PANE_SHARE });
  }, [pending, isOpened, land]);
  return (kind, group) => {
    const edge = readSplitEdge();
    openNew(target, kind, openRun, (key) => setPending({ key, group, edge }));
  };
}

/** The splitSame key (#536): the focused group's shown kind split beside it, as its menu's dividir com o mesmo tipo. Nothing on a diff, the
 * console or a task that opens nothing. Mounted with the center, so the key acts only while an activity shows. */
export function useSplitSameKey(activity: Activity, layout: CenterLayout | undefined, split: SplitOpen): void {
  const latest = useRef<() => void>(() => undefined);
  useEffect(() => {
    latest.current = () => {
      const group = layout === undefined ? undefined : groupsOf(layout.root).find((g) => g.id === layout.focused);
      const kind = group === undefined ? undefined : sameKind(activity, group);
      if (group !== undefined && kind !== undefined && canOpenIn(activity)) split(kind, group.id);
    };
  });
  useEffect(() => onShortcutKey([[true, 'splitSame']], () => latest.current()), []);
}

// posição: a two-way toggle, written at once so the next split, from this menu or the key, reads it. Radio items, not a ToggleGroup: a menu
// roves the arrow keys over its items only, so a toggle inside it was out of the keyboard's reach. A pick keeps the menu open.
function EdgeToggle() {
  const [edge, setEdge] = useState<SplitEdge>(readSplitEdge);
  const pick = (value: string): void => {
    if (value !== 'right' && value !== 'bottom') return;
    writeSplitEdge(value);
    setEdge(value);
  };
  return (
    <DropdownMenuRadioGroup value={edge} onValueChange={pick} className={SEGMENT_TRACK}>
      <DropdownMenuRadioItem value="right" className={SEGMENT} onSelect={(event) => event.preventDefault()}>{t('split.right')}</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="bottom" className={SEGMENT} onSelect={(event) => event.preventDefault()}>{t('split.below')}</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

interface SplitMenuProps { activity: Activity; group: TabGroup; onSplit: SplitOpen }

/** dividir ⌄ on the right of a group's strip (redesign 04, #536): a new pane beside this group with a terminal or an agent's new session
 * (the file pane is not built yet), the edge it goes to, and the same type as the shown tab with its key. Disabled by the rule the + reads. */
export function SplitMenu({ activity, group, onSplit }: SplitMenuProps) {
  const same = sameKind(activity, group);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!canOpenIn(activity)}>
        <Button type="button" size="xs" variant="ghost"><Columns2Icon />{t('split.open')}<ChevronDownIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <DropdownMenuLabel>{t('split.with')}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onSplit('terminal', group.id)}>{t('activities.menu.terminal')}</DropdownMenuItem>
        {AGENT_IDS.map((agent) => <DropdownMenuItem key={agent} onSelect={() => onSplit(agent, group.id)}>{agentName(agent)}</DropdownMenuItem>)}
        <DropdownMenuItem disabled>{t('split.file')}<span className="ml-auto text-muted-foreground text-xs">{t('split.soon')}</span></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('split.position')}</DropdownMenuLabel>
        <EdgeToggle />
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-muted-foreground" disabled={same === undefined} onSelect={() => same && onSplit(same, group.id)}>{t('split.same')}<KeyHint id="splitSame" /></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
