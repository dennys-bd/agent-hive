import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DaemonAddress } from '../src/daemon.js';
import { initialState } from '../src/orchestrator.js';
import { newSecret } from '../src/secret.js';
import { MAX_FRAME_CHARS, RECONNECT_MS, signalItems, sseFrames, traySignal, trayIconFile, type TraySignal, watchSignal } from '../src/tray-signal.js';
import type { EventsPayload, RateLimits, Signal } from '../src/types.js';
import { setLanguage } from '../src/ui/i18n.js';
import { SECRET } from './secret-client.js';

// An /events payload as server.ts streams it: the State plus effectiveLimits' answer, reduced here to what the menu bar reads
const payload = (manual: Signal, effective: Signal, floor: Signal): EventsPayload => ({
  ...initialState(2),
  signal: manual,
  effective: { signal: effective, floor: { signal: floor }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} },
});
const GREEN: TraySignal = { manual: 'green', effective: 'green', floor: 'green' };
const HELD: TraySignal = { manual: 'green', effective: 'red', floor: 'red' }; // a rule raised the user's green to red
// A plan reading as a worker's status line reports it (#197): `at` is when it arrived
const reading = (at: string): RateLimits => ({ at, windows: { five_hour: { usedPercent: 82, resetsAt: '2026-09-24T14:40:00.000Z' } } });

const WAIT_MS = 5000; // well past RECONNECT_MS: a wait that runs out is a failure, not a slow machine
const POLL_MS = 10;
const QUIET = { error: (): void => undefined };
const frame = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;

// Waits for `check` to hold; past WAIT_MS the test fails
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for onChange');
    await sleep(POLL_MS);
  }
}

