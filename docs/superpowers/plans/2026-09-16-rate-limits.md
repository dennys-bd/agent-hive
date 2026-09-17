# Agent Hive — limites do plano (sessão / semana) na tela inicial: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard header shows the Claude plan limits that `/usage` shows in Claude Code — the 5 h window ("sessão") and the weekly one — as percent used and reset time, next to item 5's token meter, and the worker's own status line shows the same summary (`sessão 23% · semana 41%`). Claude Code exposes those limits only in the JSON it pipes to the status line command, so the `.hive/hooks.json` the Hive already hands to every worker gains a `statusLine` whose command posts that JSON to a new `POST /hooks/status`. The server keeps only `rate_limits`, validated through a pure `parseRateLimits`, and dispatches a `rateLimits` event; the reducer stores it when it comes from a live worker and does nothing else. Any window Claude Code sends (`five_hour`, `seven_day`, a hypothetical `seven_day_fable`) is rendered under a label derived from its key. Signal, budget and usage rules are untouched: this item only displays.

**Architecture:** `src/rate-limits.ts` (new, pure, no `node:*` / orchestrator import) holds `MAX_WINDOWS`, `parseRateLimits(body, now)` (key `/^[a-z][a-z0-9_]{0,31}$/`, at most 8 windows, `used_percentage` finite ≥ 0, `resets_at` positive integer epoch seconds → ISO; no surviving window → `undefined`), `isRateLimits` (persisted shape, for `state-store`), `windowLabel` and `formatRateLimits` (the status line text). `types.ts` gains `RateLimitWindow`, `RateLimits`, `State.rateLimits?` and the `rateLimits` event. `hooks-settings.ts` gains `statusCommand(port)` next to `hookCommand` (same `curl`, but printing the reply instead of discarding it) and `renderHooksSettings` returns `{ hooks, statusLine }`. `reduce` gains the `rateLimits` case: `{ ...state, rateLimits }` when `workerId` sits in an occupied slot, otherwise the same state; no effects, no `fill`. `normalize` in `state-store.ts` keeps `rateLimits` only when `isRateLimits` holds. `server.ts` gains `POST /hooks/status`: `text/plain`, always 200, empty body without `x-hive-worker` or a valid window, otherwise the line from the parsed payload and a `rateLimits` dispatch. `app.ts` gains `renderLimits` (label + `<meter>` + `reseta HH:MM` per window, `· às HH:MM` at the end) and `index.html` a `#limits` span styled like `#usage`.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-16-rate-limits-design.md` (extends `docs/superpowers/specs/2026-09-16-token-budget-design.md` and `docs/superpowers/specs/2026-09-15-agent-hive-design.md`; card: issue #13).

## Global Constraints

- All v1, setup, boards, signal, budget and usage-rules constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts`, `run.ts`, `hive.ts`, `spawn.ts`, `board.ts`, `config.ts`, `usage.ts`, `usage-rules.ts` and `src/boards/*` do not change. No config field, no setup-form field, no `SetupBody` field: `rateLimits` lives only in `State` (and therefore in `state.json`).
- `src/rate-limits.ts` is pure (no `node:*`, no orchestrator import). `parseRateLimits` is the single validation point and the only thing the server hands the reducer; the status line body is never stored, logged or echoed beyond the summary line.
- `fill`, `canStart`, `hasBudget`, `limits` and the usage rules never read `state.rateLimits`; the `rateLimits` reducer branch never calls `fill`, never emits an effect and never touches a slot. Every other reducer result is identical to item 6.
- `POST /hooks/status` always answers 200 `text/plain`, answers before dispatching (as `/hooks/event` does), requires `x-hive-worker`, and computes the line from the parsed payload, not from `State`.
- `src/ui/app.ts` cannot import `src/rate-limits.ts` (the served module graph only has `app.js`): the label rule is mirrored there under the same "Mirrors src/…" comment convention used for `usageTotals`. UI times use `toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })`.
- ESM with `.js` import extensions; no new runtime dependencies; source files under 400 lines, functions under 50 lines. Code comments in English.
- `test/setup.test.ts` keeps its fake factory and `maxConcurrent: 0`, so nothing spawns.
- `pnpm test` must stay green after every task (153 tests today → 167 at the end).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `RateLimitWindow`, `RateLimits`; `State.rateLimits?`; `rateLimits` event |
| `src/rate-limits.ts` (new) | `MAX_WINDOWS`, `parseRateLimits`, `isRateLimits`, `windowLabel`, `formatRateLimits` — pure |
| `src/hooks-settings.ts` | private `postStdin(port, path)`, `statusCommand(port)`, `renderHooksSettings` returns `{ hooks, statusLine }` |
| `src/orchestrator.ts` | `rateLimits` case in `reduce`, private `setRateLimits` |
| `src/state-store.ts` | `normalize` keeps `rateLimits` only when `isRateLimits` |
| `src/server.ts` | `POST /hooks/status` |
| `src/ui/app.ts` | `WINDOW_LABEL` mirror, `windowLabel`, `clock`, `renderLimits`, called from `render` |
| `src/ui/index.html` | `<span id="limits" class="dash">` after `#usage`, `#limits` style |
| `test/rate-limits.test.ts` (new) | docs example, extra window, dropped windows, cap at 8, `undefined` cases, `formatRateLimits` + `windowLabel`, `isRateLimits` (+7) |
| `test/hooks-settings.test.ts` | `statusCommand` and `statusLine` (+1 → 5) |
| `test/orchestrator.test.ts` | occupied worker stores / no effect / no fill; unknown worker; no mutation + survives other events (+3 → 57) |
| `test/state-store.test.ts` | valid `rateLimits` kept; invalid shapes dropped (+2 → 7) |
| `test/setup.test.ts` | `POST /hooks/status` line / empty / unknown worker (+1 → 23) |

