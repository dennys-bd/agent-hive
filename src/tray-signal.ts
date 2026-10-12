// The menu bar's view of the signal (#196): the /events stream reduced to what the icon and the menu need, the icon file, and the menu
// items. Electron is imported for its menu item type only, so node:test covers all of it; main.ts wires it to the Tray.
import type { MenuItemConstructorOptions } from 'electron';
import type { DaemonAddress } from './daemon.js';
import type { Logger } from './log.js';
import { SIGNALS } from './orchestrator.js';
import { SECRET_HEADER } from './secret.js';
import { AGENT_IDS, type EventsPayload, type PlanReadings, type Signal } from './types.js';
import { t } from './ui/i18n.js';
import { SIGNAL_RANK } from './usage-rules.js';

/** What the menu bar needs from an /events payload */
export interface TraySignal {
  manual: Signal; // state.signal
  effective: Signal; // effective.signal
  floor: Signal; // effective.floor.signal
  rateLimits?: PlanReadings; // state.rateLimits, per agent (#929), absent until a reading arrives (#197)
}

export const RECONNECT_MS = 2000; // a daemon stop or Restart ends the stream: a short fixed retry brings the badge back soon after
// an unfinished frame longer than this drops the connection: whatever holds the port is not streaming /events frames. A State is far smaller
export const MAX_FRAME_CHARS = 8 * 1024 * 1024;

const FRAME_END = '\n\n';
const DATA_FIELD = /^data: ?/;
const EVENT_FIELD = /^event: ?/;
// the radios' names: the signal states are always written green / yellow / red, in every language (#242)
const SIGNAL_LABELS: Record<Signal, string> = { green: 'Green', yellow: 'Yellow', red: 'Red' };

const isSignal = (value: unknown): value is Signal => typeof value === 'string' && Object.hasOwn(SIGNAL_RANK, value);

/** The signals of one payload. None in setup mode, or when a value is not what it should be: the effective signal names an icon file. */
export function traySignal(payload: EventsPayload): TraySignal | undefined {
  if (!('effective' in payload)) return undefined; // setup mode: { configured: false }
  const view = {
    manual: payload.signal, effective: payload.effective.signal, floor: payload.effective.floor.signal,
    ...(payload.rateLimits ? { rateLimits: payload.rateLimits } : {}), // the plan lines (#197); no key before a reading
  };
  return isSignal(view.manual) && isSignal(view.effective) && isSignal(view.floor) ? view : undefined;
}

/** The data of each complete frame in `buffer` (a frame ends on a blank line); the unfinished tail stays in `rest` for the next chunk.
 *  A comment (the `: ping` heartbeat) carries no data and gives no frame. */
export function sseFrames(buffer: string): { frames: string[]; rest: string } {
  const blocks = buffer.split(FRAME_END);
  const rest = blocks.pop() ?? '';
  const frames = blocks.flatMap((block) => {
    const lines = block.split('\n');
    if (lines.some((line) => EVENT_FIELD.test(line))) return []; // a named event (the review's, #591) carries no State
    const data = lines.filter((line) => DATA_FIELD.test(line)).map((line) => line.replace(DATA_FIELD, ''));
    return data.length > 0 ? [data.join('\n')] : [];
  });
  return { frames, rest };
}

/** The icon for a signal: the template (macOS tints it) with none, otherwise the badged comb. `light` ink (white) for a dark bar and
 *  `dark` ink (black) for a light one. */
export function trayIconFile(signal: TraySignal | undefined, dark: boolean): string {
  if (!signal) return 'trayTemplate.png';
  return `tray-${dark ? 'light' : 'dark'}-${signal.effective}.png`;
}

/** The menu's signal section: a heading that names a rule-raised signal, the three radios (the manual one checked; those looser than the
 *  rule floor disabled, as Header.tsx's toggle does), and the separator before the worker lines. The heading and the tooltip are in the
 *  Hive's language (#242). */
export function signalItems(signal: TraySignal, onPick: (s: Signal) => void): MenuItemConstructorOptions[] {
  const heading = signal.effective === signal.manual ? t('main.signal') : t('main.signalHeld', { signal: SIGNAL_LABELS[signal.effective] });
  const floor = SIGNAL_RANK[signal.floor];
  const radios = SIGNALS.map((s): MenuItemConstructorOptions => {
    const held = SIGNAL_RANK[s] < floor;
    return {
      label: SIGNAL_LABELS[s], type: 'radio', checked: s === signal.manual, enabled: !held,
      ...(held ? { toolTip: t('main.heldTooltip') } : {}), click: () => onPick(s),
    };
  });
  return [{ label: heading, enabled: false }, ...radios, { type: 'separator' }];
}

