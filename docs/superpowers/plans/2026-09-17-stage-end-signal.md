# Agent Hive — explicit stage end, awaited kill and in-process continuation (#83): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stage no longer ends at the end of a turn. The worker says it is finished (`POST /hooks/done`, from a trailer the Hive appends to every prompt); a `Stop` without that `done` leaves the slot `waiting` with the session alive, and a `Stop` with it ends the stage. When the next column has a prompt and `session: continue` and the card is what `fill` would pick for the slot, the Hive answers that `Stop` hook with `{ decision: 'block', reason: <next prompt + trailer> }` and the same process goes on in the same slot (no kill, no spawn); otherwise it kills as today and the card waits for a slot. `WorkerHandle.kill()` resolves only when the session/process is gone and the `kill` effect awaits it, so a `spawn` of the same slug later in the batch never hits `duplicate session`. A spawn failure (`started` rejected) frees the slot, keeps the card in its column with `error`, keeps it out of `fill` and shows the failure on the card and in the bar; a manual `start` clears it and retries.

**Architecture:** Reducer first: `Slot.done`, `Card.error`, `HiveEvent` `done` / `spawnFailed`, `Effect` `continue`, `SlotEventKind` `continuing`; `finish` computes the state "as if freed" and either continues in place (`setColumn(onFinish)`, `setColumn(next.onStart)`, `continue`) or kills as today; `candidates` skips cards with `error`; `start` clears it. Then the process layer: `WorkerHandle.started: Promise<void>` and `kill(): Promise<void>` for tmux (chained on `new-session`, resolved after `kill-session`) and iTerm (`pkill`, then `pgrep` every 200 ms up to 10 s); `WorkerPool.kill` / `killAll` return promises and `start` reports a rejected `started` through `StartWorker.onSpawnFailed`. Then the server: `doneTrailer(port, workerId)` appended to every prompt, `POST /hooks/done`, `dispatch` returning `Effect[]`, the `continue` effect writing the run's prompt file and storing a pending reply, `/hooks/event` answering `204` empty or `200` JSON, `kill` awaited, `close` awaiting `killAll`, `hookCommand` without `>/dev/null`. Then the UI (error badge on the card, `event.continuing` text) and one sentence in `hive-flow.md`.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (root `tsc` ESM `nodenext` with `.js` extensions; UI `moduleResolution: bundler`, `jsx: react-jsx`), Electron, Express 5, `node:test` + `node:assert/strict`, Vite + React 19 + shadcn/ui, Vitest + Testing Library, Biome. No new dependency: `pgrep` / `pkill` run through `execFile` argv arrays.

**Spec:** `docs/superpowers/specs/2026-09-17-stage-end-signal-design.md` (extends the columns and worker-session specs `2026-09-17-hive-columns-design.md` and `2026-09-17-worker-claude-session-design.md`; anything not covered there stays as in `2026-09-15-agent-hive-design.md`). Its "Closed decisions" table is binding and this plan does not reopen any row.

## Global Constraints

- All v1 and setup constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts`, `run.ts`, `state-store.ts` do not change (one exception below: `EVENT_KINDS` in `state-store.ts` gains `continuing`, one token).
- `Task.id` is a string in every adapter (`String(issue.number)` for GitHub, the `id` cell for markdown); `Task.itemId` stays the adapter's internal key (project item id / the same `id`).
- The markdown adapter never caches: every `listQueue` / `setStatus` / `setupOptions` re-reads the file. `setStatus` changes one cell of one line and writes tmp + rename; every other byte is preserved. No file lock.
- `POST /setup` order: `parseConfig` → (markdown: create the file if missing) → `resolveFields` → write `hive.config.json` (tmp + rename) → `configure` / `reconfigure`. The markdown file creation is the only write under `<repo>` allowed before `resolveFields`, and only when the file does not exist.
- Status codes: validation / board errors on `POST /setup` → 400; board failures on listing routes → 502; write / boot failures (including creating the markdown file) → 500.
- `createBoard(config, deps)` needs `deps.repo`. `createServer` defaults `boardFactory` to `(config) => createBoard(config, { repo })`; `test/setup.test.ts` keeps its fake factory and always saves `maxConcurrent: 0`, except one test using the real factory with a markdown board (touches only a local file).
- Legacy `{ "project": { owner, number } }` without `board` parses as `{ type: 'github', owner, number }`; saving from the UI rewrites the file in the new format.
- `NODE_PATH= pnpm test` must stay green after every task (27 `node:test` files with 283 tests, plus 5 Vitest files with 11 tests today → 28 `node:test` files with 298 tests, plus 5 Vitest files with 12 tests at the end). One commit per green task.

Constraints specific to this plan (in addition to the ones above):

- The reducer decides everything (`done`, `waiting`, continuation, spawn failure); the server only carries the reply. `applyHook` `Stop` is `slot.done ? fill(finish(…)) : waiting`; the Hive never answers `block` to a `Stop` without `done` (no token loop), and `stop_hook_active` is ignored.
- Continuation conditions, exactly: `next.prompt` set, `next.session === 'continue'`, `!slot.draining`, `canSchedule(freed, now)` on the state as if the slot were freed, and the card is `candidates(freed.cards, freed.columns)[0]`. Effect order on continuation: `setColumn(onFinish)` if `shouldWrite`, then `setColumn(next.onStart)` if `shouldWrite` against the already updated `boardColumn`, then `continue`. Otherwise `kill`, `setColumn(onFinish)`, card in `next` (or out) waiting for a slot, as today.
- Effects of one `dispatch` run in order and the `kill` effect awaits `pool.kill`; a `spawn` of the same slug in the same batch only starts after the session is gone.
- `WorkerHandle.kill()` is one kill per handle (a second call returns the same promise) and resolves when the session/process no longer exists; a `kill-session` failure or a `pgrep` cap reports through `onError` and resolves anyway. A `started` rejection never calls `onExit` nor `onError`: the pool removes the entry and calls `onSpawnFailed(message)`.
- `/hooks/event` answers an empty `204` after its own dispatch, except when that dispatch produced a `continue` effect for the same worker: `200` `{ "decision": "block", "reason" }`. A pending reply is taken only by the request whose dispatch produced it. `/hooks/done` answers `204` before dispatching (unknown or empty slot: ignored; repeated: idempotent). `/hooks/exit` and `/hooks/status` are unchanged.
- `hookCommand` no longer discards stdout (`-d @-; exit 0`): an empty stdout is "no decision", the JSON is how the `reason` reaches Claude Code.
- `candidates` never returns a card with `error`; only a manual `start` clears it. No automatic retry of a failed spawn.
- Code comments and log lines in English; identifiers in English; UI copy only through `src/ui/i18n.ts` in both `pt` and `en` (`event.continuing`); the error badge shows the spawner's message itself, no new key.
- `killStray` / `isStrayAlive` are `execFile` argv (`pkill` / `pgrep -f -- --worktree=<slug>`); the only shell string in the repo stays `workerCommand`.
- Files < 800 lines, functions < 50 lines; `pnpm lint` (Biome, `--error-on-warnings`) clean; `pnpm exec tsc -p src/ui` clean after the UI task.

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `SlotEventKind` + `continuing`; `Card.error?`; `Slot.done?: true`; `HiveEvent` + `done`, `spawnFailed`; `Effect` + `continue`; `WorkerHandlers` doc; `WorkerHandle.started`, `kill(): Promise<void>` |
| `src/orchestrator.ts` | `reduce` cases `done` / `spawnFailed`; `done`; `applyHook` `Stop` by `slot.done`; `finish` with `canContinue` / `continueInPlace`; `spawnFailed`; `start` clears `error`; `occupy` explicit `done: undefined` |
| `src/cards.ts` | `candidates` excludes a card with `error` |
| `src/log.ts` | `describeEvent` for `done`, `spawnFailed`; `describeEffect` for `continue` |
| `src/state-store.ts` | `EVENT_KINDS` + `continuing` (a saved `lastEvent` of that kind is kept) |
| `src/ui/i18n.ts` | `event.continuing` in `en` and `pt`; `EVENT_KEY.continuing` |
| `src/spawn.ts` | `doneTrailer(port, workerId)`; `killStray(slug, exec?)`, `isStrayAlive(slug, exec?)` over a shared `matchWorker` |
| `src/spawn-tmux.ts` | `started` = the `new-session` promise (rejects `tmux: …`, no `onExit`); `kill()` chained on `started`, resolved after `kill-session`, memoized |
| `src/spawn-iterm.ts` | `ItermDeps { exec, sleep }`; `started` = the tab promise (rejects `iTerm: …`, no `onExit`); `kill()` = `killStray` then `pgrep` every 200 ms, 10 s cap → `onError`; memoized |
| `src/workers.ts` | `StartWorker.onSpawnFailed`; `start` handles `started` rejection; `kill(): Promise<boolean>`; `killAll(): Promise<void>` |
| `src/server.ts` | `POST /hooks/done`; `onSpawnFailed` in `spawn`; `kill` effect awaited; `close` awaits `killAll`; `stagePrompt` (prompt + trailer) at spawn and continuation; `dispatch(): Promise<Effect[]>`; `continue` effect + pending replies; `/hooks/event` `204` / `200` JSON |
| `src/server-cards.ts` | `CardRouteDeps.dispatch` returns `Promise<Effect[]>` |
| `src/hooks-settings.ts` | `postStdin(port, path, timeout)`; `hookCommand` without `>/dev/null`, `-m 30` (board writes precede the reply); `statusCommand` keeps `-m 2` |
| `src/ui/components/HiveBoard.tsx` | destructive `Badge` with the spawn error (title = message); the `start` button already shows for a stopped card |
| `.claude/commands/hive-flow.md` | one sentence: the stage ends with the trailer's `/hooks/done`; a turn without it leaves the slot yellow |
| `test/fakes.ts` | `FakeSpawnOptions { startError?, holdKills? }`; `FakeWorker.releaseKill()`; handles with `started` and async `kill` |
| `test/orchestrator.test.ts` | `stopped` / `counted` post `done` first; `done` helper; +4 tests (39 → 43) |
| `test/log.test.ts` | `done`, `spawnFailed`, `continue` descriptions (12 → 12) |
| `test/i18n.test.ts` | `event.continuing` in both languages (4 → 4) |
| `test/workers.test.ts` | async `kill` / `killAll`; `onSpawnFailed`; +2 tests (8 → 10) |
| `test/spawn-tmux.test.ts` | `started` rejects without `onExit`; awaited `kill`; +1 test (4 → 5) |
| `test/spawn-iterm.test.ts` | new — 3 tests (there is no iTerm spawner test today) |
| `test/spawn.test.ts` | `doneTrailer`, `isStrayAlive` (10 → 11) |
| `test/hooks-settings.test.ts` | `hookCommand` without `>/dev/null`, `-m 30` (5 → 5) |
| `test/server.test.ts` | `hookDone` helper; `done` before every ending `Stop`; `204` / `200` replies; trailer in the prompt file; +4 tests (24 → 28) |
| `test/ui/HiveBoard.test.tsx` | +1 test: error badge + `iniciar` (3 → 4) |

---

### Task 1: Reducer — `done`, `waiting` Stop, in-place continuation, `spawnFailed`, `POST /hooks/done` (TDD)

**Files:**
- Modify: `src/types.ts`, `src/orchestrator.ts`, `src/cards.ts`, `src/log.ts`, `src/state-store.ts`, `src/ui/i18n.ts`, `src/server.ts`
- Test: `test/orchestrator.test.ts`, `test/log.test.ts`, `test/i18n.test.ts`, `test/server.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`):
  - `type SlotEventKind = 'starting' | 'manualStart' | 'prompt' | 'tool' | 'waiting' | 'pr' | 'turn' | 'continuing'`
  - `Card.error?: string` — the last spawn failure; out of `fill` until a manual `start`
  - `Slot.done?: true` — `/hooks/done` received in this run; cleared on spawn and on continuation
  - `HiveEvent` `| { type: 'done'; workerId: string } | { type: 'spawnFailed'; workerId: string; message: string }`
  - `Effect` `| { type: 'continue'; workerId: string; card: Card; column: Column }`
- Produces (in `src/orchestrator.ts`): `reduce` handles `done` (no fill) and `spawnFailed` (`fill`); `applyHook` `Stop` → `slot.done ? fill(finish(…)) : patch(status: 'waiting', question: undefined, lastEvent: { kind: 'turn' })`; `finish` → continuation or kill as above; `start` clears `error`.
- Produces (in `src/cards.ts`): `candidates` filters `c.error === undefined`.
- Produces (in `src/log.ts`): `describeEvent` → `done worker=<id8>`, `spawnFailed worker=<id8> <message>`; `describeEffect` → `continue column=<name> worker=<id8>`.
- Produces (in `src/ui/i18n.ts`): `'event.continuing'` — en `'continuing in the same session'`, pt `'continuando na mesma sessão'`.
- Produces (in `src/server.ts`): `POST /hooks/done` (header `x-hive-worker`) → `204`, then `dispatch({ type: 'done', workerId })`.
- Consumed by: Task 2 (`spawnFailed` from the pool), Task 3 (`continue` effect, `done` route in the reply tests), Task 4 (`error` badge, `continuing` text).

- [ ] **Step 1: Update `test/orchestrator.test.ts`**

Replace the `stopped` and `counted` helpers (lines 24–26) with:

```ts
const done = (state: State, workerId: string): State => reduce(state, { type: 'done', workerId }).state;
// The worker's Stop after its /hooks/done: what ends a stage now
const stopped = (state: State, workerId: string) => hook(done(state, workerId), workerId, { hook_event_name: 'Stop' });
const counted = (state: State, workerId: string, tokens: number) =>
  reduce(done(state, workerId), { type: 'hook', workerId, payload: { hook_event_name: 'Stop' }, tokens }).state;
