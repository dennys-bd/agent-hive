# Agent Hive — workers embutidos (sem terminal externo): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Hive (Electron or `run:headless`) becomes the parent process of every `claude` worker: `child_process.spawn('claude', argv)` in print mode with stream-json on stdin/stdout, no iTerm, `osascript` or `pgrep` on the normal path. The detail panel shows the worker's output (last 200 formatted lines) and sends follow-up messages; a `result` with the PR open closes stdin so the slot frees itself; closing the Hive SIGTERMs every child; a restart gives every occupied slot as dead after a `pkill` defense per slug. Works on macOS and Linux.

**Architecture:** `src/workers.ts` (new) is an in-memory pool keyed by `workerId` over an injectable `SpawnWorker`; it sends the prompt as the first `user` message, keeps a 200-line ring of `formatOutput(line)` and reports `result` / `exit`. `src/spawn.ts` keeps `renderPrompt` / `writePrompt`, gains the pure `workerArgv` / `workerEnv` / `userMessage`, the real `spawnWorker` (readline over stdout/stderr, `onExit` once) and `killStray` (today's `killWorker`, boot only); every shell-string / AppleScript function goes. `src/server.ts` takes `spawnWorker` in `ServerDeps`, runs the `spawn` / `kill` effects through the pool, closes stdin on `result` when the slot is `aguardando_review`, adds `GET /slots/:id/output` and `POST /slots/:id/input`, drops `POST /hooks/exit` and `POST /slots/:id/focus`, and `close()` kills every child. The reducer's `boot` takes no `aliveSlugs` and `spawned` / `itermSessionId` disappear. The UI replaces "ir pro terminal" with an output `<pre>` polled every 2 s plus an input line; `main.ts` calls `server.close()` on `will-quit`.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`, `node:child_process` + `node:readline` (stdlib only).

**Spec:** `docs/superpowers/specs/2026-09-16-embedded-workers-design.md` (extends `docs/superpowers/specs/2026-09-15-agent-hive-design.md`). Its "Decisões fechadas" table is authoritative; nothing there is re-decided here.

## Global Constraints

- All v1, setup, boards and signal constraints hold: immutable reducer, argv arrays (`spawn` / `execFile`) never shell strings, Portuguese UI copy, English code comments, conventional commits in English without trailers, no machine-specific values, tokens only via env (`hive.config.json` stays token-free).
- No new runtime dependencies: `child_process.spawn` + `readline` from the stdlib do the process work.
- `run.ts`, `hooks-settings.ts`, `state-store.ts`, `src/boards/*`, `board.ts`, `config.ts` do not change. `main.ts` changes only for `will-quit`.
- Interfaces are exactly the spec's "Tipos" section: `WorkerHandlers`, `WorkerHandle`, `SpawnWorker` live in `src/types.ts`; `HiveEvent` loses `spawned` and `boot` becomes `{ type: 'boot' }`; `Slot` loses `itermSessionId`.
- Tests never start a real `claude`: `test/workers.test.ts` and `test/server.test.ts` inject the fake `SpawnWorker` from `test/fakes.ts`; the real `spawnWorker` is exercised only through the pure `workerArgv` / `workerEnv` / `userMessage`. `test/setup.test.ts` keeps `maxConcurrent: 0`; `test/server.test.ts` uses `maxConcurrent: 1` with the fake.
- Worker output never enters `State` (no persist / broadcast per line): it lives in the pool and is read through `GET /slots/:id/output`.
- Status codes: `POST /slots/:id/input` → 400 when `text` is not a non-empty string, 404 when the slot has no live process; `GET /slots/:id/output` → 404 when the slot does not exist or is `vazio`; both 409 before setup (existing `requireLive`).
- New files < 400 lines and every function < 50 lines. `server.ts` already exceeds 400 lines and must not grow beyond what the two new routes need (the removed routes and `detectAlive` pay for them).
- Every task leaves `pnpm test` green (build + all suites) and ends in exactly one commit. Expected deltas: T1 −2, T2 +9, T3 +3, T4 +6, T5 0.
- Every intermediate commit is coherent: dead code goes in the same commit that makes it dead (T1 removes `focusWorker`, `aliveSlugs`, the focus route and button; T4 removes `workerCommand`, `shellQuote`, `openWorker` when the server stops calling them).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `Slot` without `itermSessionId`; `HiveEvent` `boot` without `aliveSlugs`, `spawned` removed (T1); `WorkerHandlers`, `WorkerHandle`, `SpawnWorker` (T2) |
| `src/orchestrator.ts` | `boot(state)` exits every occupied slot; `spawned` case removed (T1) |
| `src/workers.ts` | new — `createWorkerPool(spawn)`, `formatOutput`, `OUTPUT_LINES`, `RESULT_LINE` (T2) |
| `src/spawn.ts` | T1: drop `focusWorker`, `FOCUS_SCRIPT`, `aliveSlugs`; T3: add `workerArgv`, `workerEnv`, `userMessage`, `spawnWorker`, rename `killWorker` → `killStray`; T4: drop `shellQuote`, `workerCommand`, `WorkerCommandOptions`, `openWorker`, `OPEN_TAB_SCRIPT`, `osascript` |
| `src/server.ts` | T1: `killStrays` replaces `detectAlive`, `boot` without slugs, no `spawned` dispatch, no focus route; T4: `ServerDeps.spawnWorker`, pool in effects, `endWhenReviewed`, output / input routes, no `/hooks/exit`, `close()` kills all and is idempotent |
| `src/hive.ts` | `killStrays(saved)` then `dispatch({ type: 'boot' })` (T1) |
| `src/main.ts` | `app.on('will-quit')` → `server.close()` (T5) |
| `src/ui/index.html` | T1: no "ir pro terminal" button; T5: `#output`, `#input` + `#send`, permissions hint |
| `src/ui/app.ts` | T1: no focus listener; T5: output polling every 2 s while the panel is open, `sendInput` |
| `README.md` | no iTerm / macOS-only wording; print mode and permissions (T5) |
| `test/fakes.ts` | new — `fakeSpawn()` (T2), `OPTIONS` + `fakeBoardFactory` moved from `test/setup.test.ts` (T4) |
| `test/orchestrator.test.ts` | `boot` without `aliveSlugs`; `spawned` test removed (T1) |
| `test/spawn.test.ts` | T1: no `aliveSlugs`; T3: `workerArgv`, `workerEnv`, `userMessage`, `killStray`; T4: no `shellQuote` / `workerCommand` |
| `test/workers.test.ts` | new — 9 tests over the fake spawn (T2) |
| `test/server.test.ts` | new — 8 tests: fake board + fake spawn, `maxConcurrent: 1` (T4) |
| `test/setup.test.ts` | imports the fakes from `test/fakes.ts`; comment on `maxConcurrent: 0` (T4) |

---

### Task 1: Reducer and types — `boot` without `aliveSlugs`, no `spawned` / `itermSessionId` / terminal focus

**Files:**
- Modify: `src/types.ts`, `src/orchestrator.ts`, `src/server.ts`, `src/hive.ts`, `src/spawn.ts`, `src/ui/index.html`, `src/ui/app.ts`
- Test: `test/orchestrator.test.ts`, `test/spawn.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `HiveEvent` member `{ type: 'boot' }` (no `aliveSlugs`); `spawned` member removed; `Slot` without `itermSessionId`.
- Produces (in `src/orchestrator.ts`): `boot(state)` — every slot with `status !== 'vazio'` goes through `exit` (task without PR requeued with a `setStatus queue` effect; no `fill`).
- Produces (in `src/server.ts`): `export async function killStrays(state: State): Promise<void>` — `killWorker` (renamed `killStray` in T3) on every occupied slug; replaces `detectAlive`.
- Removes: `detectAlive` (server), `focusWorker`, `FOCUS_SCRIPT`, `aliveSlugs` (spawn), `POST /slots/:id/focus`, the `#focus` button and its listener.
- Consumed by: T4 (`killStrays` on `configure` / `bootHive`), everything after.

- [ ] **Step 1: Update `test/orchestrator.test.ts`**

Replace the test `boot empties slots whose worker is dead and requeues their tasks; alive ones stay` (lines 266–273) with:

```ts
test('boot gives every occupied slot as dead: tasks without a PR go back to the queue, tasks with a PR just free the slot', () => {
  const first = filled(2, 2).state;
  const all = reduce(first, { type: 'boot' });
  assert.deepEqual(all.state.slots.map((s) => s.status), ['vazio', 'vazio']);
  assert.deepEqual(all.state.queue.map((t) => t.id), ['1', '2']);
  assert.deepEqual(all.effects, [
    { type: 'setStatus', itemId: 'item1', key: 'queue' },
    { type: 'setStatus', itemId: 'item2', key: 'queue' },
  ]);
  const withPr = hook(first, first.slots[1].workerId!, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/9',
  }).state;
  const { state, effects } = reduce(withPr, { type: 'boot' });
  assert.deepEqual(state.slots.map((s) => s.status), ['vazio', 'vazio']);
  assert.deepEqual(state.queue.map((t) => t.id), ['1'], 'a task with a PR is not requeued');
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item1', key: 'queue' }]);
});
```

Delete the test `spawned stores the iTerm session id` (lines 281–285).

- [ ] **Step 2: Update `test/spawn.test.ts`**

Line 6 → `import { killWorker, renderPrompt, shellQuote, workerCommand, writePrompt } from '../src/spawn.js';`

Delete the test `aliveSlugs resolves to [] for a slug with no matching process (pgrep exit 1)` (lines 45–47).

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `Property 'aliveSlugs' is missing in type '{ type: "boot"; }'` in the orchestrator test.

- [ ] **Step 4: Edit `src/types.ts`**

Delete line 51 (`  itermSessionId?: string;`).
Line 93 → `  | { type: 'boot' }`.
Delete line 102 (`  | { type: 'spawned'; workerId: string; itermSessionId: string }`).

- [ ] **Step 5: Edit `src/orchestrator.ts`**

Line 64 → `    case 'boot': return boot(state); // no fill: bootHive polls right after, and the board is the truth`
Delete line 76 (`    case 'spawned': return patch(state, event.workerId, { itermSessionId: event.itermSessionId });`).
Replace `boot` (lines 172–178) with:

```ts
// Workers are children of the Hive: none survives a restart, so every occupied slot is given as dead.
function boot(state: State): Reduced {
  return state.slots
    .filter((s) => s.status !== 'vazio' && s.workerId)
    .reduce<Reduced>((r, s) => {
      const next = exit(r.state, s.workerId!);
      return { state: next.state, effects: [...r.effects, ...next.effects] };
    }, none(state));
}
```

- [ ] **Step 6: Edit `src/spawn.ts`**

Delete `FOCUS_SCRIPT` (lines 66–83), `focusWorker` (lines 94–97) and `aliveSlugs` (lines 114–127). `osascript`, `OPEN_TAB_SCRIPT`, `openWorker`, `worktreePattern` and `killWorker` stay until T3/T4.

- [ ] **Step 7: Edit `src/server.ts`**

Line 14 → `import { killWorker, openWorker, renderPrompt, workerCommand, writePrompt } from './spawn.js';`

Replace `detectAlive` (lines 76–78) with:

```ts
/** Boot-only orphan defense: a worker of a previous Hive may still hold a worktree. Every occupied slot is given as dead right after. */
export async function killStrays(state: State): Promise<void> {
  const slugs = state.slots.flatMap((s) => (s.status !== 'vazio' && s.slug ? [s.slug] : []));
  await Promise.all(slugs.map((slug) => killWorker(slug)));
}
```

Replace the `persist` comment (lines 110–113) with:

```ts
  // Serializes writes: dispatch calls can overlap (a hook arriving mid-poll, a worker exit landing
  // inside a kill effect), and two concurrent saveState calls would race on the same state.json.tmp.
  // Chaining onto saveChain queues them, and reading `live` inside the .then ensures a queued save
  // always persists the latest.
```

In `spawn`, replace lines 165–166 (`const itermSessionId = await openWorker(command);` and the `spawned` dispatch) with `    await openWorker(command);`.

In `configure`, replace line 217 with:

```ts
    await killStrays(saved);
    await dispatch({ type: 'boot' });
```

Delete the whole `app.post('/slots/:id/focus', …)` handler (lines 405–419).

- [ ] **Step 8: Edit `src/hive.ts`**

Line 4 → `import { createServer, killStrays, type HiveServer } from './server.js';`
Line 22 → two lines:

```ts
  await killStrays(saved);
  await server.dispatch({ type: 'boot' });
```

- [ ] **Step 9: Edit the UI**

`src/ui/index.html`: delete line 140 (`        <button id="focus">ir pro terminal</button>`).
`src/ui/app.ts`: delete lines 402–404 (the `$('focus').addEventListener(…)` block).

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm test`
Expected: all PASS, two fewer tests than before (`orchestrator` −1, `spawn` −1).

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/orchestrator.ts src/server.ts src/hive.ts src/spawn.ts src/ui/index.html src/ui/app.ts test/orchestrator.test.ts test/spawn.test.ts
git commit -m "refactor: boot gives every occupied slot as dead; drop spawned event, itermSessionId and terminal focus"
```

---

### Task 2: Worker pool in `src/workers.ts` with `formatOutput` (TDD, fake spawn)

**Files:**
- Create: `src/workers.ts`, `test/workers.test.ts`, `test/fakes.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Produces (in `src/types.ts`, exactly the spec's "Tipos"):
  - `interface WorkerHandlers { onLine(line: string): void; onExit(): void }`
  - `interface WorkerHandle { send(text: string): void; end(): void; kill(): void }`
  - `type SpawnWorker = (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }, handlers: WorkerHandlers) => WorkerHandle`
- Produces (in `src/workers.ts`):
  - `OUTPUT_LINES = 200`; `RESULT_LINE = '✔ turno encerrado'`
  - `interface StartWorker { workerId: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; prompt: string; onExit(): void; onResult(workerId: string): void }`
  - `interface WorkerPool { start(o: StartWorker): void; send(workerId, text): boolean; end(workerId): boolean; kill(workerId): boolean; killAll(): void; output(workerId): string[]; has(workerId): boolean }`
  - `formatOutput(line: string): string[]` — invalid JSON → `[line]`; `assistant` → each `text` block (≤ 2000 chars) and each `tool_use` as `▶ <name>: <command | file_path | pattern | description>` (detail ≤ 120 chars); `result` → `[RESULT_LINE]`; anything else → `[]`.
  - `createWorkerPool(spawn: SpawnWorker): WorkerPool`
- Produces (in `test/fakes.ts`): `interface FakeWorker { argv; opts; handlers; sent: string[]; ended: number; killed: number }`; `fakeSpawn(): { spawn: SpawnWorker; workers: FakeWorker[] }`.
- Consumed by: T4 (server pool, `RESULT_LINE` in tests, `fakeSpawn`).

- [ ] **Step 1: Write the failing tests — `test/fakes.ts`**

```ts
import type { SpawnWorker, WorkerHandlers } from '../src/types.js';

export interface FakeWorker {
  argv: string[];
  opts: { cwd: string; env: NodeJS.ProcessEnv };
  handlers: WorkerHandlers;
  sent: string[];
  ended: number;
  killed: number;
}

/** A SpawnWorker that opens nothing: records every call and exposes the handlers so a test can emit lines and exits. */
export function fakeSpawn(): { spawn: SpawnWorker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const spawn: SpawnWorker = (argv, opts, handlers) => {
    const worker: FakeWorker = { argv, opts, handlers, sent: [], ended: 0, killed: 0 };
    workers.push(worker);
    return {
      send: (text) => {
        worker.sent.push(text);
      },
      end: () => {
        worker.ended += 1;
      },
      kill: () => {
        worker.killed += 1;
      },
    };
  };
  return { spawn, workers };
}
```

- [ ] **Step 2: Write the failing tests — `test/workers.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerPool, formatOutput, OUTPUT_LINES, RESULT_LINE } from '../src/workers.js';
import { fakeSpawn } from './fakes.js';

const ENV: NodeJS.ProcessEnv = { HIVE_WORKER_ID: 'W1', HIVE_PORT: '4242' };
const noop = (): void => {};

const assistant = (...content: unknown[]): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });

function started(workerId = 'W1') {
  const { spawn, workers } = fakeSpawn();
  const pool = createWorkerPool(spawn);
  const exits: string[] = [];
  const results: string[] = [];
  pool.start({
    workerId, argv: ['-p'], cwd: '/repo', env: ENV, prompt: 'faz a task',
    onExit: () => exits.push(workerId), onResult: (id) => results.push(id),
  });
  return { pool, worker: workers[0], workers, exits, results };
}

test('formatOutput shows assistant text blocks and tool calls with their main argument', () => {
  const line = assistant(
    { type: 'text', text: 'vou olhar o arquivo' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', description: 'roda os testes' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
    { type: 'tool_use', name: 'Task', input: { description: 'explora o repo' } },
    { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
  );
  assert.deepEqual(formatOutput(line), [
    'vou olhar o arquivo', '▶ Read: /repo/src/a.ts', '▶ Bash: pnpm test', '▶ Grep: TODO', '▶ Task: explora o repo', '▶ TodoWrite',
  ]);
});

test('formatOutput truncates text to 2000 chars and tool arguments to 120', () => {
  const [text, tool] = formatOutput(
    assistant({ type: 'text', text: 'x'.repeat(2500) }, { type: 'tool_use', name: 'Bash', input: { command: 'y'.repeat(300) } }),
  );
  assert.equal(text.length, 2000);
  assert.equal(tool, `▶ Bash: ${'y'.repeat(120)}`);
});

test('formatOutput marks a result, hides system / user / stream_event lines and passes non-JSON through', () => {
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'result', subtype: 'success' })), [RESULT_LINE]);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'system', subtype: 'init' })), []);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })), []);
  assert.deepEqual(formatOutput(JSON.stringify({ type: 'stream_event' })), []);
  assert.deepEqual(formatOutput('stderr: warning: something'), ['stderr: warning: something']);
  assert.deepEqual(formatOutput('42'), ['42']);
  assert.deepEqual(formatOutput(''), ['']);
});

test('start opens the process with argv, cwd and env and sends the prompt as the first message', () => {
  const { worker, pool } = started();
  assert.deepEqual(worker.argv, ['-p']);
  assert.deepEqual(worker.opts, { cwd: '/repo', env: ENV });
  assert.deepEqual(worker.sent, ['faz a task']);
  assert.equal(pool.has('W1'), true);
  assert.equal(pool.has('W2'), false);
});

test('output keeps the last 200 formatted lines and returns a copy', () => {
  const { worker, pool } = started();
  for (let i = 0; i < OUTPUT_LINES + 5; i += 1) worker.handlers.onLine(`line ${i}`);
  const lines = pool.output('W1');
  assert.equal(lines.length, OUTPUT_LINES);
  assert.equal(lines[0], 'line 5');
  assert.equal(lines.at(-1), `line ${OUTPUT_LINES + 4}`);
  lines.push('mutated');
  assert.equal(pool.output('W1').length, OUTPUT_LINES);
  assert.deepEqual(pool.output('nope'), []);
});

test('a result line calls onResult with the worker id; other lines do not', () => {
  const { worker, results } = started();
  worker.handlers.onLine(assistant({ type: 'text', text: 'oi' }));
  worker.handlers.onLine(JSON.stringify({ type: 'system' }));
  worker.handlers.onLine('not json');
  assert.deepEqual(results, []);
  worker.handlers.onLine(JSON.stringify({ type: 'result' }));
  assert.deepEqual(results, ['W1']);
});

test('exit removes the worker and calls onExit; later calls report it unknown', () => {
  const { worker, pool, exits } = started();
  worker.handlers.onLine('hello');
  worker.handlers.onExit();
  assert.deepEqual(exits, ['W1']);
  assert.equal(pool.has('W1'), false);
  assert.deepEqual(pool.output('W1'), []);
  assert.equal(pool.send('W1', 'x'), false);
  assert.equal(pool.end('W1'), false);
  assert.equal(pool.kill('W1'), false);
  assert.deepEqual(worker.sent, ['faz a task'], 'nothing written after the exit');
});

test('send, end and kill reach the handle of a live worker and return true', () => {
  const { worker, pool } = started();
  assert.equal(pool.send('W1', 'continua'), true);
  assert.equal(pool.end('W1'), true);
  assert.equal(pool.kill('W1'), true);
  assert.deepEqual(worker.sent, ['faz a task', 'continua']);
  assert.equal(worker.ended, 1);
  assert.equal(worker.killed, 1);
});

test('killAll sends kill to every live worker and skips the ones that already exited', () => {
  const { spawn, workers } = fakeSpawn();
  const pool = createWorkerPool(spawn);
  for (const workerId of ['W1', 'W2', 'W3']) {
    pool.start({ workerId, argv: [], cwd: '/repo', env: ENV, prompt: 'p', onExit: noop, onResult: noop });
  }
  workers[0].handlers.onExit();
  pool.killAll();
  assert.deepEqual(workers.map((w) => w.killed), [0, 1, 1]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `Cannot find module '../src/workers.js'`, `'SpawnWorker'` / `'WorkerHandlers'` not exported from `types.js`.

- [ ] **Step 4: Append to `src/types.ts`**

```ts
/** What the server injects so tests never open a process. */
export interface WorkerHandlers {
  onLine(line: string): void; // one stdout line, or one stderr line prefixed `stderr: `
  onExit(): void; // once, on process exit or spawn error
}

export interface WorkerHandle {
  send(text: string): void; // one `user` message on stdin
  end(): void; // close stdin: the session ends after the current turn
  kill(): void; // SIGTERM
}

export type SpawnWorker = (
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
  handlers: WorkerHandlers,
) => WorkerHandle;
```

- [ ] **Step 5: Create `src/workers.ts`**

```ts
import type { SpawnWorker, WorkerHandle } from './types.js';

export const OUTPUT_LINES = 200;
export const RESULT_LINE = '✔ turno encerrado';
const TEXT_MAX = 2000;
const TOOL_MAX = 120;

export interface StartWorker {
  workerId: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string; // first `user` message; the .hive/prompts file is only a record
  onExit(): void;
  onResult(workerId: string): void; // a `result` line: the turn ended
}

export interface WorkerPool {
  start(o: StartWorker): void;
  send(workerId: string, text: string): boolean; // false when the worker is unknown
  end(workerId: string): boolean;
  kill(workerId: string): boolean;
  killAll(): void;
  output(workerId: string): string[]; // copy of the last OUTPUT_LINES formatted lines; [] when unknown
  has(workerId: string): boolean;
}

interface Entry {
  handle: WorkerHandle;
  lines: string[];
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamLine {
  type?: string;
  message?: { content?: ContentBlock[] };
}

// stream-json: one JSON object per line. Anything else (stderr, CLI warnings) is not a stream line.
function parseLine(line: string): StreamLine | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as StreamLine) : undefined;
  } catch {
    return undefined;
  }
}