---

### Task 1: Types and the pure module — `src/rate-limits.ts` (TDD)

**Files:**
- Modify: `src/types.ts`
- Create: `src/rate-limits.ts`
- Test: `test/rate-limits.test.ts` (new)

**Interfaces:**
- Produces (in `src/types.ts`):
  - `interface RateLimitWindow { usedPercent: number; resetsAt: string }` — `resetsAt` ISO
  - `interface RateLimits { at: string; windows: Record<string, RateLimitWindow> }` — `at` ISO, when the reading arrived
  - `State.rateLimits?: RateLimits`
  - `HiveEvent` gains `{ type: 'rateLimits'; workerId: string; rateLimits: RateLimits }`
- Produces (in `src/rate-limits.ts`):
  - `MAX_WINDOWS = 8`
  - `parseRateLimits(body: unknown, now: Date): RateLimits | undefined` — reads `body.rate_limits`; key must match `/^[a-z][a-z0-9_]{0,31}$/`; `used_percentage` finite number ≥ 0; `resets_at` positive integer in epoch seconds → `new Date(resets_at * 1000).toISOString()`; a window missing either is dropped; first 8 survivors kept in payload order; none → `undefined`
  - `isRateLimits(value: unknown): value is RateLimits` — `at` string, `windows` plain object, every window with finite `usedPercent` and string `resetsAt`
  - `windowLabel(key: string): string` — `five_hour` → `sessão`, `seven_day` → `semana`, `seven_day_<x>` → `semana <x>`, else the key with `_` → space (so `spend_limit` → `spend limit`)
  - `formatRateLimits(limits: RateLimits): string` — `"sessão 23% · semana 41%"`, percent through `Math.round`
- Consumed by: Task 3 (`isRateLimits`, `RateLimits`, the event), Task 4 (`parseRateLimits`, `formatRateLimits`).