```

In the test `reducer never mutates its input`, after the line `reduce(first, { type: 'setColumns', columns: [] });` add:

```ts
  reduce(first, { type: 'done', workerId: id });
  reduce(first, { type: 'spawnFailed', workerId: id, message: 'tmux: boom' });
```

In the test `Stop or SessionEnd from a child session changes nothing …`, replace the last line (`assert.deepEqual(hook(started, id, { hook_event_name: 'Stop', session_id: mainId }).effects[0].type, 'kill');`) with:

```ts
  assert.deepEqual(hook(done(started, id), id, { hook_event_name: 'Stop', session_id: mainId }).effects[0].type, 'kill');
```

Append after the `mergeCards is pure …` test:

```ts
test('done marks the occupied slot; a Stop without it leaves the slot waiting with no effects and the card in place; a prompt or a tool brings it back; boot clears it', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const { state, effects } = hook(first, id, { hook_event_name: 'Stop' });
  assert.equal(effects.length, 0, 'no kill, no write, no spawn');
  assert.equal(state.slots[0].status, 'waiting');
  assert.deepEqual(state.slots[0].lastEvent, { kind: 'turn' });
  assert.equal(state.slots[0].workerId, id, 'the session stays alive');
  assert.deepEqual([card(state, 1)?.column, card(state, 1)?.slotId], ['spec', first.slots[0].id]);
  assert.equal(hook(state, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).state.slots[0].status, 'working');
  assert.equal(hook(state, id, { hook_event_name: 'UserPromptSubmit' }).state.slots[0].status, 'working');
  const marked = done(state, id);
  assert.equal(marked.slots[0].done, true);
  assert.equal(marked.slots[0].status, 'waiting', 'done alone changes nothing else');
  assert.equal(done(marked, id).slots[0].done, true, 'idempotent');
  assert.equal(done(first, 'ghost'), first, 'unknown worker: same object');
  assert.equal(reduce(marked, { type: 'boot' }).state.slots[0].done, undefined);
  assert.equal(stopped(signaled(state, 'yellow').state, id).effects[0].type, 'kill', 'with done the Stop ends the stage');
});

test('Stop with done continues in place when the next column has a prompt and session continue and the card is next in line: no kill, same worker, onFinish then onStart written, card in the next column with its slot', () => {
  const first = filled(1, 1).state; // green: spec → dev, dev continues the session
  const id = first.slots[0].workerId!;
  const { state, effects } = stopped(first, id);
  const moved = card(state, 1)!;
  assert.deepEqual(effects, [
    { type: 'setColumn', itemId: 'item1', column: 'Ready' },
    { type: 'setColumn', itemId: 'item1', column: 'In progress' },
    { type: 'continue', workerId: id, card: moved, column: COLUMNS[1] },
  ]);
  assert.deepEqual([moved.column, moved.boardColumn, moved.slotId, moved.sessionId], ['dev', 'In progress', first.slots[0].id, card(first, 1)?.sessionId]);
  const slot = state.slots[0];
  assert.deepEqual([slot.workerId, slot.status, slot.done, slot.question, slot.cardId], [id, 'working', undefined, undefined, 'item1']);
  assert.deepEqual(slot.lastEvent, { kind: 'continuing' });
  assert.equal(slot.startedAt, first.slots[0].startedAt, 'the same run goes on');
  assert.equal(hook(state, id, { hook_event_name: 'Stop' }).effects.length, 0, 'done was cleared: the next Stop waits for a new done');
  const again = stopped(state, id); // dev is the last column with a prompt: the card parks in review, the session dies
  assert.deepEqual(again.effects, [{ type: 'kill', slug: 'hive-1-task-1', workerId: id }, { type: 'setColumn', itemId: 'item1', column: 'In review' }]);
  assert.deepEqual([card(again.state, 1)?.column, card(again.state, 1)?.slotId, again.state.slots[0].status], ['review', undefined, 'empty']);
});

test('Stop with done kills and respawns instead when a heavier card waits, when the next column is new, under yellow, or on a draining slot', () => {
  const two = filled(1, 2).state; // 1 runs in spec, 2 waits in spec (5): heavier than 1 in dev (1)
  const heavier = stopped(two, two.slots[0].workerId!);
  assert.deepEqual(heavier.effects.map((e) => e.type), ['kill', 'setColumn', 'spawn']);
  assert.ok(heavier.effects[2].type === 'spawn' && heavier.effects[2].card.task.id === '2', 'the heavier card takes the slot');
  assert.deepEqual([card(heavier.state, 1)?.column, card(heavier.state, 1)?.slotId], ['dev', undefined]);
  const fresh: Column[] = [COLUMNS[0], { ...COLUMNS[1], session: 'new' }, COLUMNS[2]];
  const one = polled(base(1, fresh), many(1)).state;
  const renewed = stopped(one, one.slots[0].workerId!);
  assert.deepEqual(renewed.effects.map((e) => e.type), ['kill', 'setColumn', 'setColumn', 'spawn'], 'same card, new session: kill then spawn in the same batch');
  assert.ok(renewed.effects[3].type === 'spawn' && renewed.effects[3].card.task.id === '1' && renewed.effects[3].session === 'new');
  assert.notEqual(renewed.state.slots[0].workerId, one.slots[0].workerId);
  const single = filled(1, 1).state;
  const yellow = stopped(signaled(single, 'yellow').state, single.slots[0].workerId!);
  assert.deepEqual(yellow.effects.map((e) => e.type), ['kill', 'setColumn']);
  assert.deepEqual([card(yellow.state, 1)?.column, card(yellow.state, 1)?.slotId, yellow.state.slots[0].status], ['dev', undefined, 'empty']);
  assert.equal(card(yellow.state, 1)?.sessionId, card(single, 1)?.sessionId, 'waits for a slot and resumes later');
  const drained = reduce(filled(2, 2).state, { type: 'setMax', max: 1 }).state; // slot 2 draining
  const gone = stopped(drained, drained.slots[1].workerId!);
  assert.deepEqual(gone.effects.map((e) => e.type), ['kill', 'setColumn']);
  assert.equal(gone.state.slots.length, 1, 'the draining slot leaves');
  assert.deepEqual([card(gone.state, 2)?.column, card(gone.state, 2)?.slotId], ['dev', undefined]);
});

test('spawnFailed frees the slot, keeps the card in its column with the error and sets the bar; fill skips it, another card may take the slot; start clears it and runs', () => {
  const two = filled(1, 2).state; // 1 runs, 2 waits
  const { state, effects } = reduce(two, { type: 'spawnFailed', workerId: two.slots[0].workerId!, message: 'tmux: duplicate session: hive-1-task-1' });
  assert.equal(card(state, 1)?.error, 'tmux: duplicate session: hive-1-task-1');
  assert.deepEqual([card(state, 1)?.column, card(state, 1)?.slotId], ['spec', undefined]);
  assert.equal(state.error, 'tmux: duplicate session: hive-1-task-1');
  assert.equal(state.slots[0].cardId, 'item2', 'the freed slot goes to the next card, never back to the failed one');
  assert.deepEqual(effects.map((e) => e.type), ['spawn']);
  assert.deepEqual(candidates(state.cards, state.columns), [], 'a card with an error is never picked');
  assert.equal(reduce(two, { type: 'spawnFailed', workerId: 'ghost', message: 'x' }).state, two, 'unknown worker: same object');
  const single = filled(1, 1).state;
  const failed = reduce(single, { type: 'spawnFailed', workerId: single.slots[0].workerId!, message: 'tmux: spawn tmux ENOENT' });
  assert.equal(failed.effects.length, 0, 'no retry');
  assert.equal(failed.state.slots[0].status, 'empty');
  assert.equal(polled(failed.state, many(1)).effects.length, 0, 'a poll does not retry either');
  assert.equal(card(polled(failed.state, many(1)).state, 1)?.error, 'tmux: spawn tmux ENOENT', 'the error survives the poll');
  const retried = started(failed.state, 'item1');
  assert.equal(card(retried.state, 1)?.error, undefined, 'start clears it');
  assert.deepEqual(retried.effects.map((e) => e.type), ['spawn']);
  assert.deepEqual(retried.state.slots[0].lastEvent, { kind: 'manualStart' });
});
```

- [ ] **Step 2: Update `test/log.test.ts`**

In `describeEvent summarises every other event …`, after the `keepCard` assertion add:

```ts
  assert.equal(describeEvent({ type: 'done', workerId: WORKER }), 'done worker=1a2b3c4d');
  assert.equal(describeEvent({ type: 'spawnFailed', workerId: WORKER, message: 'tmux: duplicate session: hive-30-logs' }), 'spawnFailed worker=1a2b3c4d tmux: duplicate session: hive-30-logs');
