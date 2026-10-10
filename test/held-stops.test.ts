import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Response } from 'express';
import { createHeldStops } from '../src/held-stops.js';

// What the Stop's handler hands over: records what the Stop was answered with.
function fakeRes(): { res: Response; sent: unknown[]; close(): void } {
  const sent: unknown[] = [];
  const closers: (() => void)[] = [];
  const res: { headersSent: boolean; json(body: unknown): void; status(code: number): { end(): void }; once(event: string, fn: () => void): void } = {
    headersSent: false,
    json(body) { sent.push(body); res.headersSent = true; },
    status(code) { return { end: () => { sent.push(code); res.headersSent = true; } }; },
    once(event, fn) { if (event === 'close') closers.push(fn); },
  };
  return { res: res as unknown as Response, sent, close: () => { for (const fn of closers) fn(); } };
}
const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();

test('answer replies to a waiting Stop once, with a continue\'s JSON or 204; an answer that comes before its Stop settles goes out when it does (#268)', () => {
  const held = createHeldStops(() => assert.fail('no timer fires here'));
  const [a, b, c, d] = [fakeRes(), fakeRes(), fakeRes(), fakeRes()];
  held.settle('w1', a.res, soon(60_000));
  held.settle('w2', b.res, soon(60_000));
  held.answer('w1', { decision: 'block', reason: 'next' });
  held.answer('w2');
  assert.deepEqual([a.sent, b.sent], [[{ decision: 'block', reason: 'next' }], [204]]);
  held.answer('w3', { decision: 'block', reason: 'early' }); // the Stop's own continue, or the user's answer during its dispatch
  held.settle('w3', c.res, soon(60_000));
  assert.deepEqual(c.sent, [{ decision: 'block', reason: 'early' }], 'taken at once, never waits');
  held.settle('w4', d.res);
  assert.deepEqual(d.sent, [204], 'nothing to wait for: no decision');
});

test('the timer answers a waiting Stop with 204 just past until and reports the worker; extend moves it; releaseAll answers what is left (#268)', async () => {
  const expired: string[] = [];
  const held = createHeldStops((ptyId) => expired.push(ptyId), 0);
  const [a, b] = [fakeRes(), fakeRes()];
  held.settle('w1', a.res, soon(20));
  held.extend('w1', soon(120));
  held.settle('w2', b.res, soon(60_000));
  await sleep(60);
  assert.deepEqual([a.sent, expired], [[], []], 'extended: still waiting');
  await sleep(120);
  assert.deepEqual([a.sent, expired], [[204], ['w1']]);
  held.releaseAll();
  assert.deepEqual(b.sent, [204], 'close(): no Stop outlives the server');
});

test('a release that finds no waiting Stop is not kept: the expiry already answered it, and a later Stop of that worker still waits (#268)', () => {
  const held = createHeldStops(() => assert.fail('no timer fires here'));
  const a = fakeRes();
  held.answer('w1'); // the release approvalExpired emits after the timer answered the Stop itself
  held.settle('w1', a.res, soon(60_000));
  assert.deepEqual(a.sent, [], 'no stale 204 was waiting for it');
  held.releaseAll();
});

test('a second Stop of the same worker answers the first with 204, and the first one\'s timer never answers the second (#268)', async () => {
  const expired: string[] = [];
  const held = createHeldStops((ptyId) => expired.push(ptyId), 0);
  const [a, b] = [fakeRes(), fakeRes()];
  held.settle('w1', a.res, soon(20)); // the user pressed Esc: curl died, the entry stayed
  held.settle('w1', b.res, soon(60_000));
  assert.deepEqual(a.sent, [204], 'the replaced Stop is ended');
  await sleep(60);
  assert.deepEqual([b.sent, expired], [[], []], 'the old deadline does not touch the new Stop');
  held.answer('w1', { decision: 'block', reason: 'next' });
  assert.deepEqual(b.sent, [{ decision: 'block', reason: 'next' }]);
});

test('a held Stop whose connection closes is forgotten: no timer answers it, and a later answer is not kept for it (#268)', async () => {
  const expired: string[] = [];
  const held = createHeldStops((ptyId) => expired.push(ptyId), 0);
  const a = fakeRes();
  held.settle('w1', a.res, soon(20));
  a.close(); // the worker died with the Stop held
  await sleep(60);
  assert.deepEqual([a.sent, expired], [[], []]);
});
