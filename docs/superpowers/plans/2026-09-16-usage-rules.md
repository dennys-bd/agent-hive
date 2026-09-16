# Agent Hive — sinal dinâmico por uso de tokens: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Rebase note:** this plan was written and executed while roadmap item 5 (token budget, PR #14) was still open, under the assumption that item 6 would define `State.usage` / `Config.budget` itself. Item 5 landed with `State.usage: UsageSample[]`, `usageTotals(usage, now)`, `State.budget` copied from `Config.budget` by `setBudget`, and `hasBudget` in `fill`. The branch was then re-applied on top of it: `Usage` / `Budget` / `UsagePolicy` / the `usage` event below are gone; `usedPercent` and `applyUsageRules` take `(usage: UsageSample[], budget: Budget, …, now: number)`; the rules reach the reducer as `State.usageRules` via a `setUsageRules` event (mirroring `setBudget`) instead of a third `reduce` argument; `poll` releases `paused` when the effective signal leaves red. The spec (`docs/superpowers/specs/2026-09-16-usage-rules-design.md`) describes the final shape; the task bodies below are kept as the record of the first pass.

**Goal:** The signal and the worker cap become *derived* from token usage against a budget, through a table of rules in `hive.config.json`. A pure rule `applyUsageRules(usage, budget, rules) → { signal, maxWorkers }` says what the usage allows; the orchestrator combines it with the manual signal (the most restrictive wins) and with `maxConcurrent` (the smaller wins), and stops opening jobs above the effective cap without draining or killing any live worker. Without `budget`, without `usageRules` or without `state.usage`, behavior is exactly item 4's. Measuring tokens, the UI meter and any HTTP route for usage stay in item 5; this item only adds the seam (`usage` event) item 5 will deliver into.

**Architecture:** `src/usage-rules.ts` (new) holds the pure rule: `SIGNAL_RANK`, `worstSignal`, `usedPercent` (worst of the hour/day windows that have a budget, 0 without data) and `applyUsageRules` (every rule with `percent <= used` fires; worst signal and smallest cap win). `reduce(state, event, policy = { usageRules: [] })` in `src/orchestrator.ts` gains a `UsagePolicy` third argument that `server.ts` fills with `live.runtime.config` (`Config` structurally satisfies `UsagePolicy`, so no adapter). A private `limits(state, policy)` folds manual and dynamic into one effective `{ signal, maxWorkers }`; `canStart(signal, slots, limit?)` is still the single spawn gate, now also requiring `occupied < limit` when a cap exists; `fill` computes `limits` once and re-checks the gate before every spawn. `Stop` and `setSignal` read the effective signal, so a dynamic red pauses exactly like a manual one and a manual `green` cannot lift a dynamic red. The new `usage` event stores `state.usage`, releases `paused` marks if the effective signal left red, then runs `fill`. `config.ts` parses and validates `budget` and `usageRules`; `saveSetup` in `server.ts` carries both from the current file across `POST /setup` (`saveSetup` picks fields one by one, so the two fields are added explicitly). `state.usage` persists through `saveState` as any other field; `loadState` needs no change.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-16-usage-rules-design.md` (extends `docs/superpowers/specs/2026-09-16-signal-design.md` and `docs/superpowers/specs/2026-09-15-agent-hive-design.md`).

## Global Constraints

- All v1, setup, boards and signal constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts`, `run.ts`, `hive.ts`, `hooks-settings.ts`, `spawn.ts`, `board.ts`, `state-store.ts`, `src/boards/*` and `src/ui/*` do not change. Hooks, spawn, board adapters, the setup form and the dashboard are untouched: this item has no UI change and no new HTTP route.
- `budget` and `usageRules` live only in `hive.config.json` (never in `state.json`, `SetupBody` or the setup form); `usage` lives only in `State` (never in the config). The reducer receives the policy as an argument and stays pure: same inputs, same output, no config read inside it.
- `canStart` remains the single spawn gate and `fill` the only place a `spawn` effect is created; `fill` consults `canStart` with the *effective* signal and cap before every spawn. No other reducer branch reads the signal except `Stop` and `setSignal` / `usage` (through `limits`).
- The dynamic cap never emits `kill`, never marks `draining` (only `setMax` does) and never changes a slot's `status`; `state.maxConcurrent` stays the configured value, so `N/M workers ativos` keeps showing the config's `M`.
- Manual and dynamic can only restrict each other: effective signal = worst of the two, effective cap = smaller of the two. No `usage` value ever loosens a manual red or raises the cap above `maxConcurrent`.
- Without `policy` (every existing test) or without `state.usage` / `budget`, every reducer result is identical to item 4.
- `Config` must keep satisfying `UsagePolicy` structurally (`budget?: Budget; usageRules: UsageRule[]`) so `server.ts` passes `live.runtime.config` as is.
- ESM with `.js` import extensions; no new runtime dependencies; source files under 400 lines, functions under 50 lines (`fill` included). Code comments in English.
- `test/setup.test.ts` keeps its fake factory and `maxConcurrent: 0`, so nothing spawns.
- `pnpm test` must stay green after every task (114 tests today → 128 at the end).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `Budget`, `Usage`, `UsageRule`, `UsageLimits`, `UsagePolicy`; `Config.budget?` / `Config.usageRules`; `State.usage?`; `usage` event |
| `src/usage-rules.ts` (new) | `SIGNAL_RANK`, `worstSignal`, `usedPercent`, `applyUsageRules` — pure, no orchestrator import |
| `src/orchestrator.ts` | `reduce(state, event, policy)`, private `limits`, `canStart(signal, slots, limit?)`, `fill` re-checks the gate per spawn, `setSignal` / `usage` release `paused` via the effective signal, `Stop` reads the effective signal |
| `src/config.ts` | `DEFAULT_CONFIG.usageRules = []`, `parseBudget`, `parseUsageRule`, `budget` / `usageRules` in `parseConfig` |
| `src/server.ts` | `dispatch` passes `live.runtime.config` to `reduce`; `saveSetup` carries `budget` and `usageRules` from the current file |
| `test/usage-rules.test.ts` (new) | `usedPercent`, `applyUsageRules` (roadmap table at 0 / 49 / 55 / 65 / 85 / 95 %, order, signal-only rule), `worstSignal` (+5) |
| `test/orchestrator.test.ts` | `canStart` with `limit`, cap on `poll`, cap below occupied, dynamic yellow / recovery, dynamic red vs manual green, no policy / no usage, mutation (+6 → 46) |
| `test/config.test.ts` | defaults, valid `budget` / `usageRules`, errors naming the field (+2 → 10) |
| `test/setup.test.ts` | `budget` and `usageRules` survive `POST /setup` and reach the live config (+1 → 20) |

