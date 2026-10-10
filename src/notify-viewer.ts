// The macOS notifications (#199): the /events payloads through notificationFeed, each result shown as a native Notification while no main
// window has the focus; a click goes to main's showWorker. Electron glue, checked by hand: the decisions live in notify.ts.
import { Notification } from 'electron';
import type { Logger } from './log.js';
import { notificationFeed } from './notify.js';
import type { EventsPayload, NotificationSettings } from './types.js';

export interface NotifierDeps {
  enabled(): NotificationSettings; // the viewer's settings as loadSettings last read them: a save applies to the next event
  isMainFocused(): boolean; // a detached terminal window does not count: the user is not looking at the cards
  onClick(taskId: string | undefined): void; // main's showWorker: that task's panel, or only the window for a local session
  log: Pick<Logger, 'error'>;
}

// A shown notification is held until it is clicked or closed, or the GC can take its click handler. macOS may file one into Notification
// Center without a close, so the oldest goes past HELD_MAX: only its click is lost, long after the user could have cared.
const HELD_MAX = 100;
const shown = new Set<Notification>();

function show(title: string, body: string, onClick: () => void): void {
  const note = new Notification({ title, body }); // silent false by default: the macOS sound
  shown.add(note);
  const oldest = shown.size > HELD_MAX ? shown.values().next().value : undefined;
  if (oldest) shown.delete(oldest);
  note.on('click', () => {
    shown.delete(note);
    onClick();
  });
  note.on('close', () => shown.delete(note));
  note.show();
}

/** What watchSignal's onPayload calls (#199). Every payload is fed, focused or not, so the next diff is against what the user just saw. Where
 *  Notification is not supported, one log line says so and nothing is shown. */
export function createNotifier({ enabled, isMainFocused, onClick, log }: NotifierDeps): (payload: EventsPayload | undefined) => void {
  if (!Notification.isSupported()) {
    log.error('notifications: not supported on this system, none will show');
    return () => undefined;
  }
  const feed = notificationFeed(enabled);
  return (payload) => {
    const found = feed(payload);
    if (found.length === 0 || isMainFocused()) return;
    for (const { title, body, taskId } of found) show(title, body, () => onClick(taskId));
  };
}
