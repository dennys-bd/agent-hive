# Agent Hive — poll do board sob orçamento da API do GitHub: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The 30 s timer stops hitting the GitHub board when nothing could start anyway. A timer tick calls the board only when a job could be scheduled (`canSchedule`: effective signal green, a free non-draining slot, room under the dynamic cap, token budget with balance) or when the last read is 5 min old (`IDLE_POLL_INTERVAL_MS`), and never while the GraphQL quota is below a 500-point reserve (`QUOTA_RESERVE`) and its reset is still ahead. After every real poll — success or failure — the server reads the account's GraphQL quota through `gh api rate_limit` (which does not consume quota) and stores it as `State.boardQuota`; the header shows `GitHub 4.320/5.000 · reseta HH:MM`, red when below the reserve. Manual refresh, `configure`, `reconfigure` and boot always poll. The quota never opens or closes a job by itself.

**Architecture:** `src/polling.ts` (new) holds `POLL_INTERVAL_MS` (moved from `server.ts`, same value), `IDLE_POLL_INTERVAL_MS`, `QUOTA_RESERVE`, `shouldPoll(state, now)` (`!inBackoff && (canSchedule || stale)`) and `isBoardQuota` (persisted shape, for `state-store`). `orchestrator.ts` exports `canSchedule(state, now)`, extracted from the gate at the top of `fill` (which now calls it), and gains the `boardQuota` reducer case: `{ ...state, boardQuota }`, no effects, no `fill`. `types.ts` gains `BoardQuota`, `State.boardQuota?`, the `boardQuota` event and the optional `Board.quota?()`. Only the GitHub adapter implements `quota()`: `gh api rate_limit --jq .resources.graphql` → `{ limit, remaining, reset }` → `BoardQuota` with `resetsAt` ISO and `at = now`; an unexpected shape returns `undefined`. `server.ts`'s `poll()` stays as is and ends with `refreshQuota()` (`board.quota?.()` → dispatch, or `console.error` on failure); the timer calls `tick()`, which goes through `shouldPoll`. `state-store.ts` keeps `boardQuota` only when `isBoardQuota` holds. `app.ts` gains `renderQuota` and `index.html` a `#quota` span after `#limits`.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-16-board-polling-design.md` (extends `docs/superpowers/specs/2026-09-16-pluggable-boards-design.md`, `docs/superpowers/specs/2026-09-16-signal-design.md` and `docs/superpowers/specs/2026-09-15-agent-hive-design.md`; card: issue #25).

## Global Constraints

- All v1, setup, boards, signal, budget, usage-rules and rate-limits constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts`, `run.ts`, `hive.ts`, `spawn.ts`, `board.ts`, `config.ts`, `usage.ts`, `usage-rules.ts`, `rate-limits.ts`, `hooks-settings.ts`, `workers.ts` and `src/boards/markdown.ts` do not change. No config field, no setup-form field, no `SetupBody` field: `boardQuota` lives only in `State` (and therefore in `state.json`).
- `src/polling.ts` imports only `./orchestrator.js` (for `canSchedule`) and types; no `node:*`. `shouldPoll` is the single place that decides whether a timer tick hits the board; nothing else reads `boardQuota` except `normalize` and the UI.
- `fill`, `canStart`, `hasBudget`, `limits` and the usage rules never read `state.boardQuota`; the `boardQuota` reducer branch never calls `fill`, never emits an effect and never touches a slot or the queue. `fill`'s behaviour is unchanged: `canSchedule` is the same composition it already evaluated at its top, and the loop keeps re-checking `canStart` per spawn.
- `poll()` always calls the board; only the timer goes through `shouldPoll`. `POST /board/refresh`, `configure`, `reconfigure` and boot keep calling `poll()` directly. The quota is read after every real poll (success or failure) and never on a skipped tick; a failed quota read is logged and never replaces `state.error`.
- Timer interval stays 30 s; no second timer, no backoff state beyond `boardQuota` itself.
- `src/ui/app.ts` cannot import `src/polling.ts` (the served module graph only has `app.js`): `QUOTA_RESERVE` is mirrored there under the same "Mirrors src/…" comment convention. UI times use the existing `clock` helper.
- ESM with `.js` import extensions; no new runtime dependencies; source files under 400 lines, functions under 50 lines. Code comments in English.
- `test/fakes.ts`'s `fakeBoardFactory` keeps its default behaviour (no `quota`), so every existing server and setup test is untouched.
- `pnpm test` must stay green after every task (206 tests today → 216 at the end).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `BoardQuota`; `State.boardQuota?`; `boardQuota` event; `Board.quota?()` |
| `src/polling.ts` (new) | `POLL_INTERVAL_MS`, `IDLE_POLL_INTERVAL_MS`, `QUOTA_RESERVE`, `shouldPoll`, `isBoardQuota` |
| `src/orchestrator.ts` | `canSchedule` exported (extracted from `fill`), `boardQuota` case in `reduce` |
| `src/boards/github.ts` | private `readQuota(exec)`, `quota` on the returned board |
| `src/state-store.ts` | `normalize` keeps `boardQuota` only when `isBoardQuota` |
| `src/server.ts` | `POLL_INTERVAL_MS` imported from `polling.ts`; `refreshQuota` after `poll()`; timer runs `tick()` through `shouldPoll` |
| `src/ui/app.ts` | `QUOTA_RESERVE` mirror, `renderQuota`, called from `render` |
| `src/ui/index.html` | `<span id="quota" class="dash">` after `#limits`; `#quota` / `#quota.low` styles |
| `test/polling.test.ts` (new) | `shouldPoll` cases, constants, `isBoardQuota` (+4) |
| `test/orchestrator.test.ts` | `canSchedule` mirrors the fill gate; `boardQuota` stores without effects (+2 → 60) |
| `test/board.test.ts` | `quota()` argv and ISO conversion; unexpected shape; markdown has none (+2 → 14) |
| `test/state-store.test.ts` | valid `boardQuota` kept, invalid dropped (+1 → 8) |
| `test/fakes.ts` | optional `quota` on `fakeBoardFactory` |
| `test/server.test.ts` | `/board/refresh` reads the quota; a board without `quota` stores nothing (+1 → 12) |

