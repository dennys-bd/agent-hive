# Agent Hive v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Electron dashboard that keeps up to `maxConcurrent` interactive Claude Code sessions running in iTerm2 tabs (one git worktree each), pulling tasks from a GitHub Projects v2 board and showing live per-worker status fed by Claude Code hooks.

**Architecture:** A pure reducer (`orchestrator.ts`) owns all state transitions and emits effects; `server.ts` (Express) receives hook calls on `POST /hooks/event`, runs the reducer, executes effects (spawn via osascript, board updates via `gh`), persists `.hive/state.json` and pushes the whole state over SSE. The UI is a single HTML page served by that same server; Electron is only the window.

**Tech Stack:** Node 24, pnpm, TypeScript (`tsc` only, ESM `nodenext`), Electron, Express, `node --test`, `gh` CLI, `osascript`/iTerm2.

**Spec:** `docs/superpowers/specs/2026-09-15-agent-hive-design.md`

## Global Constraints

- Nothing from the developer's machine is hardcoded: board owner/number, Status option names, port, terminal, repo path all come from `hive.config.json` or defaults. The `gonext` project (`@me` / number 6) is only a manual-test fixture.
- Product name is **Agent Hive**; identifiers use `hive` (`hive.config.json`, `.hive/`, `HIVE_WORKER_ID`, `HIVE_PORT`). Never "Fleet".
- TypeScript `strict`, ESM (`"type": "module"`, `module: nodenext`), imports use `.js` extensions. No bundler, no test framework beyond `node:test`.
- Immutable state: the reducer never mutates its input; every transition returns new objects.
- External processes always via `execFile` with an argv array (no shell string), except the command line typed into the iTerm tab, which is intentionally a shell string.
- Hook `curl` commands must end with `; exit 0` and use `-m 2` so a dead Hive never blocks a worker.
- Worker id == slot id (a UUID). `HIVE_WORKER_ID` carries it; the server reads it from the `x-hive-worker` header.
- Default status names: `queue: "Ready"`, `working: "In progress"`, `review: "In review"`; default `maxConcurrent: 2`; default `port: 47821`.
- Commit after every task with conventional commits (`feat:`, `test:`, `chore:`), no `Co-Authored-By`.
- All UI copy in Portuguese (matches the spec: `vazio`, `trabalhando`, `esperando_voce`, `aguardando_review`, "workers ativos", "atualizar board", "ir pro terminal").

---

