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

export interface ConsoleChannels {
  channels: ChannelEntry[]; // newest run first (#537)
  selection?: ConsoleSelection;
  stamp: string; // changes on every read of the list: the panel reads its shown channel again with it
  isOpen: boolean; // the drawer over the center (#537), per viewer and in memory
  select(selection: ConsoleSelection): void;
  refresh(): void;
  setOpen(isOpen: boolean): void;
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
  const [isOpen, setOpen] = useState(false);
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
  return { channels, selection, stamp: `${runs}|${reads}`, isOpen, select: setSelection, refresh, setOpen };
}

/** ver saída (#755): the task's activity picked with its commands stage's locked console tab, opened or shown. */
export type OpenStageOutput = (taskId: string, channel: string, run: string) => void; // run: the stage execution's id, which scopes the tab to it

/** MainDock's opener of a commands stage's output; undefined outside a Dashboard, as ConsoleContext is. */
export const StageOutputContext = createContext<OpenStageOutput | undefined>(undefined);

export const useOpenStageOutput = (): OpenStageOutput | undefined => useContext(StageOutputContext);
