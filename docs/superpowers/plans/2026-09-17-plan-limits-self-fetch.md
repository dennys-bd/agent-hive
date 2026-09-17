# Agent Hive — limites do plano sem depender de worker rodando: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The header shows `sessão NN% · semana NN%` as soon as the Hive opens and keeps updating while it sits on yellow, with no worker alive. The Hive reads `GET https://api.anthropic.com/api/oauth/usage` itself with the OAuth token Claude Code already keeps (env → `.credentials.json` → macOS Keychain), on `configure` / boot and every 5 min. A reading that fails keeps the last value, is logged once per reason, and never stops the Hive. The workers' status line keeps feeding in between.

**Architecture:** `src/rate-limits.ts` gains `parseUsage(body, now)` sharing the window collector with `parseRateLimits` (only the per-window parse differs: `utilization` + ISO `resets_at`). New `src/plan-limits.ts` holds `USAGE_URL`, `PLAN_LIMITS_INTERVAL_MS`, `readOAuthToken(deps)` and `readPlanLimits(deps)` with `fetch`, `exec`, `env`, `platform`, `now` injectable. `HiveEvent.rateLimits.workerId` becomes optional: without it the reducer always stores. `server.ts` takes `ServerDeps.readPlanLimits?: PlanLimitsReader`, gains `refreshPlanLimits()` (called after `poll()` in `configure`, exposed on `HiveServer` like `poll` because `bootHive`'s hive-mode path does not go through `configure`), a 5-min timer armed in `listen` and cleared in `close`, and change-only logging. `bootHive(repo, deps)` forwards the reader; `main.ts` and `run.ts` are the only places that pass the real one.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`. Global `fetch` (Node ≥ 18), no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-17-plan-limits-self-fetch-design.md` (extends `docs/superpowers/specs/2026-09-16-rate-limits-design.md`; card: issue #34).

## Global Constraints

- All v1, setup, boards, signal, budget, usage-rules and rate-limits constraints hold (immutable reducer, `execFile` argv arrays through the injectable `Exec`, Portuguese UI copy, English code comments and log lines, conventional commits without `Co-Authored-By`, no machine-specific values).
- Network only through the injectable `fetch`; the process only through the injectable `Exec`. Tests never touch the real `fetch`, `security`, `process.env.CLAUDE_CODE_OAUTH_TOKEN` or `~/.claude/.credentials.json`: every `PlanLimitsDeps` in a test sets `fetch`, `exec`, `platform` and `env.CLAUDE_CONFIG_DIR` (a tmp dir).
- The token lives only inside `readPlanLimits`; it is never stored in `State`, `hive.config.json`, the log or an error message. The response body never reaches the log, only the HTTP status.
- `src/rate-limits.ts` stays pure. `src/ui/*`, `hooks-settings.ts`, `state-store.ts`, `POST /hooks/status` and the UI do not change: `renderLimits` already shows any window and `às HH:MM`.
- Without `deps.readPlanLimits` the server never reads (what every existing test does). Only `main.ts` and `run.ts` inject `readPlanLimits` from `plan-limits.js`.
- ESM with `.js` import extensions; source files under 400 lines, functions under 50 lines.
- `pnpm test` must stay green after every task (252 tests today → 267 at the end).

---

## File map

| File | Change |
|---|---|
| `src/rate-limits.ts` | private `collectWindows(source, parse, now)` shared by `parseRateLimits` and new `parseUsage`; private `parseUsageWindow` |
| `src/types.ts` | `PlanLimitsReader`; `rateLimits` event `workerId?: string` |
| `src/plan-limits.ts` (new) | `USAGE_URL`, `PLAN_LIMITS_INTERVAL_MS`, `PlanLimitsDeps`, `readOAuthToken`, `readPlanLimits` |
| `src/orchestrator.ts` | `setRateLimits` accepts `workerId: string \| undefined` |
| `src/log.ts` | `describeEvent` for a `rateLimits` without worker |
| `src/server.ts` | `ServerDeps.readPlanLimits`, `HiveServer.refreshPlanLimits`, timer, logging on change |
| `src/hive.ts` | `bootHive(repo, deps = {})` forwards `readPlanLimits` and calls `refreshPlanLimits()` after `poll()` |
| `src/main.ts`, `src/run.ts` | `bootHive(repo, { readPlanLimits })` |
| `test/rate-limits.test.ts` | `parseUsage` (+4 → 11) |
| `test/plan-limits.test.ts` (new) | token sources, headers, argv, 401, invalid JSON (+6) |
| `test/orchestrator.test.ts` | `rateLimits` without `workerId` (+1) |
| `test/log.test.ts` | one assertion in the existing `describeEvent` test |
| `test/server.test.ts` | reader on setup + timer, failure logging, no dep (+3) |
| `test/hive.test.ts` | `bootHive` with a fake reader (+1) |

---

### Task 1: `parseUsage` in `src/rate-limits.ts` (TDD)

**Files:** Modify `src/rate-limits.ts`; Test `test/rate-limits.test.ts`

**Interfaces:**
- `parseUsage(body: unknown, now: Date): RateLimits | undefined` — every top-level key of the `/api/oauth/usage` body that matches `WINDOW_KEY` and holds `{ utilization: finite ≥ 0 (clamped to 100), resets_at: parseable date string → ISO }` becomes a window; `null`, other shapes and an unparseable `resets_at` drop the window; at most `MAX_WINDOWS`, payload order; no window or a non-object body → `undefined`.
- `parseRateLimits` unchanged in behaviour; both share `collectWindows`.

- [ ] **Step 1: Write the failing tests — append to `test/rate-limits.test.ts`** (add `parseUsage` to the import on line 3)

```ts
// What GET /api/oauth/usage answers on a Max plan: per-model weekly windows present, unused ones null, extra_usage alongside
const USAGE = {
  five_hour: { utilization: 23.4, resets_at: '2026-09-17T15:00:00.000Z' },
  seven_day: { utilization: 41, resets_at: '2026-09-21T00:00:00Z' },
  seven_day_opus: { utilization: 7.5, resets_at: '2026-09-21T00:00:00+00:00' },
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: 0, used_credits: 0, utilization: null },
};
const USAGE_PARSED: RateLimits = {
  at: '2026-09-16T12:00:00.000Z',
  windows: {
    five_hour: { usedPercent: 23.4, resetsAt: '2026-09-17T15:00:00.000Z' },
    seven_day: { usedPercent: 41, resetsAt: '2026-09-21T00:00:00.000Z' },
    seven_day_opus: { usedPercent: 7.5, resetsAt: '2026-09-21T00:00:00.000Z' },
  },
};

test('parseUsage reads the usage endpoint body: one window per key with utilization and an ISO resets_at, nulls and extras dropped', () => {
  assert.deepEqual(parseUsage(USAGE, NOW), USAGE_PARSED);
  assert.deepEqual(Object.keys(parseUsage(USAGE, NOW)?.windows ?? {}), ['five_hour', 'seven_day', 'seven_day_opus'], 'payload order');
});

test('parseUsage clamps a utilization above 100 and drops a window whose resets_at does not parse', () => {
  const over = { five_hour: { utilization: 250, resets_at: '2026-09-17T15:00:00Z' } };
  assert.equal(parseUsage(over, NOW)?.windows.five_hour.usedPercent, 100);
  const bad = { ...USAGE, seven_day: { utilization: 41, resets_at: 'soon' } };
  assert.deepEqual(Object.keys(parseUsage(bad, NOW)?.windows ?? {}), ['five_hour', 'seven_day_opus']);
  assert.equal(parseUsage({ five_hour: { utilization: 1, resets_at: 'soon' } }, NOW), undefined, 'no surviving window');
});

test('parseUsage is undefined for a body that is not an object or has no valid window', () => {
  const iso = '2026-09-17T15:00:00Z';
  const bodies: unknown[] = [
    undefined, null, 'x', 5, [], {}, { five_hour: null }, { five_hour: 7 },
    { five_hour: { utilization: '23', resets_at: iso } }, { five_hour: { utilization: -1, resets_at: iso } },
    { five_hour: { utilization: 1, resets_at: 1759744800 } }, { 'Five-Hour': { utilization: 1, resets_at: iso } },
  ];
  for (const body of bodies) assert.equal(parseUsage(body, NOW), undefined, String(JSON.stringify(body)));
});

test('parseUsage keeps at most MAX_WINDOWS windows, like parseRateLimits', () => {
  const body = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, { utilization: i, resets_at: '2026-09-17T15:00:00Z' }]));
  assert.deepEqual(Object.keys(parseUsage(body, NOW)?.windows ?? {}), Array.from({ length: MAX_WINDOWS }, (_, i) => `w${i}`));
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`. Expected: build error `Module '"../src/rate-limits.js"' has no exported member 'parseUsage'`.

- [ ] **Step 3: Edit `src/rate-limits.ts`** — replace `parseRateLimits` (lines 28–39) with:

```ts
type WindowParser = (raw: unknown) => RateLimitWindow | undefined;

// Shared by both sources: key filter, cap at MAX_WINDOWS, nothing when no window survives (then nothing is dispatched).
function collectWindows(source: Record<string, unknown>, parse: WindowParser, now: Date): RateLimits | undefined {
  const entries = Object.entries(source)
    .filter(([key]) => WINDOW_KEY.test(key))
    .flatMap<[string, RateLimitWindow]>(([key, raw]) => {
      const window = parse(raw);
      return window ? [[key, window]] : [];
    })
    .slice(0, MAX_WINDOWS); // any local process can post here, and the endpoint is undocumented: the State never grows past this
  return entries.length === 0 ? undefined : { at: now.toISOString(), windows: Object.fromEntries(entries) };
}

/** `body.rate_limits` of a status line JSON → the persisted shape. */
export function parseRateLimits(body: unknown, now: Date): RateLimits | undefined {
  if (!isRecord(body) || !isRecord(body.rate_limits)) return undefined;
  return collectWindows(body.rate_limits, parseWindow, now);
}

// The usage endpoint window: `utilization` percent and `resets_at` as a date string. `null` (a window the plan lacks) drops it.
function parseUsageWindow(raw: unknown): RateLimitWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { utilization, resets_at: resetsAt } = raw;
  if (!isPercent(utilization) || typeof resetsAt !== 'string') return undefined;
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return undefined;
  return { usedPercent: Math.min(utilization, PERCENT_MAX), resetsAt: reset.toISOString() };
}

/** The body of GET /api/oauth/usage (undocumented: parsed defensively) → the same persisted shape. `extra_usage` falls to the filter. */
export function parseUsage(body: unknown, now: Date): RateLimits | undefined {
  return isRecord(body) ? collectWindows(body, parseUsageWindow, now) : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`. Expected: 256 tests PASS (`rate-limits` 11).

- [ ] **Step 5: Commit**

```bash
git add src/rate-limits.ts test/rate-limits.test.ts
git commit -m "feat(rate-limits): parseUsage reads the oauth usage body through the shared window collector"
```

---

### Task 2: `src/plan-limits.ts` — token sources and the reading (TDD)

**Files:** Create `src/plan-limits.ts`, `test/plan-limits.test.ts`; Modify `src/types.ts` (`PlanLimitsReader`)

**Interfaces:**
- `src/types.ts`: `/** Reads the plan limits of the Claude Code account; rejects when it cannot (no token, network, 401). */ export type PlanLimitsReader = () => Promise<RateLimits | undefined>;`
- `src/plan-limits.ts`: `USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'`; `PLAN_LIMITS_INTERVAL_MS = 5 * 60_000`; `interface PlanLimitsDeps { fetch?: typeof fetch; exec?: Exec; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; now?: () => Date }`; `readOAuthToken(deps = {}): Promise<string>` — `env.CLAUDE_CODE_OAUTH_TOKEN` → `<env.CLAUDE_CONFIG_DIR ?? ~/.claude>/.credentials.json` (`claudeAiOauth.accessToken`, non-empty string) → on `darwin`, `exec('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'])` (same JSON on stdout); each source that is missing, unreadable, not JSON, or fails moves to the next; none → `Error('no Claude Code OAuth token (env, .credentials.json or Keychain)')`; `readPlanLimits(deps = {}): Promise<RateLimits | undefined>` — token → `fetch(USAGE_URL, { headers: { Authorization: 'Bearer <token>', 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10_000) })`; `!res.ok` → `Error('HTTP <status>')`; unparseable JSON → `Error('invalid JSON body')`; else `parseUsage(json, now())`.
- Consumed by: Task 4 (`PLAN_LIMITS_INTERVAL_MS`, `PlanLimitsReader`), Task 5 (`readPlanLimits`).

- [ ] **Step 1: Write the failing tests — create `test/plan-limits.test.ts`**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`. Expected: build error `Cannot find module '../src/plan-limits.js'`.

- [ ] **Step 3: Edit `src/types.ts`** — after the `RateLimits` interface add:

```ts
/** Reads the plan limits of the Claude Code account; rejects when it cannot (no token, network, 401). */
export type PlanLimitsReader = () => Promise<RateLimits | undefined>;
```

- [ ] **Step 4: Create `src/plan-limits.ts`**

```ts
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseUsage } from './rate-limits.js';
import type { Exec, RateLimits } from './types.js';