// a new plan reading always carries a new `at` (#197): it is reported even when the signals hold; each agent's on its own (#929)
const sameReadings = (a: PlanReadings | undefined, b: PlanReadings | undefined): boolean => AGENT_IDS.every((agent) => a?.[agent]?.at === b?.[agent]?.at);
const sameSignal = (a: TraySignal | undefined, b: TraySignal | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.manual === b.manual && a.effective === b.effective && a.floor === b.floor
    && sameReadings(a.rateLimits, b.rateLimits));

// What one connection reports to (#196, #199): the badge's reduced view, and every payload whole
interface SignalSink { report(signal: TraySignal | undefined): void; deliver(payload: EventsPayload | undefined): void }

// One connection to GET /events: each complete frame is delivered whole and reported reduced, until the stream ends. A frame that does not
// parse is logged and skipped; the stream goes on.
async function readSignals({ port, secret }: DaemonAddress, abort: AbortSignal, sink: SignalSink, log: Pick<Logger, 'error'>): Promise<void> {
  // the main process's fetch carries none of the main window's cookies: the secret goes as a header (#467)
  const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: { [SECRET_HEADER]: secret }, signal: abort, redirect: 'error' });
  if (!res.ok) {
    await res.body?.cancel(); // no socket left open across the retries when something else answers on the port
    return;
  }
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    const { frames, rest } = sseFrames(buffer + decoder.decode(value, { stream: true }));
    if (rest.length > MAX_FRAME_CHARS) throw new Error('signal stream: frame too long');
    buffer = rest;
    for (const frame of frames) {
      try {
        const payload = JSON.parse(frame) as EventsPayload;
        sink.deliver(payload); // #199: the notifications diff the whole State, whatever the badge makes of it
        sink.report(traySignal(payload));
      } catch (err) {
        log.error(`signal stream: frame skipped: ${(err as Error).message}`); // #742: hive.log, not only the terminal
      }
    }
  }
}

/** Follows the daemon's GET /events at the address `daemon()` names at each connect (#196): its port and its secret, read again at every
 *  connect so a daemon that moved (#466) or restarted with a new secret (#467) is followed; none skips the fetch until the next retry.
 *  onChange gets the reduced view when it differs from the last one, and undefined once the stream ends or fails; a new connection follows
 *  RECONNECT_MS later. onPayload (#199) gets every parsed payload before it is reduced, and undefined with onChange's. The returned stop aborts the stream and cancels a pending retry: nothing is reported after it. */
export function watchSignal(daemon: () => DaemonAddress | undefined | Promise<DaemonAddress | undefined>, onChange: (signal: TraySignal | undefined) => void, log: Pick<Logger, 'error'>, onPayload?: (payload: EventsPayload | undefined) => void): () => void {
  let stopped = false;
  let last: TraySignal | undefined;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const report = (next: TraySignal | undefined): void => {
    if (stopped || sameSignal(last, next)) return;
    last = next;
    try {
      onChange(next);
    } catch (err) {
      // a throw here would end connect() before its retry, and the badge would stop following the daemon for good
      log.error(`signal stream: onChange failed: ${(err as Error).message}`);
    }
  };
  // #199: every payload, and undefined where report gets it. A throw is logged as onChange's is: a failing notification never stops the badge
  const deliver = (payload: EventsPayload | undefined): void => {
    if (stopped || !onPayload) return;
    try {
      onPayload(payload);
    } catch (err) {
      log.error(`signal stream: onPayload failed: ${(err as Error).message}`);
    }
  };
  const connect = async (): Promise<void> => {
    controller = new AbortController();
    try {
      const at = await daemon(); // the viewer's asks who answers first (#466): a stale hive.port held by something else is no daemon
      if (at !== undefined) await readSignals(at, controller.signal, { report, deliver }, log); // none recorded: no daemon to follow, only the retry (#466)
    } catch {
      // refused while the daemon is down, reset by its stop, aborted by stop(), a bad port: all read as "no signal", and the retry covers
      // them. Not logged: while the daemon is stopped this runs every 2 s, and the menu's status line already says why.
    }
    report(undefined);
    deliver(undefined);
    if (!stopped) retry = setTimeout(() => void connect(), RECONNECT_MS);
  };
  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    clearTimeout(retry);
  };
}