---

### Task 1: Types, `src/polling.ts`, `canSchedule` and the `boardQuota` reducer case (TDD)

**Files:**
- Modify: `src/types.ts`, `src/orchestrator.ts`
- Create: `src/polling.ts`
- Test: `test/polling.test.ts` (new), `test/orchestrator.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`):
  - `interface BoardQuota { limit: number; remaining: number; resetsAt: string; at: string }` — both ISO; `at` is when it was read
  - `State.boardQuota?: BoardQuota`
  - `HiveEvent` gains `{ type: 'boardQuota'; quota: BoardQuota }`
- Produces (in `src/orchestrator.ts`):
  - `canSchedule(state: State, now: number): boolean` — `hasBudget(state.usage, state.budget, now) && canStart(signal, state.slots, maxWorkers)` with `signal` / `maxWorkers` from `limits(state, now)`; `fill` opens with it
  - `reduce` handles `boardQuota`: `none({ ...state, boardQuota: event.quota })`
- Produces (in `src/polling.ts`):
  - `POLL_INTERVAL_MS = 30_000`, `IDLE_POLL_INTERVAL_MS = 5 * 60_000`, `QUOTA_RESERVE = 500`
  - `shouldPoll(state: State, now: number): boolean` — `!inBackoff(state, now) && (canSchedule(state, now) || isStale(state, now))`; `inBackoff`: `boardQuota` present, `remaining < QUOTA_RESERVE`, `Date.parse(resetsAt) > now`; `isStale`: `lastPolledAt` missing, unparsable or older than `IDLE_POLL_INTERVAL_MS`
  - `isBoardQuota(value: unknown): value is BoardQuota` — `limit` and `remaining` finite ≥ 0, `resetsAt` and `at` strings
- Consumed by: Task 3 (`isBoardQuota`), Task 4 (`POLL_INTERVAL_MS`, `shouldPoll`, the event), Task 5 (`BoardQuota`).

