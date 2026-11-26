import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountEnvDeps } from '../../src/account-env.js';
import { COPILOT_USER_URL } from '../../src/agents/copilot-account.js';
import { parseCopilotUser, readCopilotPlanLimits } from '../../src/agents/copilot-limits.js';
import type { AccountsConfig, Credentials, RateLimits } from '../../src/types.js';
import { OFF_GITLAB } from '../fixtures/accounts.js';

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

// #962: the reading takes the token the runs use, over the same GET as the spawn's check, with a fake fetch and a fake gh
const STORED_TOKEN = 'not-a-real-token-962-stored';
const MACHINE_TOKEN = 'not-a-real-token-962-machine';
const STORE = async (): Promise<Credentials> => ({ github: { work: { token: STORED_TOKEN } } });
const accountsOf = (accounts: AccountsConfig, login = 'octo'): AccountEnvDeps =>
  ({ accounts, credentials: STORE, machineGithub: { login: async () => login, token: async () => MACHINE_TOKEN }, gitlabOrigin: OFF_GITLAB });

interface FetchCall { url: string; init: RequestInit | undefined }
function answering(status: number, body: string): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetch: doFetch, calls };
}
const rejecting = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
const read = (accounts: AccountEnvDeps, doFetch: typeof fetch): Promise<RateLimits> => readCopilotPlanLimits({ accounts, fetch: doFetch, now: () => NOW });
const bearer = (call: FetchCall | undefined): string | null => new Headers(call?.init?.headers).get('authorization');

test('readCopilotPlanLimits reads /copilot_internal/user with the selected login\'s token, or gh\'s machine token with none; no login check (#962)', async () => {
  const selected = answering(200, JSON.stringify({ ...FREE, login: 'someone-else' }));
  assert.deepEqual(await read(accountsOf({ copilot: 'work', github: 'work' }), selected.fetch), month(2.4), 'a mismatch is the spawn\'s to refuse');
  const machine = answering(200, JSON.stringify(FREE));
  assert.deepEqual(await read(accountsOf({ github: 'work' }), machine.fetch), month(2.4), 'never accounts.github\'s token');
  assert.deepEqual([selected.calls[0]?.url, bearer(selected.calls[0]), bearer(machine.calls[0])], [COPILOT_USER_URL, `Bearer ${STORED_TOKEN}`, `Bearer ${MACHINE_TOKEN}`]);
});

test('readCopilotPlanLimits throws a fixed reason for each failure, never the token or the body (#962, #557)', async () => {
  const cases: [string, Promise<RateLimits>][] = [
    ['no Copilot token', read(accountsOf({ copilot: 'gone' }), answering(200, JSON.stringify(FREE)).fetch)],
    ['no Copilot token', read(accountsOf({}, ''), answering(200, JSON.stringify(FREE)).fetch)],
    ['no Copilot token', readCopilotPlanLimits({ fetch: answering(200, JSON.stringify(FREE)).fetch })],
    ['Copilot quota read failed: HTTP 401', read(accountsOf({ copilot: 'work' }), answering(401, `{"token":"${STORED_TOKEN}"}`).fetch)],
    ['Copilot quota read failed: HTTP 404', read(accountsOf({}), answering(404, '{}').fetch)],
    ['Copilot quota read failed: HTTP 500', read(accountsOf({}), answering(500, '{}').fetch)],
    ['Copilot quota unreachable', read(accountsOf({}), rejecting)],
    ['Copilot quota unreachable', read(accountsOf({}), answering(200, '<html>').fetch)],
    ['no Copilot quota with an entitlement', read(accountsOf({}), answering(200, '{}').fetch)],
  ];
  for (const [reason, reading] of cases) {
    await assert.rejects(reading, (err: Error) => err.message === reason && !err.message.includes(STORED_TOKEN) && !err.message.includes(MACHINE_TOKEN), reason);
  }
});
