# Agent Hive — logs persistentes e modo debug: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Hive writes one log file per repo, `<repo>/.hive/hive.log`, one `<ISO> <LEVEL> <message>` line per entry, rotated once at 5 MB (`hive.log.1`). `info` tells what the Hive did (boot, poll, slot transitions, signal, board writes, spawn/kill, errors); `debug` adds what it received (every reducer event, every `gh` call with argv and duration, quota). `logLevel: "info" | "debug"` in `hive.config.json` (default `info`) is read on boot and on every `POST /setup`, so editing the file and saving the setup form switches the level without a restart. Nothing from the worker's payloads ever reaches the file.

**Architecture:** `src/log.ts` holds `createLogger(dir, level, options?)` (synchronous `appendFileSync`, size tracked in memory, `renameSync` rotation, one stderr line and self-disable on a write failure) plus four pure helpers: `describeEvent`, `describeEffect`, `describeChanges`, `shortId`. `ServerDeps.log?: Logger` (default: real logger in `<repo>/.hive`); `dispatch` logs the event at debug, then the slot / signal transitions derived by comparing `slots` before and after `reduce` at info, then the effects at debug; `runEffect`, `fail`, `persist`, `refreshQuota`, `poll`, `activate`, `saveSetup`, `listen` and the hook route add their lines. `createBoard(config, { repo, exec?, log? })` wraps the GitHub `exec` with `loggedExec(exec, log)` so every `gh` call leaves a debug line. `src/hive.ts` creates the logger before anything else and passes it to `createServer` and `createBoard`. The reducer stays pure; `main.ts`, `run.ts`, `orchestrator.ts`, `workers.ts`, `spawn*.ts`, the UI do not change.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`, `gh` CLI (GitHub adapter only). No new runtime dependencies; the logger is `node:fs` sync calls only.

**Spec:** `docs/superpowers/specs/2026-09-17-persistent-logs-design.md` (extends `docs/superpowers/specs/2026-09-15-agent-hive-design.md`, `2026-09-16-pluggable-boards-design.md` and `2026-09-16-board-polling-design.md`). Issue: <https://github.com/dennys-bd/agent-hive/issues/30>. Plan file: `docs/superpowers/plans/2026-09-17-persistent-logs.md`.

## Global Constraints

- All v1 and setup constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts`, `run.ts`, `hooks-settings.ts`, `state-store.ts` do not change. For this feature also `orchestrator.ts`, `workers.ts`, `spawn.ts`, `spawn-*.ts`, `boards/markdown.ts`, `src/ui/*` do not change. `hooks-settings.ts` is only imported (`HIVE_DIR`).
- Every decision in the spec's "Decisões fechadas" table is closed: file location, size rotation, text format, the two levels, config-driven `logLevel` (no form field, no env var), what never enters the log, `error` also on stderr, synchronous writes, injection through `ServerDeps` / `BoardDeps`, transitions derived in `dispatch`.
- Never logged, at any level: `tool_input`, `tool_response`, Notification `message`, the worker's question / `result`, the rendered prompt, worker stdout, transcript content, the status-line JSON, env values. Only names, ids and counts.
- The new pure helpers (`describeEvent`, `describeEffect`, `describeChanges`, `shortId`) live in `src/log.ts`, not in `src/server.ts`. `src/server.ts` (549 lines) already exceeds the 400-line bullet; this plan adds only the lines the spec lists (about 15) and does not refactor it.
- `Task`, `State`, `Slot`, `HiveEvent`, `Effect`, `Board`, `SetupBody` do not change. `Config` gains `logLevel: LogLevel`.
- Files < 400 lines (`src/log.ts` included), functions < 50 lines, code comments in English, `execFile` argv arrays only (the injectable `Exec` in `src/boards/github.ts` is reused, now wrapped).
- Tests: `node:test` + `node:assert/strict` under `test/`, ESM with `.js` import extensions. In this environment run the suite as `NODE_PATH= pnpm test`: an inherited `NODE_PATH` makes `test/hive-cli.test.ts` find the real Electron and hang.
- `NODE_PATH= pnpm test` must stay green after every task (224 tests today → 238 at the end).

---

## File map

| File | Change |
|---|---|
| `src/log.ts` | new — `LogLevel`, `LOG_LEVELS`, `LOG_FILE`, `LOG_MAX_BYTES`, `Logger`, `createLogger`; `shortId`, `describeEvent`, `describeEffect`, `describeChanges` |
| `src/types.ts` | `Config.logLevel: LogLevel` |
| `src/config.ts` | `DEFAULT_CONFIG.logLevel = 'info'`; `parseConfig` reads `logLevel` ∈ `LOG_LEVELS` |
| `src/server.ts` | `ServerDeps.log?`; `dispatch` logs event / transitions / effects; `runEffect`, `poll`, `activate`, `saveSetup`, `listen`, `/hooks/event` lines; `fail`, `persist`, `refreshQuota` use `log.error`; `saveSetup` forwards `logLevel`; default `boardFactory` passes `log` |
| `src/board.ts` | `BoardDeps.log?`; GitHub `exec` wrapped with `loggedExec` |
| `src/boards/github.ts` | `loggedExec(exec, log)` |
| `src/hive.ts` | creates the logger, boot lines, passes `log` to `createServer` / `createBoard` |
| `README.md` | `logLevel` row in the config table; runtime-state line mentions `hive.log` |
| `test/log.test.ts` | new — 5 logger tests + 4 helper tests (9 tests) |
| `test/fakes.ts` | `fakeLog()` → `{ log: Logger, lines: string[] }` |
| `test/config.test.ts` | +1: `logLevel` accepted / rejected; default asserted in the defaults test (15 tests) |
| `test/server.test.ts` | +2: transitions at info, hook at debug without `tool_input`; `POST /setup` re-reads `logLevel` (16 tests) |
| `test/board.test.ts` | +1: `loggedExec` `ok` / `error:` lines, argv cut, rethrow (16 tests) |
| `test/hive.test.ts` | +1: boot lines in `.hive/hive.log` for `mode=hive` and `mode=setup` (4 tests) |

---

### Task 1: `src/log.ts` — `createLogger` with levels, rotation and the write-failure guard (TDD)

**Files:**
- Create: `src/log.ts`, `test/log.test.ts`