```

Rename `describeEffect: spawn, setColumn and kill` to `describeEffect: spawn, setColumn, kill and continue` and append inside it:

```ts
  assert.equal(describeEffect({ type: 'continue', workerId: WORKER, card: cardFor('30'), column }), 'continue column=dev worker=1a2b3c4d');
```

- [ ] **Step 3: Update `test/i18n.test.ts`**

In `statusText and slotEventText follow the language …`, add after the `turno encerrado` line:

```ts
  assert.equal(slotEventText({ kind: 'continuing' }), 'continuando na mesma sessão');
```

and after the `PR open` line:

```ts
  assert.equal(slotEventText({ kind: 'continuing' }), 'continuing in the same session');
```

- [ ] **Step 4: Update `test/server.test.ts`**

After the `hookEvent` helper add:

```ts
// The trailer's curl: the worker says the command is finished. No body, only the header.
const hookDone = (base: string, workerId: string): Promise<Response> => fetch(`${base}/hooks/done`, { method: 'POST', headers: { 'x-hive-worker': workerId } });
```

Replace the test `a Stop ends the run: …` with:

```ts
test('a Stop before /hooks/done leaves the slot waiting; after it the Stop ends the run: the session is killed, onFinish written, the card leaves (single column) and the slot frees; a PR seen before stays on the card until then', async (t) => {
  const { log, lines } = fakeLog();
  const { base, server, workers } = await start(t, BODY, log);
  const [worker] = workers;
  const workerId = slot0(server).workerId!;
  await openPr(server, workerId);
  assert.equal(slot0(server).status, 'review');
  assert.equal(card0(server).prUrl, 'https://github.com/acme/r/pull/9');
  assert.equal(worker.killed, 0, 'a PR is not a transition any more');
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'Stop' })).status, 200);
  assert.equal(worker.killed, 0, 'no done yet: the worker is idle, not finished');
  assert.equal(slot0(server).status, 'waiting');
  assert.equal(card0(server).column, 'fila');
  assert.equal((await hookDone(base, workerId)).status, 204);
  assert.equal(slot0(server).done, true);
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'Stop' })).status, 200);
  assert.equal(worker.killed, 1, 'killed through the effect, before the answer');
  assert.equal(slot0(server).status, 'empty');
  assert.deepEqual(server.getState()?.cards, [], 'fila is the last column');
  assert.ok(lines.includes('INFO setColumn #I1 → In review ok'), lines.join('\n'));
  worker.handlers.onExit();
  await sleep(20);
  assert.equal(workers.length, 1, 'the exit of a killed session is a no-op');
});
```

In `a Stop from a child session … (#24)`, insert `assert.equal((await hookDone(base, workerId)).status, 204);` right after the `SessionStart` assertion (before the child `Stop`), and change the assertion after the child `Stop` to `assert.equal(slot0(server).status, 'working', 'a child Stop is not even a turn end');`.

- [ ] **Step 5: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build errors — `Type '"continuing"' is not assignable to type 'SlotEventKind'`, `Type '"done"' is not assignable …` on `HiveEvent`, `'error' does not exist in type 'Card'`.

- [ ] **Step 6: Edit `src/types.ts`**

Line 6 → `export type SlotEventKind = 'starting' | 'manualStart' | 'prompt' | 'tool' | 'waiting' | 'pr' | 'turn' | 'continuing';`

In `Card`, after `orphan?: true; …` add:

```ts
  error?: string; // the last spawn failure; the card stays out of fill until a manual start clears it
```

In `Slot`, after `sessionId?: string; …` add:

```ts
  done?: true; // /hooks/done received in this run: the next Stop ends the stage. Cleared on spawn and on continuation
```

In `HiveEvent`, after the `keepCard` member (turn its `;` into `|` continuation):

```ts
  | { type: 'keepCard'; cardId: string } // manter on a missing card
  | { type: 'done'; workerId: string } // the worker says the command is finished (POST /hooks/done)
  | { type: 'spawnFailed'; workerId: string; message: string }; // the spawner could not open the session / tab
```

In `Effect`:

```ts
export type Effect =
  | { type: 'spawn'; slot: Slot; card: Card; column: Column; session: SessionPolicy } // session already resolved: continue without an id runs as new
  | { type: 'setColumn'; itemId: string; column: string }
  | { type: 'kill'; slug: string; workerId: string }
  | { type: 'continue'; workerId: string; card: Card; column: Column }; // answers the worker's Stop with `column`'s prompt: same process, no spawn
```

- [ ] **Step 7: Edit `src/cards.ts`** — replace `candidates`:

```ts
/** Cards a free slot may take, best first: stopped, present on the board, unblocked, without a spawn failure, in a column with a prompt;
 * higher weight wins, ties keep board order. A card with `error` waits for a manual start: retrying would fail the same way. */
export function candidates(cards: Card[], columns: Column[]): Card[] {
  const weight = (card: Card): number => columnOf(columns, card.column)?.weight ?? 0;
  const runnable = cards.filter((c) =>
    c.slotId === undefined && !c.missing && c.error === undefined && !isBlocked(c.task) && columnOf(columns, c.column)?.prompt !== undefined);
  return [...runnable].sort((a, b) => weight(b) - weight(a)); // sort is stable: equal weights keep the listing order
}
```

- [ ] **Step 8: Edit `src/orchestrator.ts`**

In `reduce`, after `case 'exit': …` add:

```ts
    case 'done': return done(state, event.workerId); // no fill: nothing freed, nothing loosened
    case 'spawnFailed': return fill(spawnFailed(state, event.workerId, event.message)); // the slot frees; the failed card is out of the candidates, the next one may take it
```

In `occupy`, the slot literal becomes (explicit `done: undefined`, so a run never inherits a previous `done`):

```ts
  const slot: Slot = { id: state.slots[index].id, workerId: randomUUID(), cardId: cardId(card), status: 'working', startedAt: new Date().toISOString(), lastEvent: { kind }, done: undefined };
```

In `start`, replace the last line with:

```ts
  const { error: _error, ...retried } = card; // a manual start clears the last spawn failure and tries again
  return index < 0 ? none(state) : occupy(base, index, retried, column, 'manualStart'); // never throws: a reducer that throws takes the route with it
```

Replace `finish` (the whole function) with:

```ts
// The end of the command (a Stop after /hooks/done): the board learns the outcome and the card moves on (or leaves after the last
// column). The worker goes on in place with the next column's prompt when it can, otherwise the session dies and the card waits for a slot.
function finish(state: State, workerId: string): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  const card = slot && cardOf(state.cards, slot);
  if (!slot || !card) return exit(state, workerId);
  const column = columnOf(state.columns, card.column);
  const write = shouldWrite(card, column?.onFinish);
  const next = column && nextColumn(state.columns, column.name);
  const moved: Card = { ...dropSlot(card), column: next?.name ?? card.column, ...(write ? { boardColumn: column?.onFinish as string } : {}) };
  const cards = next ? state.cards.map((c) => (cardId(c) === cardId(card) ? moved : c)) : state.cards.filter((c) => cardId(c) !== cardId(card));
  const freed: State = { ...state, slots: freeSlot(state.slots, slot), cards }; // as if the slot were free: what fill would see
  const finished: Effect[] = write ? [{ type: 'setColumn', itemId: cardId(card), column: column?.onFinish as string }] : [];
  if (next && canContinue(freed, slot, moved, next)) return continueInPlace(freed, slot, workerId, moved, next, finished);
  return { state: freed, effects: [{ type: 'kill', slug: card.slug, workerId }, ...finished] };
}

// In-place continuation: the next column continues the session with a prompt, the slot is not draining, the gate is open on the state
// as if freed, and the card is what fill would pick for that slot (a heavier card waiting wins it; the card then resumes later).
function canContinue(freed: State, slot: Slot, moved: Card, next: Column): boolean {
  if (next.prompt === undefined || next.session !== 'continue' || slot.draining) return false;
  if (!canSchedule(freed, Date.now())) return false;
  const top = candidates(freed.cards, freed.columns)[0];
  return top !== undefined && cardId(top) === cardId(moved);
}

// Same process, same slot, same workerId: the Stop is answered with the next column's prompt (the `continue` effect). onFinish is
// written first, then onStart against the board column as just updated, so the board sees both moves in order.
function continueInPlace(freed: State, slot: Slot, workerId: string, moved: Card, next: Column, finished: Effect[]): Reduced {
  const { onStart } = next;
  const write = shouldWrite(moved, onStart);
  const kept: Slot = { ...slot, status: 'working', done: undefined, question: undefined, lastEvent: { kind: 'continuing' } };
  const card: Card = { ...moved, slotId: slot.id, ...(write ? { boardColumn: onStart } : {}) };
  return {
    state: withCard({ ...freed, slots: freed.slots.map((s) => (s.id === slot.id ? kept : s)) }, card),
    effects: [...finished, ...(write ? [{ type: 'setColumn' as const, itemId: cardId(card), column: onStart }] : []), { type: 'continue', workerId, card, column: next }],
  };
}
```

After `exit` add:

```ts
// /hooks/done from the worker: the command says it is finished, so the next Stop of this run ends the stage. Unknown or empty slot: ignored.
function done(state: State, workerId: string): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  return !slot || slot.status === 'empty' ? none(state) : patch(state, workerId, { done: true });
}

// The worker never started (tmux missing, a name taken, iTerm refused): as exit, and the card carries the message and leaves the
// candidates until a manual start; the bar shows it too. No automatic retry: the same fill would fail the same way, in a tight loop.
function spawnFailed(state: State, workerId: string, message: string): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  if (!slot || slot.status === 'empty') return none(state);
  const card = cardOf(state.cards, slot);
  const freed = exit(state, workerId).state;
  return none({ ...(card ? withCard(freed, { ...dropSlot(card), error: message }) : freed), error: message });
}
```

In `applyHook`, replace the `Stop` case:

```ts
    case 'Stop': // the end of the command only after /hooks/done; otherwise the worker is idle (an agent running, a question asked): the slot waits
      return slot.done ? fill(finish(state, workerId)) : patch(state, workerId, { status: 'waiting', question: undefined, lastEvent: { kind: 'turn' } });
```

- [ ] **Step 9: Edit `src/log.ts`**

In `describeEvent`, after `case 'keepCard': …`:

```ts
    case 'done': return `done worker=${shortId(event.workerId)}`;
    case 'spawnFailed': return `spawnFailed worker=${shortId(event.workerId)} ${event.message}`;
```

In `describeEffect`, after `case 'kill': …`:

```ts
    case 'continue': return `continue column=${effect.column.name} worker=${shortId(effect.workerId)}`;
```

- [ ] **Step 10: Edit `src/state-store.ts`** line 25:

```ts
const EVENT_KINDS: readonly SlotEventKind[] = ['starting', 'manualStart', 'prompt', 'tool', 'waiting', 'pr', 'turn', 'continuing'];
```

- [ ] **Step 11: Edit `src/ui/i18n.ts`**

After `'event.turn': 'turn ended',` add `'event.continuing': 'continuing in the same session',`; after `'event.turn': 'turno encerrado',` add `'event.continuing': 'continuando na mesma sessão',`. Replace `EVENT_KEY`:

```ts
const EVENT_KEY: Record<Exclude<SlotEventKind, 'tool'>, MessageKey> = {
  starting: 'event.starting', manualStart: 'event.manualStart', prompt: 'event.prompt', waiting: 'event.waiting', pr: 'event.pr', turn: 'event.turn',
  continuing: 'event.continuing',
};
```

- [ ] **Step 12: Edit `src/server.ts`** — the `done` route

After the `HTTP_BAD_GATEWAY` constant add `const HTTP_NO_CONTENT = 204; // hook routes: an empty body is "no decision" for Claude Code`. After the `/hooks/exit` route add:

```ts
  // The worker's own word that the command is finished (the trailer's curl): the next Stop of this run ends the stage.
  app.post('/hooks/done', async (req: Request, res: Response) => {
    res.status(HTTP_NO_CONTENT).end();
    const workerId = req.header('x-hive-worker');
    if (workerId) await dispatch({ type: 'done', workerId });
  });
```

- [ ] **Step 13: Run tests to verify they pass**

Run: `pnpm lint && NODE_PATH= pnpm test`
Expected: 287 `node:test` tests PASS (`orchestrator` 43, `log` 12, `i18n` 4, `server` 24); Vitest 11 PASS.

- [ ] **Step 14: Commit**

```bash
git add src/types.ts src/orchestrator.ts src/cards.ts src/log.ts src/state-store.ts src/ui/i18n.ts src/server.ts test/orchestrator.test.ts test/log.test.ts test/i18n.test.ts test/server.test.ts
git commit -m "feat(orchestrator): stage ends on /hooks/done, Stop without it waits, in-place continuation and spawnFailed (#83)"
```

---

### Task 2: Spawners and pool — `started`, awaited `kill`, `onSpawnFailed`; the server awaits kills (TDD)

**Files:**
- Modify: `src/types.ts`, `src/spawn.ts`, `src/spawn-tmux.ts`, `src/spawn-iterm.ts`, `src/workers.ts`, `src/server.ts`, `test/fakes.ts`
- Create: `test/spawn-iterm.test.ts`
- Test: `test/workers.test.ts`, `test/spawn-tmux.test.ts`, `test/spawn.test.ts`, `test/server.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `interface WorkerHandle { started: Promise<void>; kill(): Promise<void>; focus(): Promise<void> }`; `WorkerHandlers` unchanged in shape (`onError` only for kill / focus).
- Produces (in `src/spawn.ts`): `killStray(slug, exec = execFileAsync): Promise<boolean>` (unchanged behaviour, injectable); `isStrayAlive(slug, exec = execFileAsync): Promise<boolean>` (`pgrep -f -- --worktree=<slug>`).
- Produces (in `src/spawn-tmux.ts`): `spawnTmuxWorker(launch, handlers, deps?)` — `started` rejects with `tmux: <message>` and calls nothing; `kill()` chains on `started` (settled either way), runs `kill-session`, reports a failure through `onError`, resolves after it and then `onExit` once; memoized.
- Produces (in `src/spawn-iterm.ts`): `interface ItermDeps { exec: Exec; sleep(ms: number): Promise<void> }`; `spawnItermWorker(launch, handlers, deps?: Partial<ItermDeps>)` — `started` rejects with `iTerm: <message>`; `kill()` = `killStray` then `isStrayAlive` every `KILL_POLL_MS = 200` up to `KILL_TIMEOUT_MS = 10_000` (50 polls); past it `onError('kill: worker still alive after 10s')`; memoized.
- Produces (in `src/workers.ts`): `StartWorker.onSpawnFailed(message: string): void`; `WorkerPool.kill(workerId): Promise<boolean>`; `WorkerPool.killAll(): Promise<void>`.
- Produces (in `test/fakes.ts`): `interface FakeSpawnOptions { startError?: string; holdKills?: boolean }`; `fakeSpawn(options?)`; `FakeWorker.releaseKill(): void`.
- Consumed by: `src/server.ts` (`onSpawnFailed` → `spawnFailed`, `await pool.kill`, `await pool.killAll()`), Task 3.

- [ ] **Step 1: Rewrite `fakeSpawn` in `test/fakes.ts`**

```ts
export interface FakeWorker {
  launch: WorkerLaunch;
  handlers: WorkerHandlers;
  killed: number;
  focused: number;
  focusError?: Error; // set by a test: the next focus() rejects, like a terminal that cannot open
  releaseKill(): void; // with holdKills: resolves the pending kill() and makes later kills resolve at once (the process is gone)
}

export interface FakeSpawnOptions {
  startError?: string; // every worker's `started` rejects with it, like tmux missing or a taken name
  holdKills?: boolean; // kill() stays pending until releaseKill(): what the awaited-kill tests need
}

/** A SpawnWorker that opens nothing: records every call and exposes the handlers so a test can report errors and exits. */
export function fakeSpawn(options: FakeSpawnOptions = {}): { spawn: SpawnWorker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const spawn: SpawnWorker = (launch, handlers) => {
    let released = false;
    const pending: (() => void)[] = [];
    const worker: FakeWorker = {
      launch, handlers, killed: 0, focused: 0,
      releaseKill: () => {
        released = true;
        for (const resolve of pending.splice(0)) resolve();
      },
    };
    workers.push(worker);
    return {
      started: options.startError === undefined ? Promise.resolve() : Promise.reject(new Error(options.startError)),
      kill: () => {
        worker.killed += 1;
        if (!options.holdKills || released) return Promise.resolve();
        return new Promise<void>((resolve) => { pending.push(resolve); });
      },
      focus: async () => {
        worker.focused += 1;
        if (worker.focusError) throw worker.focusError;
      },
    };
  };
  return { spawn, workers };
}
```

- [ ] **Step 2: Update `test/workers.test.ts`**

Replace the imports and the `started` helper:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPool } from '../src/workers.js';
import { fakeSpawn, type FakeSpawnOptions, LAUNCH } from './fakes.js';

const noop = (): void => {};
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function started(workerId = 'W1', options: FakeSpawnOptions = {}) {
  const { spawn, workers } = fakeSpawn(options);
  const pool = createWorkerPool(spawn);
  const exits: string[] = [];
  const errors: string[] = [];
  const failures: string[] = [];
  pool.start({
    workerId, launch: { ...LAUNCH, workerId },
    onExit: () => exits.push(workerId), onError: (message) => errors.push(message), onSpawnFailed: (message) => failures.push(message),
  });
  return { pool, worker: workers[0], workers, exits, errors, failures };
}
```

Make `exit removes the worker …` async and change `assert.equal(pool.kill('W1'), false);` to `assert.equal(await pool.kill('W1'), false);`. Make `kill reaches the handle …` async and change its first assertion to `assert.equal(await pool.kill('W1'), true);`. In `killAll sends kill …`: add `onSpawnFailed: noop` to the `pool.start` call, make the test async and `await pool.killAll();`. In `a spawner that reports the exit before returning …`, the returned handle becomes `{ started: Promise.resolve(), kill: async () => {}, focus: async () => {} }` and the `pool.start` call gains `onSpawnFailed: noop`.

Append:

```ts
test('a started that rejects removes the entry and reports onSpawnFailed with the message; neither onExit nor onError fires', async () => {
  const { pool, exits, errors, failures } = started('W1', { startError: 'tmux: duplicate session: hive-1-task' });
  await tick();
  assert.deepEqual(failures, ['tmux: duplicate session: hive-1-task']);
  assert.equal(pool.has('W1'), false);
  assert.deepEqual(exits, []);
  assert.deepEqual(errors, []);
  assert.equal(await pool.kill('W1'), false);
});

test('kill resolves only when the handle kill resolves; killAll waits for every kill', async () => {
  const { spawn, workers } = fakeSpawn({ holdKills: true });
  const pool = createWorkerPool(spawn);
  for (const workerId of ['W1', 'W2']) pool.start({ workerId, launch: { ...LAUNCH, workerId }, onExit: noop, onError: noop, onSpawnFailed: noop });
  let killed = false;
  const kill = pool.kill('W1').then((known) => { killed = true; return known; });
  await tick();
  assert.equal(workers[0].killed, 1);
  assert.equal(killed, false, 'the handle has not resolved yet');
  workers[0].releaseKill();
  assert.equal(await kill, true);
  assert.equal(pool.has('W1'), true, 'the entry only leaves on the exit');
  let all = false;
  const killAll = pool.killAll().then(() => { all = true; });
  await tick();
  assert.deepEqual(workers.map((w) => w.killed), [2, 1]);
  assert.equal(all, false, 'W2 is still being killed');
  workers[1].releaseKill();
  await killAll;
  assert.equal(all, true);
});
```

- [ ] **Step 3: Update `test/spawn-tmux.test.ts`**

Replace `a new-session that fails reports the error and the exit, once` with:

```ts
test('a new-session that fails rejects started with the tmux message and calls neither onError nor onExit', async () => {
  const { exec } = fakeExec('new-session');
  const h = handlers();
  const handle = spawnTmuxWorker(LAUNCH, h.handlers, { exec, openTerminal: noTerminal });
  await assert.rejects(handle.started, { message: 'tmux: new-session boom' });
  assert.deepEqual(h.errors, []);
  assert.equal(h.exits(), 0, 'the pool reports it as spawnFailed; there is no session to exit');
});
```

Replace `kill runs kill-session and reports the exit once, even when kill-session fails` with:

```ts
test('kill runs kill-session and reports the exit once, even when kill-session fails; a second kill is the same kill', async () => {
  const ok = fakeExec();
  const h = handlers();
  const handle = spawnTmuxWorker(LAUNCH, h.handlers, { exec: ok.exec, openTerminal: noTerminal });
  await handle.kill();
  assert.deepEqual(ok.calls[1], { file: 'tmux', args: ['-L', TMUX_SOCKET, 'kill-session', '-t', 'hive-1-task'], env: undefined });
  assert.equal(h.exits(), 1);
  assert.deepEqual(h.errors, []);
  await handle.kill();
  assert.equal(h.exits(), 1, 'a second kill does not exit twice');
  assert.equal(ok.calls.length, 2, 'nor does it run kill-session again: the first kill is the kill');
  const failing = fakeExec('kill-session');
  const h2 = handlers();
  await spawnTmuxWorker(LAUNCH, h2.handlers, { exec: failing.exec, openTerminal: noTerminal }).kill();
  assert.deepEqual(h2.errors, ['tmux: kill-session boom']);
  assert.equal(h2.exits(), 1, 'the session is given as gone either way');
});

test('kill resolves only after kill-session returned, and reports the exit right after', async () => {
  let release = (): void => {};
  const subcommands: string[] = [];
  const exec: Exec = async (_file, args) => {
    subcommands.push(args[2]);
    if (args.includes('kill-session')) await new Promise<void>((resolve) => { release = resolve; });
    return { stdout: '' };
  };
  const h = handlers();
  const handle = spawnTmuxWorker(LAUNCH, h.handlers, { exec, openTerminal: noTerminal });
  await handle.started;
  let resolved = false;
  const kill = handle.kill().then(() => { resolved = true; });
  await tick();
  assert.deepEqual(subcommands, ['new-session', 'kill-session']);
  assert.equal(resolved, false, 'tmux has not answered yet');
  assert.equal(h.exits(), 0);
  release();
  await kill;
  assert.equal(h.exits(), 1);
});
```

- [ ] **Step 4: Create `test/spawn-iterm.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnItermWorker, workerCommand } from '../src/spawn-iterm.js';
import type { Exec } from '../src/types.js';
import { LAUNCH } from './fakes.js';

interface Call { file: string; args: string[] }

// Records every command. osascript answers a tab id (or fails); pkill always matches; pgrep matches `alive` times, then exit 1 (no match).
function fakeExec(options: { alive?: number; openFails?: boolean } = {}): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  let alive = options.alive ?? 0;
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (file === 'osascript') {
      if (options.openFails) throw new Error('osascript boom');
      return { stdout: 'w0t1p0:ABCD\n' };
    }
    if (file === 'pgrep' && alive-- <= 0) throw Object.assign(new Error('no match'), { code: 1 });
    return { stdout: '' };
  };
  return { exec, calls };
}

function handlers() {
  const errors: string[] = [];
  let exits = 0;
  return { errors, exits: () => exits, handlers: { onError: (m: string) => errors.push(m), onExit: () => { exits += 1; } } };
}
const noSleep = async (): Promise<void> => {};
const PGREP = ['pgrep', '-f', '--', '--worktree=hive-1-task'];

test('spawnItermWorker opens a tab typing workerCommand and started resolves once it exists; a failed osascript rejects started with the iTerm message and calls neither onError nor onExit', async () => {
  const ok = fakeExec();
  const h = handlers();
  const handle = spawnItermWorker(LAUNCH, h.handlers, { exec: ok.exec, sleep: noSleep });
  await handle.started;
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].file, 'osascript');
  assert.equal(ok.calls[0].args[2], workerCommand(LAUNCH));
  const failing = fakeExec({ openFails: true });
  const h2 = handlers();
  await assert.rejects(spawnItermWorker(LAUNCH, h2.handlers, { exec: failing.exec, sleep: noSleep }).started, { message: 'iTerm: osascript boom' });
  assert.deepEqual(h2.errors, []);
  assert.equal(h2.exits(), 0, 'the pool reports it as spawnFailed; the exit only ever comes from the curl trailer');
});

test('kill runs pkill by slug and resolves only once pgrep finds nothing, sleeping 200 ms between polls; a second kill is the same kill', async () => {
  const { exec, calls } = fakeExec({ alive: 2 });
  const h = handlers();
  const slept: number[] = [];
  const handle = spawnItermWorker(LAUNCH, h.handlers, { exec, sleep: async (ms) => { slept.push(ms); } });
  await handle.started;
  await handle.kill();
  assert.deepEqual(calls.slice(1).map((c) => [c.file, ...c.args]), [['pkill', '-f', '--', '--worktree=hive-1-task'], PGREP, PGREP, PGREP]);
  assert.deepEqual(slept, [200, 200], 'one wait per match');
  assert.deepEqual(h.errors, []);
  assert.equal(h.exits(), 0, 'the tab reports its own exit through the trailer');
  await handle.kill();
  assert.equal(calls.length, 5, 'the first kill is the kill');
});

test('kill gives up after 10 s of matches (50 polls of 200 ms), resolves and reports it through onError', async () => {
  const { exec, calls } = fakeExec({ alive: 1000 });
  const h = handlers();
  await spawnItermWorker(LAUNCH, h.handlers, { exec, sleep: noSleep }).kill();
  assert.equal(calls.filter((c) => c.file === 'pgrep').length, 50);
  assert.deepEqual(h.errors, ['kill: worker still alive after 10s']);
});
```

- [ ] **Step 5: Update `test/spawn.test.ts`**

Change the import to `import { isStrayAlive, killStray, renderPrompt, workerArgs, workerEnv, writePrompt } from '../src/spawn.js';` and replace `killStray resolves false when no process matches` with:

```ts
test('killStray and isStrayAlive resolve false when no process matches', async () => {
  assert.equal(await killStray('definitely-not-running-slug-xyz'), false);
  assert.equal(await isStrayAlive('definitely-not-running-slug-xyz'), false);
});
```

- [ ] **Step 6: Update `test/server.test.ts`**

Change the fakes import to `import { COLUMNS, type FakeSpawnOptions, fakeBoardFactory, fakeLog, fakeSpawn, type FakeWorker } from './fakes.js';`, add `Column` and `Effect` to the `../src/types.js` type import, change `openPr`'s return type to `Promise<Effect[]>`, and give `start` a fourth parameter:

```ts
async function start(t: TestContext, body: SetupBody = BODY, log?: Logger, spawnOptions: FakeSpawnOptions = {}): Promise<Started> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { spawn, workers } = fakeSpawn(spawnOptions);
```

(`openPr`'s type change only compiles from Task 3 on when `dispatch` returns `Effect[]`; `Promise<Effect[]>` is not assignable from `Promise<void>` either, so in this task write it as `Promise<unknown>` and switch it to `Promise<Effect[]>` in Task 3.)

Append:

```ts
test('a spawn failure frees the slot and marks the card with the message: the bar shows it, neither fill nor a poll retries, a manual start does', async (t) => {
  const { base, server, workers } = await start(t, BODY, undefined, { startError: 'tmux: spawn tmux ENOENT' });
  await waitFor(() => slot0(server).status === 'empty');
  assert.equal(workers.length, 1, 'no retry');
  assert.equal(card0(server).error, 'tmux: spawn tmux ENOENT');
  assert.equal(card0(server).column, 'fila');
  assert.equal(server.getState()?.error, 'tmux: spawn tmux ENOENT');
  assert.deepEqual(await json(postJson(`${base}/board/refresh`)), { ok: true });
  assert.equal(workers.length, 1, 'a poll does not retry either');
  assert.equal(card0(server).error, 'tmux: spawn tmux ENOENT', 'the error survives the poll');
  assert.deepEqual(await json(postJson(`${base}/cards/I1/start`)), { ok: true });
  assert.equal(workers.length, 2, 'the manual start runs it again');
  await waitFor(() => slot0(server).status === 'empty'); // the fake fails every time: the card shows the error again
  assert.equal(card0(server).error, 'tmux: spawn tmux ENOENT');
});

test('the kill effect waits for the pool before the next effect: a new column of the same card only spawns after the old session is gone', async (t) => {
  const columns: Column[] = [
    { name: 'plan', weight: 2, from: ['Ready'], onFinish: 'In progress', prompt: '/hive-plan {url}' },
    { name: 'dev', weight: 1, from: ['In progress'], onFinish: 'In review', prompt: '/hive-build {url}' },
  ];
  const { base, server, workers } = await start(t, { ...BODY, columns }, undefined, { holdKills: true });
  const workerId = slot0(server).workerId!;
  await hookDone(base, workerId);
  const stop = hookEvent(base, workerId, { hook_event_name: 'Stop' }); // answered only after every effect ran
  await waitFor(() => workers[0].killed === 1);
  await sleep(20);
  assert.equal(workers.length, 1, 'no spawn while the kill is pending');
  assert.equal(card0(server).column, 'dev');
  workers[0].releaseKill();
  assert.equal((await stop).status, 200);
  assert.equal(workers.length, 2);
  assert.equal(workers[1].launch.slug, workers[0].launch.slug);
  assert.equal(workers[1].launch.workerId, slot0(server).workerId);
  workers[1].releaseKill(); // close() awaits killAll: nothing may stay pending
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build errors — `'started' does not exist in type 'WorkerHandle'`, `'onSpawnFailed' does not exist in type 'StartWorker'`, `Module '"../src/spawn.js"' has no exported member 'isStrayAlive'`, `Expected 2 arguments, but got 3` on `spawnItermWorker`.

- [ ] **Step 8: Edit `src/types.ts`** — replace `WorkerHandlers` and `WorkerHandle`:

```ts
/** What the server injects so tests never open a session. `onError` is for kill / focus failures: a spawn failure is `started` rejecting. */
export interface WorkerHandlers {
  onExit(): void; // once, on session end or kill
  onError(message: string): void; // shown in the dashboard error bar
}

export interface WorkerHandle {
  started: Promise<void>; // resolves when the session / tab exists; rejects with the spawner's error (`tmux: …`, `iTerm: …`)
  kill(): Promise<void>; // resolves when the session / process no longer exists; one kill per handle
  focus(): Promise<void>; // opens (or brings to the front) the worker's terminal
}
```

- [ ] **Step 9: Edit `src/spawn.ts`**

Replace the imports' `execFileAsync` line and `killStray` (keep `renderPrompt`, `writePrompt`, `workerArgs`, `workerEnv`, `spawnWorker` as they are):

```ts
import type { Card, Column, Exec, SessionPolicy, SpawnWorker, Task } from './types.js';

const execFileAsync: Exec = promisify(execFile);
const NO_MATCH_EXIT = 1;
```

```ts
// pkill / pgrep by the worktree flag every worker carries: true when a process matched; exit 1 is "nothing matched", anything else throws.
async function matchWorker(tool: 'pkill' | 'pgrep', slug: string, exec: Exec): Promise<boolean> {
  try {
    await exec(tool, ['-f', '--', `--worktree=${slug}`]);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code !== NO_MATCH_EXIT) throw err;
    return false;
  }
}

/** Boot-only orphan defense (and the tab's kill): kills a worker that may still hold the worktree. Resolves true when pkill matched. */
export const killStray = (slug: string, exec: Exec = execFileAsync): Promise<boolean> => matchWorker('pkill', slug, exec);

/** Whether a worker of that slug is still running: the tab's kill polls it until it is gone. */
export const isStrayAlive = (slug: string, exec: Exec = execFileAsync): Promise<boolean> => matchWorker('pgrep', slug, exec);
```

- [ ] **Step 10: Rewrite `spawnTmuxWorker` in `src/spawn-tmux.ts`**

```ts
/**
 * A worker in a detached tmux session named after the slug: `claude` gets a real TTY (permission prompts, questions) and
 * the terminal opens only on focus. The command is the same shell string iTerm types; tmux runs it through the shell,
 * so it travels as one argv element. Its `; curl /hooks/exit` trailer reports the natural exit.
 */
export function spawnTmuxWorker(launch: WorkerLaunch, handlers: WorkerHandlers, deps: Partial<TmuxDeps> = {}): WorkerHandle {
  const { exec = execFileAsync, openTerminal: open = openTerminal } = deps;
  const { slug } = launch;
  let exited = false;
  let killing: Promise<void> | undefined;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    handlers.onExit();
  };
  const report = (err: Error): void => handlers.onError(`tmux: ${err.message}`);
  // tmux missing or the name taken: the pool reports the rejection (spawnFailed). No onExit: there never was a session.
  const started = exec('tmux', tmuxArgs(
    'new-session', '-d', '-s', slug, '-c', launch.repo, '-x', SESSION_COLS, '-y', SESSION_ROWS, workerCommand(launch),
  ), { env: workerEnv(process.env, launch.workerId, launch.port) }).then(() => undefined, (err: Error) => {
    throw new Error(`tmux: ${err.message}`);
  });
  // One kill per handle (a Stop racing the card's kill would fail on the gone session and put a false error in the bar). It resolves
  // once kill-session returned: tmux only answers after the session is destroyed, so a new-session of the same name may follow.
  // kill-session SIGHUPs the shell and the curl trailer never runs: the handle reports the exit itself, after the kill.
  const kill = (): Promise<void> => {
    killing ??= started.catch(() => undefined)
      .then(() => exec('tmux', tmuxArgs('kill-session', '-t', slug)))
      .then(() => undefined, report)
      .then(exitOnce);
    return killing;
  };
  return { started, kill, focus: () => started.then(() => open(attachArgv(slug))) };
}
```

- [ ] **Step 11: Edit `src/spawn-iterm.ts`**

Replace the imports and constants at the top:

```ts
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isStrayAlive, killStray } from './spawn.js';
import type { Exec, WorkerHandle, WorkerHandlers, WorkerLaunch } from './types.js';