- [ ] **Step 1: Write the failing tests — create `test/rate-limits.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRateLimits, isRateLimits, MAX_WINDOWS, parseRateLimits, windowLabel } from '../src/rate-limits.js';
import type { RateLimits } from '../src/types.js';

const NOW = new Date('2026-09-16T12:00:00.000Z');
// The example from the Claude Code status line docs: resets_at in epoch seconds
const FIVE_HOUR = { used_percentage: 23.4, resets_at: 1759744800 };
const SEVEN_DAY = { used_percentage: 41, resets_at: 1760263200 };
const DOCS = { rate_limits: { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY } };
const PARSED: RateLimits = {
  at: '2026-09-16T12:00:00.000Z',
  windows: {
    five_hour: { usedPercent: 23.4, resetsAt: '2025-10-06T10:00:00.000Z' },
    seven_day: { usedPercent: 41, resetsAt: '2025-10-12T10:00:00.000Z' },
  },
};

test('parseRateLimits reads the docs example into two windows with ISO resets and stamps the arrival time', () => {
  assert.deepEqual(parseRateLimits(DOCS, NOW), PARSED);
  assert.equal(parseRateLimits(DOCS, NOW)?.at, NOW.toISOString());
});

test('parseRateLimits keeps any extra window under its own key', () => {
  const body = { rate_limits: { ...DOCS.rate_limits, seven_day_fable: { used_percentage: 7, resets_at: 1760263200 } } };
  const parsed = parseRateLimits(body, NOW);
  assert.deepEqual(Object.keys(parsed?.windows ?? {}), ['five_hour', 'seven_day', 'seven_day_fable']);
  assert.deepEqual(parsed?.windows.seven_day_fable, { usedPercent: 7, resetsAt: '2025-10-12T10:00:00.000Z' });
});

test('parseRateLimits drops a window with a bad key, a non-numeric used_percentage or a missing resets_at', () => {
  const body = {
    rate_limits: {
      ...DOCS.rate_limits,
      'Five-Hour': FIVE_HOUR,
      '9lives': FIVE_HOUR,
      ['a'.repeat(33)]: FIVE_HOUR,
      text: { used_percentage: '23', resets_at: 1759744800 },
      negative: { used_percentage: -1, resets_at: 1759744800 },
      no_reset: { used_percentage: 5 },
      zero_reset: { used_percentage: 5, resets_at: 0 },
      fraction: { used_percentage: 5, resets_at: 1.5 },
      nothing: null,
      number: 7,
    },
  };
  assert.deepEqual(parseRateLimits(body, NOW), PARSED);
  const onlyBad = { rate_limits: { five_hour: { used_percentage: '23', resets_at: 1759744800 } } };
  assert.equal(parseRateLimits(onlyBad, NOW), undefined, 'no valid window: nothing to dispatch');
});

test('parseRateLimits keeps at most MAX_WINDOWS windows, in payload order', () => {
  assert.equal(MAX_WINDOWS, 8);
  const rate_limits = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`w${i}`, FIVE_HOUR]));
  const windows = parseRateLimits({ rate_limits }, NOW)?.windows ?? {};
  assert.deepEqual(Object.keys(windows), Array.from({ length: MAX_WINDOWS }, (_, i) => `w${i}`));
});

test('parseRateLimits is undefined without rate_limits or for a body that is not an object', () => {
  const bodies: unknown[] = [undefined, null, 'x', 5, [], {}, { rate_limits: null }, { rate_limits: [] }, { rate_limits: 'x' }, { rate_limits: {} }];
  for (const body of bodies) assert.equal(parseRateLimits(body, NOW), undefined, String(JSON.stringify(body)));
});

test('formatRateLimits is the status line — label, rounded percent, dot-separated — and windowLabel names every key', () => {
  assert.equal(formatRateLimits(PARSED), 'sessão 23% · semana 41%');
  const fable: RateLimits = { at: PARSED.at, windows: { ...PARSED.windows, seven_day_fable: { usedPercent: 99.5, resetsAt: PARSED.at } } };
  assert.equal(formatRateLimits(fable), 'sessão 23% · semana 41% · semana fable 100%');
  assert.equal(windowLabel('five_hour'), 'sessão');
  assert.equal(windowLabel('seven_day'), 'semana');
  assert.equal(windowLabel('seven_day_fable'), 'semana fable');
  assert.equal(windowLabel('seven_day_opus'), 'semana opus');
  assert.equal(windowLabel('spend_limit'), 'spend limit');
  assert.equal(windowLabel('constructor'), 'constructor', 'an inherited property name is not a label');
});

test('isRateLimits accepts the parsed shape and rejects anything else', () => {
  assert.equal(isRateLimits(PARSED), true);
  assert.equal(isRateLimits({ at: PARSED.at, windows: {} }), true, 'no window is still the shape');
  const withWindow = (window: unknown): unknown => ({ at: PARSED.at, windows: { five_hour: window } });
  assert.equal(isRateLimits(withWindow({ usedPercent: 1, resetsAt: 7 })), false, 'resetsAt must be a string');
  assert.equal(isRateLimits(withWindow({ usedPercent: '1', resetsAt: 'x' })), false);
  assert.equal(isRateLimits(withWindow({ resetsAt: 'x' })), false);
  assert.equal(isRateLimits(withWindow(null)), false);
  assert.equal(isRateLimits({ at: 5, windows: {} }), false);
  assert.equal(isRateLimits({ at: PARSED.at, windows: [] }), false);
  assert.equal(isRateLimits({ at: PARSED.at }), false);
  for (const value of [undefined, null, 'x', 5, []]) assert.equal(isRateLimits(value), false, String(value));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `Cannot find module '../src/rate-limits.js'`, `Module '"../src/types.js"' has no exported member 'RateLimits'`.

- [ ] **Step 3: Edit `src/types.ts`**

After the `UsageLimits` interface add:

```ts
export interface RateLimitWindow {
  usedPercent: number;
  resetsAt: string; // ISO
}

/** Plan limits as last seen in a worker's status line; `at` is when the reading arrived, not a live value. */
export interface RateLimits {
  at: string; // ISO
  windows: Record<string, RateLimitWindow>; // keyed as Claude Code sends them: five_hour, seven_day, …
}
```

In `State`, after `  usageRules: UsageRule[]; // …` add:

```ts
  rateLimits?: RateLimits; // display only; absent until a worker's status line reports it
```

In `HiveEvent`, after `  | { type: 'setUsageRules'; usageRules: UsageRule[] }` add:

```ts
  | { type: 'rateLimits'; workerId: string; rateLimits: RateLimits }
```

- [ ] **Step 4: Create `src/rate-limits.ts`**