- [ ] **Step 1: Write the failing tests — create `test/polling.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { IDLE_POLL_INTERVAL_MS, isBoardQuota, POLL_INTERVAL_MS, QUOTA_RESERVE, shouldPoll } from '../src/polling.js';
import type { BoardQuota, State } from '../src/types.js';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const MINUTE_MS = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const TASK = { itemId: 'item1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1' };
// `poll` stamps lastPolledAt with the real clock; the tests pin it against NOW instead
const readAt = (state: State, ms: number): State => ({ ...state, lastPolledAt: iso(ms) });
const free = readAt(initialState(1), NOW - POLL_INTERVAL_MS); // one empty slot, read 30 s ago
const busy = readAt(reduce(initialState(1), { type: 'poll', tasks: [TASK] }).state, NOW - POLL_INTERVAL_MS); // the only slot working
const quota = (remaining: number, resetsAt: number): BoardQuota => ({ limit: 5000, remaining, resetsAt: iso(resetsAt), at: iso(NOW) });

test('shouldPoll is true whenever a job could start, however fresh the last read', () => {
  assert.equal(POLL_INTERVAL_MS, 30_000);
  assert.equal(IDLE_POLL_INTERVAL_MS, 5 * MINUTE_MS);
  assert.equal(shouldPoll(free, NOW), true);
  assert.equal(shouldPoll(readAt(free, NOW), NOW), true, 'read this very instant: a free slot still wants the queue');
});

test('shouldPoll is false while nothing could start and the last read is recent; a stale or missing read polls anyway', () => {
  assert.equal(shouldPoll(busy, NOW), false, 'all occupied, read 30 s ago');
  assert.equal(shouldPoll(readAt(busy, NOW - IDLE_POLL_INTERVAL_MS), NOW), true, 'all occupied, read 5 min ago');
  assert.equal(shouldPoll(readAt(busy, NOW - IDLE_POLL_INTERVAL_MS + 1), NOW), false, 'one ms short of stale');
  assert.equal(shouldPoll({ ...busy, lastPolledAt: undefined }, NOW), true, 'never read');
  assert.equal(shouldPoll({ ...busy, lastPolledAt: 'garbage' }, NOW), true, 'an unparsable stamp reads as stale');
  assert.equal(shouldPoll({ ...free, signal: 'red' }, NOW), false, 'red with a free slot, read 30 s ago');
  assert.equal(shouldPoll({ ...free, signal: 'yellow' }, NOW), false);
  assert.equal(shouldPoll(readAt({ ...free, signal: 'red' }, NOW - IDLE_POLL_INTERVAL_MS), NOW), true, 'red, but the queue is 5 min old');
  const broke: State = { ...free, budget: { maxTokensPerHour: 100 }, usage: [{ at: iso(NOW - MINUTE_MS), tokens: 100 }] };
  assert.equal(shouldPoll(broke, NOW), false, 'no token budget left');
});

test('shouldPoll is false inside a quota backoff whatever else holds, and true again once the reset has passed', () => {
  assert.equal(QUOTA_RESERVE, 500);
  const soon = NOW + MINUTE_MS;
  assert.equal(shouldPoll({ ...free, boardQuota: quota(QUOTA_RESERVE - 1, soon) }, NOW), false, 'below the reserve with a free slot');
  const staleBusy = readAt(busy, NOW - IDLE_POLL_INTERVAL_MS);
  assert.equal(shouldPoll({ ...staleBusy, boardQuota: quota(0, soon) }, NOW), false, 'a stale read does not break the backoff');
  assert.equal(shouldPoll({ ...free, boardQuota: quota(QUOTA_RESERVE, soon) }, NOW), true, 'at the reserve is not below it');
  assert.equal(shouldPoll({ ...free, boardQuota: quota(QUOTA_RESERVE - 1, NOW - 1) }, NOW), true, 'reset in the past: the backoff lifts by itself');
  assert.equal(shouldPoll({ ...free, boardQuota: quota(QUOTA_RESERVE - 1, NOW) }, NOW), true, 'a reset right now counts as passed');
});

test('isBoardQuota accepts the read shape and rejects anything else', () => {
  const valid = quota(4320, NOW + MINUTE_MS);
  assert.equal(isBoardQuota(valid), true);
  assert.equal(isBoardQuota({ ...valid, remaining: 0 }), true, 'zero is a count');
  assert.equal(isBoardQuota({ ...valid, remaining: -1 }), false);
  assert.equal(isBoardQuota({ ...valid, limit: Infinity }), false);
  assert.equal(isBoardQuota({ ...valid, limit: '5000' }), false);
  assert.equal(isBoardQuota({ limit: 5000, remaining: 1, at: iso(NOW) }), false, 'resetsAt missing');
  assert.equal(isBoardQuota({ ...valid, resetsAt: 7 }), false);
  assert.equal(isBoardQuota({ ...valid, at: undefined }), false);
  for (const value of [undefined, null, 'x', 5, []]) assert.equal(isBoardQuota(value), false, String(value));
});
```

- [ ] **Step 2: Write the failing tests in `test/orchestrator.test.ts`**

Replace line 3 (the orchestrator import) with:

```ts
import { canSchedule, canStart, extractPrUrl, initialState, isBlocked, reduce, slugFor } from '../src/orchestrator.js';
```

Replace line 5 (the types import) with:

```ts
import type { BoardQuota, Budget, HookPayload, RateLimits, Signal, State, Task, UsageRule } from '../src/types.js';
```

After `const idled = (state: State, workerId: string, question: string) => reduce(state, { type: 'idle', workerId, question });` (line 40) add:

```ts
const QUOTA: BoardQuota = { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };
```

Append after the `rateLimits never mutates its input…` test (before `slugFor strips accents…`):