const execFileAsync: Exec = promisify(execFile);
const ITERM_APP_ID = 'com.googlecode.iterm2';
const KILL_POLL_MS = 200;
const KILL_TIMEOUT_MS = 10_000;
const KILL_POLLS = KILL_TIMEOUT_MS / KILL_POLL_MS;

export interface ItermDeps {
  exec: Exec;
  sleep(ms: number): Promise<void>;
}
```

Replace `spawnItermWorker` (and add `waitGone` before it):

```ts
// pgrep by slug every 200 ms until nothing matches: the tab's shell only reaches its curl trailer once claude is gone, and a
// respawn of the same slug must not race the old process. False past the cap.
async function waitGone(slug: string, exec: Exec, wait: ItermDeps['sleep']): Promise<boolean> {
  for (let i = 0; i < KILL_POLLS; i += 1) {
    if (!(await isStrayAlive(slug, exec))) return true;
    await wait(KILL_POLL_MS);
  }
  return false;
}

/**
 * A worker in an iTerm2 tab. The exit comes from the `; curl /hooks/exit` at the end of the command, which the server
 * forwards to the pool; a kill goes through pkill by slug and resolves once pgrep no longer finds the process.
 */
export function spawnItermWorker(launch: WorkerLaunch, handlers: WorkerHandlers, deps: Partial<ItermDeps> = {}): WorkerHandle {
  const { exec = execFileAsync, sleep: wait = sleep } = deps;
  const report = (err: Error): void => handlers.onError(`iTerm: ${err.message}`);
  // iTerm missing or refused: the pool reports the rejection (spawnFailed). No onExit: the tab never existed.
  const session = openItermTab(workerCommand(launch), exec).then((id) => id, (err: Error) => {
    throw new Error(`iTerm: ${err.message}`);
  });
  let killing: Promise<void> | undefined;
  const kill = (): Promise<void> => {
    killing ??= killStray(launch.slug, exec)
      .then(() => waitGone(launch.slug, exec, wait))
      .then((gone) => {
        if (!gone) handlers.onError('kill: worker still alive after 10s');
      }, report);
    return killing;
  };
  return { started: session.then(() => undefined), kill, focus: () => session.then((id) => inTab(id, FOCUS_SCRIPT)) };
}
```

- [ ] **Step 12: Rewrite `src/workers.ts`**

```ts
import type { SpawnWorker, WorkerHandle, WorkerLaunch } from './types.js';

