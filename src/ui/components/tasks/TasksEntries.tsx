import { InboxIcon, ListIcon, WaypointsIcon } from 'lucide-react';
import { type ReactNode, useEffect, useEffectEvent } from 'react';
import { FLOW_ENTRY_IDS } from '../../../shortcut-registry.js';
import { ariaKeyShortcut, displayBinding } from '../../../shortcuts.js';
import type { Flow, OperationId, State } from '../../../types.js';
import { useIsFlowShown } from '@/components/MainDock';
import type { TasksCenter, TasksView } from '@/hooks/use-tasks-center';
import { t } from '@/i18n';
import { isSettingsClosed, onShortcutKey } from '@/lib/dock-layout';
import { binding, isInDialog, isMac, isTextField } from '@/lib/shortcut-bindings';
import { type EntryCount, entryCounts } from '@/lib/tasks-sidebar';

export interface TasksEntriesProps { state: State; center: TasksCenter; show(next: TasksCenter): void }

const ROW = 'flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[13px] hover:bg-accent/50 data-[selected]:bg-muted';
const ICON = 'size-4 shrink-0 text-muted-foreground';
// Decision 10 (#921): a keycap 16px high, at least 22px wide, a 1px border, radius 4, 11px system sans, muted, tabular numerals
const CHIP = 'inline-flex h-4 min-w-[22px] shrink-0 items-center justify-center rounded-[4px] border px-1 font-sans text-[11px] text-muted-foreground tabular-nums tracking-widest';
const NONE: EntryCount = { total: 0, needsYou: 0 };

interface EntryRow { id: string; icon: ReactNode; label: string; count: EntryCount; isSelected: boolean; onClick(): void }

// The nth entry's binding (#921): none past the ninth, none while it is off
const keysOf = (index: number): string | null => {
  const id = FLOW_ENTRY_IDS[index];
  return id === undefined ? null : binding(id);
};

// A row (handoff §4b, #921): icon, name, ● N in the waiting colour when some of its tasks wait for the user, its total, then its key's chip
function Entry({ icon, label, count, isSelected, keys, onClick }: Omit<EntryRow, 'id'> & { keys: string | null }) {
  const mac = isMac();
  const shown = keys === null ? undefined : displayBinding(keys, mac);
  return (
    <button
      type="button" className={ROW} data-selected={isSelected ? '' : undefined} aria-pressed={isSelected} onClick={onClick}
      title={shown === undefined ? undefined : t('tasks.sidebar.entryTitle', { name: label, key: shown })}
      aria-keyshortcuts={keys === null ? undefined : ariaKeyShortcut(keys, mac)}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count.needsYou > 0 && <span className="text-signal-yellow text-xs tabular-nums">{`● ${count.needsYou}`}</span>}
      <span className="w-[18px] text-right text-muted-foreground text-xs tabular-nums">{count.total}</span>
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: the kbd sits inside the button but is not itself focusable; the button announces the key through aria-keyshortcuts */}
      {shown !== undefined && <kbd aria-hidden="true" className={CHIP}>{shown}</kbd>}
    </button>
  );
}

// Decision 11 (#921): the nth key clicks the nth entry, only while the flow view shows and never from a text field, a dialog or Settings.
// Only the keys of entries that exist listen, so a key with no entry goes on; the listener reads the latest render's rows
function useEntryKeys(rows: readonly EntryRow[]): void {
  const isShown = useIsFlowShown();
  const count = Math.min(rows.length, FLOW_ENTRY_IDS.length);
  const pick = useEffectEvent((index: number): void => rows[index]?.onClick());
  useEffect(() => {
    if (!isShown) return undefined;
    const keys = FLOW_ENTRY_IDS.slice(0, count).map((id, i): [number, OperationId] => [i, id]);
    return onShortcutKey(keys, (i) => pick(i), (event) => !isTextField(event.target) && !isInDialog(event.target) && isSettingsClosed());
  }, [isShown, count]);
}

// Decision 11 (#571): a flow center with no flow named shows the first flow, so that row is the selected one
const isFlowShown = (center: TasksCenter, flows: readonly Flow[], name: string): boolean =>
  center.kind === 'tasks' && center.view === 'flow' && (center.flow ?? flows[0]?.name) === name;

/** The tasks section (#572, decision 8): todas em lista, one row per flow in the state's order, sem fluxo, each opening its view and taking its position's key (#921). */
export function TasksEntries({ state, center, show }: TasksEntriesProps) {
  const counts = entryCounts(state);
  const isView = (view: TasksView): boolean => center.kind === 'tasks' && center.view === view;
  const rows: EntryRow[] = [
    { id: 'list', icon: <ListIcon aria-hidden="true" className={ICON} />, label: t('tasks.sidebar.list'), count: counts.all, isSelected: isView('list'), onClick: () => show({ kind: 'tasks', view: 'list' }) },
    ...state.flows.map((flow): EntryRow => ({
      id: `flow:${flow.name}`, icon: <WaypointsIcon aria-hidden="true" className={ICON} />, label: flow.name, count: counts.flows[flow.name] ?? NONE,
      isSelected: isFlowShown(center, state.flows, flow.name), onClick: () => show({ kind: 'tasks', view: 'flow', flow: flow.name }),
    })),
    { id: 'outside', icon: <InboxIcon aria-hidden="true" className={ICON} />, label: t('tasks.sidebar.outside'), count: counts.outside, isSelected: isView('outside'), onClick: () => show({ kind: 'tasks', view: 'outside' }) },
  ];
  useEntryKeys(rows);
  return <div className="flex flex-col gap-0.5">{rows.map(({ id, ...row }, i) => <Entry key={id} {...row} keys={keysOf(i)} />)}</div>;
}
