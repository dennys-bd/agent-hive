import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexRateLimits, readCodexPlanLimits } from '../../src/agents/codex-limits.js';
import { CHILD, DAY, NOW, OTHER, SESSION, sessionMeta, tokenCount, TWO_TURNS, writeRollout } from '../codex-rollouts.js';
import { tempDir } from '../temp-dir.js';

const NOW_S = Math.floor(NOW / 1000);
const AHEAD = NOW_S + 86_400;
const planWindow = (minutes: number, percent: number, resetsAt = AHEAD): Record<string, unknown> => ({ used_percent: percent, window_minutes: minutes, resets_at: resetsAt });
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const free = (percent: number): unknown => ({ limit_id: 'codex', primary: planWindow(43_200, percent), secondary: null, plan_type: 'free' });
const deps = (home: string) => ({ env: { CODEX_HOME: home }, now: () => new Date(NOW) });

test('parseCodexRateLimits keys a window by its duration: the free plan\'s 43200 minutes is thirty_day, 300 and 10080 five_hour and seven_day (#929)', () => {
  const now = new Date(NOW);
  assert.deepEqual(parseCodexRateLimits(free(40), now), { at: now.toISOString(), windows: { thirty_day: { usedPercent: 40, resetsAt: iso(AHEAD) } } });
  assert.deepEqual(parseCodexRateLimits({ primary: planWindow(300, 12.5), secondary: planWindow(10_080, 130) }, now)?.windows, {
    five_hour: { usedPercent: 12.5, resetsAt: iso(AHEAD) }, seven_day: { usedPercent: 100, resetsAt: iso(AHEAD) },
  }, 'a percent past 100 is clamped');
});

test('parseCodexRateLimits drops an unknown duration, a negative percent, a non-integer or past reset; nothing left is no reading (#929)', () => {
  const now = new Date(NOW);
  for (const primary of [planWindow(60, 10), planWindow(300, -1), planWindow(300, 10, NOW_S + 0.5), planWindow(300, 10, NOW_S - 1), { window_minutes: 300, resets_at: AHEAD }, null, 'x']) {
    assert.equal(parseCodexRateLimits({ primary, secondary: null }, now), undefined, JSON.stringify(primary));
  }
  assert.equal(parseCodexRateLimits(null, now), undefined);
  assert.deepEqual(Object.keys(parseCodexRateLimits({ primary: planWindow(60, 10), secondary: planWindow(10_080, 5) }, now)?.windows ?? {}), ['seven_day']);
});

test('readCodexPlanLimits: no sessions folder is no reading (#929)', async (t) => {
  assert.equal(await readCodexPlanLimits(deps(await tempDir(t, 'codex-'))), undefined);
});

test('readCodexPlanLimits reads the newest date folder\'s newest rollout at its last rate_limits; a newest rollout without any hands over to the next (#929)', async (t) => {
  const home = await tempDir(t, 'codex-');
  await writeRollout(home, '2026/10/11', OTHER, [tokenCount('2026-10-11T09:00:00.000Z', free(90))]);
  await writeRollout(home, DAY, CHILD, [tokenCount('2026-10-12T09:00:00.000Z', free(10)), tokenCount('2026-10-12T09:05:00.000Z', free(12))], NOW - 60_000);
  assert.equal((await readCodexPlanLimits(deps(home)))?.windows.thirty_day?.usedPercent, 12, 'the newer folder, its last line');
  await writeRollout(home, DAY, SESSION, [sessionMeta(SESSION), ...TWO_TURNS.slice(1)], NOW); // the newest, with no token_count yet
  assert.equal((await readCodexPlanLimits(deps(home)))?.windows.thirty_day?.usedPercent, 12, 'the next rollout\'s');
});
