// A run's pty in the daemon as an xterm sees it (#251), shared by the main window's panel tabs (PtyTab.tsx) and a detached run's window
// (terminal.ts, #252), over one WebSocket (#407): output in, keys and sizes out. A WebSocket sits outside Chromium's 6-per-host HTTP pool,
// which a stream and two POSTs per terminal used to exhaust, leaving every other fetch of the page waiting.
import type { Terminal } from '@xterm/xterm';

type PtyMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }; // parsePtyMessage in src/terminal-wire.ts

// A drag's ResizeObserver ticks dozens of times; the shell redraws its prompt on every SIGWINCH, so it should see one per drag, not one per
// tick. #451
export const RESIZE_SETTLE_MS = 150;

// xterm's focus-in / focus-out reports (DECSET 1004), each emitted alone. claude drops a click that comes while it believes it is blurred or
// shortly after a focus-in, and in the Hive any click outside a terminal blurs it: the next click on one of claude's options was lost (#599).
// Never forwarded, claude always sees a focused terminal. Every pty goes through here, plain terminals too: a vim in one loses FocusGained,
// a smaller cost than a lost click. A key or a bracketed paste never equals one of them.
const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O']);

// The socket's first frame is the replay (#831), the ring or an empty one. xterm answers the queries in it (device attributes, cursor
// position) as if they were typed, and a dead prompt's queries would type their replies into the running program. So from the first
// frame's write until xterm has parsed it, what onData emits is dropped. Writes parse in order, so a live frame that lands meanwhile is
// parsed after the callback and its queries are answered. A key typed in that window is lost: the API cannot tell it from a reply.
function replayGate(term: Terminal): { write(data: string): void; isReplaying(): boolean } {
  let replay: 'waiting' | 'parsing' | 'done' = 'waiting';
  return {
    write: (data) => {
      if (replay !== 'waiting') {
        term.write(data);
        return;
      }
      replay = 'parsing'; // before the write: xterm may parse it, and call back, inside write itself
      term.write(data, () => { replay = 'done'; });
    },
    isReplaying: () => replay === 'parsing',
  };
}

/** What connectPty hands its view (#808). postSize sends the xterm's grid now, past the debounce, dropping a resize still pending: a view
 * calls it on its first shown fit and whenever it becomes the one in front of the user. The host drops a grid the pty already has. */
export interface PtyConnection { disconnect(): void; postSize(): void }

/** Streams the run's scrollback, then its live output, into `term`. What xterm answers to the scrollback never reaches the pty (#831).
 * Its keys go over the socket as soon as they're typed; a resize is debounced (#451) so only the last grid of a drag, once it has been quiet for RESIZE_SETTLE_MS, goes out; the last resize of any viewer
 * wins. A key never waits behind a pending resize. What is sent before the socket opens waits for it. Any close the page did not ask for (the pty exited, the daemon refused
 * or dropped the socket) calls onExit: an internal pty dies with the daemon, so there is nothing to reconnect to. Returns the connection (#808):
 * its teardown, which drops any resize still pending, and postSize. */
export function connectPty(term: Terminal, ptyId: string, onExit: () => void): PtyConnection {
  const socket = new WebSocket(`ws://${location.host}/ptys/${encodeURIComponent(ptyId)}/pty`);
  let queued: string[] | undefined = []; // undefined once open
  let stopped = false; // the teardown's own close is not the run's end
  const frames = replayGate(term);
  const send = (message: PtyMessage): void => {
    const text = JSON.stringify(message);
    if (queued) queued = [...queued, text];
    else socket.send(text);
  };
  socket.addEventListener('open', () => {
    const held = queued ?? [];
    queued = undefined;
    for (const text of held) socket.send(text);
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') frames.write(event.data);
  });
  socket.addEventListener('close', () => {
    if (!stopped) onExit();
  });
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const typed = term.onData((data) => {
    if (!frames.isReplaying() && !FOCUS_REPORTS.has(data)) send({ type: 'input', data });
  });
  const dropPending = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = undefined;
  };
  const sized = term.onResize(({ cols, rows }) => {
    dropPending();
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      send({ type: 'resize', cols, rows });
    }, RESIZE_SETTLE_MS);
  });
  const postSize = (): void => {
    dropPending();
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  };
  const disconnect = (): void => {
    stopped = true;
    dropPending();
    socket.close();
    typed.dispose();
    sized.dispose();
  };
  return { disconnect, postSize };
}
