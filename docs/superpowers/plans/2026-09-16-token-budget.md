# Agent Hive — orçamento de tokens: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The orchestrator learns how many tokens each worker spends and respects a budget. Every `Stop` / `SessionEnd` hook carries the worker's `transcript_path`; the server sums the tokens in that file, the reducer stores the delta since the worker's previous turn as one sample in `State.usage`, and `fill` opens a new job only when there is a free slot **and** budget left (`maxTokensPerHour` / `maxTokensPerDay` in `hive.config.json`). The dashboard shows `tokens: 12.3k/h · 240.0k/dia` with a native `<meter>` per configured limit, ` · sem orçamento` in red when the budget is gone, and ` · 34.1k tokens` on each occupied card. It is the base for the dynamic signal (roadmap 6).

**Architecture:** `src/usage.ts` (new) holds every pure rule: `parseUsageLine` (one transcript line → `{ id, tokens }`), `sumTranscriptTokens` (`node:readline` over `createReadStream`, dedupe by `message.id`), `usageTotals` / `hasBudget` / `pruneUsage` over `UsageSample[]`, and `isTranscriptPath`. `State.usage` (last 24 h, oldest first) and `State.budget` are new reducer fields; `Slot.tokens` is the session total at the last turn end, so the next delta is measured against it. `fill` gains a second gate next to `canStart`: `hasBudget(state.usage, state.budget, Date.now())`. A `hook` event may carry `tokens` (only the server sets it, only on `Stop` / `SessionEnd`, only after `isTranscriptPath` and an occupied slot match); `applyHook` records the sample before the event itself applies. `Config.budget` is validated by `config.ts`, written by `POST /setup`, and copied to `State.budget` by a `setBudget` event in `configure` / `reconfigure`, the way `maxConcurrent` already goes through `setMax`. `loadState` normalizes old files (`usage` → `[]`, `budget` → `{}`). The budget reopens by itself: the 30 s `poll` already calls `fill` and old samples leave the window.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`, `node:readline`.

**Spec:** `docs/superpowers/specs/2026-09-16-token-budget-design.md` (extends `docs/superpowers/specs/2026-09-15-agent-hive-design.md` and `docs/superpowers/specs/2026-09-16-signal-design.md`).

## Global Constraints

- All v1, setup, boards and signal constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts`, `run.ts`, `hive.ts`, `hooks-settings.ts`, `spawn.ts`, `board.ts`, `src/boards/*` do not change. Hooks settings, spawn and board adapters are untouched; `hooks.json` already posts every event with `transcript_path` in the body.
- The budget lives in `Config.budget` (file and setup form) and is copied to `State.budget` only by the `setBudget` event; usage lives only in `State.usage` / `Slot.tokens` (persisted by the existing `saveState`), never in the config.
- `fill` stays the only place a `spawn` effect is created; `hasBudget` is its second gate next to `canStart`. No other reducer branch reads `budget`; only `applyHook` (via `recordUsage`) writes `usage`.
- Only the server puts `tokens` on a `hook` event, only for `Stop` / `SessionEnd`, only when `isTranscriptPath(payload.transcript_path)` holds and `x-hive-worker` matches a slot with `status !== 'vazio'`. A read error means the hook goes through without `tokens`. Transcript content never leaves the process: only the number does.
- `sumTranscriptTokens` reads the whole file line by line on every turn end (`node:readline` over `createReadStream`), with a `ponytail:` comment naming the offset-tailing upgrade path. No `ccusage`, no new runtime dependency.
- Every Portuguese UI string is exactly as the spec writes it: `tokens: <hora>/h · <dia>/dia`, ` · sem orçamento`, ` · <n> tokens`, `tokens por hora`, `tokens por dia`, `vazio = sem limite`. Numbers: integer below 1000, `k` with one decimal up to `999.9k`, `M` with one decimal above (`842`, `12.3k`, `1.2M`). Code comments in English.
- ESM with `.js` import extensions; functions under 50 lines; new and touched files stay under 400 lines except `server.ts`, which is already at 437 and grows by about 15 (splitting it is out of scope for this item).
- `test/setup.test.ts` keeps its fake factory and `maxConcurrent: 0`, so nothing spawns and no slot is ever occupied there; the transcript read itself is covered in `test/usage.test.ts`, the reducer side in `test/orchestrator.test.ts`.
- `pnpm test` must stay green after every task (115 tests today → 135 at the end).

---

## File map

| File | Change |
|---|---|
| `src/usage.ts` | new: `HOUR_MS`, `DAY_MS`, `parseUsageLine`, `sumTranscriptTokens`, `usageTotals`, `hasBudget`, `pruneUsage`, `isTranscriptPath` |
| `src/types.ts` | `Budget`, `UsageSample`, `Slot.tokens`, `State.usage` / `State.budget`, `Config.budget`, `HookPayload.transcript_path`, `SetupBody.budget`, `hook.tokens`, `setBudget` event |
| `src/config.ts` | `DEFAULT_CONFIG.budget = {}`, `parseBudget`, `budget` in `parseConfig` |
| `src/orchestrator.ts` | `initialState` with `usage: []` / `budget: {}`, `fill` gated by `hasBudget`, `setBudget`, `recordUsage` before the `applyHook` switch |
| `src/state-store.ts` | `loadState` normalizes `usage` (invalid samples dropped) and `budget` |
| `src/server.ts` | `turnTokens` for `POST /hooks/event`, `setBudget` dispatch in `configure` / `reconfigure`, `budget` in `saveSetup` |
| `src/ui/index.html` | `#usage` after `#signal`; `.over` colour; `budget-hour` / `budget-day` fields and hint in the form |
| `src/ui/app.ts` | `fmt`, `usageTotals` / `withinLimit` mirror, `renderUsage`, ` · N tokens` on the card, `openSetup` / `saveSetup` read and write `budget` |
| `test/usage.test.ts` | new: pure functions + synthetic transcript fixture (+8 → 8) |
| `test/config.test.ts` | `budget` defaults and validation (+2 → 10) |
| `test/orchestrator.test.ts` | `initialState`, `Stop` / `SessionEnd` with `tokens`, gated `poll`, `setBudget`, mutation (+7 → 47) |
| `test/state-store.test.ts` | `usage` / `budget` normalization (+1 → 5) |
| `test/setup.test.ts` | `POST /setup` with `budget`, `POST /hooks/event` `Stop` with `transcript_path` for an unknown worker (+2 → 21) |

---

### Task 1: `src/usage.ts` — pure rules and the transcript reader (TDD)

**Files:**
- Create: `src/usage.ts`
- Modify: `src/types.ts` (only `Budget` and `UsageSample`)
- Test: `test/usage.test.ts` (new)

**Interfaces:**
- Produces (in `src/types.ts`):
  - `interface Budget { maxTokensPerHour?: number; maxTokensPerDay?: number }` — absent or `0` = no limit
  - `interface UsageSample { at: string; tokens: number }` — ISO time of the turn end, delta since the worker's previous turn end
