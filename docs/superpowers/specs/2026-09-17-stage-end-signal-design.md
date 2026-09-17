# Agent Hive — explicit stage end, awaited kill and in-process continuation (#83)

Extends the Hive columns (`2026-09-17-hive-columns-design.md`) and the worker session (`2026-09-17-worker-claude-session-design.md`). Anything not covered here stays as in v1 (`2026-09-15-agent-hive-design.md`).

**What happened in #83.** The #81 card went Backlog → Plan → Dev → In review in one minute. The spawn failure (`duplicate session`) was real but did not advance the card: it became an `exit`, the card stayed in Dev and `fill` respawned it right away, successfully. What advanced the card were two legitimate `Stop`s: `/hive-plan` dispatched `ecc:planner` as a background Agent and ended its turn ("I'll write and commit the plan when it reports back"); the Hive took that `Stop` as the end of the command, killed the worker with the planner still running inside it and opened Dev, which answered "queued behind /hive-plan" and ended its turn again. The columns rule, "the end of the turn is the end of the command", stopped holding once the Agent tool started running subagents in the background.

## Closed decisions

| Decision | Choice | Reason |
|---|---|---|
| Stage end | The worker says so: `POST /hooks/done` (curl with `x-hive-worker`). A `Stop` ends the stage only when the slot has already received the `done` | A `Stop` can arrive with background agents running or with a question asked in prose; only the worker knows it is finished |
| Who instructs the worker | The Hive appends a trailer to the rendered prompt of every run (spawn and continuation), with the curl ready (literal port and worker id) | Works for any column prompt, not only the repo's commands; nobody has to remember the curl |
| `Stop` without `done` | The slot goes `waiting`, `lastEvent: { kind: 'turn' }`, the session stays alive; the next `PreToolUse`/`UserPromptSubmit` brings it back to `working` | It is the true state: the worker is idle waiting for something (an agent notification, a human answer). Nothing is written to the board, the card does not move |
| Blocked `Stop` | No. The Hive never answers `block` to force the worker to go on without `done` | With nothing to do but wait, a `block` becomes a token loop |
| Continuation (want 3) | On a `Stop` with `done`, if the next column has a `prompt` and `session: continue` and the card is what `fill` would pick for this slot, the Hive answers the `Stop` hook with `{ decision: 'block', reason: <next column's prompt + trailer> }`: same process, same slot, same `workerId`, no kill, no spawn | Native Claude Code mechanism, identical in tmux and iTerm, no typing into the TUI. Background agents and teammates survive between columns. "The card is the next one in the queue" is the issue's condition: a heavier card waiting wins the slot |
| Continuation and `--resume` | `--resume` remains the path when the card does not continue in place (another card won the slot, signal not green, slot `draining`, budget): kill as today and the card waits for a slot | Context continuity without the process already exists (worker session); in-place continuation is the shortcut, not the replacement |
| Spawn failure (want 1) | `spawnFailed { workerId, message }`: the slot frees, the card stays in its column with `error: message` and leaves the candidates; a manual `start` (#47) clears the `error` and runs it; the bar shows the error | No automatic retry: tmux missing or a taken name would fail again in the same `fill`, in a tight loop. The human sees it and decides |
| Awaited kill (want 2) | `WorkerHandle.kill(): Promise<void>` resolves when the session/process no longer exists; `pool.kill` returns the promise; the `kill` effect awaits it, and since the effects of one `dispatch` run in order, a `spawn` of the same slug in the same batch only starts afterwards | Closes the `duplicate session`: `tmux new-session` runs only after `kill-session` returned. With a `new` session the next column kills and respawns the same slug in the same batch |
| Hook output | The hook command no longer discards the curl's stdout; the Hive answers every hook with an empty `204`, except the `Stop` that continues in place (`200` with the JSON) | It is how the `reason` reaches Claude Code. Empty stdout means "no decision" |
| `stop_hook_active` | Ignored | The Hive decides by `done`, not by how many times `Stop` fired |
| `/command` prompt on continuation | Accepted as is: the `reason` reaches the model as text and it invokes the skill (`Skill` tool), not as a typed slash command | It is what `hive-columns` already configures (`/hive-build {url}`); the result is the same expanded command |

## Protocol with the worker

- Trailer appended to every rendered prompt (spawn and continuation):

  ```
  ---
  Hive: when this command is completely finished — nothing left to do, no agent or background task still
  running, no answer pending from the user — run
  `curl -s -X POST http://127.0.0.1:<port>/hooks/done -H 'x-hive-worker: <workerId>'`
  and end your turn. Never run it earlier. If you need something from the user, ask and end your turn without it.
  ```

- `POST /hooks/done` (header `x-hive-worker`): `{ type: 'done', workerId }`. Unknown or empty slot: ignored. Repeated: idempotent.
- `Stop` (not from a subagent, `isChildSession` filter as today):
  - `slot.done` → `finish` (below).
  - without `done` → `waiting`, no effects.
- `/hooks/event` reply: `204` with no body, except when the `Stop`'s `dispatch` produced a `continue` effect for the same `workerId`: `200` `{ "decision": "block", "reason": "<prompt + trailer>" }`. `hookCommand` becomes `curl … -d @-; exit 0` (no `>/dev/null`).
- `SessionEnd`, `/hooks/exit`: `exit` as today.

## Types (`src/types.ts`)

```ts
interface Slot { /* as today */ done?: true; }            // /hooks/done received in this run; cleared on spawn and on continuation
interface Card { /* as today */ error?: string; }         // the last spawn failure; the card stays out of fill until a manual start
type SlotEventKind = /* as today */ | 'continuing';       // the in-place continuation

type HiveEvent = /* as today */
  | { type: 'done'; workerId: string }
  | { type: 'spawnFailed'; workerId: string; message: string };

type Effect = /* as today */
  | { type: 'continue'; workerId: string; card: Card; column: Column }; // answers the Stop with `column`'s prompt

interface WorkerHandle {
  started: Promise<void>;   // resolves when the session/tab exists; rejects with the spawner's error
  kill(): Promise<void>;    // resolves when the session/process no longer exists
  focus(): Promise<void>;
}
interface WorkerHandlers { onExit(): void; onError(message: string): void; } // onError only for kill/focus; a spawn failure is `started`
interface WorkerPool {
  start(o: StartWorker): void;              // `started` rejected → entry removed, `o.onSpawnFailed(message)`
  kill(workerId: string): Promise<boolean>; // false when unknown; resolves with the handle
  killAll(): Promise<void>;
  /* exit, focus, has as today */
}
```

`StartWorker` gains `onSpawnFailed(message: string): void`.

## `src/orchestrator.ts`

- `done(state, workerId)`: occupied slot with that `workerId` → `{ ...slot, done: true }`; otherwise unchanged.
- `applyHook` `Stop`: `slot.done ? fill(finish(state, workerId)) : patch(status: 'waiting', question: undefined, lastEvent: { kind: 'turn' })`.
- `finish(state, workerId)`: computes `moved` (the card in the next column, without `slotId`) and the state "as if freed" (`freeSlot` + `moved`). If `next?.prompt`, `next.session === 'continue'`, `!slot.draining`, `canSchedule(freed)` and `candidates(freed.cards, freed.columns)[0]` is this card → **continuation**: the slot keeps `id`/`workerId`, `status: 'working'`, `done: undefined`, `lastEvent: { kind: 'continuing' }`; the card goes to `next.name` keeping `slotId` and `sessionId`; effects: `setColumn(onFinish)` if `shouldWrite`, then `setColumn(next.onStart)` if `shouldWrite` against the already updated `boardColumn`, then `continue`. Otherwise → as today: `kill`, `setColumn(onFinish)`, card in `next` (or out) waiting for a slot.
- `occupy`: `done: undefined` on the new slot (it is a new slot already; explicit so it never inherits).
- `spawnFailed(state, workerId, message)`: like `exit`, plus `card.error = message` and `state.error = message` (the bar).
- `candidates` (`cards.ts`): excludes a card with `error`.
- `start`: clears `card.error` before `occupy`.
- `exit`, `boot`, `closeCard`, `keepCard`, `setColumns`: as today; `boot` clears `done` along with the slots.

## `src/spawn.ts`, `src/spawn-tmux.ts`, `src/spawn-iterm.ts`

- `doneTrailer(port, workerId)`: the text above; `renderPrompt` stays pure, the server concatenates.
- tmux: `started` is the `new-session` promise; `kill` chains on `started` (settled either way), runs `kill-session` and resolves after it (tmux only returns after destroying the session); a `kill-session` failure → `onError` as today and resolves anyway. A `started` failure no longer calls `onExit`.
- iTerm: `started` is the `openItermTab` promise; `kill` runs `killStray(slug)` and then `pgrep -f -- --worktree=<slug>` every 200 ms until nothing matches, 10 s cap (past it → `onError('kill: worker still alive after 10s')` and resolves).
- `createWorkerPool.start`: registers the entry, `handle.started.catch(err → entries.delete; o.onSpawnFailed(err.message))`. `kill` returns `entry.handle.kill()` (the entry only leaves on `onExit`, as today). `killAll` = `Promise.all` of the kills.

## `src/server.ts`

- `spawn`: written prompt = `renderPrompt(column.prompt, task) + doneTrailer(port, workerId)`; `onSpawnFailed: (message) => dispatch({ type: 'spawnFailed', workerId, message })`. `onError` keeps going to the bar (`fail`).
- `runEffect` `kill`: `await pool.kill(workerId)`; unknown → `exit` as today. `continue`: writes the prompt to `prompts/<slug>.md` (the run's same file) and stores the pending reply for the `workerId` (`Map<workerId, { decision, reason }>`).
- `dispatch` returns the effects (`Promise<Effect[]>`), the rest unchanged.
- `/hooks/event`: after the `dispatch`, if there is a pending reply for the `workerId` → `res.status(200).json(reply)` and remove it; otherwise `res.status(204).end()`. The other hook routes (`/hooks/exit`, `/hooks/status`) unchanged.
- `POST /hooks/done`: `res.status(204).end()`; header `x-hive-worker` → `dispatch({ type: 'done', workerId })`.
- `close`: `await pool.killAll()`.
- `src/log.ts`: `describeEvent` for `done` and `spawnFailed`; `describeEffect` for `continue` (`continue column=<name> worker=<id>`); `describeChanges` already covers status and column.
- `src/hooks-settings.ts`: `hookCommand` without `>/dev/null`.

## UI (`src/ui`)

- Card with `error`: error badge with the message (title) and the `start` button visible as on a stopped card; `start` clears it.
- `event.continuing` in `i18n.ts` (en: `continuing in the same session`, pt: `continuando na mesma sessão`); `event.turn` already exists and is what shows next to `waiting`.

## Commands (`.claude/commands`)

Nothing to change: the trailer is the Hive's. `hive-flow.md` gains one sentence saying the stage ends with the trailer's `/hooks/done` and that a turn ended without it leaves the slot yellow.

## Tests

- `test/orchestrator.test.ts`: `done` marks the slot; `Stop` without `done` → `waiting`, no effects, card in its column; `Stop` with `done` and a next `continue` column with the card on top → `continue` effect, no `kill`, slot keeps `workerId`, `done` cleared, card in the next column with `slotId`; `Stop` with `done` and a heavier card waiting → `kill` + `spawn` of the heavier one; next `new` → `kill` + `spawn` of the same card; yellow signal or `draining` slot → `kill`, card waits; `onFinish`/`onStart` written in order on continuation; `spawnFailed` frees the slot, sets `error`, `fill` skips the card, `start` clears and runs; `boot` clears `done`.
- `test/workers.test.ts`: rejected `started` → entry removed and `onSpawnFailed`; `kill` returns the handle's promise; `killAll` awaits.
- `test/spawn-tmux.test.ts`: `kill` resolves only after `kill-session`; a `new-session` failure rejects `started` and does not call `onExit`.
- `test/spawn-iterm.test.ts`: `kill` runs `pkill` and waits for an empty `pgrep`; the 10 s cap calls `onError`.
- `test/server.test.ts`: `/hooks/done` → slot `done`; a continuing `Stop` answers `200` with `{ decision: 'block', reason }` containing the next column's prompt and the trailer; a plain `Stop` answers an empty `204`; the prompt written at spawn ends with the trailer; the `kill` effect awaits the pool before the following `spawn` (a fake that resolves late: `spawn` is only called afterwards).
- `test/hooks-settings.test.ts`: `hookCommand` without `>/dev/null`.

## Done criteria

1. Replaying the #83 scenario (`plan` column with `/hive-plan {url}`, `dev` with `session: continue`): the `Stop` of the "the planner is running" turn leaves the slot yellow and the card in `plan`; when the planner returns and the command posts `done`, the next `Stop` answers `block` with `dev`'s prompt, the same process goes on, the card moves to `dev` with no kill.
2. With two consecutive `new` columns, `hive.log` shows the `kill` finished before the `spawn` of the same slug; no `duplicate session`.
3. With tmux removed from the PATH, the card gets `error` in its column, the bar shows the failure, `fill` does not retry, and a manual `start` tries again.

## Out of scope

- Typing into the worker's TUI (tmux `paste-buffer`, iTerm `write text`).
- Detecting pending agents from the transcript.
- A timeout for a `waiting` slot without `done`.