function describeBlock(block: ContentBlock): string[] {
  if (block.type === 'text') return block.text ? [block.text.slice(0, TEXT_MAX)] : [];
  if (block.type !== 'tool_use') return [];
  const input = block.input ?? {};
  const detail = String(input.command ?? input.file_path ?? input.pattern ?? input.description ?? '').slice(0, TOOL_MAX);
  const name = block.name ?? 'tool';
  return [detail ? `▶ ${name}: ${detail}` : `▶ ${name}`];
}

/** What one stdout line becomes in the panel: assistant text and tool calls, a mark per turn end, nothing for the rest. */
export function formatOutput(line: string): string[] {
  const parsed = parseLine(line);
  if (!parsed) return [line];
  if (parsed.type === 'result') return [RESULT_LINE];
  if (parsed.type !== 'assistant') return [];
  return (parsed.message?.content ?? []).flatMap(describeBlock);
}

/** In-memory registry of live workers keyed by workerId. Process state, not domain state: it is never persisted. */
export function createWorkerPool(spawn: SpawnWorker): WorkerPool {
  const entries = new Map<string, Entry>();

  function start(o: StartWorker): void {
    const { workerId } = o;
    const handle = spawn(o.argv, { cwd: o.cwd, env: o.env }, {
      onLine: (line) => {
        const entry = entries.get(workerId);
        if (!entry) return; // a line after the exit: nobody is watching this worker any more
        entry.lines = [...entry.lines, ...formatOutput(line)].slice(-OUTPUT_LINES);
        if (parseLine(line)?.type === 'result') o.onResult(workerId);
      },
      onExit: () => {
        entries.delete(workerId);
        o.onExit();
      },
    });
    entries.set(workerId, { handle, lines: [] });
    handle.send(o.prompt);
  }

  function call(workerId: string, action: (handle: WorkerHandle) => void): boolean {
    const entry = entries.get(workerId);
    if (!entry) return false;
    action(entry.handle);
    return true;
  }

  return {
    start,
    send: (workerId, text) => call(workerId, (handle) => handle.send(text)),
    end: (workerId) => call(workerId, (handle) => handle.end()),
    kill: (workerId) => call(workerId, (handle) => handle.kill()),
    killAll: () => {
      for (const { handle } of entries.values()) handle.kill();
    },
    output: (workerId) => [...(entries.get(workerId)?.lines ?? [])],
    has: (workerId) => entries.has(workerId),
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: all PASS, `workers` 9 new tests (+9).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/workers.ts test/workers.test.ts test/fakes.ts
git commit -m "feat: worker pool with stream-json output formatting"
```

---

### Task 3: `src/spawn.ts` — `workerArgv`, `workerEnv`, `userMessage`, real `spawnWorker`, `killStray` (TDD)

**Files:**
- Modify: `src/spawn.ts`, `src/server.ts` (import rename only)
- Test: `test/spawn.test.ts`

**Interfaces:**
- Produces (in `src/spawn.ts`):
  - `interface WorkerArgvOptions { slug: string; hooksPath: string; claudeArgs: string[] }`
  - `workerArgv(o): string[]` = `['--worktree=<slug>', '--settings', hooksPath, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...claudeArgs]`
  - `workerEnv(base: NodeJS.ProcessEnv, workerId: string, port: number): NodeJS.ProcessEnv` — copy without `CLAUDECODE`, plus `HIVE_WORKER_ID`, `HIVE_PORT`
  - `userMessage(text: string): string` — `JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'`
  - `spawnWorker: SpawnWorker` — `spawn('claude', argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })`; readline on stdout → `onLine(line)`, on stderr → `onLine('stderr: ' + line)`; `exit` / `error` → `onExit` once
  - `killStray(slug): Promise<boolean>` — today's `killWorker`, renamed
- Removes: nothing yet (`shellQuote`, `workerCommand`, `openWorker` go in T4 with the server rewrite).
- Consumed by: T4.

- [ ] **Step 1: Update `test/spawn.test.ts`**

Line 6 → `import { killStray, renderPrompt, shellQuote, userMessage, workerArgv, workerCommand, workerEnv, writePrompt } from '../src/spawn.js';`

Replace the `killWorker resolves false when no process matches` test (last test) with:

```ts
test('workerArgv puts the worktree, the hooks settings and the stream-json print mode before claudeArgs', () => {
  const argv = workerArgv({ slug: 'hive-7-fix', hooksPath: '/Users/x/my repo/.hive/hooks.json', claudeArgs: ['--permission-mode', 'acceptEdits'] });
  assert.deepEqual(argv, [
    '--worktree=hive-7-fix', '--settings', '/Users/x/my repo/.hive/hooks.json',
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
  ]);
  assert.deepEqual(workerArgv({ slug: 's', hooksPath: 'h', claudeArgs: [] }).slice(-1), ['--verbose'], 'no trailing args without claudeArgs');
});

test('workerEnv copies the base env without CLAUDECODE and adds HIVE_WORKER_ID and HIVE_PORT', () => {
  const base = { PATH: '/bin', CLAUDECODE: '1', HOME: '/Users/x' };
  assert.deepEqual(workerEnv(base, 'W1', 4242), { PATH: '/bin', HOME: '/Users/x', HIVE_WORKER_ID: 'W1', HIVE_PORT: '4242' });
  assert.equal(base.CLAUDECODE, '1', 'the base env is not touched');
});

test('userMessage wraps text as one stream-json user line', () => {
  assert.equal(userMessage('oi "você"\nlinha 2'), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'oi "você"\nlinha 2' } })}\n`);
});