---

### Task 1: Types and the pure rule — `src/usage-rules.ts` (TDD)

**Files:**
- Modify: `src/types.ts`
- Create: `src/usage-rules.ts`
- Test: `test/usage-rules.test.ts` (new)

**Interfaces:**
- Produces (in `src/types.ts`):
  - `interface Budget { maxTokensPerHour?: number; maxTokensPerDay?: number }`
  - `interface Usage { tokensLastHour: number; tokensLastDay: number }`
  - `interface UsageRule { percent: number; maxWorkers?: number; signal?: Signal }`
  - `interface UsageLimits { signal: Signal; maxWorkers?: number }`
  - `interface UsagePolicy { budget?: Budget; usageRules: UsageRule[] }`
  - `Config.budget?: Budget`, `Config.usageRules: UsageRule[]` (so `Config` satisfies `UsagePolicy`)
  - `State.usage?: Usage`
  - `HiveEvent` gains `{ type: 'usage'; usage: Usage }`
- Produces (in `src/usage-rules.ts`):
  - `SIGNAL_RANK: Record<Signal, number>` = `{ green: 0, yellow: 1, red: 2 }`
  - `worstSignal(a, b): Signal`
  - `usedPercent(usage, budget): number` — `max` over the windows that have a budget of `tokens × 100 / limit`; no usage, no budget, or a window absent / `0` → `0`
  - `applyUsageRules(usage, budget, rules): UsageLimits` — every rule with `percent <= used` fires; `signal` = worst among them (default `green`), `maxWorkers` = smallest among them (absent when none sets it)
- Consumed by: Task 2 (`applyUsageRules`, `worstSignal`, all types), Task 3 (`Budget`, `UsageRule`, `SIGNALS`), Task 4 (`Config` shape).

Note: `Config.usageRules` becomes required, so `DEFAULT_CONFIG` and `parseConfig` in `src/config.ts` stop compiling until Task 3. To keep `pnpm test` green at the end of this task, Task 1 also adds the one-line default `usageRules: []` to `DEFAULT_CONFIG` and the parse line in `parseConfig` (validation comes in Task 3). Both are shown in step 4.