```ts
test('canSchedule is the fill gate: green with a free slot and budget; not under yellow, a reached cap or an exhausted budget', () => {
  const now = Date.now();
  assert.equal(canSchedule(initialState(1), now), true);
  assert.equal(canSchedule(filled(1, 1).state, now), false, 'all occupied');
  assert.equal(canSchedule(signaled(initialState(1), 'yellow').state, now), false);
  assert.equal(canSchedule(signaled(initialState(1), 'red').state, now), false);
  assert.equal(canSchedule(spent(1000, 0, { maxTokensPerHour: 1000 }), now), false, 'budget exhausted');
  assert.equal(canSchedule(spent(1000, 2 * HOUR_MS, { maxTokensPerHour: 1000 }), now), true, 'the sample left the hour');
  assert.equal(canSchedule(ruled(filled(2, 1).state, 550), now), false, '55%: cap 1 with one occupied');
  assert.equal(canSchedule(ruled(initialState(1), 850), now), false, '85%: dynamic yellow');
  assert.equal(canSchedule(ruled(initialState(1), 100), now), true, '10%: no rule applies');
});

test('boardQuota stores the reading, emits no effect and never fills, even with a free slot next to a queue', () => {
  const first = filled(1, 2).state; // one working, task 2 queued
  const roomy: State = { ...first, maxConcurrent: 2, slots: [...first.slots, { id: 'free', status: 'vazio' }] };
  const snapshot = JSON.stringify(roomy);
  const { state, effects } = reduce(roomy, { type: 'boardQuota', quota: QUOTA });
  assert.deepEqual(state.boardQuota, QUOTA);
  assert.equal(effects.length, 0, 'display and backoff only: no fill, no spawn');
  assert.equal(state.slots[1].status, 'vazio');
  assert.deepEqual(state.queue.map((t) => t.id), ['2']);
  assert.deepEqual({ ...state, boardQuota: undefined }, { ...roomy, boardQuota: undefined }, 'nothing else changes');
  assert.equal(JSON.stringify(roomy), snapshot, 'no mutation');
  const drained: BoardQuota = { ...QUOTA, remaining: 12, at: '2026-09-16T12:05:00.000Z' };
  assert.deepEqual(reduce(state, { type: 'boardQuota', quota: drained }).state.boardQuota, drained, 'the latest reading replaces the previous one');
  assert.deepEqual(reduce(state, { type: 'poll', tasks: tasks(2) }).state.boardQuota, QUOTA, 'a poll keeps the last reading');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `Cannot find module '../src/polling.js'`, `Module '"../src/types.js"' has no exported member 'BoardQuota'`, `Module '"../src/orchestrator.js"' has no exported member 'canSchedule'`.

- [ ] **Step 4: Edit `src/types.ts`**

After the `RateLimits` interface (its closing `}` on line 36) add:

```ts
/** GraphQL quota of the account the Hive polls with, as last read after a poll; `at` is when it was read. */
export interface BoardQuota {
  limit: number;
  remaining: number;
  resetsAt: string; // ISO
  at: string; // ISO
}
```

In `State`, after `  rateLimits?: RateLimits; // display only; absent until a worker's status line reports it` add:

```ts
  boardQuota?: BoardQuota; // last quota read after a poll; drives the timer backoff and the header meter, never a job
```

In `HiveEvent`, after `  | { type: 'rateLimits'; workerId: string; rateLimits: RateLimits }` add:

```ts
  | { type: 'boardQuota'; quota: BoardQuota }
```

- [ ] **Step 5: Edit `src/orchestrator.ts`**

After the `limits` function (its closing `}` on line 39) add:

```ts
/** Whether a job could start right now: token budget with balance and `canStart` under the effective signal and cap. */
export function canSchedule(state: State, now: number): boolean {
  const { signal, maxWorkers } = limits(state, now);
  return hasBudget(state.usage, state.budget, now) && canStart(signal, state.slots, maxWorkers);
}
```

In `reduce`, after `    case 'rateLimits': return setRateLimits(state, event.workerId, event.rateLimits); // display only: no fill, no effects` add:

```ts
    case 'boardQuota': return none({ ...state, boardQuota: event.quota }); // display and timer backoff only: no fill, no effects
```

In `fill`, replace the three lines

```ts
  const now = Date.now();
  const { signal, maxWorkers } = limits(state, now);
  if (!hasBudget(state.usage, state.budget, now)) return reduced; // no budget left: whatever happened stands, nothing new starts
```

with:

```ts
  const now = Date.now();
  if (!canSchedule(state, now)) return reduced; // nothing could start: whatever happened stands
  const { signal, maxWorkers } = limits(state, now);
```

- [ ] **Step 6: Create `src/polling.ts`**

