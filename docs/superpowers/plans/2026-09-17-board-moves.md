# Agent Hive — quem move o card (Hive, agente ou humano): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each of the three board moves the Hive makes today (`working` when a worker opens, `review` when `gh pr create` shows up in a `PostToolUse`, `queue` when a worker exits without a PR) gets an owner in `hive.config.json`: `hive` (today's behaviour), `agent` (the Hive does not write the board and appends a paragraph to the worker prompt saying which moves are the worker's) or `human` (the Hive does not write the board and says nothing). A config without `moves` behaves exactly as today. The slot state machine does not change: `moves` governs board writes only.

**Architecture:** `Config.moves: Moves` (`Record<StatusKey, Mover>`, default all `hive`), parsed in `src/config.ts` like `status` (partial object accepted, missing key = `hive`). The rule lives in the reducer as `hiveMoves(state, key)` over an optional `State.moves`: `fill` emits `setStatus working` only under `hive`, `PostToolUse` with a PR emits `setStatus review` only under `hive`, `exit` requeues (in memory and on the board) only under `hive`. `moves` is copied from the config into the state by `configure`, `reconfigure` and `bootHive`, always before the `boot` event, with no new reducer event. `src/spawn.ts` gains `movesNote(moves, status)` and `server.spawn` writes `renderPrompt(...) + movesNote(...)` to the prompt file. `saveSetup` forwards `body.moves ?? current?.moves`; `activate` logs the moves. The board panel of the setup form gets a `quem move o card` fieldset with one `<select>` per transition. `Task`, `Slot`, `HiveEvent`, `Effect`, `Board`, the adapters, `state-store.ts` and `log.ts` do not change.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`, `gh` CLI (GitHub adapter only). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-board-moves-design.md` (extends `docs/superpowers/specs/2026-09-16-pluggable-boards-design.md`, `docs/superpowers/specs/2026-09-16-ignore-epics-design.md` and `docs/superpowers/specs/2026-09-15-agent-hive-design.md`). Issue: <https://github.com/dennys-bd/agent-hive/issues/42>.

## Global Constraints

- All v1 and setup constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts`, `run.ts`, `hooks-settings.ts`, `state-store.ts` do not change. For this feature also `board.ts`, `boards/github.ts`, `boards/markdown.ts`, `log.ts`, `polling.ts`, `workers.ts`, `usage.ts`, `usage-rules.ts` do not change.
- `Task.id` is a string in every adapter (`String(issue.number)` for GitHub, the `id` cell for markdown); `Task.itemId` stays the adapter's internal key (project item id / the same `id`).
- `Task.blockedBy` is omitted when empty; adapters only list blockers that are still **open**. Existing fixtures and `deepEqual` expectations stay valid.
- The markdown adapter never caches: every `listQueue` / `setStatus` / `setupOptions` re-reads the file. `setStatus` changes one cell of one line and writes tmp + rename; every other byte is preserved. The dependency column is never written by the Hive.
- `POST /setup` order: `parseConfig` → (markdown: create the file if missing) → `resolveFields` → write `hive.config.json` (tmp + rename) → `configure` / `reconfigure`. The markdown file creation is the only write under `<repo>` allowed before `resolveFields`, and only when the file does not exist.
- Status codes: validation / board errors on `POST /setup` → 400; board failures on listing routes → 502; write / boot failures (including creating the markdown file) → 500.
- `createBoard(config, deps)` needs `deps.repo`. `createServer` defaults `boardFactory` to `(config) => createBoard(config, { repo, log })`; `test/setup.test.ts` keeps its fake factory and always saves `maxConcurrent: 0`, except one test using the real factory with a markdown board (touches only a local file).
- Legacy `{ "project": { owner, number } }` without `board` parses as `{ type: 'github', owner, number }`; saving from the UI rewrites the file in the new format.
- A failing graphql call is a `listQueue` error (banner, like any poll failure); never swallowed into "no blockers".
- Files < 400 lines, functions < 50 lines, code comments in English, `execFile` argv arrays only (the injectable `Exec` in `src/boards/github.ts` is reused).
- **New for this feature:**
  - `moves` governs board writes only. `trabalhando → aguardando_review` still comes from `gh pr create` in `PostToolUse`, `prUrl` is still stored, and a `Stop` with a PR still ends the session, whatever `moves` says.
  - `State.moves` is optional and reads as all `hive` when absent (legacy `state.json`, no migration). The config overwrites it **before** the `boot` event on both boot paths (`configure` on `POST /setup` and `bootHive` on app start), so dead slots are requeued by the config's rule, not by what `state.json` carried.
  - No new reducer event (`setMoves` does not exist): `configure` / `reconfigure` / `bootHive` write `moves` into the state they build. Nothing reacts to the change (no `fill`, no `releasePaused`).
  - No new prompt placeholder: `movesNote` is appended to the rendered template, so saved templates work without edits. The note is English, like the default template; `''` when no transition is `agent`.
  - Exit without a PR under `queue ≠ hive`: the slot is freed, the task does **not** return to the in-memory queue and no effect is emitted; the next poll sees whatever column the card is in. Under `working ≠ hive` the card stays in the queue column while the worker runs; `poll` already excludes tasks in a slot by `itemId`.
  - `Board` interface and adapters unchanged; `sameBoard` does not compare `moves` (nothing is baked into the adapter, so a change never rebuilds the board).
  - `MOVERS`, `MOVE_KEYS` (`['working', 'review', 'queue']`, the order of the note and the log line) live in `src/config.ts`; `Mover`, `Moves` in `src/types.ts`; `hiveMoves` in `src/orchestrator.ts`; `movesNote` in `src/spawn.ts`. No other new names.
- `pnpm test` must stay green after every task (252 tests today → 260 at the end).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `Mover`, `Moves`; `Config.moves: Moves`; `State.moves?: Moves`; `SetupBody.moves?: Moves` |
| `src/config.ts` | `MOVERS`, `MOVE_KEYS`; `DEFAULT_CONFIG.moves` all `hive`; `requireMover`, `parseMoves`; `parseConfig` reads `moves` |
| `src/orchestrator.ts` | `hiveMoves(state, key)`; `fill`, `PostToolUse`, `exit` gate their `setStatus` (and the requeue) on it |
| `src/spawn.ts` | `movesNote(moves, status)` |
| `src/server.ts` | `configure` / `reconfigure` copy `config.moves` into the state; `spawn` appends `movesNote`; `saveSetup` forwards `moves`; `activate` logs `moves=…` |
| `src/hive.ts` | boot state carries `moves: config.moves` |
| `src/ui/index.html` | `<fieldset id="moves-fields">` with `#move-working`, `#move-review`, `#move-queue` in the `board` panel; one CSS rule for `legend` |
| `src/ui/app.ts` | `MOVE_SELECT`; `openSetup` fills the three selects; `movesFromForm`; `saveSetup` always sends `moves` |
| `test/config.test.ts` | +1: partial / invalid / non-object `moves`; default asserted in the defaults test (16 tests) |
| `test/orchestrator.test.ts` | +3: `fill` under `working: agent`; `PostToolUse` under `review: human`; `exit` and `boot` under `queue: agent` / `human` (62 tests) |
| `test/spawn.test.ts` | +1: `movesNote` empty / two parts in order / one part (9 tests) |
| `test/setup.test.ts` | +1: `moves` written, carried by `GET /setup`, the State and `state.json`, kept when absent, partial filled, bad value 400 (27 tests) |
| `test/server.test.ts` | +1: prompt file ends with the note and the Hive skips the `review` write; all hive has no note. The logLevel test's two `INFO config …` lines gain `moves=…` (16 tests) |
| `test/hive.test.ts` | +1: `bootHive` copies `moves` before `boot`; a dead slot is requeued by the config rule (6 tests) |