```ts
import type { RateLimits, RateLimitWindow } from './types.js';

export const MAX_WINDOWS = 8;
// Claude Code names windows like five_hour / seven_day; the key becomes a State key and a UI label, so it is kept to this.
const WINDOW_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const MS_PER_SECOND = 1000;
const WEEKLY_PREFIX = 'seven_day_';
const LABELS: Record<string, string> = { five_hour: 'sessão', seven_day: 'semana' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// `used_percentage` is a finite number from 0; `resets_at` is a positive integer in epoch seconds. Anything else drops the window.
function parseWindow(raw: unknown): RateLimitWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { used_percentage: usedPercent, resets_at: resetsAt } = raw;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt) || resetsAt <= 0) return undefined;
  const reset = new Date(resetsAt * MS_PER_SECOND);
  return Number.isNaN(reset.getTime()) ? undefined : { usedPercent, resetsAt: reset.toISOString() }; // past the Date range: invalid
}

/** `body.rate_limits` of a status line JSON → the persisted shape, or nothing when no window survives (then nothing is dispatched). */
export function parseRateLimits(body: unknown, now: Date): RateLimits | undefined {
  if (!isRecord(body) || !isRecord(body.rate_limits)) return undefined;
  const entries = Object.entries(body.rate_limits)
    .filter(([key]) => WINDOW_KEY.test(key))
    .flatMap<[string, RateLimitWindow]>(([key, raw]) => {
      const window = parseWindow(raw);
      return window ? [[key, window]] : [];
    })
    .slice(0, MAX_WINDOWS); // any local process can post here: the State never grows past this
  return entries.length === 0 ? undefined : { at: now.toISOString(), windows: Object.fromEntries(entries) };
}

const isWindow = (value: unknown): value is RateLimitWindow =>
  isRecord(value) && Number.isFinite(value.usedPercent) && typeof value.resetsAt === 'string';

/** The persisted shape, for state-store: a hand-edited state.json never feeds the UI garbage. */
export function isRateLimits(value: unknown): value is RateLimits {
  return isRecord(value) && typeof value.at === 'string' && isRecord(value.windows) && Object.values(value.windows).every(isWindow);
}

/** five_hour → sessão, seven_day → semana, seven_day_<x> → semana <x>; anything else reads as its key with spaces. */
export function windowLabel(key: string): string {
  if (Object.hasOwn(LABELS, key)) return LABELS[key]; // hasOwn: "constructor" must not resolve to Object's
  if (key.startsWith(WEEKLY_PREFIX)) return `semana ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
}