- [ ] **Step 1: Write the failing tests — create `test/usage-rules.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUsageRules, SIGNAL_RANK, usedPercent, worstSignal } from '../src/usage-rules.js';
import type { Budget, Usage, UsageRule } from '../src/types.js';

const HOUR = 2_000_000;
const DAY = 20_000_000;
const BUDGET: Budget = { maxTokensPerHour: HOUR, maxTokensPerDay: DAY };
// the roadmap table
const RULES: UsageRule[] = [
  { percent: 50, maxWorkers: 4 },
  { percent: 60, maxWorkers: 3 },
  { percent: 80, signal: 'yellow' },
  { percent: 90, signal: 'red' },
];
const hourAt = (percent: number): Usage => ({ tokensLastHour: (HOUR / 100) * percent, tokensLastDay: 0 });

test('usedPercent is 0 without usage, without a budget, or with no window set', () => {
  assert.equal(usedPercent(undefined, BUDGET), 0);
  assert.equal(usedPercent(hourAt(50), undefined), 0);
  assert.equal(usedPercent(hourAt(50), {}), 0, 'a budget with no window set');
  assert.equal(usedPercent(hourAt(50), { maxTokensPerHour: 0 }), 0, 'a zero window is no budget, never a division by zero');
});

test('usedPercent takes the tighter of the hour and day windows, only over the windows with a budget', () => {
  assert.equal(usedPercent({ tokensLastHour: 1_000_000, tokensLastDay: 0 }, BUDGET), 50);
  assert.equal(usedPercent({ tokensLastHour: 0, tokensLastDay: 15_000_000 }, BUDGET), 75);
  assert.equal(usedPercent({ tokensLastHour: 1_000_000, tokensLastDay: 15_000_000 }, BUDGET), 75, 'the worst window wins');
  assert.equal(usedPercent({ tokensLastHour: 100, tokensLastDay: 15_000_000 }, { maxTokensPerHour: 1000 }), 10, 'day ignored without a day budget');
  assert.equal(usedPercent({ tokensLastHour: 3_000_000, tokensLastDay: 0 }, BUDGET), 150, 'over budget reads above 100');
  assert.equal(usedPercent({ tokensLastHour: 1_140_000, tokensLastDay: 0 }, BUDGET), 57, 'exact share reads exactly, no float drift');
});

test('applyUsageRules fires every rule at or below the used percent; worst signal and smallest cap win', () => {
  const at = (percent: number) => applyUsageRules(hourAt(percent), BUDGET, RULES);
  assert.deepEqual(at(0), { signal: 'green' });
  assert.deepEqual(at(49), { signal: 'green' });
  assert.deepEqual(at(55), { signal: 'green', maxWorkers: 4 });
  assert.deepEqual(at(65), { signal: 'green', maxWorkers: 3 });
  assert.deepEqual(at(85), { signal: 'yellow', maxWorkers: 3 });
  assert.deepEqual(at(95), { signal: 'red', maxWorkers: 3 });
  assert.deepEqual(at(50), { signal: 'green', maxWorkers: 4 }, 'the boundary fires');
});

test('applyUsageRules ignores array order, works with a signal-only rule, and is green without usage, budget or rules', () => {
  assert.deepEqual(applyUsageRules(hourAt(95), BUDGET, [...RULES].reverse()), applyUsageRules(hourAt(95), BUDGET, RULES));
  const only = applyUsageRules(hourAt(85), BUDGET, [RULES[2]]);
  assert.equal(only.signal, 'yellow');
  assert.equal(only.maxWorkers, undefined);
  assert.deepEqual(applyUsageRules(undefined, BUDGET, RULES), { signal: 'green' });
  assert.deepEqual(applyUsageRules(hourAt(95), undefined, RULES), { signal: 'green' });
  assert.deepEqual(applyUsageRules(hourAt(95), BUDGET, []), { signal: 'green' });
});

test('worstSignal ranks green < yellow < red', () => {
  assert.deepEqual(SIGNAL_RANK, { green: 0, yellow: 1, red: 2 });
  assert.equal(worstSignal('green', 'yellow'), 'yellow');
  assert.equal(worstSignal('yellow', 'green'), 'yellow');
  assert.equal(worstSignal('red', 'yellow'), 'red');
  assert.equal(worstSignal('green', 'green'), 'green');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `Cannot find module '../src/usage-rules.js'`, `Module '"../src/types.js"' has no exported member 'Budget'` (and `Usage`, `UsageRule`).

- [ ] **Step 3: Edit `src/types.ts`**

After `export type Signal = 'green' | 'yellow' | 'red';` add:

```ts
export interface Budget {
  maxTokensPerHour?: number;
  maxTokensPerDay?: number;
}

export interface Usage {
  tokensLastHour: number;
  tokensLastDay: number;
}

/** One row of the usage table: at `percent` of the budget used, cap the workers and/or force a signal. */
export interface UsageRule {
  percent: number;
  maxWorkers?: number;
  signal?: Signal;
}

export interface UsageLimits {
  signal: Signal;
  maxWorkers?: number;
}

/** What the reducer needs from the config to apply the usage rules; `Config` satisfies it structurally. */
export interface UsagePolicy {
  budget?: Budget;
  usageRules: UsageRule[];
}
```

In `State`, after `  signal: Signal; // …` add:

```ts
  usage?: Usage; // token usage as last reported by the `usage` event; absent = no data = no restriction
```

Replace the `Config` interface with:

```ts
export interface Config {
  board: BoardConfig;
  status: Record<StatusKey, string>;
  maxConcurrent: number;
  port: number;
  claudeArgs: string[];
  promptTemplate: string;
  budget?: Budget;
  usageRules: UsageRule[];
}
```

In `HiveEvent`, after `  | { type: 'setSignal'; signal: Signal }` add:

```ts
  | { type: 'usage'; usage: Usage }
```

- [ ] **Step 4: Create `src/usage-rules.ts`, and keep `config.ts` compiling**

`src/usage-rules.ts`:

```ts
import type { Budget, Signal, Usage, UsageLimits, UsageRule } from './types.js';

export const SIGNAL_RANK: Record<Signal, number> = { green: 0, yellow: 1, red: 2 };
const PERCENT = 100;

export function worstSignal(a: Signal, b: Signal): Signal {
  return SIGNAL_RANK[b] > SIGNAL_RANK[a] ? b : a;
}

// Multiply before dividing: token counts are integers, so an exact share (1_140_000 of 2_000_000) reads 57, not 56.99…
function share(used: number, limit: number | undefined): number {
  return limit ? (used * PERCENT) / limit : 0; // no budget for this window (absent or 0) never restricts
}

/** Share of the budget used, in percent, over the windows that have a budget; no usage or no budget reads as 0. */
export function usedPercent(usage: Usage | undefined, budget: Budget | undefined): number {
  if (!usage || !budget) return 0;
  return Math.max(share(usage.tokensLastHour, budget.maxTokensPerHour), share(usage.tokensLastDay, budget.maxTokensPerDay));
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Every rule at or below the used percent fires; the worst signal and the smallest cap among them win. Array order is irrelevant. */
export function applyUsageRules(usage: Usage | undefined, budget: Budget | undefined, rules: UsageRule[]): UsageLimits {
  const used = usedPercent(usage, budget);
  return rules
    .filter((rule) => rule.percent <= used)
    .reduce<UsageLimits>((limits, rule) => ({
      signal: rule.signal ? worstSignal(limits.signal, rule.signal) : limits.signal,
      maxWorkers: minDefined(limits.maxWorkers, rule.maxWorkers),
    }), { signal: 'green' });
}
```