- Produces (in `src/usage.ts`):
  - `HOUR_MS = 3_600_000`, `DAY_MS = 24 * HOUR_MS`
  - `parseUsageLine(line: string): { id: string; tokens: number } | undefined` — pure; invalid JSON, non-`assistant`, missing `message.id` string or `message.usage` object → `undefined`; sums `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`, missing fields count `0`
  - `sumTranscriptTokens(path: string): Promise<number>` — readline over the file, each `message.id` counted once; rejects on a missing / unreadable file
  - `usageTotals(usage: UsageSample[], now: number): { hour: number; day: number }`
  - `hasBudget(usage: UsageSample[], budget: Budget, now: number): boolean` — a limit that is absent or `<= 0` does not restrict; otherwise `total < limit`, for both windows
  - `pruneUsage(usage: UsageSample[], now: number): UsageSample[]` — drops samples older than `DAY_MS`
  - `isTranscriptPath(value: unknown): value is string` — absolute string ending in `.jsonl`
- Consumed by: Task 3 (`hasBudget`, `pruneUsage` in `orchestrator.ts`; `HOUR_MS` in its test), Task 4 (`UsageSample` in `state-store.ts`), Task 5 (`isTranscriptPath`, `sumTranscriptTokens` in `server.ts`), Task 6 (`Budget`, `UsageSample` types in the UI).

- [ ] **Step 1: Write the failing tests — create `test/usage.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAY_MS, HOUR_MS, hasBudget, isTranscriptPath, parseUsageLine, pruneUsage, sumTranscriptTokens, usageTotals,
} from '../src/usage.js';
import type { UsageSample } from '../src/types.js';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const MINUTE_MS = 60_000;

// One assistant line in the shape Claude Code writes: the same message.id repeats once per content block of a reply.
const assistant = (id: string, usage: Record<string, unknown>, text = 'x'): string =>
  JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }], usage } });
const sample = (ageMs: number, tokens: number): UsageSample => ({ at: new Date(NOW - ageMs).toISOString(), tokens });

// Writes a synthetic transcript: one JSON object per line, like the real `.jsonl` files.
async function writeTranscript(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hive-usage-'));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, lines.map((line) => `${line}\n`).join(''));
  return path;
}

test('parseUsageLine ignores invalid JSON, non-assistant lines and assistant lines without usage or id', () => {
  assert.equal(parseUsageLine('{not json'), undefined);
  assert.equal(parseUsageLine(''), undefined);
  assert.equal(parseUsageLine('null'), undefined);
  assert.equal(parseUsageLine(JSON.stringify({ type: 'user', message: { id: 'u1', usage: { input_tokens: 5 } } })), undefined);
  assert.equal(parseUsageLine(JSON.stringify({ type: 'assistant', message: { id: 'a1' } })), undefined);
  assert.equal(parseUsageLine(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5 } } })), undefined);
  assert.equal(parseUsageLine(JSON.stringify({ type: 'assistant', message: { id: 'a1', usage: null } })), undefined);
});

test('parseUsageLine sums the four usage fields and counts missing or non-numeric ones as 0', () => {
  const full = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 };
  assert.deepEqual(parseUsageLine(assistant('a1', full)), { id: 'a1', tokens: 4330 });
  assert.deepEqual(parseUsageLine(assistant('a2', { input_tokens: 7, output_tokens: 3 })), { id: 'a2', tokens: 10 });
  assert.deepEqual(parseUsageLine(assistant('a3', {})), { id: 'a3', tokens: 0 });
  assert.deepEqual(parseUsageLine(assistant('a4', { input_tokens: 'many', output_tokens: 2 })), { id: 'a4', tokens: 2 });
});

test('sumTranscriptTokens counts each message.id once, sums distinct ids and skips every other line', async () => {
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 };
  const path = await writeTranscript([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    assistant('m1', usage, 'first block'),
    assistant('m1', usage, 'second block of the same reply'),
    JSON.stringify({ type: 'progress' }),
    'garbage line',
    assistant('m2', { input_tokens: 10, output_tokens: 5 }),
  ]);
  assert.equal(await sumTranscriptTokens(path), 1165);
});

test('sumTranscriptTokens rejects for a missing file and resolves 0 for an empty one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-usage-'));
  await assert.rejects(sumTranscriptTokens(join(dir, 'missing.jsonl')), { code: 'ENOENT' });
  assert.equal(await sumTranscriptTokens(await writeTranscript([])), 0);
});

test('usageTotals separates the last hour from the last day', () => {
  const usage = [
    sample(30 * MINUTE_MS, 100), sample(59 * MINUTE_MS, 20), sample(61 * MINUTE_MS, 1000),
    sample(23 * HOUR_MS, 5000), sample(25 * HOUR_MS, 70_000),
  ];
  assert.deepEqual(usageTotals(usage, NOW), { hour: 120, day: 6120 });
  assert.deepEqual(usageTotals([], NOW), { hour: 0, day: 0 });
});

test('hasBudget: an absent or 0 limit never restricts; an exhausted hour or day limit does', () => {
  const usage = [sample(10 * MINUTE_MS, 900), sample(5 * HOUR_MS, 4000)]; // hour 900, day 4900
  assert.equal(hasBudget(usage, {}, NOW), true);
  assert.equal(hasBudget(usage, { maxTokensPerHour: 0, maxTokensPerDay: 0 }, NOW), true);
  assert.equal(hasBudget(usage, { maxTokensPerHour: 901, maxTokensPerDay: 4901 }, NOW), true);
  assert.equal(hasBudget(usage, { maxTokensPerHour: 900 }, NOW), false, 'hour exactly at the limit');
  assert.equal(hasBudget(usage, { maxTokensPerHour: 500 }, NOW), false);
  assert.equal(hasBudget(usage, { maxTokensPerHour: 5000, maxTokensPerDay: 4900 }, NOW), false, 'hour ok, day exhausted');
  assert.equal(hasBudget([], { maxTokensPerHour: 1, maxTokensPerDay: 1 }, NOW), true);
});

test('pruneUsage drops samples older than 24 h and keeps the rest in order', () => {
  const fresh = sample(0, 1);
  const hourOld = sample(HOUR_MS, 2);
  const edge = sample(DAY_MS, 3);
  const old = sample(DAY_MS + 1, 4);
  assert.deepEqual(pruneUsage([old, fresh, hourOld, edge], NOW), [fresh, hourOld, edge]);
  assert.deepEqual(pruneUsage([], NOW), []);
});

test('isTranscriptPath accepts only an absolute string ending in .jsonl', () => {
  assert.equal(isTranscriptPath('/Users/x/.claude/projects/p/abc.jsonl'), true);
  assert.equal(isTranscriptPath('relative/abc.jsonl'), false);
  assert.equal(isTranscriptPath('/Users/x/abc.json'), false);
  assert.equal(isTranscriptPath('/Users/x/abc.jsonl/'), false);
  assert.equal(isTranscriptPath(''), false);
  assert.equal(isTranscriptPath(undefined), false);
  assert.equal(isTranscriptPath(42), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `Cannot find module '../src/usage.js'`, `'"../src/types.js"' has no exported member 'UsageSample'`.

- [ ] **Step 3: Edit `src/types.ts` — add the two types**

After `export type Signal = 'green' | 'yellow' | 'red';` add:

```ts
export interface Budget {
  maxTokensPerHour?: number; // absent or 0 = no limit
  maxTokensPerDay?: number;
}

export interface UsageSample {
  at: string; // ISO, when the Stop / SessionEnd arrived
  tokens: number; // delta since the worker's previous turn end
}
```

- [ ] **Step 4: Create `src/usage.ts`**

```ts
import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import type { Budget, UsageSample } from './types.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

// The four fields whose sum is ccusage's "Total Tokens", so the number the user sees here matches the one they know.
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;

interface TranscriptLine {
  type?: unknown;
  message?: { id?: unknown; usage?: Record<string, unknown> | null };
}