**Interfaces:**
- Produces (in `src/log.ts`):
  - `export type LogLevel = 'info' | 'debug'`; `export const LOG_LEVELS: readonly LogLevel[] = ['info', 'debug']`; `export const LOG_FILE = 'hive.log'`; `export const LOG_MAX_BYTES = 5 * 1024 * 1024`.
  - `export interface Logger { error(message: string): void; info(message: string): void; debug(message: string): void; setLevel(level: LogLevel): void }`
  - `export interface LoggerOptions { maxBytes?: number; stderr?: (line: string) => void }`
  - `export function createLogger(dir: string, level: LogLevel = 'info', options: LoggerOptions = {}): Logger` — `mkdirSync(dir, { recursive: true })` on creation; size = `statSync(<dir>/hive.log).size` (0 when missing); line = `${new Date().toISOString()} ${TAG.padEnd(5)} ${message}\n` (tags `ERROR`, `INFO `, `DEBUG`); before a write, if the file is not empty and `size + bytes > maxBytes` → `renameSync(hive.log, hive.log.1)`, `size = 0`; `error` always writes and calls `stderr(message)` (default `console.error`); `info` always writes; `debug` writes only at level `debug`; any fs failure (creation or write) → `stderr('hive.log: <message>')` once, `disabled = true`, later calls are no-ops on the file (`error` still reaches stderr).
- Consumed by: Task 2 (same file), Task 4 (`ServerDeps.log`), Task 5 (`BoardDeps.log`), Task 6 (`hive.ts`).

- [ ] **Step 1: Write the failing tests — `test/log.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, LOG_FILE } from '../src/log.js';

const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (ERROR|INFO |DEBUG) /;
const ISO_WIDTH = 25; // "2026-09-17T12:00:00.000Z " — what precedes the level tag
const quiet = (): void => {};

async function logDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'hive-log-')), '.hive'); // does not exist yet: the logger creates it
}

const tail = (dir: string, file = LOG_FILE): string[] =>
  readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => l.slice(ISO_WIDTH));

function stderrSpy(): { calls: string[]; stderr: (line: string) => void } {
  const calls: string[] = [];
  return { calls, stderr: (line) => { calls.push(line); } };
}

test('createLogger creates .hive/ and hive.log and writes one `<ISO> <LEVEL> <message>` line per call', async () => {
  const dir = await logDir();
  assert.equal(existsSync(dir), false);
  const log = createLogger(dir, 'info', { stderr: quiet });
  assert.equal(existsSync(dir), true, 'the directory is created on construction (setup mode has no prepareHiveDir yet)');
  log.info('poll queue=3');
  const raw = readFileSync(join(dir, LOG_FILE), 'utf8');
  assert.match(raw, LINE);
  assert.equal(raw.slice(ISO_WIDTH), 'INFO  poll queue=3\n');
});

test('info is written and debug dropped at level info; setLevel(debug) starts writing debug', async () => {
  const dir = await logDir();
  const log = createLogger(dir, 'info', { stderr: quiet });
  log.debug('hook PreToolUse worker=1a2b3c4d tool=Bash');
  log.info('boot');
  log.setLevel('debug');
  log.debug('hook PostToolUse worker=1a2b3c4d tool=Bash');
  assert.deepEqual(tail(dir), ['INFO  boot', 'DEBUG hook PostToolUse worker=1a2b3c4d tool=Bash']);
  assert.deepEqual(tail(dir), tail(dir)); // reading is stable: sync writes leave no pending data
});

test('error goes to the injected stderr and to the file, whatever the level', async () => {
  const dir = await logDir();
  const { calls, stderr } = stderrSpy();
  const log = createLogger(dir, 'info', { stderr });
  log.error('board.listQueue: gh project item-list: rate limited');
  assert.deepEqual(calls, ['board.listQueue: gh project item-list: rate limited']);
  assert.deepEqual(tail(dir), ['ERROR board.listQueue: gh project item-list: rate limited']);
});

test('past maxBytes the file becomes hive.log.1 (replacing the previous one) and a new hive.log starts; a new logger picks up the existing size', async () => {
  const dir = await logDir();
  // one line is 32 bytes + the message: "first" 37, "second" 38, "third" 37 …
  const log = createLogger(dir, 'info', { maxBytes: 100, stderr: quiet });
  log.info('first');
  log.info('second'); // 75 bytes so far
  log.info('third'); // 112 > 100: rotate before writing
  assert.deepEqual(tail(dir), ['INFO  third']);
  assert.deepEqual(tail(dir, `${LOG_FILE}.1`), ['INFO  first', 'INFO  second']);
  log.info('fourth'); // 75
  log.info('fifth'); // 112: rotate again, the old hive.log.1 is replaced
  assert.deepEqual(tail(dir), ['INFO  fifth']);
  assert.deepEqual(tail(dir, `${LOG_FILE}.1`), ['INFO  third', 'INFO  fourth']);
  const again = createLogger(dir, 'info', { maxBytes: 100, stderr: quiet }); // 37 bytes already on disk
  again.info('sixth'); // 74
  again.info('seventh'); // 113: rotates only because the size was read from the file
  assert.deepEqual(tail(dir), ['INFO  seventh']);
  assert.deepEqual(tail(dir, `${LOG_FILE}.1`), ['INFO  fifth', 'INFO  sixth']);
});

test('a write failure prints once on stderr, disables the file and never throws; error still reaches stderr', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'hive-log-')), '.hive');
  await writeFile(dir, 'not a directory'); // mkdir / append fail with EEXIST / ENOTDIR
  const { calls, stderr } = stderrSpy();
  const log = createLogger(dir, 'debug', { stderr });
  log.info('one');
  log.debug('two');
  log.info('three');
  assert.equal(calls.length, 1, 'one complaint, then silence');
  assert.match(calls[0], /^hive\.log: /);
  log.error('board.listQueue: boom');
  assert.deepEqual(calls.slice(1), ['board.listQueue: boom']);
  assert.equal(readFileSync(dir, 'utf8'), 'not a directory', 'the Hive kept running and touched nothing');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Cannot find module '../src/log.js'`.

- [ ] **Step 3: Create `src/log.ts`**