---

### Task 1: `Mover`, `Moves`, `Config.moves`, `State.moves?`, `SetupBody.moves?`, parsing with default all `hive` (TDD)

**Files:**
- Modify: `src/types.ts`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `export type Mover = 'hive' | 'agent' | 'human'`; `export type Moves = Record<StatusKey, Mover>`; `Config.moves: Moves`; `State.moves?: Moves`; `SetupBody.moves?: Moves`.
- Produces (in `src/config.ts`): `export const MOVERS: readonly Mover[] = ['hive', 'agent', 'human']`; `export const MOVE_KEYS: readonly StatusKey[] = ['working', 'review', 'queue']`; `DEFAULT_CONFIG.moves = { working: 'hive', review: 'hive', queue: 'hive' }`; `parseConfig` accepts an optional `moves` object, each key of `MOVE_KEYS` optional with default `'hive'`; errors `hive.config.json: "moves" must be an object` and `hive.config.json: "moves.<key>" must be one of: hive, agent, human`.
- Consumed by: Task 2 (`State.moves`), Task 3 (`MOVE_KEYS`, `Moves`), Task 4 (`config.moves`, `SetupBody.moves`), Task 5 (form).

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, inside `parseConfig applies defaults on top of a minimal config`, add after `  assert.equal(config.epics, 'ignore');`:

```ts
  assert.deepEqual(config.moves, { working: 'hive', review: 'hive', queue: 'hive' });
```

Append after the `parseConfig accepts epics ignore or queue and rejects anything else` test:

```ts
test('parseConfig reads moves as a partial object with hive as the default and rejects bad values naming the key', () => {
  const all = { working: 'hive', review: 'hive', queue: 'hive' };
  assert.deepEqual(parseConfig({ board: GITHUB, moves: {} }).moves, all);
  assert.deepEqual(parseConfig({ board: GITHUB, moves: { review: 'agent' } }).moves, { ...all, review: 'agent' });
  assert.deepEqual(
    parseConfig({ board: GITHUB, moves: { working: 'human', review: 'agent', queue: 'agent' } }).moves,
    { working: 'human', review: 'agent', queue: 'agent' },
  );
  assert.throws(() => parseConfig({ board: GITHUB, moves: 'agent' }), { message: 'hive.config.json: "moves" must be an object' });
  assert.throws(() => parseConfig({ board: GITHUB, moves: null }), /"moves" must be an object/);
  assert.throws(() => parseConfig({ board: GITHUB, moves: [] }), /"moves" must be an object/);
  assert.throws(
    () => parseConfig({ board: GITHUB, moves: { review: 'bot' } }),
    { message: 'hive.config.json: "moves.review" must be one of: hive, agent, human' },
  );
  assert.throws(() => parseConfig({ board: GITHUB, moves: { queue: true } }), /"moves\.queue" must be one of/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error — `Property 'moves' does not exist on type 'Config'`.

- [ ] **Step 3: Edit `src/types.ts`**

Insert after the line `export type EpicsMode = 'ignore' | 'queue';`:

```ts