/** Undocumented; what `/usage` in Claude Code reads. The only host this module ever calls. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const PLAN_LIMITS_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const OAUTH_BETA = 'oauth-2025-04-20';
const CREDENTIALS_FILE = '.credentials.json';
const KEYCHAIN_ARGS = ['find-generic-password', '-s', 'Claude Code-credentials', '-w'];
const NO_TOKEN_MESSAGE = 'no Claude Code OAuth token (env, .credentials.json or Keychain)';

const execFileAsync: Exec = promisify(execFile);

export interface PlanLimitsDeps {
  fetch?: typeof fetch;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

// The file and the Keychain item hold the same JSON: { claudeAiOauth: { accessToken, refreshToken, expiresAt, … } }.
function tokenFromJson(text: string): string | undefined {
  try {
    const { claudeAiOauth } = JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = claudeAiOauth?.accessToken;
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch {
    return undefined; // not JSON or not an object: the next source
  }
}

async function tokenFromFile(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), CREDENTIALS_FILE);
  const text = await readFile(path, 'utf8').catch(() => undefined); // missing or unreadable: the next source
  return text === undefined ? undefined : tokenFromJson(text);
}

async function tokenFromKeychain(exec: Exec): Promise<string | undefined> {
  try {
    const { stdout } = await exec('security', KEYCHAIN_ARGS);
    return tokenFromJson(stdout.trim());
  } catch {
    return undefined; // no item, or the Keychain is locked: nothing to read
  }
}

/** Same precedence as Claude Code: env → <config dir>/.credentials.json → macOS Keychain. Read on every call: Claude Code renews it. */
export async function readOAuthToken(deps: PlanLimitsDeps = {}): Promise<string> {
  const { env = process.env, exec = execFileAsync, platform = process.platform } = deps;
  const token = env.CLAUDE_CODE_OAUTH_TOKEN || (await tokenFromFile(env)) || (platform === 'darwin' ? await tokenFromKeychain(exec) : undefined);
  if (!token) throw new Error(NO_TOKEN_MESSAGE);
  return token;
}