/** One transcript line → its usage, or nothing. The same `message.id` repeats once per content block; the caller dedupes. */
export function parseUsageLine(line: string): { id: string; tokens: number } | undefined {
  let parsed: TranscriptLine | null;
  try {
    parsed = JSON.parse(line) as TranscriptLine | null;
  } catch {
    return undefined;
  }
  if (parsed?.type !== 'assistant') return undefined;
  const message = parsed.message;
  const usage = message?.usage;
  if (typeof message?.id !== 'string' || typeof usage !== 'object' || usage === null) return undefined;
  const tokens = USAGE_FIELDS.reduce((sum, field) => {
    const value = usage[field];
    return sum + (typeof value === 'number' ? value : 0);
  }, 0);
  return { id: message.id, tokens };
}

/**
 * Sums the tokens of every assistant message in a Claude Code transcript, counting each `message.id` once.
 * Rejects when the file cannot be opened or read; the server treats that as "no tokens this turn".
 * ponytail: reads the whole file at every turn end; if transcripts ever weigh, keep a byte offset per slot and tail from it.
 */
export function sumTranscriptTokens(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const seen = new Set<string>();
    let total = 0;
    const input = createReadStream(path);
    input.on('error', reject);
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const usage = parseUsageLine(line);
      if (!usage || seen.has(usage.id)) return;
      seen.add(usage.id);
      total += usage.tokens;
    });
    lines.on('close', () => resolve(total));
  });
}

export function usageTotals(usage: UsageSample[], now: number): { hour: number; day: number } {
  return usage.reduce((totals, { at, tokens }) => {
    const age = now - Date.parse(at);
    return { hour: totals.hour + (age < HOUR_MS ? tokens : 0), day: totals.day + (age < DAY_MS ? tokens : 0) };
  }, { hour: 0, day: 0 });
}

const withinLimit = (total: number, limit: number | undefined): boolean => limit === undefined || limit <= 0 || total < limit;

/** The budget gate `fill` consults next to `canStart`: both windows under their limit (an absent or 0 limit never restricts). */
export function hasBudget(usage: UsageSample[], budget: Budget, now: number): boolean {
  const { hour, day } = usageTotals(usage, now);
  return withinLimit(hour, budget.maxTokensPerHour) && withinLimit(day, budget.maxTokensPerDay);
}

export function pruneUsage(usage: UsageSample[], now: number): UsageSample[] {
  return usage.filter((s) => now - Date.parse(s.at) <= DAY_MS);
}

/** Any local process can hit /hooks/event: only an absolute `.jsonl` path is ever opened. */
export function isTranscriptPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && value.endsWith('.jsonl');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 123 tests PASS (`usage` 8; nothing else changed).

- [ ] **Step 6: Commit**

```bash
git add src/usage.ts src/types.ts test/usage.test.ts
git commit -m "feat: usage module — transcript token sum, usage windows and hasBudget"
```

---

### Task 2: Types and config — `Config.budget` (TDD)

**Files:**
- Modify: `src/types.ts`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `Config.budget: Budget`, `SetupBody.budget?: Budget`
- Produces (in `src/config.ts`): `DEFAULT_CONFIG.budget = {}`; `parseConfig` accepts an optional `budget` object whose `maxTokensPerHour` / `maxTokensPerDay` are non-negative integers (`requireInt`, message `hive.config.json: "budget.maxTokensPerHour" must be a non-negative integer`); a non-object → `hive.config.json: "budget" must be an object`; absent keys stay absent (never become `0`).
- Consumed by: Task 5 (`saveSetup`, `configure`, `reconfigure`), Task 6 (`openSetup`, `saveSetup` in the UI).

- [ ] **Step 1: Write the failing tests in `test/config.test.ts`**

In `parseConfig applies defaults on top of a minimal config`, after `assert.equal(config.promptTemplate, DEFAULT_CONFIG.promptTemplate);` add:

```ts
  assert.deepEqual(config.budget, {});
```

Append at the end of the file:

```ts
test('parseConfig reads budget, leaves absent limits absent and defaults to {}', () => {
  assert.deepEqual(parseConfig({ board: GITHUB }).budget, {});
  assert.deepEqual(parseConfig({ board: GITHUB, budget: {} }).budget, {});
  assert.deepEqual(parseConfig({ board: GITHUB, budget: { maxTokensPerHour: 50_000 } }).budget, { maxTokensPerHour: 50_000 });
  assert.deepEqual(
    parseConfig({ board: GITHUB, budget: { maxTokensPerHour: 0, maxTokensPerDay: 1_000_000 } }).budget,
    { maxTokensPerHour: 0, maxTokensPerDay: 1_000_000 },
  );
});

test('parseConfig rejects a budget that is not an object or has a non-integer limit, naming the field', () => {
  assert.throws(() => parseConfig({ board: GITHUB, budget: 5 }), { message: 'hive.config.json: "budget" must be an object' });
  assert.throws(() => parseConfig({ board: GITHUB, budget: [] }), /"budget" must be an object/);
  assert.throws(() => parseConfig({ board: GITHUB, budget: null }), /"budget" must be an object/);
  assert.throws(
    () => parseConfig({ board: GITHUB, budget: { maxTokensPerHour: 1.5 } }),
    { message: 'hive.config.json: "budget.maxTokensPerHour" must be a non-negative integer' },
  );
  assert.throws(() => parseConfig({ board: GITHUB, budget: { maxTokensPerDay: -1 } }), /budget\.maxTokensPerDay/);
  assert.throws(() => parseConfig({ board: GITHUB, budget: { maxTokensPerDay: '10' } }), /budget\.maxTokensPerDay/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error — `Property 'budget' does not exist on type 'Config'`.

- [ ] **Step 3: Edit `src/types.ts`**

Replace the `Config` interface with:

```ts
export interface Config {
  board: BoardConfig;
  status: Record<StatusKey, string>;
  maxConcurrent: number;
  port: number;
  claudeArgs: string[];
  promptTemplate: string;
  budget: Budget; // copied to State.budget by setBudget on configure / reconfigure
}
```

In `SetupBody`, after the `promptTemplate?: string;` line add:

```ts
  /** The form always sends it (empty field = key absent); an API caller that omits it keeps the current budget. */
  budget?: Budget;
```

- [ ] **Step 4: Edit `src/config.ts`**

Replace the types import with:

```ts
import type { BoardConfig, Budget, Config, StatusKey } from './types.js';
```

In `DEFAULT_CONFIG`, after the `promptTemplate:` entry (the two-line string) add:

```ts
  budget: {},
```

After `const MARKDOWN_CELL_BREAKERS = …;` add:

```ts
const BUDGET_KEYS = ['maxTokensPerHour', 'maxTokensPerDay'] as const;
```

After `boardFrom` (before `export function parseConfig`) add:

```ts
// Absent keys stay absent (never become 0) so a hive.config.json without limits stays clean.
function parseBudget(raw: unknown): Budget {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "budget" must be an object`);
  return Object.fromEntries(
    BUDGET_KEYS.flatMap((key) => (raw[key] === undefined ? [] : [[key, requireInt(raw[key], `budget.${key}`)]])),
  ) as Budget;
}
```

In the object `parseConfig` returns, after the `promptTemplate:` line add:

```ts
    budget: optional(raw.budget, DEFAULT_CONFIG.budget, parseBudget),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 125 tests PASS (`config` 10). `setup` still passes: the config written by `POST /setup` now carries `"budget": {}` and `{ ...DEFAULT_CONFIG, ...BODY }` carries the same.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "feat: budget in hive.config.json (maxTokensPerHour / maxTokensPerDay)"
```

---

### Task 3: Orchestrator — `usage` / `budget` in the state, `fill` gated by `hasBudget`, `recordUsage`, `setBudget` (TDD)

**Files:**
- Modify: `src/types.ts`, `src/orchestrator.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`):
  - `Slot.tokens?: number` — session total at the last `Stop` / `SessionEnd`
  - `State.usage: UsageSample[]`, `State.budget: Budget`
  - `HookPayload.transcript_path?: string`
  - `HiveEvent`: `hook` gains `tokens?: number`; new `{ type: 'setBudget'; budget: Budget }`
