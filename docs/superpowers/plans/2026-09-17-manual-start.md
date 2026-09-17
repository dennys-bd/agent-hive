# Agent Hive — iniciar uma task da fila à mão, independente do sinal: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every unblocked task in the queue panel gets an `iniciar` button that opens a worker for it right away, whatever the signal (manual or dynamic), the usage-rule cap or the budget. Without a free slot a native `confirm` offers to raise `máx. workers` to `occupied + 1` and start, on a single request. The task leaves the queue exactly as through `fill` (same `Slot`, same `setStatus working` + `spawn` effects), marked `iniciado à mão`; nothing else opens.

**Architecture:** `src/orchestrator.ts` exports `isFree(slot)` (empty and not draining: the criterion `fill` already used) and extracts the placement out of `fill` into a shared `occupy(state, index, task, lastEvent)`; `fill` calls it with `'iniciando'`, the new `start(state, itemId, raiseMax)` with `'iniciado à mão'`. `start` needs only a queued, unblocked task and a free slot; without one and with `raiseMax` it first applies `setMax(state, occupied + 1)`; it never calls `fill`. `HiveEvent` gains `{ type: 'start'; itemId; raiseMax? }`; `describeEvent` gains `start #<itemId> raiseMax=<bool>`, and `describeChanges` reports a slot that appears already occupied (the raiseMax path) as `vazio → trabalhando`. `server.ts` gains `POST /queue/:itemId/start` whose checks live in a pure `startRefusal` helper outside `createServer` (404 not queued, 409 blocked, 409 no free slot without `raiseMax: true`, 409 not configured through `requireLive`). `src/ui/app.ts` renders the button in `renderQueued`, mirrors `isFree`, and a delegated click on `#queue` posts, or confirms then posts `{ raiseMax: true }`.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-17-manual-start-design.md` (extends `docs/superpowers/specs/2026-09-16-signal-design.md` and `docs/superpowers/specs/2026-09-16-usage-rules-design.md`; card: issue #47). Its "Decisões fechadas" table is binding.

## Global Constraints

- All v1, setup, boards, signal, budget, usage-rules, rate-limits and plan-limits constraints hold (immutable reducer, Portuguese UI copy, English code comments and log lines, conventional commits without `Co-Authored-By`, no machine-specific values).
- The reducer stays pure and never throws: every refusal in `start` is `none(state)` (the same object, no effects). The route answers what the reducer would ignore in silence; a race between the check and the dispatch is a no-op in the reducer, never a spawn it should not do.
- The manual start goes through none of `canStart` / `canSchedule` / `limits`, and those do not change. `fill` keeps its behaviour to the letter (same `Slot`, same effect order): every existing test passes unchanged after the refactor.
- Out of scope, per the spec: starting into a specific slot, picking the task from an empty card, undoing the `+1` when the worker exits, starting a blocked task "anyway". `raiseMax` is honoured only when the body carries a literal `true`.
- `itemId` is the key everywhere (event, route, `data-start`); `id` is only what the user reads. It goes escaped into the attribute and through `encodeURIComponent` into the URL.
- The browser mirrors `isFree` as a local constant, like the other mirrored constants in `app.ts` (the orchestrator pulls `node:crypto`). `src/ui/*` is verified by hand (`pnpm start`); reducer, log and route by `node:test`.
- ESM with `.js` import extensions; functions under 50 lines. `server.ts` (577 lines) and `orchestrator.ts` (267) grow by the minimum: the route stays compact, its checks in one helper; no other file crosses 400 lines.
- `pnpm test` must stay green after every task (269 tests today → 276 at the end).

---

## File map

| File | Change |
|---|---|
| `src/orchestrator.ts` | `isFree` exported; private `occupiedCount`; private `occupy` shared by `fill` and the new `start`; `reduce` case `'start'` |
| `src/types.ts` | `HiveEvent` gains `{ type: 'start'; itemId: string; raiseMax?: boolean }` |
| `src/log.ts` | `describeEvent` case `'start'`; `describeChanges` counts a slot that appears already occupied as a transition |
| `src/server.ts` | `HTTP_NOT_CONFIGURED` → `HTTP_CONFLICT`; two messages; pure `startRefusal`; `POST /queue/:itemId/start` |
| `src/ui/app.ts` | `isFree` mirror; `renderQueued` button; `#queue` click listener with the `confirm` |
| `src/ui/index.html` | one CSS rule so the button fits the list |
| `test/orchestrator.test.ts` | `started` helper; `isFree` + `start` (+5); the mutation test gains the event |
| `test/log.test.ts` | two assertions in the existing `describeEvent` test, one in the `describeChanges` test |
| `test/server.test.ts` | the route (+2) |

---

### Task 1: `isFree`, `occupiedCount` and `occupy` shared by `fill` (refactor, existing tests stay green)

**Files:** Modify `src/orchestrator.ts`

**Interfaces:**
- `/** A free slot for the gate and for a manual start: empty and not draining. */ export function isFree(slot: Slot): boolean` — what `canStart` and the `fill` loop tested inline until now.
- `const occupiedCount = (slots: Slot[]): number` — the count `canStart` and `setMax` each computed inline.
- `function occupy(state: State, index: number, task: Task, lastEvent: string): Reduced` — the placement taken out of `fill`: `task` leaves the queue (by reference), `slots[index]` becomes `{ id, workerId: randomUUID(), status: 'trabalhando', task, slug: slugFor(task), startedAt, lastEvent }`, effects `[setStatus working, spawn]` in that order.
- `fill` unchanged in behaviour: same gate, same loop, `'iniciando'`. Consumed by: Task 2 (`start`), Task 3 (`isFree` in the route).

- [ ] **Step 1: Edit `src/orchestrator.ts` — `canStart` (lines 26–30)** → replace with:

```ts
/** A free slot for the gate and for a manual start: empty and not draining. */
export function isFree(slot: Slot): boolean {
  return slot.status === 'vazio' && !slot.draining;
}