/** One reading of the account's plan limits. The token exists only inside this call; no error carries it or the response body. */
export async function readPlanLimits(deps: PlanLimitsDeps = {}): Promise<RateLimits | undefined> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const token = await readOAuthToken(deps);
  const res = await doFetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // no retry: the next reading is the retry
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: unknown = await res.json().catch(() => { throw new Error('invalid JSON body'); }); // res.json() would quote the body
  return parseUsage(body, now());
}
```

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`. Expected: 262 tests PASS (`plan-limits` 6).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/plan-limits.ts test/plan-limits.test.ts
git commit -m "feat(plan-limits): read the plan limits from the oauth usage endpoint with the Claude Code token"
```

---

### Task 3: `rateLimits` event without `workerId` (TDD)

**Files:** Modify `src/types.ts`, `src/orchestrator.ts`, `src/log.ts`; Test `test/orchestrator.test.ts`, `test/log.test.ts`

**Interfaces:**
- `HiveEvent`: `{ type: 'rateLimits'; workerId?: string; rateLimits: RateLimits }` — no `workerId`: the Hive's own reading, always stored; with one: the current rule (only an occupied slot).
- `setRateLimits(state, workerId: string | undefined, rateLimits): Reduced`.
- `describeEvent`: `rateLimits worker=<id8>` as today, `rateLimits source=hive` without a worker.

- [ ] **Step 1: Write the failing tests** — append to `test/orchestrator.test.ts` after `rateLimits never mutates its input…`:

```ts
test('rateLimits without a workerId is the Hive own reading: stored with no slot occupied, no effects, input untouched', () => {
  const idle = initialState(1); // one free slot, empty queue: no worker anywhere
  const snapshot = JSON.stringify(idle);
  const { state, effects } = reduce(idle, { type: 'rateLimits', rateLimits: LIMITS });
  assert.deepEqual(state.rateLimits, LIMITS);
  assert.equal(effects.length, 0, 'display only');
  assert.deepEqual({ ...state, rateLimits: undefined }, { ...idle, rateLimits: undefined }, 'nothing else changes');
  assert.equal(JSON.stringify(idle), snapshot);
  assert.equal(idle.rateLimits, undefined);
  const newer: RateLimits = { ...LIMITS, at: '2026-09-17T12:05:00.000Z' };
  assert.deepEqual(reduce(state, { type: 'rateLimits', rateLimits: newer }).state.rateLimits, newer, 'the latest reading wins');
  assert.equal(limited(state, 'ghost').state.rateLimits, LIMITS, 'with a workerId the slot rule still holds');
});
```

In `test/log.test.ts`, after the `describeEvent … rateLimits worker=1a2b3c4d` assertion (line 125) add:

```ts
  assert.equal(describeEvent({ type: 'rateLimits', rateLimits: { at: '2026-09-17T12:00:00.000Z', windows: {} } }), 'rateLimits source=hive');
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`. Expected: build errors — `Property 'workerId' is missing in type … 'rateLimits'` in both test files.

- [ ] **Step 3: Edit `src/types.ts`** — line 131 → `  | { type: 'rateLimits'; workerId?: string; rateLimits: RateLimits } // no workerId: the Hive's own reading`