test('killStray resolves false when no process matches', async () => {
  assert.equal(await killStray('definitely-not-running-slug-xyz'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `'killStray'`, `'userMessage'`, `'workerArgv'`, `'workerEnv'` not exported from `spawn.js`.

- [ ] **Step 3: Edit `src/spawn.ts`**

Replace lines 1–5 (imports) with:

```ts
import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { SpawnWorker, Task } from './types.js';
```

Insert after `writePrompt` (before `shellQuote`):

```ts
export interface WorkerArgvOptions {
  slug: string;
  hooksPath: string;
  claudeArgs: string[]; // where the user sets the permission mode: print mode has no permission prompt
}

/** Print mode with JSON on both ends of stdio: the session stays open until stdin closes, so follow-ups still work. */
export function workerArgv(o: WorkerArgvOptions): string[] {
  return [
    `--worktree=${o.slug}`, '--settings', o.hooksPath,
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ...o.claudeArgs,
  ];
}

/** The child's env: the Hive's own minus CLAUDECODE (a Hive launched from inside Claude Code would stop the child from starting). */
export function workerEnv(base: NodeJS.ProcessEnv, workerId: string, port: number): NodeJS.ProcessEnv {
  const { CLAUDECODE: _inherited, ...env } = base;
  return { ...env, HIVE_WORKER_ID: workerId, HIVE_PORT: String(port) };
}

export function userMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

export const spawnWorker: SpawnWorker = (argv, { cwd, env }, handlers) => {
  const child = spawn('claude', argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    handlers.onExit();
  };
  createInterface({ input: child.stdout }).on('line', (line) => handlers.onLine(line));
  createInterface({ input: child.stderr }).on('line', (line) => handlers.onLine(`stderr: ${line}`));
  child.on('exit', exitOnce);
  child.on('error', (err) => {
    // claude not on PATH, or the signal failed: shown in the panel, and the worker is over either way
    handlers.onLine(`stderr: ${err.message}`);
    exitOnce();
  });
  child.stdin.on('error', (err) => handlers.onLine(`stderr: stdin: ${err.message}`)); // EPIPE after the child died: exit already freed the slot
  return {
    send: (text) => {
      child.stdin.write(userMessage(text));
    },
    end: () => {
      child.stdin.end();
    },
    kill: () => {
      child.kill('SIGTERM');
    },
  };
};
```

Rename `killWorker` → `killStray` and replace its doc comment with:

```ts
/** Boot-only orphan defense: kills a worker of a previous Hive that may still hold the worktree. Resolves true when pkill matched. */
```

- [ ] **Step 4: Edit `src/server.ts`**

Line 14 → `import { killStray, openWorker, renderPrompt, workerCommand, writePrompt } from './spawn.js';`
In `killStrays`: `slugs.map((slug) => killWorker(slug))` → `slugs.map((slug) => killStray(slug))`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: all PASS (`spawn` +3: `workerArgv`, `workerEnv`, `userMessage`; `killStray` replaces `killWorker`).

- [ ] **Step 6: Commit**

```bash
git add src/spawn.ts src/server.ts test/spawn.test.ts
git commit -m "feat: spawn a claude worker as a child process over stdio"
```

---

### Task 4: Server — injectable `spawnWorker`, pool in effects, output / input routes, `close()` kills all (TDD)

**Files:**
- Create: `test/server.test.ts`
- Modify: `src/server.ts`, `src/spawn.ts`, `test/fakes.ts`, `test/setup.test.ts`, `test/spawn.test.ts`

**Interfaces:**
- Produces (in `src/server.ts`): `ServerDeps.spawnWorker?: SpawnWorker` (default: the real one); effect `spawn` → `writePrompt` + `pool.start({ workerId, argv: workerArgv(…), cwd: repo, env: workerEnv(process.env, workerId, config.port), prompt, onExit: exit dispatch, onResult: endWhenReviewed })`; effect `kill` → `pool.kill(workerId)`, `exit` dispatched when `false`; `close()` → `pool.killAll()` first, idempotent.
- Routes: `GET /slots/:id/output` → `{ lines: string[] }` (404 when the slot does not exist or is `vazio`); `POST /slots/:id/input { text }` → 400 when `text` is not a non-empty string, 404 when no live process, else `{ ok: true }`. Removed: `POST /hooks/exit`.
- Produces (in `test/fakes.ts`): `OPTIONS`, `fakeBoardFactory(resolveDelayMs?)` (moved from `test/setup.test.ts`, unchanged).
- Removes (in `src/spawn.ts`): `WorkerCommandOptions`, `shellQuote`, `workerCommand`, `ITERM_APP_ID`, `OPEN_TAB_SCRIPT`, `osascript`, `openWorker` and their tests.
- Consumed by: T5 (UI routes), T6.

- [ ] **Step 1: Move the fake board to `test/fakes.ts`**

Append to `test/fakes.ts` (add `import { setTimeout as sleep } from 'node:timers/promises';` and `import type { Board, Config, SpawnWorker, WorkerHandlers } from '../src/types.js';` at the top, replacing the existing type import):

```ts
export const OPTIONS = ['Ready', 'In progress', 'In review', 'Done'];

// A board that has the OPTIONS columns and returns one task named after the configured queue column.
// `resolveDelayMs` makes resolveFields slow so concurrent saves overlap.
export function fakeBoardFactory(resolveDelayMs = 0): { factory: (config: Config) => Board; configs: Config[] } {
  const configs: Config[] = [];
  const factory = (config: Config): Board => {
    configs.push(config);
    return {
      async resolveFields() {
        if (resolveDelayMs > 0) await sleep(resolveDelayMs);
        for (const key of ['queue', 'working', 'review'] as const) {
          const wanted = config.status[key];
          if (!OPTIONS.includes(wanted)) {
            throw new Error(`status.${key} "${wanted}" not found in board Status options: ${OPTIONS.join(', ')}`);
          }
        }
      },
      async listQueue() {
        return [{ itemId: 'I1', id: '1', title: `from ${config.status.queue}`, body: '', url: 'https://github.com/acme/r/issues/1' }];
      },
      async setStatus() {},
      async setupOptions() {
        return OPTIONS;
      },
    };
  };
  return { factory, configs };
}
```

`test/setup.test.ts`: delete line 14 (`const OPTIONS = …`) and lines 21–47 (the local `fakeBoardFactory`); line 12 → `import type { Config, SetupBody, SetupInfo, State } from '../src/types.js';`; add `import { fakeBoardFactory } from './fakes.js';` after the `newBoardText` import; line 18 → `  maxConcurrent: 0, // zero slots: nothing is ever spawned (spawn would start a real claude)`. `sleep` stays imported (used by the hooks test).

- [ ] **Step 2: Write the failing tests — `test/server.test.ts`**

```ts
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseConfig } from '../src/config.js';
import { prepareHiveDir } from '../src/hooks-settings.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { createServer, type HiveServer } from '../src/server.js';
import { RESULT_LINE } from '../src/workers.js';
import type { SetupBody, Slot, State } from '../src/types.js';
import { fakeBoardFactory, fakeSpawn, type FakeWorker } from './fakes.js';

const BODY: SetupBody = {
  board: { type: 'github', owner: 'acme', number: 6 },
  status: { queue: 'Ready', working: 'In progress', review: 'In review' },
  maxConcurrent: 1, // one slot: the fake board's single task is spawned into the fake worker
};

interface Started { repo: string; base: string; port: number; server: HiveServer; workers: FakeWorker[] }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const slot0 = (server: HiveServer): Slot => server.getState()!.slots[0];
const line = (worker: FakeWorker, payload: unknown): void => worker.handlers.onLine(JSON.stringify(payload));

async function start(t: TestContext): Promise<Started> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ repo, boardFactory: fakeBoardFactory().factory, spawnWorker: spawn });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/setup`, BODY)).status, 200); // configure + poll + fill: the spawn runs before the answer
  return { repo, base, port, server, workers };
}