export interface StartWorker {
  workerId: string;
  launch: WorkerLaunch;
  onExit(): void;
  onError(message: string): void; // a kill / focus failure: the server puts it in the error bar
  onSpawnFailed(message: string): void; // `started` rejected: the entry is gone; the server frees the slot and marks the card
}

export interface WorkerPool {
  start(o: StartWorker): void;
  kill(workerId: string): Promise<boolean>; // false when the worker is unknown; otherwise resolves with the handle's kill
  exit(workerId: string): boolean; // an exit reported from outside (the curl trailer): same as the handle exiting
  focus(workerId: string): Promise<boolean>; // false when unknown; rejects when the terminal cannot open
  killAll(): Promise<void>;
  has(workerId: string): boolean;
}

interface Entry {
  handle: WorkerHandle;
  exit(): void;
}

/** In-memory registry of live workers keyed by workerId. Process state, not domain state: it is never persisted. */
export function createWorkerPool(spawn: SpawnWorker): WorkerPool {
  const entries = new Map<string, Entry>();

  function start(o: StartWorker): void {
    const { workerId } = o;
    let exited = false;
    const onExit = (): void => {
      if (exited) return; // once: the handle and the external signal can both report it
      exited = true;
      entries.delete(workerId);
      o.onExit();
    };
    const handle = spawn(o.launch, { onExit, onError: o.onError });
    if (!exited) entries.set(workerId, { handle, exit: onExit }); // a spawner may fail before returning
    handle.started.catch((err: Error) => { // the session never existed: no exit will ever come for it
      entries.delete(workerId);
      o.onSpawnFailed(err.message);
    });
  }

  return {
    start,
    kill: async (workerId) => {
      const entry = entries.get(workerId);
      if (!entry) return false;
      await entry.handle.kill(); // the entry itself only leaves on the exit
      return true;
    },
    exit: (workerId) => {
      const entry = entries.get(workerId);
      if (!entry) return false;
      entry.exit();
      return true;
    },
    focus: async (workerId) => {
      const entry = entries.get(workerId);
      if (!entry) return false;
      await entry.handle.focus();
      return true;
    },
    killAll: async () => {
      await Promise.all([...entries.values()].map(({ handle }) => handle.kill()));
    },
    has: (workerId) => entries.has(workerId),
  };
}
```

- [ ] **Step 13: Edit `src/server.ts`**

In `runEffect`, the `kill` case:

```ts
      case 'kill':
        log.info(describeEffect(effect));
        // Awaited: a spawn of the same slug later in this batch only starts once the session is gone (no `duplicate session`).
        // Unknown to the pool (started by a previous Hive): nothing to signal, free the slot ourselves.
        if (!(await pool.kill(effect.workerId))) await dispatch({ type: 'exit', workerId: effect.workerId });
        return;