/** The line the worker's status line shows: "sessão 23% · semana 41%". */
export function formatRateLimits(limits: RateLimits): string {
  return Object.entries(limits.windows)
    .map(([key, window]) => `${windowLabel(key)} ${Math.round(window.usedPercent)}%`)
    .join(' · ');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 160 tests PASS (`rate-limits` 7; everything else unchanged — `State.rateLimits` is optional and no reducer branch handles the event yet, which `tsc` accepts because `reduce`'s `switch` has no exhaustiveness `never` check; Task 3 adds the case).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/rate-limits.ts test/rate-limits.test.ts
git commit -m "feat(rate-limits): parse, validate and format the plan limits from the status line"
```

---

### Task 2: `hooks-settings.ts` — `statusCommand` and the `statusLine` in `.hive/hooks.json` (TDD)

**Files:**
- Modify: `src/hooks-settings.ts`
- Test: `test/hooks-settings.test.ts`

**Interfaces:**
- Produces (in `src/hooks-settings.ts`):
  - private `postStdin(port, path): string` — the `curl -s -m 2 -X POST http://127.0.0.1:<port><path> -H "x-hive-worker: $HIVE_WORKER_ID" -H 'content-type: application/json' -d @-` shared by both commands
  - `hookCommand(port)` — unchanged text: `postStdin(port, '/hooks/event') + ' >/dev/null; exit 0'`
  - `statusCommand(port): string` — `postStdin(port, '/hooks/status') + '; exit 0'`; no `>/dev/null`, the reply is what the worker's status line prints
  - `renderHooksSettings(port): { hooks: Record<string, unknown[]>; statusLine: { type: 'command'; command: string } }`
- Consumed by: `prepareHiveDir` (already writes `renderHooksSettings(port)`; nothing else changes), Task 4 (the route the command targets).

Note: the existing `renderHooksSettings registers every lifecycle event` test compares `Object.keys(settings.hooks)`, so the sibling `statusLine` key keeps it green; `prepareHiveDir` deep-equals the written file with `renderHooksSettings`, also fine.

- [ ] **Step 1: Write the failing test — in `test/hooks-settings.test.ts`**

Replace line 6 (the import) with:

```ts
import { HOOK_EVENTS, hookCommand, prepareHiveDir, renderHooksSettings, statusCommand } from '../src/hooks-settings.js';
```

Append after the `renderHooksSettings registers every lifecycle event…` test:

```ts
test('statusCommand posts the status line JSON to /hooks/status, prints the reply and never fails; renderHooksSettings ships it as statusLine', () => {
  const cmd = statusCommand(4242);
  assert.match(cmd, /curl -s -m 2 -X POST http:\/\/127\.0\.0\.1:4242\/hooks\/status/);
  assert.match(cmd, /-H "x-hive-worker: \$HIVE_WORKER_ID"/);
  assert.match(cmd, /-d @-; exit 0$/);
  assert.doesNotMatch(cmd, />\/dev\/null/, 'the reply is the line the worker shows');
  assert.deepEqual(renderHooksSettings(4242).statusLine, { type: 'command', command: cmd });
  assert.equal(hookCommand(4242).endsWith('>/dev/null; exit 0'), true, 'hooks still discard the reply');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error — `Module '"../src/hooks-settings.js"' has no exported member 'statusCommand'`.

- [ ] **Step 3: Edit `src/hooks-settings.ts`**

Replace `hookCommand` and `renderHooksSettings` (lines 9–27) with:

```ts
function postStdin(port: number, path: string): string {
  return [
    `curl -s -m 2 -X POST http://127.0.0.1:${port}${path}`,
    `-H "x-hive-worker: $HIVE_WORKER_ID"`,
    `-H 'content-type: application/json'`,
    `-d @-`,
  ].join(' ');
}

export function hookCommand(port: number): string {
  return `${postStdin(port, '/hooks/event')} >/dev/null; exit 0`;
}

/** The worker's status line: the Hive replies with the plan limits summary, which is what the worker's tab shows. */
export function statusCommand(port: number): string {
  return `${postStdin(port, '/hooks/status')}; exit 0`;
}

export function renderHooksSettings(port: number): { hooks: Record<string, unknown[]>; statusLine: { type: 'command'; command: string } } {
  const command = hookCommand(port);
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [{ ...(event === 'PostToolUse' ? { matcher: 'Bash' } : {}), hooks: [{ type: 'command', command }] }],
    ]),
  );
  // --settings precedence replaces the user's own status line inside the workers; the reply keeps the tab useful
  return { hooks, statusLine: { type: 'command', command: statusCommand(port) } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 161 tests PASS (`hooks-settings` 5). The four pre-existing tests are untouched: `hookCommand(4242)` renders the exact same string as before.

- [ ] **Step 5: Commit**

```bash
git add src/hooks-settings.ts test/hooks-settings.test.ts
git commit -m "feat(hooks-settings): statusLine posting the worker status line to /hooks/status"
```

---

### Task 3: Orchestrator `rateLimits` event and `state-store` normalize (TDD)

**Files:**
- Modify: `src/orchestrator.ts`, `src/state-store.ts`
- Test: `test/orchestrator.test.ts`, `test/state-store.test.ts`

**Interfaces:**
- Produces (in `src/orchestrator.ts`):
  - `reduce` handles `rateLimits`: private `setRateLimits(state, workerId, rateLimits): Reduced` — `none({ ...state, rateLimits })` when `workerId` is the `workerId` of a slot with `status !== 'vazio'`, else `none(state)` (same reference). No `fill`, no effects, no slot change.
- Produces (in `src/state-store.ts`):
  - `normalize` keeps `rateLimits` only when `isRateLimits(parsed.rateLimits)`; otherwise the key is absent (not `undefined`), so `saveState`/`loadState` round-trips of a state without the field stay deep-equal.
- Consumes: `RateLimits` and the event from Task 1; `isRateLimits` from Task 1.
- Consumed by: Task 4 (`dispatch` already routes any `HiveEvent` through `reduce`).

- [ ] **Step 1: Write the failing tests in `test/orchestrator.test.ts`**

Replace line 5 (the types import) with:

```ts
import type { Budget, HookPayload, RateLimits, Signal, State, Task, UsageRule } from '../src/types.js';
```

After `const polled = …` (line 30) add:

```ts
const LIMITS: RateLimits = {
  at: '2026-09-16T12:00:00.000Z',
  windows: {
    five_hour: { usedPercent: 23, resetsAt: '2026-09-16T15:00:00.000Z' },
    seven_day: { usedPercent: 41, resetsAt: '2026-09-20T00:00:00.000Z' },
  },
};
const limited = (state: State, workerId: string, rateLimits: RateLimits = LIMITS) =>
  reduce(state, { type: 'rateLimits', workerId, rateLimits });
```

Append after the `setUsageRules copies the rules…` test (before `slugFor strips accents…`):

```ts
test('rateLimits from an occupied slot stores the reading, emits no effect and starts nothing', () => {
  const first = filled(1, 2).state; // one working, task 2 queued
  const id = first.slots[0].workerId!;
  // A free slot next to a non-empty queue: any fill would spawn task 2 here
  const roomy: State = { ...first, maxConcurrent: 2, slots: [...first.slots, { id: 'free', status: 'vazio' }] };
  const { state, effects } = limited(roomy, id);
  assert.deepEqual(state.rateLimits, LIMITS);
  assert.equal(effects.length, 0, 'display only: no fill, no spawn');
  assert.equal(state.slots[1].status, 'vazio');
  assert.deepEqual({ ...state, rateLimits: undefined }, { ...roomy, rateLimits: undefined }, 'nothing else changes');
  const newer: RateLimits = { ...LIMITS, at: '2026-09-16T12:05:00.000Z' };
  assert.deepEqual(limited(state, id, newer).state.rateLimits, newer, 'the latest reading replaces the previous one');
});

test('rateLimits from an unknown worker or one that already exited leaves the state as is', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const ghost = limited(first, 'ghost');
  assert.equal(ghost.state, first, 'same object: nothing to persist or broadcast differently');
  assert.equal(ghost.state.rateLimits, undefined);
  assert.equal(ghost.effects.length, 0);
  const gone = reduce(first, { type: 'exit', workerId: id }).state; // the slot is refilled under a new workerId
  assert.notEqual(gone.slots[0].workerId, id);
  assert.equal(limited(gone, id).state.rateLimits, undefined, 'a worker that exited no longer feeds');
});

test('rateLimits never mutates its input and the reading survives poll, setMax and boot', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const snapshot = JSON.stringify(first);
  const { state } = limited(first, id);
  assert.equal(JSON.stringify(first), snapshot);
  assert.equal(first.rateLimits, undefined);
  const later = reduce(reduce(state, { type: 'poll', tasks: tasks(1) }).state, { type: 'setMax', max: 2 }).state;
  assert.deepEqual(later.rateLimits, LIMITS, 'the last reading stays until a newer one arrives');
  assert.deepEqual(reduce(later, { type: 'boot', aliveSlugs: [] }).state.rateLimits, LIMITS, 'a reopened Hive shows the last value');
});
```

- [ ] **Step 2: Write the failing tests in `test/state-store.test.ts`**

Append:

```ts
test('loadState keeps a valid rateLimits reading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const rateLimits = {
    at: '2026-09-16T12:00:00.000Z',
    windows: { five_hour: { usedPercent: 23, resetsAt: '2026-09-16T15:00:00.000Z' }, seven_day_fable: { usedPercent: 7, resetsAt: '2026-09-20T00:00:00.000Z' } },
  };
  await saveState(dir, { ...initialState(1), rateLimits });
  assert.deepEqual((await loadState(dir, 1)).rateLimits, rateLimits);
});

test('loadState drops a rateLimits with the wrong shape and leaves the key absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const base = initialState(1);
  const at = '2026-09-16T12:00:00.000Z';
  const bad: unknown[] = [
    5, 'x', null, [], { at: 5, windows: {} }, { at }, { at, windows: [] }, { at, windows: 'x' },
    { at, windows: { five_hour: { usedPercent: 'many', resetsAt: at } } },
    { at, windows: { five_hour: { usedPercent: 1, resetsAt: 7 } } },
    { at, windows: { five_hour: null } },
  ];
  for (const rateLimits of bad) {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...base, rateLimits }));
    const loaded = await loadState(dir, 1);
    assert.equal('rateLimits' in loaded, false, JSON.stringify(rateLimits));
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: the three orchestrator tests fail at the first `rateLimits` assertion (`reduce` falls through the switch and returns `undefined`); `drops a rateLimits with the wrong shape` fails on the first bad value (`5` is kept as is).

- [ ] **Step 4: Edit `src/orchestrator.ts`**

Replace line 2 (the types import) with:

```ts
import type { Effect, HiveEvent, HookPayload, RateLimits, Signal, Slot, State, Status, Task, UsageLimits, UsageRule } from './types.js';
```

In `reduce`, after `    case 'setUsageRules': return fill(setUsageRules(state, event.usageRules));` add:

```ts
    case 'rateLimits': return setRateLimits(state, event.workerId, event.rateLimits); // display only: no fill, no effects
```

After `function patch(…) { … }` add:

```ts
// Account-wide data, but only a live worker feeds it, as with hooks. Nothing here gates a spawn: signal and budget stay item 6's.
function setRateLimits(state: State, workerId: string, rateLimits: RateLimits): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  return !slot || slot.status === 'vazio' ? none(state) : none({ ...state, rateLimits });
}
```

- [ ] **Step 5: Edit `src/state-store.ts`**

Replace line 4 (the types import) with:

```ts
import { isRateLimits } from './rate-limits.js';
import type { Signal, State, UsageRule, UsageSample } from './types.js';
```

Replace `normalize` with:

```ts
// Files written before the signal or the budget existed lack these fields; anything unknown reads as the default.
function normalize(parsed: State): State {
  const { rateLimits, ...rest } = parsed;
  return {
    ...rest,
    signal: isSignal(parsed.signal) ? parsed.signal : 'green',
    usage: Array.isArray(parsed.usage) ? parsed.usage.filter(isSample) : [],
    budget: parsed.budget ?? {},
    usageRules: Array.isArray(parsed.usageRules) ? parsed.usageRules.filter(isRule) : [],
    ...(isRateLimits(rateLimits) ? { rateLimits } : {}), // wrong shape or legacy file: no key at all, the header shows nothing
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: 166 tests PASS (`orchestrator` 57, `state-store` 7). `saveState then loadState round-trips` stays green because a state without `rateLimits` normalizes without the key.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts src/state-store.ts test/orchestrator.test.ts test/state-store.test.ts
git commit -m "feat(orchestrator): rateLimits event stores the last plan limits; state-store keeps a valid reading"
```

---

### Task 4: Server `POST /hooks/status` and the header `#limits` (TDD for the route, manual for the UI)

**Files:**
- Modify: `src/server.ts`, `src/ui/app.ts`, `src/ui/index.html`
- Test: `test/setup.test.ts`

**Interfaces:**
- Produces (in `src/server.ts`):
  - `POST /hooks/status` — `res.type('text/plain')`; `parseRateLimits(req.body, new Date())`; without `x-hive-worker` or without a surviving window → `res.send('')` (200); otherwise `res.send(formatRateLimits(rateLimits))` first, then `await dispatch({ type: 'rateLimits', workerId, rateLimits })`. The line is computed from the payload, so an unknown worker gets it and the reducer ignores the event, exactly like `/hooks/event`. Before setup `dispatch` is a no-op (`!live`), the line is still answered.
- Produces (in `src/ui/app.ts`):
  - `WINDOW_LABEL`, `WEEKLY_PREFIX`, `PERCENT_MAX` constants (mirror of `src/rate-limits.ts`), `windowLabel(key)`, `clock(iso)`, `renderLimits(limits?: RateLimits)` called from `render`
- Produces (in `src/ui/index.html`): `<span id="limits" class="dash"></span>` after `#usage`; `#limits { color: var(--muted); }`
- Consumes: `parseRateLimits`, `formatRateLimits` (Task 1); the reducer branch (Task 3); `statusCommand` (Task 2) is what makes real workers call this route.

- [ ] **Step 1: Write the failing test — append to `test/setup.test.ts`**

```ts
test('POST /hooks/status answers the limits line for a valid payload, an empty body otherwise, and an unknown worker changes nothing', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  const postStatus = (body: unknown, worker?: string): Promise<Response> =>
    fetch(`${base}/hooks/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(worker ? { 'x-hive-worker': worker } : {}) },
      body: JSON.stringify(body),
    });
  const payload = {
    model: { id: 'claude-opus' }, // the rest of the status line JSON rides along and is ignored
    rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 1759744800 }, seven_day: { used_percentage: 41, resets_at: 1760263200 } },
  };
  const ok = await postStatus(payload, 'ghost');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await ok.text(), 'sessão 23% · semana 41%');
  const noHeader = await postStatus(payload);
  assert.equal(noHeader.status, 200);
  assert.equal(await noHeader.text(), '');
  const noLimits = await postStatus({ model: { id: 'claude-opus' } }, 'ghost');
  assert.equal(noLimits.status, 200);
  assert.equal(await noLimits.text(), '');
  const noValid = await postStatus({ rate_limits: { five_hour: { used_percentage: 'x' } } }, 'ghost');
  assert.equal(await noValid.text(), '');
  await sleep(20); // the route answers before dispatching; let the handlers finish
  assert.equal(server.getState()?.rateLimits, undefined, 'no occupied slot matches, so nothing is stored');
  assert.equal((await fetch(`${base}/setup`)).status, 200, 'the server is still up');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: the new test fails at `assert.equal(ok.status, 200)` (404: no route).