const occupiedCount = (slots: Slot[]): number => slots.filter((s) => s.status !== 'vazio').length;

/** The one gate every automatic spawn goes through: green, a free slot that is not draining, and room under the cap when there is one. */
export function canStart(signal: Signal, slots: Slot[], limit?: number): boolean {
  if (signal !== 'green' || !slots.some(isFree)) return false;
  return limit === undefined || occupiedCount(slots) < limit;
}
```

- [ ] **Step 2: Edit `src/orchestrator.ts` — `fill` (lines 114–138)** → replace with:

```ts
// Takes `task` out of the queue into `slots[index]` and emits the board move plus the spawn; fill and start share it.
function occupy(state: State, index: number, task: Task, lastEvent: string): Reduced {
  const next: Slot = {
    id: state.slots[index].id, workerId: randomUUID(), status: 'trabalhando', task, slug: slugFor(task),
    startedAt: new Date().toISOString(), lastEvent,
  };
  return {
    state: { ...state, slots: state.slots.map((s, i) => (i === index ? next : s)), queue: state.queue.filter((t) => t !== task) },
    effects: [{ type: 'setStatus', itemId: task.itemId, key: 'working' }, { type: 'spawn', slot: next }],
  };
}

function fill(reduced: Reduced): Reduced {
  const now = Date.now();
  if (!canSchedule(reduced.state, now)) return reduced; // nothing could start: whatever happened stands
  const { signal, maxWorkers } = limits(reduced.state, now);
  let { state } = reduced;
  const spawned: Effect[] = [];
  // The gate is re-checked before every spawn against the slots as they stand, so the cap counts what was just opened.
  for (let i = 0; i < state.slots.length && canStart(signal, state.slots, maxWorkers); i += 1) {
    if (!isFree(state.slots[i])) continue;
    const task = state.queue.find((t) => !isBlocked(t)); // first free task in board order; blocked ones keep their place
    if (!task) break;
    const next = occupy(state, i, task, 'iniciando');
    state = next.state;
    spawned.push(...next.effects);
  }
  return { state, effects: [...reduced.effects, ...spawned] };
}
```

- [ ] **Step 3: Edit `src/orchestrator.ts` — `setMax` (lines 149–150)** → the local count uses the helper (the local is renamed so it does not shadow it):

```ts
  const occupied = occupiedCount(state.slots);
  const room = Math.max(0, max - occupied);