// An /events endpoint (text/event-stream, as server.ts answers it) whose connections the test writes by hand, in the order they arrive.
// Closed after the test.
async function sseServer(t: TestContext): Promise<{ port: number; next(): Promise<ServerResponse>; connections(): number; secrets(): string[] }> {
  const arrived: ServerResponse[] = [];
  const waiting: ((res: ServerResponse) => void)[] = [];
  const secrets: string[] = [];
  let count = 0;
  const server = createServer((req, res) => {
    if (req.url !== '/events') {
      res.writeHead(404).end();
      return;
    }
    count += 1;
    secrets.push(String(req.headers['x-hive-secret']));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders(); // fetch resolves on the headers
    const waiter = waiting.shift();
    if (waiter) waiter(res);
    else arrived.push(res);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    port: (server.address() as AddressInfo).port,
    next: () => new Promise((resolvePromise) => {
      const res = arrived.shift();
      if (res) resolvePromise(res);
      else waiting.push(resolvePromise);
    }),
    connections: () => count,
    secrets: () => secrets,
  };
}

test('sseFrames: the data of each complete frame; a partial frame waits in rest; the heartbeat comment gives nothing (#196)', () => {
  assert.deepEqual(sseFrames('data: {"a":1}\n\n'), { frames: ['{"a":1}'], rest: '' });
  assert.deepEqual(sseFrames('data: 1\n\ndata: 2\n\n'), { frames: ['1', '2'], rest: '' }, 'two frames in one chunk');
  const head = sseFrames('data: {"a"');
  assert.deepEqual(head, { frames: [], rest: 'data: {"a"' }, 'a frame split across chunks waits for its end');
  assert.deepEqual(sseFrames(`${head.rest}:1}\n\ndata: 3`), { frames: ['{"a":1}'], rest: 'data: 3' });
  assert.deepEqual(sseFrames(': ping\n\n'), { frames: [], rest: '' }, 'the heartbeat');
});

test('traySignal: the manual signal, the effective one and the rule floor of a payload; none in setup mode or for a value that is not a signal (#196)', () => {
  assert.deepEqual(traySignal(payload('green', 'red', 'red')), HELD);
  assert.deepEqual(traySignal(payload('green', 'green', 'green')), GREEN);
  assert.equal(traySignal({ configured: false }), undefined, 'setup mode: no signal, no badge');
  assert.equal(traySignal({ ...payload('green', 'green', 'green'), signal: '../x' as Signal }), undefined, 'a value that would name another file');
});

test('traySignal: the view carries the plan reading when the payload has one (#197)', () => {
  const read = reading('2026-09-24T12:00:00.000Z');
  assert.deepEqual(traySignal({ ...payload('green', 'red', 'red'), rateLimits: { claude: read } }), { ...HELD, rateLimits: { claude: read } });
});

test('trayIconFile: the template with no signal; otherwise the effective signal\'s badge, the white comb on a dark bar and the black one on a light bar (#196)', () => {
  assert.equal(trayIconFile(undefined, false), 'trayTemplate.png');
  assert.equal(trayIconFile(undefined, true), 'trayTemplate.png');
  for (const effective of ['green', 'yellow', 'red'] as const) {
    const view: TraySignal = { manual: 'green', effective, floor: effective }; // the effective signal, never the manual one
    assert.equal(trayIconFile(view, true), `tray-light-${effective}.png`);
    assert.equal(trayIconFile(view, false), `tray-dark-${effective}.png`);
  }
});

test('signalItems: a heading, the three radios with the manual one checked, those below the rule floor disabled with a tooltip, a click that picks, then a separator (#196)', () => {
  const picked: Signal[] = [];
  const held = signalItems(HELD, (s) => picked.push(s));
  assert.deepEqual(held.map(({ click: _click, ...item }) => item), [
    { label: 'Signal: Red (usage rule)', enabled: false },
    { label: 'Green', type: 'radio', checked: true, enabled: false, toolTip: 'Held by a usage rule' },
    { label: 'Yellow', type: 'radio', checked: false, enabled: false, toolTip: 'Held by a usage rule' },
    { label: 'Red', type: 'radio', checked: false, enabled: true },
    { type: 'separator' },
  ]);
  (held[3].click as () => void)();
  assert.deepEqual(picked, ['red']);

  const free = signalItems({ manual: 'yellow', effective: 'yellow', floor: 'green' }, () => {});
  assert.equal(free[0].label, 'Signal', 'no rule raises it: a plain heading');
  assert.deepEqual(free.slice(1, 4).map((item) => [item.label, item.checked, item.enabled]),
    [['Green', false, true], ['Yellow', true, true], ['Red', false, true]]);
});

test('signalItems in pt: the heading, the held heading and the held tooltip follow the language; the radios stay Green / Yellow / Red (#242)', (t) => {
  t.after(() => setLanguage('en'));
  setLanguage('pt');
  const held = signalItems(HELD, () => {});
  assert.deepEqual(held.slice(0, 4).map((item) => [item.label, item.toolTip]), [
    ['Sinal: Red (regra de uso)', undefined],
    ['Green', 'Travado por uma regra de uso'],
    ['Yellow', 'Travado por uma regra de uso'],
    ['Red', undefined],
  ], 'the signal states are always written green / yellow / red');
  assert.equal(signalItems(GREEN, () => {})[0].label, 'Sinal', 'no rule raises it: a plain heading');
});

test('watchSignal: onChange on each change of the reduced view; never on a repeat, a heartbeat, another state change or a frame that does not parse (#196)', async (t) => {
  const sse = await sseServer(t);
  const seen: (TraySignal | undefined)[] = [];
  const stop = watchSignal(() => ({ port: sse.port, secret: SECRET }), (signal) => seen.push(signal), QUIET);
  const res = await sse.next();
  res.write(frame(payload('green', 'green', 'green')));
  res.write(': ping\n\n');
  res.write(frame({ ...payload('green', 'green', 'green'), maxConcurrent: 5 })); // the State moved, the signal did not
  res.write('data: {oops\n\n'); // logged and skipped: the stream goes on
  res.write(frame(payload('green', 'red', 'red')));
  await until(() => seen.length >= 2);
  stop();
  assert.deepEqual(seen, [GREEN, HELD]);
});

test('watchSignal: a stream that ends gives undefined, and the reconnect RECONNECT_MS later delivers the signal again (#196)', async (t) => {
  const sse = await sseServer(t);
  const seen: (TraySignal | undefined)[] = [];
  const stop = watchSignal(() => ({ port: sse.port, secret: SECRET }), (signal) => seen.push(signal), QUIET);
  const first = await sse.next();
  first.write(frame(payload('green', 'red', 'red')));
  await until(() => seen.length === 1);
  const endedAt = Date.now();
  first.end(); // the daemon stopped, or Restart
  await until(() => seen.length === 2);
  assert.equal(seen[1], undefined, 'no stream, no signal: the icon goes back to the template');
  const second = await sse.next();
  assert.ok(Date.now() - endedAt >= RECONNECT_MS - POLL_MS, 'a fixed retry, not a busy loop');
  second.write(frame(payload('green', 'red', 'red')));
  await until(() => seen.length === 3);
  stop();
  assert.deepEqual(seen, [HELD, undefined, HELD]);
});

test('watchSignal: stop aborts the stream, reports nothing more and does not reconnect (#196)', async (t) => {
  const sse = await sseServer(t);
  const seen: (TraySignal | undefined)[] = [];
  const stop = watchSignal(() => ({ port: sse.port, secret: SECRET }), (signal) => seen.push(signal), QUIET);
  const res = await sse.next();
  res.write(frame(payload('green', 'green', 'green')));
  await until(() => seen.length === 1);
  const closed = new Promise<void>((resolvePromise) => res.on('close', () => resolvePromise()));
  stop();
  await closed; // the daemon sees the client go
  await sleep(RECONNECT_MS + 500);
  assert.deepEqual(seen, [GREEN], 'no undefined after a stop');
  assert.equal(sse.connections(), 1, 'no retry after a stop');
});

test('watchSignal: an unfinished frame past MAX_FRAME_CHARS drops the connection, which reconnects (#196)', async (t) => {
  const sse = await sseServer(t);
  const seen: (TraySignal | undefined)[] = [];
  const stop = watchSignal(() => ({ port: sse.port, secret: SECRET }), (signal) => seen.push(signal), QUIET);
  const first = await sse.next();
  first.write(frame(payload('green', 'green', 'green')));
  await until(() => seen.length === 1);
  first.write(`data: ${'x'.repeat(MAX_FRAME_CHARS + 1)}`); // something that never ends a frame
  await until(() => seen.length === 2);
  assert.equal(seen[1], undefined);
  const second = await sse.next();
  second.write(frame(payload('green', 'green', 'green')));
  await until(() => seen.length === 3);
  stop();
  assert.deepEqual(seen, [GREEN, undefined, GREEN]);
});

test('watchSignal: an onChange that throws is logged, and the stream still reconnects (#196)', async (t) => {
  const sse = await sseServer(t);
  const seen: (TraySignal | undefined)[] = [];
  const logged: string[] = [];
  const stop = watchSignal(() => ({ port: sse.port, secret: SECRET }), (signal) => {
    seen.push(signal);
    if (signal === undefined) throw new Error('tray gone');
  }, { error: (message) => { logged.push(message); } });
  const first = await sse.next();
  first.write(frame(payload('green', 'green', 'green')));
  await until(() => seen.length === 1);
  first.end();
  const second = await sse.next(); // the retry survived the throw
  second.write(frame(payload('green', 'green', 'green')));
  await until(() => seen.length === 3);
  stop();
  assert.deepEqual(seen, [GREEN, undefined, GREEN]);
  assert.deepEqual(logged, ['signal stream: onChange failed: tray gone']);
});

test('watchSignal: a daemon() that answers undefined (no hive.port or hive.secret, #466, #467) fetches nothing, reports no signal and asks again RECONNECT_MS later', async (t) => {
  const sse = await sseServer(t);
  const seen: (TraySignal | undefined)[] = [];
  let recorded: DaemonAddress | undefined;
  let asked = 0;
  const stop = watchSignal(() => { asked += 1; return recorded; }, (signal) => seen.push(signal), QUIET);
  t.after(stop); // a timeout in until() must not leave the reconnect loop running
  await until(() => asked >= 2); // the retry came
  assert.equal(sse.connections(), 0, 'no port, no fetch');
  assert.deepEqual(seen, [], 'no signal after no signal is no change');
  recorded = { port: sse.port, secret: SECRET }; // the daemon came up and recorded its port
  const res = await sse.next();
  res.write(frame(payload('green', 'green', 'green')));
  await until(() => seen.length === 1);
  assert.deepEqual(seen, [GREEN]);
});

test('watchSignal: a new plan reading of any agent is reported while the signal holds; the same readings again are not (#197, #929)', async (t) => {
  const sse = await sseServer(t);
  const seen: (TraySignal | undefined)[] = [];
  const stop = watchSignal(() => ({ port: sse.port, secret: SECRET }), (signal) => seen.push(signal), QUIET);
  t.after(stop); // a timeout in until() must not leave the reconnect loop running
  const res = await sse.next();
  const first = { claude: reading('2026-09-24T12:00:00.000Z') };
  const second = { ...first, codex: reading('2026-09-24T12:05:00.000Z') };
  res.write(frame({ ...payload('green', 'green', 'green'), rateLimits: first }));
  res.write(frame({ ...payload('green', 'green', 'green'), rateLimits: first })); // a repeat: no report
  res.write(frame({ ...payload('green', 'green', 'green'), rateLimits: second }));
  await until(() => seen.length >= 2);
  assert.deepEqual(seen, [{ ...GREEN, rateLimits: first }, { ...GREEN, rateLimits: second }]);
});

test('watchSignal sends the secret daemon() names at each connect, read again at a reconnect: a Restart\'s new secret is followed (#467)', async (t) => {
  const sse = await sseServer(t);
  const first = newSecret();
  const second = newSecret();
  let secret = first;
  const stop = watchSignal(() => ({ port: sse.port, secret }), () => {}, QUIET);
  t.after(stop);
  const res = await sse.next();
  secret = second; // the daemon restarted on the same port with a new hive.secret
  res.end();
  await sse.next();
  assert.deepEqual(sse.secrets(), [first, second]);
});

test('sseFrames skips a named event: the review event is no State (#591)', () => {
  const text = `event: review\ndata: {"type":"review","taskId":"local:1"}\n\n${frame({ a: 1 })}`;
  assert.deepEqual(sseFrames(text), { frames: ['{"a":1}'], rest: '' });
});

test('watchSignal hands onPayload every parsed frame, the ones the badge ignores too, and undefined when the stream ends (#199)', async (t) => {
  const sse = await sseServer(t);
  const payloads: (EventsPayload | undefined)[] = [];
  const stop = watchSignal(() => ({ port: sse.port, secret: SECRET }), () => {}, QUIET, (p) => payloads.push(p));
  t.after(stop);
  const res = await sse.next();
  const first = payload('green', 'green', 'green');
  const moved = { ...first, maxConcurrent: 5 }; // the State moved, the signal did not
  res.write(frame(first));
  res.write(': ping\n\n');
  res.write('data: {oops\n\n'); // skipped: no payload
  res.write(frame(moved));
  await until(() => payloads.length >= 2);
  res.end();
  await until(() => payloads.length >= 3);
  assert.deepEqual(payloads, [first, moved, undefined]);
});

test('watchSignal: an onPayload that throws is logged and the badge still updates (#199)', async (t) => {
  const sse = await sseServer(t);
  const seen: (TraySignal | undefined)[] = [];
  const logged: string[] = [];
  const stop = watchSignal(() => ({ port: sse.port, secret: SECRET }), (signal) => seen.push(signal), { error: (message) => { logged.push(message); } }, () => {
    throw new Error('no notifier');
  });
  t.after(stop);
  const res = await sse.next();
  res.write(frame(payload('green', 'red', 'red')));
  await until(() => seen.length >= 1);
  assert.deepEqual(seen, [HELD]);
  assert.deepEqual(logged, ['signal stream: onPayload failed: no notifier']);
});
