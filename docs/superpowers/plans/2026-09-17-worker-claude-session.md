# Agent Hive — sessão Claude do worker (id e comando de retomada): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every worker runs one Claude Code session and every hook already carries its `session_id`; today the Hive drops it. After this change the reducer keeps the id on the slot from the `SessionStart` hook (`Slot.sessionId`, first one wins, only a value matching `^[A-Za-z0-9_-]{8,64}$`), the detail panel shows `sessão: claude --resume <id>` under `branch`, and `hive.log` gets one `info` line `slot N: session=<id> #<task> worker=<id8>` the moment the id appears, so a PR can be traced back to its session after the slot was freed. Nothing is written to the issue or the PR; the Hive does not resume sessions (that is #26).

**Architecture:** Four source files, about 40 lines. `src/types.ts`: `Slot.sessionId?` and `HookPayload.session_id?`. `src/orchestrator.ts`: `SESSION_ID` regex, `isSessionId` guard, and the `SessionStart` case of `applyHook` adds `sessionId: slot.sessionId ?? (isSessionId(p.session_id) ? p.session_id : undefined)` next to `worktree` / `branch` / `transcriptPath`. `src/log.ts`: `describeChanges(prev, next)` emits a session line for each slot of `next` whose `sessionId` is set while the same slot in `prev` had none, after the status lines and before the signal line. `src/ui/app.ts`: one line in `renderDetail`. `src/server.ts` does not change: the hook route already passes the whole payload to `reduce` and `dispatch` already logs whatever `describeChanges` returns at `info`.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`, Biome lint. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-worker-claude-session-design.md` (extends `docs/superpowers/specs/2026-09-15-agent-hive-design.md` and `2026-09-17-persistent-logs-design.md`). Issue: <https://github.com/dennys-bd/agent-hive/issues/29>. Plan file: `docs/superpowers/plans/2026-09-17-worker-claude-session.md`.

## Global Constraints

- All v1, setup and persistent-logs constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, code comments in English, conventional commits in English without `Co-Authored-By`, no machine-specific values).
- Only `src/types.ts`, `src/orchestrator.ts`, `src/log.ts` and `src/ui/app.ts` change. `src/server.ts`, `src/hive.ts`, `src/usage.ts`, `src/state-store.ts`, `src/ui/index.html`, `README.md` do not change. In particular no refactor of `src/server.ts`.
- Every decision in the spec's "Decisões fechadas" table is closed: the id comes from `SessionStart` only; it lives on the slot; the format check `^[A-Za-z0-9_-]{8,64}$` drops anything else silently (the rest of the hook still applies); first id wins; the panel shows `sessão: claude --resume <id>` in `<code>` under `branch` and the card does not change; the log line is `info`, emitted once when the id goes from absent to present; nothing goes to GitHub; no web link; no resume from the Hive.
- `isSessionId` is a trust-boundary check, not a style choice: any local process can `POST /hooks/event`, and the value reaches `innerHTML` (escaped) and `hive.log`. It follows the `isTranscriptPath` pattern and is never skipped.
- `State`, `HiveEvent`, `Effect`, `Config`, `SetupBody`, `Board` do not change. `Slot` and `HookPayload` each gain one optional field; `state.json` picks up `sessionId` for free (the whole slot is persisted).
- Files < 400 lines, functions < 50 lines (`describeChanges` stays one small function), no new constants beyond `SESSION_ID`.
- Tests: `node:test` + `node:assert/strict` under `test/`, ESM with `.js` import extensions. Run the suite as `NODE_PATH= pnpm test` (an inherited `NODE_PATH` makes `test/hive-cli.test.ts` find the real Electron and hang). `pnpm lint` (Biome) must stay clean; CI runs build, tests and lint on every PR.
- `NODE_PATH= pnpm test` must stay green after every task (252 tests today → 254 at the end: orchestrator +1, log +1; the server check is folded into the existing `the log tells the story…` test in `test/server.test.ts`, which already has `fakeLog`, `has()` and the `id8` helper it needs, so a separate test would only duplicate its setup).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `Slot.sessionId?: string`; `HookPayload.session_id?: string` |
| `src/orchestrator.ts` | `SESSION_ID`, `isSessionId`; `SessionStart` case of `applyHook` sets `sessionId` (first wins) |
| `src/log.ts` | `describeChanges` adds the `slot N: session=<id>…` lines between the status lines and the signal line |
| `src/ui/app.ts` | `renderDetail`: `sessão: <code>claude --resume <id></code>` line after `branch` |
| `test/orchestrator.test.ts` | +1: valid id kept, first wins, malformed / missing ignored without dropping `worktree` (60 tests) |
| `test/log.test.ts` | +1: session line once, after status lines, before the signal (12 tests) |
| `test/server.test.ts` | existing `the log tells the story…` test gains a `SessionStart` over `POST /hooks/event`: slot has `sessionId`, log has the `session=` line (15 tests) |