```

In `spawn`, the `pool.start` handlers:

```ts
      onExit: () => void dispatch({ type: 'exit', workerId }),
      onError: (message) => void fail(`worker ${card.slug}`, new Error(message)), // a kill / focus failure: the error bar
      onSpawnFailed: (message) => void dispatch({ type: 'spawnFailed', workerId, message }), // the slot frees, the card keeps the message
```

In `close`, replace `pool.killAll(); // children of the Hive: none should outlive it` with `await pool.killAll(); // children of the Hive: none should outlive it; awaited so the sessions are gone before the process is`.

- [ ] **Step 14: Run tests to verify they pass**

Run: `pnpm lint && NODE_PATH= pnpm test`
Expected: 295 `node:test` tests PASS (`workers` 10, `spawn-tmux` 5, `spawn-iterm` 3, `spawn` 10, `server` 26); Vitest 11 PASS.

- [ ] **Step 15: Commit**

```bash
git add src/types.ts src/spawn.ts src/spawn-tmux.ts src/spawn-iterm.ts src/workers.ts src/server.ts test/fakes.ts test/workers.test.ts test/spawn-tmux.test.ts test/spawn-iterm.test.ts test/spawn.test.ts test/server.test.ts
git commit -m "feat(workers): started promise, awaited kill on tmux and iTerm, onSpawnFailed; the kill effect awaits the pool (#83)"
```

---

### Task 3: Server protocol — trailer, `dispatch` returns effects, `continue` reply, `204` / `200` hooks, `hookCommand` (TDD)

**Files:**
- Modify: `src/spawn.ts`, `src/server.ts`, `src/server-cards.ts`, `src/hooks-settings.ts`
- Test: `test/spawn.test.ts`, `test/hooks-settings.test.ts`, `test/server.test.ts`

**Interfaces:**
- Produces (in `src/spawn.ts`): `doneTrailer(port: number, workerId: string): string` — starts with `\n---\n`, carries the literal curl, ends with `\n`; `renderPrompt` stays pure, the server concatenates.
- Produces (in `src/server.ts`): `HiveServer.dispatch(event): Promise<Effect[]>`; `interface HookReply { decision: 'block'; reason: string }`; `stagePrompt(runtime, column, card, workerId)` = `renderPrompt(column.prompt ?? '', card.task) + doneTrailer(port, workerId)`, written to `prompts/<slug>.md` on spawn and on continuation; `continue` effect stores the pending reply; `POST /hooks/event` → `204` empty, or `200` JSON when its own dispatch produced a `continue` for the same worker.
- Produces (in `src/server-cards.ts`): `CardRouteDeps.dispatch(event): Promise<Effect[]>`.
- Produces (in `src/hooks-settings.ts`): `hookCommand(port)` = `curl -s -m 30 -X POST http://127.0.0.1:<port>/hooks/event -H "x-hive-worker: $HIVE_WORKER_ID" -H 'content-type: application/json' -d @-; exit 0`; `statusCommand` unchanged (`-m 2`).
- Consumed by: the workers (Claude Code reads the JSON stdout of the Stop hook), Task 4 (nothing new), Task 5 (acceptance).

