import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { CHANNEL_STATUSES, type ChannelEntry, type ChannelStatus, type ChannelView, runLabel } from '../../console';
import { act } from '@/components/actions';
import { LinkConfirm } from '@/components/LinkConfirm';
import { fitOnResize } from '@/components/PtyTab';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { shownChannel } from '@/hooks/use-console';
import { type MessageKey, t } from '@/i18n';
import { getJson } from '@/lib/api';
import { connectPty, type PtyConnection } from '@/lib/pty-stream';
import { linkHandler } from '@/lib/trusted-links';
import { followTheme, type TerminalPalette } from '@/lib/xterm-setup';

/** The channel, and the run in it, this viewer picked (#353): from a command's start or a select. Never stored: a reload shows the first. */
export interface ConsoleSelection { channel: string; ptyId?: string }

export interface ConsolePanelProps {
  channels: ChannelEntry[]; selection?: ConsoleSelection; stamp: string; fontFamily: string;
  onSelect(selection: ConsoleSelection): void; onStale(): void;
  drawer?: ConsoleDrawerActions; // in the drawer (#537); absent: a grid tab
  locked?: boolean; // #755: a commands stage's tab: its one channel, by label, with no channel select and no fallback to another
  run?: string; // #755: the stage execution a locked tab shows: only its runs of the shared channel
}

/** The drawer's own actions: esc, and abrir como aba, disabled while no activity's grid is there to take it. */
export interface ConsoleDrawerActions { onClose(): void; onOpenTab?(): void }

type LiveRun = ChannelView['live'][number];

// GET /console/:id's answer; anything else reads as no view
function isView(value: unknown): value is ChannelView {
  if (typeof value !== 'object' || value === null) return false;
  const { history, live, status } = value as Record<string, unknown>;
  return typeof history === 'string' && CHANNEL_STATUSES.includes(status as ChannelStatus) && Array.isArray(live) && live.every((r) => typeof r?.ptyId === 'string' && typeof r?.header === 'string');
}

// The shown channel as the daemon holds it: read again when the channel changes, on every stamp (a command run started or ended anywhere) and
// on reread() (the shown run ended here). A failed read means the channel is gone (a daemon restart): onStale reads the list again, which
// drops it. A view read for another channel is never shown. `run`: a stage tab's execution, which the daemon filters the runs by (#755).
function useChannelView(id: string, run: string | undefined, stamp: string, onStale: () => void): { view?: ChannelView; reread(): void } {
  const [loaded, setLoaded] = useState<{ id: string; run?: string; view: ChannelView }>();
  const [reads, setReads] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stamp and reads are the triggers of a new read, not values it uses
  useEffect(() => {
    if (id === '') return;
    let current = true; // an older read answering late never replaces a newer one
    getJson<unknown>(`/console/${encodeURIComponent(id)}${run === undefined ? '' : `?run=${encodeURIComponent(run)}`}`).then(
      (value) => { if (current && isView(value)) setLoaded({ id, run, view: value }); },
      () => { if (current) onStale(); },
    );
    return () => { current = false; };
  }, [id, run, stamp, reads, onStale]);
  const reread = useCallback(() => setReads((n) => n + 1), []);
  return { view: loaded?.id === id && loaded.run === run ? loaded.view : undefined, reread };
}

interface ConsoleViewProps { history: string; run?: LiveRun; fontFamily: string; palette: TerminalPalette; onEnd(): void }

const FONT_SIZE = 12; // redesign 05: 12px/18px mono
const LINE_HEIGHT = 1.5;