- Produces (in `src/orchestrator.ts`):
  - `initialState(max)` returns `usage: []`, `budget: {}`
  - `fill` returns its input untouched when `!canStart(...) || !hasBudget(state.usage, state.budget, Date.now())`
  - `reduce` handles `setBudget`: `{ ...state, budget }` then `fill`
  - `applyHook` with `tokens !== undefined` first runs `recordUsage`: `Slot.tokens = tokens`; delta `= tokens >= (slot.tokens ?? 0) ? tokens - (slot.tokens ?? 0) : tokens`; delta `> 0` appends `{ at: now, tokens: delta }` and prunes; then the switch runs on the updated state
- Consumes: `hasBudget`, `pruneUsage` from Task 1.
- Consumed by: Task 4 (`UsageSample` guard in `state-store.ts`), Task 5 (`setBudget`, `tokens` on `hook`), Task 6 (`State.usage`, `State.budget`, `Slot.tokens`).

- [ ] **Step 1: Write the failing tests in `test/orchestrator.test.ts`**

Replace the two imports (lines 3–4) with:

```ts
import { canStart, extractPrUrl, initialState, isBlocked, reduce, slugFor } from '../src/orchestrator.js';
import { HOUR_MS } from '../src/usage.js';
import type { Budget, HookPayload, Signal, State, Task } from '../src/types.js';
```

After the `stopped` helper add:

```ts
const counted = (state: State, workerId: string, tokens: number) =>
  reduce(state, { type: 'hook', workerId, payload: { hook_event_name: 'Stop' }, tokens }).state;
// One free slot, one usage sample of `tokens` aged `ageMs`, under `budget`.
const spent = (tokens: number, ageMs: number, budget: Budget): State => ({
  ...initialState(1), budget, usage: [{ at: new Date(Date.now() - ageMs).toISOString(), tokens }],
});
```

Append to the end of the `reducer never mutates its input` test (after the last `assert.equal(JSON.stringify(paused), pausedSnapshot);`):

```ts
  const id = first.slots[0].workerId!;
  const spentState = counted(first, id, 700);
  const spentSnapshot = JSON.stringify(spentState);
  reduce(spentState, { type: 'hook', workerId: id, payload: { hook_event_name: 'Stop' }, tokens: 900 });
  reduce(spentState, { type: 'setBudget', budget: { maxTokensPerHour: 1 } });
  assert.equal(JSON.stringify(spentState), spentSnapshot);
```

Append after the `setSignal to green or yellow clears paused…` test (before `slugFor strips accents…`):

```ts
test('initialState starts with no usage and no budget', () => {
  const idle = initialState(1);
  assert.deepEqual(idle.usage, []);
  assert.deepEqual(idle.budget, {});
});

test('Stop with tokens records the slot total and one sample per turn with the delta', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const one = counted(first, id, 1200);
  assert.equal(one.slots[0].tokens, 1200);
  assert.equal(one.slots[0].lastEvent, 'turno encerrado');
  assert.deepEqual(one.usage.map((s) => s.tokens), [1200]);
  assert.ok(Number.isFinite(Date.parse(one.usage[0].at)), 'sample time is ISO');
  const two = counted(one, id, 1500);
  assert.equal(two.slots[0].tokens, 1500);
  assert.deepEqual(two.usage.map((s) => s.tokens), [1200, 300]);
});

test('Stop with a total below the previous one records the whole total; an equal total adds no sample', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const one = counted(first, id, 1000);
  const replaced = counted(one, id, 400); // transcript swapped: the new file starts from zero
  assert.equal(replaced.slots[0].tokens, 400);
  assert.deepEqual(replaced.usage.map((s) => s.tokens), [1000, 400]);
  const same = counted(replaced, id, 400);
  assert.equal(same.slots[0].tokens, 400);
  assert.deepEqual(same.usage.map((s) => s.tokens), [1000, 400]);
});

test('Stop without tokens and a counted hook for an unknown worker leave usage untouched', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const one = counted(first, id, 500);
  const plain = stopped(one, id);
  assert.deepEqual(plain.usage, one.usage);
  assert.equal(plain.slots[0].tokens, 500);
  const unknown = reduce(one, { type: 'hook', workerId: 'nope', payload: { hook_event_name: 'Stop' }, tokens: 999 });
  assert.deepEqual(unknown.state, one);
  assert.equal(unknown.effects.length, 0);
});

test('SessionEnd with tokens records the last turn before the slot is freed', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const one = counted(first, id, 800);
  const { state } = reduce(one, { type: 'hook', workerId: id, payload: { hook_event_name: 'SessionEnd' }, tokens: 1000 });
  assert.deepEqual(state.usage.map((s) => s.tokens), [800, 200]);
  // exit reset the slot (and fill refilled it fresh from the requeued task): no leftover total
  assert.notEqual(state.slots[0].workerId, id);
  assert.equal(state.slots[0].tokens, undefined);
});

test('poll under an exhausted hour budget queues everything; a sample outside the hour does not count', () => {
  const blocked = reduce(spent(1000, 0, { maxTokensPerHour: 1000 }), { type: 'poll', tasks: tasks(2) });
  assert.equal(occupied(blocked.state).length, 0);
  assert.deepEqual(blocked.state.queue.map((t) => t.id), ['1', '2']);
  assert.equal(blocked.effects.length, 0);
  const reopened = reduce(spent(1000, 2 * HOUR_MS, { maxTokensPerHour: 1000 }), { type: 'poll', tasks: tasks(2) });
  assert.equal(reopened.state.slots[0].task?.id, '1');
  assert.deepEqual(reopened.effects.map((e) => e.type), ['setStatus', 'spawn']);
  const dayBlocked = reduce(spent(1000, 2 * HOUR_MS, { maxTokensPerDay: 1000 }), { type: 'poll', tasks: tasks(1) });
  assert.equal(occupied(dayBlocked.state).length, 0);
});

test('setBudget stores the budget and fills a free slot only when the new limit is above the usage', () => {
  const queued = reduce(spent(1000, 0, { maxTokensPerHour: 1000 }), { type: 'poll', tasks: tasks(1) }).state;
  assert.equal(queued.slots[0].status, 'vazio');
  const lower = reduce(queued, { type: 'setBudget', budget: { maxTokensPerHour: 500, maxTokensPerDay: 500 } });
  assert.deepEqual(lower.state.budget, { maxTokensPerHour: 500, maxTokensPerDay: 500 });
  assert.equal(lower.state.slots[0].status, 'vazio');
  assert.equal(lower.effects.length, 0);
  const raised = reduce(lower.state, { type: 'setBudget', budget: { maxTokensPerHour: 5000 } });
  assert.deepEqual(raised.state.budget, { maxTokensPerHour: 5000 });
  assert.equal(raised.state.slots[0].task?.id, '1');
  assert.deepEqual(raised.effects.map((e) => e.type), ['setStatus', 'spawn']);
  const unlimited = reduce(lower.state, { type: 'setBudget', budget: {} });
  assert.equal(unlimited.state.slots[0].task?.id, '1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `Property 'usage' does not exist on type 'State'`, `Object literal may only specify known properties, and 'tokens' does not exist in type '{ type: "hook"; … }'`, `Type '"setBudget"' is not assignable to type …`.

- [ ] **Step 3: Edit `src/types.ts`**

In `Slot`, after `  paused?: boolean; …` add:

```ts
  tokens?: number; // session total at the last Stop / SessionEnd; the next delta is measured against it