```ts
import { canSchedule } from './orchestrator.js';
import type { BoardQuota, State } from './types.js';

export const POLL_INTERVAL_MS = 30_000;
export const IDLE_POLL_INTERVAL_MS = 5 * 60_000;
export const QUOTA_RESERVE = 500; // ponytail: fixed 10 % of the 5 000/h GraphQL quota, config it if a board ever needs another

// Below the reserve and before the reset: what is left goes to the workers' own gh calls (gh pr create…).
function inBackoff(state: State, now: number): boolean {
  const quota = state.boardQuota;
  return quota !== undefined && quota.remaining < QUOTA_RESERVE && Date.parse(quota.resetsAt) > now;
}

// A missing or unparsable stamp reads as stale: NaN fails the `<`.
const isStale = (state: State, now: number): boolean => !(now - Date.parse(state.lastPolledAt ?? '') < IDLE_POLL_INTERVAL_MS);

/** Whether a timer tick should hit the board: never inside a quota backoff; otherwise when a job could start or the last read is stale. */
export function shouldPoll(state: State, now: number): boolean {
  return !inBackoff(state, now) && (canSchedule(state, now) || isStale(state, now));
}

const isCount = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0;

/** The persisted shape, for state-store: a reopened Hive keeps backing off only on a reading it can trust. */
export function isBoardQuota(value: unknown): value is BoardQuota {
  if (typeof value !== 'object' || value === null) return false;
  const { limit, remaining, resetsAt, at } = value as BoardQuota;
  return isCount(limit) && isCount(remaining) && typeof resetsAt === 'string' && typeof at === 'string';
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test`
Expected: 212 tests PASS (`polling` 4, `orchestrator` 60; everything else unchanged — `fill` returns the same `reduced` reference where it used to rebuild an equal state, and every existing assertion on those paths is a `deepEqual`).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/polling.ts src/orchestrator.ts test/polling.test.ts test/orchestrator.test.ts
git commit -m "feat(polling): shouldPoll rule, canSchedule gate and the boardQuota event"
```

---

### Task 2: GitHub adapter `quota()` and the optional `Board.quota?` (TDD)

**Files:**
- Modify: `src/types.ts`, `src/boards/github.ts`
- Test: `test/board.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `Board.quota?(): Promise<BoardQuota | undefined>` — optional; only the GitHub adapter implements it
- Produces (in `src/boards/github.ts`):
  - private `readQuota(exec: Exec): Promise<BoardQuota | undefined>` — `exec(['api', 'rate_limit', '--jq', '.resources.graphql'])` → JSON `{ limit, remaining, reset }` (finite numbers, `reset` in epoch seconds) → `{ limit, remaining, resetsAt: ISO, at: now ISO }`; any other shape → `undefined`; a failing `gh` rejects (the server logs it)
  - `createGithubBoard(...)` returns `quota: () => readQuota(exec)` next to the four existing methods
- Consumed by: Task 4 (`board.quota?.()` in `refreshQuota`).

- [ ] **Step 1: Write the failing tests — append to `test/board.test.ts`**

```ts
test('quota reads gh api rate_limit for the graphql resource and converts reset (epoch seconds) to ISO', async () => {
  const { exec, calls } = fakeExec({ 'api rate_limit --jq': { limit: 5000, used: 680, remaining: 4320, reset: 1789563600 } });
  const before = Date.now();
  const quota = await createBoard(config, { repo: REPO, exec }).quota!();
  assert.deepEqual(calls, [['api', 'rate_limit', '--jq', '.resources.graphql']]);
  assert.equal(quota?.limit, 5000);
  assert.equal(quota?.remaining, 4320);
  assert.equal(quota?.resetsAt, '2026-09-16T13:00:00.000Z');
  assert.ok(quota && Date.parse(quota.at) >= before && Date.parse(quota.at) <= Date.now(), 'at is when it was read');
});

test('quota is undefined for an unexpected shape, and a markdown board has no quota at all', async () => {
  const shapes: unknown[] = [
    null, 5, {}, { limit: '5000', remaining: 1, reset: 1789563600 }, { limit: 5000, remaining: 1 },
    { limit: 5000, remaining: 1, reset: 'soon' }, { limit: 5000, remaining: null, reset: 1789563600 },
  ];
  for (const shape of shapes) {
    const { exec } = fakeExec({ 'api rate_limit --jq': shape });
    assert.equal(await createBoard(config, { repo: REPO, exec }).quota!(), undefined, JSON.stringify(shape));
  }
  await assert.rejects(createBoard(config, { repo: REPO, exec: fakeExec({}).exec }).quota!(), /unexpected gh call/, 'a failing gh rejects: the server logs it');
  assert.equal(createBoard(parseConfig({ board: { type: 'markdown', path: 'board.md' } }), { repo: REPO }).quota, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error — `Property 'quota' does not exist on type 'Board'`.

- [ ] **Step 3: Edit `src/types.ts`**

In `Board`, after `  setupOptions(): Promise<string[]>; // status values available, for the setup form` add:

```ts
  quota?(): Promise<BoardQuota | undefined>; // the polling account's API quota; a board without one (markdown) leaves it out
```

- [ ] **Step 4: Edit `src/boards/github.ts`**

Replace line 3 (the types import) with:

```ts
import type { Board, BoardConfig, BoardQuota, ProjectSummary, StatusKey, Task } from '../types.js';
```