```

- [ ] **Step 4: Run tests** — `pnpm test`. Expected: 269 tests PASS, `orchestrator` 61 unchanged (`poll fills slots in board order…`, `exit without PR…`, `fill skips a blocked task…` prove the same slots and the same effect order). `pnpm lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts
git commit -m "refactor(orchestrator): isFree, occupiedCount and occupy shared by fill ahead of the manual start"
```

---

### Task 2: `start` event — type, reducer and log (TDD)

`describeEvent` is an exhaustive `switch` returning `string`: adding the event to `HiveEvent` without its `case` breaks the build, so the log change ships in this task with the reducer.

**Files:** Modify `src/types.ts`, `src/orchestrator.ts`, `src/log.ts`; Test `test/orchestrator.test.ts`, `test/log.test.ts`

**Interfaces:**
- `HiveEvent`: `{ type: 'start'; itemId: string; raiseMax?: boolean }`.
- `reduce`: `case 'start': return start(state, event.itemId, event.raiseMax === true);` — no `fill` afterwards.
- `function start(state: State, itemId: string, raiseMax: boolean): Reduced` — task not in the queue or `isBlocked` → `none(state)`; no `isFree` slot and no `raiseMax` → `none(state)`; no free slot with `raiseMax` → `setMax(state, occupiedCount + 1).state` first (this clears every `draining` and adds exactly one empty slot); then `occupy(base, firstFreeIndex, task, 'iniciado à mão')`. A free slot ignores `raiseMax`. Never throws.
- `describeEvent`: `start #<itemId> raiseMax=<true|false>`.
- `describeChanges`: a slot absent from `prev` counts as empty before, so a slot that appears occupied (start with raiseMax) yields `slot N: vazio → trabalhando #id worker=…`; an added empty slot (setMax) still yields nothing.

- [ ] **Step 1: Write the failing tests**

In `test/orchestrator.test.ts`: add `isFree` to the import on line 3; after `const polled = …` (line 30) add:

```ts
const started = (state: State, itemId: string, raiseMax?: boolean) => reduce(state, { type: 'start', itemId, raiseMax });
```

At the end of `reducer never mutates its input` (after line 80) add:

```ts
  const full = filled(1, 2).state; // no free slot: start with raiseMax goes through setMax and occupy
  const fullSnapshot = JSON.stringify(full);
  reduce(full, { type: 'start', itemId: 'item2', raiseMax: true });
  assert.equal(JSON.stringify(full), fullSnapshot);
```

Append:

```ts
test('isFree is true only for an empty slot that is not draining', () => {
  assert.equal(isFree({ id: 'x', status: 'vazio' }), true);
  assert.equal(isFree({ id: 'x', status: 'vazio', draining: true }), false);
  assert.equal(isFree(filled(1, 1).state.slots[0]), false, 'occupied');
});

test('start under yellow or red opens the task in the first free slot exactly like fill, marked "iniciado à mão", and leaves the rest queued', () => {
  const yellow = polled(signaled(initialState(2), 'yellow').state, 3).state; // 2 free slots, 3 queued, nothing spawned
  const { state, effects } = started(yellow, 'item2');
  assert.equal(state.signal, 'yellow', 'the signal is untouched');
  assert.equal(state.slots[0].task?.id, '2');
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(state.slots[0].slug, 'hive-2-task-2');
  assert.equal(state.slots[0].lastEvent, 'iniciado à mão');
  assert.ok(state.slots[0].workerId && state.slots[0].startedAt);
  assert.equal(state.slots[1].status, 'vazio', 'only the task asked for opens');
  assert.deepEqual(state.queue.map((t) => t.id), ['1', '3']);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item2', key: 'working' }, { type: 'spawn', slot: state.slots[0] }]);
  const red = started(signaled(yellow, 'red').state, 'item3');
  assert.equal(red.state.slots[0].task?.id, '3');
  assert.deepEqual(red.effects.map((e) => e.type), ['setStatus', 'spawn']);
});

test('start ignores the dynamic cap and the budget, and never calls fill: only the task asked for opens', () => {
  const capped = polled(ruled(initialState(3), 550), 3).state; // 55%: cap 1 → one working, two queued, two free slots
  assert.equal(occupied(capped).length, 1);
  const { state, effects } = started(capped, 'item3');
  assert.deepEqual(occupied(state).map((s) => s.task?.id), ['1', '3']);
  assert.deepEqual(state.queue.map((t) => t.id), ['2'], 'task 2 stays queued: no fill after a manual start');
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'spawn']);
  const broke = polled(spent(1000, 0, { maxTokensPerHour: 1000 }), 1).state; // budget exhausted: the free slot stayed empty
  assert.equal(broke.slots[0].status, 'vazio');
  assert.equal(started(broke, 'item1').state.slots[0].task?.id, '1');
});

test('start leaves the state as is, with no effects, for an unknown or blocked task and for no free slot without raiseMax', () => {
  const blocked = { ...task(1), blockedBy: ['3'] };
  const queued = reduce(signaled(initialState(1), 'yellow').state, { type: 'poll', tasks: [blocked, task(2)] }).state;
  for (const [itemId, why] of [['nope', 'unknown'], ['item1', 'blocked']] as const) {
    const { state, effects } = started(queued, itemId, true);
    assert.equal(state, queued, `${why}: same object, even with raiseMax`);
    assert.equal(effects.length, 0, why);
  }
  const full = filled(1, 2).state; // one working, task 2 queued, no free slot
  const { state, effects } = started(full, 'item2');
  assert.equal(state, full, 'no free slot and no raiseMax: same object');
  assert.equal(effects.length, 0);
  assert.equal(state.maxConcurrent, 1);
});

test('start with raiseMax and no free slot sets maxConcurrent to occupied + 1 and opens the task in the new slot; a free slot ignores raiseMax', () => {
  const full = filled(2, 3).state; // 2 working, task 3 queued
  const { state, effects } = started(full, 'item3', true);
  assert.equal(state.maxConcurrent, 3);
  assert.equal(state.slots.length, 3);
  assert.deepEqual(state.slots.map((s) => s.task?.id), ['1', '2', '3']);
  assert.equal(state.slots[2].lastEvent, 'iniciado à mão');
  assert.deepEqual(state.queue, []);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item3', key: 'working' }, { type: 'spawn', slot: state.slots[2] }]);
  // 3 working under a max of 1: two draining, the cap below the occupied count. +1 on the max would open nothing; occupied + 1 opens one.
  const draining = reduce(filled(3, 4).state, { type: 'setMax', max: 1 }).state;
  assert.deepEqual(draining.slots.map((s) => s.draining), [undefined, true, true]);
  const raised = started(draining, 'item4', true).state;
  assert.equal(raised.maxConcurrent, 4);
  assert.ok(raised.slots.every((s) => !s.draining), 'nothing drains any more');
  assert.deepEqual(raised.slots.map((s) => s.task?.id), ['1', '2', '3', '4']);
  const roomy = polled(signaled(initialState(2), 'yellow').state, 1).state; // a free slot: the slot appeared between the render and the click
  const kept = started(roomy, 'item1', true).state;
  assert.equal(kept.maxConcurrent, 2);
  assert.equal(kept.slots.length, 2);
  assert.equal(kept.slots[0].task?.id, '1');
});
```

In `test/log.test.ts`, in `describeEvent summarises every other event…` after the `describeEvent({ type: 'error' })` line (line 132) add:

```ts
  assert.equal(describeEvent({ type: 'start', itemId: 'PVTI_1' }), 'start #PVTI_1 raiseMax=false');
  assert.equal(describeEvent({ type: 'start', itemId: 'PVTI_1', raiseMax: true }), 'start #PVTI_1 raiseMax=true');
```

In `describeChanges lists each slot whose status changed…` after its last assertion (line 154) add:

```ts
  const added: Slot = { ...working, id: 'c0c0c0c0-4444-4444-8444-444444444444' };
  assert.deepEqual(describeChanges(next, { ...next, slots: [working, other, added] }), ['slot 3: vazio → trabalhando #30 worker=1a2b3c4d'], 'a slot that appears already occupied (start with raiseMax) is a transition');
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`. Expected: build errors — `Type '"start"' is not assignable to type '"boot" | "poll" | …'` in both test files.

- [ ] **Step 3: Edit `src/types.ts`** — line 141 `  | { type: 'error'; message?: string };` →

```ts
  | { type: 'error'; message?: string }
  | { type: 'start'; itemId: string; raiseMax?: boolean }; // the human override from the queue panel: past the signal, the cap and the budget
```

- [ ] **Step 4: Edit `src/orchestrator.ts`**

In `reduce`, after the `case 'boardQuota'` line add:

```ts
    case 'start': return start(state, event.itemId, event.raiseMax === true); // no fill: nothing loosened, so nothing else could open
```

After `fill` add:

```ts
// The human override: no signal, cap or budget check. Unknown or blocked task, or no free slot without raiseMax: unchanged.
// With raiseMax the new max is occupied + 1, not maxConcurrent + 1: with slots draining the cap sits below the occupied count
// and +1 on it would open nothing. A free slot ignores raiseMax: the slot appeared between the render and the click.
function start(state: State, itemId: string, raiseMax: boolean): Reduced {
  const task = state.queue.find((t) => t.itemId === itemId);
  if (!task || isBlocked(task)) return none(state);
  const hasFree = state.slots.some(isFree);
  if (!hasFree && !raiseMax) return none(state);
  const base = hasFree ? state : setMax(state, occupiedCount(state.slots) + 1).state;
  const index = base.slots.findIndex(isFree);
  return index < 0 ? none(state) : occupy(base, index, task, 'iniciado à mão'); // never throws: a reducer that throws takes the route with it
}
```

- [ ] **Step 5: Edit `src/log.ts`**

In `describeEvent`, after the `case 'error'` line (111) add:

```ts
    case 'start': return `start #${event.itemId} raiseMax=${event.raiseMax === true}`;
```

In `describeChanges`, line 131 →

```ts
  // A slot missing from prev appeared in this reduce: empty (setMax: no line) or already occupied (start with raiseMax: one line).
  const before = (slot: Slot): Slot => prev.slots.find((s) => s.id === slot.id) ?? { id: slot.id, status: 'vazio' };
```

lines 133–134 → `    const old = before(slot);` / `    if (old.status === slot.status) return [];` and line 140 → `    slot.sessionId && !before(slot).sessionId ? […] : []);` (the `?.` goes).

- [ ] **Step 6: Run tests to verify they pass** — `pnpm test`. Expected: 274 tests PASS (`orchestrator` 66, `log` 12). `pnpm lint` clean.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/orchestrator.ts src/log.ts test/orchestrator.test.ts test/log.test.ts
git commit -m "feat(orchestrator): start event opens a queued task by hand past the signal, cap and budget"
```

---

### Task 3: `POST /queue/:itemId/start` (TDD)

**Files:** Modify `src/server.ts`; Test `test/server.test.ts`

**Interfaces:**
- `POST /queue/:itemId/start`, body `{ raiseMax?: true }` → `{ ok: true }` after `dispatch({ type: 'start', itemId, raiseMax })`. `409 Hive não configurado…` through `requireLive`; `404 task não está na fila`; `409 task bloqueada por <ids>`; `409 nenhum slot livre` when no `isFree` slot and `body.raiseMax !== true`.
- `function startRefusal(state: State, itemId: string, raiseMax: boolean): { status: number; message: string } | undefined` — pure, outside `createServer`, the three checks above in that order.
- `HTTP_NOT_CONFIGURED` renamed `HTTP_CONFLICT` (same 409, now also "the state refuses what was asked").

