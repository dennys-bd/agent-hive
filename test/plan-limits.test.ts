import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN_LIMITS_INTERVAL_MS, readOAuthToken, readPlanLimits, USAGE_URL, type PlanLimitsDeps } from '../src/plan-limits.js';
import type { Exec } from '../src/types.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const TOKEN = 'sk-ant-oat01-secret-token';
const KEYCHAIN_ARGV = ['find-generic-password', '-s', 'Claude Code-credentials', '-w'];
const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: 1 } });
const USAGE = { five_hour: { utilization: 23.4, resets_at: '2026-09-17T15:00:00Z' }, seven_day: { utilization: 41, resets_at: '2026-09-21T00:00:00Z' } };
const PARSED = {
  at: NOW.toISOString(),
  windows: { five_hour: { usedPercent: 23.4, resetsAt: '2026-09-17T15:00:00.000Z' }, seven_day: { usedPercent: 41, resetsAt: '2026-09-21T00:00:00.000Z' } },
};

interface FetchCall { url: string; init: RequestInit | undefined }

// Answers `body` with `status` and records every call; nothing leaves the process.
function fakeFetch(status = 200, body = JSON.stringify(USAGE)): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: doFetch, calls };
}

// `security` printing `stdout`, or failing like an absent item / locked Keychain when there is none.
function fakeExec(stdout?: string): { exec: Exec; calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, args]);
    if (stdout === undefined) throw new Error('security: The specified item could not be found in the keychain.');
    return { stdout: `${stdout}\n` };
  };
  return { exec, calls };
}

// Every dep set, so no test reads the real env, the real ~/.claude or the real Keychain, whatever the machine.
async function deps(overrides: PlanLimitsDeps = {}): Promise<PlanLimitsDeps> {
  const configDir = await mkdtemp(join(tmpdir(), 'hive-claude-'));
  return { fetch: fakeFetch().fetch, exec: fakeExec().exec, platform: 'linux', env: { CLAUDE_CONFIG_DIR: configDir }, now: () => NOW, ...overrides };
}

test('readPlanLimits with the env token calls the usage URL with the bearer and beta headers and returns the parsed windows', async () => {
  const { fetch, calls } = fakeFetch();
  const keychain = fakeExec(CREDENTIALS);
  const limits = await readPlanLimits(await deps({ fetch, exec: keychain.exec, platform: 'darwin', env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }));
  assert.deepEqual(limits, PARSED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, USAGE_URL);
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(headers.get('anthropic-beta'), 'oauth-2025-04-20');
  assert.ok(calls[0].init?.signal instanceof AbortSignal, 'a timeout guards the call');
  assert.equal(keychain.calls.length, 0, 'the env wins: the Keychain is not asked');
  assert.equal(PLAN_LIMITS_INTERVAL_MS, 300_000);
});

test('readOAuthToken falls back to <CLAUDE_CONFIG_DIR>/.credentials.json, skipping a file without a usable accessToken', async () => {
  const base = await deps();
  const file = join(base.env!.CLAUDE_CONFIG_DIR!, '.credentials.json');
  await writeFile(file, CREDENTIALS);
  assert.equal(await readOAuthToken(base), TOKEN);
  for (const text of [JSON.stringify({ claudeAiOauth: { accessToken: '' } }), JSON.stringify({ other: 1 }), '{ not json', 'null']) {
    await writeFile(file, text);
    await assert.rejects(readOAuthToken(base), /no Claude Code OAuth token/, text);
  }
});

test('readOAuthToken asks the macOS Keychain with the exact argv when the file is missing, and never on another platform', async () => {
  const { exec, calls } = fakeExec(CREDENTIALS);
  assert.equal(await readOAuthToken(await deps({ exec, platform: 'darwin' })), TOKEN);
  assert.deepEqual(calls, [['security', KEYCHAIN_ARGV]]);
  const linux = fakeExec(CREDENTIALS);
  await assert.rejects(readOAuthToken(await deps({ exec: linux.exec, platform: 'linux' })), /no Claude Code OAuth token/);
  assert.equal(linux.calls.length, 0);
});

test('readPlanLimits rejects naming the three sources when none has a token, and fetch never runs', async () => {
  const { fetch, calls } = fakeFetch();
  const locked = fakeExec(); // security fails: absent item or locked Keychain
  await assert.rejects(readPlanLimits(await deps({ fetch, exec: locked.exec, platform: 'darwin' })), {
    message: 'no Claude Code OAuth token (env, .credentials.json or Keychain)',
  });
  assert.equal(locked.calls.length, 1, 'the Keychain was tried');
  assert.equal(calls.length, 0);
});

test('readPlanLimits rejects with the HTTP status on a non-2xx answer, and the message never carries the token', async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
  await assert.rejects(readPlanLimits(await deps({ fetch: fakeFetch(401, '{"error":"unauthorized"}').fetch, env })), (err: Error) => {
    assert.equal(err.message, 'HTTP 401');
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
});

test('readPlanLimits rejects on a body that is not JSON without echoing it, and resolves undefined on JSON with no window', async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
  await assert.rejects(readPlanLimits(await deps({ fetch: fakeFetch(200, 'not json at all').fetch, env })), (err: Error) => {
    assert.ok(!err.message.includes('not json at all'), err.message);
    return true;
  });
  assert.equal(await readPlanLimits(await deps({ fetch: fakeFetch(200, '{"extra_usage":{}}').fetch, env })), undefined);
});
