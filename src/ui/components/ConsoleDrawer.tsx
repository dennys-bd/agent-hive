import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react';
import type { ChannelStatus } from '../../console';
import { ConsolePanel } from '@/components/ConsolePanel';
import { type ConsoleChannels, type ConsoleTab, shownChannel } from '@/hooks/use-console';
import { t } from '@/i18n';
import { onShortcutKey } from '@/lib/dock-layout';
import { readView, writeView } from '@/lib/view-state';

// The chip's dot (redesign 05): working while the last run is live, destructive once it failed, empty once it ended well or with none yet
const DOT: Record<ChannelStatus, string> = { running: 'bg-working', failed: 'bg-destructive', done: 'bg-empty' };

// The command's own name, `hive test` of `agent-hive · hive test`; a setup's label has no workspace to drop
const commandName = (label: string): string => label.split(' · ').at(-1) ?? label;

/** The footer's console chip (redesign 05), under fluxo and atividades alike: the shown channel's status dot and `console · {command}`. A
 * command started from the UI switches it to that command, which is the only notice; a click opens or closes the drawer. */
export function ConsoleChip({ console: channels }: { console: ConsoleChannels }) {
  const channel = shownChannel(channels.channels, channels.selection);
  const text = channel === undefined ? t('console.title') : t('console.chip', { command: commandName(channel.label) });
  return (
    <button
      type="button" aria-expanded={channels.isOpen && channels.tab === 'console'} onClick={() => channels.show('console')}
      className="flex items-center gap-1.5 rounded-sm bg-muted px-2 py-px text-foreground text-xs"
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[channel?.status ?? 'done']}`} />
      {text}
    </button>
  );
}

// A key that belongs to something else: a text field keeps it, a terminal outside the drawer sends it to its pty (#426), a find bar closes (#12)
const OWNS_ESCAPE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, [data-terminal-find]';
// An open select's list, portalled outside the drawer: its Escape closes the list alone
const OPEN_POPUP = '[role="listbox"], [data-radix-popper-content-wrapper]';

// Escape closes the open drawer (redesign 05). Captured on the document before Detalhes' own listener (#452), which then sees the key as
// handled and keeps its panel open: the drawer is on top. The drawer's own view is read-only, so a key in it closes it too.
function useCloseKey(isOpen: boolean, close: () => void): void {
  useEffect(() => {
    if (!isOpen) return undefined;
    const listener = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(OPEN_POPUP)) return;
      const owner = target?.closest(OWNS_ESCAPE);
      if (owner && !owner.closest('[data-console-drawer]')) return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }, [isOpen, close]);
}

// The drawer's height (redesign 05): dragged by its top handle between MIN_HEIGHT and MAX_SHARE of the center, back to DEFAULT_HEIGHT on a
// double click. Per viewer in the view state (#484), like the dock's layout; anything but a finite number of at least MIN_HEIGHT reads as
// the default. MAX_SHARE depends on the window, so it is applied when dragging, not on read.
export const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;
const MAX_SHARE = 0.7;
const BOTTOM_GAP = 8; // the drawer's bottom-2
const STEP = 16; // pixels per arrow key on the handle

function readHeight(): number {
  const stored = readView('consoleHeight');
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
}

function useHeight(): [number, (height: number) => void] {
  const [height, setHeight] = useState(readHeight);
  useEffect(() => writeView('consoleHeight', height), [height]);
  return [height, setHeight];
}

interface HandleProps { height: number; drawer: RefObject<HTMLElement | null>; onHeight(height: number): void }

// The top edge's handle: a strip across the drawer with a discreet mark in its middle. The pointer sets the height from the center column
// the drawer sits in; the arrows nudge it. Also a CSS max-height, so a window made smaller never leaves it past 70%.
function ResizeHandle({ height, drawer, onHeight }: HandleProps) {
  const bounds = (): { max: number; bottom: number } | undefined => {
    const rect = drawer.current?.parentElement?.getBoundingClientRect();
    return rect && { max: rect.height * MAX_SHARE, bottom: rect.bottom - BOTTOM_GAP };
  };
  const set = (value: number): void => {
    const max = bounds()?.max ?? Number.POSITIVE_INFINITY;
    onHeight(Math.round(Math.max(MIN_HEIGHT, Math.min(max, value)))); // the floor wins in a center too short for both
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const box = bounds();
    if (box && event.currentTarget.hasPointerCapture(event.pointerId)) set(box.bottom - event.clientY);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowUp') set(height + STEP);
    if (event.key === 'ArrowDown') set(height - STEP);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the WAI-ARIA splitter pattern, as the dock's Divider (#251)
    <div
      role="separator" tabIndex={0} aria-label={t('console.resize')} aria-orientation="horizontal" aria-valuenow={height} aria-valuemin={MIN_HEIGHT}
      className="flex h-2 shrink-0 cursor-row-resize items-center justify-center"
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={onPointerMove} onKeyDown={onKeyDown}
      onDoubleClick={() => onHeight(DEFAULT_HEIGHT)}
    >
      <span aria-hidden="true" className="h-[3px] w-8 rounded-full bg-border" />
    </div>
  );
}

interface ConsoleDrawerProps { console: ConsoleChannels; fontFamily: string; onOpenTab?(): void }

/** The console's drawer over the center (redesign 05): the flow under fluxo, the activity's grid under atividades. Opened only by the chip,
 * Cmd+J (toggleConsole) or a setup's ver log; Escape, esc, the chip or Cmd+J close it. Its top handle resizes it (see useHeight). abrir como aba moves the console into a tab of the activity's grid and closes
 * the drawer; with no grid there (fluxo, or no activity picked) it shows disabled. */
export function ConsoleDrawer({ console: channels, fontFamily, onOpenTab }: ConsoleDrawerProps) {
  const { isOpen, close, show } = channels;
  const [height, setHeight] = useHeight();
  const section = useRef<HTMLElement>(null);
  useCloseKey(isOpen, close);
  useEffect(() => onShortcutKey<ConsoleTab>([['console', 'toggleConsole']], show), [show]);
  if (!isOpen) return null;
  const openTab = onOpenTab === undefined ? undefined : (): void => { onOpenTab(); close(); };
  return (
    <section
      ref={section} data-console-drawer aria-label={t('console.title')} style={{ height }}
      className="absolute inset-x-3 bottom-2 z-20 flex max-h-[70%] flex-col overflow-hidden rounded-lg border bg-popover shadow-lg"
    >
      <ResizeHandle height={height} drawer={section} onHeight={setHeight} />
      <ConsolePanel
        channels={channels.channels} selection={channels.selection} stamp={channels.stamp} fontFamily={fontFamily}
        onSelect={channels.select} onStale={channels.refresh} drawer={{ onClose: close, onOpenTab: openTab }}
      />
    </section>
  );
}