```

Replace the `State` interface with:

```ts
export interface State {
  signal: Signal; // runtime gate for new jobs; lives here, not in the config, so a red set by hand survives a restart
  maxConcurrent: number;
  slots: Slot[];
  queue: Task[];
  usage: UsageSample[]; // last 24 h, oldest first; one sample per worker turn
  budget: Budget; // copied from Config.budget by setBudget
  lastPolledAt?: string;
  error?: string;
}
```

In `HookPayload`, after `  tool_response?: unknown;` add:

```ts
  transcript_path?: string; // Claude Code sends it on every hook; the server reads it only on Stop / SessionEnd
```

In `HiveEvent`, replace the `hook` line and add `setBudget` after `setSignal`:

```ts
  | { type: 'setSignal'; signal: Signal }
  | { type: 'setBudget'; budget: Budget }
  | { type: 'hook'; workerId: string; payload: HookPayload; branch?: string; tokens?: number }
```

- [ ] **Step 4: Edit `src/orchestrator.ts`**

Replace the types import (line 2) with:

```ts
import type { Effect, HiveEvent, HookPayload, Signal, Slot, State, Status, Task } from './types.js';
import { hasBudget, pruneUsage } from './usage.js';
```

Replace `initialState` with:

```ts
export function initialState(maxConcurrent: number): State {
  return {
    signal: 'green', maxConcurrent, slots: Array.from({ length: maxConcurrent }, emptySlot), queue: [], usage: [], budget: {},
  };
}
```

In `reduce`, replace the `setSignal` and `hook` cases with:

```ts
    case 'setSignal': return fill(setSignal(state, event.signal));
    case 'setBudget': return fill(none({ ...state, budget: event.budget })); // raising the limit can open a job right away
    case 'hook': return applyHook(state, event.workerId, event.payload, event.branch, event.tokens);
```

In `fill`, replace the `canStart` line with:

```ts
  // yellow / red or no budget left: whatever happened stands, nothing new starts
  if (!canStart(state.signal, state.slots) || !hasBudget(state.usage, state.budget, Date.now())) return reduced;
```

After `activeStatus` (before `applyHook`) add:

```ts
// One sample per turn: the delta against the total seen at this worker's previous turn end. A smaller total means the
// transcript was replaced, so the whole new total counts. A delta of 0 adds nothing; pruning happens on insert.
function recordUsage(state: State, slot: Slot, tokens: number): State {
  const previous = slot.tokens ?? 0;
  const delta = tokens >= previous ? tokens - previous : tokens;
  const now = new Date();
  const slots = state.slots.map((s) => (s.workerId === slot.workerId ? { ...s, tokens } : s));
  const usage = delta > 0 ? pruneUsage([...state.usage, { at: now.toISOString(), tokens: delta }], now.getTime()) : state.usage;
  return { ...state, slots, usage };
}
```

Replace the head of `applyHook` (the signature and its first two lines, through `if (!slot || …) return none(state);`) with:

```ts
function applyHook(initial: State, workerId: string, p: HookPayload, branch?: string, tokens?: number): Reduced {
  const slot = initial.slots.find((s) => s.workerId === workerId);
  if (!slot || slot.status === 'vazio') return none(initial);
  // Only the server sets `tokens` (Stop / SessionEnd): the sample lands first, then the event applies on top of it
  const state = tokens === undefined ? initial : recordUsage(initial, slot, tokens);
```

The `switch` and every case stay as they are: they keep using `state` (now the counted one) and `slot` (whose `prUrl` / `task` the count does not touch).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 132 tests PASS (`orchestrator` 47; `state-store` and `setup` still pass because `initialState` now carries `usage` / `budget` and nothing asserts their absence).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat: usage samples per worker turn and hasBudget gate in fill"
```

---

### Task 4: State store — `loadState` normalizes `usage` and `budget` (TDD)

**Files:**
- Modify: `src/state-store.ts`
- Test: `test/state-store.test.ts`

**Interfaces:**
- Produces (in `src/state-store.ts`): `loadState(hiveDir, maxConcurrent)` — a file without `usage` or with a non-array loads `usage: []`; samples whose `at` is not a string or whose `tokens` is not a finite number are dropped; a missing `budget` loads `{}`. `saveState` unchanged (both fields are part of `State`).
- Consumes: `UsageSample` (Task 1), `State.usage` / `State.budget` (Task 3).
- Consumed by: `server.ts` `configure()` (unchanged caller; criterion 3 "reopen with usage" comes from here).

- [ ] **Step 1: Write the failing test — append to `test/state-store.test.ts`**

```ts
test('loadState reads missing usage and budget as empty, keeps valid samples and drops malformed ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const legacy = { signal: 'green', maxConcurrent: 1, slots: [], queue: [] }; // written before the budget existed
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
  const loaded = await loadState(dir, 1);
  assert.deepEqual(loaded.usage, []);
  assert.deepEqual(loaded.budget, {});
  const valid = { at: '2026-09-16T12:00:00.000Z', tokens: 1200 };
  const usage = [valid, { at: 5, tokens: 1 }, { at: '2026-09-16T12:00:00.000Z' }, { at: 'x', tokens: 'many' }, null, 7];
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usage, budget: { maxTokensPerHour: 10 } }));
  const kept = await loadState(dir, 1);
  assert.deepEqual(kept.usage, [valid]);
  assert.deepEqual(kept.budget, { maxTokensPerHour: 10 });
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...legacy, usage: 'nope' }));
  assert.deepEqual((await loadState(dir, 1)).usage, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: the new test fails on `assert.deepEqual(loaded.usage, [])` (`undefined` is returned as parsed).

- [ ] **Step 3: Rewrite `src/state-store.ts`**

```ts
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState, SIGNALS } from './orchestrator.js';
import type { Signal, State, UsageSample } from './types.js';

const STATE_FILE = 'state.json';

const isSignal = (value: unknown): value is Signal => SIGNALS.includes(value as Signal);
const isSample = (value: unknown): value is UsageSample =>
  typeof value === 'object' && value !== null
  && typeof (value as UsageSample).at === 'string' && Number.isFinite((value as UsageSample).tokens);

// Files written before the signal or the budget existed lack these fields; anything unknown reads as the default.
function normalize(parsed: State): State {
  return {
    ...parsed,
    signal: isSignal(parsed.signal) ? parsed.signal : 'green',
    usage: Array.isArray(parsed.usage) ? parsed.usage.filter(isSample) : [],
    budget: parsed.budget ?? {},
  };
}