// The fake's onExit dispatches without awaiting, like a real process event: poll the state until it settles.
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

const openPr = (server: HiveServer, workerId: string): Promise<void> =>
  server.dispatch({
    type: 'hook', workerId,
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/acme/r/pull/9' },
  });

test('saving the setup starts one worker in the repo with the stream-json argv, the hive env and the prompt as first message', async (t) => {
  const { repo, port, server, workers } = await start(t);
  const slot = slot0(server);
  assert.equal(slot.status, 'trabalhando');
  assert.equal(slot.slug, 'hive-1-from-ready');
  assert.equal(workers.length, 1);
  const [worker] = workers;
  assert.deepEqual(worker.argv, [
    '--worktree=hive-1-from-ready', '--settings', join(repo, '.hive', 'hooks.json'),
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ]);
  assert.equal(worker.opts.cwd, repo);
  assert.equal(worker.opts.env.HIVE_WORKER_ID, slot.workerId);
  assert.equal(worker.opts.env.HIVE_PORT, String(port));
  assert.equal(worker.opts.env.CLAUDECODE, undefined);
  assert.deepEqual(worker.sent, [await readFile(join(repo, '.hive', 'prompts', 'hive-1-from-ready.md'), 'utf8')]);
});

test('POST /slots/:id/input writes to the worker; blank text is 400 and an unknown slot is 404', async (t) => {
  const { base, server, workers } = await start(t);
  const id = slot0(server).id;
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/input`, { text: 'olha o CI também' })), { ok: true });
  assert.deepEqual(workers[0].sent.slice(1), ['olha o CI também']);
  assert.equal((await postJson(`${base}/slots/${id}/input`, { text: '   ' })).status, 400);
  assert.equal((await postJson(`${base}/slots/${id}/input`, {})).status, 400);
  assert.equal((await postJson(`${base}/slots/nope/input`, { text: 'x' })).status, 404);
  assert.equal(workers[0].sent.length, 2);
});

test('GET /slots/:id/output returns the formatted lines the worker emitted; an unknown slot is 404', async (t) => {
  const { base, server, workers } = await start(t);
  const id = slot0(server).id;
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: [] });
  line(workers[0], { type: 'assistant', message: { content: [{ type: 'text', text: 'lendo o issue' }] } });
  workers[0].handlers.onLine('stderr: aviso');
  line(workers[0], { type: 'result' });
  assert.deepEqual(await json(fetch(`${base}/slots/${id}/output`)), { lines: ['lendo o issue', 'stderr: aviso', RESULT_LINE] });
  assert.equal((await fetch(`${base}/slots/nope/output`)).status, 404);
});

test('a result closes stdin only once the PR is open; the exit then frees the slot without requeueing', async (t) => {
  const { server, workers } = await start(t);
  const [worker] = workers;
  const workerId = slot0(server).workerId!;
  line(worker, { type: 'result' });
  assert.equal(worker.ended, 0, 'no PR yet: the session stays open for follow-ups');
  await openPr(server, workerId);
  assert.equal(slot0(server).status, 'aguardando_review');
  line(worker, { type: 'result' });
  assert.equal(worker.ended, 1);
  worker.handlers.onExit();
  await waitFor(() => slot0(server).status === 'vazio');
  assert.deepEqual(server.getState()?.queue, []);
  assert.equal(workers.length, 1, 'nothing left to spawn');
});

test('an exit without a PR requeues the task, which the free slot picks up again with a new worker', async (t) => {
  const { server, workers } = await start(t);
  const first = slot0(server).workerId;
  workers[0].handlers.onExit();
  await waitFor(() => workers.length === 2);
  const slot = slot0(server);
  assert.equal(slot.status, 'trabalhando');
  assert.notEqual(slot.workerId, first);
  assert.equal(workers[1].opts.env.HIVE_WORKER_ID, slot.workerId);
  assert.deepEqual(server.getState()?.queue, []);
});

test('POST /slots/:id/kill sends kill to the live worker; the slot frees on its exit, not before', async (t) => {
  const { base, server, workers } = await start(t);
  const id = slot0(server).id;
  assert.deepEqual(await json(postJson(`${base}/slots/${id}/kill`)), { ok: true });
  assert.equal(workers[0].killed, 1);
  assert.equal(slot0(server).status, 'trabalhando');
  workers[0].handlers.onExit();
  await waitFor(() => workers.length === 2); // requeued and picked up again
});

test('kill on a slot whose process the pool does not know (Hive restarted) frees the slot directly', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, 0);
  const { factory } = fakeBoardFactory();
  const config = parseConfig(BODY);
  const board = factory(config);
  const previous = reduce(initialState(1), { type: 'poll', tasks: await board.listQueue() }).state; // occupied by a worker of a previous run
  const state: State = { ...previous, signal: 'yellow' }; // yellow: the requeued task is not picked up, so the freed slot stays visible
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ repo, boardFactory: factory, spawnWorker: spawn, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state });
  await server.listen(0);
  t.after(() => server.close());
  await server.dispatch({ type: 'kill', slotId: state.slots[0].id });
  assert.equal(slot0(server).status, 'vazio');
  assert.deepEqual(server.getState()?.queue.map((task) => task.id), ['1']);
  assert.equal(workers.length, 0);
});

test('close() kills every live worker before the HTTP server goes down, and a second close() is a no-op', async (t) => {
  const { base, server, workers } = await start(t);
  await server.close();
  assert.equal(workers[0].killed, 1);
  await assert.rejects(fetch(`${base}/setup`));
  await server.close();
});
```

- [ ] **Step 3: Update `test/spawn.test.ts`**

Line 6 → `import { killStray, renderPrompt, userMessage, workerArgv, workerEnv, writePrompt } from '../src/spawn.js';`
Delete the tests `shellQuote single-quotes and escapes embedded quotes` and `workerCommand runs claude in the repo with hive env, worktree, hooks and prompt, then reports exit`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error — `'spawnWorker' does not exist in type 'ServerDeps'`.

- [ ] **Step 5: Rewrite `src/spawn.ts`** (final content)

```ts
import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { SpawnWorker, Task } from './types.js';

const execFileAsync = promisify(execFile);
const NO_MATCH_EXIT = 1;

export interface WorkerArgvOptions {
  slug: string;
  hooksPath: string;
  claudeArgs: string[]; // where the user sets the permission mode: print mode has no permission prompt
}

export function renderPrompt(template: string, task: Task): string {
  const values: Record<string, string> = {
    id: task.id, number: task.id, title: task.title, body: task.body, url: task.url, // {number} is a synonym of {id}
  };
  return template.replace(/\{(id|number|title|body|url)\}/g, (_, key: string) => values[key]);
}

export async function writePrompt(promptsDir: string, slug: string, text: string): Promise<string> {
  const path = join(promptsDir, `${slug}.md`);
  await writeFile(path, text);
  return path;
}

/** Print mode with JSON on both ends of stdio: the session stays open until stdin closes, so follow-ups still work. */
export function workerArgv(o: WorkerArgvOptions): string[] {
  return [
    `--worktree=${o.slug}`, '--settings', o.hooksPath,
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ...o.claudeArgs,
  ];
}

/** The child's env: the Hive's own minus CLAUDECODE (a Hive launched from inside Claude Code would stop the child from starting). */
export function workerEnv(base: NodeJS.ProcessEnv, workerId: string, port: number): NodeJS.ProcessEnv {
  const { CLAUDECODE: _inherited, ...env } = base;
  return { ...env, HIVE_WORKER_ID: workerId, HIVE_PORT: String(port) };
}

export function userMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

export const spawnWorker: SpawnWorker = (argv, { cwd, env }, handlers) => {
  const child = spawn('claude', argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    handlers.onExit();
  };
  createInterface({ input: child.stdout }).on('line', (line) => handlers.onLine(line));
  createInterface({ input: child.stderr }).on('line', (line) => handlers.onLine(`stderr: ${line}`));
  child.on('exit', exitOnce);
  child.on('error', (err) => {
    // claude not on PATH, or the signal failed: shown in the panel, and the worker is over either way
    handlers.onLine(`stderr: ${err.message}`);
    exitOnce();
  });
  child.stdin.on('error', (err) => handlers.onLine(`stderr: stdin: ${err.message}`)); // EPIPE after the child died: exit already freed the slot
  return {
    send: (text) => {
      child.stdin.write(userMessage(text));
    },
    end: () => {
      child.stdin.end();
    },
    kill: () => {
      child.kill('SIGTERM');
    },
  };
};

/** Boot-only orphan defense: kills a worker of a previous Hive that may still hold the worktree. Resolves true when pkill matched. */
export async function killStray(slug: string): Promise<boolean> {
  try {
    await execFileAsync('pkill', ['-f', '--', `--worktree=${slug}`]);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code !== NO_MATCH_EXIT) throw err;
    return false;
  }
}
```

- [ ] **Step 6: Edit `src/server.ts`**

Imports: line 14 → two lines, and add `SpawnWorker` to the type import:

```ts
import { killStray, renderPrompt, spawnWorker, workerArgv, workerEnv, writePrompt } from './spawn.js';
import { createWorkerPool } from './workers.js';
```

```ts
import type {
  Board, Config, Effect, EventsPayload, HiveEvent, HookPayload, SetupBody, SetupInfo, SetupResult, Signal, Slot, SpawnWorker, State,
} from './types.js';
```

Constants: after `const HTTP_FORBIDDEN = 403;` add `const HTTP_NOT_FOUND = 404;`; after `SIGNAL_MESSAGE` add:

```ts
const SLOT_EMPTY_MESSAGE = 'slot vazio ou inexistente';
const NO_WORKER_MESSAGE = 'nenhum worker vivo nesse slot';
const INPUT_MESSAGE = 'text deve ser uma string não vazia';
```

`ServerDeps`:

```ts
export interface ServerDeps {
  repo: string;
  runtime?: Runtime;
  state?: State;
  boardFactory?: BoardFactory;
  spawnWorker?: SpawnWorker; // tests inject a fake; the default opens a real claude
}
```

In `createServer`, after the `boardFactory` line: `  const pool = createWorkerPool(deps.spawnWorker ?? spawnWorker);`

Replace the `kill` case in `runEffect` with:

```ts
      case 'kill':
        // unknown to the pool (started by a previous Hive): nothing to signal, free the slot ourselves
        if (!pool.kill(effect.workerId)) await dispatch({ type: 'exit', workerId: effect.workerId });
        return;
```

Replace `spawn` with:

```ts
  async function spawn(runtime: Runtime, slot: Slot): Promise<void> {
    if (!slot.task || !slot.slug || !slot.workerId) return;
    const { config, hooksPath, promptsDir } = runtime;
    const { workerId } = slot;
    const prompt = renderPrompt(config.promptTemplate, slot.task);
    await writePrompt(promptsDir, slot.slug, prompt); // kept as a record; the worker receives it over stdin
    pool.start({
      workerId, prompt, cwd: repo,
      argv: workerArgv({ slug: slot.slug, hooksPath, claudeArgs: config.claudeArgs }),
      env: workerEnv(process.env, workerId, config.port),
      onExit: () => void dispatch({ type: 'exit', workerId }),
      onResult: endWhenReviewed,
    });
  }

  // A turn ended with the PR already open: the task is done, so closing stdin lets the worker exit and free the slot.
  // Without a PR the session stays open for follow-ups from the panel.
  function endWhenReviewed(workerId: string): void {
    if (live?.state.slots.find((s) => s.workerId === workerId)?.status === 'aguardando_review') pool.end(workerId);
  }
```

Delete the whole `app.post('/hooks/exit', …)` handler.

After the `app.post('/slots/:id/kill', …)` handler add:

```ts
  app.get('/slots/:id/output', (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    if (!slot || slot.status === 'vazio') {
      res.status(HTTP_NOT_FOUND).json({ error: SLOT_EMPTY_MESSAGE });
      return;
    }
    res.json({ lines: slot.workerId ? pool.output(slot.workerId) : [] });
  });

  app.post('/slots/:id/input', (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const text = (req.body as { text?: unknown }).text;
    if (typeof text !== 'string' || text.trim() === '') {
      res.status(HTTP_BAD_REQUEST).json({ error: INPUT_MESSAGE });
      return;
    }
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    if (!slot?.workerId || !pool.send(slot.workerId, text)) {
      res.status(HTTP_NOT_FOUND).json({ error: NO_WORKER_MESSAGE });
      return;
    }
    res.json({ ok: true });
  });
```

Replace `close` with:

```ts
  async function close(): Promise<void> {
    if (pollTimer) clearInterval(pollTimer);
    pool.killAll(); // children of the Hive: none should outlive it
    const server = httpServer;
    httpServer = undefined; // a second close() (Electron will-quit after a test's after hook, or vice versa) is a no-op
    if (!server) return;
    server.closeAllConnections(); // drops open SSE streams so close() does not wait for them
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test`
Expected: all PASS — `server` 8 new, `spawn` −2 (net +6); `setup` unchanged.

- [ ] **Step 8: Headless smoke with a real worker (manual, needs `claude` on PATH)**

```bash
rm -rf /tmp/hive-embed && mkdir /tmp/hive-embed && cd /tmp/hive-embed && git init -q
printf '| id | título | status |\n|---|---|---|\n| T-1 | Criar README | Ready |\n' > board.md
git add board.md && git commit -qm board
cat > hive.config.json <<'EOF'
{ "board": { "type": "markdown", "path": "board.md" }, "maxConcurrent": 1, "claudeArgs": ["--permission-mode", "acceptEdits"] }
EOF
cd - && pnpm build && node dist/src/run.js /tmp/hive-embed &
sleep 8
ID=$(curl -s localhost:47821/events --max-time 1 | sed -n 's/^data: //p' | head -1 | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).slots[0].id')
curl -s localhost:47821/slots/$ID/output; echo
curl -s -X POST localhost:47821/slots/$ID/input -H 'content-type: application/json' -d '{"text":"resuma o que você fez"}'; echo
pgrep -fl -- --worktree=hive-t-1
kill %1; sleep 1; pgrep -fl -- --worktree=hive-t-1 || echo "no worker left"
```
Expected: no terminal tab opens; `output` shows `▶ …` tool lines and text; the input answers `{"ok":true}`; `pgrep` lists one `claude`; after `kill %1` nothing is listed (the child's stdin closed with the parent). Note: `run.ts` has no signal handler by design, so the second `pgrep` may still list the worker for a moment while it finishes the turn; the next boot's `killStray` covers the leftover.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts src/spawn.ts test/server.test.ts test/fakes.ts test/setup.test.ts test/spawn.test.ts
git commit -m "feat: server runs workers embedded, with output and input routes"
```

---

### Task 5: Detail panel with output and input, permissions hint, `will-quit`, README

**Files:**
- Modify: `src/ui/index.html`, `src/ui/app.ts`, `src/main.ts`, `README.md`

**Interfaces:**
- Consumes: `GET /slots/:id/output` → `{ lines: string[] }`, `POST /slots/:id/input { text }` (T4); `HiveServer.close()`.
- DOM ids added: `output` (`<pre>`), `input`, `send`. Removed in T1: `focus`.
- `OUTPUT_POLL_MS = 2_000`; polling runs only while the panel shows a slot and restarts clean when the selected slot changes.

- [ ] **Step 1: Edit `src/ui/index.html`**

After the `#detail pre { … }` rule (line 51) add:

```css
  #output { font: 12px/1.4 ui-monospace, monospace; min-height: 60px; }
  #detail .row { display: flex; gap: 8px; margin-top: 8px; }
  #detail .row input { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
```

Replace the prompt hint (line 126) with:

```html
  <div class="hint">placeholders: <code>{id}</code> <code>{title}</code> <code>{body}</code> <code>{url}</code> (<code>{number}</code> é sinônimo de <code>{id}</code>) — ex.: <code>/ship #{id}</code>. Vazio mantém o atual. No markdown, <code>{body}</code> é vazio e <code>{url}</code> é o caminho do arquivo. Em modo print não há prompt de permissão: libere as ferramentas com <code>claudeArgs</code> no <code>hive.config.json</code> (ex.: <code>["--permission-mode", "acceptEdits"]</code>) ou no <code>.claude/settings.json</code> do repo.</div>
```

Replace the `<aside id="detail">` block with:

```html
    <aside id="detail">
      <h2>detalhe</h2>
      <div id="detail-body"></div>
      <pre id="output"></pre>
      <div class="row">
        <input id="input" type="text" placeholder="mensagem pro worker" autocomplete="off">
        <button id="send">enviar</button>
      </div>
      <div class="actions" style="margin-top: 8px; display: flex; gap: 8px;">
        <button id="close">fechar</button>
      </div>
    </aside>
```

- [ ] **Step 2: Edit `src/ui/app.ts`**

After `const RERENDER_MS = 30_000;` add `const OUTPUT_POLL_MS = 2_000;`.
After `let setupInfo: SetupInfo | undefined;` add:

```ts
let outputTimer: ReturnType<typeof setInterval> | undefined;
let outputSlotId: string | undefined; // the slot the output polling follows
```

Before `renderDetail` add:

```ts
async function loadOutput(): Promise<void> {
  const slotId = outputSlotId;
  if (!slotId) return;
  try {
    const { lines } = await getJson<{ lines: string[] }>(`/slots/${slotId}/output`);
    if (slotId !== outputSlotId) return; // the panel moved on while the request was in flight
    const pre = $('output');
    const text = lines.join('\n');
    if (text === pre.textContent) return;
    pre.textContent = text;
    pre.scrollTop = pre.scrollHeight; // follows the worker as the output grows
  } catch (err) {
    showError((err as Error).message);
  }
}

// One timer, for the selected slot only: opening the panel starts it, closing or switching restarts it clean.
function syncOutputPolling(slotId: string | undefined): void {
  if (slotId === outputSlotId) return;
  if (outputTimer) clearInterval(outputTimer);
  outputTimer = undefined;
  outputSlotId = slotId;
  $('output').textContent = '';
  if (!slotId) return;
  void loadOutput();
  outputTimer = setInterval(() => void loadOutput(), OUTPUT_POLL_MS);
}

function sendInput(): void {
  const input = $<HTMLInputElement>('input');
  const text = input.value.trim();
  if (!selectedSlotId || !text) return;
  input.value = '';
  post(`/slots/${selectedSlotId}/input`, { text });
}
```

In `renderDetail`, add `    syncOutputPolling(undefined);` right after `selectedSlotId = undefined;` in the hidden branch, and `  syncOutputPolling(slot.id);` as the last line of the function (after `panel.classList.add('show');`).

In the events section, where the `$('focus')` listener used to be (before `$('close').addEventListener(…)`), add:

```ts
$('send').addEventListener('click', sendInput);
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendInput();
});
```

- [ ] **Step 3: Edit `src/main.ts`**

Replace lines 51–52 with:

```ts
  const { port, server } = await bootHive(repo);
  // Workers are children of this process: SIGTERM them before Electron goes away. Best effort, no waiting.
  app.on('will-quit', () => void server.close().catch((err: Error) => console.error('close failed:', err.message)));
  openWindow(port);
```

- [ ] **Step 4: Edit `README.md`**

Line 5 → `Hive starts up to N \`claude\` workers as child processes (print mode, JSON over stdio), each working on one task; when a session ends, the next task in the queue starts on its own. One card per worker shows what it is doing, turns yellow when Claude needs you, and blue once the PR is open. Click a card to read the worker's output and send it a follow-up; Hive observes (through Claude Code hooks) and schedules.`
Line 7 → `Runs 100% locally, no external service. macOS and Linux.`
Line 16 → `  │ Agent Hive │ ───────▶ │ claude -p --worktree=<task> (stdio)   │`
Line 25 → `2. Each worker is \`claude --worktree=<slug> -p --input-format stream-json --output-format stream-json\`, a child process of the Hive that receives the prompt on stdin, with a \`hooks.json\` injected via \`--settings\`: \`SessionStart\`, \`PreToolUse\`, \`Notification\`, \`PostToolUse\`, \`Stop\` and \`SessionEnd\` each \`curl\` the Hive.`
Line 31 → `Requirements: macOS or Linux, Node 24+, pnpm, \`claude\` (Claude Code), and \`gh\` logged in (GitHub boards only; run \`gh auth refresh -s project\` once).`
Line 49 → `On screen: \`N/M workers ativos\`, the \`máx. workers\` field (changes live), the queue, and one card per slot. Click a card to see the pending question or the PR link, the worker's output, and to send it a message; \`kill\` stops the worker and returns the task to the queue.`
Line 51: `or someone types in its terminal` → `or someone sends it a message from its card`.
Line 102 → `| \`claudeArgs\` | \`[]\` | file (e.g. \`["--permission-mode", "acceptEdits"]\`; print mode has no permission prompt, so this or the repo's \`.claude/settings.json\` must allow the tools) |`
Lines 118–119 → `- Print mode: there is no permission prompt; tools not allowed by \`claudeArgs\` or \`.claude/settings.json\` are denied. Questions from the worker show on the card; answer them from the card's input.`

- [ ] **Step 5: Build and run the tests**

Run: `pnpm test`
Expected: all PASS, count unchanged (UI compiles under `strict`).

- [ ] **Step 6: Check the panel in the app (manual, needs `claude` on PATH)**

Use `/tmp/hive-embed` from T4 step 8 (reset `board.md` to `Ready`). Run `pnpm start -- /tmp/hive-embed`.
Expected: the card goes green with no terminal tab; clicking it opens the panel with the output `<pre>` filling within 2 s and following the end; typing a message and pressing Enter clears the field, the card reads `prompt enviado`, and the message's effect shows in the output; "fechar" stops the polling (no more `/output` requests in the network log). The "matar" confirmation still reads `Matar esse worker? A task volta pra fila.`. Quit the app (Cmd+Q): `pgrep -fl -- --worktree=hive-t-1` lists nothing.

- [ ] **Step 7: Commit**

```bash
git add src/ui/index.html src/ui/app.ts src/main.ts README.md
git commit -m "feat: detail panel shows worker output and sends follow-ups; kill workers on quit"
```

---

### Task 6: Acceptance per the spec's "Critério de pronto"

**Files:**
- Modify: only what the run reveals (fixes to `src/` outside the UI come with a test).

**Interfaces:**
- Consumes everything from Tasks 1–5. No new exports.

- [ ] **Step 1: Criterion 1 — one worker, no tab, panel, follow-up, slot frees after the PR**

Use a real repo with `gh` access and a `hive.config.json` with `maxConcurrent: 1`, `claudeArgs: ["--permission-mode", "acceptEdits"]` and one small task in `Ready`. Run `hive` there.
Expected: the card goes green without any terminal tab; the panel shows `▶ …` tool lines and the assistant's text as the worker works; sending a message shows `prompt enviado` on the card; after `gh pr create` the card turns blue and, at the end of that turn, the slot empties by itself (`RESULT_LINE` is the last output line before the panel closes). `git worktree list` in the repo shows the worktree the worker used.

- [ ] **Step 2: Criterion 2 — closing the Hive ends the workers; reopening gives the slots as empty**

With one worker green (task without PR), quit the app.
Expected: `pgrep -fl -- --worktree=hive-` lists nothing within a few seconds. Run `hive` again: the slot is `vazio`, the task is back in the queue column on the board, and (signal green, slot free) a new worker starts on it.

- [ ] **Step 3: Criterion 3 — tests**

Run: `pnpm test`
Expected: all PASS (`workers` 9, `server` 8, `spawn` 7, `orchestrator` one fewer than before T1, everything else unchanged).

- [ ] **Step 4: Commit**

If fixes were needed, commit them with the results in the body; otherwise record the results in an empty commit:

```bash
git add -A
git commit --allow-empty -m "chore: embedded workers acceptance

Critério 1 (worker embutido, painel, follow-up, slot libera após PR): <pass/fail>
Critério 2 (fechar mata workers, reabrir dá slots vazios): <pass/fail>
Critério 3 (pnpm test): <pass/fail>"
```

---

## Self-review notes

**Spec coverage (section → task):**
- Decisões fechadas: `spawn('claude', argv, { cwd: repo, stdio: pipe })` (T3 `spawnWorker`, T4 `cwd: repo` tested); print mode flags (T3 `workerArgv`, tested); prompt as first `user` message with the file kept as a record (T2 pool, T4 `writePrompt` + `sent[0]` test); permissions via `claudeArgs` / repo settings (T5 hint, README); ring of 200 outside `State` (T2, tested); `POST /slots/:id/input` (T4, tested); stdin closed on `result` under `aguardando_review` (T4 `endWhenReviewed`, tested both ways); kill = SIGTERM, unknown → direct `exit` (T4, both tested); boot without `aliveSlugs` after `killStray` per slug (T1 reducer + `killStrays`, T3 rename); `close()` kills all, Electron `will-quit` (T4 tested, T5); env without `CLAUDECODE` plus the two vars (T3 tested, T4 tested on the real spawn path); focus, `spawned`, `itermSessionId`, `/hooks/exit` removed (T1, T4).
- Config: no new fields (nothing added).
- Tipos: `boot` without `aliveSlugs`, `spawned` gone, `Slot` without `itermSessionId` (T1); `WorkerHandlers` / `WorkerHandle` / `SpawnWorker` verbatim in `types.ts` (T2).
- `src/spawn.ts`: keeps `renderPrompt` / `writePrompt`; removes `shellQuote`, `workerCommand`, `openWorker`, `focusWorker`, `aliveSlugs` (T1 + T4); adds `workerArgv`, `workerEnv`, `spawnWorker`, `killStray` (T3). `userMessage` is the one addition beyond the spec's list: it is the `send()` envelope pulled out so the stdin format has a test without a process.
- `src/workers.ts`: `createWorkerPool` with `start / send / end / kill / killAll / output / has`, `formatOutput` rules (T2, 9 tests).
- `src/server.ts`: `ServerDeps.spawnWorker`, pool per `createServer`, effects, `killStray` on `configure` / `bootHive`, `close()`, two routes in, two routes out (T1, T4).
- `src/orchestrator.ts`, `src/main.ts`, UI: T1, T5.
- Testes: every listed file and case (`spawn`, `workers`, `orchestrator`, `server`); `test/fakes.ts` holds the shared fakes so `setup.test.ts` and `server.test.ts` use the same board fake.
- Critério de pronto 1–3 (T6). Fora: nothing from that list is built.

**Placeholder scan:** every code step is complete; no "add validation", "similar to", or TBD. The only `<…>` tokens are the T6 commit template results and operator-chosen paths. Line numbers refer to the files as they are at the start of the task; the later tasks describe edits by anchor text.

**Deliberate choices worth knowing:**
- `Effect` `kill` keeps its `slug` field (the spec's types leave `Effect` alone, and the orchestrator test asserts it); the server only uses `workerId` now.
- `run.ts` gets no signal handler (constraint: untouched). Killing the headless Hive closes the children's stdin, so they exit after the current turn; `killStray` on the next boot covers what is left.
- `POST /hooks/event` answers before dispatching, so in theory a `result` line could arrive before the `PostToolUse` that carries the PR URL is applied. In practice the PR hook lands many seconds before the turn's `result` (the model keeps working after `gh pr create`), so the slot is already `aguardando_review` when `endWhenReviewed` runs. If it ever races, the session simply stays open and `kill` frees the slot.
- `close()` became idempotent (`httpServer = undefined`) so Electron's `will-quit` and a test's `t.after` can both call it.

**Type consistency across tasks:**
- `SpawnWorker` (T2, `types.ts`) is what `fakeSpawn()` returns (T2), what `spawnWorker` implements (T3), and what `ServerDeps.spawnWorker` / `createWorkerPool(spawn)` take (T2, T4).
- `StartWorker.onResult(workerId)` (T2) matches `endWhenReviewed(workerId: string): void` (T4); `onExit(): void` matches `() => void dispatch(…)` (T4).
- `killStrays(state)` (T1, `server.ts`) is imported by `hive.ts` (T1) and switches from `killWorker` to `killStray` in T3 with no signature change.
- `RESULT_LINE` / `OUTPUT_LINES` (T2) are the values asserted in `workers.test.ts` (T2) and `server.test.ts` (T4).
- `fakeBoardFactory` (T4, `test/fakes.ts`) is byte-for-byte the one removed from `setup.test.ts`, so its 20-odd tests keep their behavior.
- Test deltas: T1 −2, T2 +9, T3 +3, T4 +6, T5 0 (net +16 over the current suite).