/** Who performs one board move: the Hive (today's behaviour), the worker from inside its session, or nobody automated. */
export type Mover = 'hive' | 'agent' | 'human';
/** One entry per transition, keyed by the column it lands on: working (spawn), review (PR seen), queue (exit without a PR). */
export type Moves = Record<StatusKey, Mover>;
```

In `Config`, add after `  epics: EpicsMode; // GitHub only; the markdown adapter has no epics and ignores it`:

```ts
  moves: Moves; // copied to State.moves by configure / reconfigure / bootHive; the agent's moves are appended to the worker prompt
```

In `State`, add after `  usageRules: UsageRule[]; // copied from Config.usageRules by setUsageRules`:

```ts
  moves?: Moves; // set from Config before boot; absent (legacy state.json) reads as all hive
```

In `SetupBody`, add after the `  epics?: EpicsMode;` entry:

```ts
  /** Optional; missing keeps the current value (or all hive on first setup). The form always sends the three keys. */
  moves?: Moves;
```

- [ ] **Step 4: Edit `src/config.ts`**

Replace the type import line:

```ts
import type { BoardConfig, Budget, Config, EpicsMode, Mover, Moves, Signal, StatusKey, UsageRule, WorkersMode } from './types.js';
```

Add after `export const EPICS_MODES: readonly EpicsMode[] = ['ignore', 'queue'];`:

```ts
export const MOVERS: readonly Mover[] = ['hive', 'agent', 'human'];
/** The three transitions the Hive makes today, in the order the prompt note and the log line list them. */
export const MOVE_KEYS: readonly StatusKey[] = ['working', 'review', 'queue'];
```

In `DEFAULT_CONFIG`, add after `  epics: 'ignore',`:

```ts
  moves: { working: 'hive', review: 'hive', queue: 'hive' },
```

Insert after `requireSignal` (before `parseUsageRule`):

```ts
function requireMover(value: unknown, field: string): Mover {
  if (!MOVERS.includes(value as Mover)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${MOVERS.join(', ')}`);
  return value as Mover;
}

// A partial object is fine: a missing key is the Hive, so a file written before moves existed changes nothing.
function parseMoves(raw: unknown): Moves {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "moves" must be an object`);
  return Object.fromEntries(
    MOVE_KEYS.map((key) => [key, optional(raw[key], DEFAULT_CONFIG.moves[key], (v) => requireMover(v, `moves.${key}`))]),
  ) as Moves;
}
```

In `parseConfig`'s returned object, add after the `epics: optional(…)` block (before `logLevel:`):

```ts
    moves: optional(raw.moves, DEFAULT_CONFIG.moves, parseMoves),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 253 tests PASS. `test/setup.test.ts` (`{ ...DEFAULT_CONFIG, ...BODY }` against the written file) keeps passing because both sides carry `moves` all `hive`; `State.moves?` is optional so no fixture changes.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "feat(config): moves per board transition (hive | agent | human), default hive"
```

---

### Task 2: Orchestrator — `hiveMoves` gates the board writes in `fill`, `PostToolUse` and `exit` (TDD)

**Files:**
- Modify: `src/orchestrator.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces:**
- Produces (in `src/orchestrator.ts`): `export function hiveMoves(state: State, key: StatusKey): boolean` = `(state.moves?.[key] ?? 'hive') === 'hive'`.
- Behaviour: `fill` pushes `setStatus working` only under `hiveMoves(state, 'working')`, then `spawn` as today; `PostToolUse` with a PR patches the slot to `aguardando_review` + `prUrl` as today and emits `setStatus review` only under `hiveMoves(state, 'review')`; `exit` computes `requeue` only when `slot.task && !slot.prUrl && hiveMoves(state, 'queue')`, so without it there is no queue entry and no effect. `boot` goes through `exit` and inherits the rule. Every existing test has no `moves` on its state, so the legacy behaviour stays covered by the 59 tests already there.
- Consumed by: Task 4 (the server puts `moves` in the state).

- [ ] **Step 1: Write the failing tests**

In `test/orchestrator.test.ts`, change the import lines 3 and 5:

```ts
import { canSchedule, canStart, extractPrUrl, hiveMoves, initialState, isBlocked, reduce, slugFor } from '../src/orchestrator.js';
```

```ts
import type { BoardQuota, Budget, HookPayload, Moves, RateLimits, Signal, State, Task, UsageRule } from '../src/types.js';
```

Add after `const QUOTA: BoardQuota = …;`:

```ts
// The state with `moves` as configure / bootHive leave it: every key set, hive unless overridden.
const moved = (state: State, moves: Partial<Moves>): State => ({ ...state, moves: { working: 'hive', review: 'hive', queue: 'hive', ...moves } });
```

Append at the end of the file:

```ts
test('fill under moves.working = agent or human spawns without a setStatus working; hive, or no moves at all, writes the board as before', () => {
  const agent = reduce(moved(initialState(1), { working: 'agent' }), { type: 'poll', tasks: tasks(2) });
  assert.equal(agent.state.slots[0].status, 'trabalhando');
  assert.equal(agent.state.slots[0].task?.id, '1');
  assert.deepEqual(agent.state.queue.map((t) => t.id), ['2']);
  assert.deepEqual(agent.effects, [{ type: 'spawn', slot: agent.state.slots[0] }], 'the card stays in the queue column: whoever owns the move handles it');
  assert.deepEqual(agent.state.moves, { working: 'agent', review: 'hive', queue: 'hive' }, 'moves rides along in the state');
  const human = reduce(moved(initialState(1), { working: 'human' }), { type: 'poll', tasks: tasks(1) });
  assert.deepEqual(human.effects.map((e) => e.type), ['spawn']);
  const hive = reduce(moved(initialState(1), {}), { type: 'poll', tasks: tasks(1) });
  assert.deepEqual(hive.effects.map((e) => e.type), ['setStatus', 'spawn']);
  assert.equal(hiveMoves(initialState(1), 'working'), true, 'a state without moves (legacy state.json) is all hive');
  assert.equal(hiveMoves(moved(initialState(1), { queue: 'human' }), 'queue'), false);
});

test('PostToolUse with gh pr create under moves.review = human moves the slot to aguardando_review with the prUrl and writes nothing to the board', () => {
  const first = moved(filled(1, 1).state, { review: 'human' });
  const id = first.slots[0].workerId!;
  const { state, effects } = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/o/r/pull/42',
  });
  assert.equal(state.slots[0].status, 'aguardando_review');
  assert.equal(state.slots[0].prUrl, 'https://github.com/o/r/pull/42');
  assert.equal(state.slots[0].lastEvent, 'PR aberto');
  assert.deepEqual(effects, [], 'the internal state does not depend on moves; only the board write does');
  // the Stop with a PR still ends the task: its exit frees the slot and never requeues, whatever moves says
  const freed = reduce(state, { type: 'exit', workerId: id });
  assert.equal(freed.state.slots[0].status, 'vazio');
  assert.deepEqual(freed.state.queue, []);
  assert.deepEqual(freed.effects, []);
});