export async function loadState(hiveDir: string, maxConcurrent: number): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(join(hiveDir, STATE_FILE), 'utf8')) as State;
    if (Array.isArray(parsed.slots) && Array.isArray(parsed.queue) && Number.isInteger(parsed.maxConcurrent)) {
      return normalize(parsed);
    }
  } catch {
    // missing or corrupt: start fresh
  }
  return initialState(maxConcurrent);
}

export async function saveState(hiveDir: string, state: State): Promise<void> {
  const path = join(hiveDir, STATE_FILE);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 133 tests PASS (`state-store` 5; the round-trip test still holds because `initialState` writes `usage: []` and `budget: {}`).

- [ ] **Step 5: Commit**

```bash
git add src/state-store.ts test/state-store.test.ts
git commit -m "feat: loadState normalizes usage and budget from older state files"
```

---

### Task 5: Server — transcript read on `Stop` / `SessionEnd`, `setBudget` on configure, `budget` in setup (TDD)

**Files:**
- Modify: `src/server.ts`
- Test: `test/setup.test.ts`

**Interfaces:**
- `POST /hooks/event`: unchanged contract (answers 200 first). If `hook_event_name` is `Stop` or `SessionEnd`, `isTranscriptPath(payload.transcript_path)` and `x-hive-worker` matches a slot with `status !== 'vazio'`, the handler awaits `sumTranscriptTokens(path).catch(() => undefined)` and puts the result on the `hook` event as `tokens`. Any other case dispatches without `tokens`, as today.
- `configure(config)`: after the conditional `setMax`, `if (!isDeepStrictEqual(saved.budget, config.budget)) dispatch({ type: 'setBudget', budget: config.budget })`. `reconfigure`: same against `live.state.budget`.
- `saveSetup`: `budget: body.budget ?? current?.budget` goes into `parseConfig` (the form always sends `budget`; an API caller that omits it keeps the file's).
- Consumes: `isTranscriptPath`, `sumTranscriptTokens` (Task 1), `Config.budget` (Task 2), `setBudget` / `hook.tokens` / `State.budget` (Task 3).
- Consumed by: Task 6 (`SetupBody.budget` from the form; `State.usage` / `State.budget` over SSE).

- [ ] **Step 1: Write the failing tests — append to `test/setup.test.ts`**

```ts
test('POST /setup with a budget writes it to hive.config.json, GET /setup returns it and the State carries it', async (t) => {
  const { base, repo, server } = await start(t);
  const budget = { maxTokensPerHour: 50_000, maxTokensPerDay: 400_000 };
  assert.equal((await postSetup(base, { ...BODY, budget })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).budget, budget);
  assert.deepEqual((await json<SetupInfo>(fetch(`${base}/setup`))).config?.budget, budget);
  assert.deepEqual(server.getState()?.budget, budget);
  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const streamed = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '')) as State;
  assert.deepEqual(streamed.budget, budget);
  assert.deepEqual(streamed.usage, []);
  // a save without budget keeps the file's; a save with {} clears it (the form always sends budget)
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).budget, budget);
  assert.equal((await postSetup(base, { ...BODY, budget: {} })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).budget, {});
  assert.deepEqual(server.getState()?.budget, {});
  const bad = await postSetup(base, { ...BODY, budget: { maxTokensPerHour: -5 } });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /budget\.maxTokensPerHour/);
});

test('POST /hooks/event Stop with a transcript_path for an unknown worker answers 200, reads nothing and keeps serving', async (t) => {
  const { base, repo, server } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  const transcript = join(repo, 'transcript.jsonl');
  await writeFile(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } } })}\n`);
  const postHook = (body: unknown): Promise<Response> =>
    fetch(`${base}/hooks/event`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-worker': 'ghost' }, body: JSON.stringify(body),
    });
  assert.equal((await postHook({ hook_event_name: 'Stop', transcript_path: transcript })).status, 200);
  assert.equal((await postHook({ hook_event_name: 'SessionEnd', transcript_path: join(repo, 'missing.jsonl') })).status, 200);
  assert.equal((await postHook({ hook_event_name: 'Stop', transcript_path: 'relative.jsonl' })).status, 200);
  await sleep(20); // the route answers before dispatching; let the handlers finish
  assert.deepEqual(server.getState()?.usage, [], 'no occupied slot matches, so nothing is read or recorded');
  assert.equal((await fetch(`${base}/setup`)).status, 200, 'the server is still up');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: the first new test fails at `assert.deepEqual(… .budget, budget)` (`{}` !== the posted budget: `saveSetup` does not pass it to `parseConfig`). The second passes already (it pins the "never reads for an unknown worker" path so step 3 cannot regress it).

- [ ] **Step 3: Edit `src/server.ts`**

After `import { loadState, saveState } from './state-store.js';` add:

```ts
import { isTranscriptPath, sumTranscriptTokens } from './usage.js';
```

After `const SIGNAL_MESSAGE = …;` add:

```ts
const TURN_END_EVENTS: readonly string[] = ['Stop', 'SessionEnd']; // the only stable points to read a transcript
```

Inside `createServer`, after `resolveBranch` add:

```ts
  // Reads the transcript only at a turn end, only for a worker this Hive spawned, and only an absolute `.jsonl`:
  // any local process can hit /hooks/event, and the worst case here is reading a `.jsonl` and discarding it.
  async function turnTokens(workerId: string, payload: HookPayload): Promise<number | undefined> {
    if (!TURN_END_EVENTS.includes(payload.hook_event_name) || !isTranscriptPath(payload.transcript_path)) return undefined;
    const slot = live?.state.slots.find((s) => s.workerId === workerId);
    if (!slot || slot.status === 'vazio') return undefined;
    return sumTranscriptTokens(payload.transcript_path).catch(() => undefined); // unreadable: the hook goes through without tokens
  }
```

In `configure`, after the `setMax` line add:

```ts
    if (!isDeepStrictEqual(saved.budget, config.budget)) await dispatch({ type: 'setBudget', budget: config.budget });
```

In `reconfigure`, after the `setMax` line add:

```ts
    if (!isDeepStrictEqual(live.state.budget, config.budget)) await dispatch({ type: 'setBudget', budget: config.budget });
```

In the `/hooks/event` handler, replace the last two lines (`const branch = …` and the `dispatch`) with:

```ts
    const branch = payload.hook_event_name === 'SessionStart' && payload.cwd ? await resolveBranch(payload.cwd) : undefined;
    const tokens = await turnTokens(workerId, payload);
    await dispatch({ type: 'hook', workerId, payload, branch, tokens });
```

In `saveSetup`, inside the `parseConfig({ … })` call, after `promptTemplate: promptTemplateFrom(body, current),` add:

```ts
        budget: body.budget ?? current?.budget,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 135 tests PASS (`setup` 21).

- [ ] **Step 5: Headless check (manual, markdown board, `maxConcurrent: 0`, no gh)**

```bash
rm -rf /tmp/hive-budget-repo && mkdir /tmp/hive-budget-repo && git -C /tmp/hive-budget-repo init -q
printf '| id | título | status |\n|---|---|---|\n| T-1 | Exemplo | Ready |\n' > /tmp/hive-budget-repo/board.md
printf '{ "board": { "type": "markdown", "path": "board.md" }, "maxConcurrent": 0, "budget": { "maxTokensPerHour": 50000 } }\n' > /tmp/hive-budget-repo/hive.config.json
pnpm build && node dist/src/run.js /tmp/hive-budget-repo &
sleep 1
curl -s -N --max-time 1 localhost:47821/events | head -c 300; echo
curl -s -X POST localhost:47821/hooks/event -H 'content-type: application/json' -H 'x-hive-worker: ghost' -d '{"hook_event_name":"Stop","transcript_path":"/nope.jsonl"}'; echo
grep -A2 '"budget"' /tmp/hive-budget-repo/.hive/state.json
kill %1
```
Expected, in order: the first SSE line carries `"usage":[]` and `"budget":{"maxTokensPerHour":50000}`; `OK` (200) for the ghost hook and no error on the server's stderr; `state.json` has `"budget": { "maxTokensPerHour": 50000 }`.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/setup.test.ts
git commit -m "feat: server reads the transcript at turn end and copies the budget into the state"
```