---

### Task 1: Types + reducer — `Slot.sessionId` from `SessionStart`, validated, first one wins (TDD)

**Files:**
- Modify: `src/types.ts`, `src/orchestrator.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `Slot.sessionId?: string`; `HookPayload.session_id?: string`.
- Produces (in `src/orchestrator.ts`): `export const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/`; `export function isSessionId(value: unknown): value is string`.
- `applyHook`, case `SessionStart`: the patch gains `sessionId: slot.sessionId ?? (isSessionId(p.session_id) ? p.session_id : undefined)`. `slot` is the occupant found at the top of `applyHook` (matched by `workerId`), so a second `SessionStart` for the same worker (a teammate, #24) keeps the first id.
- Consumed by: Task 2 (`describeChanges` reads `slot.sessionId`), Task 3 (server test), Task 4 (panel).

- [ ] **Step 1: Write the failing test**

In `test/orchestrator.test.ts`, append after the `SessionStart records worktree, branch and the transcript path…` test:

```ts
test('SessionStart keeps a well-formed session_id, the first one wins, and a malformed or missing one is dropped without losing the rest of the hook', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].workerId!;
  const start = (state: State, session_id?: string): State => hook(state, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id }).state;
  const uuid = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'; // what Claude Code sends
  const started = start(first, uuid);
  assert.equal(started.slots[0].sessionId, uuid);
  assert.equal(started.slots[0].worktree, '/w');
  assert.equal(start(started, 'another-session-id-0001').slots[0].sessionId, uuid, 'a teammate SessionStart does not replace the main session (#24)');
  for (const bad of ['', 'short', 'has space-in-it', 'x'.repeat(65), '../../etc/passwd', '<b>x</b>abcdef']) {
    assert.equal(start(first, bad).slots[0].sessionId, undefined, JSON.stringify(bad));
  }
  const missing = start(first);
  assert.equal(missing.slots[0].sessionId, undefined);
  assert.equal(missing.slots[0].worktree, '/w', 'the rest of the hook still applies');
  assert.equal(JSON.stringify(first.slots[0].sessionId), undefined, 'the input state is untouched');
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Object literal may only specify known properties, and 'session_id' does not exist in type 'Partial<HookPayload> & { hook_event_name: string; }'`.

- [ ] **Step 3: Edit `src/types.ts`**

In `Slot`, add after `transcriptPath?: string; // …`:

```ts
  sessionId?: string; // Claude Code session id from SessionStart; what `claude --resume` takes. First one wins (#24)
```

In `HookPayload`, add after `transcript_path?: string; // …`:

```ts
  session_id?: string; // Claude Code sends it on every hook; the reducer keeps it from SessionStart
```

- [ ] **Step 4: Edit `src/orchestrator.ts`**

Add after `const PR_URL = …;`:

```ts
export const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/; // Claude Code uses uuids; anything else came from another local process
```

Add after `extractPrUrl`:

```ts
/** Any local process can hit /hooks/event and the id reaches the panel and the log: only a plain id of a sane length is kept. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}
```

Replace the `SessionStart` case in `applyHook`:

```ts
    case 'SessionStart': // the transcript path is kept only when it is what Claude Code sends: an absolute .jsonl; the first session id wins (#24)
      return patch(state, workerId, {
        worktree: p.cwd, branch, transcriptPath: isTranscriptPath(p.transcript_path) ? p.transcript_path : undefined,
        sessionId: slot.sessionId ?? (isSessionId(p.session_id) ? p.session_id : undefined),
      });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 253 tests PASS (`orchestrator` 60). The existing `SessionStart records worktree…` test keeps passing: no `session_id` in its payload → `sessionId: undefined`, same as before.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): keep the worker's Claude session id from SessionStart, first one wins"
```

---

### Task 2: `describeChanges` — one `session=` line when the id appears (TDD)

**Files:**
- Modify: `src/log.ts`
- Test: `test/log.test.ts`