- [ ] **Step 1: Update `test/spawn.test.ts`**

Add `doneTrailer` to the `../src/spawn.js` import and append:

```ts
test('doneTrailer separates from the prompt, carries the literal port and worker id in the curl and ends with a newline', () => {
  const trailer = doneTrailer(4242, 'W1');
  assert.ok(trailer.startsWith('\n---\nHive: when this command is completely finished'), trailer);
  assert.ok(trailer.includes("`curl -s -X POST http://127.0.0.1:4242/hooks/done -H 'x-hive-worker: W1'`"), trailer);
  assert.match(trailer, /Never run it earlier\. If you need something from the user, ask and end your turn without it\.\n$/);
  assert.equal(`${renderPrompt('/hive-build {url}', task)}${trailer}`.split('\n---\n')[0], '/hive-build https://github.com/a/b/issues/7');
});
```

- [ ] **Step 2: Update `test/hooks-settings.test.ts`**

In `hookCommand posts stdin …`, change the first `assert.match` to `/curl -s -m 30 -X POST http:\/\/127\.0\.0\.1:4242\/hooks\/event/` and replace `assert.match(cmd, /; exit 0$/);` with:

```ts
  assert.match(cmd, /-d @-; exit 0$/);
  assert.doesNotMatch(cmd, />\/dev\/null/, 'the reply is how a Stop continues in place: empty = no decision');
```

In `statusCommand posts …`, replace the last line (`assert.equal(hookCommand(4242).endsWith('>/dev/null; exit 0'), true, …)`) with:

```ts
  assert.match(cmd, /-m 2 /, 'the status line stays snappy; the hook waits for the board writes (-m 30)');
