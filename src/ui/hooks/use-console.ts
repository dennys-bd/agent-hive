import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CHANNEL_KINDS, CHANNEL_STATUSES, type ChannelEntry, type ChannelKind, type ChannelStatus } from '../../console';
import type { ConsoleSelection } from '@/components/ConsolePanel';
import { getJson } from '@/lib/api';
import { onConsoleChange } from '@/lib/console-events';

/** A run command's start, handed to the console (#353): its channel's id and the new run's pty id. The footer's chip switches to it; the
 * drawer opens only with `show` (#537), a setup's ver log, since a command's start only flags the chip. */
export type OpenConsole = (channel: string, ptyId: string, show?: boolean) => void;

/** MainDock's console opener; undefined outside a Dashboard (a component test, the first-run form), as TerminalTabsContext is. */
export const ConsoleContext = createContext<OpenConsole | undefined>(undefined);

export const useOpenConsole = (): OpenConsole | undefined => useContext(ConsoleContext);

/** The drawer's tabs (#225): the console's channels, or the problems list. */
export type ConsoleTab = 'console' | 'problems';

export interface ConsoleChannels {
  channels: ChannelEntry[]; // newest run first (#537)
  selection?: ConsoleSelection;
  stamp: string; // changes on every read of the list: the panel reads its shown channel again with it
  isOpen: boolean; // the drawer over the center (#537), per viewer and in memory
  tab: ConsoleTab; // #225: what the open drawer shows, in memory, never persisted
  select(selection: ConsoleSelection): void;
  refresh(): void;
  show(tab: ConsoleTab): void; // ⌘J, ⌘⇧M, the chip and the problems button: open on `tab`, switch to it, or close the drawer showing it
  open(tab: ConsoleTab): void; // a channel opened, the segmented control: never closes
  close(): void;
}

/** The Dashboard's channels, for a console tab in the activity's grid (#537); undefined outside a Dashboard. */
export const ConsoleChannelsContext = createContext<ConsoleChannels | undefined>(undefined);

export const useConsoleChannelsContext = (): ConsoleChannels | undefined => useContext(ConsoleChannelsContext);

/** The channel the console shows (#353): the picked one while it is listed, else the newest. */
export const shownChannel = (channels: ChannelEntry[], selection?: ConsoleSelection): ChannelEntry | undefined =>
  channels.find((c) => c.id === selection?.channel) ?? channels[0];

// One entry of GET /console's answer; anything else is dropped
function isChannel(value: unknown): value is ChannelEntry {
  if (typeof value !== 'object' || value === null) return false;
  const { id, kind, label, status } = value as Record<string, unknown>;
  return typeof id === 'string' && CHANNEL_KINDS.includes(kind as ChannelKind) && typeof label === 'string' && CHANNEL_STATUSES.includes(status as ChannelStatus);
}

/** The daemon's console channels (#353), read on mount, whenever `runs` changes (the live command runs' pty ids, joined: one started or
 * ended anywhere) on refresh() (a command started here) and when the daemon's console event says a channel was added or a run ended (#780). A failed read keeps the last list: the next run that starts or ends reads it
 * again. The selection is this viewer's own and never stored. */
export function useConsoleChannels(runs: string): ConsoleChannels {
  const [channels, setChannels] = useState<ChannelEntry[]>([]);
  const [selection, setSelection] = useState<ConsoleSelection>();
  const [drawer, setDrawer] = useState<{ isOpen: boolean; tab: ConsoleTab }>({ isOpen: false, tab: 'console' });
  const show = useCallback((tab: ConsoleTab) => setDrawer((d) => (d.isOpen && d.tab === tab ? { ...d, isOpen: false } : { isOpen: true, tab })), []);
  const open = useCallback((tab: ConsoleTab) => setDrawer({ isOpen: true, tab }), []);
  const close = useCallback(() => setDrawer((d) => ({ ...d, isOpen: false })), []);
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((n) => n + 1), []);
  useEffect(() => onConsoleChange(refresh), [refresh]); // a format run or a language server is no pty: the daemon says when its channel changed (#780)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs and reads are the triggers of a new read, not values it uses
  useEffect(() => {
    let current = true; // an older read answering late never replaces a newer one
    getJson<unknown>('/console').then(
      (value) => { if (current) setChannels(Array.isArray(value) ? value.filter(isChannel) : []); },
      () => undefined, // kept: see the doc comment
    );
    return () => { current = false; };
  }, [runs, reads]);
  return { channels, selection, stamp: `${runs}|${reads}`, isOpen: drawer.isOpen, tab: drawer.tab, select: setSelection, refresh, show, open, close };
}

/** A run command's start (#353): the console switches to the command's channel and the new run, and the list is read again, since the
 * channel may be new. The footer's chip shows it; the drawer opens, on its console tab (#225), only when asked (redesign 05). */
export function useConsoleOpener(channels?: ConsoleChannels): OpenConsole {
  const select = channels?.select;
  const refresh = channels?.refresh;
  const open = channels?.open;
  return useCallback((channel: string, ptyId: string, show?: boolean) => {
    select?.({ channel, ptyId });
    refresh?.();
    if (show) open?.('console');
  }, [select, refresh, open]);
}

/** ver saída (#755): the task's activity picked with its commands stage's locked console tab, opened or shown. */
export type OpenStageOutput = (taskId: string, channel: string, run: string) => void; // run: the stage execution's id, which scopes the tab to it

/** MainDock's opener of a commands stage's output; undefined outside a Dashboard, as ConsoleContext is. */
export const StageOutputContext = createContext<OpenStageOutput | undefined>(undefined);

export const useOpenStageOutput = (): OpenStageOutput | undefined => useContext(StageOutputContext);
