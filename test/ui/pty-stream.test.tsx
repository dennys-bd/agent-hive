// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx.
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BATCH_MS } from '@/lib/key-probe';
import { connectPty, RESIZE_SETTLE_MS } from '@/lib/pty-stream';
import { FakeTerminal, FakeWebSocket, resetFakes } from './xterm-fakes';

const fetchMock = vi.fn();
beforeEach(() => {
  resetFakes();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// One xterm connected to worker `W 1` (a space, so the path shows its encoding): `socket` is its WebSocket
function connect() {
  const term = new FakeTerminal();
  const onExit = vi.fn();
  const { disconnect, postSize } = connectPty(term as unknown as Terminal, 'W 1', onExit);
  return { term, onExit, stop: disconnect, postSize, socket: FakeWebSocket.all[0] };
}

test('one WebSocket on the page\'s own host carries the pty: its output is written, and keys and sizes typed before it opens wait, then go in order as JSON, with no POST (#407)', () => {
  const { term, socket } = connect();
  expect(socket.url).toBe(`ws://${location.host}/ptys/W%201/pty`);
  term.type('l');
  term.resize(100, 40);
  vi.advanceTimersByTime(RESIZE_SETTLE_MS); // the resize settles before the socket ever opens
  expect(socket.sent).toEqual([]);
  socket.open();
  term.type('s\r');
  socket.receive('hi\r\n');
  expect(term.written).toEqual(['hi\r\n']);
  expect(socket.sent.map((text) => JSON.parse(text))).toEqual([
    { type: 'input', data: 'l' },
    { type: 'resize', cols: 100, rows: 40, redraw: true },
    { type: 'input', data: 's\r' },
  ]);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a close the page did not ask for (the pty exited, a refused or dropped socket) calls onExit once; the teardown closes the socket without calling it (#407)', () => {
  const exited = connect();
  exited.socket.open();
  exited.socket.end();
  expect(exited.onExit).toHaveBeenCalledTimes(1);
  resetFakes();
  const refused = connect();
  refused.socket.end(); // the daemon answered 404 / 409 / 403: it never opened
  expect(refused.onExit).toHaveBeenCalledTimes(1);
  resetFakes();
  const torn = connect();
  torn.socket.open();
  torn.stop();
  expect([torn.socket.closed, torn.onExit.mock.calls.length]).toEqual([true, 0]);
});

test('a single resize is not sent before it settles, and is sent once RESIZE_SETTLE_MS has passed (#451)', () => {
  const { term, socket } = connect();
  socket.open();
  term.resize(100, 40);
  expect(socket.sent).toEqual([]);
  vi.advanceTimersByTime(RESIZE_SETTLE_MS - 1);
  expect(socket.sent).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(socket.sent.map((text) => JSON.parse(text))).toEqual([{ type: 'resize', cols: 100, rows: 40, redraw: true }]);
});

test('a burst of resizes during a drag sends only the last grid, once, after it settles (#451)', () => {
  const { term, socket } = connect();
  socket.open();
  term.resize(90, 30);
  vi.advanceTimersByTime(50);
  term.resize(95, 32);
  vi.advanceTimersByTime(50);
  term.resize(100, 40); // the drag's last grid, the one the shell should redraw for
  vi.advanceTimersByTime(RESIZE_SETTLE_MS);
  expect(socket.sent.map((text) => JSON.parse(text))).toEqual([{ type: 'resize', cols: 100, rows: 40, redraw: true }]);
});

test('a key typed while a resize is pending goes out immediately, ahead of the settled resize (#451)', () => {
  const { term, socket } = connect();
  socket.open();
  term.resize(100, 40);
  term.type('l');
  expect(socket.sent.map((text) => JSON.parse(text))).toEqual([{ type: 'input', data: 'l' }]);
  vi.advanceTimersByTime(RESIZE_SETTLE_MS);
  expect(socket.sent.map((text) => JSON.parse(text))).toEqual([
    { type: 'input', data: 'l' },
    { type: 'resize', cols: 100, rows: 40, redraw: true },
  ]);
});

test('a resize still pending at teardown is dropped, never sent (#451)', () => {
  const { term, socket, stop } = connect();
  socket.open();
  term.resize(100, 40);
  stop();
  vi.advanceTimersByTime(RESIZE_SETTLE_MS);
  expect(socket.sent).toEqual([]);
});

test('the terminal\'s focus reports never reach the pty, so claude never takes a click as the one that refocuses it; an ordinary key does (#599)', () => {
  const { term, socket } = connect();
  socket.open();
  term.type('\x1b[O');
  term.type('\x1b[I');
  term.type('\x1b[Ix'); // not a lone report: forwarded as typed
  term.type('1');
  expect(socket.sent.map((text) => JSON.parse(text))).toEqual([
    { type: 'input', data: '\x1b[Ix' },
    { type: 'input', data: '1' },
  ]);
});

test('postSize sends the xterm\'s grid at once and drops a debounced resize still pending; before the socket opens it waits like any message (#808)', () => {
  const { term, socket, postSize } = connect();
  term.resize(90, 30); // a fit's new grid, debounced (#451)
  postSize();
  expect(socket.sent).toEqual([]); // not open yet: queued
  socket.open();
  vi.advanceTimersByTime(RESIZE_SETTLE_MS);
  expect(socket.sent.map((text) => JSON.parse(text))).toEqual([{ type: 'resize', cols: 90, rows: 30, redraw: true }]); // once: the pending one went
  term.cols = 100; // a grid no onResize announced, as xterm's first one
  term.rows = 40;
  postSize();
  expect(socket.sent.map((text) => JSON.parse(text))).toEqual([{ type: 'resize', cols: 90, rows: 30, redraw: true }, { type: 'resize', cols: 100, rows: 40, redraw: true }]);
});

const sentOf = (socket: FakeWebSocket): unknown[] => socket.sent.map((text) => JSON.parse(text));

test('postSize asks the program to redraw on the connection\'s first post and whenever the grid changed since its last; a repeat of the last grid asks for none (#389)', () => {
  const { term, socket, postSize } = connect();
  socket.open();
  postSize(); // the first post: a new tab, a woken session, a reopened window
  postSize(); // the tab shown again with nothing changed: a plain tab switch
  term.cols = 100; // the view's own grid changed, as a tab mounted hidden at 80x24 and then shown
  term.rows = 40;
  postSize();
  expect(sentOf(socket)).toEqual([
    { type: 'resize', cols: 120, rows: 30, redraw: true },
    { type: 'resize', cols: 120, rows: 30 },
    { type: 'resize', cols: 100, rows: 40, redraw: true },
  ]);
});

test('a settled resize asks for a redraw when its grid differs from the last one sent, and for none when a drag ends on it (#389, #451)', () => {
  const { term, socket, postSize } = connect();
  socket.open();
  postSize(); // 120x30
  term.resize(100, 40);
  vi.advanceTimersByTime(RESIZE_SETTLE_MS);
  term.resize(90, 30);
  term.resize(100, 40); // the drag comes back to the grid already sent
  vi.advanceTimersByTime(RESIZE_SETTLE_MS);
  expect(sentOf(socket)).toEqual([
    { type: 'resize', cols: 120, rows: 30, redraw: true },
    { type: 'resize', cols: 100, rows: 40, redraw: true },
    { type: 'resize', cols: 100, rows: 40 },
  ]);
});

test('what xterm answers while it parses the replay never reaches the pty; once parsed, keys and live answers do, and a later frame opens no new window (#831)', () => {
  const { term, socket } = connect();
  socket.open();
  socket.receive('\x1b[c\x1b[6n'); // the ring: a dead prompt's device-attributes and cursor-position queries
  term.type('\x1b[?1;2c'); // xterm answering them as it parses
  term.type('\x1b[43;3R');
  socket.receive('$ '); // live output that lands while the replay still parses
  term.type('x'); // a key typed in the window goes too (spec: assumed)
  term.parse();
  term.type('l');
  socket.receive('\x1b[6n'); // a query in live output: the live shell asked it
  term.type('\x1b[44;3R');
  expect(term.written).toEqual(['\x1b[c\x1b[6n', '$ ', '\x1b[6n']);
  expect(sentOf(socket)).toEqual([
    { type: 'input', data: 'l' },
    { type: 'input', data: '\x1b[44;3R' },
  ]);
});

test('an empty first frame, a ring with nothing in it, opens and closes the window the same; focus reports stay dropped after it (#831, #599)', () => {
  const { term, socket } = connect();
  socket.open();
  socket.receive('');
  term.type('\x1b[?1;2c');
  term.parse();
  term.type('\x1b[I');
  term.type('\x1b[O');
  term.type('1');
  expect(sentOf(socket)).toEqual([{ type: 'input', data: '1' }]);
});

test('the key probe\'s batch goes out as a keys message, and like input never while xterm parses the replay (#732, #831)', () => {
  const { term, socket } = connect();
  socket.open();
  const textarea = term.textarea as HTMLTextAreaElement;
  socket.receive('\x1b[c'); // the replay, still parsing
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'Quote' }));
  vi.advanceTimersByTime(BATCH_MS); // its batch ends inside the window: dropped
  term.parse();
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'Quote' }));
  textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'é' }));
  term.type('é');
  vi.advanceTimersByTime(BATCH_MS);
  expect(sentOf(socket)).toEqual([
    { type: 'input', data: 'é' },
    { type: 'keys', events: [
      { kind: 'keydown', key: 'Dead', code: 'Quote', isComposing: false, at: 0 },
      { kind: 'compositionend', data: 'é', at: 0 },
      { kind: 'data', data: 'é', at: 0 },
    ] },
  ]);
});

test('the teardown stops the probe: a batch pending at disconnect is never sent (#732)', () => {
  const { term, socket, stop } = connect();
  socket.open();
  socket.receive('');
  term.parse();
  (term.textarea as HTMLTextAreaElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'Quote' }));
  const sent = socket.sent.length;
  stop();
  vi.advanceTimersByTime(BATCH_MS);
  expect(socket.sent.length).toBe(sent);
});