- [ ] **Step 4: Edit `src/orchestrator.ts`** — replace `setRateLimits` (lines 100–104):

```ts
// Account-wide data. From a worker it needs a live slot, as with hooks (any local process can post to the route); the Hive's own
// reading never passes through a route, so it is always kept. Nothing here gates a spawn: signal and budget stay item 6's.
function setRateLimits(state: State, workerId: string | undefined, rateLimits: RateLimits): Reduced {
  if (workerId === undefined) return none({ ...state, rateLimits });
  const slot = state.slots.find((s) => s.workerId === workerId);
  return !slot || slot.status === 'vazio' ? none(state) : none({ ...state, rateLimits });
}
```

- [ ] **Step 5: Edit `src/log.ts`** — line 103 → `    case 'rateLimits': return event.workerId ? \`rateLimits worker=${shortId(event.workerId)}\` : 'rateLimits source=hive';`

- [ ] **Step 6: Run tests to verify they pass** — `pnpm test`. Expected: 263 tests PASS. `POST /hooks/status` in `server.ts` still passes a string `workerId`; nothing else changes.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/orchestrator.ts src/log.ts test/orchestrator.test.ts test/log.test.ts
git commit -m "feat(orchestrator): a rateLimits event without workerId is the Hive own reading and is always stored"
```

---

### Task 4: Server — `readPlanLimits` dep, `refreshPlanLimits`, timer, logging on change (TDD)

**Files:** Modify `src/server.ts`; Test `test/server.test.ts`

**Interfaces:**
- `ServerDeps.readPlanLimits?: PlanLimitsReader` — absent: the server never reads.
- `HiveServer.refreshPlanLimits(): Promise<void>` — no dep or not live → nothing; a value → `dispatch({ type: 'rateLimits', rateLimits })`; `undefined` → nothing; a rejection → `log.info('plan limits: <message>')` only when the message differs from the last one, and `log.info('plan limits: ok')` on the first success after a failure. Never `State.error`.
- `configure` calls it after `poll()`; `listen` arms `setInterval(refreshPlanLimits, PLAN_LIMITS_INTERVAL_MS)`; `close` clears it. `reconfigure` and `POST /hooks/status` unchanged.

- [ ] **Step 1: Write the failing tests — in `test/server.test.ts`**

Add `import { PLAN_LIMITS_INTERVAL_MS } from '../src/plan-limits.js';` after the orchestrator import; add `RateLimits` to the types import. After `const QUOTA = …` add:

```ts
const PLAN: RateLimits = {
  at: '2026-09-17T12:00:00.000Z',
  windows: { five_hour: { usedPercent: 23.4, resetsAt: '2026-09-17T15:00:00.000Z' }, seven_day_opus: { usedPercent: 7.5, resetsAt: '2026-09-21T00:00:00.000Z' } },
};
const NO_TOKEN = 'no Claude Code OAuth token (env, .credentials.json or Keychain)';
```

Append:

```ts
test('POST /setup reads the plan limits through the injected reader with no worker alive, and the timer reads again every 5 min', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] }); // before listen: the timer is armed there
  let reads = 0;
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const server = createServer({
    repo, boardFactory: fakeBoardFactory().factory, spawnWorker: fakeSpawn().spawn,
    readPlanLimits: async () => { reads += 1; return { ...PLAN, at: `2026-09-17T12:0${reads}:00.000Z` }; },
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  assert.equal(reads, 0, 'nothing to read before the Hive is configured');
  assert.equal((await postJson(`http://127.0.0.1:${port}/setup`, { ...BODY, maxConcurrent: 0 })).status, 200); // no slot: no worker ever
  assert.equal(reads, 1, 'configure reads once, after the poll');
  assert.deepEqual(server.getState()?.rateLimits, { ...PLAN, at: '2026-09-17T12:01:00.000Z' });
  t.mock.timers.tick(PLAN_LIMITS_INTERVAL_MS);
  await waitFor(() => server.getState()?.rateLimits?.at === '2026-09-17T12:02:00.000Z');
  assert.equal(reads, 2);
  const saved = JSON.parse(await readFile(join(repo, '.hive', 'state.json'), 'utf8')) as State;
  assert.deepEqual(saved.rateLimits, server.getState()?.rateLimits, 'persisted like any other reading');
  assert.equal(server.getState()?.error, undefined);
});