- [ ] **Step 1: Write the failing tests — append to `test/server.test.ts`**

```ts
test('POST /queue/:itemId/start under yellow opens the task in the pool with its slug, marked "iniciado à mão"; 404 for a task not in the queue, 409 before the setup', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ repo, boardFactory: fakeBoardFactory().factory, spawnWorker: spawn });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/queue/I1/start`)).status, 409, 'not configured');
  assert.equal((await postJson(`${base}/setup`, { ...BODY, maxConcurrent: 2 })).status, 200); // boot opens under yellow: I1 queued, nothing spawned
  assert.equal(server.getState()?.signal, 'yellow');
  assert.deepEqual(server.getState()?.queue.map((task) => task.id), ['1']);
  assert.equal(workers.length, 0);
  const missing = await postJson(`${base}/queue/nope/start`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'task não está na fila' });
  assert.deepEqual(await json(postJson(`${base}/queue/I1/start`)), { ok: true });
  const slot = slot0(server);
  assert.equal(slot.status, 'trabalhando');
  assert.equal(slot.lastEvent, 'iniciado à mão');
  assert.equal(workers.length, 1, 'the spawn ran before the answer');
  assert.equal(workers[0].launch.slug, 'hive-1-from-ready');
  assert.equal(workers[0].launch.workerId, slot.workerId);
  assert.deepEqual(server.getState()?.queue, []);
  assert.equal(server.getState()?.signal, 'yellow', 'the signal is untouched');
  assert.equal(server.getState()?.maxConcurrent, 2, 'a free slot: nothing to raise');
});