After `const RELATION_LIMIT = 50; // ponytail: …` add:

```ts
const MS_PER_SECOND = 1000;
```

After `type GhRelationsData = …;` (line 38) add:

```ts
interface GhRateLimit { limit?: unknown; remaining?: unknown; reset?: unknown }
```

After the `withBlockers` function (its closing `}` on line 94) add:

```ts
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// `gh api rate_limit` does not count against the quota; `reset` comes in epoch seconds. Any other shape → undefined, nothing dispatched.
async function readQuota(exec: Exec): Promise<BoardQuota | undefined> {
  const parsed = JSON.parse(await exec(['api', 'rate_limit', '--jq', '.resources.graphql'])) as GhRateLimit | null;
  const { limit, remaining, reset } = parsed ?? {};
  if (!isCount(limit) || !isCount(remaining) || !isCount(reset)) return undefined;
  return { limit, remaining, resetsAt: new Date(reset * MS_PER_SECOND).toISOString(), at: new Date().toISOString() };
}
```

Replace the last line of `createGithubBoard`

```ts
  return { resolveFields, listQueue, setStatus, setupOptions };
```

with:

```ts
  return { resolveFields, listQueue, setStatus, setupOptions, quota: () => readQuota(exec) };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 214 tests PASS (`board` 14). `fakeBoardFactory` and the markdown adapter still return four methods, which `Board` accepts because `quota` is optional.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/boards/github.ts test/board.test.ts
git commit -m "feat(boards): github quota() from gh api rate_limit; Board.quota is optional"
```

---

### Task 3: `state-store` keeps a valid `boardQuota` (TDD)

**Files:**
- Modify: `src/state-store.ts`
- Test: `test/state-store.test.ts`

**Interfaces:**
- Produces (in `src/state-store.ts`): `normalize` keeps `boardQuota` only when `isBoardQuota(parsed.boardQuota)`; otherwise the key is absent (not `undefined`), as with `rateLimits`.
- Consumes: `isBoardQuota` from Task 1.
- Consumed by: Task 4 (`configure` loads the saved state, so a Hive reopened mid-backoff keeps backing off until the reset).

- [ ] **Step 1: Write the failing test — append to `test/state-store.test.ts`**