```

- [ ] **Step 3: Update `test/server.test.ts`**

Add `doneTrailer` to the `../src/spawn.js` import (new line: `import { doneTrailer } from '../src/spawn.js';`) and change `openPr`'s return type to `Promise<Effect[]>`. Every `hookEvent(...)).status, 200)` assertion becomes `204` — in the output test (`sessionStart(forged)`, `sessionStart(own)`), in `a Stop before /hooks/done …` (both `Stop`s), in the child-session test (all three), in `the log tells the story …` (`SessionStart`), and in `the kill effect waits …` (`(await stop).status`).

In `saving the setup starts one worker …`, replace the last line with:

```ts
  const prompt = await readFile(promptPath, 'utf8');
  assert.match(prompt, /^Task #1: from Ready/, 'the command line reads the prompt from this file');
  assert.ok(prompt.endsWith(doneTrailer(port, slot.workerId!)), 'the trailer tells the worker how to end the stage');
  assert.ok(prompt.includes(`curl -s -X POST http://127.0.0.1:${port}/hooks/done -H 'x-hive-worker: ${slot.workerId}'`), prompt);
```

Append:

```ts
const CONTINUE_COLUMNS: Column[] = [
  { name: 'plan', weight: 2, from: ['Ready'], onFinish: 'In progress', prompt: '/hive-plan {url}' },
  { name: 'dev', weight: 1, from: ['In progress'], onStart: 'In progress', onFinish: 'In review', prompt: '/hive-build {url}', session: 'continue' },
];

test('POST /hooks/done marks the slot, is idempotent and ignores an unknown worker; a Stop without done answers an empty 204 and leaves the slot waitingwith the session alive', async (t) => {
  const { base, server, workers } = await start(t, { ...BODY, columns: CONTINUE_COLUMNS });
  const workerId = slot0(server).workerId!;
  const idle = await hookEvent(base, workerId, { hook_event_name: 'Stop' });
  assert.equal(idle.status, 204);
  assert.equal(await idle.text(), '', 'no decision: Claude Code sees an empty stdout');
  assert.equal(slot0(server).status, 'waiting');
  assert.deepEqual(slot0(server).lastEvent, { kind: 'turn' });
  assert.equal(card0(server).column, 'plan');
  assert.equal(workers[0].killed, 0);
  assert.equal((await hookDone(base, 'ghost')).status, 204);
  assert.equal(slot0(server).done, undefined, 'unknown worker: ignored');
  assert.equal((await hookDone(base, workerId)).status, 204);
  assert.equal((await hookDone(base, workerId)).status, 204);
  assert.equal(slot0(server).done, true);
  assert.equal(slot0(server).status, 'waiting', 'done alone changes nothing else');
});

test('a Stop with done and a next continue column answers 200 { decision: block, reason } with the next prompt and the trailer: same worker, no kill, no spawn, the card moves', async (t) => {
  const { log, lines } = fakeLog();
  const { base, port, repo, server, workers } = await start(t, { ...BODY, columns: CONTINUE_COLUMNS }, log);
  const { id, workerId } = slot0(server);
  await hookDone(base, workerId!);
  const stop = await hookEvent(base, workerId!, { hook_event_name: 'Stop' });
  assert.equal(stop.status, 200);
  const reason = `/hive-build https://github.com/acme/r/issues/1${doneTrailer(port, workerId!)}`;
  assert.deepEqual(await json(stop), { decision: 'block', reason });
  assert.equal(workers.length, 1, 'no spawn');
  assert.equal(workers[0].killed, 0, 'no kill');
  const slot = slot0(server);
  assert.deepEqual([slot.id, slot.workerId, slot.status, slot.done, slot.lastEvent], [id, workerId, 'working', undefined, { kind: 'continuing' }]);
  assert.deepEqual([card0(server).column, card0(server).slotId], ['dev', id]);
  assert.equal(await readFile(join(repo, '.hive', 'prompts', 'hive-1-from-ready.md'), 'utf8'), reason, 'the run prompt file follows the stage');
  assert.ok(lines.includes('INFO setColumn #I1 → In progress ok'), lines.join('\n'));
  assert.ok(lines.includes(`INFO continue column=dev worker=${workerId!.slice(0, 8)}`), lines.join('\n'));
  const next = await hookEvent(base, workerId!, { hook_event_name: 'Stop' });
  assert.equal(next.status, 204, 'the reply was taken once; the next Stop needs a new done');
  assert.equal(slot0(server).status, 'waiting');
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build error `Module '"../src/spawn.js"' has no exported member 'doneTrailer'`.

- [ ] **Step 5: Edit `src/spawn.ts`** — add after `renderPrompt`:

```ts
/** Appended to every rendered prompt (spawn and continuation): how the worker tells the Hive the command is finished. */
export function doneTrailer(port: number, workerId: string): string {
  return [
    '', '---',
    'Hive: when this command is completely finished — nothing left to do, no agent or background task still',
    'running, no answer pending from the user — run',
    `\`curl -s -X POST http://127.0.0.1:${port}/hooks/done -H 'x-hive-worker: ${workerId}'\``,
    'and end your turn. Never run it earlier. If you need something from the user, ask and end your turn without it.',
    '',
  ].join('\n');
}
```

- [ ] **Step 6: Edit `src/hooks-settings.ts`**

```ts
const HOOK_TIMEOUT_S = 30; // a Stop is answered after the board writes of its dispatch (gh takes seconds); the reply is the continuation
const STATUS_TIMEOUT_S = 2;

function postStdin(port: number, path: string, timeout: number): string {
  return [
    `curl -s -m ${timeout} -X POST http://127.0.0.1:${port}${path}`,
    `-H "x-hive-worker: $HIVE_WORKER_ID"`,
    `-H 'content-type: application/json'`,
    `-d @-`,
  ].join(' ');
}

/** The hook command: stdout is what Claude Code reads. Empty (204) means no decision; the JSON of a continuing Stop is the decision. */
export function hookCommand(port: number): string {
  return `${postStdin(port, '/hooks/event', HOOK_TIMEOUT_S)}; exit 0`;
}

/** The worker's status line: the Hive replies with the plan limits summary, which is what the worker's tab shows. */
export function statusCommand(port: number): string {
  return `${postStdin(port, '/hooks/status', STATUS_TIMEOUT_S)}; exit 0`;
}
```

- [ ] **Step 7: Edit `src/server-cards.ts`**

`import type { Effect, HiveEvent, State } from './types.js';` and `dispatch(event: HiveEvent): Promise<Effect[]>;`.

- [ ] **Step 8: Edit `src/server.ts`**

Import `doneTrailer` from `./spawn.js` (`import { doneTrailer, killStray, renderPrompt, spawnWorker, workerArgs, writePrompt } from './spawn.js';`) and add `Card, Column` to the `./types.js` type import. `HiveServer.dispatch` becomes `dispatch(event: HiveEvent): Promise<Effect[]>;`. After the `Live` interface add:

```ts
/** What a continuing Stop hook is answered with: Claude Code goes on with `reason` as the next prompt. */
interface HookReply {
  decision: 'block';
  reason: string;
}
```

Inside `createServer`, after `setupChain` add:

```ts
  // The answer a Stop hook is waiting for: set by the `continue` effect of its own dispatch, taken once by the /hooks/event that dispatched it.
  const pendingReplies = new Map<string, HookReply>();

  function takeReply(workerId: string): HookReply | undefined {
    const reply = pendingReplies.get(workerId);
    pendingReplies.delete(workerId);
    return reply;
  }

  // The rendered column prompt plus the done trailer: what every run (spawn or continuation) is told.
  const stagePrompt = (runtime: Runtime, column: Column, card: Card, workerId: string): string =>
    renderPrompt(column.prompt ?? '', card.task) + doneTrailer(runtime.config.port, workerId);
```

`dispatch` returns the effects:

```ts
  async function dispatch(event: HiveEvent): Promise<Effect[]> {
    if (!live) return [];
    log.debug(describeEvent(event));
    const prev = live.state;
    const result = reduce(prev, event);
    live = { runtime: live.runtime, state: result.state };
    // Transitions are derived here, not in the reducer: one place covers every rule, current or future, and the reducer stays pure.
    for (const line of describeChanges(prev, result.state)) log.info(line);
    if (result.effects.length > 0) log.debug(`effects: ${result.effects.map(describeEffect).join('; ')}`);
    await persist();
    broadcast();
    for (const effect of result.effects) await runEffect(effect);
    return result.effects;
  }
```

`runEffect` gains the `continue` case after `spawn`:

```ts
      case 'continue': {
        log.info(describeEffect(effect));
        const reason = stagePrompt(runtime, effect.column, effect.card, effect.workerId);
        // the run's prompt file follows the stage, so the file shows what the worker was last told; the reply is what carries it
        await writePrompt(runtime.promptsDir, effect.card.slug, reason).catch((err) => fail(`prompt ${effect.card.slug}`, err));
        pendingReplies.set(effect.workerId, { decision: 'block', reason });
        return;
      }
```

In `spawn`, the prompt line becomes:

```ts
    const promptPath = await writePrompt(promptsDir, card.slug, stagePrompt(runtime, column, card, workerId)); // the command line reads it; the trailer tells the worker how to end the stage
```

`/hooks/event` (whole route):

```ts
  // Answers only after its own dispatch: the worker's hook blocks until curl returns, so a PR seen on PostToolUse is applied before the
  // worker goes on. Empty 204 = no decision; the one exception is a Stop whose dispatch decided to continue in place: 200 with the JSON.
  app.post('/hooks/event', async (req: Request, res: Response) => {
    const workerId = req.header('x-hive-worker');
    const raw = req.body as HookPayload | undefined;
    const payload = workerId && raw?.hook_event_name ? scopeTranscript(workerId, raw) : raw;
    // Computed once against the slot as it stands: a subagent/teammate Stop or SessionEnd must not read the transcript, same as the reducer ignores it (#24)
    const isChild = workerId !== undefined && payload !== undefined && isChildSession(slotOf(workerId), payload);
    let effects: Effect[] = [];
    if (workerId && payload?.hook_event_name) {
      const branch = payload.hook_event_name === 'SessionStart' && payload.cwd ? await resolveBranch(payload.cwd) : undefined;
      const tokens = isChild ? undefined : await turnTokens(workerId, payload);
      effects = await dispatch({ type: 'hook', workerId, payload, branch, tokens });
    } else {
      log.debug(`hook ignored: ${workerId ? 'no event name' : 'no worker id'}`);
    }
    const continues = workerId !== undefined && effects.some((e) => e.type === 'continue' && e.workerId === workerId);
    const reply = continues && workerId !== undefined ? takeReply(workerId) : undefined;
    if (reply) res.json(reply);
    else res.status(HTTP_NO_CONTENT).end();
  });
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm lint && NODE_PATH= pnpm test`
Expected: 298 `node:test` tests PASS (`spawn` 11, `hooks-settings` 5, `server` 28); Vitest 11 PASS.

- [ ] **Step 10: Manual check of the #83 scenario (headless, a configured repo with tmux)**

Config with `plan` (`/hive-plan {url}`, `session: new`) followed by `dev` (`/hive-build {url}`, `session: continue`), one slot, a card in `plan`'s `from`. `pnpm build && node dist/src/run.js /path/to/repo`, signal green. Expected in `hive.log`: the first `Stop` of the plan turn without `done` → `slot 1: working → waiting`, card still in `plan`; after `curl … /hooks/done` and the next `Stop` → `setColumn … ok` lines then `continue column=dev worker=…`, no `kill`, no `spawn`; the same tmux session shows the `/hive-build` prompt as its next turn. `cat .hive/prompts/<slug>.md` ends with the trailer.

- [ ] **Step 11: Commit**

```bash
git add src/spawn.ts src/server.ts src/server-cards.ts src/hooks-settings.ts test/spawn.test.ts test/hooks-settings.test.ts test/server.test.ts
git commit -m "feat(server): done trailer on every prompt, /hooks/event answers 204 or the continuation block, hook stdout kept (#83)"
```

---

### Task 4: UI — error badge on the card (Vitest)

**Files:**
- Modify: `src/ui/components/HiveBoard.tsx`
- Test: `test/ui/HiveBoard.test.tsx`

**Interfaces:**
- `BoardCard` renders `<Badge variant="destructive" title={card.error}>` with the message when `card.error` is set; the `start` button path is the existing one (a stopped card in a column with a prompt). `SlotGrid` already shows `continuing` through `slotEventText` (key from Task 1).

- [ ] **Step 1: Write the failing test** — append to `test/ui/HiveBoard.test.tsx`:

```tsx
test('a card whose spawn failed shows the error (full message as title) and still offers iniciar, which posts start', async () => {
  const user = userEvent.setup();
  render(<HiveBoard state={state([card('1', 'dev', { error: 'tmux: spawn tmux ENOENT' })], [slot('s1')])} />);
  const badge = screen.getByText('tmux: spawn tmux ENOENT').closest('[data-slot="badge"]');
  expect(badge).toHaveAttribute('title', 'tmux: spawn tmux ENOENT');
  expect(badge).toHaveAttribute('data-variant', 'destructive');
  await user.click(screen.getByRole('button', { name: 'iniciar' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/cards/I1/start', expect.objectContaining({ method: 'POST' }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: `node:test` green; Vitest fails — `Unable to find an element with the text: tmux: spawn tmux ENOENT`.

- [ ] **Step 3: Edit `src/ui/components/HiveBoard.tsx`**

Add `import { Badge } from '@/components/ui/badge';` after the `Button` import. After the `{card.prUrl && …}` line add:

```tsx
      {card.error && (
        <Badge variant="destructive" className="max-w-full" title={card.error}>
          <span className="truncate">{card.error}</span>
        </Badge>
      )}
```

- [ ] **Step 4: Run lint, type check and tests**

Run: `pnpm lint && pnpm exec tsc -p src/ui && NODE_PATH= pnpm test`
Expected: 298 `node:test` PASS; Vitest 12 PASS (`HiveBoard` 4).

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/HiveBoard.tsx test/ui/HiveBoard.test.tsx
git commit -m "feat(ui): spawn error badge on the card, start retries it (#83)"
```

---

### Task 5: `hive-flow.md` note and acceptance per the spec's "Done criteria"

**Files:**
- Modify: `.claude/commands/hive-flow.md`

- [ ] **Step 1: Edit `.claude/commands/hive-flow.md`** — after `The flow ends with the PR URL in chat. Do not merge.` add a paragraph:

```
Inside a Hive worker, each stage ends only when the command runs the
`/hooks/done` curl from the trailer the Hive appends to the prompt; a turn
that ends without it leaves the slot yellow (waiting) and the card where it is.
```

- [ ] **Step 2: Criterion 1 — the #83 replay (manual)**

`plan` column with `/hive-plan {url}`, `dev` with `session: continue`, one slot. The `Stop` of the "the planner is running" turn leaves the slot yellow and the card in `plan`; when the command posts `done`, the next `Stop` answers `block` with `dev`'s prompt, the same process goes on and the card moves to `dev` with no `kill` in `hive.log`.

- [ ] **Step 3: Criterion 2 — two consecutive `new` columns (manual)**

`hive.log` shows `kill slug=… worker=…` followed by `slot 1: working → empty`, then `spawn … session=new` of the same slug; the tmux server (`tmux -L hive ls`) never reports `duplicate session`.

- [ ] **Step 4: Criterion 3 — tmux off the PATH (manual)**

`PATH=/usr/bin:/bin node dist/src/run.js /path/to/repo` with `workers: embedded`: the card gets the `tmux: spawn tmux ENOENT` badge in its column, the bar shows it, the next poll spawns nothing, and `iniciar` on the card tries again.

- [ ] **Step 5: Run the full suite and commit**

Run: `pnpm lint && NODE_PATH= pnpm test`
Expected: 298 `node:test` tests PASS across 28 files; Vitest 12 PASS across 5 files.

```bash
git add .claude/commands/hive-flow.md
git commit -m "docs(commands): hive-flow notes the /hooks/done stage end (#83)

Criterion 1 (Stop without done waits; with done the Stop continues in place into dev): <pass/fail>
Criterion 2 (two new columns: kill finished before the spawn, no duplicate session): <pass/fail>
Criterion 3 (tmux missing: error on the card and the bar, no retry, manual start retries): <pass/fail>"
```

---

## Notes

- **Test counts.** 283 → 287 (T1: orchestrator +4) → 295 (T2: workers +2, spawn-tmux +1, spawn-iterm +3 in a new file, server +2) → 298 (T3: spawn +1, server +2) → 298 + Vitest 12 (T4) → same (T5). Count `test(` per file after each task and correct the expected number if a test was merged or split.
- **Why `event.continuing` and `EVENT_KINDS` land in T1.** `EVENT_KEY` in `i18n.ts` is `Record<Exclude<SlotEventKind, 'tool'>, MessageKey>` and `describeEvent` / `reduce` are exhaustive switches: extending the unions without the new cases does not compile, so the types, the reducer, the log and the i18n key are one task. The spec lists the key under UI; only its placement in the plan moves.
- **`stopped` / `counted` helpers post `done` first.** Every existing orchestrator test that ended a run through `Stop` keeps its assertions: the ones under yellow, red, a draining slot, a missing/orphan card or a heavier waiting card still get `kill`; the two under green with `spec → dev` now continue in place, which their assertions (PR travels with the card; session id kept) still hold for.
- **The `continue` reply is guarded by the returned effects.** The map is what the spec asks for; the route only takes a reply when its own dispatch produced a `continue` for that worker, so a hook of another session arriving between the effect and the answer can never take it.
- **Intermediate state between T1 and T3.** With the reducer continuing in place but the server not yet answering the reply (T1–T2), a card in a `continue` column would move with its slot kept and the worker left idle. `test/server.test.ts` only uses `continue` columns from T3 on; the branch merges as a whole.
- **`spawnFailed` is followed by `fill`.** The failed card is out of the candidates, so another card may take the freed slot; with tmux missing every card fails once and then sits with its badge (bounded, not a loop). "No automatic retry" is about the failed card.
- **`fakeSpawn` `holdKills`.** After `releaseKill()` every later `kill()` resolves at once, like a dead session; `close()` awaits `killAll`, so the awaited-kill test releases both workers before returning.
- **`startedAt` is kept on continuation.** The slot is the same run; the elapsed time on the card keeps counting from the first spawn.

## Open questions

1. **Hook curl timeout.** `hookCommand` uses `-m 2` today; a continuing `Stop` is answered only after its `setColumn` board writes (`gh project item-edit`, seconds each), and a timed-out curl would lose the continuation silently. The spec only drops `>/dev/null`. **Default used:** `hookCommand` gets `-m 30`, `statusCommand` keeps `-m 2` (T3). If the cap must stay at 2 s, the reply would have to be sent before the board writes, which reorders the spec's effects.
2. **Error badge text.** The spec says "error badge with the message (title)". **Default used:** the badge shows the spawner's message itself (truncated, full text in `title`), no new i18n key. If a fixed label ("erro" / "error") with the message only in the title is preferred, add `card.error` in both languages in T4.
3. **`state.error` on a spawn failure.** The spec sets the raw `message`; the bar today formats spawner errors as `worker <slug>: <message>`. **Default used:** the spec's literal (the card next to it names the slug).
4. **Spawner error prefix.** `started` rejects with `tmux: …` / `iTerm: …` (what `report` prefixed before), so the card and the bar say where it failed. **Default used:** keep the prefix.
5. **`fill` after `spawnFailed`** (see Notes). **Default used:** `fill`, so other cards keep flowing.
