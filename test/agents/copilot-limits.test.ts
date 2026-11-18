import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopilotUser, readCopilotPlanLimits } from '../../src/agents/copilot-limits.js';
import type { Exec } from '../../src/types.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const RESET = '2026-12-01T00:00:00.000Z';
// The spike's Free answer (§7), as gh printed it
const FREE = {
  copilot_plan: 'individual', access_type_sku: 'free_limited_copilot', token_based_billing: true,
  quota_reset_date: '2026-12-01', quota_reset_date_utc: RESET,
  quota_snapshots: {
    chat: { entitlement: 200, remaining: 195, percent_remaining: 97.6, credits_used: 4, unlimited: false, overage_permitted: false, token_based_billing: true },
    completions: { entitlement: 2000, remaining: 2000, percent_remaining: 100.0, unlimited: false },
    premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0.0, has_quota: false, unlimited: false },
  },
};
// Not seen (spike §7): the Free shape with a premium entitlement
const PAID = {
  ...FREE,
  quota_snapshots: {
    ...FREE.quota_snapshots,
    chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
    premium_interactions: { entitlement: 300, remaining: 225, percent_remaining: 75, unlimited: false },
  },
};
const month = (usedPercent: number) => ({ at: NOW.toISOString(), windows: { thirty_day: { usedPercent, resetsAt: RESET } } });

test('parseCopilotUser reads Free\'s chat quota as the thirty_day window: used percent and reset date, completions never (#879)', () => {
  assert.deepEqual(parseCopilotUser(FREE, NOW), month(2.4));
});

test('parseCopilotUser reads a paid plan\'s premium_interactions over chat (#879)', () => {
  assert.deepEqual(parseCopilotUser(PAID, NOW), month(25));
});

test('parseCopilotUser has no reading for an empty object, a missing quota_snapshots, an unlimited quota or a bad reset (#879)', () => {
  const unlimited = { ...FREE, quota_snapshots: { ...FREE.quota_snapshots, chat: { ...FREE.quota_snapshots.chat, unlimited: true } } };
  const unsaid = { ...FREE, quota_snapshots: { chat: { entitlement: 200, percent_remaining: 97.6 } } };
  const cases = [{}, null, 'x', { ...FREE, quota_snapshots: undefined }, unlimited, unsaid, { ...FREE, quota_reset_date_utc: 'soon' }];
  for (const body of cases) assert.equal(parseCopilotUser(body, NOW), undefined, JSON.stringify(body));
});

const answering = (stdout: string, calls: Parameters<Exec>[] = []): Exec => async (...args) => { calls.push(args); return { stdout }; };

test('readCopilotPlanLimits runs gh api with an argv array as gh\'s own login, inherited tokens removed (#879, #180)', async () => {
  const calls: Parameters<Exec>[] = [];
  const reading = await readCopilotPlanLimits({ exec: answering(JSON.stringify(FREE), calls), env: { PATH: '/bin', GH_TOKEN: 'inherited' }, now: () => NOW });
  assert.deepEqual(reading, month(2.4));
  const [[file, args, opts]] = calls;
  assert.deepEqual([file, args], ['gh', ['api', '/copilot_internal/user']]);
  assert.equal(opts?.env?.PATH, '/bin');
  assert.equal('GH_TOKEN' in (opts?.env ?? {}), false);
  assert.equal(typeof opts?.timeout, 'number');
});

test('readCopilotPlanLimits throws a reason for a failing gh, a non-JSON answer and no usable quota, never gh\'s own words (#879, #557)', async () => {
  const failing: Exec = async () => { throw new Error('HTTP 401 secret-ish stderr'); };
  await assert.rejects(readCopilotPlanLimits({ exec: failing, env: {} }), (err: Error) => !err.message.includes('secret-ish'));
  await assert.rejects(readCopilotPlanLimits({ exec: answering('<html>'), env: {} }), /no JSON/);
  await assert.rejects(readCopilotPlanLimits({ exec: answering('{}'), env: {} }), /no Copilot quota/);
});