```ts
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'info' | 'debug';
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'debug'];
export const LOG_FILE = 'hive.log';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const TAG_WIDTH = 5; // ERROR / INFO  / DEBUG

export interface Logger {
  error(message: string): void; // file + stderr
  info(message: string): void; // what the Hive did
  debug(message: string): void; // what it received; written only at level debug
  setLevel(level: LogLevel): void;
}

export interface LoggerOptions {
  maxBytes?: number; // rotation threshold; tests use a small one
  stderr?: (line: string) => void; // default console.error; tests inject a spy
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** One file per repo, `<ISO> <LEVEL> <message>` per line, rotated once at `maxBytes`. Never throws: a broken disk disables the file, not the Hive. */
export function createLogger(dir: string, level: LogLevel = 'info', options: LoggerOptions = {}): Logger {
  const { maxBytes = LOG_MAX_BYTES, stderr = console.error } = options;
  const path = join(dir, LOG_FILE);
  let current = level;
  let disabled = false;
  let size = 0;

  function disable(err: unknown): void {
    disabled = true;
    stderr(`${LOG_FILE}: ${errorMessage(err)}`);
  }

  try {
    mkdirSync(dir, { recursive: true }); // setup mode has no prepareHiveDir yet
    size = fileSize(path);
  } catch (err) {
    disable(err);
  }

  // ponytail: sync appends and no queue; a few short lines per second keep order for free. Move to a write stream if the volume ever matters.
  function write(tag: string, message: string): void {
    if (disabled) return;
    const line = `${new Date().toISOString()} ${tag.padEnd(TAG_WIDTH)} ${message}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(path, `${path}.1`); // one rotation: the previous .1 is gone
        size = 0;
      }
      appendFileSync(path, line);
      size += bytes;
    } catch (err) {
      disable(err);
    }
  }

  return {
    error: (message) => {
      stderr(message); // keeps today's console.error behaviour in headless / terminal runs
      write('ERROR', message);
    },
    info: (message) => write('INFO', message),
    debug: (message) => {
      if (current === 'debug') write('DEBUG', message);
    },
    setLevel: (next) => {
      current = next;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 229 tests PASS (`log` 5).

- [ ] **Step 5: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "feat(log): file logger with levels, size rotation and a write-failure guard"
```

---

### Task 2: Pure helpers — `shortId`, `describeEvent`, `describeEffect`, `describeChanges` (TDD)

**Files:**
- Modify: `src/log.ts`
- Test: `test/log.test.ts`

**Interfaces:**
- Produces (in `src/log.ts`):
  - `export const shortId = (id?: string): string` — first 8 characters of a uuid, `-` when absent.
  - `export function describeEvent(event: HiveEvent): string` — `boot`; `poll tasks=<n> ids=<up to 20 ids, comma-separated>`; `setMax <n>`; `setSignal <signal>`; `setBudget <JSON of budget>`; `setUsageRules rules=<n>`; `rateLimits worker=<id8>`; `boardQuota remaining=<r>/<limit> resetsAt=<iso>`; `hook <hook_event_name> worker=<id8>` plus ` tool=<tool_name>` when present (never `tool_input`, `tool_response`, `message`); `exit worker=<id8>`; `idle worker=<id8>` (never the question); `kill slot=<id8>`; `error <message>` (`error` alone when there is no message).
  - `export function describeEffect(effect: Effect): string` — `spawn slot=<id8> #<taskId> slug=<slug> worker=<id8>`; `setStatus #<itemId> → <key>`; `kill slug=<slug> worker=<id8>`.
  - `export function describeChanges(prev: State, next: State): string[]` — one line per slot of `next` whose `status` differs from the slot with the same `id` in `prev`: `slot <n>: <before> → <after>` + ` #<taskId>` + ` worker=<id8>` taken from the new slot, or from the old one when it went back to `vazio` (so the line names what the slot held); `n` is the 1-based position in `next.slots`; then `signal: <before> → <after>` when the signal changed. `[]` when nothing changed.
- Slot ids are uuids (`emptySlot` → `randomUUID()` in `src/orchestrator.ts`), so a slot line reads `slot 1:` (the dashboard order) and the effects / `kill` event show `slot=<id8>`; matching between `prev` and `next` is always by `slot.id`, never by position.
- Consumed by: Task 4 (`dispatch`, `runEffect`).

- [ ] **Step 1: Write the failing tests**

Change the import line at the top of `test/log.test.ts`:

```ts
import { createLogger, describeChanges, describeEffect, describeEvent, LOG_FILE, shortId } from '../src/log.js';
import { initialState } from '../src/orchestrator.js';
import type { Slot, State, Task } from '../src/types.js';
```

Add after `const quiet = …`:

```ts
const WORKER = '1a2b3c4d-1111-4111-8111-111111111111';
const SLOT = '9f8e7d6c-2222-4222-8222-222222222222';
const task = (id: string): Task => ({ itemId: `I${id}`, id, title: 'Logs', body: 'the body is never logged', url: `https://github.com/acme/r/issues/${id}` });
```

Append at the end of the file:

```ts
test('shortId keeps the first 8 characters and shows - for a missing id', () => {
  assert.equal(shortId(WORKER), '1a2b3c4d');
  assert.equal(shortId(undefined), '-');
  assert.equal(shortId('abc'), 'abc');
});

test('describeEvent names the hook, worker and tool but never the tool_input, the response, the message or the question', () => {
  const hook = describeEvent({
    type: 'hook', workerId: WORKER,
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/acme/r/pull/9' },
  });
  assert.equal(hook, 'hook PostToolUse worker=1a2b3c4d tool=Bash');
  const notification = describeEvent({
    type: 'hook', workerId: WORKER, payload: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to run rm' },
  });
  assert.equal(notification, 'hook Notification worker=1a2b3c4d');
  assert.equal(describeEvent({ type: 'idle', workerId: WORKER, question: 'Posso apagar a pasta secrets/?' }), 'idle worker=1a2b3c4d');
});

test('describeEvent summarises every other event with names, ids and counts only', () => {
  assert.equal(describeEvent({ type: 'boot' }), 'boot');
  assert.equal(describeEvent({ type: 'poll', tasks: [task('1'), task('2')] }), 'poll tasks=2 ids=1,2');
  const ids = Array.from({ length: 25 }, (_, i) => String(i + 1));
  assert.equal(describeEvent({ type: 'poll', tasks: ids.map(task) }), `poll tasks=25 ids=${ids.slice(0, 20).join(',')}`);
  assert.equal(describeEvent({ type: 'exit', workerId: WORKER }), 'exit worker=1a2b3c4d');
  assert.equal(describeEvent({ type: 'kill', slotId: SLOT }), 'kill slot=9f8e7d6c');
  assert.equal(describeEvent({ type: 'setSignal', signal: 'red' }), 'setSignal red');
  assert.equal(describeEvent({ type: 'setMax', max: 3 }), 'setMax 3');
  assert.equal(describeEvent({ type: 'setBudget', budget: { maxTokensPerHour: 10 } }), 'setBudget {"maxTokensPerHour":10}');
  assert.equal(describeEvent({ type: 'setUsageRules', usageRules: [{ percent: 80, signal: 'yellow' }] }), 'setUsageRules rules=1');
  assert.equal(describeEvent({ type: 'rateLimits', workerId: WORKER, rateLimits: { at: '2026-09-17T12:00:00.000Z', windows: {} } }), 'rateLimits worker=1a2b3c4d');
  assert.equal(
    describeEvent({ type: 'boardQuota', quota: { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' } }),
    'boardQuota remaining=4320/5000 resetsAt=2026-09-16T13:00:00.000Z',
  );
  assert.equal(describeEvent({ type: 'error', message: 'board.listQueue: boom' }), 'error board.listQueue: boom');
  assert.equal(describeEvent({ type: 'error' }), 'error');
});

test('describeEffect: spawn, setStatus and kill', () => {
  const slot: Slot = { id: SLOT, workerId: WORKER, status: 'trabalhando', task: task('30'), slug: 'hive-30-logs' };
  assert.equal(describeEffect({ type: 'spawn', slot }), 'spawn slot=9f8e7d6c #30 slug=hive-30-logs worker=1a2b3c4d');
  assert.equal(describeEffect({ type: 'setStatus', itemId: 'PVTI_1', key: 'review' }), 'setStatus #PVTI_1 → review');
  assert.equal(describeEffect({ type: 'kill', slug: 'hive-30-logs', workerId: WORKER }), 'kill slug=hive-30-logs worker=1a2b3c4d');
});

test('describeChanges lists each slot whose status changed (position in the grid, matched by id) and the signal change; [] when nothing moved', () => {
  const empty: Slot = { id: SLOT, status: 'vazio' };
  const other: Slot = { id: 'b0b0b0b0-3333-4333-8333-333333333333', status: 'vazio' };
  const working: Slot = { ...empty, workerId: WORKER, status: 'trabalhando', task: task('30'), slug: 'hive-30-logs' };
  const prev: State = { ...initialState(0), signal: 'yellow', slots: [empty, other] };
  const next: State = { ...prev, signal: 'green', slots: [working, other] };
  assert.deepEqual(describeChanges(prev, next), ['slot 1: vazio → trabalhando #30 worker=1a2b3c4d', 'signal: yellow → green']);
  const reviewed: State = { ...next, slots: [{ ...working, status: 'aguardando_review', prUrl: 'https://github.com/acme/r/pull/9' }, other] };
  assert.deepEqual(describeChanges(next, reviewed), ['slot 1: trabalhando → aguardando_review #30 worker=1a2b3c4d']);
  const freed: State = { ...reviewed, slots: [empty, other] };
  assert.deepEqual(describeChanges(reviewed, freed), ['slot 1: aguardando_review → vazio #30 worker=1a2b3c4d'], 'an emptied slot names what it held');
  assert.deepEqual(describeChanges(next, { ...next, queue: [task('1')], lastPolledAt: '2026-09-17T12:00:00.000Z' }), []);
  assert.deepEqual(describeChanges(next, { ...next, slots: [working, other, { id: 'c0c0c0c0-4444-4444-8444-444444444444', status: 'vazio' }] }), [], 'a slot added by setMax is not a transition');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Module '"../src/log.js"' has no exported member 'describeChanges'` (and the other three).

- [ ] **Step 3: Edit `src/log.ts`**

Add to the imports:

```ts
import type { Effect, HiveEvent, Slot, State } from './types.js';
```

Add after `const TAG_WIDTH = 5;`:

```ts
const ID_WIDTH = 8; // enough of a uuid to grep for
const POLL_IDS_MAX = 20;
```

Append at the end of the file:

```ts
/** The first 8 characters of a uuid (worker or slot); `-` when the id is missing. */
export const shortId = (id?: string): string => id?.slice(0, ID_WIDTH) ?? '-';

/** A one-line summary of a reducer event: names, ids and counts, never a payload (tool_input, question, message). */
export function describeEvent(event: HiveEvent): string {
  switch (event.type) {
    case 'boot': return 'boot';
    case 'poll': return `poll tasks=${event.tasks.length} ids=${event.tasks.slice(0, POLL_IDS_MAX).map((t) => t.id).join(',')}`;
    case 'setMax': return `setMax ${event.max}`;
    case 'setSignal': return `setSignal ${event.signal}`;
    case 'setBudget': return `setBudget ${JSON.stringify(event.budget)}`;
    case 'setUsageRules': return `setUsageRules rules=${event.usageRules.length}`;
    case 'rateLimits': return `rateLimits worker=${shortId(event.workerId)}`;
    case 'boardQuota': return `boardQuota remaining=${event.quota.remaining}/${event.quota.limit} resetsAt=${event.quota.resetsAt}`;
    case 'hook': {
      const tool = event.payload.tool_name ? ` tool=${event.payload.tool_name}` : '';
      return `hook ${event.payload.hook_event_name} worker=${shortId(event.workerId)}${tool}`;
    }
    case 'exit': return `exit worker=${shortId(event.workerId)}`;
    case 'idle': return `idle worker=${shortId(event.workerId)}`;
    case 'kill': return `kill slot=${shortId(event.slotId)}`;
    case 'error': return event.message ? `error ${event.message}` : 'error';
  }
}

export function describeEffect(effect: Effect): string {
  switch (effect.type) {
    case 'spawn': {
      const { slot } = effect;
      return `spawn slot=${shortId(slot.id)} #${slot.task?.id ?? '-'} slug=${slot.slug ?? '-'} worker=${shortId(slot.workerId)}`;
    }
    case 'setStatus': return `setStatus #${effect.itemId} → ${effect.key}`;
    case 'kill': return `kill slug=${effect.slug} worker=${shortId(effect.workerId)}`;
  }
}

const slotDetail = (slot: Slot): string =>
  `${slot.task ? ` #${slot.task.id}` : ''}${slot.workerId ? ` worker=${shortId(slot.workerId)}` : ''}`;

/** Slot and signal transitions between two states: one line per slot whose status changed, in grid order, matched by id; then the signal. */
export function describeChanges(prev: State, next: State): string[] {
  const slots = next.slots.flatMap((slot, i) => {
    const before = prev.slots.find((s) => s.id === slot.id);
    if (!before || before.status === slot.status) return [];
    const detail = slotDetail(slot.status === 'vazio' ? before : slot); // an emptied slot names what it held
    return [`slot ${i + 1}: ${before.status} → ${slot.status}${detail}`];
  });
  return prev.signal === next.signal ? slots : [...slots, `signal: ${prev.signal} → ${next.signal}`];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 233 tests PASS (`log` 9).

- [ ] **Step 5: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "feat(log): describeEvent, describeEffect, describeChanges and shortId helpers"
```

---

### Task 3: `Config.logLevel` — types, parsing with default `info`, README row (TDD)

**Files:**
- Modify: `src/types.ts`, `src/config.ts`, `README.md`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `Config.logLevel: LogLevel` (type imported from `./log.js`; a type-only cycle with `log.ts` → `types.ts`, erased by `tsc`).
- Produces (in `src/config.ts`): `DEFAULT_CONFIG.logLevel = 'info'`; `parseConfig` accepts an optional `logLevel` ∈ `LOG_LEVELS`, default `'info'`, error `hive.config.json: "logLevel" must be one of: info, debug`.
- `SetupBody` does not change (the form never sends it). Consumed by: Task 4 (`activate`, `saveSetup`), Task 6 (`hive.ts`).

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, inside `parseConfig applies defaults on top of a minimal config` add after `assert.equal(config.epics, 'ignore');`:

```ts
  assert.equal(config.logLevel, 'info');
```

Append after the `parseConfig accepts epics ignore or queue…` test:

```ts
test('parseConfig accepts logLevel info or debug and rejects anything else', () => {
  assert.equal(parseConfig({ board: GITHUB, logLevel: 'debug' }).logLevel, 'debug');
  assert.equal(parseConfig({ board: GITHUB, logLevel: 'info' }).logLevel, 'info');
  assert.throws(() => parseConfig({ board: GITHUB, logLevel: 'trace' }), /"logLevel" must be one of: info, debug/);
  assert.throws(() => parseConfig({ board: GITHUB, logLevel: true }), /"logLevel" must be one of: info, debug/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Property 'logLevel' does not exist on type 'Config'`.

- [ ] **Step 3: Edit `src/types.ts`**

Add at the top of the file:

```ts
import type { LogLevel } from './log.js';
```

In `Config`, add after `epics: EpicsMode; // …`:

```ts
  logLevel: LogLevel; // info: what the Hive did; debug: also what it received. Read on boot and on every POST /setup
```

- [ ] **Step 4: Edit `src/config.ts`**

Add after the `./orchestrator.js` import:

```ts
import { LOG_LEVELS, type LogLevel } from './log.js';
```

In `DEFAULT_CONFIG` add after `epics: 'ignore',`:

```ts
  logLevel: 'info',
```

In `parseConfig`'s returned object, add after the `epics: optional(…)` entry:

```ts
    logLevel: optional(raw.logLevel, DEFAULT_CONFIG.logLevel, (v) => {
      if (!LOG_LEVELS.includes(v as LogLevel)) throw new Error(`${CONFIG_FILE}: "logLevel" must be one of: ${LOG_LEVELS.join(', ')}`);
      return v as LogLevel;
    }),
```

- [ ] **Step 5: Edit `README.md`**

In the config table, add after the `claudeArgs` row:

```md
| `logLevel` | `info` | file (`info` or `debug`; re-read on every save of the setup form, no restart needed) |
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 234 tests PASS. `test/setup.test.ts` (`{ ...DEFAULT_CONFIG, ...BODY }`) keeps passing because the written file and `DEFAULT_CONFIG` both carry `logLevel: 'info'`.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts README.md test/config.test.ts
git commit -m "feat(config): logLevel (info | debug), default info"
```

---

### Task 4: Server — `ServerDeps.log`, transitions in `dispatch`, effects, errors, config lines (TDD)

**Files:**
- Modify: `src/server.ts`, `test/fakes.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Produces (in `src/server.ts`): `ServerDeps.log?: Logger`; `const log = deps.log ?? createLogger(join(repo, HIVE_DIR))`; default `boardFactory` = `(config) => createBoard(config, { repo, log })` (compiles against today's `BoardDeps` only after Task 5 — so in this task pass `{ repo }` and switch to `{ repo, log }` in Task 5).
- `dispatch(event)`: `log.debug(describeEvent(event))` before `reduce`; after it, `log.info(line)` for each of `describeChanges(prev, next)`; `log.debug('effects: ' + effects.map(describeEffect).join('; '))` when there are effects; then `persist`, `broadcast`, effects as today.
- `runEffect`: `setStatus` → `log.info(describeEffect(effect) + ' ok')` after success (the failure goes through `fail`); `spawn` and `kill` → `log.info(describeEffect(effect))` before acting.
- `fail`: `log.error(message)` replaces `console.error(message)`. `persist`: `.catch((err: Error) => log.error(\`persist failed: ${err.message}\`))` replaces `console.error('persist failed:', err.message)`. `refreshQuota`: `log.error(\`board.quota: ${errorMessage(err)}\`)` replaces the `console.error`. No `console.error` remains in `server.ts`.
- `poll`: `log.info(\`poll queue=${tasks.length}\`)` after `listQueue`. `activate`: after `resolveFields`, `log.setLevel(effective.logLevel)` and `log.info(\`config port=${boundPort} board=${effective.board.type} workers=${effective.workers} logLevel=${effective.logLevel}\`)`. `saveSetup`: `logLevel: current?.logLevel` in the `parseConfig` call (the form never sends it; the file is re-read on every save, so a hand edit wins), `log.info('setup saved')` after `writeConfigFile`. `listen`: `log.info(\`listening port=${bound}\`)`. `POST /hooks/event` without `x-hive-worker` or without `hook_event_name`: `log.debug('hook ignored: no worker id')` / `log.debug('hook ignored: no event name')`.
- Produces (in `test/fakes.ts`): `fakeLog(): { log: Logger; lines: string[] }` — records every call as `LEVEL message` (`ERROR …`, `INFO …`, `DEBUG …`) regardless of level, and `setLevel` as `LEVEL <level>`, so a test can assert the level a message was emitted at and the level switches.
- Consumed by: Task 5 (`fakeLog` in `test/board.test.ts`), Task 6.

- [ ] **Step 1: Add `fakeLog` to `test/fakes.ts`**

Add to the imports:

```ts
import type { Logger } from '../src/log.js';
```

Append at the end of the file:

```ts
/** A Logger that writes nothing: every call becomes a `LEVEL message` line, whatever the level, and setLevel a `LEVEL <level>` line. */
export function fakeLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const at = (tag: string) => (message: string): void => {
    lines.push(`${tag} ${message}`);
  };
  return { lines, log: { error: at('ERROR'), info: at('INFO'), debug: at('DEBUG'), setLevel: at('LEVEL') } };
}
```

- [ ] **Step 2: Write the failing tests**

In `test/server.test.ts`, change the fs import and the fakes import:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
```

```ts
import type { Logger } from '../src/log.js';
import { fakeBoardFactory, fakeLog, fakeSpawn, type FakeWorker } from './fakes.js';
```

Change the `start` helper so a test can inject the log (every other test keeps the real logger writing into its tmp repo's `.hive/`):

```ts
async function start(t: TestContext, body: SetupBody = BODY, withFocus = false, log?: Logger): Promise<Started> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-server-'));
  const { spawn, workers } = fakeSpawn(withFocus);
  const server = createServer({ repo, boardFactory: fakeBoardFactory().factory, spawnWorker: spawn, log });
```

Append at the end of the file:

```ts
test('the log tells the story: slot transitions, signal and board writes at info, events at debug, and never a tool_input', async (t) => {
  const { log, lines } = fakeLog();
  const { server } = await start(t, BODY, false, log);
  const workerId = slot0(server).workerId!;
  const id8 = workerId.slice(0, 8);
  const has = (line: string): void => assert.ok(lines.includes(line), `missing "${line}" in:\n${lines.join('\n')}`);
  has('INFO signal: green → yellow'); // boot
  has('INFO poll queue=1');
  has('INFO signal: yellow → green');
  has(`INFO slot 1: vazio → trabalhando #1 worker=${id8}`);
  has('INFO setStatus #I1 → working ok');
  has(`INFO spawn slot=${slot0(server).id.slice(0, 8)} #1 slug=hive-1-from-ready worker=${id8}`);
  has('DEBUG setSignal green');
  has(`DEBUG effects: setStatus #I1 → working; spawn slot=${slot0(server).id.slice(0, 8)} #1 slug=hive-1-from-ready worker=${id8}`);
  await openPr(server, workerId);
  has(`DEBUG hook PostToolUse worker=${id8} tool=Bash`);
  has(`INFO slot 1: trabalhando → aguardando_review #1 worker=${id8}`);
  has('INFO setStatus #I1 → review ok');
  assert.ok(!lines.some((l) => l.includes('gh pr create')), 'tool_input never reaches the log');
  assert.ok(!lines.some((l) => l.includes('pull/9')), 'tool_response never reaches the log');
  assert.ok(!lines.some((l) => l.startsWith('ERROR')), lines.filter((l) => l.startsWith('ERROR')).join('\n'));
});

test('POST /setup re-reads logLevel from hive.config.json and switches the logger level without a restart', async (t) => {
  const { log, lines } = fakeLog();
  const { base, repo, port } = await start(t, BODY, false, log);
  assert.ok(lines.includes('LEVEL info'), 'the first save activates the default level');
  assert.ok(lines.includes(`INFO config port=${port} board=github workers=embedded logLevel=info`));
  assert.ok(lines.includes('INFO setup saved'));
  assert.ok(lines.includes(`INFO listening port=${port}`));
  const file = join(repo, 'hive.config.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...saved, logLevel: 'debug' })); // the hand edit the spec describes
  const { maxConcurrent: _omitted, ...formBody } = BODY; // the form re-save: no logLevel in the body
  assert.equal((await postJson(`${base}/setup`, formBody)).status, 200);
  assert.ok(lines.includes('LEVEL debug'), lines.filter((l) => l.startsWith('LEVEL')).join('\n'));
  assert.ok(lines.includes(`INFO config port=${port} board=github workers=embedded logLevel=debug`));
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as { logLevel: string }).logLevel, 'debug', 'the save keeps the level it read');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `NODE_PATH= pnpm test`
Expected: build error — `Object literal may only specify known properties, and 'log' does not exist in type 'ServerDeps'`.

- [ ] **Step 4: Edit `src/server.ts`**

Imports — add after the `./hooks-settings.js` line and extend it:

```ts
import { HIVE_DIR, prepareHiveDir } from './hooks-settings.js';
import { createLogger, describeChanges, describeEffect, describeEvent, type Logger } from './log.js';
```

In `ServerDeps`, add after `spawnWorker?: SpawnWorker; …`:

```ts
  log?: Logger; // tests inject a fake; the default writes <repo>/.hive/hive.log
```

At the top of `createServer`, replace the first two lines of the body:

```ts
  const { repo } = deps;
  const log = deps.log ?? createLogger(join(repo, HIVE_DIR));
  const boardFactory: BoardFactory = deps.boardFactory ?? ((config) => createBoard(config, { repo }));
```

(Task 5 changes the factory to `{ repo, log }` once `BoardDeps.log` exists.)

Replace `persist`'s catch:

```ts
      .catch((err: Error) => log.error(`persist failed: ${err.message}`));
```

Replace `dispatch`:

```ts
  async function dispatch(event: HiveEvent): Promise<void> {
    if (!live) return;
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
  }
```

In `fail`, replace `console.error(message);` with `log.error(message);`.

Replace the `switch` in `runEffect`:

```ts
    switch (effect.type) {
      case 'setStatus':
        await runtime.board.setStatus(effect.itemId, effect.key)
          .then(() => log.info(`${describeEffect(effect)} ok`))
          .catch((err) => fail(`board.setStatus(${effect.key})`, err));
        return;
      case 'kill':
        log.info(describeEffect(effect));
        // unknown to the pool (started by a previous Hive): nothing to signal, free the slot ourselves
        if (!pool.kill(effect.workerId)) await dispatch({ type: 'exit', workerId: effect.workerId });
        return;
      case 'spawn':
        log.info(describeEffect(effect));
        await spawn(runtime, effect.slot).catch((err) => fail(`spawn ${effect.slot.slug}`, err));
        return;
    }
```

In `poll`, add after `const tasks = await runtime.board.listQueue();`:

```ts
      log.info(`poll queue=${tasks.length}`);
```

In `refreshQuota`, replace `console.error(\`board.quota: ${errorMessage(err)}\`);` with:

```ts
      log.error(`board.quota: ${errorMessage(err)}`);
```

In `activate`, add after `await board.resolveFields();`:

```ts
    log.setLevel(effective.logLevel); // read from the file on every save: a hand edit switches the level without a restart
    log.info(`config port=${boundPort} board=${effective.board.type} workers=${effective.workers} logLevel=${effective.logLevel}`);
```

In `POST /hooks/event`, replace the `if` block:

```ts
    if (workerId && payload?.hook_event_name) {
      const branch = payload.hook_event_name === 'SessionStart' && payload.cwd ? await resolveBranch(payload.cwd) : undefined;
      const tokens = await turnTokens(workerId, payload);
      await dispatch({ type: 'hook', workerId, payload, branch, tokens });
    } else {
      log.debug(`hook ignored: ${workerId ? 'no event name' : 'no worker id'}`);
    }
```

In `saveSetup`'s `parseConfig` call, add after `epics: body.epics ?? current?.epics,`:

```ts
        logLevel: current?.logLevel, // never in the body: the file is the switch
```

In `saveSetup`, add after `await writeConfigFile(config);`:

```ts
      log.info('setup saved');
```

In `listen`, add after `boundPort = bound;`:

```ts
    log.info(`listening port=${bound}`);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 236 tests PASS (`server` 16). `grep -n console.error src/server.ts` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/fakes.ts test/server.test.ts
git commit -m "feat(server): log events, slot transitions, effects, board writes and errors to hive.log"
```

---

### Task 5: Board — `BoardDeps.log`, `loggedExec` around the GitHub `exec` (TDD)

**Files:**
- Modify: `src/boards/github.ts`, `src/board.ts`, `src/server.ts` (one line)
- Test: `test/board.test.ts`

**Interfaces:**
- Produces (in `src/boards/github.ts`): `export function loggedExec(exec: Exec, log: Logger): Exec` — measures the duration and writes `log.debug(\`gh <argv> <ms>ms ok\`)` or `log.debug(\`gh <argv> <ms>ms error: <first line of the message>\`)`, rethrowing the same error; `argv = args.join(' ')` cut at 200 characters with `…`. stdout is never logged.
- Produces (in `src/board.ts`): `BoardDeps.log?: Logger`; for `github`, `exec = deps.exec ?? ghExec`, wrapped with `loggedExec(exec, deps.log)` when `log` is present (an injected `exec` is wrapped the same way, so tests see the lines); markdown ignores `log` (`fail` already covers its errors).
- `src/server.ts`: default `boardFactory` becomes `createBoard(config, { repo, log })`.
- Consumed by: Task 6 (`hive.ts` passes `log`).

- [ ] **Step 1: Write the failing test**

In `test/board.test.ts`, add to the imports:

```ts
import { fakeLog } from './fakes.js';
```

Append at the end of the file:

```ts
test('createBoard with a log wraps the exec: every gh call leaves a debug line with the argv (cut at 200 chars), the duration and ok / error, and errors rethrow', async () => {
  const { log, lines } = fakeLog();
  const { exec } = fakeExec({ 'project field-list 6': fields, 'project item-list 6': { items: [issue(1), issue(2), issue(3)] }, 'api graphql -f': { data: {} } });
  const board = createBoard(config, { repo: REPO, exec, log });
  assert.deepEqual(await board.setupOptions(), ['Ready', 'In progress', 'In review', 'Done']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^DEBUG gh project field-list 6 --owner acme --format json \d+ms ok$/);
  assert.ok(!lines[0].includes('O_ready'), 'stdout is never logged');
  await board.listQueue(); // item-list + one long graphql query
  const graphql = lines.find((l) => l.startsWith('DEBUG gh api graphql'));
  assert.ok(graphql, lines.join('\n'));
  assert.match(graphql, /^DEBUG gh .{200}… \d+ms ok$/, 'argv cut at 200 characters');
  await assert.rejects(board.setStatus('x', 'queue'), /not resolved/); // thrown before exec: no gh line
  await assert.rejects(board.quota!(), /unexpected gh call/); // the fake rejects; the wrapper rethrows
  assert.match(lines.at(-1)!, /^DEBUG gh api rate_limit --jq \.resources\.graphql \d+ms error: unexpected gh call: api rate_limit --jq \.resources\.graphql$/);
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.startsWith('DEBUG ')), 'gh calls are debug only');
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `NODE_PATH= pnpm test`
Expected: build error — `'log' does not exist in type 'BoardDeps'`.

- [ ] **Step 3: Edit `src/boards/github.ts`**

Add to the imports:

```ts
import type { Logger } from '../log.js';
```

Add after `const MS_PER_SECOND = 1000;`:

```ts
const ARGV_MAX = 200; // the GraphQL query is long; the head names the call, the rest is noise
```

Insert after `ghExec`:

```ts
const cutArgv = (args: string[]): string => {
  const argv = args.join(' ');
  return argv.length > ARGV_MAX ? `${argv.slice(0, ARGV_MAX)}…` : argv;
};

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];

/** Wraps a gh runner so every call leaves a debug line with argv and duration; stdout is never logged, errors rethrow untouched. */
export function loggedExec(exec: Exec, log: Logger): Exec {
  return async (args) => {
    const argv = cutArgv(args);
    const started = Date.now();
    try {
      const stdout = await exec(args);
      log.debug(`gh ${argv} ${Date.now() - started}ms ok`);
      return stdout;
    } catch (err) {
      log.debug(`gh ${argv} ${Date.now() - started}ms error: ${firstLine(err)}`);
      throw err;
    }
  };
}
```

- [ ] **Step 4: Rewrite `src/board.ts`**

```ts
import { createGithubBoard, ghExec, loggedExec, type Exec } from './boards/github.js';
import { createMarkdownBoard, markdownPath } from './boards/markdown.js';
import type { Logger } from './log.js';
import type { Board, Config } from './types.js';

export interface BoardDeps {
  repo: string; // markdown resolves a relative path against it; github ignores it
  exec?: Exec; // gh runner, injectable for tests
  log?: Logger; // github: every gh call is logged at debug; markdown has nothing to log beyond what the server's fail covers
}

export function createBoard(config: Config, deps: BoardDeps): Board {
  const { board, status, epics } = config;
  switch (board.type) {
    case 'github': {
      const exec = deps.exec ?? ghExec;
      return createGithubBoard(board, status, epics, deps.log ? loggedExec(exec, deps.log) : exec);
    }
    case 'markdown':
      return createMarkdownBoard(markdownPath(deps.repo, board.path), status);
  }
}
```

- [ ] **Step 5: Edit `src/server.ts`**

```ts
  const boardFactory: BoardFactory = deps.boardFactory ?? ((config) => createBoard(config, { repo, log }));
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 237 tests PASS (`board` 16). The existing board tests pass no `log`, so their `exec` stays unwrapped and their `calls` assertions are unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/boards/github.ts src/board.ts src/server.ts test/board.test.ts
git commit -m "feat(github): log every gh call with argv and duration at debug"
```

---

### Task 6: `hive.ts` — logger created on boot, boot lines; README runtime-state line (TDD)

**Files:**
- Modify: `src/hive.ts`, `README.md`
- Test: `test/hive.test.ts`

**Interfaces:**
- `bootHive(repo)`: `const log = createLogger(join(repo, HIVE_DIR), config?.logLevel ?? 'info')` right after `loadConfigIfPresent` (a config file that fails to parse still throws before any logger, as today: `run.ts` / `main.ts` own that error); `createBoard(config, { repo, log })`; on the fallback, `log.error(\`board: ${message}\`)` before `bootSetupMode`; `log.info(\`boot repo=${repo} mode=hive\`)` once the board resolved; `createServer({ …, log })`.
- `bootSetupMode(repo, log, setupFallback?)`: `log.info(\`boot repo=${repo} mode=setup reason=${setupFallback?.error ?? 'no hive.config.json'}\`)`; `createServer({ repo, setupFallback, log })`. Today's `console.log` lines stay (the terminal needs the URL).
- `listening port=<n>` and `poll queue=<n>` come from the server (Task 4).

- [ ] **Step 1: Write the failing test**

In `test/hive.test.ts`, change the fs import:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
```

Append at the end of the file:

```ts
const logLines = async (repo: string): Promise<string[]> =>
  (await readFile(join(repo, '.hive', 'hive.log'), 'utf8')).split('\n').filter(Boolean).map((l) => l.slice(25)); // drop the ISO stamp

test('bootHive writes the boot to <repo>/.hive/hive.log: mode=hive with a usable board, mode=setup with the reason when it is not', async (t) => {
  const repo = await repoWithConfig({});
  const hive = await bootHive(repo);
  t.after(() => hive.server.close());
  const lines = await logLines(repo);
  assert.ok(lines.includes(`INFO  boot repo=${repo} mode=hive`), lines.join('\n'));
  assert.ok(lines.includes(`INFO  listening port=${hive.port}`));
  assert.ok(lines.includes('INFO  poll queue=1'));
  assert.ok(!lines.some((l) => l.startsWith('DEBUG')), 'default level is info');

  const broken = await repoWithConfig({ logLevel: 'debug' });
  await rm(join(broken, 'board.md'));
  const setup = await bootHive(broken); // prints the board error on stderr too, as the spec wants for error
  t.after(() => setup.server.close());
  const setupLines = await logLines(broken);
  assert.ok(setupLines.some((l) => l.startsWith('ERROR board: ') && l.includes('board.md não existe')), setupLines.join('\n'));
  assert.ok(setupLines.some((l) => l.startsWith(`INFO  boot repo=${broken} mode=setup reason=`) && l.includes('board.md não existe')));
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `NODE_PATH= pnpm test`
Expected: the new test fails with `ENOENT … .hive/hive.log` on the first `logLines` (the server's default logger only exists inside `createServer`, and `bootHive` with a runtime never calls `activate`; nothing writes `boot …` yet). If the file exists because the server logged `listening`, the `boot repo=` assertion fails instead.

- [ ] **Step 3: Edit `src/hive.ts`**

Imports:

```ts
import { join } from 'node:path';
import { createBoard } from './board.js';
import { DEFAULT_CONFIG, loadConfigIfPresent } from './config.js';
import { HIVE_DIR, prepareHiveDir } from './hooks-settings.js';
import { createLogger, type Logger } from './log.js';
import { createServer, killStrays, type HiveServer, type ServerDeps } from './server.js';
import { loadState } from './state-store.js';
```

Replace `bootHive`:

```ts
export async function bootHive(repo: string): Promise<BootedHive> {
  const config = await loadConfigIfPresent(repo);
  const log = createLogger(join(repo, HIVE_DIR), config?.logLevel ?? 'info'); // before anything else: setup mode logs too
  if (!config) return bootSetupMode(repo, log);
  const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, config.port);
  const board = createBoard(config, { repo, log });
  try {
    await board.resolveFields();
  } catch (err) {
    // A saved config whose board is gone (file deleted, project removed) must not kill the app: reopen the setup form with the reason.
    const error = (err as Error).message;
    log.error(`board: ${error}`);
    return bootSetupMode(repo, log, { config, error });
  }
  log.info(`boot repo=${repo} mode=hive`);
  // state.json carries a copy of the budget; the config file is the source, so a hand edit wins on boot
  const saved = { ...(await loadState(hiveDir, config.maxConcurrent)), budget: config.budget, usageRules: config.usageRules };
  const server = createServer({ repo, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state: saved, log });
  const port = await server.listen(config.port);
  await killStrays(saved);
  await server.dispatch({ type: 'boot' });
  await server.poll();
  console.log(`Agent Hive em http://127.0.0.1:${port} (repo: ${repo})`);
  return { port, server };
}
```

Replace `bootSetupMode`:

```ts
// No hive.config.json (or one whose board cannot be read): serve only the setup form; POST /setup finishes the boot in place.
async function bootSetupMode(repo: string, log: Logger, setupFallback?: ServerDeps['setupFallback']): Promise<BootedHive> {
  log.info(`boot repo=${repo} mode=setup reason=${setupFallback?.error ?? 'no hive.config.json'}`);
  const server = createServer({ repo, setupFallback, log });
  const port = await server.listen(setupFallback?.config.port ?? DEFAULT_CONFIG.port);
  console.log(`Agent Hive em modo setup em http://127.0.0.1:${port} (repo: ${repo}, ${setupFallback?.error ?? 'sem hive.config.json'})`);
  return { port, server };
}
```

- [ ] **Step 4: Edit `README.md`**

Replace the runtime-state sentence:

```md
Older files with `project: { owner, number }` are still accepted. Runtime state lives in `<repo>/.hive/` (kept out of git through `.git/info/exclude`), including `hive.log`: one line per thing the Hive did (`tail -f .hive/hive.log`), rotated once at 5 MB into `hive.log.1`; `logLevel: "debug"` adds every hook event and every `gh` call.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_PATH= pnpm test`
Expected: 238 tests PASS (`hive` 4). The fallback half of the new test prints one `board: …` line on stderr (the logger's `error` path), which is the behaviour the spec asks for.

- [ ] **Step 6: Commit**

```bash
git add src/hive.ts README.md test/hive.test.ts
git commit -m "feat(hive): create the logger on boot and record the boot lines"
```

---

## Verification

- `NODE_PATH= pnpm test` green: 238 tests (224 before; `log` 9, `config` 15, `server` 16, `board` 16, `hive` 4). `grep -rn console.error src/server.ts src/hive.ts` prints nothing.
- Manual, headless: `pnpm run:headless /path/to/configured-repo` in one terminal and `tail -f /path/to/configured-repo/.hive/hive.log` in another. Expected on boot: `INFO  boot repo=… mode=hive`, `INFO  listening port=47821`, `INFO  poll queue=<n>`, `INFO  signal: green → yellow` (or nothing when it was already yellow / red). Set the signal to green in the dashboard: `INFO  signal: yellow → green`, then per spawned task `INFO  slot 1: vazio → trabalhando #<id> worker=<id8>`, `INFO  setStatus #<itemId> → working ok`, `INFO  spawn slot=… #<id> slug=… worker=…`. No `DEBUG` line, no hook payloads, no prompt text. A failing `gh` shows as `ERROR board.listQueue: gh …` in the file and on the terminal.
- Manual, debug mode: with the Hive running, edit `hive.config.json` to `"logLevel": "debug"` and save the setup form (`configurar` → `salvar`, no field changed). Expected: `INFO  setup saved`, `INFO  config port=… board=github workers=… logLevel=debug`, and from then on `DEBUG hook PreToolUse worker=… tool=Bash`, `DEBUG gh project item-list 6 --owner … 812ms ok`, `DEBUG effects: …`, `DEBUG boardQuota remaining=…/… resetsAt=…`. Check with `grep -c tool_input .hive/hive.log` → `0`. Set it back to `"info"`, save again: the `DEBUG` lines stop.
- Manual, setup mode: `pnpm run:headless /tmp/empty-repo` (no `hive.config.json`): `.hive/hive.log` is created with `INFO  boot repo=/tmp/empty-repo mode=setup reason=no hive.config.json` and `INFO  listening port=47821`.
- Rotation (optional): `logLevel: debug` for a day, or `truncate -s 5M .hive/hive.log` and trigger one poll (`atualizar`): `hive.log.1` appears with the old content and `hive.log` restarts.

## Notes

- `slot <n>` in a transition line is the 1-based position in `State.slots` (the dashboard order) because slot ids are uuids (`emptySlot` → `randomUUID()`); matching between the previous and the next state is by `slot.id`. Effects and the `kill` event show `slot=<id8>` since they carry no state.
- `src/server.ts` (549 lines) already exceeds the 400-line bullet; this plan adds about 15 lines to it and no refactor. All new logic lives in `src/log.ts` (about 130 lines) and `src/boards/github.ts` (about 20).
- The `ponytail:` comment in `createLogger` names the ceiling: synchronous appends with no queue; a write stream is the upgrade if the volume ever matters.
- Deliberate simplifications: no `notification_type` in the hook line (the spec lists only the event name and the tool); no log line for `/hooks/exit` / `/hooks/status` without a worker id (a status line without `rate_limits` is normal traffic); `describeChanges` uses `find` per slot (n ≤ `maxConcurrent`); the level filter is tested against the real logger in `test/log.test.ts` while the server tests use `fakeLog`, which records every call with its level prefix.