test('a reader that rejects keeps the last value and the Hive going; the reason is logged once per change and the recovery once', async (t) => {
  const { log, lines } = fakeLog();
  let failWith: string | undefined = NO_TOKEN;
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const server = createServer({
    repo, boardFactory: fakeBoardFactory().factory, spawnWorker: fakeSpawn().spawn, log,
    readPlanLimits: async () => { if (failWith) throw new Error(failWith); return PLAN; },
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  const planLines = (): string[] => lines.filter((l) => l.includes('plan limits'));
  assert.equal((await postJson(`http://127.0.0.1:${port}/setup`, { ...BODY, maxConcurrent: 0 })).status, 200, 'setup succeeds without limits');
  assert.equal(server.getState()?.rateLimits, undefined);
  assert.equal(server.getState()?.error, undefined, 'never the error bar: an API-key user has no token, by design');
  assert.deepEqual(planLines(), [`INFO plan limits: ${NO_TOKEN}`]);
  await server.refreshPlanLimits();
  assert.deepEqual(planLines(), [`INFO plan limits: ${NO_TOKEN}`], 'same reason again: silent');
  failWith = 'HTTP 401';
  await server.refreshPlanLimits();
  assert.deepEqual(planLines(), [`INFO plan limits: ${NO_TOKEN}`, 'INFO plan limits: HTTP 401']);
  failWith = undefined;
  await server.refreshPlanLimits();
  assert.deepEqual(server.getState()?.rateLimits, PLAN);
  assert.deepEqual(planLines().at(-1), 'INFO plan limits: ok');
  await server.refreshPlanLimits();
  assert.equal(planLines().length, 3, 'a success after a success logs nothing');
  failWith = 'HTTP 401';
  await server.refreshPlanLimits();
  assert.deepEqual(server.getState()?.rateLimits, PLAN, 'the last value stays');
  assert.ok(!lines.some((l) => l.startsWith('ERROR')), lines.filter((l) => l.startsWith('ERROR')).join('\n'));
});

test('without a readPlanLimits dep the server never reads the plan limits and logs nothing about them', async (t) => {
  const { log, lines } = fakeLog();
  const { server } = await start(t, BODY, log);
  await server.refreshPlanLimits();
  assert.equal(server.getState()?.rateLimits, undefined);
  assert.ok(!lines.some((l) => l.includes('plan limits')), lines.join('\n'));
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`. Expected: build errors — `'readPlanLimits' does not exist in type 'ServerDeps'`, `Property 'refreshPlanLimits' does not exist on type 'HiveServer'`.

- [ ] **Step 3: Edit `src/server.ts`**

After `import { POLL_INTERVAL_MS, shouldPoll } from './polling.js';` add `import { PLAN_LIMITS_INTERVAL_MS } from './plan-limits.js';`. Add `PlanLimitsReader` to the `./types.js` type import.

In `ServerDeps`, after `log?: Logger; …` add:

```ts
  /** The Hive's own reading of the plan limits; absent (every test) means it never reads. main.ts / run.ts inject the real one. */
  readPlanLimits?: PlanLimitsReader;
```

In `HiveServer`, after `poll(): Promise<void>;` add `  refreshPlanLimits(): Promise<void>;`.

After `let pollTimer: …` add:

```ts
  let planLimitsTimer: NodeJS.Timeout | undefined;
  let planLimitsReason: string | undefined; // last failure logged; a repeat is silent, a change and the recovery are one line each
```

After `refreshQuota` add:

```ts
  // A failure keeps the last value and is logged once per reason: an API-key user (no OAuth token) sees it in hive.log once, not
  // every 5 min. Info, not error: nothing is broken. The reader's message never carries the token or the response body.
  async function refreshPlanLimits(): Promise<void> {
    const read = deps.readPlanLimits;
    if (!read || !live) return;
    try {
      const rateLimits = await read();
      if (planLimitsReason !== undefined) log.info('plan limits: ok');
      planLimitsReason = undefined;
      if (rateLimits) await dispatch({ type: 'rateLimits', rateLimits });
    } catch (err) {
      const reason = errorMessage(err);
      if (reason !== planLimitsReason) log.info(`plan limits: ${reason}`);
      planLimitsReason = reason;
    }
  }
```

In `configure`, after `await poll();` add `    await refreshPlanLimits();`.
In `listen`, after the `pollTimer = …` line add `    planLimitsTimer = setInterval(() => void refreshPlanLimits(), PLAN_LIMITS_INTERVAL_MS); // no-op until configured or without the dep`.
In `close`, after `if (pollTimer) clearInterval(pollTimer);` add `    if (planLimitsTimer) clearInterval(planLimitsTimer);`.
Last line → `return { dispatch, poll, refreshPlanLimits, listen, close, configure, reconfigure, getState: () => live?.state };`

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`. Expected: 266 tests PASS (`server` +3). `the timer skips the board…` stays green: its 10 ticks of 30 s fire the new timer once as a no-op (no dep).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): read the plan limits on configure and every 5 min through an injected reader"
```

---

### Task 5: `bootHive` deps, `main.ts` / `run.ts` wiring (TDD for the boot, manual for the acceptance)

**Files:** Modify `src/hive.ts`, `src/main.ts`, `src/run.ts`; Test `test/hive.test.ts`

**Interfaces:**
- `bootHive(repo: string, deps: Pick<ServerDeps, 'readPlanLimits'> = {}): Promise<BootedHive>` — spreads `deps` into both `createServer` calls; in hive mode calls `server.refreshPlanLimits()` after `server.poll()` (setup mode gets it through `configure` on `POST /setup`).
- `main.ts` and `run.ts`: `bootHive(repo, { readPlanLimits })` with `import { readPlanLimits } from './plan-limits.js';` (its `deps` parameter is optional, so it is a `PlanLimitsReader` as is; the real `fetch`, `security`, env and platform apply only here).

- [ ] **Step 1: Write the failing test — append to `test/hive.test.ts`** (add `RateLimits` to the types import)

```ts
test('bootHive reads the plan limits through the injected reader on boot, so the header has them before any worker; no reader, no reading', async (t) => {
  const repo = await repoWithConfig({});
  const rateLimits: RateLimits = { at: '2026-09-17T12:00:00.000Z', windows: { five_hour: { usedPercent: 23, resetsAt: '2026-09-17T15:00:00.000Z' } } };
  let reads = 0;
  const { server } = await bootHive(repo, { readPlanLimits: async () => { reads += 1; return rateLimits; } });
  t.after(() => server.close());
  assert.equal(reads, 1);
  assert.deepEqual(server.getState()?.rateLimits, rateLimits);
  const plain = await repoWithConfig({});
  const bare = await bootHive(plain);
  t.after(() => bare.server.close());
  assert.equal(bare.server.getState()?.rateLimits, undefined);
  assert.ok(!(await logLines(plain)).some((l) => l.includes('plan limits')), 'nothing to say without a reader');
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`. Expected: build error `Expected 1 arguments, but got 2` on `bootHive`.

- [ ] **Step 3: Edit `src/hive.ts`**

Line 14 → `export async function bootHive(repo: string, deps: Pick<ServerDeps, 'readPlanLimits'> = {}): Promise<BootedHive> {`
Line 20 → `  if (!config) return bootSetupMode(repo, log, deps);`
Line 30 → `    return bootSetupMode(repo, log, deps, { config, error });`
Line 35 → `  const server = createServer({ repo, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state: saved, log, ...deps });`
After `  await server.poll();` (line 39) add `  await server.refreshPlanLimits(); // hive mode skips configure(): the same order, board first, then the account`.
`bootSetupMode` signature → `async function bootSetupMode(repo: string, log: Logger, deps: Pick<ServerDeps, 'readPlanLimits'>, setupFallback?: ServerDeps['setupFallback']): Promise<BootedHive> {` and its `createServer` call → `createServer({ repo, setupFallback, log, ...deps });`

- [ ] **Step 4: Edit `src/main.ts` and `src/run.ts`**

`main.ts`: after `import { bootHive } from './hive.js';` add `import { readPlanLimits } from './plan-limits.js';`; line 69 → `  const { port, server } = await bootHive(repo, { readPlanLimits });`
`run.ts`: after the `hive.js` import add `import { readPlanLimits } from './plan-limits.js';`; line 9 → `bootHive(resolve(repo), { readPlanLimits }).catch((err: Error) => {`

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`. Expected: 267 tests PASS (`hive` 6). `pnpm lint` clean.

- [ ] **Step 6: Acceptance per the spec's "Critério de pronto" (manual)**

1. Pro/Max account, Claude Code logged in, a repo with `máx. workers = 0`: `pnpm start <repo>`. The header shows `sessão NN% ▮▮ reseta HH:MM · semana NN% … · às HH:MM` within a second of the window opening, no worker alive; `às HH:MM` moves 5 min later. `cat <repo>/.hive/hive.log` has no `plan limits:` line; `grep -c oat01 <repo>/.hive/hive.log <repo>/.hive/state.json` is 0 on both.
2. Same repo with `CLAUDE_CODE_OAUTH_TOKEN=bad pnpm run:headless <repo>`: the Hive boots, `hive.log` has exactly one `INFO  plan limits: HTTP 401` line after 6 min, and `curl -s localhost:47821/events | head -c 400` shows `rateLimits` only if `state.json` had one from before.
3. API-key machine (or `CLAUDE_CONFIG_DIR=$(mktemp -d)` and no env token, on Linux or with the Keychain item absent): the header is empty or shows the last saved value, and `hive.log` has one `INFO  plan limits: no Claude Code OAuth token (env, .credentials.json or Keychain)` line.
4. Signal buttons, `máx. workers`, token meter, queue and the workers' status line behave exactly as in #13.

- [ ] **Step 7: Commit**

```bash
git add src/hive.ts src/main.ts src/run.ts test/hive.test.ts
git commit -m "feat(hive): boot reads the plan limits itself; main and run inject the real reader"
```