test('exit without a PR under moves.queue = agent frees the slot without requeueing or writing the board; boot follows the same rule', () => {
  const first = moved(filled(1, 2).state, { queue: 'agent' }); // task 1 working, task 2 queued
  const { state, effects } = reduce(first, { type: 'exit', workerId: first.slots[0].workerId! });
  assert.equal(state.slots[0].task?.id, '2', 'the free slot still pulls the next task');
  assert.deepEqual(state.queue, [], 'task 1 is not back in the queue: the agent moves the card, the next poll sees it');
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'spawn'], 'only the working move of task 2; nothing for task 1');
  assert.deepEqual(effects[0], { type: 'setStatus', itemId: 'item2', key: 'working' });
  const booted = reduce(moved(filled(2, 2).state, { queue: 'human' }), { type: 'boot' });
  assert.deepEqual(booted.state.slots.map((s) => s.status), ['vazio', 'vazio']);
  assert.deepEqual(booted.state.queue, [], 'dead slots are not requeued when the move is not the Hive\'s');
  assert.deepEqual(booted.effects, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error — `Module '"../src/orchestrator.js"' has no exported member 'hiveMoves'`.

- [ ] **Step 3: Edit `src/orchestrator.ts`**

Replace the type import (line 2):

```ts
import type { Effect, HiveEvent, HookPayload, RateLimits, Signal, Slot, State, Status, StatusKey, Task, UsageLimits, UsageRule } from './types.js';
```

Insert after `isBlocked` (before `extractPrUrl`):

```ts
/** Whether the Hive itself writes the board for the transition landing on `key`; a state without `moves` (legacy state.json) is all hive. */
export function hiveMoves(state: State, key: StatusKey): boolean {
  return (state.moves?.[key] ?? 'hive') === 'hive';
}
```

In `fill`, replace the line

```ts
    spawned.push({ type: 'setStatus', itemId: task.itemId, key: 'working' }, { type: 'spawn', slot: next });
```

with

```ts
    if (hiveMoves(state, 'working')) spawned.push({ type: 'setStatus', itemId: task.itemId, key: 'working' });
    spawned.push({ type: 'spawn', slot: next });
```

In `exit`, replace the line

```ts
  const requeue = slot.task && !slot.prUrl ? slot.task : undefined;
```

with

```ts
  // Not the Hive's move: whoever moves the card decides if the task comes back; the next poll sees it in the queue column
  const requeue = slot.task && !slot.prUrl && hiveMoves(state, 'queue') ? slot.task : undefined;
```

In `applyHook`, case `PostToolUse`, replace the line

```ts
      return { ...patched, effects: slot.task ? [{ type: 'setStatus', itemId: slot.task.itemId, key: 'review' }] : [] };
```

with

```ts
      // The slot moves either way: moves governs the board write only
      return {
        ...patched,
        effects: slot.task && hiveMoves(state, 'review') ? [{ type: 'setStatus', itemId: slot.task.itemId, key: 'review' }] : [],
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 256 tests PASS. The existing `exit`, `boot`, `SessionEnd` and `PostToolUse` tests still see their `setStatus` effects: none of their states has `moves`.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): board writes gated by State.moves; agent or human moves are not the Hive's"
```

---

### Task 3: `movesNote` in `src/spawn.ts` (TDD)

**Files:**
- Modify: `src/spawn.ts`
- Test: `test/spawn.test.ts`

**Interfaces:**
- Produces (in `src/spawn.ts`): `export function movesNote(moves: Moves, status: Record<StatusKey, string>): string` — `''` when no key is `agent`; otherwise `\n\nBoard moves you own (the Hive will not make them): ` followed by the parts of the `agent` keys in `MOVE_KEYS` order, joined by `; `, ending with `.`:
  - `working`: `move this task's card to "<status.working>" now, at the start`
  - `review`: `move it to "<status.review>" when you open the PR`
  - `queue`: `move it back to "<status.queue>" if you stop without a PR`
- `renderPrompt`, `writePrompt`, `workerEnv`, `spawnWorker`, `killStray` unchanged.
- Consumed by: Task 4 (`server.spawn`).

- [ ] **Step 1: Write the failing test**

In `test/spawn.test.ts`, change line 6:

```ts
import { killStray, movesNote, renderPrompt, workerEnv, writePrompt } from '../src/spawn.js';
```

Add after `const task = …;`:

```ts
const STATUS = { queue: 'Ready', working: 'In progress', review: 'In review' };
const NOTE = '\n\nBoard moves you own (the Hive will not make them): ';
```

Append after `renderPrompt renders {id} and {number} the same`:

```ts
test('movesNote is empty unless the agent owns a move, then lists the owned moves in working, review, queue order with the column names', () => {
  assert.equal(movesNote({ working: 'hive', review: 'hive', queue: 'hive' }, STATUS), '');
  assert.equal(movesNote({ working: 'human', review: 'hive', queue: 'human' }, STATUS), '', 'human is nobody\'s instruction');
  assert.equal(
    movesNote({ working: 'hive', review: 'agent', queue: 'agent' }, STATUS),
    `${NOTE}move it to "In review" when you open the PR; move it back to "Ready" if you stop without a PR.`,
  );
  assert.equal(
    movesNote({ working: 'agent', review: 'hive', queue: 'hive' }, { ...STATUS, working: 'Doing' }),
    `${NOTE}move this task's card to "Doing" now, at the start.`,
  );
  assert.equal(
    movesNote({ working: 'agent', review: 'agent', queue: 'agent' }, STATUS),
    `${NOTE}move this task's card to "In progress" now, at the start; move it to "In review" when you open the PR; move it back to "Ready" if you stop without a PR.`,
  );
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `pnpm test`
Expected: build error — `Module '"../src/spawn.js"' has no exported member 'movesNote'`.

