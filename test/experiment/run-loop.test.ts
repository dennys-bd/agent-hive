import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type LoopDeps, runLoop } from '../../scripts/experiment/run-loop.js';
import type { RunRef } from '../../scripts/experiment/types.js';
import { clock } from './fixtures.js';

const NIGHT = new Date('2026-10-01T22:00:00.000Z');
const HOUR = 3_600_000;

// The fake clock adds every sleep, so only arm A's runs take time: a pair lasts runMs, as its two runs overlap
function depsOf(o: { measured?: string[]; judged?: string[]; time: ReturnType<typeof clock>; runMs?: number; failEvaluate?: string }): { events: string[]; deps: LoopDeps } {
  const events: string[] = [];
  return {
    events,
    deps: {
      now: o.time.now,
      log: (line) => { events.push(`log ${line}`); },
      hasMetrics: async (ref: RunRef) => (o.measured ?? []).includes(ref.id),
      hasJudge: async (ref: RunRef) => (o.judged ?? []).includes(ref.id),
      execute: async (ref: RunRef, alone: boolean) => {
        events.push(`execute ${ref.id}${alone ? ' alone' : ''}`);
        if (ref.arm === 'a') await o.time.sleep(o.runMs ?? 0);
      },
      evaluate: async (ref: RunRef) => { events.push(`evaluate ${ref.id}`); if (ref.id === o.failEvaluate) throw new Error('judge down'); },
      report: async () => { events.push('report'); },
    },
  };
}
const steps = (events: string[]): string[] => events.filter((e) => !e.startsWith('log'));

test('runLoop starts both runs of each missing pair together, then evaluates them one at a time (#105)', async () => {
  const { events, deps } = depsOf({ measured: ['a1', 'b1'], judged: ['a1', 'b1'], time: clock(NIGHT) });
  assert.deepEqual(await runLoop(2, undefined, deps), ['a2', 'b2']);
  assert.deepEqual(steps(events), ['execute a2', 'execute b2', 'evaluate a2', 'report', 'evaluate b2', 'report']);
});

test('runLoop starts no pair at or after --until and never cuts the pair going (#105)', async () => {
  const time = clock(NIGHT);
  const { events, deps } = depsOf({ time, runMs: 3 * HOUR });
  assert.deepEqual(await runLoop(3, new Date(NIGHT.getTime() + 4 * HOUR), deps), ['a1', 'b1', 'a2', 'b2']);
  assert.equal(time.now().getTime() - NIGHT.getTime(), 6 * HOUR, 'pair 2 started at 3 h, before the deadline, and ran to its end');
  assert.ok(!steps(events).some((e) => e.includes('3')), 'pair 3 never started');
  assert.ok(events.some((e) => e.includes('--until')));
});

test('runLoop reruns only the missing run of a half-finished pair, alone, after evaluating the finished one (#105)', async () => {
  const { events, deps } = depsOf({ measured: ['a1'], time: clock(NIGHT) });
  assert.deepEqual(await runLoop(1, undefined, deps), ['b1']);
  assert.deepEqual(steps(events), ['evaluate a1', 'report', 'execute b1 alone', 'evaluate b1', 'report']);
});

test('runLoop evaluates a measured run with no judge even past the deadline, but starts nothing there (#105)', async () => {
  const { events, deps } = depsOf({ measured: ['a1'], time: clock(NIGHT) });
  assert.deepEqual(await runLoop(1, NIGHT, deps), []);
  assert.deepEqual(steps(events), ['evaluate a1', 'report']);
});

test('runLoop logs a failed evaluation and goes on with the night (#105)', async () => {
  const { events, deps } = depsOf({ time: clock(NIGHT), failEvaluate: 'a1' });
  assert.deepEqual(await runLoop(1, undefined, deps), ['a1', 'b1']);
  assert.ok(events.includes('log evaluation of a1 failed: judge down'));
  assert.deepEqual(steps(events), ['execute a1', 'execute b1', 'evaluate a1', 'report', 'evaluate b1', 'report']);
});