// The console's one xterm: the channel's finished runs, then the shown live run's header, then that run over its pty socket (#407), its
// scrollback first. disableStdin: no key reaches the run, so no Ctrl+C either. A new history, another run or another font rebuilds it: its
// screen is only that text, so nothing is lost. Its fit resizes the run's pty, which has no other viewer.
function ConsoleView({ history, run, fontFamily, palette, onEnd }: ConsoleViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const ptyId = run?.ptyId;
  const header = run?.header ?? '';
  const [pendingUrl, setPendingUrl] = useState<string>(); // a link a command printed follows the terminal's trusted-domain rule (#404)
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const xterm = new Terminal({ fontFamily, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, disableStdin: true, linkHandler: linkHandler(setPendingUrl) });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element);
    const stopTheme = followTheme(xterm, palette);
    if (history !== '') xterm.write(history);
    let connection: PtyConnection | undefined;
    if (ptyId !== undefined) {
      xterm.write(header);
      connection = connectPty(xterm, ptyId, onEnd); // its close is the run's end: the channel is read again, the run now in the history
    }
    const sized = fitOnResize({ fit, host: element }, () => connection?.postSize()); // #808: its first shown fit posts the run's grid
    return () => {
      sized.disconnect();
      connection?.disconnect();
      stopTheme();
      xterm.dispose();
    };
  }, [history, ptyId, header, fontFamily, palette, onEnd]);
  return (
    <>
      <div ref={host} className="min-h-0 min-w-0 flex-1 px-3.5 py-2" />
      <LinkConfirm url={pendingUrl} onClose={() => setPendingUrl(undefined)} />
    </>
  );
}

// redesign 05's select: a bordered chip, `agent-hive · hive test ⌄`, no fill and a small chevron right after the text
const TRIGGER = 'gap-1 rounded-md border-border px-2 py-0.5 text-xs text-foreground shadow-none data-[size=sm]:h-auto dark:bg-transparent dark:hover:bg-accent [&_svg]:size-3! [&_svg]:opacity-100!';
const ACTION = 'h-auto px-1.5 py-0.5 text-xs font-normal text-muted-foreground';

// What the header says of the shown channel's last run (#537): executando while live, falhou once it exited non-zero, concluído once done
const STATUS: Record<ChannelStatus, { key: MessageKey; className: string }> = {
  running: { key: 'console.running', className: 'text-working' },
  failed: { key: 'console.failed', className: 'text-destructive' },
  done: { key: 'console.done', className: 'text-muted-foreground' },
};

function ChannelState({ status }: { status?: ChannelStatus }) {
  if (status === undefined) return null;
  return <span role="status" className={STATUS[status].className}>{t(STATUS[status].key)}</span>;
}

// Plain output greyed, the echoed command (bright white) in the foreground, on the surface the console sits on (redesign 05)
const DRAWER_PALETTE: TerminalPalette = { background: '--popover', foreground: '--muted-foreground', brightWhite: '--foreground', green: '--signal-green', red: '--signal-red' };
const TAB_PALETTE: TerminalPalette = { background: '--background', foreground: '--muted-foreground', brightWhite: '--foreground', green: '--signal-green', red: '--signal-red' };

interface BarProps { channels: ChannelEntry[]; channel?: ChannelEntry; onSelect(selection: ConsoleSelection): void }