test('POST /queue/:itemId/start is 409 for a blocked task and, without a free slot, unless raiseMax is true: then the max rises, persists and the worker opens', async (t) => {
  const { log, lines } = fakeLog();
  const { base, repo, server, workers } = await start(t, BODY, log); // 1 slot, I1 working
  const blocked = { itemId: 'I2', id: '2', title: 'blocked', body: '', url: 'https://github.com/acme/r/issues/2', blockedBy: ['1'] };
  const free = { itemId: 'I3', id: '3', title: 'free', body: '', url: 'https://github.com/acme/r/issues/3' };
  await server.dispatch({ type: 'poll', tasks: [blocked, free] }); // I1 stays in its slot; no free slot, so nothing spawns
  assert.deepEqual(server.getState()?.queue.map((task) => task.id), ['2', '3']);
  const refused = await postJson(`${base}/queue/I2/start`, { raiseMax: true });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'task bloqueada por 1' });
  const noSlot = await postJson(`${base}/queue/I3/start`);
  assert.equal(noSlot.status, 409);
  assert.deepEqual(await noSlot.json(), { error: 'nenhum slot livre' });
  assert.equal((await postJson(`${base}/queue/I3/start`, { raiseMax: 'yes' })).status, 409, 'only a literal true raises the max');
  assert.equal(workers.length, 1);
  assert.ok(!lines.some((l) => l.startsWith('DEBUG start')), 'a refusal never reaches the reducer');
  assert.deepEqual(await json(postJson(`${base}/queue/I3/start`, { raiseMax: true })), { ok: true });
  assert.equal(server.getState()?.maxConcurrent, 2);
  assert.equal(server.getState()?.slots.length, 2);
  const opened = server.getState()!.slots[1];
  assert.equal(opened.task?.id, '3');
  assert.equal(opened.lastEvent, 'iniciado à mão');
  assert.equal(workers.length, 2);
  assert.equal(workers[1].launch.slug, 'hive-3-free');
  assert.deepEqual(server.getState()?.queue.map((task) => task.id), ['2']);
  assert.ok(lines.includes('DEBUG start #I3 raiseMax=true'), lines.filter((l) => l.includes('start')).join('\n'));
  assert.ok(lines.includes(`INFO slot 2: vazio → trabalhando #3 worker=${opened.workerId!.slice(0, 8)}`), 'the slot that appeared occupied is a transition');
  const saved = JSON.parse(await readFile(join(repo, '.hive', 'state.json'), 'utf8')) as State;
  assert.equal(saved.maxConcurrent, 2, 'the raised max survives a restart');
  assert.equal(server.getState()?.error, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`. Expected: the build passes; the first new test fails at `not configured` (Express answers 404 for the unknown route, not 409) and the second at the blocked refusal (404 instead of 409).

- [ ] **Step 3: Edit `src/server.ts`**

Line 14 → `import { isBlocked, isFree, reduce, SIGNALS } from './orchestrator.js';`

Line 34 `const HTTP_NOT_CONFIGURED = 409;` → `const HTTP_CONFLICT = 409; // not configured, or the state refuses what was asked`. After `const NO_WORKER_MESSAGE = …` (line 41) add:

```ts
const NOT_QUEUED_MESSAGE = 'task não está na fila';
const NO_FREE_SLOT_MESSAGE = 'nenhum slot livre';
```

After `boardFromQuery` (line 107) add:

```ts
/** Why a manual start would be a no-op in the reducer, as the answer the route gives; undefined when it can go through. */
function startRefusal(state: State, itemId: string, raiseMax: boolean): { status: number; message: string } | undefined {
  const task = state.queue.find((t) => t.itemId === itemId);
  if (!task) return { status: HTTP_NOT_FOUND, message: NOT_QUEUED_MESSAGE };
  if (isBlocked(task)) return { status: HTTP_CONFLICT, message: `task bloqueada por ${(task.blockedBy ?? []).join(', ')}` };
  if (!raiseMax && !state.slots.some(isFree)) return { status: HTTP_CONFLICT, message: NO_FREE_SLOT_MESSAGE };
  return undefined;
}
```

In `requireLive` (line 319) `HTTP_NOT_CONFIGURED` → `HTTP_CONFLICT`.

Before `app.post('/board/refresh', …)` (line 534) add:

```ts
  // The human override from the queue panel. The checks answer what the reducer would ignore in silence, so the UI is never left
  // without an answer; a race between the check and the dispatch is a no-op in the reducer, never a spawn it should not do.
  app.post('/queue/:itemId/start', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const itemId = req.params.itemId as string;
    const raiseMax = (req.body as { raiseMax?: unknown } | undefined)?.raiseMax === true; // only a literal true raises the max
    const refusal = startRefusal(current.state, itemId, raiseMax);
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.message });
      return;
    }
    await dispatch({ type: 'start', itemId, raiseMax });
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`. Expected: 276 tests PASS (`server` 20). `pnpm lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): POST /queue/:itemId/start opens a queued task by hand, raising the max on request"
```

---

### Task 4: UI — `iniciar` button and the confirm (manual check, no node:test)

**Files:** Modify `src/ui/app.ts`, `src/ui/index.html`

**Interfaces:**
- `renderQueued(task)`: unblocked → `<li>#id título <button type="button" data-start="<esc(itemId)>">iniciar</button></li>`; blocked → as today, no button.
- `const isFree = (slot: Slot): boolean` — mirror of the orchestrator's, next to the other mirrored constants.
- Delegated click on `#queue`: `data-start` → the task in `state.queue`; `state.slots.some(isFree)` → `post('/queue/<encodeURIComponent(itemId)>/start')`; otherwise `confirm('Nenhum slot livre. Subir máx. workers de N pra M e iniciar #id?')` with `N = state.maxConcurrent`, `M = occupied + 1` (the number the reducer will set), then `post(…, { raiseMax: true })`. A route error lands in the error bar like every `post`.

- [ ] **Step 1: Edit `src/ui/app.ts`**

After `const QUOTA_RESERVE = 500;` (line 31) add:

```ts
// Mirrors isFree in src/orchestrator.ts, which cannot be imported here (it pulls node:crypto into the browser).
const isFree = (slot: Slot): boolean => slot.status === 'vazio' && !slot.draining;
```

Replace `renderQueued` (lines 182–187):

```ts
// A free task gets the manual-start button; a blocked one shows its blockers instead (the route would refuse it anyway).
function renderQueued(task: Task): string {
  const tail = task.blockedBy?.length
    ? `<span class="meta" style="color:var(--muted)"> · bloqueada por ${esc(task.blockedBy.join(', '))}</span>`
    : ` <button type="button" data-start="${esc(task.itemId)}">iniciar</button>`;
  return `<li>#${esc(task.id)} ${esc(task.title)}${tail}</li>`;
}
```

After the `$('grid').addEventListener('click', …)` block (line 498) add:

```ts
// The human override: the route ignores the signal, the cap and the budget. Without a free slot the confirm offers the number the
// reducer will set (occupied + 1: maxConcurrent + 1 unless slots are draining), on the same request so nothing races the raise.
$('queue').addEventListener('click', (event) => {
  const itemId = (event.target as HTMLElement).dataset.start;
  const task = itemId === undefined ? undefined : state?.queue.find((t) => t.itemId === itemId);
  if (!state || !task) return;
  const path = `/queue/${encodeURIComponent(task.itemId)}/start`;
  if (state.slots.some(isFree)) {
    post(path);
    return;
  }
  const next = state.slots.filter((s) => s.status !== 'vazio').length + 1;
  if (confirm(`Nenhum slot livre. Subir máx. workers de ${state.maxConcurrent} pra ${next} e iniciar #${task.id}?`)) post(path, { raiseMax: true });
});
```

- [ ] **Step 2: Edit `src/ui/index.html`** — after `  li { margin: 4px 0; }` (line 50) add:

```css
  #queue button { padding: 2px 8px; font-size: 12px; margin-left: 6px; }