---

### Task 6: Dashboard — usage meter in the header, tokens on the card, budget fields in the setup form

**Files:**
- Modify: `src/ui/index.html`, `src/ui/app.ts`

**Interfaces:**
- Consumes (type-only): `Budget`, `UsageSample`, `State.usage`, `State.budget`, `Slot.tokens`, `SetupBody.budget`, `Config.budget`; `POST /setup` from Task 5.
- DOM ids added: `usage` (span after `#signal`), `budget-hour`, `budget-day` (number inputs after `máx. workers`). CSS: `#usage`, `#usage.over`.
- `app.ts` mirrors `usageTotals` / `withinLimit` in a few lines: it cannot import `src/usage.ts` (it pulls `node:fs` into the browser), same reason `PRESELECT` mirrors `DEFAULT_CONFIG`.
- No automated test: the UI is not a test target; `pnpm test` only checks it type-checks under `strict`. Manual checks below.

- [ ] **Step 1: Edit `src/ui/index.html`**

In the `<style>` block, after `#signal-hint { color: var(--muted); }` add (no `display` rule on purpose: `body.setup .dash` must keep hiding it in setup mode):

```css
  #usage { color: var(--muted); }
  #usage.over { color: var(--danger); }
```

In `<header>`, after the closing `</span>` of `#signal` add:

```html
  <span id="usage" class="dash"></span>
```

In `<form id="setup">`, after the `máx. workers` label add:

```html
  <div class="row">
    <label>tokens por hora <input id="budget-hour" type="number" min="0" step="1"></label>
    <label>tokens por dia <input id="budget-day" type="number" min="0" step="1"></label>
  </div>
  <div class="hint">vazio = sem limite</div>
```

- [ ] **Step 2: Edit `src/ui/app.ts`**

Replace the type import (lines 1–3) with:

```ts
import type {
  BoardConfig, Budget, EventsPayload, ProjectSummary, SetupBody, SetupInfo, SetupResult, Signal, Slot, State, StatusKey, Task,
  UsageSample,
} from '../types.js';
```

After `const DEFAULT_MARKDOWN_PATH = 'board.md';` add:

```ts
// Mirrors src/usage.ts, which cannot be imported here (it pulls node:fs into the browser).
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const THOUSAND = 1_000;
const MILLION = 1_000_000;
```

After `elapsed` add:

```ts
// 842, 12.3k, 1.2M: fits the header and the card meta
function fmt(n: number): string {
  if (n < THOUSAND) return String(n);
  if (n < MILLION) return `${(n / THOUSAND).toFixed(1)}k`;
  return `${(n / MILLION).toFixed(1)}M`;
}

function usageTotals(usage: UsageSample[], now: number): { hour: number; day: number } {
  return usage.reduce((totals, { at, tokens }) => {
    const age = now - Date.parse(at);
    return { hour: totals.hour + (age < HOUR_MS ? tokens : 0), day: totals.day + (age < DAY_MS ? tokens : 0) };
  }, { hour: 0, day: 0 });
}

const withinLimit = (total: number, limit?: number): boolean => limit === undefined || limit <= 0 || total < limit;
const meter = (value: number, max: number): string => `<meter min="0" max="${max}" value="${value}"></meter>`;
```

Replace `renderCard` with:

```ts
function renderCard(slot: Slot): string {
  const occupied = slot.status !== 'vazio';
  const classes = ['card', slot.status, occupied ? 'occupied' : '', slot.draining ? 'draining' : '', slot.paused ? 'paused' : ''].join(' ');
  if (!occupied) return `<div class="${classes}" data-id="${slot.id}"><div class="meta">${STATUS_LABEL.vazio}</div></div>`;
  const marks = `${slot.draining ? ' · drenando' : ''}${slot.paused ? ' · pausado' : ''}`;
  const tokens = slot.tokens === undefined ? '' : ` · ${fmt(slot.tokens)} tokens`;
  return `
    <div class="${classes}" data-id="${slot.id}">
      <div class="title">#${esc(slot.task?.id ?? '')} ${esc(slot.task?.title ?? '')}</div>
      <div class="meta">${STATUS_LABEL[slot.status]} · ${elapsed(slot.startedAt)}${marks}${tokens}</div>
      <div class="meta">${esc(slot.branch ?? slot.slug ?? '')}</div>
      <div class="meta">${esc(slot.lastEvent ?? '')}</div>
      <div class="actions"><button class="danger" data-kill="${slot.id}">kill</button></div>
    </div>`;
}
```

After `renderSignal` add (every interpolated value is a number, so no escaping is needed):

```ts
function renderUsage(usage: UsageSample[], budget: Budget): void {
  const { hour, day } = usageTotals(usage, Date.now());
  const over = !withinLimit(hour, budget.maxTokensPerHour) || !withinLimit(day, budget.maxTokensPerDay);
  const el = $('usage');
  el.classList.toggle('over', over);
  el.innerHTML = [
    `tokens: ${fmt(hour)}/h`, budget.maxTokensPerHour ? meter(hour, budget.maxTokensPerHour) : '',
    `· ${fmt(day)}/dia`, budget.maxTokensPerDay ? meter(day, budget.maxTokensPerDay) : '',
    over ? '· sem orçamento' : '',
  ].filter(Boolean).join(' ');
}
```

In `render()`, after `renderSignal(state.signal);` add:

```ts
  renderUsage(state.usage, state.budget);
```

In `openSetup`, after the `$<HTMLInputElement>('max-workers').value = …` line add:

```ts
  $<HTMLInputElement>('budget-hour').value = budgetField(config?.budget.maxTokensPerHour);
  $<HTMLInputElement>('budget-day').value = budgetField(config?.budget.maxTokensPerDay);
```

Before `openSetup` add:

```ts
const budgetField = (limit?: number): string => (limit ? String(limit) : ''); // 0 or absent = no limit = empty field

// Only filled fields above 0 become keys, so hive.config.json stays clean.
function budgetFromForm(): Budget {
  const limit = (id: string): number | undefined => {
    const value = Number($<HTMLInputElement>(id).value);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const hour = limit('budget-hour');
  const day = limit('budget-day');
  return { ...(hour ? { maxTokensPerHour: hour } : {}), ...(day ? { maxTokensPerDay: day } : {}) };
}
```

In `saveSetup`, in the `body: SetupBody = { … }` literal, after `promptTemplate: …,` add:

```ts
    budget: budgetFromForm(),
```

- [ ] **Step 3: Build and run the tests**

Run: `pnpm test`
Expected: 135 tests PASS (UI compiles under `strict`; `HTMLMeterElement` markup is plain HTML in a string, nothing DOM-typed is needed).

- [ ] **Step 4: Header, cards and form in a browser (manual, `maxConcurrent: 0`, nothing spawns)**