// The channel select, shared by the drawer's bar and a plain tab's line
function ChannelSelect({ channels, channel, onSelect }: BarProps) {
  if (channel === undefined) return null;
  return (
    <Select value={channel.id} onValueChange={(picked) => onSelect({ channel: picked })}>
      <SelectTrigger size="sm" aria-label={t('console.channel')} className={TRIGGER}><SelectValue /></SelectTrigger>
      <SelectContent>{channels.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}

// A grid tab's header (#755): one 26px line styled as PaneHeader's, which a console tab does not get. A commands stage's locked tab reads
// `log <channel> <status of its own execution>`; a plain one `console <channel select> <channel status>`. No run select, no limpar
function TabLine({ channels, channel, onSelect, locked, status }: BarProps & { locked: boolean; status?: ChannelStatus }) {
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-2 px-3 text-muted-foreground text-xs">
      <span className="shrink-0 text-foreground">{t(locked ? 'console.log' : 'console.title')}</span>
      {locked ? channel && <span className="min-w-0 truncate">{channel.label}</span> : <ChannelSelect channels={channels} channel={channel} onSelect={onSelect} />}
      <ChannelState status={status} />
    </div>
  );
}

interface DrawerBarProps extends BarProps { id: string; live: LiveRun[]; run?: LiveRun; drawer: ConsoleDrawerActions; onClear(): void }

function DrawerBar({ channels, channel, onSelect, id, live, run, drawer, onClear }: DrawerBarProps) {
  return (
    <div className="flex h-[34px] shrink-0 items-center gap-2.5 border-b px-3 text-muted-foreground text-xs">
      <span className="font-medium text-foreground">{t('console.title')}</span>
      <ChannelSelect channels={channels} channel={channel} onSelect={onSelect} />
      {live.length > 1 && (
        <Select value={run?.ptyId} onValueChange={(ptyId) => onSelect({ channel: id, ptyId })}>
          <SelectTrigger size="sm" aria-label={t('console.run')} className={TRIGGER}><SelectValue /></SelectTrigger>
          <SelectContent>{live.map((r) => <SelectItem key={r.ptyId} value={r.ptyId}>{runLabel(r.header)}</SelectItem>)}</SelectContent>
        </Select>
      )}
      <ChannelState status={channel?.status} />
      <span className="flex-1" />
      <Button type="button" variant="ghost" size="xs" className={ACTION} disabled={drawer.onOpenTab === undefined} onClick={drawer.onOpenTab}>{t('console.openTab')}</Button>
      {channel && <Button type="button" variant="ghost" size="xs" className={ACTION} onClick={onClear}>{t('console.clear')}</Button>}
      <Button type="button" variant="ghost" size="xs" className={ACTION} aria-label={t('console.close')} onClick={drawer.onClose}>esc</Button>
    </div>
  );
}

/** The console (#353, redesign 05), in the drawer over the center or as a grid tab. The drawer has a bar with console, the channel select (the
 * commands run in every workspace, newest first), the run select with two or more live runs in the shown channel, the last run's status, then
 * abrir como aba, limpar and esc; a tab has one 26px line instead (#755). Under it the read-only view. It shows the picked channel, else the
 * newest, and the picked run, else the newest live one. A locked tab (#755) shows its one channel by label and nothing while that channel is
 * not listed, and only the runs of its `run` execution. It stops nothing: a run stops where it started. limpar drops the channel's finished
 * runs on the daemon, for every viewer. */
export function ConsolePanel({ channels, selection, stamp, fontFamily, onSelect, onStale, drawer, locked = false, run: execution }: ConsolePanelProps) {
  // a locked tab shows its own channel or nothing: the newest of another would read as the stage's output (#755)
  const channel = locked ? channels.find((c) => c.id === selection?.channel) : shownChannel(channels, selection);
  const id = channel?.id ?? '';
  const { view, reread } = useChannelView(id, locked ? execution : undefined, stamp, onStale);
  const live = view?.live ?? [];
  const run = live.find((r) => r.ptyId === selection?.ptyId) ?? live.at(-1);
  const clear = (): void => { void act(`/console/${encodeURIComponent(id)}/clear`).then(reread); };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {drawer
        ? <DrawerBar channels={channels} channel={channel} onSelect={onSelect} id={id} live={live} run={run} drawer={drawer} onClear={clear} />
        : <TabLine channels={channels} channel={channel} onSelect={onSelect} locked={locked} status={locked ? view?.status : channel?.status} />}
      {channel === undefined && <p className="px-3.5 py-2 text-muted-foreground text-xs">{t('console.empty')}</p>}
      {view && <ConsoleView history={view.history} run={run} fontFamily={fontFamily} palette={drawer ? DRAWER_PALETTE : TAB_PALETTE} onEnd={reread} />}
    </div>
  );
}