```ts
test('loadState keeps a valid boardQuota and drops one with the wrong shape, leaving the key absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const boardQuota = { limit: 5000, remaining: 320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };
  await saveState(dir, { ...initialState(1), boardQuota });
  assert.deepEqual((await loadState(dir, 1)).boardQuota, boardQuota);
  const bad: unknown[] = [
    5, 'x', null, [], { ...boardQuota, remaining: -1 }, { ...boardQuota, limit: 'x' }, { ...boardQuota, resetsAt: undefined },
    { ...boardQuota, at: 7 },
  ];
  for (const value of bad) {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...initialState(1), boardQuota: value }));
    assert.equal('boardQuota' in (await loadState(dir, 1)), false, JSON.stringify(value));
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: the new test fails on the first bad value (`5` is kept as is).

- [ ] **Step 3: Edit `src/state-store.ts`**

After `import { isRateLimits } from './rate-limits.js';` add:

```ts
import { isBoardQuota } from './polling.js';
```

Replace `normalize` with:

```ts
// Files written before the signal or the budget existed lack these fields; anything unknown reads as the default.
function normalize(parsed: State): State {
  const { rateLimits, boardQuota, ...rest } = parsed;
  return {
    ...rest,
    signal: isSignal(parsed.signal) ? parsed.signal : 'green',
    usage: Array.isArray(parsed.usage) ? parsed.usage.filter(isSample) : [],
    budget: parsed.budget ?? {},
    usageRules: Array.isArray(parsed.usageRules) ? parsed.usageRules.filter(isRule) : [],
    ...(isRateLimits(rateLimits) ? { rateLimits } : {}), // wrong shape or legacy file: no key at all, the header shows nothing
    ...(isBoardQuota(boardQuota) ? { boardQuota } : {}), // kept so a Hive reopened mid-backoff keeps backing off until the reset
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 215 tests PASS (`state-store` 8). `saveState then loadState round-trips` stays green: a state without `boardQuota` normalizes without the key. No import cycle: `state-store` → `polling` → `orchestrator`, and `orchestrator` imports neither.

- [ ] **Step 5: Commit**

```bash
git add src/state-store.ts test/state-store.test.ts
git commit -m "feat(state-store): keep a valid boardQuota across restarts"
```

---

### Task 4: Server — quota after every poll, timer through `shouldPoll` (TDD)

**Files:**
- Modify: `src/server.ts`, `test/fakes.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Produces (in `src/server.ts`):
  - `POLL_INTERVAL_MS` imported from `./polling.js` (the local constant is deleted)
  - private `refreshQuota(board: Board): Promise<void>` — `await board.quota?.()`; a reading → `dispatch({ type: 'boardQuota', quota })`; a throw → `console.error('board.quota: …')`, nothing dispatched
  - `poll()` unchanged, plus `await refreshQuota(runtime.board)` after the try/catch (runs on success and on a `listQueue` failure)
  - private `tick(): Promise<void>` — `if (live && shouldPoll(live.state, Date.now())) await poll()`; the timer calls it
- Produces (in `test/fakes.ts`): `fakeBoardFactory(resolveDelayMs = 0, quota?: BoardQuota)` — with `quota`, the board gains `quota: async () => quota`; without it, the board is exactly as today
- Consumes: `shouldPoll`, `POLL_INTERVAL_MS`, the event (Task 1); `Board.quota?` (Task 2); `normalize` (Task 3).

- [ ] **Step 1: Edit `test/fakes.ts`**

Replace line 2 (the types import) with:

```ts
import type { Board, BoardQuota, Config, SpawnWorker, WorkerHandlers, WorkerLaunch } from '../src/types.js';
```

Replace the `fakeBoardFactory` signature and comment (lines 42–44) with:

```ts
// A board that has the OPTIONS columns and returns one task named after the configured queue column.
// `resolveDelayMs` makes resolveFields slow so concurrent saves overlap; `quota` gives it a fixed quota reading (none by default, like markdown).
export function fakeBoardFactory(resolveDelayMs = 0, quota?: BoardQuota): { factory: (config: Config) => Board; configs: Config[] } {
```

Replace the last two lines of the returned board object

```ts
      async setupOptions() {
        return OPTIONS;
      },
    };
```

with:

```ts
      async setupOptions() {
        return OPTIONS;
      },
      ...(quota ? { quota: async () => quota } : {}),
    };
```

- [ ] **Step 2: Write the failing test — in `test/server.test.ts`**

Replace line 12 (the types import) with:

```ts
import type { BoardQuota, SetupBody, Slot, State } from '../src/types.js';
```

After `const line = (worker: FakeWorker, payload: unknown): void => worker.handlers.onLine(JSON.stringify(payload));` (line 27) add:

```ts
const QUOTA: BoardQuota = { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };
```

Append after the `close() kills every live worker…` test:

```ts
test('every poll reads the board quota afterwards and persists it; a board without quota stores nothing', async (t) => {
  const { base, server } = await start(t);
  assert.equal(server.getState()?.boardQuota, undefined, 'the default fake has no quota, like markdown');
  assert.deepEqual(await json(postJson(`${base}/board/refresh`)), { ok: true });
  assert.equal(server.getState()?.boardQuota, undefined);
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const withQuota = createServer({ repo, boardFactory: fakeBoardFactory(0, QUOTA).factory, spawnWorker: fakeSpawn().spawn });
  const port = await withQuota.listen(0);
  t.after(() => withQuota.close());
  assert.equal((await postJson(`http://127.0.0.1:${port}/setup`, BODY)).status, 200); // configure polls: the quota is read at boot
  assert.deepEqual(withQuota.getState()?.boardQuota, QUOTA);
  await withQuota.dispatch({ type: 'boardQuota', quota: { ...QUOTA, remaining: 1 } }); // overwrite, so the refresh below proves a re-read
  assert.deepEqual(await json(postJson(`http://127.0.0.1:${port}/board/refresh`)), { ok: true });
  assert.deepEqual(withQuota.getState()?.boardQuota, QUOTA, 'read again after the manual poll');
  const saved = JSON.parse(await readFile(join(repo, '.hive', 'state.json'), 'utf8')) as State;
  assert.deepEqual(saved.boardQuota, QUOTA, 'persisted with the rest of the state');
  assert.equal(withQuota.getState()?.error, undefined);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: the new test fails at `assert.deepEqual(withQuota.getState()?.boardQuota, QUOTA)` (`undefined`: nothing reads the quota yet).

- [ ] **Step 4: Edit `src/server.ts`**

After `import { reduce, SIGNALS } from './orchestrator.js';` add:

```ts
import { POLL_INTERVAL_MS, shouldPoll } from './polling.js';
```

Delete line 24:

```ts
const POLL_INTERVAL_MS = 30_000;
```

Replace `poll` (lines 194–203) with:

```ts
  async function poll(): Promise<void> {
    const runtime = live?.runtime;
    if (!runtime) return;
    try {
      const tasks = await runtime.board.listQueue();
      await dispatch({ type: 'poll', tasks });
    } catch (err) {
      await fail('board.listQueue', err);
    }
    await refreshQuota(runtime.board); // after every real poll, success or failure: the reset time matters most when the limit just hit
  }

  // Diagnostic only: a failed read is logged and never masks the board error or drops the poll.
  async function refreshQuota(board: Board): Promise<void> {
    try {
      const quota = await board.quota?.();
      if (quota) await dispatch({ type: 'boardQuota', quota });
    } catch (err) {
      console.error(`board.quota: ${errorMessage(err)}`);
    }
  }

  // Only the timer asks shouldPoll; /board/refresh, configure, reconfigure and boot always poll: whoever asked wants the answer now.
  async function tick(): Promise<void> {
    if (live && shouldPoll(live.state, Date.now())) await poll();
  }
```

In `listen`, replace

```ts
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS); // no-op until configured
```

with:

```ts
    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS); // no-op until configured
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 216 tests PASS (`server` 12). `setup` stays at 24: its fake board has no `quota`, and the timer never fires inside a test.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/fakes.ts test/server.test.ts
git commit -m "feat(server): read the board quota after every poll; timer ticks go through shouldPoll"
```

---

### Task 5: Header `#quota` (manual check)

**Files:**
- Modify: `src/ui/app.ts`, `src/ui/index.html`

**Interfaces:**
- Produces (in `src/ui/app.ts`): `QUOTA_RESERVE` mirror; `renderQuota(quota?: BoardQuota)` called from `render` after `renderLimits`
- Produces (in `src/ui/index.html`): `<span id="quota" class="dash"></span>` after `#limits`; `#quota { color: var(--muted); }`, `#quota.low { color: var(--danger); }`
- Consumes: `State.boardQuota` (Task 1) as streamed by `/events`.

Note: `fmt` is the k/M shortener (`4.3k/5.0k`); the spec's display example is `GitHub 4.320/5.000`, so the plan renders with `toLocaleString('pt-BR')`.

- [ ] **Step 1: Edit `src/ui/app.ts`**

Replace the types import (lines 1–4) with:

```ts
import type {
  BoardConfig, BoardQuota, Budget, EventsPayload, ProjectSummary, RateLimits, SetupBody, SetupInfo, SetupResult, Signal, Slot, State,
  StatusKey, Task, UsageSample, WorkersMode,
} from '../types.js';
```

After `const PERCENT_MAX = 100;` add:

```ts
// Mirrors src/polling.ts, which cannot be imported here (it pulls the orchestrator into the browser).
const QUOTA_RESERVE = 500;
```

After `renderLimits` (its closing `}` on line 235) add:

```ts
// Numbers and a Date: nothing to escape. Empty without a reading (markdown board, or no poll yet).
function renderQuota(quota?: BoardQuota): void {
  const el = $('quota');
  el.classList.toggle('low', quota !== undefined && quota.remaining < QUOTA_RESERVE);
  el.textContent = quota
    ? `GitHub ${quota.remaining.toLocaleString('pt-BR')}/${quota.limit.toLocaleString('pt-BR')} · reseta ${clock(quota.resetsAt)}`
    : '';
}
```

In `render`, after `  renderLimits(state.rateLimits);` add:

```ts
  renderQuota(state.boardQuota);
```

- [ ] **Step 2: Edit `src/ui/index.html`**

After `  #limits { color: var(--muted); }` add:

```css
  #quota { color: var(--muted); }
  #quota.low { color: var(--danger); }
```

After `  <span id="limits" class="dash"></span>` add:

```html
  <span id="quota" class="dash"></span>
```

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `pnpm test`
Expected: 216 tests PASS (the build includes `app.ts`; no test touches the UI).

- [ ] **Step 4: Acceptance per the spec's "Testes → Manual" (manual, GitHub board)**

1. `pnpm start <repo>` with a GitHub board. After the boot poll the header shows `GitHub N/5.000 · reseta HH:MM` after the plan-limits span, in muted color; `cat <repo>/.hive/state.json` has `boardQuota` with `limit`, `remaining`, `resetsAt`, `at`.
2. Set `máx. workers` so every slot is occupied (or set the signal to red with an empty queue). `board: HH:MM` in the header now advances only every 5 min instead of every 30 s; the "atualizar board" button advances it right away and `GitHub N/5.000` drops by the poll's cost.
3. Free a slot (kill a worker, or set the signal back to green): the next tick polls within 30 s.
4. Close the Hive. In `.hive/state.json` set `boardQuota.remaining` to `12` and `boardQuota.resetsAt` to an ISO instant ~10 min ahead; reopen. The header shows `GitHub 12/5.000 · reseta HH:MM` in red; boot always polls, which re-reads the real quota and lifts the fake backoff.
5. Switch to a markdown board: the `#quota` span is empty, nothing breaks; the last GitHub reading stays in `state.json` harmlessly (a past `resetsAt` lifts any backoff). The signal buttons, `máx. workers`, the token meter and the plan limits behave exactly as before.
6. `pnpm test`: 216 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/app.ts src/ui/index.html
git commit -m "feat(ui): GitHub quota and reset time in the dashboard header"
```