## File map

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore` | toolchain |
| `src/types.ts` | shared types: `State`, `Slot`, `Task`, `Config`, `HookPayload`, `HiveEvent`, `Effect` |
| `src/orchestrator.ts` | pure reducer + `fill`, `slugFor`, `extractPrUrl` |
| `src/config.ts` | load/validate `hive.config.json` with defaults |
| `src/hooks-settings.ts` | render `hooks.json`, create `.hive/`, exclude it from git |
| `src/board.ts` | `gh project` wrapper: `resolveFields`, `listQueue`, `setStatus` |
| `src/spawn.ts` | prompt file, iTerm2 tab command, focus, kill, liveness |
| `src/state-store.ts` | load/save `.hive/state.json` atomically |
| `src/server.ts` | Express routes, effect runner, SSE, polling |
| `src/hive.ts` | `bootHive(repo)`: wires config → board → state → server |
| `src/run.ts` | headless runner (`node dist/src/run.js <repo>`) for manual testing |
| `src/main.ts` | Electron window |
| `src/ui/index.html`, `src/ui/app.ts` | dashboard |
| `test/*.test.ts` | `node --test` |

Build layout: `rootDir: "."`, `outDir: "dist"` → `dist/src/**`, `dist/test/**`; `index.html` is copied to `dist/src/ui/`.

---

### Task 1: Scaffold and shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`, `src/main.ts` (placeholder, replaced in Task 9), `src/ui/index.html` (placeholder, replaced in Task 8)

**Interfaces:**
- Produces: every type below; all later tasks import from `./types.js`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "agent-hive",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/src/main.js",
  "scripts": {
    "build": "tsc && mkdir -p dist/src/ui && cp src/ui/index.html dist/src/ui/",
    "test": "pnpm build && node --test dist/test/",
    "start": "pnpm build && electron dist/src/main.js",
    "run:headless": "pnpm build && node dist/src/run.js"
  },
  "dependencies": {
    "express": "^5.1.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^24.0.0",
    "electron": "^38.0.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2022", "dom"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules
dist
.hive
```

- [ ] **Step 4: Create `src/types.ts`**

```ts
export type Status = 'vazio' | 'trabalhando' | 'esperando_voce' | 'aguardando_review';
export type StatusKey = 'queue' | 'working' | 'review';

export interface Task {
  itemId: string;
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface Slot {
  id: string;
  status: Status;
  draining?: boolean;
  task?: Task;
  slug?: string;
  worktree?: string;
  branch?: string;
  itermSessionId?: string;
  startedAt?: string;
  lastEvent?: string;
  prUrl?: string;
  question?: string;
}

export interface State {
  maxConcurrent: number;
  slots: Slot[];
  queue: Task[];
  lastPolledAt?: string;
  error?: string;
}

export interface Config {
  project: { owner: string; number: number };
  status: Record<StatusKey, string>;
  maxConcurrent: number;
  port: number;
  claudeArgs: string[];
  promptTemplate: string;
}

export interface HookPayload {
  hook_event_name: string;
  cwd?: string;
  notification_type?: string;
  message?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

export type HiveEvent =
  | { type: 'boot'; aliveSlugs: string[] }
  | { type: 'poll'; tasks: Task[] }
  | { type: 'setMax'; max: number }
  | { type: 'hook'; workerId: string; payload: HookPayload; branch?: string }
  | { type: 'exit'; workerId: string }
  | { type: 'kill'; slotId: string }
  | { type: 'spawned'; slotId: string; itermSessionId: string }
  | { type: 'error'; message?: string };

export type Effect =
  | { type: 'spawn'; slot: Slot }
  | { type: 'setStatus'; itemId: string; key: StatusKey }
  | { type: 'kill'; slug: string };
```

- [ ] **Step 5: Create placeholders**

`src/main.ts`:
```ts
import type { State } from './types.js';
export const placeholder: State | undefined = undefined;
```

`src/ui/index.html`:
```html
<!doctype html><title>Agent Hive</title>
```

- [ ] **Step 6: Install and build**

Run: `pnpm install && pnpm build`
Expected: exit 0; `dist/src/types.js` and `dist/src/ui/index.html` exist.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json .gitignore src/types.ts src/main.ts src/ui/index.html
git commit -m "chore: scaffold agent-hive with typescript and shared types"
```

---

### Task 2: Pure orchestrator (TDD)

**Files:**
- Create: `src/orchestrator.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `types.ts`.
- Produces:
  - `initialState(maxConcurrent: number): State`
  - `reduce(state: State, event: HiveEvent): { state: State; effects: Effect[] }`
  - `slugFor(task: Task): string`
  - `extractPrUrl(command: string, response: unknown): string | undefined`
  - `WAITING_NOTIFICATIONS: readonly string[]`

- [ ] **Step 1: Write the failing tests**

`test/orchestrator.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrUrl, initialState, reduce, slugFor } from '../src/orchestrator.js';
import type { HookPayload, State, Task } from '../src/types.js';

const task = (n: number): Task => ({
  itemId: `item${n}`, number: n, title: `Task ${n}`, body: `body ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
});
const tasks = (n: number) => Array.from({ length: n }, (_, i) => task(i + 1));
const filled = (max: number, n: number) => reduce(initialState(max), { type: 'poll', tasks: tasks(n) });
const hook = (state: State, workerId: string, payload: Partial<HookPayload> & { hook_event_name: string }) =>
  reduce(state, { type: 'hook', workerId, payload });
const occupied = (s: State) => s.slots.filter((x) => x.status !== 'vazio');

test('poll fills slots in board order up to maxConcurrent and queues the rest', () => {
  const { state, effects } = filled(3, 5);
  assert.deepEqual(occupied(state).map((s) => s.task?.number), [1, 2, 3]);
  assert.deepEqual(state.queue.map((t) => t.number), [4, 5]);
  assert.equal(effects.filter((e) => e.type === 'spawn').length, 3);
  assert.deepEqual(
    effects.flatMap((e) => (e.type === 'setStatus' ? [e.key] : [])),
    ['working', 'working', 'working'],
  );
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(state.slots[0].slug, 'hive-1-task-1');
  assert.ok(state.slots[0].startedAt);
});

test('poll does not duplicate a task already in a slot', () => {
  const first = filled(1, 2).state;
  const { state, effects } = reduce(first, { type: 'poll', tasks: tasks(2) });
  assert.deepEqual(state.queue.map((t) => t.number), [2]);
  assert.equal(effects.length, 0);
});

test('reducer never mutates its input', () => {
  const before = initialState(2);
  const snapshot = JSON.stringify(before);
  reduce(before, { type: 'poll', tasks: tasks(3) });
  assert.equal(JSON.stringify(before), snapshot);
});

test('setMax up adds empty slots and fills them from the queue', () => {
  const first = filled(1, 3).state;
  const { state, effects } = reduce(first, { type: 'setMax', max: 2 });
  assert.equal(state.maxConcurrent, 2);
  assert.equal(occupied(state).length, 2);
  assert.deepEqual(state.queue.map((t) => t.number), [3]);
  assert.equal(effects.filter((e) => e.type === 'spawn').length, 1);
});

test('setMax down marks extra occupied slots as draining instead of killing them', () => {
  const first = filled(3, 3).state;
  const { state, effects } = reduce(first, { type: 'setMax', max: 1 });
  assert.equal(effects.length, 0);
  assert.equal(state.slots.length, 3);
  assert.ok(!state.slots[0].draining);
  assert.equal(state.slots[1].draining, true);
  assert.equal(state.slots[2].draining, true);
  assert.equal(state.slots[1].status, 'trabalhando');
});

test('a draining slot is removed when its worker exits and its task returns to the queue', () => {
  const drained = reduce(filled(3, 3).state, { type: 'setMax', max: 1 }).state;
  const { state, effects } = reduce(drained, { type: 'exit', workerId: drained.slots[1].id });
  assert.equal(state.slots.length, 2);
  assert.deepEqual(state.queue.map((t) => t.number), [2]);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item2', key: 'queue' }]);
});

test('setMax down drops surplus empty slots', () => {
  const { state } = reduce(initialState(3), { type: 'setMax', max: 1 });
  assert.equal(state.slots.length, 1);
});

test('SessionStart records worktree and branch', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].id;
  const { state } = reduce(first, {
    type: 'hook', workerId: id, branch: 'hive-1-task-1',
    payload: { hook_event_name: 'SessionStart', cwd: '/repo/.claude/worktrees/hive-1-task-1' },
  });
  assert.equal(state.slots[0].worktree, '/repo/.claude/worktrees/hive-1-task-1');
  assert.equal(state.slots[0].branch, 'hive-1-task-1');
});

test('Notification of a waiting type turns the slot yellow with the message', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].id, {
    hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?',
  });
  assert.equal(state.slots[0].status, 'esperando_voce');
  assert.equal(state.slots[0].question, 'Allow Bash?');
});

test('Notification of a non-waiting type is ignored', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].id, {
    hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok',
  });
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(state.slots[0].question, undefined);
});

test('UserPromptSubmit and PreToolUse bring a yellow slot back to trabalhando and clear the question', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].id;
  const yellow = hook(first, id, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'idle' }).state;
  const green = hook(yellow, id, { hook_event_name: 'UserPromptSubmit' }).state;
  assert.equal(green.slots[0].status, 'trabalhando');
  assert.equal(green.slots[0].question, undefined);
  const yellowAgain = hook(green, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state;
  const tool = hook(yellowAgain, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } }).state;
  assert.equal(tool.slots[0].status, 'trabalhando');
  assert.equal(tool.slots[0].lastEvent, 'Bash: pnpm test');
});

test('PostToolUse with gh pr create moves the slot to aguardando_review and the board item to review', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].id;
  const { state, effects } = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'gh pr create --fill' },
    tool_response: { stdout: 'Creating pull request\nhttps://github.com/o/r/pull/42\n', stderr: '' },
  });
  assert.equal(state.slots[0].status, 'aguardando_review');
  assert.equal(state.slots[0].prUrl, 'https://github.com/o/r/pull/42');
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item1', key: 'review' }]);
});

test('after a PR, a permission prompt answered returns the slot to aguardando_review, not trabalhando', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].id;
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/7',
  }).state;
  const yellow = hook(reviewed, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state;
  assert.equal(yellow.slots[0].status, 'esperando_voce');
  const back = hook(yellow, id, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).state;
  assert.equal(back.slots[0].status, 'aguardando_review');
});

test('PostToolUse for other commands changes nothing', () => {
  const first = filled(1, 1).state;
  const { state, effects } = hook(first, first.slots[0].id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'git status' }, tool_response: 'clean',
  });
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(effects.length, 0);
});

test('Stop only updates lastEvent', () => {
  const first = filled(1, 1).state;
  const { state, effects } = hook(first, first.slots[0].id, { hook_event_name: 'Stop' });
  assert.equal(state.slots[0].status, 'trabalhando');
  assert.equal(state.slots[0].lastEvent, 'turno encerrado');
  assert.equal(effects.length, 0);
});

test('exit without PR empties the slot, requeues the task at the end and pulls the next one', () => {
  const first = filled(1, 2).state;
  const id = first.slots[0].id;
  const { state, effects } = reduce(first, { type: 'exit', workerId: id });
  assert.equal(state.slots[0].id, id, 'slot keeps its id');
  assert.equal(state.slots[0].task?.number, 2, 'next task pulled');
  assert.deepEqual(state.queue.map((t) => t.number), [1]);
  assert.deepEqual(effects.map((e) => e.type), ['setStatus', 'setStatus', 'spawn']);
  assert.deepEqual(effects[0], { type: 'setStatus', itemId: 'item1', key: 'queue' });
});

test('exit with PR does not requeue the task', () => {
  const first = filled(1, 1).state;
  const id = first.slots[0].id;
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/1',
  }).state;
  const { state, effects } = reduce(reviewed, { type: 'exit', workerId: id });
  assert.equal(state.slots[0].status, 'vazio');
  assert.equal(state.queue.length, 0);
  assert.equal(effects.length, 0);
});

test('SessionEnd behaves like exit', () => {
  const first = filled(1, 1).state;
  const { state } = hook(first, first.slots[0].id, { hook_event_name: 'SessionEnd' });
  assert.equal(state.slots[0].status, 'vazio');
});

test('exit is idempotent and ignores unknown workers', () => {
  // use a slot with a PR so exit does not requeue (and fill does not immediately respawn) the task
  const first = filled(1, 1).state;
  const id = first.slots[0].id;
  const reviewed = hook(first, id, {
    hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create' }, tool_response: 'https://github.com/o/r/pull/1',
  }).state;
  const once = reduce(reviewed, { type: 'exit', workerId: id }).state;
  const twice = reduce(once, { type: 'exit', workerId: id });
  assert.deepEqual(twice.state, once);
  assert.equal(twice.effects.length, 0);
  const unknown = reduce(first, { type: 'exit', workerId: 'nope' });
  assert.deepEqual(unknown.state, first);
});

test('hook for an empty or unknown slot is ignored', () => {
  const s = initialState(1);
  const { state, effects } = hook(s, s.slots[0].id, { hook_event_name: 'Stop' });
  assert.deepEqual(state, s);
  assert.equal(effects.length, 0);
});

test('boot empties slots whose worker is dead and requeues their tasks; alive ones stay', () => {
  const first = filled(2, 2).state;
  const { state, effects } = reduce(first, { type: 'boot', aliveSlugs: ['hive-2-task-2'] });
  assert.equal(state.slots[0].status, 'vazio');
  assert.equal(state.slots[1].task?.number, 2);
  assert.deepEqual(state.queue.map((t) => t.number), [1]);
  assert.deepEqual(effects, [{ type: 'setStatus', itemId: 'item1', key: 'queue' }]);
});

test('kill emits a kill effect for the slot slug', () => {
  const first = filled(1, 1).state;
  const { effects } = reduce(first, { type: 'kill', slotId: first.slots[0].id });
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1' }]);
});

test('spawned stores the iTerm session id', () => {
  const first = filled(1, 1).state;
  const { state } = reduce(first, { type: 'spawned', slotId: first.slots[0].id, itermSessionId: 'w0t1p0' });
  assert.equal(state.slots[0].itermSessionId, 'w0t1p0');
});

test('error sets and poll clears state.error', () => {
  const withError = reduce(initialState(1), { type: 'error', message: 'gh: boom' }).state;
  assert.equal(withError.error, 'gh: boom');
  const cleared = reduce(withError, { type: 'poll', tasks: [] }).state;
  assert.equal(cleared.error, undefined);
  assert.ok(cleared.lastPolledAt);
});

test('slugFor strips accents, lowercases, and caps the title at 30 chars', () => {
  assert.equal(slugFor({ ...task(12), title: 'Adicionar Autenticação OAuth no backend da API v2' }), 'hive-12-adicionar-autenticacao-oauth-n');
  assert.equal(slugFor({ ...task(3), title: '  --weird__title!!  ' }), 'hive-3-weird-title');
});

test('extractPrUrl finds the PR url only for gh pr create', () => {
  assert.equal(extractPrUrl('gh pr create --fill', 'https://github.com/a/b/pull/9\n'), 'https://github.com/a/b/pull/9');
  assert.equal(extractPrUrl('gh pr create', { stdout: 'x https://github.com/a/b-c/pull/10 y' }), 'https://github.com/a/b-c/pull/10');
  assert.equal(extractPrUrl('gh pr view', 'https://github.com/a/b/pull/9'), undefined);
  assert.equal(extractPrUrl('gh pr create', 'error: not logged in'), undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build fails with `Cannot find module '../src/orchestrator.js'`.

- [ ] **Step 3: Implement `src/orchestrator.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Effect, HiveEvent, HookPayload, Slot, State, Status, Task } from './types.js';

export interface Reduced {
  state: State;
  effects: Effect[];
}

export const WAITING_NOTIFICATIONS: readonly string[] = [
  'permission_prompt', 'idle_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog',
];
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const SLUG_MAX = 30;

export function initialState(maxConcurrent: number): State {
  return { maxConcurrent, slots: Array.from({ length: maxConcurrent }, emptySlot), queue: [] };
}

export function slugFor(task: Task): string {
  const kebab = task.title
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX).replace(/-+$/, '');
  return `hive-${task.number}-${kebab}`;
}

export function extractPrUrl(command: string, response: unknown): string | undefined {
  if (!command.includes('gh pr create')) return undefined;
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return text.match(PR_URL)?.[0];
}

export function reduce(state: State, event: HiveEvent): Reduced {
  switch (event.type) {
    case 'boot': return boot(state, event.aliveSlugs); // no fill: bootHive polls right after, and the board is the truth
    case 'poll': return fill(poll(state, event.tasks));
    case 'setMax': return fill(setMax(state, event.max));
    case 'hook': return applyHook(state, event.workerId, event.payload, event.branch);
    case 'exit': return fill(exit(state, event.workerId));
    case 'kill': {
      const slug = state.slots.find((s) => s.id === event.slotId)?.slug;
      return { state, effects: slug ? [{ type: 'kill', slug }] : [] };
    }
    case 'spawned': return patch(state, event.slotId, { itermSessionId: event.itermSessionId });
    case 'error': return { state: { ...state, error: event.message }, effects: [] };
  }
}

function emptySlot(): Slot {
  return { id: randomUUID(), status: 'vazio' };
}

function none(state: State): Reduced {
  return { state, effects: [] };
}

function patch(state: State, slotId: string, changes: Partial<Slot>): Reduced {
  return none({ ...state, slots: state.slots.map((s) => (s.id === slotId ? { ...s, ...changes } : s)) });
}

function fill({ state, effects }: Reduced): Reduced {
  let queue = state.queue;
  const spawned: Effect[] = [];
  const slots = state.slots.map((slot) => {
    if (slot.status !== 'vazio' || slot.draining || queue.length === 0) return slot;
    const [task, ...rest] = queue;
    queue = rest;
    const next: Slot = {
      id: slot.id, status: 'trabalhando', task, slug: slugFor(task),
      startedAt: new Date().toISOString(), lastEvent: 'iniciando',
    };
    spawned.push({ type: 'setStatus', itemId: task.itemId, key: 'working' }, { type: 'spawn', slot: next });
    return next;
  });
  return { state: { ...state, slots, queue }, effects: [...effects, ...spawned] };
}

function poll(state: State, tasks: Task[]): Reduced {
  const inSlot = new Set(state.slots.map((s) => s.task?.itemId));
  return none({
    ...state, queue: tasks.filter((t) => !inSlot.has(t.itemId)),
    lastPolledAt: new Date().toISOString(), error: undefined,
  });
}

function setMax(state: State, max: number): Reduced {
  const occupiedCount = state.slots.filter((s) => s.status !== 'vazio').length;
  const room = Math.max(0, max - occupiedCount);
  let occupiedSeen = 0;
  let emptyKept = 0;
  const kept = state.slots.flatMap<Slot>((s) => {
    if (s.status !== 'vazio') {
      const draining = occupiedSeen++ >= max;
      return [draining ? { ...s, draining: true } : { ...s, draining: undefined }];
    }
    if (emptyKept >= room) return [];
    emptyKept += 1;
    return [s];
  });
  const extra = Array.from({ length: room - emptyKept }, emptySlot);
  return none({ ...state, maxConcurrent: max, slots: [...kept, ...extra] });
}

function exit(state: State, workerId: string): Reduced {
  const slot = state.slots.find((s) => s.id === workerId);
  if (!slot || slot.status === 'vazio') return none(state);
  const requeue = slot.task && !slot.prUrl ? slot.task : undefined;
  const slots = slot.draining
    ? state.slots.filter((s) => s.id !== workerId)
    : state.slots.map((s) => (s.id === workerId ? { id: s.id, status: 'vazio' as Status } : s));
  return {
    state: { ...state, slots, queue: requeue ? [...state.queue, requeue] : state.queue },
    effects: requeue ? [{ type: 'setStatus', itemId: requeue.itemId, key: 'queue' }] : [],
  };
}

function boot(state: State, aliveSlugs: string[]): Reduced {
  const dead = state.slots.filter((s) => s.status !== 'vazio' && s.slug && !aliveSlugs.includes(s.slug));
  return dead.reduce<Reduced>((r, s) => {
    const next = exit(r.state, s.id);
    return { state: next.state, effects: [...r.effects, ...next.effects] };
  }, none(state));
}

function describeTool(p: HookPayload): string {
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const detail = String(input.command ?? input.file_path ?? input.pattern ?? '').slice(0, 60);
  const name = p.tool_name ?? 'tool';
  return detail ? `${name}: ${detail}` : name;
}

function activeStatus(slot: Slot): Status {
  return slot.prUrl ? 'aguardando_review' : 'trabalhando';
}

function applyHook(state: State, workerId: string, p: HookPayload, branch?: string): Reduced {
  const slot = state.slots.find((s) => s.id === workerId);
  if (!slot || slot.status === 'vazio') return none(state);
  switch (p.hook_event_name) {
    case 'SessionStart':
      return patch(state, workerId, { worktree: p.cwd, branch });
    case 'UserPromptSubmit':
      return patch(state, workerId, { status: activeStatus(slot), question: undefined, lastEvent: 'prompt enviado' });
    case 'PreToolUse':
      return patch(state, workerId, { status: activeStatus(slot), question: undefined, lastEvent: describeTool(p) });
    case 'Notification': {
      const kind = String(p.notification_type ?? '');
      if (!WAITING_NOTIFICATIONS.includes(kind)) return none(state);
      return patch(state, workerId, { status: 'esperando_voce', question: String(p.message ?? kind), lastEvent: `aguardando: ${kind}` });
    }
    case 'PostToolUse': {
      const command = String((p.tool_input as { command?: unknown } | undefined)?.command ?? '');
      const prUrl = extractPrUrl(command, p.tool_response);
      if (!prUrl) return none(state);
      const patched = patch(state, workerId, { status: 'aguardando_review', prUrl, question: undefined, lastEvent: 'PR aberto' });
      return { ...patched, effects: slot.task ? [{ type: 'setStatus', itemId: slot.task.itemId, key: 'review' }] : [] };
    }
    case 'Stop':
      return patch(state, workerId, { lastEvent: 'turno encerrado' });
    case 'SessionEnd':
      return fill(exit(state, workerId));
    default:
      return none(state);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: all tests in `dist/test/orchestrator.test.js` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat: pure orchestrator reducer with fill, hooks and exit transitions"
```

---

### Task 3: Config loading

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  - `CONFIG_FILE = 'hive.config.json'`
  - `DEFAULT_CONFIG: Omit<Config, 'project'>`
  - `parseConfig(raw: unknown): Config` — throws `Error` with a message naming the bad field
  - `loadConfig(repo: string): Promise<Config>` — reads `<repo>/hive.config.json`

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, parseConfig } from '../src/config.js';

test('parseConfig applies defaults on top of a minimal config', () => {
  const config = parseConfig({ project: { owner: '@me', number: 6 } });
  assert.deepEqual(config.status, { queue: 'Ready', working: 'In progress', review: 'In review' });
  assert.equal(config.maxConcurrent, 2);
  assert.equal(config.port, 47821);
  assert.deepEqual(config.claudeArgs, []);
  assert.equal(config.promptTemplate, DEFAULT_CONFIG.promptTemplate);
});

test('parseConfig keeps explicit values', () => {
  const config = parseConfig({
    project: { owner: 'acme', number: 3 },
    status: { queue: 'Todo', working: 'Doing', review: 'Review' },
    maxConcurrent: 4, port: 5000, claudeArgs: ['--model', 'sonnet'], promptTemplate: '{title}',
  });
  assert.equal(config.status.queue, 'Todo');
  assert.equal(config.maxConcurrent, 4);
  assert.deepEqual(config.claudeArgs, ['--model', 'sonnet']);
  assert.equal(config.promptTemplate, '{title}');
});

test('parseConfig rejects missing or wrong-typed fields with the field name', () => {
  assert.throws(() => parseConfig({}), /project\.owner/);
  assert.throws(() => parseConfig({ project: { owner: '@me' } }), /project\.number/);
  assert.throws(() => parseConfig({ project: { owner: '@me', number: 1 }, maxConcurrent: '3' }), /maxConcurrent/);
  assert.throws(() => parseConfig({ project: { owner: '@me', number: 1 }, claudeArgs: 'x' }), /claudeArgs/);
  assert.throws(() => parseConfig({ project: { owner: '@me', number: 1 }, status: { queue: 1 } }), /status\.queue/);
});

test('loadConfig reads hive.config.json from the repo and reports a missing file clearly', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  await assert.rejects(loadConfig(repo), /hive\.config\.json/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ project: { owner: '@me', number: 9 } }));
  const config = await loadConfig(repo);
  assert.equal(config.project.number, 9);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, StatusKey } from './types.js';

export const CONFIG_FILE = 'hive.config.json';

export const DEFAULT_CONFIG: Omit<Config, 'project'> = {
  status: { queue: 'Ready', working: 'In progress', review: 'In review' },
  maxConcurrent: 2,
  port: 47821,
  claudeArgs: [],
  promptTemplate:
    'Task #{number}: {title}\n\n{body}\n\nWork on this branch. When the task is done, open a PR with `gh pr create`.',
};

const STATUS_KEYS: StatusKey[] = ['queue', 'working', 'review'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${CONFIG_FILE}: "${field}" must be a non-empty string`);
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${CONFIG_FILE}: "${field}" must be a non-negative integer`);
  return value as number;
}

function optional<T>(value: unknown, fallback: T, check: (v: unknown) => T): T {
  return value === undefined ? fallback : check(value);
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: root must be an object`);
  const project = isRecord(raw.project) ? raw.project : {};
  const owner = requireString(project.owner, 'project.owner');
  const number = requireInt(project.number, 'project.number');

  const statusRaw = optional(raw.status, {} as Record<string, unknown>, (v) => {
    if (!isRecord(v)) throw new Error(`${CONFIG_FILE}: "status" must be an object`);
    return v;
  });
  const status = Object.fromEntries(
    STATUS_KEYS.map((key) => [key, optional(statusRaw[key], DEFAULT_CONFIG.status[key], (v) => requireString(v, `status.${key}`))]),
  ) as Record<StatusKey, string>;

  return {
    project: { owner, number },
    status,
    maxConcurrent: optional(raw.maxConcurrent, DEFAULT_CONFIG.maxConcurrent, (v) => requireInt(v, 'maxConcurrent')),
    port: optional(raw.port, DEFAULT_CONFIG.port, (v) => requireInt(v, 'port')),
    claudeArgs: optional(raw.claudeArgs, DEFAULT_CONFIG.claudeArgs, (v) => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${CONFIG_FILE}: "claudeArgs" must be an array of strings`);
      return v as string[];
    }),
    promptTemplate: optional(raw.promptTemplate, DEFAULT_CONFIG.promptTemplate, (v) => requireString(v, 'promptTemplate')),
  };
}

export async function loadConfig(repo: string): Promise<Config> {
  const path = join(repo, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`${CONFIG_FILE} não encontrado em ${repo} (${(err as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: JSON inválido (${(err as Error).message})`);
  }
  return parseConfig(raw);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS for `config.test.js` and `orchestrator.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: load and validate hive.config.json with defaults"
```

---

### Task 4: Hooks settings and `.hive/` directory

**Files:**
- Create: `src/hooks-settings.ts`
- Test: `test/hooks-settings.test.ts`

**Interfaces:**
- Produces:
  - `HIVE_DIR = '.hive'`
  - `HOOK_EVENTS: readonly string[]`
  - `hookCommand(port: number): string`
  - `renderHooksSettings(port: number): { hooks: Record<string, unknown[]> }`
  - `prepareHiveDir(repo: string, port: number): Promise<{ hiveDir: string; hooksPath: string; promptsDir: string }>` — creates `<repo>/.hive/prompts`, writes `<repo>/.hive/hooks.json`, appends `.hive/` to `<repo>/.git/info/exclude` when that directory exists.

- [ ] **Step 1: Write the failing tests**

`test/hooks-settings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_EVENTS, hookCommand, prepareHiveDir, renderHooksSettings } from '../src/hooks-settings.js';

test('hookCommand posts stdin to the hive with the worker header and never fails the hook', () => {
  const cmd = hookCommand(4242);
  assert.match(cmd, /curl -s -m 2 -X POST http:\/\/127\.0\.0\.1:4242\/hooks\/event/);
  assert.match(cmd, /-H "x-hive-worker: \$HIVE_WORKER_ID"/);
  assert.match(cmd, /-d @-/);
  assert.match(cmd, /; exit 0$/);
});

test('renderHooksSettings registers every lifecycle event, Bash matcher only on PostToolUse', () => {
  const settings = renderHooksSettings(4242);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.equal(HOOK_EVENTS.length, 7);
  const post = settings.hooks.PostToolUse[0] as { matcher?: string; hooks: { type: string; command: string }[] };
  assert.equal(post.matcher, 'Bash');
  const stop = settings.hooks.Stop[0] as { matcher?: string; hooks: { type: string; command: string }[] };
  assert.equal(stop.matcher, undefined);
  assert.equal(stop.hooks[0].type, 'command');
  assert.equal(stop.hooks[0].command, hookCommand(4242));
});

test('prepareHiveDir creates .hive/prompts, hooks.json and excludes .hive from git', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  await mkdir(join(repo, '.git', 'info'), { recursive: true });
  const paths = await prepareHiveDir(repo, 4242);
  assert.equal(paths.hooksPath, join(repo, '.hive', 'hooks.json'));
  assert.ok((await stat(paths.promptsDir)).isDirectory());
  const written = JSON.parse(await readFile(paths.hooksPath, 'utf8'));
  assert.deepEqual(written, renderHooksSettings(4242));
  const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.hive\/$/m);
  await prepareHiveDir(repo, 4242);
  const again = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(again.match(/\.hive\//g)?.length, 1, 'exclude line is not duplicated');
});

test('prepareHiveDir works in a folder without .git', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  const paths = await prepareHiveDir(repo, 1);
  assert.ok((await stat(paths.hooksPath)).isFile());
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error `Cannot find module '../src/hooks-settings.js'`.

- [ ] **Step 3: Implement `src/hooks-settings.ts`**

```ts
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const HIVE_DIR = '.hive';
export const HOOK_EVENTS: readonly string[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
];

export function hookCommand(port: number): string {
  return [
    `curl -s -m 2 -X POST http://127.0.0.1:${port}/hooks/event`,
    `-H "x-hive-worker: $HIVE_WORKER_ID"`,
    `-H 'content-type: application/json'`,
    `-d @- >/dev/null; exit 0`,
  ].join(' ');
}

export function renderHooksSettings(port: number): { hooks: Record<string, unknown[]> } {
  const command = hookCommand(port);
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [{ ...(event === 'PostToolUse' ? { matcher: 'Bash' } : {}), hooks: [{ type: 'command', command }] }],
    ]),
  );
  return { hooks };
}

async function excludeFromGit(repo: string): Promise<void> {
  const infoDir = join(repo, '.git', 'info');
  try {
    if (!(await stat(infoDir)).isDirectory()) return;
  } catch {
    return;
  }
  const excludePath = join(infoDir, 'exclude');
  const current = await readFile(excludePath, 'utf8').catch(() => '');
  if (current.split('\n').includes(`${HIVE_DIR}/`)) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(excludePath, `${separator}${HIVE_DIR}/\n`);
}

export async function prepareHiveDir(repo: string, port: number): Promise<{ hiveDir: string; hooksPath: string; promptsDir: string }> {
  const hiveDir = join(repo, HIVE_DIR);
  const promptsDir = join(hiveDir, 'prompts');
  const hooksPath = join(hiveDir, 'hooks.json');
  await mkdir(promptsDir, { recursive: true });
  await writeFile(hooksPath, JSON.stringify(renderHooksSettings(port), null, 2) + '\n');
  await excludeFromGit(repo);
  return { hiveDir, hooksPath, promptsDir };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks-settings.ts test/hooks-settings.test.ts
git commit -m "feat: generate per-worker hooks.json and prepare .hive directory"
```

---

### Task 5: Board adapter (`gh project`)

**Files:**
- Create: `src/board.ts`
- Test: `test/board.test.ts`

**Interfaces:**
- Consumes: `Config`, `Task`, `StatusKey`.
- Produces:
  - `type Exec = (args: string[]) => Promise<string>` (stdout)
  - `ghExec: Exec` (real one, `execFile('gh', args)`)
  - `createBoard(config: Config, exec?: Exec): Board`
  - `interface Board { resolveFields(): Promise<void>; listQueue(): Promise<Task[]>; setStatus(itemId: string, key: StatusKey): Promise<void> }`
  - `setStatus` before `resolveFields` rejects with `Error('board not resolved…')`.

- [ ] **Step 1: Write the failing tests**

`test/board.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard } from '../src/board.js';
import { parseConfig } from '../src/config.js';

const config = parseConfig({ project: { owner: 'acme', number: 6 } });

function fakeExec(responses: Record<string, unknown>) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    const key = args.slice(0, 3).join(' ');
    if (!(key in responses)) throw new Error(`unexpected gh call: ${args.join(' ')}`);
    const value = responses[key];
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return { calls, exec };
}

const fields = {
  fields: [
    { id: 'F_title', name: 'Title', type: 'ProjectV2Field' },
    { id: 'F_status', name: 'Status', type: 'ProjectV2SingleSelectField',
      options: [{ id: 'O_ready', name: 'Ready' }, { id: 'O_prog', name: 'In progress' }, { id: 'O_rev', name: 'In review' }, { id: 'O_done', name: 'Done' }] },
  ],
};

test('resolveFields maps configured status names to option ids and stores the project id', async () => {
  const { exec, calls } = fakeExec({ 'project view 6': { id: 'PVT_1' }, 'project field-list 6': fields });
  const board = createBoard(config, exec);
  await board.resolveFields();
  await board.setStatus('ITEM_1', 'review');
  const edit = calls.find((c) => c[1] === 'item-edit');
  assert.deepEqual(edit, ['project', 'item-edit', '--id', 'ITEM_1', '--project-id', 'PVT_1', '--field-id', 'F_status', '--single-select-option-id', 'O_rev']);
  for (const c of calls.filter((c) => c[1] !== 'item-edit')) assert.ok(c.includes('--owner') && c.includes('acme'), c.join(' '));
});

test('resolveFields fails naming the missing option and listing the available ones', async () => {
  const bad = parseConfig({ project: { owner: 'acme', number: 6 }, status: { queue: 'Todo' } });
  const board = createBoard(bad, fakeExec({ 'project view 6': { id: 'PVT_1' }, 'project field-list 6': fields }).exec);
  await assert.rejects(board.resolveFields(), /"Todo".*Ready, In progress, In review, Done/s);
});

test('setStatus before resolveFields throws', async () => {
  const board = createBoard(config, fakeExec({}).exec);
  await assert.rejects(board.setStatus('x', 'queue'), /not resolved/);
});

test('listQueue returns only issues in the queue column, in board order', async () => {
  const items = {
    items: [
      { id: 'I1', status: 'Ready', title: 'A', content: { type: 'Issue', number: 1, title: 'A', body: 'a', url: 'https://github.com/acme/r/issues/1' } },
      { id: 'I2', status: 'In progress', title: 'B', content: { type: 'Issue', number: 2, title: 'B', body: 'b', url: 'https://github.com/acme/r/issues/2' } },
      { id: 'I3', status: 'Ready', title: 'Draft', content: { type: 'DraftIssue', title: 'Draft', body: '' } },
      { id: 'I4', status: 'Ready', title: 'C', content: { type: 'Issue', number: 4, title: 'C', body: null, url: 'https://github.com/acme/r/issues/4' } },
      { id: 'I5', title: 'No status', content: { type: 'Issue', number: 5, title: 'E', body: '', url: 'https://github.com/acme/r/issues/5' } },
    ],
  };
  const board = createBoard(config, fakeExec({ 'project item-list 6': items }).exec);
  const queue = await board.listQueue();
  assert.deepEqual(queue, [
    { itemId: 'I1', number: 1, title: 'A', body: 'a', url: 'https://github.com/acme/r/issues/1' },
    { itemId: 'I4', number: 4, title: 'C', body: '', url: 'https://github.com/acme/r/issues/4' },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error `Cannot find module '../src/board.js'`.

- [ ] **Step 3: Implement `src/board.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, StatusKey, Task } from './types.js';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 20 * 1024 * 1024;
const ITEM_LIMIT = 200;
const STATUS_KEYS: StatusKey[] = ['queue', 'working', 'review'];

export type Exec = (args: string[]) => Promise<string>;

export interface Board {
  resolveFields(): Promise<void>;
  listQueue(): Promise<Task[]>;
  setStatus(itemId: string, key: StatusKey): Promise<void>;
}

export const ghExec: Exec = async (args) => {
  try {
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: GH_MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${(e.stderr ?? '').trim() || e.message}`);
  }
};

interface GhField { id: string; name: string; type: string; options?: { id: string; name: string }[] }
interface GhItem {
  id: string;
  status?: string;
  title?: string;
  content?: { type?: string; number?: number; title?: string; body?: string | null; url?: string };
}

export function createBoard(config: Config, exec: Exec = ghExec): Board {
  const { owner, number } = config.project;
  const base = (sub: string) => ['project', sub, String(number), '--owner', owner, '--format', 'json'];
  let resolved: { projectId: string; statusFieldId: string; optionIds: Record<StatusKey, string> } | undefined;

  async function resolveFields(): Promise<void> {
    const view = JSON.parse(await exec(base('view'))) as { id: string };
    const { fields } = JSON.parse(await exec(base('field-list'))) as { fields: GhField[] };
    const status = fields.find((f) => f.name === 'Status' && f.options);
    if (!status?.options) throw new Error('board has no single-select "Status" field');
    const available = status.options.map((o) => o.name);
    const optionIds = {} as Record<StatusKey, string>;
    for (const key of STATUS_KEYS) {
      const wanted = config.status[key];
      const option = status.options.find((o) => o.name === wanted);
      if (!option) throw new Error(`status.${key} "${wanted}" not found in board Status options: ${available.join(', ')}`);
      optionIds[key] = option.id;
    }
    resolved = { projectId: view.id, statusFieldId: status.id, optionIds };
  }

  async function listQueue(): Promise<Task[]> {
    const { items } = JSON.parse(await exec([...base('item-list'), '--limit', String(ITEM_LIMIT)])) as { items: GhItem[] };
    return items.flatMap<Task>((item) => {
      const c = item.content;
      if (item.status !== config.status.queue || c?.type !== 'Issue' || typeof c.number !== 'number' || !c.url) return [];
      return [{ itemId: item.id, number: c.number, title: c.title ?? item.title ?? `#${c.number}`, body: c.body ?? '', url: c.url }];
    });
  }

  async function setStatus(itemId: string, key: StatusKey): Promise<void> {
    if (!resolved) throw new Error('board not resolved: call resolveFields() first');
    await exec([
      'project', 'item-edit', '--id', itemId, '--project-id', resolved.projectId,
      '--field-id', resolved.statusFieldId, '--single-select-option-id', resolved.optionIds[key],
    ]);
  }

  return { resolveFields, listQueue, setStatus };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Validate against a real board (manual)**

Create `/tmp/hive-board-check.mjs`:

```js
import { createBoard } from '/Users/dennysazevedo/Workspace/agent-hive/dist/src/board.js';
import { parseConfig } from '/Users/dennysazevedo/Workspace/agent-hive/dist/src/config.js';
const [owner, number, queue] = process.argv.slice(2);
const board = createBoard(parseConfig({ project: { owner, number: Number(number) }, status: queue ? { queue } : undefined }));
await board.resolveFields();
console.log(await board.listQueue());
```

Run: `node /tmp/hive-board-check.mjs @me 6 Ready`
Expected: an array of `{ itemId, number, title, body, url }` for the items currently in `Ready`. If it is empty while the board has Ready issues, print one raw item with `gh project item-list 6 --owner @me --limit 1 --format json` and adapt the `status` key in `listQueue` (this is the one assumption about `gh` output the plan could not verify).

- [ ] **Step 6: Commit**

```bash
git add src/board.ts test/board.test.ts
git commit -m "feat: github projects v2 board adapter via gh"
```

---

### Task 6: Spawn, focus, kill, liveness (iTerm2)

**Files:**
- Create: `src/spawn.ts`
- Test: `test/spawn.test.ts`

**Interfaces:**
- Consumes: `Task`.
- Produces:
  - `renderPrompt(template: string, task: Task): string`
  - `writePrompt(promptsDir: string, slug: string, text: string): Promise<string>` → path
  - `interface WorkerCommandOptions { repo: string; workerId: string; port: number; slug: string; hooksPath: string; promptPath: string; claudeArgs: string[] }`
  - `workerCommand(opts: WorkerCommandOptions): string`
  - `openWorker(command: string): Promise<string>` → iTerm session unique id
  - `focusWorker(sessionId: string): Promise<void>`
  - `killWorker(slug: string): Promise<void>`
  - `aliveSlugs(slugs: string[]): Promise<string[]>`
  - `shellQuote(s: string): string`

- [ ] **Step 1: Write the failing tests**

`test/spawn.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPrompt, shellQuote, workerCommand, writePrompt } from '../src/spawn.js';

const task = { itemId: 'I1', number: 7, title: 'Fix "login"', body: 'line1\n$(echo pwned) `x`', url: 'https://github.com/a/b/issues/7' };

test('renderPrompt substitutes every placeholder', () => {
  const text = renderPrompt('#{number} {title}\n{body}\n{url}', task);
  assert.equal(text, '#7 Fix "login"\nline1\n$(echo pwned) `x`\nhttps://github.com/a/b/issues/7');
});

test('writePrompt writes <promptsDir>/<slug>.md', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const path = await writePrompt(dir, 'hive-7-fix', 'hello');
  assert.equal(path, join(dir, 'hive-7-fix.md'));
  assert.equal(await readFile(path, 'utf8'), 'hello');
});

test('shellQuote single-quotes and escapes embedded quotes', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('workerCommand runs claude in the repo with hive env, worktree, hooks and prompt, then reports exit', () => {
  const cmd = workerCommand({
    repo: '/Users/x/my repo', workerId: 'W1', port: 4242, slug: 'hive-7-fix',
    hooksPath: '/Users/x/my repo/.hive/hooks.json', promptPath: '/Users/x/my repo/.hive/prompts/hive-7-fix.md',
    claudeArgs: ['--model', 'sonnet'],
  });
  assert.equal(
    cmd,
    "cd '/Users/x/my repo' && HIVE_WORKER_ID=W1 HIVE_PORT=4242 claude --worktree=hive-7-fix " +
      "--settings '/Users/x/my repo/.hive/hooks.json' '--model' 'sonnet' \"$(cat '/Users/x/my repo/.hive/prompts/hive-7-fix.md')\"; " +
      "curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-worker: W1' >/dev/null",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error `Cannot find module '../src/spawn.js'`.

- [ ] **Step 3: Implement `src/spawn.ts`**

```ts
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from './types.js';

const execFileAsync = promisify(execFile);
const PKILL_NO_MATCH = 1;

export interface WorkerCommandOptions {
  repo: string;
  workerId: string;
  port: number;
  slug: string;
  hooksPath: string;
  promptPath: string;
  claudeArgs: string[];
}

export function renderPrompt(template: string, task: Task): string {
  const values: Record<string, string> = {
    number: String(task.number), title: task.title, body: task.body, url: task.url,
  };
  return template.replace(/\{(number|title|body|url)\}/g, (_, key: string) => values[key]);
}

export async function writePrompt(promptsDir: string, slug: string, text: string): Promise<string> {
  const path = join(promptsDir, `${slug}.md`);
  await writeFile(path, text);
  return path;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function workerCommand(o: WorkerCommandOptions): string {
  const args = o.claudeArgs.map(shellQuote).join(' ');
  return [
    `cd ${shellQuote(o.repo)} &&`,
    `HIVE_WORKER_ID=${o.workerId} HIVE_PORT=${o.port} claude --worktree=${o.slug}`,
    `--settings ${shellQuote(o.hooksPath)}${args ? ` ${args}` : ''}`,
    `"$(cat ${shellQuote(o.promptPath)})";`,
    `curl -s -m 2 -X POST http://127.0.0.1:${o.port}/hooks/exit -H 'x-hive-worker: ${o.workerId}' >/dev/null`,
  ].join(' ');
}

const OPEN_TAB_SCRIPT = `
on run argv
  tell application "iTerm2"
    activate
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current tab of current window
      write text (item 1 of argv)
      return unique id
    end tell
  end tell
end run`;

const FOCUS_SCRIPT = `
on run argv
  tell application "iTerm2"
    activate
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is (item 1 of argv) then
            select t
            set index of w to 1
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
    return "not found"
  end tell
end run`;

async function osascript(script: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script, ...args]);
  return stdout.trim();
}

export async function openWorker(command: string): Promise<string> {
  return osascript(OPEN_TAB_SCRIPT, command);
}

export async function focusWorker(sessionId: string): Promise<void> {
  const result = await osascript(FOCUS_SCRIPT, sessionId);
  if (result !== 'ok') throw new Error(`iTerm session ${sessionId} not found`);
}

function worktreePattern(slug: string): string {
  return `--worktree=${slug}`;
}

export async function killWorker(slug: string): Promise<void> {
  try {
    await execFileAsync('pkill', ['-f', '--', worktreePattern(slug)]);
  } catch (err) {
    if ((err as { code?: number }).code !== PKILL_NO_MATCH) throw err;
  }
}

export async function aliveSlugs(slugs: string[]): Promise<string[]> {
  const checks = await Promise.all(
    slugs.map(async (slug) => {
      try {
        await execFileAsync('pgrep', ['-f', '--', worktreePattern(slug)]);
        return slug;
      } catch {
        return undefined;
      }
    }),
  );
  return checks.filter((s): s is string => s !== undefined);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Validate iTerm integration (manual)**

Create `/tmp/hive-spawn-check.mjs`:

```js
import { openWorker, focusWorker, killWorker, aliveSlugs } from '/Users/dennysazevedo/Workspace/agent-hive/dist/src/spawn.js';
const id = await openWorker('echo HIVE-SPAWN-OK; sh -c "sleep 60" --worktree=hive-check');
console.log('session', id);
await new Promise((r) => setTimeout(r, 2000));
console.log('alive', await aliveSlugs(['hive-check']));
await focusWorker(id);
await killWorker('hive-check');
await new Promise((r) => setTimeout(r, 500));
console.log('alive after kill', await aliveSlugs(['hive-check']));
```

Run: `node /tmp/hive-spawn-check.mjs`
Expected: a new iTerm2 tab prints `HIVE-SPAWN-OK`; output shows `alive [ 'hive-check' ]`, then `alive after kill []`. (The bogus `--worktree=hive-check` argument only exists so `pgrep -f` has something to match.) The first run may trigger a macOS Automation permission prompt for controlling iTerm2 — accept it.

- [ ] **Step 6: Commit**

```bash
git add src/spawn.ts test/spawn.test.ts
git commit -m "feat: spawn, focus and kill workers in iTerm2 tabs"
```

---

### Task 7: State store, server, effect runner, `bootHive`, headless runner

**Files:**
- Create: `src/state-store.ts`, `src/server.ts`, `src/hive.ts`, `src/run.ts`
- Test: `test/state-store.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces:
  - `loadState(hiveDir: string, maxConcurrent: number): Promise<State>`
  - `saveState(hiveDir: string, state: State): Promise<void>` (atomic: write `state.json.tmp`, rename)
  - `interface ServerDeps { repo: string; config: Config; board: Board; state: State; hiveDir: string; hooksPath: string; promptsDir: string }`
  - `interface HiveServer { dispatch(event: HiveEvent): Promise<void>; poll(): Promise<void>; listen(): Promise<void>; getState(): State }`
  - `createServer(deps: ServerDeps): HiveServer`
  - `detectAlive(state: State): Promise<string[]>`
  - `bootHive(repo: string): Promise<{ port: number; server: HiveServer }>`

- [ ] **Step 1: Write the failing test for the state store**

`test/state-store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState } from '../src/orchestrator.js';
import { loadState, saveState } from '../src/state-store.js';

test('loadState returns initialState when nothing is saved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const state = await loadState(dir, 3);
  assert.equal(state.slots.length, 3);
  assert.deepEqual(state.queue, []);
});

test('saveState then loadState round-trips and leaves no tmp file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const state = { ...initialState(1), error: 'x' };
  await saveState(dir, state);
  assert.deepEqual(await loadState(dir, 1), state);
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('loadState ignores a corrupt file and falls back to initialState', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  await writeFile(join(dir, 'state.json'), '{not json');
  const state = await loadState(dir, 2);
  assert.equal(state.slots.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: build error `Cannot find module '../src/state-store.js'`.

- [ ] **Step 3: Implement `src/state-store.ts`**

```ts
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState } from './orchestrator.js';
import type { State } from './types.js';

const STATE_FILE = 'state.json';

export async function loadState(hiveDir: string, maxConcurrent: number): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(join(hiveDir, STATE_FILE), 'utf8')) as State;
    if (Array.isArray(parsed.slots) && Array.isArray(parsed.queue) && Number.isInteger(parsed.maxConcurrent)) return parsed;
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Implement `src/server.ts`**

```ts
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import type { Board } from './board.js';
import { reduce } from './orchestrator.js';
import { aliveSlugs, focusWorker, killWorker, openWorker, renderPrompt, workerCommand, writePrompt } from './spawn.js';
import { saveState } from './state-store.js';
import type { Config, Effect, HiveEvent, HookPayload, Slot, State } from './types.js';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 30_000;
const SSE_HEARTBEAT_MS = 25_000;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');

export interface ServerDeps {
  repo: string;
  config: Config;
  board: Board;
  state: State;
  hiveDir: string;
  hooksPath: string;
  promptsDir: string;
}

export interface HiveServer {
  dispatch(event: HiveEvent): Promise<void>;
  poll(): Promise<void>;
  listen(): Promise<void>;
  getState(): State;
}

export async function detectAlive(state: State): Promise<string[]> {
  return aliveSlugs(state.slots.flatMap((s) => (s.status !== 'vazio' && s.slug ? [s.slug] : [])));
}

export function createServer(deps: ServerDeps): HiveServer {
  const { repo, config, board, hiveDir, hooksPath, promptsDir } = deps;
  let state = deps.state;
  const clients = new Set<Response>();

  function broadcast(): void {
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  async function dispatch(event: HiveEvent): Promise<void> {
    const result = reduce(state, event);
    state = result.state;
    await saveState(hiveDir, state).catch((err: Error) => console.error('persist failed:', err.message));
    broadcast();
    for (const effect of result.effects) await runEffect(effect);
  }

  async function fail(context: string, err: unknown): Promise<void> {
    const message = `${context}: ${(err as Error).message}`;
    console.error(message);
    await dispatch({ type: 'error', message });
  }

  async function runEffect(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'setStatus':
        await board.setStatus(effect.itemId, effect.key).catch((err) => fail(`board.setStatus(${effect.key})`, err));
        return;
      case 'kill':
        await killWorker(effect.slug).catch((err) => fail('kill', err));
        return;
      case 'spawn':
        await spawn(effect.slot).catch((err) => fail(`spawn ${effect.slot.slug}`, err));
        return;
    }
  }

  async function spawn(slot: Slot): Promise<void> {
    if (!slot.task || !slot.slug) return;
    const promptPath = await writePrompt(promptsDir, slot.slug, renderPrompt(config.promptTemplate, slot.task));
    const command = workerCommand({
      repo, workerId: slot.id, port: config.port, slug: slot.slug, hooksPath, promptPath, claudeArgs: config.claudeArgs,
    });
    const itermSessionId = await openWorker(command);
    await dispatch({ type: 'spawned', slotId: slot.id, itermSessionId });
  }

  async function poll(): Promise<void> {
    try {
      const tasks = await board.listQueue();
      await dispatch({ type: 'poll', tasks });
    } catch (err) {
      await fail('board.listQueue', err);
    }
  }

  async function resolveBranch(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current']);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/hooks/event', async (req: Request, res: Response) => {
    res.sendStatus(200);
    const workerId = req.header('x-hive-worker');
    const payload = req.body as HookPayload | undefined;
    if (!workerId || !payload?.hook_event_name) return;
    const branch = payload.hook_event_name === 'SessionStart' && payload.cwd ? await resolveBranch(payload.cwd) : undefined;
    await dispatch({ type: 'hook', workerId, payload, branch });
  });

  app.post('/hooks/exit', async (req: Request, res: Response) => {
    res.sendStatus(200);
    const workerId = req.header('x-hive-worker');
    if (workerId) await dispatch({ type: 'exit', workerId });
  });

  app.get('/events', (req: Request, res: Response) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });

  app.post('/config', async (req: Request, res: Response) => {
    const max = (req.body as { maxConcurrent?: unknown }).maxConcurrent;
    if (!Number.isInteger(max) || (max as number) < 0) {
      res.status(400).json({ error: 'maxConcurrent must be a non-negative integer' });
      return;
    }
    await dispatch({ type: 'setMax', max: max as number });
    res.json({ ok: true });
  });

  app.post('/slots/:id/kill', async (req: Request, res: Response) => {
    await dispatch({ type: 'kill', slotId: req.params.id });
    res.json({ ok: true });
  });

  app.post('/slots/:id/focus', async (req: Request, res: Response) => {
    const slot = state.slots.find((s) => s.id === req.params.id);
    if (!slot?.itermSessionId) {
      res.status(404).json({ error: 'slot has no terminal session' });
      return;
    }
    try {
      await focusWorker(slot.itermSessionId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/board/refresh', async (_req: Request, res: Response) => {
    await poll();
    res.json({ ok: true });
  });

  app.get('/', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'index.html')));
  app.get('/ui/app.js', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'app.js')));

  async function listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(config.port, '127.0.0.1', () => resolve());
      server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE'
          ? new Error(`porta ${config.port} em uso (outro Agent Hive rodando? veja: lsof -i :${config.port})`)
          : err);
      });
    });
    setInterval(() => void poll(), POLL_INTERVAL_MS);
  }

  return { dispatch, poll, listen, getState: () => state };
}
```

- [ ] **Step 6: Implement `src/hive.ts`**

```ts
import { createBoard } from './board.js';
import { loadConfig } from './config.js';
import { prepareHiveDir } from './hooks-settings.js';
import { createServer, detectAlive, type HiveServer } from './server.js';
import { loadState } from './state-store.js';

export async function bootHive(repo: string): Promise<{ port: number; server: HiveServer }> {
  const config = await loadConfig(repo);
  const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, config.port);
  const board = createBoard(config);
  await board.resolveFields();
  const saved = await loadState(hiveDir, config.maxConcurrent);
  const server = createServer({ repo, config, board, state: saved, hiveDir, hooksPath, promptsDir });
  await server.listen();
  await server.dispatch({ type: 'boot', aliveSlugs: await detectAlive(saved) });
  await server.poll();
  console.log(`Agent Hive em http://127.0.0.1:${config.port} (repo: ${repo})`);
  return { port: config.port, server };
}
```

- [ ] **Step 7: Implement `src/run.ts`**

```ts
import { resolve } from 'node:path';
import { bootHive } from './hive.js';

const repo = process.argv[2];
if (!repo) {
  console.error('uso: node dist/src/run.js <repo>');
  process.exit(2);
}
bootHive(resolve(repo)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 8: Build and validate with simulated hooks (manual)**

Prepare a test repo: any git repo with a `hive.config.json` pointing at a board that has ≥1 issue in the queue column, starting with `maxConcurrent: 0` so nothing spawns on boot:

```json
{ "project": { "owner": "@me", "number": 6 }, "maxConcurrent": 0 }
```

```bash
pnpm build && node dist/src/run.js /path/to/test-repo &
curl -s -N localhost:47821/events | head -c 400; echo
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:47821/hooks/event -H 'x-hive-worker: nope' -H 'content-type: application/json' -d '{"hook_event_name":"Stop"}'
curl -s -X POST localhost:47821/config -H 'content-type: application/json' -d '{"maxConcurrent":1}'
```
Expected: the first `curl -N` prints a `data: {...}` line with `maxConcurrent: 0` and the queue filled from the board; the unknown-worker hook returns `200`; after `/config`, an iTerm2 tab opens running `claude --worktree=hive-<n>-...`, the board item moves to `In progress`, and `curl -N localhost:47821/events` shows the slot `trabalhando` with an `itermSessionId`. Wait in that tab for `idle_prompt` (or a permission prompt): SSE state shows `esperando_voce`. Type `/exit` in the tab: state shows `vazio`, item back in `Ready`.

- [ ] **Step 9: Commit**

```bash
git add src/state-store.ts src/server.ts src/hive.ts src/run.ts test/state-store.test.ts
git commit -m "feat: express server with hook intake, effects, sse and headless runner"
```

---

### Task 8: Dashboard UI

**Files:**
- Modify: `src/ui/index.html` (replace the placeholder)
- Create: `src/ui/app.ts`

**Interfaces:**
- Consumes: `State`, `Slot` types (type-only import, erased at build); routes from Task 7.

- [ ] **Step 1: Write `src/ui/index.html`**

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Hive</title>
<style>
  :root {
    --bg: #111418; --panel: #1a1f26; --text: #e6e6e6; --muted: #8a94a6; --border: #2a313b;
    --vazio: #3a4250; --trabalhando: #2e9e5b; --esperando: #e0b52a; --review: #3b82f6; --danger: #d9534f;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 -apple-system, system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; margin: 0; }
  header label { color: var(--muted); display: flex; gap: 8px; align-items: center; }
  input[type=number] { width: 64px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; }
  button { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  button.danger { border-color: var(--danger); color: var(--danger); }
  #error { display: none; background: var(--danger); color: #fff; padding: 8px 20px; }
  #error.show { display: block; }
  main { display: grid; grid-template-columns: 1fr 300px; gap: 16px; padding: 16px 20px; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; align-content: start; }
  .card { background: var(--panel); border: 1px solid var(--border); border-left: 6px solid var(--vazio); border-radius: 8px; padding: 12px; min-height: 120px; cursor: default; }
  .card.occupied { cursor: pointer; }
  .card.trabalhando { border-left-color: var(--trabalhando); }
  .card.aguardando_review { border-left-color: var(--review); }
  .card.esperando_voce { border-left-color: var(--esperando); animation: blink 1s ease-in-out infinite; }
  .card.draining .title { text-decoration: line-through; }
  .card .title { font-weight: 600; margin-bottom: 4px; }
  .card .meta { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .actions { margin-top: 8px; display: flex; gap: 8px; }
  @keyframes blink { 0%, 100% { background: var(--panel); } 50% { background: #3a3110; } }
  aside { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  aside h2 { font-size: 13px; color: var(--muted); margin: 0 0 8px; text-transform: uppercase; }
  ol { margin: 0; padding-left: 20px; }
  li { margin: 4px 0; }
  #detail { display: none; }
  #detail.show { display: block; }
  #detail pre { white-space: pre-wrap; background: var(--bg); padding: 8px; border-radius: 6px; max-height: 300px; overflow: auto; }
  a { color: var(--review); }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Agent Hive</h1>
  <span id="summary">0/0 workers ativos</span>
  <label>máx. workers <input id="max" type="number" min="0" step="1"></label>
  <button id="refresh">atualizar board</button>
  <span id="polled" style="color: var(--muted); margin-left: auto;"></span>
</header>
<div id="error"></div>
<main>
  <section id="grid"></section>
  <div>
    <aside id="detail">
      <h2>detalhe</h2>
      <div id="detail-body"></div>
      <div class="actions" style="margin-top: 8px; display: flex; gap: 8px;">
        <button id="focus">ir pro terminal</button>
        <button id="close">fechar</button>
      </div>
    </aside>
    <aside id="queue-panel">
      <h2>fila</h2>
      <ol id="queue"></ol>
    </aside>
  </div>
</main>
<script type="module" src="/ui/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `src/ui/app.ts`**

```ts
import type { Slot, State } from '../types.js';

const STATUS_LABEL: Record<Slot['status'], string> = {
  vazio: 'vazio', trabalhando: 'trabalhando', esperando_voce: 'esperando você', aguardando_review: 'aguardando review',
};
const RERENDER_MS = 30_000;

let state: State | undefined;
let selectedSlotId: string | undefined;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function elapsed(iso?: string): string {
  if (!iso) return '';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function showError(message?: string): void {
  const el = $('error');
  el.textContent = message ?? '';
  el.classList.toggle('show', Boolean(message));
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    showError(error ?? res.statusText);
  }
}

function renderCard(slot: Slot): string {
  const occupied = slot.status !== 'vazio';
  const classes = ['card', slot.status, occupied ? 'occupied' : '', slot.draining ? 'draining' : ''].join(' ');
  if (!occupied) return `<div class="${classes}" data-id="${slot.id}"><div class="meta">${STATUS_LABEL.vazio}</div></div>`;
  return `
    <div class="${classes}" data-id="${slot.id}">
      <div class="title">#${slot.task?.number} ${esc(slot.task?.title ?? '')}</div>
      <div class="meta">${STATUS_LABEL[slot.status]} · ${elapsed(slot.startedAt)}${slot.draining ? ' · drenando' : ''}</div>
      <div class="meta">${esc(slot.branch ?? slot.slug ?? '')}</div>
      <div class="meta">${esc(slot.lastEvent ?? '')}</div>
      <div class="actions"><button class="danger" data-kill="${slot.id}">kill</button></div>
    </div>`;
}

function renderDetail(): void {
  const slot = state?.slots.find((s) => s.id === selectedSlotId);
  const panel = $('detail');
  if (!slot || slot.status === 'vazio') {
    panel.classList.remove('show');
    selectedSlotId = undefined;
    return;
  }
  const lines = [
    `<div class="title">#${slot.task?.number} ${esc(slot.task?.title ?? '')}</div>`,
    slot.prUrl ? `<p>PR: <a href="${esc(slot.prUrl)}" target="_blank" rel="noreferrer">${esc(slot.prUrl)}</a></p>` : '',
    slot.question ? `<p>pendente:</p><pre>${esc(slot.question)}</pre>` : '',
    `<div class="meta">worktree: ${esc(slot.worktree ?? '—')}</div>`,
    `<div class="meta">branch: ${esc(slot.branch ?? '—')}</div>`,
    slot.task?.url ? `<div class="meta"><a href="${esc(slot.task.url)}" target="_blank" rel="noreferrer">issue</a></div>` : '',
  ];
  $('detail-body').innerHTML = lines.join('');
  panel.classList.add('show');
}

function render(): void {
  if (!state) return;
  const active = state.slots.filter((s) => s.status !== 'vazio').length;
  $('summary').textContent = `${active}/${state.maxConcurrent} workers ativos`;
  const max = $<HTMLInputElement>('max');
  if (document.activeElement !== max) max.value = String(state.maxConcurrent);
  $('polled').textContent = state.lastPolledAt ? `board: ${new Date(state.lastPolledAt).toLocaleTimeString()}` : '';
  showError(state.error);
  $('grid').innerHTML = state.slots.map(renderCard).join('');
  $('queue').innerHTML = state.queue.map((t) => `<li>#${t.number} ${esc(t.title)}</li>`).join('')
    || '<li style="list-style:none;color:var(--muted)">vazia</li>';
  renderDetail();
}

function connect(): void {
  const source = new EventSource('/events');
  source.onmessage = (event) => {
    state = JSON.parse(event.data) as State;
    render();
  };
  source.onerror = () => showError('conexão com o Agent Hive perdida; reconectando…');
}

$('grid').addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const killId = target.dataset.kill;
  if (killId) {
    event.stopPropagation();
    if (confirm('Matar esse worker? A task volta pra fila.')) void post(`/slots/${killId}/kill`);
    return;
  }
  const card = target.closest<HTMLElement>('.card.occupied');
  if (!card) return;
  selectedSlotId = card.dataset.id;
  renderDetail();
});

$('max').addEventListener('change', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isInteger(value) && value >= 0) void post('/config', { maxConcurrent: value });
});
$('refresh').addEventListener('click', () => void post('/board/refresh'));
$('focus').addEventListener('click', () => {
  if (selectedSlotId) void post(`/slots/${selectedSlotId}/focus`);
});
$('close').addEventListener('click', () => {
  selectedSlotId = undefined;
  renderDetail();
});

setInterval(render, RERENDER_MS);
connect();
```

- [ ] **Step 3: Build and check in a browser (manual)**

Run: `pnpm build && node dist/src/run.js /path/to/test-repo` and open `http://127.0.0.1:47821/` in Chrome.
Expected: header shows `N/M workers ativos`, the number input reflects `maxConcurrent`, the queue lists the `Ready` issues, one card per slot. Set the input to 1: a worker spawns and its card turns green with title/branch/last event. Click the card: the detail panel opens; "ir pro terminal" brings the iTerm tab forward. Wait for the worker to idle: card blinks yellow. Click kill → confirm → card returns to grey and the next task (if any) starts.

Simulate a PR without opening a real one (replace `<SLOT_ID>` with the occupied slot's `id` from the SSE payload):

```bash
curl -s -X POST localhost:47821/hooks/event -H "x-hive-worker: <SLOT_ID>" -H 'content-type: application/json' \
  -d '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"gh pr create"},"tool_response":"https://github.com/acme/repo/pull/1"}'
```
Expected: card turns blue, detail shows the PR link, the board item moves to `In review` (move it back by hand afterwards).

- [ ] **Step 4: Commit**

```bash
git add src/ui/index.html src/ui/app.ts
git commit -m "feat: dashboard ui with slot cards, queue and detail panel"
```

---

### Task 9: Electron window and end-to-end smoke

**Files:**
- Modify: `src/main.ts` (replace placeholder)

**Interfaces:**
- Consumes: `bootHive(repo)` from Task 7.

- [ ] **Step 1: Write `src/main.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { bootHive } from './hive.js';

const WINDOW = { width: 1280, height: 820, backgroundColor: '#111418' };

function lastRepoFile(): string {
  return join(app.getPath('userData'), 'last-repo');
}

async function rememberRepo(repo: string): Promise<void> {
  await mkdir(dirname(lastRepoFile()), { recursive: true });
  await writeFile(lastRepoFile(), repo);
}

async function pickRepo(): Promise<string | undefined> {
  const fromArgv = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  if (fromArgv) return resolve(fromArgv);
  const remembered = await readFile(lastRepoFile(), 'utf8').catch(() => '');
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Escolha o repositório com hive.config.json',
    defaultPath: remembered || undefined,
    properties: ['openDirectory'],
  });
  return canceled ? undefined : filePaths[0];
}

function openWindow(port: number): void {
  const origin = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow(WINDOW);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  void win.loadURL(`${origin}/`);
}

app.whenReady().then(async () => {
  const repo = await pickRepo();
  if (!repo) {
    app.quit();
    return;
  }
  await rememberRepo(repo);
  const { port } = await bootHive(repo);
  openWindow(port);
}).catch((err: Error) => {
  dialog.showErrorBox('Agent Hive', err.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 2: Build and launch**

Run: `pnpm start -- /path/to/test-repo`
Expected: the Electron window opens on the dashboard; clicking the issue or PR link opens the default browser, not a navigation inside the window. Launching with no argument shows the folder picker, defaulting to the remembered path on later launches.

- [ ] **Step 3: Run the spec's acceptance criteria (manual, against a test board with 5 issues in `Ready`)**

1. Set `maxConcurrent` to 3 → 3 iTerm tabs open with distinct worktrees under `<repo>/.claude/worktrees/`, 2 issues stay in the queue panel, 3 issues show `In progress` on GitHub.
2. Kill one (card button) and close another tab with `/exit` → both slots refill from the queue, the two issues move back to `Ready`.
3. Let a worker hit a permission prompt → card blinks yellow, click → "ir pro terminal" focuses the right tab, answer → card green again.
4. Let a worker run `gh pr create` → card blue with the PR link, issue moves to `In review`.
5. Quit the Hive window while workers run, relaunch → occupied slots are re-adopted (still green), dead ones are emptied.

Record the outcome of each in the commit message body.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: electron window and repo picker

Smoke: <one line per acceptance criterion with pass/fail>"
```

---

## Self-review notes

- Spec coverage: config (T3), state + persistence (T1, T7), state machine + fill (T2), spawn/focus/kill/boot liveness (T6, T7), hooks.json + git exclude (T4), every route in the spec's server table (T7), board functions and error banner (T5, T7, T8), UI sections/colors/panel/external links (T8, T9), Electron (T9), tests listed in the spec (T2–T7). "Draining" is a flag instead of the original `drenando` status on purpose (spec updated).
- Type consistency: `Slot.draining`, `Effect` variants, `HiveEvent` variants and `Board` method names are used identically across T2, T5, T7 and T8.
- Known unverified assumption: the `status` key on `gh project item-list` items (T5 step 5 checks it against a real board before anything depends on it).