- [ ] **Step 3: Edit `src/server.ts`**

After `import { reduce, SIGNALS } from './orchestrator.js';` add:

```ts
import { formatRateLimits, parseRateLimits } from './rate-limits.js';
```

After the `/hooks/exit` route add:

```ts
  // The worker's status line posts its whole JSON here; only `rate_limits` is kept, and the reply is the line the worker's tab shows.
  app.post('/hooks/status', async (req: Request, res: Response) => {
    res.type('text/plain');
    const workerId = req.header('x-hive-worker');
    const rateLimits = parseRateLimits(req.body, new Date());
    if (!workerId || !rateLimits) {
      res.send('');
      return;
    }
    res.send(formatRateLimits(rateLimits)); // from the payload, not the State: an unknown worker gets the line and the reducer ignores it
    await dispatch({ type: 'rateLimits', workerId, rateLimits });
  });
```

- [ ] **Step 4: Edit `src/ui/app.ts`**

Replace the types import (lines 1–4) with:

```ts
import type {
  BoardConfig, Budget, EventsPayload, ProjectSummary, RateLimits, SetupBody, SetupInfo, SetupResult, Signal, Slot, State, StatusKey,
  Task, UsageSample,
} from '../types.js';
```

After `const MILLION = 1_000_000;` add:

```ts
// Mirrors src/rate-limits.ts, which cannot be imported here (the served module graph only has app.js).
const WINDOW_LABEL: Record<string, string> = { five_hour: 'sessão', seven_day: 'semana' };
const WEEKLY_PREFIX = 'seven_day_';
const PERCENT_MAX = 100;
```

After `const meter = …;` add:

```ts
const clock = (iso: string): string => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function windowLabel(key: string): string {
  if (Object.hasOwn(WINDOW_LABEL, key)) return WINDOW_LABEL[key];
  if (key.startsWith(WEEKLY_PREFIX)) return `semana ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
}
```

After `renderUsage` add:

```ts
// Percent and times are numbers / Date output; the label derives from a key another process chose, so it is escaped.
function renderLimits(limits?: RateLimits): void {
  const el = $('limits');
  if (!limits) {
    el.textContent = '';
    return;
  }
  const windows = Object.entries(limits.windows).map(([key, w]) =>
    `${esc(windowLabel(key))} ${Math.round(w.usedPercent)}% ${meter(w.usedPercent, PERCENT_MAX)} reseta ${clock(w.resetsAt)}`);
  el.innerHTML = [...windows, `às ${clock(limits.at)}`].join(' · ');
}
```

In `render`, after `  renderUsage(state.usage, state.budget);` add:

```ts
  renderLimits(state.rateLimits);