In `src/config.ts`, in `DEFAULT_CONFIG` after `  claudeArgs: [],` add:

```ts
  usageRules: [],
```

and in the object returned by `parseConfig`, after the `promptTemplate:` line add (temporary, replaced by validation in Task 3):

```ts
    usageRules: DEFAULT_CONFIG.usageRules,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 119 tests PASS (`usage-rules` 5; everything else unchanged — `State.usage` and `Config.budget` are optional, `usageRules` is defaulted).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/usage-rules.ts src/config.ts test/usage-rules.test.ts
git commit -m "feat(usage-rules): pure usage rules — usedPercent, applyUsageRules, worstSignal"
```

---

### Task 2: Orchestrator — `reduce(state, event, policy)`, `canStart` with a cap, effective signal, `usage` event (TDD)

**Files:**
- Modify: `src/orchestrator.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces:**
- Produces (in `src/orchestrator.ts`):
  - `reduce(state, event, policy: UsagePolicy = NO_POLICY): Reduced` — `NO_POLICY = { usageRules: [] }`; every existing caller and test keeps working unchanged
  - `canStart(signal, slots, limit?): boolean` — as before, plus `limit === undefined || occupied < limit` where occupied = slots with `status !== 'vazio'`
  - `reduce` handles `usage`: stores `state.usage`, releases `paused` if the effective signal is not red, then `fill`
  - `setSignal` releases `paused` only when the *effective* signal after the change is not red; `Stop` marks `paused` when the *effective* signal is red
  - private `limits(state, policy): UsageLimits` — `{ signal: worstSignal(state.signal, dyn.signal), maxWorkers: dyn.maxWorkers === undefined ? undefined : min(state.maxConcurrent, dyn.maxWorkers) }`
- Consumes: `applyUsageRules`, `worstSignal` and the types from Task 1.
- Consumed by: Task 4 (`server.ts` passes the policy).

- [ ] **Step 1: Write the failing tests in `test/orchestrator.test.ts`**

Replace line 4 (the types import) with:

```ts
import type { HookPayload, Signal, State, Task, UsagePolicy } from '../src/types.js';
```

After the `stopped` helper (line 16) add:

```ts
// 55% → cap 1; 85% → yellow + cap 1; 95% → red + cap 1; 10% → nothing
const POLICY: UsagePolicy = {
  budget: { maxTokensPerHour: 1000 },
  usageRules: [{ percent: 50, maxWorkers: 1 }, { percent: 80, signal: 'yellow' }, { percent: 90, signal: 'red' }],
};
const used = (state: State, tokensLastHour: number) =>
  reduce(state, { type: 'usage', usage: { tokensLastHour, tokensLastDay: 0 } }, POLICY);
const stoppedUnder = (state: State, workerId: string) =>
  reduce(state, { type: 'hook', workerId, payload: { hook_event_name: 'Stop' } }, POLICY).state;
```

In the `reducer never mutates its input` test, after `  reduce(before, { type: 'setSignal', signal: 'red' });` add:

```ts
  reduce(before, { type: 'usage', usage: { tokensLastHour: 950, tokensLastDay: 0 } }, POLICY);
```

Append after the `setSignal to green or yellow clears paused on every slot; red again keeps it` test (before `slugFor strips accents…`):

```ts
test('canStart with a limit needs the occupied count below it; without one it is as before', () => {
  const one = filled(2, 1).state.slots; // 1 occupied, 1 free
  assert.equal(canStart('green', one), true);
  assert.equal(canStart('green', one, 2), true, 'occupied 1 < limit 2');
  assert.equal(canStart('green', one, 1), false, 'occupied 1 = limit 1');
  assert.equal(canStart('green', one, 0), false);
  assert.equal(canStart('yellow', one, 2), false, 'a limit never overrides the signal');
});

test('poll under a usage cap opens up to the cap, queues the rest and drains nothing', () => {
  const capped = used(initialState(3), 550).state; // 55%: cap 1
  const { state, effects } = reduce(capped, { type: 'poll', tasks: tasks(3) }, POLICY);
  assert.equal(state.maxConcurrent, 3, 'the configured max is untouched');
  assert.equal(occupied(state).length, 1);
  assert.equal(state.slots.length, 3);
  assert.deepEqual(state.queue.map((t) => t.id), ['2', '3']);
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'spawn']);
  assert.ok(state.slots.every((s) => !s.draining));
});

test('a usage cap below the occupied count emits no kill, drains nothing, and a freed slot stays empty', () => {
  const three = filled(3, 4).state; // 3 working, 1 queued
  const { state, effects } = used(three, 550); // cap 1 < 3 occupied
  assert.equal(effects.length, 0);
  assert.equal(occupied(state).length, 3);
  assert.ok(state.slots.every((s) => !s.draining));
  assert.deepEqual(state.queue.map((t) => t.id), ['4']);
  const freed = reduce(state, { type: 'exit', workerId: state.slots[0].workerId! }, POLICY);
  assert.equal(occupied(freed.state).length, 2, 'the freed slot stays empty while occupied >= cap');
  assert.equal(freed.state.slots[0].status, 'vazio');
  assert.deepEqual(freed.state.queue.map((t) => t.id), ['4', '1']);
  assert.deepEqual(freed.effects, [{ type: 'setStatus', itemId: 'item1', key: 'queue' }]);
});