**Interfaces:**
- `describeChanges(prev: State, next: State): string[]` — unchanged signature. New rule: for each slot of `next` (grid order, matched by `id`) whose `sessionId` is set while the slot with the same id in `prev` had none, one line `slot <n>: session=<sessionId>` + `slotDetail(slot)` (` #<taskId> worker=<id8>`). Order: status lines, then session lines, then `signal: …`. The same id in both states, or a slot going back to `vazio` (id dropped), produces no session line.
- Consumed by: `dispatch` in `src/server.ts` (already logs every line at `info`; no change).

- [ ] **Step 1: Write the failing test**

In `test/log.test.ts`, append after the `describeChanges lists each slot whose status changed…` test:

```ts
test('describeChanges emits the session line once, when the id appears, after the status lines and before the signal', () => {
  const session = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const empty: Slot = { id: SLOT, status: 'vazio' };
  const working: Slot = { ...empty, workerId: WORKER, status: 'trabalhando', task: task('29'), slug: 'hive-29-session' };
  const prev: State = { ...initialState(0), signal: 'yellow', slots: [working] };
  const started: State = { ...prev, slots: [{ ...working, sessionId: session, worktree: '/w' }] };
  assert.deepEqual(describeChanges(prev, started), [`slot 1: session=${session} #29 worker=1a2b3c4d`]);
  const later: State = { ...started, slots: [{ ...started.slots[0], lastEvent: 'Bash: pnpm test' }] };
  assert.deepEqual(describeChanges(started, later), [], 'the same id in both states is not a change');
  const both: State = { ...prev, signal: 'green', slots: [{ ...working, status: 'esperando_voce', sessionId: session }] };
  assert.deepEqual(describeChanges(prev, both), [
    'slot 1: trabalhando → esperando_voce #29 worker=1a2b3c4d',
    `slot 1: session=${session} #29 worker=1a2b3c4d`,
    'signal: yellow → green',
  ]);
  assert.deepEqual(describeChanges(started, { ...started, slots: [empty] }), ['slot 1: trabalhando → vazio #29 worker=1a2b3c4d'], 'freeing the slot drops the id silently: its line already left');
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `NODE_PATH= pnpm test`
Expected: the new test fails on the first `deepEqual` — `[]` instead of the session line (types already compile after Task 1).

- [ ] **Step 3: Edit `src/log.ts`**

Replace `describeChanges`:

```ts
/** Slot and signal transitions between two states: one line per slot whose status changed, in grid order, matched by id; then the sessions that appeared; then the signal. */
export function describeChanges(prev: State, next: State): string[] {
  const before = (slot: Slot): Slot | undefined => prev.slots.find((s) => s.id === slot.id);
  const statuses = next.slots.flatMap((slot, i) => {
    const old = before(slot);
    if (!old || old.status === slot.status) return [];
    const detail = slotDetail(slot.status === 'vazio' ? old : slot); // an emptied slot names what it held
    return [`slot ${i + 1}: ${old.status} → ${slot.status}${detail}`];
  });
  // The slot is wiped on exit / boot; this line is what ties a PR (same worker=) back to a `claude --resume` id afterwards
  const sessions = next.slots.flatMap((slot, i) =>
    slot.sessionId && !before(slot)?.sessionId ? [`slot ${i + 1}: session=${slot.sessionId}${slotDetail(slot)}`] : []);
  const lines = [...statuses, ...sessions];
  return prev.signal === next.signal ? lines : [...lines, `signal: ${prev.signal} → ${next.signal}`];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 254 tests PASS (`log` 12). The existing `describeChanges lists each slot…` test is untouched: none of its slots has a `sessionId`.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "feat(log): one session= line per slot when the worker's Claude session id appears"
```

---

### Task 3: Server — end to end: `POST /hooks/event` `SessionStart` → `slot.sessionId` + `session=` log line (test only)

**Files:**
- Test: `test/server.test.ts` (no source change; `src/server.ts` already forwards the whole payload and logs `describeChanges`)

**Interfaces:**
- None produced. Verifies that the hook route, `scopeTranscript` (which spreads the payload and only touches `transcript_path`), `reduce` and `dispatch` chain correctly for `session_id`.

- [ ] **Step 1: Extend the existing test**

In `test/server.test.ts`, inside `the log tells the story: slot transitions, signal and board writes at info, events at debug, and never a tool_input`, destructure `base` and `repo` from `start` and insert the `SessionStart` block before `await openPr(server, workerId);`. The test's tmp repo is not a git repo, so `resolveBranch` yields `undefined`, as in the `GET /slots/:id/output` test:

```ts
  const { base, repo, server } = await start(t, BODY, log);
  …
  const session = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  assert.equal((await hookEvent(base, workerId, { hook_event_name: 'SessionStart', cwd: repo, session_id: session })).status, 200);
  assert.equal(slot0(server).sessionId, session, 'the route hands the whole payload to the reducer');
  has(`DEBUG hook SessionStart worker=${id8}`);
  has(`INFO slot 1: session=${session} #1 worker=${id8}`);
  assert.equal(lines.filter((l) => l.includes('session=')).length, 1, 'one line per session');
  await openPr(server, workerId);
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 254 tests PASS (`server` 15, same count: the check lives in an existing test). This task has no RED step by design: the source already does the work after Tasks 1 and 2. If it fails, the bug is in Task 1 or 2, not here.

- [ ] **Step 3: Commit**

```bash
git add test/server.test.ts
git commit -m "test(server): SessionStart over /hooks/event leaves sessionId on the slot and a session= line in the log"
```

---

### Task 4: Detail panel — `sessão: claude --resume <id>` under `branch`

**Files:**
- Modify: `src/ui/app.ts`

**Interfaces:**
- `renderDetail()` gains one entry in `lines` after the `branch` line: `slot.sessionId ? \`<div class="meta">sessão: <code>claude --resume ${esc(slot.sessionId)}</code></div>\` : ''`. `esc` is already imported from `./highlight.js`. The card (`renderSlot`) and `index.html` do not change.
- No `node:test` covers `app.ts` (browser module); the check is manual, listed in Verification and in the PR test plan.

- [ ] **Step 1: Edit `src/ui/app.ts`**

In `renderDetail`, after the `branch` line of `lines`:

```ts
    `<div class="meta">branch: ${esc(slot.branch ?? '—')}</div>`,
    slot.sessionId ? `<div class="meta">sessão: <code>claude --resume ${esc(slot.sessionId)}</code></div>` : '',
```

- [ ] **Step 2: Build, tests and lint**

Run: `NODE_PATH= pnpm test && pnpm lint`
Expected: 254 tests PASS, lint clean.

- [ ] **Step 3: Manual check**

Run `pnpm start` on a configured repo with the signal on green so one worker spawns. Open the slot's panel: after `worktree` and `branch` there is `sessão: claude --resume <uuid>` in monospace. Copy the command, run it inside the worktree shown above it: the session reopens. Before the worker's `SessionStart` arrives (first second or so) the line is absent, not `—`.

- [ ] **Step 4: Commit**

```bash
git add src/ui/app.ts
git commit -m "feat(ui): show claude --resume <id> in the slot detail panel"
```

---

## Verification

- `NODE_PATH= pnpm test` green: 254 tests (252 before; `orchestrator` 60, `log` 12, `server` 15). `pnpm lint` clean.
- Manual, `pnpm start` with one worker running: the panel shows `sessão: claude --resume <uuid>`; the command run inside the worktree reopens the session (spec criterion 1).
- Manual, `tail -f <repo>/.hive/hive.log`: right after `INFO  spawn slot=… #<task> slug=… worker=<id8>` comes `INFO  slot N: session=<uuid> #<task> worker=<id8>` with the same `worker=` (spec criterion 2). Later `INFO  slot N: trabalhando → aguardando_review #<task> worker=<id8>` shares that `worker=`, so `grep worker=<id8> .hive/hive.log` links PR and session.
- Manual, `cat <repo>/.hive/state.json`: the occupied slot carries `sessionId`. After a restart the slot is freed on `boot` (as today) and the id survives only in the log.
- Forged hook, optional: `curl -X POST localhost:<port>/hooks/event -H 'x-hive-worker: <workerId>' -H 'content-type: application/json' -d '{"hook_event_name":"SessionStart","session_id":"<b>x</b>"}'` → 200, `sessionId` unchanged, no `session=` line.

## Notes

- `isSessionId` lives in `src/orchestrator.ts` per the spec (next to the reducer that uses it), not in `src/usage.ts` where `isTranscriptPath` is: the transcript check is about files, this one is about the payload.
- The session line is derived in `describeChanges`, not in the reducer, for the same reason the status transitions are: the reducer stays pure and `dispatch` is the one place that compares states.
- `!before(slot)?.sessionId` also covers a slot that has no counterpart in `prev` (added by `setMax`); such a slot is always empty, so nothing is emitted in practice and the branch stays one expression.
- `index.html` gets no CSS: the spec keeps it unchanged and `<code>` renders monospace by default inside `.meta`.
- Deliberate simplifications (all closed in the spec): no copy button, no web link, no issue / PR comment, no `/clear` handling (a new id on the same worker is ignored; #24), no resume from the Hive (#26).