- [ ] **Step 3: Edit `src/spawn.ts`**

Replace the two import lines

```ts
import { spawnItermWorker } from './spawn-iterm.js';
import { spawnTmuxWorker } from './spawn-tmux.js';
import type { SpawnWorker, Task } from './types.js';
```

with

```ts
import { MOVE_KEYS } from './config.js';
import { spawnItermWorker } from './spawn-iterm.js';
import { spawnTmuxWorker } from './spawn-tmux.js';
import type { Moves, SpawnWorker, StatusKey, Task } from './types.js';
```

Add after `const NO_MATCH_EXIT = 1;`:

```ts
const MOVES_NOTE_HEADER = '\n\nBoard moves you own (the Hive will not make them): ';
```

Insert after `renderPrompt`:

```ts
/** The paragraph appended to the worker prompt with the board moves that are the agent's; '' when none is. English, like the default template. */
export function movesNote(moves: Moves, status: Record<StatusKey, string>): string {
  const parts: Record<StatusKey, string> = {
    working: `move this task's card to "${status.working}" now, at the start`,
    review: `move it to "${status.review}" when you open the PR`,
    queue: `move it back to "${status.queue}" if you stop without a PR`,
  };
  const owned = MOVE_KEYS.filter((key) => moves[key] === 'agent').map((key) => parts[key]);
  return owned.length === 0 ? '' : `${MOVES_NOTE_HEADER}${owned.join('; ')}.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 257 tests PASS. (`config.ts` imports `orchestrator.js` and `log.js`; neither imports `spawn.ts`, so no cycle.)

- [ ] **Step 5: Commit**

```bash
git add src/spawn.ts test/spawn.test.ts
git commit -m "feat(spawn): movesNote lists the board moves the agent owns"
```

---

### Task 4: Server and boot wiring — `moves` into the state before `boot`, appended to the prompt, saved from `POST /setup`, logged (TDD)

**Files:**
- Modify: `src/server.ts`, `src/hive.ts`
- Test: `test/setup.test.ts`, `test/server.test.ts`, `test/hive.test.ts`

**Interfaces:**
- `configure`: `live = { runtime, state: { ...saved, queue: [], moves: config.moves } }` before `dispatch({ type: 'boot' })`.
- `reconfigure`: `live = { runtime, state: { ...live.state, moves: config.moves } }`; the `poll()` that follows persists and broadcasts. No event.
- `spawn`: the prompt file holds `renderPrompt(config.promptTemplate, slot.task) + movesNote(config.moves, config.status)`.
- `saveSetup`: `moves: body.moves ?? current?.moves` (absent → current → `parseConfig` default all `hive`; partial → filled with `hive`; invalid → 400 with the config message, before the write).
- `activate` log line gains ` moves=working:<m>,review:<m>,queue:<m>` in `MOVE_KEYS` order.
- `bootHive` (`src/hive.ts`): the boot state also carries `moves: config.moves`, for the same reason it carries `budget` and `usageRules` (the app's normal boot never calls `configure`; without this line a restart would requeue dead slots to the board even under `queue: agent`).
- `sameBoard` unchanged: a different `moves` reuses the live board.

- [ ] **Step 1: Write the failing tests**

`test/setup.test.ts` — append:

```ts
test('POST /setup with moves writes the whole object, GET /setup, the State and state.json carry it, a save without the key keeps it, a partial object fills hive and a bad value answers 400', async (t) => {
  const { base, repo, server } = await start(t);
  const all = { working: 'hive', review: 'hive', queue: 'hive' };
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, all, 'all hive on first setup');
  assert.deepEqual(server.getState()?.moves, all, 'configure copies it into the state');
  const moves = { working: 'hive', review: 'agent', queue: 'human' };
  assert.equal((await postSetup(base, { ...BODY, moves })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, moves);
  assert.deepEqual((await json<SetupInfo>(fetch(`${base}/setup`))).config?.moves, moves);
  assert.deepEqual(server.getState()?.moves, moves, 'reconfigure copies it into the live state without an event');
  assert.deepEqual((JSON.parse(await readFile(join(repo, '.hive', 'state.json'), 'utf8')) as State).moves, moves, 'persisted by the poll that follows');
  // a save without the key keeps the file's (the API caller that omits it, like `epics`); a partial object fills the rest with hive
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, moves);
  assert.equal((await postSetup(base, { ...BODY, moves: { queue: 'agent' } })).status, 200);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, { ...all, queue: 'agent' });
  const bad = await postSetup(base, { ...BODY, moves: { review: 'bot' } });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /"moves\.review" must be one of: hive, agent, human/);
  assert.deepEqual((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).moves, { ...all, queue: 'agent' }, 'rejected before the write');
});
```

`test/server.test.ts` — in `POST /setup re-reads logLevel from hive.config.json …`, change the two `INFO config …` expectations (lines 283 and 292):

```ts
  assert.ok(lines.includes(`INFO config port=${port} board=github workers=embedded logLevel=info moves=working:hive,review:hive,queue:hive`));