test('usage past the yellow rule stops fill without touching the manual signal; usage dropping back reopens', () => {
  const yellow = used(initialState(1), 850); // 85%: yellow
  assert.deepEqual(yellow.state.usage, { tokensLastHour: 850, tokensLastDay: 0 });
  assert.equal(yellow.state.signal, 'green', 'the manual signal is untouched');
  const queued = reduce(yellow.state, { type: 'poll', tasks: tasks(1) }, POLICY);
  assert.equal(occupied(queued.state).length, 0);
  assert.deepEqual(queued.state.queue.map((t) => t.id), ['1']);
  assert.equal(queued.effects.length, 0);
  const back = used(queued.state, 100); // 10%: nothing fires
  assert.equal(back.state.slots[0].task?.id, '1');
  assert.deepEqual(back.state.queue, []);
  assert.deepEqual(back.effects.map((e) => e.type), ['setStatus', 'spawn']);
});

test('Stop under a dynamic red pauses; manual green cannot lift it; usage leaving red clears it; usage never lifts a manual red', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const paused = stoppedUnder(used(first, 950).state, id); // 95%: red
  assert.equal(paused.slots[0].paused, true);
  assert.equal(paused.slots[0].status, 'trabalhando');
  assert.equal(paused.slots[0].lastEvent, 'pausado: sinal red');
  const stillRed = reduce(paused, { type: 'setSignal', signal: 'green' }, POLICY).state;
  assert.equal(stillRed.signal, 'green');
  assert.equal(stillRed.slots[0].paused, true, 'manual green does not beat a dynamic red');
  assert.equal(used(stillRed, 100).state.slots[0].paused, undefined, 'usage back under the red rule releases the mark');
  const manual = reduce(used(first, 100).state, { type: 'setSignal', signal: 'red' }, POLICY).state;
  const pausedByHand = stoppedUnder(manual, id);
  assert.equal(pausedByHand.slots[0].paused, true);
  assert.equal(used(pausedByHand, 0).state.slots[0].paused, true, 'usage never clears a manual red');
});