Reuse the repo from Task 5 step 5 (`/tmp/hive-budget-repo`, budget `50000/h` on disk):

```bash
pnpm start /tmp/hive-budget-repo
```
Expected: the header shows `tokens: 0/h [meter] · 0/dia` next to the signal buttons, the meter empty, no red. Click `configurar`: `tokens por hora` reads `50000`, `tokens por dia` is empty, the hint reads `vazio = sem limite`. Set `tokens por dia` to `100`, save: `hive.config.json` has both keys; the header now shows two meters. Clear both fields, save: the file has `"budget": {}` and the header shows no meter. Close the window.

- [ ] **Step 5: Acceptance per the spec's "Critério de pronto" (manual, real workers, GitHub or markdown board)**

Use a repo with `máx. workers = 1`, no budget, and 2 tasks in the queue column; run `pnpm start <repo>`.

1. Let the worker run. At the end of each of its turns (it stops to ask, or finishes) the card meta shows ` · Nk tokens` growing and the header `tokens: …/h · …/dia` rises by the same delta. `.hive/state.json` gains one `usage` entry per turn.
2. Open `configurar`, set `tokens por hora` below the header's hour value, save. Kill the worker from its card: the task returns to the queue, the slot stays `vazio`, nothing opens; the header shows the hour meter full and ` · sem orçamento` in red. Raise `tokens por hora` above the usage and save: the next `poll` (within 30 s, or `atualizar board`) opens a job at once.
3. Leave a worker alive with tokens on its card, close the window, run `pnpm start <repo>` again: the header shows the same usage and the card still shows its tokens.
4. `pnpm test`: 135 tests PASS.

Set `máx. workers` to 0 and kill the remaining workers before closing.

- [ ] **Step 6: Commit**

```bash
git add src/ui/index.html src/ui/app.ts
git commit -m "feat: usage meter, tokens per card and budget fields in the dashboard"
```

If step 5 revealed fixes in `src/` outside the UI, they come with a test in the matching test file and go in the same commit with the results in the body:

```bash
git commit -m "feat: usage meter, tokens per card and budget fields in the dashboard

Critério 1 (card e header sobem a cada turno): <pass/fail>
Critério 2 (orçamento estourado não abre job; subir o limite abre): <pass/fail>
Critério 3 (reabre com uso e tokens no card): <pass/fail>
Critério 4 (pnpm test, 135 testes): <pass/fail>"
```

---

## Self-review notes

**Spec coverage (section → task):**
- Decisões fechadas: source is `transcript_path`, read on `Stop` / `SessionEnd`, no `ccusage` (T5 `turnTokens`); four fields summed, dedupe by `message.id` (T1, tested with a repeated id); unit is a turn, `Slot.tokens` holds the last total, delta or whole total when smaller (T3 `recordUsage`, tested for first / second / smaller / equal); `State.usage` samples pruned on insert past 24 h (T1 `pruneUsage`, T3 insert); `Config.budget` copied to `State.budget` by `setBudget` in `configure` / `reconfigure`, absent or `0` = no limit (T2, T5, tested in `config` and `setup`); `hasBudget` in `src/usage.ts` as the second gate in `fill` (T1 tested, T3 `poll` under exhausted hour / day budget tested); budget reopens with time via the existing `poll` (T3 test with a 2 h old sample); mid-turn death does not count (only `Stop` / `SessionEnd` carry `tokens`: T5); `transcript_path` safety: turn-end event, occupied slot, absolute `.jsonl`, read error → no `tokens`, number only (T1 `isTranscriptPath` tested, T5 `turnTokens`, ghost-worker test); whole-file readline with the `ponytail:` ceiling comment (T1); UI meter, `<meter>` per limit, `over` class, ` · sem orçamento`, card ` · Nk tokens` (T6); form fields after `máx. workers`, empty = absent key, `SetupBody.budget` always sent by the form (T6, T5 `saveSetup`); number format `842` / `12.3k` / `1.2M` (T6 `fmt`); old `state.json` normalized (T4, tested); Fora: nothing built.
- Tipos: `Budget`, `UsageSample` (T1), `Config.budget`, `SetupBody.budget` (T2), `Slot.tokens`, `State.usage` / `budget`, `HookPayload.transcript_path`, `hook.tokens`, `setBudget` (T3); `initialState` with `usage: []` / `budget: {}` (T3, tested).
- `src/usage.ts`: every listed export with the listed semantics (T1; each has a test: invalid / user / no-usage lines, missing fields as 0, dedupe, distinct ids, ENOENT rejects, hour vs day, no limit / 0 / hour exhausted / day exhausted with hour ok, prune > 24 h, path checks).
- Orquestrador: `fill` gate, `setBudget` → `fill`, `recordUsage` before the switch, delta 0 no sample, other events unchanged (T3).
- Servidor: `/hooks/event` reads under the three checks; `configure` / `reconfigure` `setBudget` when different; `saveSetup` `budget: body.budget ?? current?.budget` (T5, tested: write, keep on omit, clear on `{}`, 400 on a bad value, ghost worker never reads).
- Config: `budget` optional object, `requireInt` per key with the exact message, `DEFAULT_CONFIG.budget = {}`, non-object message, absent keys stay absent (T2, tested).
- Estado persistido: `loadState` normalizes both; `saveState` writes both as part of `State` (T4; T5's setup test reads `budget` and `usage` off the streamed `State`).
- UI: `#usage` after `#signal` with the exact text, meters, `over` / ` · sem orçamento`; `renderCard` ` · N tokens`; `budget-hour` / `budget-day` with the exact labels and hint; `openSetup` fills from `config.budget`; `saveSetup` sends only filled fields `> 0` (T6).
- Testes: every case in the spec's Testes section has a test with full code (T1 eight; T2 two plus one assertion; T3 seven plus the mutation test extended; T4 one; T5 two).
- Critério de pronto 1–4 (T6 step 5). Criterion 3 has an automated proxy (T4 round trip with `usage`) and criterion 2's gate has T3's `poll` / `setBudget` tests.

**Placeholder scan:** every code step is complete; the only `<…>` tokens are the T6 commit template results and the operator-chosen `<repo>`.

**Type consistency across tasks:**
- `Budget` (T1 `types.ts`) is `Config.budget` (T2), `State.budget` and the `setBudget` payload (T3), `hasBudget`'s second argument (T1), `parseBudget`'s return (T2), `budgetFromForm`'s return and `renderUsage`'s argument (T6).
- `UsageSample` (T1) is the element of `State.usage` (T3), the argument type of `usageTotals` / `hasBudget` / `pruneUsage` (T1), the guard in `state-store.ts` (T4) and the UI mirror (T6).
- `hook.tokens?: number` (T3) is produced only by `turnTokens` in `server.ts` (T5) and consumed only by `applyHook` → `recordUsage` (T3); the orchestrator tests set it directly.
- `State.usage` and `State.budget` are required, so every `State` literal must carry them: `initialState` (T3), `normalize`'s spread (T4), the `spent` helper in the orchestrator test (T3, spreads `initialState`); `server.ts` spreads loaded or previous state everywhere.
- `Config.budget` is required: `DEFAULT_CONFIG` (T2), `parseConfig` (T2); `activate` spreads `config` (unchanged); the setup test's `{ ...DEFAULT_CONFIG, ...BODY }` picks it up from `DEFAULT_CONFIG`.
- Test totals: 115 → 123 (T1) → 125 (T2) → 132 (T3) → 133 (T4) → 135 (T5) → 135 (T6).