```

```ts
  assert.ok(lines.includes(`INFO config port=${port} board=github workers=embedded logLevel=debug moves=working:hive,review:hive,queue:hive`));
```

Append at the end of the file:

```ts
test('the worker prompt ends with the moves the agent owns and the Hive skips those board writes; with every move on the Hive the file is the rendered template only', async (t) => {
  const { log, lines } = fakeLog();
  const { repo, port, server } = await start(t, { ...BODY, moves: { working: 'hive', review: 'agent', queue: 'agent' } }, log);
  const note = '\n\nBoard moves you own (the Hive will not make them): move it to "In review" when you open the PR; move it back to "Ready" if you stop without a PR.';
  const text = await readFile(join(repo, '.hive', 'prompts', 'hive-1-from-ready.md'), 'utf8');
  assert.ok(text.startsWith('Task #1: from Ready'), text);
  assert.ok(text.endsWith(note), text);
  assert.ok(lines.includes(`INFO config port=${port} board=github workers=embedded logLevel=info moves=working:hive,review:agent,queue:agent`));
  assert.ok(lines.includes('INFO setStatus #I1 → working ok'), 'working is still the Hive\'s');
  await openPr(server, slot0(server).workerId!);
  assert.equal(slot0(server).status, 'aguardando_review', 'the slot state does not depend on moves');
  assert.ok(!lines.some((l) => l.includes('setStatus #I1 → review')), `review is the agent's: no board write in\n${lines.join('\n')}`);
  const plain = await start(t);
  const plainText = await readFile(join(plain.repo, '.hive', 'prompts', 'hive-1-from-ready.md'), 'utf8');
  assert.ok(!plainText.includes('Board moves you own'), plainText);
  assert.ok(plainText.endsWith('open a PR with `gh pr create`.'), 'nothing appended: the file is the rendered template');
});
```

`test/hive.test.ts` — change the types import:

```ts
import type { SetupInfo, Slot } from '../src/types.js';
```

Append after `bootHive opens under yellow …`:

```ts
test('bootHive copies moves from hive.config.json into the state before the boot event: a dead slot is requeued by the config rule, not by state.json', async (t) => {
  const task = { itemId: 'T-1', id: 'T-1', title: 'Exemplo', body: '', url: 'board.md' };
  const dead: Slot = { id: 'S1', workerId: 'W1', status: 'trabalhando', task, slug: 'hive-t-1-exemplo' }; // a worker of a previous run, no PR
  const repo = await repoWithConfig({ moves: { queue: 'agent' } });
  await mkdir(join(repo, '.hive'));
  await saveState(join(repo, '.hive'), { ...initialState(1), slots: [dead] }); // written before moves existed: no moves key
  const { server } = await bootHive(repo);
  t.after(() => server.close());
  assert.deepEqual(server.getState()?.moves, { working: 'hive', review: 'hive', queue: 'agent' });
  assert.equal(server.getState()?.slots[0].status, 'vazio');
  assert.equal(await readFile(join(repo, 'board.md'), 'utf8'), newBoardText(), 'queue is the agent\'s: the Hive did not move T-1 back');
  const control = await repoWithConfig({});
  await mkdir(join(control, '.hive'));
  await saveState(join(control, '.hive'), { ...initialState(1), slots: [dead] });
  const hive = await bootHive(control);
  t.after(() => hive.server.close());
  assert.ok((await readFile(join(control, 'board.md'), 'utf8')).includes('| T-1 | Exemplo | Ready |'), 'default: the Hive moves T-1 back to the queue column');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected (no build errors: every type exists since Task 1):
- `setup`: the new test fails at `server.getState()?.moves` (`undefined`, `configure` does not copy it yet).
- `server`: the logLevel test fails on its first `INFO config …` line (no `moves=`); the new test fails at `text.endsWith(note)`.
- `hive`: the new test fails at `server.getState()?.moves` (`undefined`).

- [ ] **Step 3: Edit `src/server.ts`**

Change the two imports:

```ts
import { CONFIG_FILE, loadConfigIfPresent, MOVE_KEYS, parseConfig } from './config.js';
```

```ts
import { killStray, movesNote, renderPrompt, spawnWorker, writePrompt } from './spawn.js';
```

In `spawn`, replace the line

```ts
    const promptPath = await writePrompt(promptsDir, slot.slug, renderPrompt(config.promptTemplate, slot.task)); // the command line reads it
```

with

```ts
    const text = renderPrompt(config.promptTemplate, slot.task) + movesNote(config.moves, config.status); // appended: saved templates need no edit
    const promptPath = await writePrompt(promptsDir, slot.slug, text); // the command line reads it
```

In `activate`, replace the line

```ts
    log.info(`config port=${boundPort} board=${effective.board.type} workers=${effective.workers} logLevel=${effective.logLevel}`);
```

with

```ts
    const moves = MOVE_KEYS.map((key) => `${key}:${effective.moves[key]}`).join(',');
    log.info(`config port=${boundPort} board=${effective.board.type} workers=${effective.workers} logLevel=${effective.logLevel} moves=${moves}`);
```

In `configure`, replace the line

```ts
    live = { runtime, state: { ...saved, queue: [] } };
```

with

```ts
    live = { runtime, state: { ...saved, queue: [], moves: config.moves } }; // before boot: dead slots follow the config's rule, not state.json's
```

In `reconfigure`, replace the line

```ts
    live = { runtime, state: live.state };
```

with

```ts
    live = { runtime, state: { ...live.state, moves: config.moves } }; // no event: nothing reacts to the change; the poll below persists and broadcasts
```

In `saveSetup`, add after `        epics: body.epics ?? current?.epics,`:

```ts
        moves: body.moves ?? current?.moves,
```

- [ ] **Step 4: Edit `src/hive.ts`**

Replace the comment and the line

```ts
  // state.json carries a copy of the budget; the config file is the source, so a hand edit wins on boot
  const saved = { ...(await loadState(hiveDir, config.maxConcurrent)), budget: config.budget, usageRules: config.usageRules };
```

with

```ts
  // state.json carries a copy of the budget, the rules and moves; the config file is the source, so a hand edit wins on boot
  const saved = { ...(await loadState(hiveDir, config.maxConcurrent)), budget: config.budget, usageRules: config.usageRules, moves: config.moves };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 260 tests PASS. `a second POST /setup with the same board and status keeps the live board instance` still passes (`sameBoard` ignores `moves`). `the log tells the story …` still passes (its `has(...)` lines do not include the `config` line).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/hive.ts test/setup.test.ts test/server.test.ts test/hive.test.ts
git commit -m "feat(server): moves copied into the state before boot, appended to the worker prompt, saved from POST /setup"
```

---

### Task 5: UI — `quem move o card` fieldset in the board setup panel

**Files:**
- Modify: `src/ui/index.html`, `src/ui/app.ts`

**Interfaces:**
- `index.html`: `<fieldset id="moves-fields">` after `#markdown-fields`, inside `<section data-panel="board">`, legend `quem move o card`, three `<select>`s `#move-working`, `#move-review`, `#move-queue` with options `hive` / `agent` / `human`, and the hint from the spec. Never disabled: it applies to both board types.
- `app.ts`: `MOVE_SELECT: Record<StatusKey, string>`; `openSetup` sets each select to `config?.moves[key] ?? 'hive'`; `movesFromForm(): Moves`; `saveSetup` always sends `moves`.
- No automated test (spec: manual).

- [ ] **Step 1: Edit `src/ui/index.html`**

Add after the CSS line `  #setup fieldset[disabled] { display: none; }`:

```css
  #setup legend { color: var(--muted); font-size: 12px; text-transform: uppercase; padding: 0; margin-bottom: 8px; }
```

Insert after the closing `</fieldset>` of `#markdown-fields` (the line right after `<datalist id="md-options"></datalist>`), still inside `<section data-panel="board">`:

```html
        <fieldset id="moves-fields">
          <legend>quem move o card</legend>
          <label>pra "em andamento", ao abrir o worker
            <select id="move-working">
              <option value="hive">Hive</option>
              <option value="agent">o agente (recebe a instrução no prompt)</option>
              <option value="human">à mão (ninguém automatiza)</option>
            </select>
          </label>
          <label>pra "em review", quando o PR abre
            <select id="move-review">
              <option value="hive">Hive</option>
              <option value="agent">o agente (recebe a instrução no prompt)</option>
              <option value="human">à mão (ninguém automatiza)</option>
            </select>
          </label>
          <label>de volta pra fila, se o worker sai sem PR
            <select id="move-queue">
              <option value="hive">Hive</option>
              <option value="agent">o agente (recebe a instrução no prompt)</option>
              <option value="human">à mão (ninguém automatiza)</option>
            </select>
          </label>
          <div class="hint">com "o agente", o prompt do worker ganha um parágrafo dizendo quais movimentos são dele; com "à mão", o Hive só observa o board pelo poll.</div>
        </fieldset>
```

- [ ] **Step 2: Edit `src/ui/app.ts`**

Change the type import (lines 1–4):

```ts
import type {
  BoardConfig, BoardQuota, Budget, EpicsMode, EventsPayload, Mover, Moves, ProjectSummary, RateLimits, SetupBody, SetupInfo, SetupResult,
  Signal, Slot, State, StatusKey, Task, UsageSample, WorkersMode,
} from '../types.js';
```

Add after `const MARKDOWN_INPUT: Record<StatusKey, string> = …;`:

```ts
const MOVE_SELECT: Record<StatusKey, string> = { queue: 'move-queue', working: 'move-working', review: 'move-review' };
```

In `openSetup`, add after `  $<HTMLSelectElement>('epics').value = config?.epics ?? 'ignore';`:

```ts
  for (const key of STATUS_KEYS) $<HTMLSelectElement>(MOVE_SELECT[key]).value = config?.moves[key] ?? 'hive';
```

Insert after `statusFromForm`:

```ts
function movesFromForm(): Moves {
  const read = (key: StatusKey): Mover => $<HTMLSelectElement>(MOVE_SELECT[key]).value as Mover;
  return { queue: read('queue'), working: read('working'), review: read('review') };
}
```

In `saveSetup`'s `body`, add after `      epics: $<HTMLSelectElement>('epics').value as EpicsMode,`:

```ts
      moves: movesFromForm(),
```

- [ ] **Step 3: Build and run the tests**

Run: `pnpm test`
Expected: 260 tests PASS (UI compiles under `strict`).

- [ ] **Step 4: Check the form in the app (manual)**

`pnpm start` in a repo with a GitHub project (or a markdown board): open `configurar`; the `board` panel shows `QUEM MOVE O CARD` under the board fields with the three selects on `Hive`, for both board types. Set `pra "em review", quando o PR abre` to `o agente …` and `de volta pra fila …` to `o agente …`, save: `hive.config.json` reads `"moves": { "working": "hive", "review": "agent", "queue": "agent" }` and `.hive/hive.log` has `config … moves=working:hive,review:agent,queue:agent`. Reopen `configurar`: the selects come back with those values. With a template that moves the card itself (this repo's `/roadmap-flow`) and the signal on green: the worker's prompt file in `.hive/prompts/` ends with `Board moves you own (the Hive will not make them): move it to "In review" when you open the PR; move it back to "<queue>" if you stop without a PR.`; when the PR opens, the card goes to `In review` once (by the agent) and the log has no `setStatus #… → review`; when the session closes, the card does not come back to the queue column and the queue panel does not list the task until the next poll finds it there.

- [ ] **Step 5: Commit**

```bash
git add src/ui/index.html src/ui/app.ts
git commit -m "feat(ui): quem move o card selects in the board setup panel"
```

---

## Notes

- `src/hive.ts` also copies `config.moves` into the boot state (Task 4): the app's normal boot (`bootHive`, when `hive.config.json` exists) builds the state itself and never calls `configure`; without the one-liner, a restart under `queue: agent` would requeue dead slots to the board and `fill` would keep writing `working` until the first `POST /setup`. It is the same line `budget` and `usageRules` already use there.
- `src/server.ts` (551 lines) and `src/ui/app.ts` (535 lines) already exceed the 400-line bullet; this plan adds 6 and 8 lines to them and does not refactor.
- `state-store.ts` is untouched on purpose: `normalize` lets `moves` through `...rest`, and every boot path overwrites it from the config before any event, so a stale or hand-edited value in `state.json` never reaches the reducer.
- Deliberate simplifications: no `setMoves` event (nothing reacts to the change); no `Slot.moves` snapshot per worker (a `reconfigure` mid-session applies the new rule to the running workers' next transition, which is what "the config is the truth" means; the prompt note a running worker already got is not rewritten); `MOVE_KEYS` reused for the parse, the note and the log line instead of three literals; the `moves` fieldset is rendered for both board types and never disabled.