test('without a policy, or without usage, everything is as before', () => {
  const first = filled(1, 2).state;
  const { state, effects } = reduce(first, { type: 'usage', usage: { tokensLastHour: 999_999, tokensLastDay: 999_999 } });
  assert.deepEqual(state.usage, { tokensLastHour: 999_999, tokensLastDay: 999_999 });
  assert.deepEqual({ ...state, usage: undefined }, { ...first, usage: undefined });
  assert.equal(effects.length, 0);
  const noUsage = reduce(initialState(2), { type: 'poll', tasks: tasks(3) }, POLICY);
  assert.equal(occupied(noUsage.state).length, 2, 'a policy without usage restricts nothing');
  assert.deepEqual(noUsage.state.queue.map((t) => t.id), ['3']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `Expected 2 arguments, but got 3` on every `reduce(…, POLICY)` call and `Expected 2 arguments, but got 3` on `canStart('green', one, 2)`.

- [ ] **Step 3: Edit `src/orchestrator.ts`**

Replace line 2 (the types import) with:

```ts
import type { Effect, HiveEvent, HookPayload, Signal, Slot, State, Status, Task, Usage, UsageLimits, UsagePolicy } from './types.js';
import { applyUsageRules, worstSignal } from './usage-rules.js';
```

After `export const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];` add:

```ts
const NO_POLICY: UsagePolicy = { usageRules: [] }; // no budget, no rules: the manual signal and maxConcurrent are the only limits
```

Replace `canStart` (lines 20–23) with:

```ts
/** The one gate every spawn goes through: green, a free slot that is not draining, and room under the cap when there is one. */
export function canStart(signal: Signal, slots: Slot[], limit?: number): boolean {
  if (signal !== 'green' || !slots.some((s) => s.status === 'vazio' && !s.draining)) return false;
  return limit === undefined || slots.filter((s) => s.status !== 'vazio').length < limit;
}

/** Effective signal and worker cap: the manual signal and the usage rules can only restrict each other, never loosen. */
function limits(state: State, policy: UsagePolicy): UsageLimits {
  const dyn = applyUsageRules(state.usage, policy.budget, policy.usageRules);
  return {
    signal: worstSignal(state.signal, dyn.signal),
    maxWorkers: dyn.maxWorkers === undefined ? undefined : Math.min(state.maxConcurrent, dyn.maxWorkers),
  };
}
```

Replace `reduce` (lines 47–62) with:

```ts
export function reduce(state: State, event: HiveEvent, policy: UsagePolicy = NO_POLICY): Reduced {
  switch (event.type) {
    case 'boot': return boot(state, event.aliveSlugs); // no fill: bootHive polls right after, and the board is the truth
    case 'poll': return fill(poll(state, event.tasks), policy);
    case 'setMax': return fill(setMax(state, event.max), policy);
    case 'setSignal': return fill(setSignal(state, event.signal, policy), policy);
    case 'usage': return fill(setUsage(state, event.usage, policy), policy); // usage dropped: pull from the queue right away
    case 'hook': return applyHook(state, event.workerId, event.payload, policy, event.branch);
    case 'exit': return fill(exit(state, event.workerId), policy);
    case 'kill': {
      const slot = state.slots.find((s) => s.id === event.slotId);
      return { state, effects: slot?.slug && slot.workerId ? [{ type: 'kill', slug: slot.slug, workerId: slot.workerId }] : [] };
    }
    case 'spawned': return patch(state, event.workerId, { itermSessionId: event.itermSessionId });
    case 'error': return { state: { ...state, error: event.message }, effects: [] };
  }
}
```

Replace `fill` (lines 76–95) in full with:

```ts
function fill(reduced: Reduced, policy: UsagePolicy): Reduced {
  const { state, effects } = reduced;
  const { signal, maxWorkers } = limits(state, policy);
  let queue = state.queue;
  let slots = state.slots;
  const spawned: Effect[] = [];
  // The gate is re-checked before every spawn against the slots as they stand, so the cap counts what was just opened.
  for (let i = 0; i < slots.length && canStart(signal, slots, maxWorkers); i += 1) {
    const slot = slots[i];
    if (slot.status !== 'vazio' || slot.draining) continue;
    const index = queue.findIndex((t) => !isBlocked(t)); // first free task in board order; blocked ones keep their place
    if (index < 0) break;
    const task = queue[index];
    queue = queue.filter((_, j) => j !== index);
    const next: Slot = {
      id: slot.id, workerId: randomUUID(), status: 'trabalhando', task, slug: slugFor(task),
      startedAt: new Date().toISOString(), lastEvent: 'iniciando',
    };
    slots = slots.map((s, j) => (j === i ? next : s));
    spawned.push({ type: 'setStatus', itemId: task.itemId, key: 'working' }, { type: 'spawn', slot: next });
  }
  return { state: { ...state, slots, queue }, effects: [...effects, ...spawned] };
}
```

Replace `setSignal` (lines 123–127) with:

```ts
function setSignal(state: State, signal: Signal, policy: UsagePolicy): Reduced {
  return none(releasePaused({ ...state, signal }, policy));
}

function setUsage(state: State, usage: Usage, policy: UsagePolicy): Reduced {
  return none(releasePaused({ ...state, usage }, policy));
}

// Leaving red (manual or dynamic) releases every paused mark. The Hive never types in a worker's terminal: this mark is all it releases.
function releasePaused(state: State, policy: UsagePolicy): State {
  if (limits(state, policy).signal === 'red' || !state.slots.some((s) => s.paused)) return state;
  return { ...state, slots: state.slots.map((s) => ({ ...s, paused: undefined })) };
}
```

Replace the head of `applyHook` (line 161) with:

```ts
function applyHook(state: State, workerId: string, p: HookPayload, policy: UsagePolicy, branch?: string): Reduced {
```

In `applyHook`, replace the `Stop` and `SessionEnd` cases with:

```ts
    case 'Stop':
      // Red (by hand or by usage) is manual mode: the worker stops by itself at the end of the turn; the mark says it stopped under red
      return patch(state, workerId, {
        status: activeStatus(slot), question: undefined,
        ...(limits(state, policy).signal === 'red' ? { paused: true, lastEvent: 'pausado: sinal red' } : { lastEvent: 'turno encerrado' }),
      });
    case 'SessionEnd':
      return fill(exit(state, workerId), policy);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 125 tests PASS (`orchestrator` 46). The 40 pre-existing orchestrator tests pass untouched: with `NO_POLICY`, `limits` returns `{ signal: state.signal, maxWorkers: undefined }`, so `canStart` and `fill` behave exactly as in item 4, and `releasePaused` only maps the slots when some mark is set (so `exit is idempotent` and the `usage without policy` deep-equalities hold). `orchestrator.ts` lands around 225 lines; `fill` is 22 lines.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): usage policy — effective signal and dynamic worker cap at the canStart gate"
```

---

### Task 3: Config — `budget` and `usageRules` parsed and validated (TDD)

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces (in `src/config.ts`):
  - `DEFAULT_CONFIG.usageRules = []` (already added in Task 1); `budget` has no default (absent)
  - `parseConfig` reads `budget` (optional object; `maxTokensPerHour` / `maxTokensPerDay` each optional, non-negative integer) and `usageRules` (optional array; each rule: `percent` integer 0–100, `maxWorkers?` non-negative integer, `signal?` in `SIGNALS`, at least one of the two)
  - Error messages, all prefixed with `hive.config.json:` like the rest: `"budget" must be an object`, `"budget.maxTokensPerHour" must be a non-negative integer`, `"usageRules" must be an array`, `"usageRules[i]" must be an object`, `"usageRules[i].percent" must be an integer from 0 to 100` (above 100) / `must be a non-negative integer` (negative or fractional), `"usageRules[i].maxWorkers" must be a non-negative integer`, `"usageRules[i].signal" must be one of: green, yellow, red`, `"usageRules[i]" must set "maxWorkers" or "signal"`
- Consumes: `Budget`, `UsageRule` from Task 1; `SIGNALS` from `orchestrator.ts` (no cycle: `orchestrator.ts` does not import `config.ts`).
- Consumed by: Task 4 (`loadConfigIfPresent` in `saveSetup`, `parseConfig` in `GET /setup/columns` — defaults fill `usageRules` there).

- [ ] **Step 1: Write the failing tests in `test/config.test.ts`**

In `parseConfig applies defaults on top of a minimal config`, after `  assert.equal(config.promptTemplate, DEFAULT_CONFIG.promptTemplate);` add:

```ts
  assert.deepEqual(config.usageRules, []);
  assert.equal(config.budget, undefined);
```

Append after `parseConfig rejects missing or wrong-typed fields with the field name`:

```ts
test('parseConfig reads budget and usageRules as written', () => {
  const usageRules = [{ percent: 50, maxWorkers: 4 }, { percent: 80, signal: 'yellow' }, { percent: 90, maxWorkers: 0, signal: 'red' }];
  const config = parseConfig({ board: GITHUB, budget: { maxTokensPerHour: 2_000_000 }, usageRules });
  assert.deepEqual(config.budget, { maxTokensPerHour: 2_000_000 });
  assert.deepEqual(config.usageRules, usageRules);
  assert.deepEqual(parseConfig({ board: GITHUB, budget: {} }).budget, {});
  assert.deepEqual(parseConfig({ board: GITHUB, budget: { maxTokensPerDay: 5 } }).budget, { maxTokensPerDay: 5 });
});

test('parseConfig rejects bad usage rules and budgets naming the field', () => {
  const rules = (usageRules: unknown) => () => parseConfig({ board: GITHUB, usageRules });
  assert.throws(rules('x'), /"usageRules" must be an array/);
  assert.throws(rules([5]), /"usageRules\[0\]" must be an object/);
  assert.throws(rules([{ percent: 101, signal: 'red' }]), /"usageRules\[0\]\.percent" must be an integer from 0 to 100/);
  assert.throws(rules([{ percent: -1, signal: 'red' }]), /usageRules\[0\]\.percent/);
  assert.throws(rules([{ percent: 1.5, signal: 'red' }]), /usageRules\[0\]\.percent/);
  assert.throws(rules([{ signal: 'red' }]), /usageRules\[0\]\.percent/);
  assert.throws(rules([{ percent: 50, signal: 'blue' }]), /"usageRules\[0\]\.signal" must be one of: green, yellow, red/);
  assert.throws(rules([{ percent: 50, maxWorkers: -1 }]), /usageRules\[0\]\.maxWorkers/);
  assert.throws(rules([{ percent: 50, signal: 'red' }, { percent: 60 }]), /"usageRules\[1\]" must set "maxWorkers" or "signal"/);
  assert.throws(() => parseConfig({ board: GITHUB, budget: 5 }), /"budget" must be an object/);
  assert.throws(() => parseConfig({ board: GITHUB, budget: { maxTokensPerHour: 1.5 } }), /budget\.maxTokensPerHour/);
  assert.throws(() => parseConfig({ board: GITHUB, budget: { maxTokensPerDay: '1' } }), /budget\.maxTokensPerDay/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: `parseConfig reads budget and usageRules as written` fails on the first assertion (`undefined` budget: the field is not read); `parseConfig rejects bad usage rules…` fails on the first `assert.throws` (nothing throws).

- [ ] **Step 3: Edit `src/config.ts`**

Replace line 3 (the types import) with:

```ts
import { SIGNALS } from './orchestrator.js';
import type { BoardConfig, Budget, Config, Signal, StatusKey, UsageRule } from './types.js';
```

After `const MARKDOWN_CELL_BREAKERS = …;` add:

```ts
const PERCENT_MAX = 100;
const BUDGET_WINDOWS = ['maxTokensPerHour', 'maxTokensPerDay'] as const;
```

After `function optional<T>(…) { … }` add:

```ts
function requireSignal(value: unknown, field: string): Signal {
  if (!SIGNALS.includes(value as Signal)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${SIGNALS.join(', ')}`);
  return value as Signal;
}

// Only the windows present in the file end up in the object, so `{}` stays `{}` and JSON round-trips unchanged.
function parseBudget(raw: unknown): Budget {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "budget" must be an object`);
  return Object.fromEntries(
    BUDGET_WINDOWS.filter((window) => raw[window] !== undefined).map((window) => [window, requireInt(raw[window], `budget.${window}`)]),
  ) as Budget;
}

function parseUsageRule(raw: unknown, field: string): UsageRule {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  const percent = requireInt(raw.percent, `${field}.percent`);
  if (percent > PERCENT_MAX) throw new Error(`${CONFIG_FILE}: "${field}.percent" must be an integer from 0 to ${PERCENT_MAX}`);
  const maxWorkers = raw.maxWorkers === undefined ? undefined : requireInt(raw.maxWorkers, `${field}.maxWorkers`);
  const signal = raw.signal === undefined ? undefined : requireSignal(raw.signal, `${field}.signal`);
  if (maxWorkers === undefined && signal === undefined) throw new Error(`${CONFIG_FILE}: "${field}" must set "maxWorkers" or "signal"`);
  return { percent, ...(maxWorkers === undefined ? {} : { maxWorkers }), ...(signal === undefined ? {} : { signal }) };
}

function parseUsageRules(raw: unknown): UsageRule[] {
  if (!Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: "usageRules" must be an array`);
  return raw.map((rule, i) => parseUsageRule(rule, `usageRules[${i}]`));
}
```

In the object returned by `parseConfig`, replace the temporary `    usageRules: DEFAULT_CONFIG.usageRules,` line (from Task 1) with:

```ts
    ...(raw.budget === undefined ? {} : { budget: parseBudget(raw.budget) }),
    usageRules: optional(raw.usageRules, DEFAULT_CONFIG.usageRules, parseUsageRules),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 127 tests PASS (`config` 10). `config.ts` lands around 150 lines; `parseConfig` stays under 40.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): parse and validate budget and usageRules"
```

---

### Task 4: Server — the live config is the policy, and it survives `POST /setup` (TDD)

**Files:**
- Modify: `src/server.ts`
- Test: `test/setup.test.ts`

**Interfaces:**
- `dispatch(event)` calls `reduce(live.state, event, live.runtime.config)` — `Config` satisfies `UsagePolicy`, no cast, no adapter.
- `saveSetup` passes `budget: current?.budget` and `usageRules: current?.usageRules` to `parseConfig`, so a re-setup from the form (which has no field for them) keeps both, exactly as it keeps `port` and `claudeArgs`. Without this line, the first "salvar" after adding the table to the file would silently erase it (`saveSetup` picks fields one by one, it does not spread the current file).
- No new route. `GET /setup` already returns `live.runtime.config`, which is how the test observes that the runtime — and therefore `dispatch` — holds the rules.
- Consumes: `reduce` from Task 2, `parseConfig` from Task 3.

- [ ] **Step 1: Write the failing test — append to `test/setup.test.ts`**

```ts
test('a second POST /setup preserves budget and usageRules from the file and the live config carries them', async (t) => {
  const { base, repo } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  const saved = JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  assert.deepEqual(saved.usageRules, [], 'the default is written out');
  assert.equal(saved.budget, undefined);
  const budget = { maxTokensPerHour: 1000 };
  const usageRules = [{ percent: 50, maxWorkers: 1 }, { percent: 90, signal: 'red' }];
  await writeFile(configFile(repo), JSON.stringify({ ...saved, budget, usageRules }));
  assert.equal((await postSetup(base, { ...BODY, status: { ...BODY.status, queue: 'Done' } })).status, 200);
  const rewritten = JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  assert.equal(rewritten.status.queue, 'Done');
  assert.deepEqual(rewritten.budget, budget);
  assert.deepEqual(rewritten.usageRules, usageRules);
  const info = await json<SetupInfo>(fetch(`${base}/setup`));
  assert.deepEqual(info.config?.budget, budget);
  assert.deepEqual(info.config?.usageRules, usageRules);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: the new test fails at `assert.deepEqual(rewritten.budget, budget)` (`undefined`: `saveSetup` rebuilt the file without it).

- [ ] **Step 3: Edit `src/server.ts`**

In `dispatch`, replace `    const result = reduce(live.state, event);` with:

```ts
    const result = reduce(live.state, event, live.runtime.config); // Config satisfies UsagePolicy: budget and usageRules ride along
```

In `saveSetup`, replace the `parseConfig({ … })` call with:

```ts
      config = parseConfig({
        board: body.board,
        status: body.status,
        maxConcurrent: body.maxConcurrent,
        port: current?.port,
        claudeArgs: current?.claudeArgs,
        promptTemplate: promptTemplateFrom(body, current),
        budget: current?.budget, // not in the form: both come from the file, like port and claudeArgs
        usageRules: current?.usageRules,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 128 tests PASS (`setup` 20).

- [ ] **Step 5: Headless check of the seam (manual, markdown board, `maxConcurrent: 0`, no gh)**

In a scratch directory (outside the repo): create a git repo with a `board.md` (`| id | título | status |` table, one row in `Ready`) and a `hive.config.json` with the markdown board, `maxConcurrent: 0`, the budget and the four rules from the spec. Run `pnpm run:headless <scratch>`; `curl -s localhost:47821/setup` echoes the four rules. Stop it, change the first rule's `percent` to `150`, run again: the boot fails with `hive.config.json: "usageRules[0].percent" must be an integer from 0 to 100` and a non-zero exit.

- [ ] **Step 6: Acceptance per the spec's "Critério de pronto" (manual, real workers, GitHub or markdown board)**

Use a repo with `máx. workers = 2`, 3 tasks in the queue column, and the config block above (budget and the four rules). Item 5 does not exist yet, so `usage` is written by hand into `.hive/state.json` while the Hive is closed.

1. Close the Hive. Edit `.hive/state.json` and add `"usage": { "tokensLastHour": 1700000, "tokensLastDay": 0 }` (85%: yellow, cap 3). Run `pnpm start <repo>`: the header still reads `máx. workers 2` and the signal buttons still show `green` active (the manual signal is untouched; the meter is item 5), but no new job opens — the 3 tasks stay in the queue panel. Kill nothing; if a worker was alive before the restart it keeps running to the end. Close the Hive, set `"usage": { "tokensLastHour": 0, "tokensLastDay": 0 }`, reopen: two workers start at once.
2. With two workers alive, close the Hive, set `tokensLastHour` to `1100000` (55%: cap 4 → effective cap `min(2, 4) = 2`, nothing changes) then `1900000` (95%: red, cap 3). Reopen with the latter: both cards stay as they were, no `drenando`; when a worker's turn ends its card reads `… · pausado` and `pausado: sinal red`. Click `green` in the header: the mark stays (dynamic red wins). Close, zero `usage`, reopen: the marks are gone and the queue is pulled.
3. Remove `budget` and `usageRules` from `hive.config.json` (or leave `usage` absent in `state.json`): everything behaves exactly as in item 4, including the three signal buttons.
4. `pnpm test`: 128 tests PASS.

Set `máx. workers` to 0 and kill the remaining workers before closing.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts test/setup.test.ts
git commit -m "feat(server): pass the live config as the usage policy and keep budget/usageRules across setup"
```