```

- [ ] **Step 3: Run tests** — `pnpm test`. Expected: 276 tests PASS (the build compiles `src/ui/app.ts`). `pnpm lint` clean.

- [ ] **Step 4: Acceptance per the spec's "Critério de pronto" (manual)**

1. A repo with `máx. workers = 2`, a board with 3 free tasks: `pnpm start <repo>`. The Hive opens under yellow, both slots empty, the 3 tasks in the queue panel each with `iniciar`. Click it on the second: only that task opens (card `iniciado à mão`, terminal spawns), the other two stay queued, the signal stays yellow, the header shows `1/2`.
2. Click `iniciar` on a second task, then on the third with both slots occupied: the browser asks `Nenhum slot livre. Subir máx. workers de 2 pra 3 e iniciar #<n>?`. Cancel: nothing happens, no request. OK: the header shows `3/3`, the worker opens, `hive.log` has `INFO  slot 3: vazio → trabalhando #<n> worker=…` and, at `logLevel: debug`, `DEBUG start #<itemId> raiseMax=true`. Quit and `pnpm start <repo>` again: `máx. workers` still reads 3 (`grep maxConcurrent <repo>/.hive/state.json`).
3. A task with an open blocker (GitHub: blocked by an open issue; markdown: a `blockedBy` cell naming an open id) shows `· bloqueada por …` and no button. `curl -s -X POST -H 'x-hive-ui: 1' localhost:<port>/queue/<itemId>/start` on it answers `409 {"error":"task bloqueada por …"}`; on an id not in the queue, `404`.
4. Under red, a worker started by hand stops at its first `Stop` with `pausado: sinal red`, like any other. Signal buttons, `máx. workers`, `kill`, the token meter and the automatic fill under green behave exactly as before.

- [ ] **Step 5: Commit**

```bash
git add src/ui/app.ts src/ui/index.html
git commit -m "feat(ui): iniciar button on each free queued task, with a confirm to raise the max when no slot is free"
```