```

- [ ] **Step 5: Edit `src/ui/index.html`**

After `  #usage.over { color: var(--danger); }` add:

```css
  #limits { color: var(--muted); }
```

After `  <span id="usage" class="dash"></span>` add:

```html
  <span id="limits" class="dash"></span>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: 167 tests PASS (`setup` 23).

- [ ] **Step 7: Headless check of the route (manual, no worker)**

With the Hive running on a configured repo (`pnpm start <repo>`), in another shell:

```bash
curl -s -X POST http://127.0.0.1:47821/hooks/status -H 'x-hive-worker: x' -H 'content-type: application/json' \
  -d '{"rate_limits":{"five_hour":{"used_percentage":23,"resets_at":1759744800},"seven_day":{"used_percentage":41,"resets_at":1760263200}}}'
```

Prints `sessão 23% · semana 41%`; the header stays empty (unknown worker, the reducer ignores it). Without `-H 'x-hive-worker: x'` it prints nothing. `cat <repo>/.hive/hooks.json` shows the `statusLine` block with the bound port.

- [ ] **Step 8: Acceptance per the spec's "Critério de pronto" (manual, real worker on a Pro/Max plan)**

1. Use a repo with `máx. workers = 1` and one task in the queue column. `pnpm start <repo>`: a worker opens; after its first API response the header shows `sessão NN% ▮▮ reseta HH:MM · semana NN% ▮▮ reseta HH:MM · às HH:MM`, and the worker's iTerm tab shows `sessão NN% · semana NN%` in its status line. Every status line refresh updates `às HH:MM`.
2. Close the Hive (set `máx. workers` to 0 and kill the worker first). `cat <repo>/.hive/state.json` has `rateLimits` with `at` and `windows`. Reopen with `pnpm start <repo>`: the header shows the same values with the old `às HH:MM`.
3. Without a worker (or on an API plan): the header shows nothing under `#limits`, nothing breaks. To see the rendering without a Pro plan, close the Hive, add `"rateLimits": { "at": "2026-09-16T12:00:00.000Z", "windows": { "five_hour": { "usedPercent": 23, "resetsAt": "2026-09-16T15:00:00.000Z" }, "seven_day_fable": { "usedPercent": 7, "resetsAt": "2026-09-20T00:00:00.000Z" } } }` to `.hive/state.json`, reopen: `sessão 23% ▮ reseta 12:00 · semana fable 7% ▮ reseta 21:00 · às 09:00` (local time). Set it to `5` in the file, reopen: nothing shows.
4. The signal buttons, `máx. workers`, the token meter and the queue behave exactly as in item 6.
5. `pnpm test`: 167 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts src/ui/app.ts src/ui/index.html test/setup.test.ts
git commit -m "feat(server): POST /hooks/status and plan limits in the dashboard header"
```
