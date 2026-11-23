import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountError, type AccountCode } from '../../src/account-error.js';
import { accountEnv, type AccountEnvDeps } from '../../src/account-env.js';
import { COPILOT_USER_URL, copilotAccountEnv, type CopilotFetch } from '../../src/agents/copilot-account.js';
import type { AccountCtx } from '../../src/agents/runner.js';
import type { Credentials } from '../../src/types.js';

// Copilot's account (#962): the token, the one GET and its check, with a fake fetch and a fake gh
const STORED_TOKEN = 'not-a-real-token-962-stored';
const MACHINE_TOKEN = 'not-a-real-token-962-machine';
const TOKENS = [STORED_TOKEN, MACHINE_TOKEN, 'not-a-real-token-962-other'];
const STORE: Credentials = { github: { work: { token: STORED_TOKEN }, other: { token: 'not-a-real-token-962-other' } } };
const ENTITLED = { chat: { entitlement: 200, unlimited: false }, premium_interactions: { entitlement: 0, unlimited: false } }; // Free (spike §7)
const user = (login: string, quotaSnapshots: unknown = ENTITLED): string => JSON.stringify({ login, quota_snapshots: quotaSnapshots });

interface FetchCall { url: string; init: RequestInit | undefined }
type FakeFetch = CopilotFetch & { fetch: typeof fetch; calls: FetchCall[] };

function answering(status: number, body: string): FakeFetch {
  const calls: FetchCall[] = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetch: doFetch, calls };
}

function rejecting(err: unknown): FakeFetch {
  const calls: FetchCall[] = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    throw err;
  }) as typeof fetch;
  return { fetch: doFetch, calls };
}

const machine = (login = 'octo', token: () => Promise<string> = async () => MACHINE_TOKEN): AccountCtx['machineGithub'] => ({ login: async () => login, token });
const ctx = (selected?: string, machineGithub = machine(), credentials = async (): Promise<Credentials> => STORE): AccountCtx =>
  ({ ...(selected === undefined ? {} : { selected }), credentials, machineGithub });
const bearer = (call: FetchCall | undefined): string | null => new Headers(call?.init?.headers).get('authorization');

// A refusal of Copilot's with this code, whose message holds no token
async function refuses(run: Promise<unknown>, code: AccountCode, label: string): Promise<void> {
  await assert.rejects(run, (err: unknown) => err instanceof AccountError && err.provider === 'copilot' && err.code === code && TOKENS.every((token) => !err.message.includes(token)), label);
}

test('accounts.copilot naming a stored login that the check answers with an entitlement: its token in COPILOT_GITHUB_TOKEN, the login as the run\'s account, whatever accounts.github is (#962)', async (t) => {
  const fake = answering(200, user('work'));
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const deps: AccountEnvDeps = { accounts: { copilot: 'work', github: 'other' }, credentials: async () => STORE, machineGithub: machine() };
  assert.deepEqual(await accountEnv({ agent: 'copilot' }, deps), { env: { COPILOT_GITHUB_TOKEN: STORED_TOKEN }, accounts: { copilot: 'work' } });
  const [call] = fake.calls;
  assert.deepEqual([fake.calls.length, call?.url, bearer(call), call?.init?.redirect, call?.init?.signal instanceof AbortSignal], [1, COPILOT_USER_URL, `Bearer ${STORED_TOKEN}`, 'manual', true]);
});

test('no accounts.copilot is gh\'s machine login: its token, checked against its login, no account, though accounts.github names another stored login (#962)', async (t) => {
  const fake = answering(200, user('octo'));
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const deps: AccountEnvDeps = { accounts: { github: 'work' }, credentials: async () => STORE, machineGithub: machine('octo') };
  assert.deepEqual(await accountEnv({ agent: 'copilot' }, deps), { env: { COPILOT_GITHUB_TOKEN: MACHINE_TOKEN }, accounts: {} });
  assert.equal(bearer(fake.calls[0]), `Bearer ${MACHINE_TOKEN}`);
});

test('the login is compared without regard to case; an unlimited quota is an entitlement (#962)', async () => {
  assert.deepEqual(await copilotAccountEnv(ctx('work'), answering(200, user('WORK'))), { env: { COPILOT_GITHUB_TOKEN: STORED_TOKEN }, account: 'work' });
  assert.deepEqual(await copilotAccountEnv(ctx(undefined, machine('Octo')), answering(200, user('oCTO'))), { env: { COPILOT_GITHUB_TOKEN: MACHINE_TOKEN } });
  const unlimited = user('work', { chat: { entitlement: 0, unlimited: true } });
  assert.deepEqual(await copilotAccountEnv(ctx('work'), answering(200, unlimited)), { env: { COPILOT_GITHUB_TOKEN: STORED_TOKEN }, account: 'work' });
});

test('a 401, a 2xx as another login or with no login is copilot/mismatch; no entitlement, a 403, a 404 or a 3xx is copilot/missing; no message holds the token (#962)', async () => {
  const none = { chat: { entitlement: 0, unlimited: false }, premium_interactions: { entitlement: 0, unlimited: false } };
  const cases: [number, string, AccountCode][] = [
    [401, '{}', 'mismatch'], [200, user('someone-else'), 'mismatch'], [200, JSON.stringify({ quota_snapshots: ENTITLED }), 'mismatch'],
    [200, user('work', none), 'missing'], [200, user('work', {}), 'missing'], [200, JSON.stringify({ login: 'work' }), 'missing'],
    [403, '{}', 'missing'], [404, '{}', 'missing'], [302, '', 'missing'],
  ];
  for (const [status, body, code] of cases) await refuses(copilotAccountEnv(ctx('work'), answering(status, body)), code, `${status} ${body}`);
});

test('a rejected fetch, a timeout, a 5xx or a body that is not JSON is copilot/unreachable (#962)', async () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const cases: [string, FakeFetch][] = [
    ['rejected', rejecting(new TypeError('fetch failed'))], ['timeout', rejecting(timeout)],
    ['500', answering(500, '{}')], ['503', answering(503, '')], ['not JSON', answering(200, '<html>')],
  ];
  for (const [label, fake] of cases) await refuses(copilotAccountEnv(ctx('work'), fake), 'unreachable', label);
});

test('a selected login with no stored token, and gh logged out or without a token, are copilot/missing, and nothing is fetched (#962)', async () => {
  const fake = answering(200, user('work'));
  const empty = async (): Promise<Credentials> => ({ github: { work: { token: '' } } });
  const noToken = async (): Promise<string> => { throw new Error(`gh: no token ${MACHINE_TOKEN}`); };
  const cases: [string, AccountCtx][] = [
    ['absent', ctx('gone')], ['an inherited name', ctx('toString')], ['empty', ctx('work', machine(), empty)], ['no GitHub logins', ctx('work', machine(), async () => ({}))],
    ['gh logged out', ctx(undefined, machine(''))], ['gh without a token', ctx(undefined, machine('octo', noToken))],
  ];
  for (const [label, given] of cases) await refuses(copilotAccountEnv(given, fake), 'missing', label);
  assert.equal(fake.calls.length, 0);
});
