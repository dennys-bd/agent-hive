# Agent Hive — boards plugáveis (GitHub + Markdown): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board tasks come from becomes an adapter chosen by `config.board.type`. `github` is what exists today; `markdown` reads a `| id | título | status |` table from a `.md` file in the repo and rewrites only the `status` cell of one row when a task moves. The setup form picks the type and configures either (markdown never calls `gh`). Old `hive.config.json` files with `project` keep working unchanged.

**Architecture:** `src/board.ts` becomes a factory: `createBoard(config, { repo, exec? })` returns `createGithubBoard(...)` from `src/boards/github.ts` (today's `board.ts` moved, `Task.id = String(issue.number)`, plus `setupOptions()`) or `createMarkdownBoard(path, status)` from `src/boards/markdown.ts` (table locator, cell-only rewrite, tmp + rename). `Task.number` becomes `Task.id: string` everywhere (`slugFor` kebab-izes it, `{id}` joins `{number}` in prompts, the UI shows `#<id>`). `server.ts` takes `board` in `POST /setup`, creates a missing markdown file before `resolveFields`, and `GET /setup/columns` receives the whole board in the query and answers `createBoard(...).setupOptions()`. The UI gets a `tipo de board` select with one fieldset per type.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`, `gh` CLI (GitHub adapter only).

**Spec:** `docs/superpowers/specs/2026-09-16-pluggable-boards-design.md` (extends `docs/superpowers/specs/2026-09-15-agent-hive-design.md` and `docs/superpowers/specs/2026-09-16-hive-cli-and-setup-design.md`).

## Global Constraints

- All v1 and setup constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts`, `run.ts`, `hooks-settings.ts`, `state-store.ts` do not change.
- `Task.id` is a string in every adapter (`String(issue.number)` for GitHub, the `id` cell for markdown); `Task.itemId` stays the adapter's internal key (project item id / the same `id`).
- The markdown adapter never caches: every `listQueue` / `setStatus` / `setupOptions` re-reads the file. `setStatus` changes one cell of one line and writes tmp + rename; every other byte is preserved. No file lock.
- `POST /setup` order: `parseConfig` → (markdown: create the file if missing) → `resolveFields` → write `hive.config.json` (tmp + rename) → `configure` / `reconfigure`. The markdown file creation is the only write under `<repo>` allowed before `resolveFields`, and only when the file does not exist.
- Status codes: validation / board errors on `POST /setup` → 400; board failures on listing routes → 502; write / boot failures (including creating the markdown file) → 500.
- `createBoard(config, deps)` needs `deps.repo`. `createServer` defaults `boardFactory` to `(config) => createBoard(config, { repo })`; `test/setup.test.ts` keeps its fake factory and always saves `maxConcurrent: 0`, except one test using the real factory with a markdown board (touches only a local file).
- Legacy `{ "project": { owner, number } }` without `board` parses as `{ type: 'github', owner, number }`; saving from the UI rewrites the file in the new format.
- `pnpm test` must stay green after every task (70 tests today → 85 at the end).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `BoardConfig`, `Task.id: string`, `Config.board`, `SetupBody.board`, `Board` interface (moved here in T2) |
| `src/config.ts` | `parseBoard` (github / markdown / unknown type), legacy `project` → github, `DEFAULT_CONFIG: Omit<Config, 'board'>` |
| `src/boards/github.ts` | new — today's `board.ts` moved: `Exec`, `ghExec`, `listProjects`, `listStatusOptions`, `createGithubBoard` with `setupOptions()` |
| `src/boards/markdown.ts` | new — `markdownPath`, `newBoardText`, `createMarkdownFileIfMissing`, `createMarkdownBoard` |
| `src/board.ts` | factory only: `BoardDeps`, `createBoard(config, deps)` |
| `src/orchestrator.ts` | `slugFor` kebab-izes `task.id` |
| `src/spawn.ts` | `renderPrompt` accepts `{id}`; `{number}` synonym |
| `src/server.ts` | `SetupBody.board`, markdown file creation, `GET /setup/columns` by board, default factory with `repo` |
| `src/hive.ts` | `createBoard(config, { repo })` |
| `src/ui/index.html` | `tipo de board` select, `github-fields` / `markdown-fields` fieldsets, markdown path + columns + datalist, `{id}` hint |
| `src/ui/app.ts` | board type handling, markdown columns loader, `#<id>`, board from form |
| `package.json` | test script also runs `dist/test/boards/*.test.js` |
| `test/config.test.ts` | board github/markdown, unknown type, legacy `project` (7 tests) |
| `test/board.test.ts` | github via `createBoard(config, { repo, exec })`, `setupOptions`, markdown pick (9 tests) |
| `test/boards/markdown.test.ts` | new — 7 tests over files in `mkdtemp` |
| `test/orchestrator.test.ts` | `id` strings, `slugFor` with `T-12` (28 tests) |
| `test/spawn.test.ts` | `id`, `{id}` = `{number}` (7 tests) |
| `test/setup.test.ts` | `BODY.board`, fake `setupOptions`, markdown save + columns (17 tests) |

---

### Task 1: Types and config — `BoardConfig`, `Task.id`, legacy `project`, `number → id` rename

**Files:**
- Modify: `src/types.ts`, `src/config.ts`, `src/board.ts`, `src/orchestrator.ts`, `src/spawn.ts`, `src/server.ts`, `src/ui/app.ts`
- Test: `test/config.test.ts`, `test/board.test.ts`, `test/orchestrator.test.ts`, `test/spawn.test.ts`, `test/setup.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`):
  - `type BoardConfig = { type: 'github'; owner: string; number: number } | { type: 'markdown'; path: string }`
  - `interface Task { itemId: string; id: string; title: string; body: string; url: string }`
  - `interface Config { board: BoardConfig; status: Record<StatusKey, string>; maxConcurrent: number; port: number; claudeArgs: string[]; promptTemplate: string }`
  - `interface SetupBody { board: BoardConfig; status: Record<StatusKey, string>; maxConcurrent: number; promptTemplate?: string }`
- Produces (in `src/config.ts`): `BOARD_TYPES: readonly BoardConfig['type'][]`; `DEFAULT_CONFIG: Omit<Config, 'board'>`; `parseConfig(raw: unknown): Config` — unknown `board.type` → `Error('hive.config.json: "board.type" must be one of: github, markdown')`; `github` needs `board.owner` (non-empty string) and `board.number` (int ≥ 0); `markdown` needs `board.path` (non-empty string); `{ project }` without `board` → github with errors named `project.*`.
- Produces (in `src/orchestrator.ts`): `slugFor(task): string` = `hive-<kebab(id)>-<kebab(title)[:30]>`.
- Produces (in `src/spawn.ts`): `renderPrompt(template, task)` replaces `{id}`, `{number}` (= `{id}`), `{title}`, `{body}`, `{url}`.
- Temporary: `createBoard(config, exec?)` in `src/board.ts` throws for `board.type !== 'github'` (replaced in Tasks 2–3).

- [ ] **Step 1: Rewrite `test/config.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, loadConfigIfPresent, parseConfig } from '../src/config.js';

const GITHUB = { type: 'github', owner: '@me', number: 6 };

test('parseConfig applies defaults on top of a minimal config', () => {
  const config = parseConfig({ board: GITHUB });
  assert.deepEqual(config.status, { queue: 'Ready', working: 'In progress', review: 'In review' });
  assert.equal(config.maxConcurrent, 2);
  assert.equal(config.port, 47821);
  assert.deepEqual(config.claudeArgs, []);
  assert.equal(config.promptTemplate, DEFAULT_CONFIG.promptTemplate);
});

test('parseConfig keeps explicit values', () => {
  const config = parseConfig({
    board: { type: 'github', owner: 'acme', number: 3 },
    status: { queue: 'Todo', working: 'Doing', review: 'Review' },
    maxConcurrent: 4, port: 5000, claudeArgs: ['--model', 'sonnet'], promptTemplate: '{title}',
  });
  assert.equal(config.status.queue, 'Todo');
  assert.equal(config.maxConcurrent, 4);
  assert.deepEqual(config.claudeArgs, ['--model', 'sonnet']);
  assert.equal(config.promptTemplate, '{title}');
});

test('parseConfig accepts a github or a markdown board', () => {
  assert.deepEqual(parseConfig({ board: { type: 'github', owner: 'acme', number: 6 } }).board, { type: 'github', owner: 'acme', number: 6 });
  assert.deepEqual(parseConfig({ board: { type: 'markdown', path: 'docs/board.md' } }).board, { type: 'markdown', path: 'docs/board.md' });
});

test('parseConfig reads the legacy project field as a github board', () => {
  assert.deepEqual(parseConfig({ project: { owner: '@me', number: 9 } }).board, { type: 'github', owner: '@me', number: 9 });
  // an explicit board wins over a leftover project
  const both = parseConfig({ project: { owner: '@me', number: 9 }, board: { type: 'markdown', path: 'b.md' } });
  assert.equal(both.board.type, 'markdown');
});

test('parseConfig rejects missing or wrong-typed fields with the field name', () => {
  assert.throws(() => parseConfig({}), /"board"/);
  assert.throws(() => parseConfig({ board: { type: 'github', owner: '@me' } }), /board\.number/);
  assert.throws(() => parseConfig({ board: { type: 'github', number: 1 } }), /board\.owner/);
  assert.throws(() => parseConfig({ board: { type: 'markdown' } }), /board\.path/);
  assert.throws(() => parseConfig({ board: { type: 'asana', id: 1 } }), /board\.type.*github, markdown/);
  assert.throws(() => parseConfig({ project: { owner: '@me' } }), /project\.number/);
  assert.throws(() => parseConfig({ board: GITHUB, maxConcurrent: '3' }), /maxConcurrent/);
  assert.throws(() => parseConfig({ board: GITHUB, claudeArgs: 'x' }), /claudeArgs/);
  assert.throws(() => parseConfig({ board: GITHUB, status: { queue: 1 } }), /status\.queue/);
});

test('loadConfig reads hive.config.json from the repo, including a legacy project file, and reports a missing file clearly', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  await assert.rejects(loadConfig(repo), /hive\.config\.json/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ project: { owner: '@me', number: 9 } }));
  assert.deepEqual((await loadConfig(repo)).board, { type: 'github', owner: '@me', number: 9 });
});

test('loadConfigIfPresent returns undefined only when the file is missing', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  assert.equal(await loadConfigIfPresent(repo), undefined);
  await writeFile(join(repo, 'hive.config.json'), '{not json');
  await assert.rejects(loadConfigIfPresent(repo), /JSON inválido/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ board: { type: 'markdown', path: 'board.md' } }));
  assert.deepEqual((await loadConfigIfPresent(repo))?.board, { type: 'markdown', path: 'board.md' });
});
```

- [ ] **Step 2: Update `test/board.test.ts`**

Line 6 → `const config = parseConfig({ board: { type: 'github', owner: 'acme', number: 6 } });`
Line 43 → `  const bad = parseConfig({ board: { type: 'github', owner: 'acme', number: 6 }, status: { queue: 'Todo' } });`
Lines 65–68 (expected queue) →

```ts
  assert.deepEqual(queue, [
    { itemId: 'I1', id: '1', title: 'A', body: 'a', url: 'https://github.com/acme/r/issues/1' },
    { itemId: 'I4', id: '4', title: 'C', body: '', url: 'https://github.com/acme/r/issues/4' },
  ]);
```

- [ ] **Step 3: Update `test/orchestrator.test.ts`**

Lines 6–9 →

```ts
const task = (n: number): Task => ({
  itemId: `item${n}`, id: String(n), title: `Task ${n}`, body: `body ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
});
```

Every task `.number` read becomes `.id` with string expectations — exactly these lines:

| line | new content |
|---|---|
| 18 | `  assert.deepEqual(occupied(state).map((s) => s.task?.id), ['1', '2', '3']);` |
| 19 | `  assert.deepEqual(state.queue.map((t) => t.id), ['4', '5']);` |
| 33 | `  assert.deepEqual(state.queue.map((t) => t.id), ['2']);` |
| 49 | `  assert.deepEqual(state.queue.map((t) => t.id), ['3']);` |
| 68 | `  assert.deepEqual(state.queue.map((t) => t.id), ['2']);` |
| 174 | `  assert.equal(state.slots[0].task?.id, '2', 'next task pulled');` |
| 175 | `  assert.deepEqual(state.queue.map((t) => t.id), ['1']);` |
| 196 | `  assert.equal(state.slots[0].task?.id, '2', 'next task pulled via fill');` |
| 197 | `  assert.deepEqual(state.queue.map((t) => t.id), ['1'], 'current task requeued');` |
| 220 | `  assert.equal(once.state.slots[0].task?.id, '2');` |
| 241 | `  assert.equal(state.slots[1].task?.id, '2');` |
| 242 | `  assert.deepEqual(state.queue.map((t) => t.id), ['1']);` |

Append after the `slugFor strips accents…` test:

```ts
test('slugFor kebab-izes the id too, so markdown ids like T-12 work', () => {
  assert.equal(slugFor({ ...task(1), id: 'T-12', title: 'Exemplo' }), 'hive-t-12-exemplo');
  assert.equal(slugFor({ ...task(1), id: 'Épico #3', title: 'x' }), 'hive-epico-3-x');
});
```

- [ ] **Step 4: Update `test/spawn.test.ts`**

Line 8 → `const task = { itemId: 'I1', id: '7', title: 'Fix "login"', body: 'line1\n$(echo pwned) \`x\`', url: 'https://github.com/a/b/issues/7' };` (only `number: 7` → `id: '7'`; keep the body literal as it is in the file).

Append after `renderPrompt substitutes every placeholder`:

```ts
test('renderPrompt renders {id} and {number} the same', () => {
  assert.equal(renderPrompt('{id}={number}', { ...task, id: 'T-12' }), 'T-12=T-12');
});
```

- [ ] **Step 5: Update `test/setup.test.ts`**

Lines 15–19 →

```ts
const BODY: SetupBody = {
  board: { type: 'github', owner: 'acme', number: 6 },
  status: { queue: 'Ready', working: 'In progress', review: 'In review' },
  maxConcurrent: 0, // zero slots: nothing is ever spawned (spawn would open an iTerm tab)
};
```

Line 38 → `        return [{ itemId: 'I1', id: '1', title: \`from ${config.status.queue}\`, body: '', url: 'https://github.com/acme/r/issues/1' }];`
Line 112 → `  assert.deepEqual(info.config?.board, BODY.board);`
Lines 127–133 →

```ts
test('POST /setup with an invalid body answers 400 naming the field', async (t) => {
  const { base, repo } = await start(t);
  const res = await postSetup(base, { ...BODY, board: { type: 'github', owner: 'acme' } });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /board\.number/);
  await assert.rejects(stat(configFile(repo)));
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `'board' does not exist in type 'SetupBody'`, `'id' does not exist in type 'Task'`, `Property 'board' does not exist on type 'Config'`.

- [ ] **Step 7: Edit `src/types.ts`**

Replace the `Task` interface (lines 4–10):

```ts
export type BoardConfig =
  | { type: 'github'; owner: string; number: number }
  | { type: 'markdown'; path: string };

export interface Task {
  itemId: string; // adapter's own key: project item id (GitHub) or the id cell (markdown)
  id: string; // what the user sees and the slug uses: issue number as a string, or the id cell
  title: string;
  body: string;
  url: string;
}
```

Replace line 37 (`project: { owner: string; number: number };` inside `Config`) with `  board: BoardConfig;`.
Replace line 83 (`project: { owner: string; number: number };` inside `SetupBody`) with `  board: BoardConfig;`.

- [ ] **Step 8: Edit `src/config.ts`**

Replace line 3 with `import type { BoardConfig, Config, StatusKey } from './types.js';`.
Replace line 7 with:

```ts
export const BOARD_TYPES: readonly BoardConfig['type'][] = ['github', 'markdown'];

export const DEFAULT_CONFIG: Omit<Config, 'board'> = {
```

Insert before `export function parseConfig` (after `optional`):

```ts
// `field` is how the board appears in error messages: "board" for the current format, "project" for legacy files.
function parseBoard(raw: unknown, field: string): BoardConfig {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  switch (raw.type) {
    case 'github':
      return { type: 'github', owner: requireString(raw.owner, `${field}.owner`), number: requireInt(raw.number, `${field}.number`) };
    case 'markdown':
      return { type: 'markdown', path: requireString(raw.path, `${field}.path`) };
    default:
      throw new Error(`${CONFIG_FILE}: "${field}.type" must be one of: ${BOARD_TYPES.join(', ')}`);
  }
}

// Files written before boards were pluggable have `project: { owner, number }` and no `board`.
function boardFrom(raw: Record<string, unknown>): BoardConfig {
  if (raw.board === undefined && isRecord(raw.project)) return parseBoard({ ...raw.project, type: 'github' }, 'project');
  return parseBoard(raw.board, 'board');
}
```

Replace lines 38–40 (`const project = …`, `const owner = …`, `const number = …`) with `  const board = boardFrom(raw);`.
Replace line 51 (`project: { owner, number },`) with `    board,`.

- [ ] **Step 9: Edit `src/board.ts` (temporary github-only guard, string id)**

Replace line 62 (`const { owner, number } = config.project;`) with:

```ts
  // Task 3 replaces this guard with the markdown adapter
  if (config.board.type !== 'github') throw new Error(`board.type "${config.board.type}" ainda não suportado`);
  const { owner, number } = config.board;
```

Replace line 85 with:

```ts
      return [{ itemId: item.id, id: String(c.number), title: c.title ?? item.title ?? `#${c.number}`, body: c.body ?? '', url: c.url }];
```

- [ ] **Step 10: Edit `slugFor` in `src/orchestrator.ts`** (replace lines 19–25)

```ts
function kebab(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function slugFor(task: Task): string {
  const title = kebab(task.title).slice(0, SLUG_MAX).replace(/-+$/, '');
  return `hive-${kebab(task.id)}-${title}`;
}
```

- [ ] **Step 11: Edit `renderPrompt` in `src/spawn.ts`** (replace lines 20–25)

```ts
export function renderPrompt(template: string, task: Task): string {
  const values: Record<string, string> = {
    id: task.id, number: task.id, title: task.title, body: task.body, url: task.url, // {number} is a synonym of {id}
  };
  return template.replace(/\{(id|number|title|body|url)\}/g, (_, key: string) => values[key]);
}
```

- [ ] **Step 12: Edit `src/server.ts`**

In `saveSetup`, replace `        project: body.project,` with `        board: body.board,`.

- [ ] **Step 13: Edit `src/ui/app.ts`**

Line 66 and line 83: `#${slot.task?.number}` → `#${slot.task?.id}`. Line 103: `#${t.number}` → `#${t.id}`.
Replace `openSetup` (lines 176–185):

```ts
async function openSetup(): Promise<void> {
  const config = setupInfo?.config;
  const github = config?.board.type === 'github' ? config.board : undefined; // markdown fields arrive in Task 5
  document.body.classList.add('setup');
  $<HTMLButtonElement>('cancel').hidden = !setupInfo?.configured;
  $<HTMLInputElement>('owner').value = github?.owner ?? DEFAULT_OWNER;
  $<HTMLInputElement>('max-workers').value = String(config?.maxConcurrent ?? DEFAULT_MAX);
  $<HTMLTextAreaElement>('prompt-template').value = config?.promptTemplate ?? '';
  setupError();
  await loadProjects(github?.number);
}
```

In `saveSetup`, replace `    project: { owner: ownerValue(), number: Number(projectValue) },` with `    board: { type: 'github', owner: ownerValue(), number: Number(projectValue) },`.

- [ ] **Step 14: Run tests to verify they pass**

Run: `pnpm test`
Expected: 74 tests PASS (`config` 7, `orchestrator` 28, `spawn` 7, `setup` 15, `board` 7, others unchanged).

- [ ] **Step 15: Legacy config still boots (manual, `maxConcurrent: 0` in that file)**

```bash
pnpm build && node dist/src/run.js /path/to/configured-repo &
curl -s localhost:47821/setup; echo
kill %1
```
Expected: `"config":{"board":{"type":"github","owner":…,"number":…},…}`; the file on disk still has `project` (not rewritten by boot).

- [ ] **Step 16: Commit**

```bash
git add src/types.ts src/config.ts src/board.ts src/orchestrator.ts src/spawn.ts src/server.ts src/ui/app.ts test/config.test.ts test/board.test.ts test/orchestrator.test.ts test/spawn.test.ts test/setup.test.ts
git commit -m "feat: board config with type, Task.id as string, legacy project accepted"
```

---

### Task 2: GitHub adapter in `src/boards/github.ts`, factory in `src/board.ts`, `setupOptions` (TDD)

**Files:**
- Create: `src/boards/github.ts`
- Modify: `src/board.ts`, `src/types.ts`, `src/server.ts`, `src/hive.ts`
- Test: `test/board.test.ts`, `test/setup.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `interface Board { resolveFields(): Promise<void>; listQueue(): Promise<Task[]>; setStatus(itemId: string, key: StatusKey): Promise<void>; setupOptions(): Promise<string[]> }`
- Produces (in `src/boards/github.ts`): `type Exec = (args: string[]) => Promise<string>`; `ghExec: Exec`; `type GithubBoardConfig = Extract<BoardConfig, { type: 'github' }>`; `listProjects(owner, exec?)`, `listStatusOptions(owner, number, exec?)` unchanged; `createGithubBoard(board: GithubBoardConfig, statusNames: Record<StatusKey, string>, exec?: Exec): Board` with `setupOptions()` = `listStatusOptions(owner, number, exec)`.
- Produces (in `src/board.ts`): `interface BoardDeps { repo: string; exec?: Exec }`; `createBoard(config: Config, deps: BoardDeps): Board` (github only until Task 3).
- Consumed by: Task 3 (factory switch), Task 4 (`setupOptions` route), `hive.ts`, `server.ts`.

- [ ] **Step 1: Write the failing tests**

`test/board.test.ts`: replace lines 3–4 with

```ts
import { createBoard } from '../src/board.js';
import { listProjects, listStatusOptions } from '../src/boards/github.js';
import { parseConfig } from '../src/config.js';

const REPO = '/repo'; // the github adapter never reads it
```

Change the three `createBoard` calls: `createBoard(config, exec)` → `createBoard(config, { repo: REPO, exec })`; `createBoard(bad, fakeExec({…}).exec)` → `createBoard(bad, { repo: REPO, exec: fakeExec({…}).exec })`; `createBoard(config, fakeExec({}).exec)` → `createBoard(config, { repo: REPO, exec: fakeExec({}).exec })`; `createBoard(config, fakeExec({ 'project item-list 6': items }).exec)` → `createBoard(config, { repo: REPO, exec: fakeExec({ 'project item-list 6': items }).exec })`.

Append:

```ts
test('setupOptions on a github board lists the Status option names in board order', async () => {
  const { exec, calls } = fakeExec({ 'project field-list 6': fields });
  assert.deepEqual(await createBoard(config, { repo: REPO, exec }).setupOptions(), ['Ready', 'In progress', 'In review', 'Done']);
  assert.equal(calls.length, 1);
});
```

`test/setup.test.ts`: replace `import type { Board } from '../src/board.js';` with nothing and change the types import to `import type { Board, Config, SetupBody, SetupInfo } from '../src/types.js';`. In `fakeBoardFactory`, after `async setStatus() {},` add:

```ts
      async setupOptions() {
        return OPTIONS;
      },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `Cannot find module '../src/boards/github.js'`, `'Board'` not exported from `types.js`.

- [ ] **Step 3: Add `Board` to `src/types.ts`** (append)

```ts
/** What every board adapter implements; `src/board.ts` picks one by `config.board.type`. */
export interface Board {
  resolveFields(): Promise<void>; // validates the config against the source (options / table exist)
  listQueue(): Promise<Task[]>; // tasks in status.queue, in source order
  setStatus(itemId: string, key: StatusKey): Promise<void>;
  setupOptions(): Promise<string[]>; // status values available, for the setup form
}
```

- [ ] **Step 4: Create `src/boards/github.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Board, BoardConfig, ProjectSummary, StatusKey, Task } from '../types.js';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 20 * 1024 * 1024;
const ITEM_LIMIT = 200;
const PROJECT_LIMIT = 100;
const STATUS_KEYS: StatusKey[] = ['queue', 'working', 'review'];

export type Exec = (args: string[]) => Promise<string>;
export type GithubBoardConfig = Extract<BoardConfig, { type: 'github' }>;

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
interface GhProject { number: number; title: string; url: string; closed?: boolean }
interface GhItem {
  id: string;
  status?: string;
  title?: string;
  content?: { type?: string; number?: number; title?: string; body?: string | null; url?: string };
}
interface StatusField { id: string; options: { id: string; name: string }[] }

function projectArgs(sub: string, owner: string, number: number): string[] {
  return ['project', sub, String(number), '--owner', owner, '--format', 'json'];
}

async function fetchStatusField(owner: string, number: number, exec: Exec): Promise<StatusField> {
  const { fields } = JSON.parse(await exec(projectArgs('field-list', owner, number))) as { fields: GhField[] };
  const status = fields.find((f) => f.name === 'Status' && f.options);
  if (!status?.options) throw new Error('board has no single-select "Status" field');
  return { id: status.id, options: status.options };
}

export async function listProjects(owner: string, exec: Exec = ghExec): Promise<ProjectSummary[]> {
  const { projects } = JSON.parse(
    await exec(['project', 'list', '--owner', owner, '--limit', String(PROJECT_LIMIT), '--format', 'json']),
  ) as { projects: GhProject[] };
  return projects.filter((p) => !p.closed).map(({ number, title, url }) => ({ number, title, url }));
}

export async function listStatusOptions(owner: string, number: number, exec: Exec = ghExec): Promise<string[]> {
  return (await fetchStatusField(owner, number, exec)).options.map((o) => o.name);
}

export function createGithubBoard(board: GithubBoardConfig, statusNames: Record<StatusKey, string>, exec: Exec = ghExec): Board {
  const { owner, number } = board;
  const base = (sub: string) => projectArgs(sub, owner, number);
  let resolved: { projectId: string; statusFieldId: string; optionIds: Record<StatusKey, string> } | undefined;

  async function resolveFields(): Promise<void> {
    const view = JSON.parse(await exec(base('view'))) as { id: string };
    const status = await fetchStatusField(owner, number, exec);
    const available = status.options.map((o) => o.name);
    const optionIds = {} as Record<StatusKey, string>;
    for (const key of STATUS_KEYS) {
      const wanted = statusNames[key];
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
      if (item.status !== statusNames.queue || c?.type !== 'Issue' || typeof c.number !== 'number' || !c.url) return [];
      return [{ itemId: item.id, id: String(c.number), title: c.title ?? item.title ?? `#${c.number}`, body: c.body ?? '', url: c.url }];
    });
  }

  async function setStatus(itemId: string, key: StatusKey): Promise<void> {
    if (!resolved) throw new Error('board not resolved: call resolveFields() first');
    await exec([
      'project', 'item-edit', '--id', itemId, '--project-id', resolved.projectId,
      '--field-id', resolved.statusFieldId, '--single-select-option-id', resolved.optionIds[key],
    ]);
  }

  async function setupOptions(): Promise<string[]> {
    return listStatusOptions(owner, number, exec);
  }

  return { resolveFields, listQueue, setStatus, setupOptions };
}
```

- [ ] **Step 5: Rewrite `src/board.ts`**

```ts
import { createGithubBoard, type Exec } from './boards/github.js';
import type { Board, Config } from './types.js';

export interface BoardDeps {
  repo: string; // markdown resolves a relative path against it (Task 3); github ignores it
  exec?: Exec; // gh runner, injectable for tests
}

export function createBoard(config: Config, deps: BoardDeps): Board {
  // Task 3 replaces this guard with the markdown adapter
  if (config.board.type !== 'github') throw new Error(`board.type "${config.board.type}" ainda não suportado`);
  return createGithubBoard(config.board, config.status, deps.exec);
}
```

- [ ] **Step 6: Adapt `src/server.ts` and `src/hive.ts`**

`src/server.ts` line 8 → two lines:

```ts
import { createBoard } from './board.js';
import { listProjects, listStatusOptions } from './boards/github.js';
```

Add `Board` to the `./types.js` type import: `Board, Config, Effect, EventsPayload, HiveEvent, HookPayload, SetupBody, SetupInfo, SetupResult, Slot, State,`.
Replace line 78 (`const { repo, boardFactory = createBoard } = deps;`) with:

```ts
  const { repo } = deps;
  const boardFactory: BoardFactory = deps.boardFactory ?? ((config) => createBoard(config, { repo }));
```

`src/hive.ts` line 16 → `  const board = createBoard(config, { repo });`

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test`
Expected: 75 tests PASS (`board` 8).

- [ ] **Step 8: Headless regression (manual, configured repo with `maxConcurrent: 0`)**

```bash
pnpm build && node dist/src/run.js /path/to/configured-repo &
curl -s 'localhost:47821/setup/columns?owner=@me&number=6'; echo
kill %1
```
Expected: the Status option names as before (route unchanged until Task 4).

- [ ] **Step 9: Commit**

```bash
git add src/boards/github.ts src/board.ts src/types.ts src/server.ts src/hive.ts test/board.test.ts test/setup.test.ts
git commit -m "refactor: github board adapter in src/boards, factory in board.ts, setupOptions"
```

---

### Task 3: Markdown adapter (TDD)

**Files:**
- Create: `src/boards/markdown.ts`, `test/boards/markdown.test.ts`
- Modify: `src/board.ts`, `package.json`
- Test: `test/board.test.ts` (+1)

**Interfaces:**
- Produces (in `src/boards/markdown.ts`):
  - `type MarkdownBoardConfig = Extract<BoardConfig, { type: 'markdown' }>`
  - `EXPECTED_HEADER = '| id | título | status |'`; `DEFAULT_STATUS_OPTIONS = ['Ready', 'In progress', 'In review', 'Done']`
  - `markdownPath(repo: string, path: string): string` — `resolve(repo, path)` (absolute paths kept)
  - `newBoardText(queueStatus: string): string` — header, separator, `| T-1 | Exemplo | <queueStatus> |`
  - `createMarkdownFileIfMissing(path: string, queueStatus: string): Promise<boolean>` — creates parent dirs, `wx` write; `true` when created, `false` when it existed
  - `createMarkdownBoard(path: string, status: Record<StatusKey, string>): Board` — `path` absolute; errors: `<path> não existe (esperado um arquivo com a tabela | id | título | status |)`, `<path> não tem uma tabela com o cabeçalho | id | título | status |`, `<path>: ids duplicados na tabela: a, b`, `task <id> não encontrada em <path>`
- Produces (in `src/board.ts`): `createBoard` switches on `config.board.type` (`markdown` → `createMarkdownBoard(markdownPath(deps.repo, board.path), config.status)`).
- Consumed by: Task 4 (`createMarkdownFileIfMissing`, `markdownPath`, `newBoardText` in tests).

- [ ] **Step 1: Write the failing tests — `test/boards/markdown.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkdownBoard, createMarkdownFileIfMissing, newBoardText } from '../../src/boards/markdown.js';
import type { StatusKey } from '../../src/types.js';

const STATUS: Record<StatusKey, string> = { queue: 'Ready', working: 'In progress', review: 'In review' };
const HEADER = '| id | título | status |';

const BOARD = `# Board do projeto

Uma tabela que não é o board:

| coluna | valor |
|--------|-------|
| x      | 1     |

| prioridade | id   | Título          | status      | dono |
|------------|------|-----------------|-------------|------|
| alta       | T-1  | Primeira tarefa | In progress | ana  |
| média      | T-2  | Segunda tarefa  | Ready       |      |
|            |      | linha sem id    | Ready       |      |
| baixa      | T-3  | Terceira        | Ready       | bia  |

## T-2 Segunda tarefa

Descrição da T-2, com \`| pipes |\` no meio e   espaços   preservados.
`;

async function boardFile(text = BOARD): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'hive-md-')), 'board.md');
  await writeFile(path, text);
  return path;
}

test('listQueue finds the table amid other content, with extra columns and a Portuguese header, in file order', async () => {
  const path = await boardFile();
  const board = createMarkdownBoard(path, STATUS);
  await board.resolveFields();
  assert.deepEqual(await board.listQueue(), [
    { itemId: 'T-2', id: 'T-2', title: 'Segunda tarefa', body: '', url: path },
    { itemId: 'T-3', id: 'T-3', title: 'Terceira', body: '', url: path },
  ]);
});

test('setStatus rewrites only the status cell of that row; the rest of the file is byte for byte the same', async () => {
  const path = await boardFile();
  await createMarkdownBoard(path, STATUS).setStatus('T-2', 'working');
  const before = '| média      | T-2  | Segunda tarefa  | Ready       |      |';
  const after = '| média      | T-2  | Segunda tarefa  | In progress       |      |'; // cell padding kept
  assert.ok(BOARD.includes(before), 'fixture row present');
  assert.equal(await readFile(path, 'utf8'), BOARD.replace(before, after));
  assert.deepEqual((await createMarkdownBoard(path, STATUS).listQueue()).map((t) => t.id), ['T-3']);
});

test('setStatus rejects an id that is not in the table', async () => {
  const path = await boardFile();
  await assert.rejects(createMarkdownBoard(path, STATUS).setStatus('T-9', 'queue'), { message: `task T-9 não encontrada em ${path}` });
});

test('duplicate ids are rejected by resolveFields and listQueue, naming them', async () => {
  const path = await boardFile(BOARD.replace('| baixa      | T-3  |', '| baixa      | T-2  |'));
  const board = createMarkdownBoard(path, STATUS);
  await assert.rejects(board.resolveFields(), /ids duplicados.*T-2/);
  await assert.rejects(board.listQueue(), /ids duplicados.*T-2/);
});

test('resolveFields fails naming the path and the expected header when the table or the file is missing', async () => {
  const path = await boardFile('# só texto\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  await assert.rejects(createMarkdownBoard(path, STATUS).resolveFields(), (err: Error) => {
    assert.ok(err.message.includes(path) && err.message.includes(HEADER), err.message);
    return true;
  });
  const missing = join(path, '..', 'nope.md');
  await assert.rejects(createMarkdownBoard(missing, STATUS).resolveFields(), (err: Error) => {
    assert.ok(err.message.includes(missing) && err.message.includes(HEADER), err.message);
    return true;
  });
});

test('setupOptions lists the statuses in the file first, then the defaults not yet present', async () => {
  const path = await boardFile();
  assert.deepEqual(await createMarkdownBoard(path, STATUS).setupOptions(), ['In progress', 'Ready', 'In review', 'Done']);
});

test('createMarkdownFileIfMissing writes the header and an example row once and never overwrites', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'hive-md-')), 'docs', 'board.md');
  assert.equal(await createMarkdownFileIfMissing(path, 'Ready'), true);
  assert.equal(await readFile(path, 'utf8'), `${HEADER}\n|---|---|---|\n| T-1 | Exemplo | Ready |\n`);
  assert.equal(await createMarkdownFileIfMissing(path, 'Todo'), false);
  assert.equal(await readFile(path, 'utf8'), newBoardText('Ready'));
  const board = createMarkdownBoard(path, STATUS);
  await board.resolveFields();
  assert.deepEqual((await board.listQueue()).map((t) => t.id), ['T-1']);
});
```

Append to `test/board.test.ts` (add `import { mkdtemp, writeFile } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';` at the top):

```ts
test('createBoard picks the markdown adapter by type and resolves the path against the repo', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  await writeFile(join(repo, 'board.md'), '| id | título | status |\n|---|---|---|\n| T-1 | Exemplo | Ready |\n');
  const board = createBoard(parseConfig({ board: { type: 'markdown', path: 'board.md' } }), { repo });
  await board.resolveFields();
  assert.deepEqual((await board.listQueue()).map((t) => [t.id, t.url]), [['T-1', join(repo, 'board.md')]]);
});
```

`package.json`: `"test": "pnpm build && node --test \"dist/test/*.test.js\" \"dist/test/boards/*.test.js\"",`

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error `Cannot find module '../../src/boards/markdown.js'`.

- [ ] **Step 3: Create `src/boards/markdown.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Board, BoardConfig, StatusKey, Task } from '../types.js';

export type MarkdownBoardConfig = Extract<BoardConfig, { type: 'markdown' }>;

export const EXPECTED_HEADER = '| id | título | status |';
/** Always offered in the setup form, after whatever the file already uses. */
export const DEFAULT_STATUS_OPTIONS = ['Ready', 'In progress', 'In review', 'Done'];
const TITLE_HEADERS = ['titulo', 'title'];
const SEPARATOR_CELL = /^\s*:?-+:?\s*$/;

interface Columns { id: number; title: number; status: number }
interface Row { lineIndex: number; id: string; title: string; status: string }
interface Table { lines: string[]; columns: Columns; rows: Row[] }
interface SplitLine { head: string; cells: string[]; tail: string }

/** Relative paths are resolved against the repo; absolute paths are kept. */
export function markdownPath(repo: string, path: string): string {
  return resolve(repo, path);
}

/** Header, separator and one example row in the queue column. */
export function newBoardText(queueStatus: string): string {
  return `${EXPECTED_HEADER}\n|---|---|---|\n| T-1 | Exemplo | ${queueStatus} |\n`;
}

/** Creates the file when it does not exist (parents included); resolves true when created. Never touches an existing file. */
export async function createMarkdownFileIfMissing(path: string, queueStatus: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, newBoardText(queueStatus), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

const isTableLine = (line: string): boolean => line.trimStart().startsWith('|');

// Splits `| a | b |` into raw cells, keeping the text before the first pipe and from the closing pipe on,
// so the line can be rebuilt byte for byte after one cell changes. ponytail: `\|` inside a cell is not handled.
function splitLine(line: string): SplitLine {
  const first = line.indexOf('|');
  const end = line.trimEnd();
  const last = end.endsWith('|') && end.length - 1 > first ? end.length - 1 : line.length;
  return { head: line.slice(0, first + 1), cells: line.slice(first + 1, last).split('|'), tail: line.slice(last) };
}

const joinLine = ({ head, cells, tail }: SplitLine): string => head + cells.join('|') + tail;

const isSeparator = (line: string): boolean => isTableLine(line) && splitLine(line).cells.every((c) => SEPARATOR_CELL.test(c));

const normalizeHeader = (cell: string): string => cell.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

function findColumns(headerCells: string[]): Columns | undefined {
  const names = headerCells.map(normalizeHeader);
  const columns = { id: names.indexOf('id'), title: names.findIndex((n) => TITLE_HEADERS.includes(n)), status: names.indexOf('status') };
  return columns.id >= 0 && columns.title >= 0 && columns.status >= 0 ? columns : undefined;
}

const cellText = (cells: string[], index: number): string => (cells[index] ?? '').trim();

function readRows(lines: string[], start: number, columns: Columns): Row[] {
  const rows: Row[] = [];
  for (let i = start; i < lines.length && isTableLine(lines[i]); i++) {
    const cells = splitLine(lines[i]).cells;
    const id = cellText(cells, columns.id);
    if (id === '') continue;
    rows.push({ lineIndex: i, id, title: cellText(cells, columns.title), status: cellText(cells, columns.status) });
  }
  return rows;
}

/** The first table whose header has id, título/title and status columns (any order, extra columns allowed). */
function parseTable(text: string): Table | undefined {
  const lines = text.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isTableLine(lines[i]) || !isSeparator(lines[i + 1])) continue;
    const columns = findColumns(splitLine(lines[i]).cells);
    if (columns) return { lines, columns, rows: readRows(lines, i + 2, columns) };
  }
  return undefined;
}

function duplicateIds(rows: Row[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const { id } of rows) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

// Replaces the text of a cell keeping its padding; an all-blank cell gets one space each side.
function replaceCell(cell: string, value: string): string {
  const content = cell.trim();
  if (content === '') return ` ${value} `;
  const start = cell.indexOf(content);
  return cell.slice(0, start) + value + cell.slice(start + content.length);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

export function createMarkdownBoard(path: string, status: Record<StatusKey, string>): Board {
  // Always re-reads: the file is edited by hand too. No cache, no lock (single user, local).
  async function loadTable(): Promise<Table> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${path} não existe (esperado um arquivo com a tabela ${EXPECTED_HEADER})`);
      throw err;
    }
    const table = parseTable(text);
    if (!table) throw new Error(`${path} não tem uma tabela com o cabeçalho ${EXPECTED_HEADER}`);
    const dupes = duplicateIds(table.rows);
    if (dupes.length > 0) throw new Error(`${path}: ids duplicados na tabela: ${dupes.join(', ')}`);
    return table;
  }

  async function resolveFields(): Promise<void> {
    await loadTable();
  }

  async function listQueue(): Promise<Task[]> {
    const { rows } = await loadTable();
    return rows.filter((r) => r.status === status.queue).map((r) => ({ itemId: r.id, id: r.id, title: r.title, body: '', url: path }));
  }

  async function setStatus(itemId: string, key: StatusKey): Promise<void> {
    const { lines, columns, rows } = await loadTable();
    const row = rows.find((r) => r.id === itemId);
    if (!row) throw new Error(`task ${itemId} não encontrada em ${path}`);
    const split = splitLine(lines[row.lineIndex]);
    const cells = split.cells.map((cell, i) => (i === columns.status ? replaceCell(cell, status[key]) : cell));
    const updated = lines.map((line, i) => (i === row.lineIndex ? joinLine({ ...split, cells }) : line));
    await writeAtomic(path, updated.join('\n'));
  }

  async function setupOptions(): Promise<string[]> {
    const { rows } = await loadTable();
    return [...new Set([...rows.map((r) => r.status).filter((s) => s !== ''), ...DEFAULT_STATUS_OPTIONS])];
  }

  return { resolveFields, listQueue, setStatus, setupOptions };
}
```

- [ ] **Step 4: Rewrite `src/board.ts`**

```ts
import { createGithubBoard, type Exec } from './boards/github.js';
import { createMarkdownBoard, markdownPath } from './boards/markdown.js';
import type { Board, Config } from './types.js';

export interface BoardDeps {
  repo: string; // markdown resolves a relative path against it; github ignores it
  exec?: Exec; // gh runner, injectable for tests
}

export function createBoard(config: Config, deps: BoardDeps): Board {
  const { board, status } = config;
  switch (board.type) {
    case 'github':
      return createGithubBoard(board, status, deps.exec);
    case 'markdown':
      return createMarkdownBoard(markdownPath(deps.repo, board.path), status);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 83 tests PASS (`boards/markdown` 7, `board` 9).

- [ ] **Step 6: Commit**

```bash
git add src/boards/markdown.ts src/board.ts package.json test/boards/markdown.test.ts test/board.test.ts
git commit -m "feat: markdown board adapter and factory by board type"
```

---

### Task 4: Server — `POST /setup` with `board`, markdown file creation, `GET /setup/columns` by board (TDD)

**Files:**
- Modify: `src/server.ts`
- Test: `test/setup.test.ts`

**Interfaces:**
- Routes: `POST /setup` body `{ board: BoardConfig, status, maxConcurrent, promptTemplate? }`; `GET /setup/columns?type=github&owner=&number=` or `?type=markdown&path=` → `string[]` from `boardFactory(parseConfig({ board })).setupOptions()`; 400 names the field (`board.type`, `board.owner`, `board.number`, `board.path`); board failure → 502.
- `GET /setup` unchanged (already returns `config.board`).
- Consumed by: Task 5 (UI).

- [ ] **Step 1: Write the failing tests**

In `test/setup.test.ts` add `import { newBoardText } from '../src/boards/markdown.js';` after the `DEFAULT_CONFIG` import. Replace the `setup listings reject a missing owner or number with 400` test with:

```ts
test('setup listings reject a missing owner, number, path or type with 400 naming the field', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/setup/projects`)).status, 400);
  const noNumber = await fetch(`${base}/setup/columns?type=github&owner=acme`);
  assert.equal(noNumber.status, 400);
  assert.match((await json<{ error: string }>(noNumber)).error, /board\.number/);
  const noPath = await fetch(`${base}/setup/columns?type=markdown`);
  assert.equal(noPath.status, 400);
  assert.match((await json<{ error: string }>(noPath)).error, /board\.path/);
  const noType = await fetch(`${base}/setup/columns?owner=acme&number=6`);
  assert.equal(noType.status, 400);
  assert.match((await json<{ error: string }>(noType)).error, /board\.type/);
});
```

Append:

```ts
test('GET /setup/columns builds the board from the query and answers its setupOptions', async (t) => {
  const { base, configs } = await start(t);
  assert.deepEqual(await json(fetch(`${base}/setup/columns?type=markdown&path=board.md`)), OPTIONS);
  assert.deepEqual(configs.at(-1)?.board, { type: 'markdown', path: 'board.md' });
  assert.deepEqual(await json(fetch(`${base}/setup/columns?type=github&owner=acme&number=6`)), OPTIONS);
  assert.deepEqual(configs.at(-1)?.board, { type: 'github', owner: 'acme', number: 6 });
});

test('POST /setup with a markdown board creates the file and boots the queue from it (real factory, no gh)', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-setup-'));
  const server = createServer({ repo }); // default factory: the markdown adapter only touches a local file
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const body: SetupBody = { ...BODY, board: { type: 'markdown', path: 'docs/board.md' } };
  const file = join(repo, 'docs', 'board.md');
  assert.equal((await postSetup(base, body)).status, 200);
  assert.equal(await readFile(file, 'utf8'), newBoardText('Ready'));
  assert.deepEqual(server.getState()?.queue.map((task) => [task.id, task.title, task.url]), [['T-1', 'Exemplo', file]]);
  assert.deepEqual((await json<SetupInfo>(fetch(`${base}/setup`))).config?.board, body.board);
  // an existing file is never rewritten by setup, and its statuses feed the columns route
  await writeFile(file, '| id | título | status |\n|---|---|---|\n| T-7 | Só esta | Todo |\n');
  assert.equal((await postSetup(base, body)).status, 200);
  assert.deepEqual(server.getState()?.queue, []);
  assert.deepEqual(await json(fetch(`${base}/setup/columns?type=markdown&path=docs/board.md`)), ['Todo', 'Ready', 'In progress', 'In review', 'Done']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: `setup listings…` fails (`board.number` not in `owner e number obrigatórios`); `GET /setup/columns builds…` gets 400; the markdown save test fails with 400 (`resolveFields`: file does not exist).

- [ ] **Step 3: Edit `src/server.ts`**

Add after the `./boards/github.js` import:

```ts
import { createMarkdownFileIfMissing, markdownPath } from './boards/markdown.js';
```

Add after `promptTemplateFrom`:

```ts
// Query values are strings: `number` is converted, the rest goes to parseConfig as is so it names the bad field.
function boardFromQuery(query: Request['query']): Record<string, unknown> {
  const { type, owner, number, path } = query;
  return { type, owner, path, number: typeof number === 'string' && number !== '' ? Number(number) : number };
}
```

Replace the whole `app.get('/setup/columns', …)` handler with:

```ts
  app.get('/setup/columns', async (req: Request, res: Response) => {
    let config: Config;
    try {
      config = parseConfig({ board: boardFromQuery(req.query) }); // defaults fill the rest; only the board matters here
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    try {
      res.json(await boardFactory(config).setupOptions());
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });
```

Replace `saveSetup` with:

```ts
  async function saveSetup(body: Partial<SetupBody>, res: Response): Promise<void> {
    let config: Config;
    try {
      const current = await loadConfigIfPresent(repo);
      config = parseConfig({
        board: body.board,
        status: body.status,
        maxConcurrent: body.maxConcurrent,
        port: current?.port,
        claudeArgs: current?.claudeArgs,
        promptTemplate: promptTemplateFrom(body, current),
      });
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    // The only write allowed before validation: a markdown board that does not exist yet gets the header and an example row.
    if (config.board.type === 'markdown') {
      try {
        await createMarkdownFileIfMissing(markdownPath(repo, config.board.path), config.status.queue);
      } catch (err) {
        res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
        return;
      }
    }
    try {
      await boardFactory(config).resolveFields(); // validates against the real board before the config is written
    } catch (err) {
      res.status(HTTP_BAD_REQUEST).json({ error: errorMessage(err) });
      return;
    }
    try {
      await writeConfigFile(config);
      await (live ? reconfigure(config) : configure(config));
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
      return;
    }
    const result: SetupResult = config.port === boundPort ? { ok: true } : { ok: true, restartForPort: config.port };
    res.json(result);
  }
```

Remove `listStatusOptions` from the `./boards/github.js` import (now unused): `import { listProjects } from './boards/github.js';`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 85 tests PASS (`setup` 17).

- [ ] **Step 5: Headless markdown flow (manual, no gh)**

```bash
rm -rf /tmp/hive-md-repo && mkdir /tmp/hive-md-repo && git -C /tmp/hive-md-repo init -q
pnpm build && node dist/src/run.js /tmp/hive-md-repo &
curl -s 'localhost:47821/setup/columns?type=markdown&path=board.md'; echo
curl -s -X POST localhost:47821/setup -H 'content-type: application/json' \
  -d '{"board":{"type":"markdown","path":"board.md"},"status":{"queue":"Ready","working":"In progress","review":"In review"},"maxConcurrent":0}'; echo
cat /tmp/hive-md-repo/board.md /tmp/hive-md-repo/hive.config.json
curl -s 'localhost:47821/setup/columns?type=markdown&path=board.md'; echo
kill %1
```
Expected, in order: `502 {"error":"/tmp/hive-md-repo/board.md não existe (…)"}`; `{"ok":true}`; the three-line table with `| T-1 | Exemplo | Ready |` and a config with `"board":{"type":"markdown","path":"board.md"}`; `["Ready","In progress","In review","Done"]`.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/setup.test.ts
git commit -m "feat: setup routes take a board config; markdown file created on first save"
```

---

### Task 5: Setup form — board type select, markdown fields

**Files:**
- Modify: `src/ui/index.html`, `src/ui/app.ts`

**Interfaces:**
- Consumes (type-only): `BoardConfig`, `SetupBody.board`, `Task.id`, routes from Task 4.
- DOM ids added: `board-type`, `github-fields` (fieldset), `markdown-fields` (fieldset, starts `disabled`), `md-path`, `load-columns`, `md-queue`, `md-working`, `md-review`, `md-options` (datalist). A disabled fieldset is hidden by CSS and skipped by form validation.

- [ ] **Step 1: Edit `src/ui/index.html`**

Add to the `<style>` block, after the `#setup .row button` rule:

```css
  #setup fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  #setup fieldset[disabled] { display: none; }
```

Replace the form from `<h2>configuração do board</h2>` through the `<div class="hint">placeholders…</div>` line with:

```html
  <h2>configuração do board</h2>
  <label>tipo de board
    <select id="board-type">
      <option value="github">GitHub Project</option>
      <option value="markdown">arquivo markdown no repo</option>
    </select>
  </label>
  <fieldset id="github-fields">
    <div class="row">
      <label>owner <input id="owner" type="text" value="@me" required></label>
      <button type="button" id="load-projects">carregar</button>
    </div>
    <label>project <select id="project" required><option value="">carregue os projects do owner</option></select></label>
    <label>coluna da fila <select id="col-queue" required></select></label>
    <label>coluna em andamento <select id="col-working" required></select></label>
    <label>coluna em review <select id="col-review" required></select></label>
  </fieldset>
  <fieldset id="markdown-fields" disabled>
    <div class="row">
      <label>caminho (relativo ao repo) <input id="md-path" type="text" value="board.md" required></label>
      <button type="button" id="load-columns">carregar</button>
    </div>
    <div class="hint">tabela <code>| id | título | status |</code>; se o arquivo não existe, é criado ao salvar. "carregar" lista os status já usados no arquivo.</div>
    <label>coluna da fila <input id="md-queue" type="text" list="md-options" value="Ready" required></label>
    <label>coluna em andamento <input id="md-working" type="text" list="md-options" value="In progress" required></label>
    <label>coluna em review <input id="md-review" type="text" list="md-options" value="In review" required></label>
    <datalist id="md-options"></datalist>
  </fieldset>
  <label>máx. workers <input id="max-workers" type="number" min="0" step="1" value="2" required></label>
  <label>prompt do worker <textarea id="prompt-template" rows="4" spellcheck="false" placeholder="vazio = padrão: Task #{number}: {title}, o body do issue e a instrução de abrir PR com gh pr create"></textarea></label>
  <div class="hint">placeholders: <code>{id}</code> <code>{title}</code> <code>{body}</code> <code>{url}</code> (<code>{number}</code> é sinônimo de <code>{id}</code>) — ex.: <code>/ship #{id}</code>. Vazio mantém o atual. No markdown, <code>{body}</code> é vazio e <code>{url}</code> é o caminho do arquivo.</div>
```

- [ ] **Step 2: Edit `src/ui/app.ts`**

Replace line 1 with:

```ts
import type { BoardConfig, EventsPayload, ProjectSummary, SetupBody, SetupInfo, SetupResult, Slot, State, StatusKey, Task } from '../types.js';
```

After `const COLUMN_SELECT …` add:

```ts
const MARKDOWN_INPUT: Record<StatusKey, string> = { queue: 'md-queue', working: 'md-working', review: 'md-review' };
const DEFAULT_MARKDOWN_PATH = 'board.md';

type BoardType = BoardConfig['type'];
```

In `renderDetail`, replace the `slot.task?.url ? … : ''` line with `    slot.task ? taskLink(slot.task) : '',` and add before `renderDetail`:

```ts
function taskLink(task: Task): string {
  // GitHub tasks link to the issue; markdown tasks carry the board file path, which is not a browsable URL
  return task.url.startsWith('http')
    ? `<div class="meta"><a href="${esc(task.url)}" target="_blank" rel="noreferrer">issue</a></div>`
    : `<div class="meta">board: ${esc(task.url)}</div>`;
}
```

Replace everything from `function ownerValue()` through the end of `saveSetup` with:

```ts
function ownerValue(): string {
  return $<HTMLInputElement>('owner').value.trim();
}

function markdownPathValue(): string {
  return $<HTMLInputElement>('md-path').value.trim();
}

function boardType(): BoardType {
  return $<HTMLSelectElement>('board-type').value as BoardType;
}

// A disabled fieldset is hidden by CSS and skipped by form validation, so only the visible fields count.
function applyBoardType(): void {
  const type = boardType();
  $<HTMLFieldSetElement>('github-fields').disabled = type !== 'github';
  $<HTMLFieldSetElement>('markdown-fields').disabled = type !== 'markdown';
}

function columnsUrl(board: BoardConfig): string {
  const params = new URLSearchParams(
    board.type === 'github' ? { type: board.type, owner: board.owner, number: String(board.number) } : { type: board.type, path: board.path },
  );
  return `/setup/columns?${params.toString()}`;
}

async function loadColumns(): Promise<void> {
  const owner = ownerValue();
  const number = $<HTMLSelectElement>('project').value;
  if (!owner || !number) return;
  setupError();
  try {
    const options = await getJson<string[]>(columnsUrl({ type: 'github', owner, number: Number(number) }));
    const current = setupInfo?.config;
    for (const key of STATUS_KEYS) {
      const wanted = current && options.includes(current.status[key]) ? current.status[key] : PRESELECT[key];
      fillSelect($(COLUMN_SELECT[key]), options.map((o) => ({ value: o, label: o })), wanted);
    }
  } catch (err) {
    setupError((err as Error).message);
  }
}

// Fills the datalist behind the three markdown text fields with the statuses the file already uses.
async function loadMarkdownColumns(): Promise<void> {
  const path = markdownPathValue();
  if (!path) {
    setupError('informe o caminho do arquivo');
    return;
  }
  setupError();
  try {
    const options = await getJson<string[]>(columnsUrl({ type: 'markdown', path }));
    $('md-options').innerHTML = options.map((o) => `<option value="${esc(o)}"></option>`).join('');
  } catch (err) {
    setupError((err as Error).message);
  }
}

async function loadProjects(selectedNumber?: number): Promise<void> {
  const owner = ownerValue();
  if (!owner) {
    setupError('informe o owner (@me, usuário ou org)');
    return;
  }
  setupError();
  try {
    const projects = await getJson<ProjectSummary[]>(`/setup/projects?owner=${encodeURIComponent(owner)}`);
    fillSelect(
      $('project'),
      projects.map((p) => ({ value: String(p.number), label: `#${p.number} ${p.title}` })),
      selectedNumber === undefined ? undefined : String(selectedNumber),
    );
    if (projects.length === 0) {
      setupError(`nenhum project aberto em ${owner}`);
      return;
    }
    await loadColumns();
  } catch (err) {
    setupError((err as Error).message);
  }
}

async function openSetup(): Promise<void> {
  const config = setupInfo?.config;
  const board = config?.board;
  document.body.classList.add('setup');
  $<HTMLButtonElement>('cancel').hidden = !setupInfo?.configured;
  $<HTMLSelectElement>('board-type').value = board?.type ?? 'github';
  applyBoardType();
  $<HTMLInputElement>('owner').value = board?.type === 'github' ? board.owner : DEFAULT_OWNER;
  $<HTMLInputElement>('md-path').value = board?.type === 'markdown' ? board.path : DEFAULT_MARKDOWN_PATH;
  for (const key of STATUS_KEYS) $<HTMLInputElement>(MARKDOWN_INPUT[key]).value = config?.status[key] ?? PRESELECT[key];
  $('md-options').innerHTML = '';
  $<HTMLInputElement>('max-workers').value = String(config?.maxConcurrent ?? DEFAULT_MAX);
  $<HTMLTextAreaElement>('prompt-template').value = config?.promptTemplate ?? '';
  setupError();
  if (board?.type !== 'markdown') await loadProjects(board?.type === 'github' ? board.number : undefined);
}

function closeSetup(): void {
  document.body.classList.remove('setup');
}

function boardFromForm(): BoardConfig | undefined {
  if (boardType() === 'markdown') {
    const path = markdownPathValue();
    return path ? { type: 'markdown', path } : undefined;
  }
  const project = $<HTMLSelectElement>('project').value;
  return project ? { type: 'github', owner: ownerValue(), number: Number(project) } : undefined;
}

function statusFromForm(): Record<StatusKey, string> {
  const ids = boardType() === 'markdown' ? MARKDOWN_INPUT : COLUMN_SELECT;
  const read = (key: StatusKey): string => $<HTMLInputElement | HTMLSelectElement>(ids[key]).value.trim();
  return { queue: read('queue'), working: read('working'), review: read('review') };
}

async function saveSetup(): Promise<void> {
  const board = boardFromForm();
  if (!board) {
    setupError(boardType() === 'markdown' ? 'informe o caminho do arquivo' : 'escolha um project');
    return;
  }
  const body: SetupBody = {
    board,
    status: statusFromForm(),
    maxConcurrent: Number($<HTMLInputElement>('max-workers').value),
    promptTemplate: $<HTMLTextAreaElement>('prompt-template').value,
  };
  const save = $<HTMLButtonElement>('save');
  save.disabled = true;
  setupError();
  try {
    const result = await postJson<SetupResult>('/setup', body);
    setupInfo = await getJson<SetupInfo>('/setup');
    closeSetup();
    showNotice(result.restartForPort ? `reinicie o Hive pra usar a porta ${result.restartForPort}` : undefined);
  } catch (err) {
    setupError((err as Error).message);
  } finally {
    save.disabled = false;
  }
}
```

In the events section, after `$('load-projects').addEventListener(…)` add:

```ts
$('board-type').addEventListener('change', applyBoardType);
$('load-columns').addEventListener('click', () => void loadMarkdownColumns());
```

- [ ] **Step 3: Build and run the tests**

Run: `pnpm test`
Expected: 85 tests PASS (UI compiles under `strict`).

- [ ] **Step 4: Check the form in a browser (manual)**

```bash
rm -rf /tmp/hive-md-repo && mkdir /tmp/hive-md-repo && git -C /tmp/hive-md-repo init -q
pnpm build && node dist/src/run.js /tmp/hive-md-repo
```
Open `http://127.0.0.1:47821/`. Expected: form visible with `tipo de board` = GitHub Project and the owner/project fields; switching to `arquivo markdown no repo` hides them and shows `caminho` = `board.md` plus three text fields `Ready` / `In progress` / `In review`. "carregar" before saving shows the `não existe` message inside the form (fields keep working). Save with `máx. workers` = 0: form hides, queue panel shows `#T-1 Exemplo`, `/tmp/hive-md-repo/board.md` exists. "carregar" now (via "configurar") offers `Ready`, `In progress`, `In review`, `Done` as suggestions; "configurar" preselects the markdown type and the current path. Click a card later (Task 6) shows `board: /tmp/hive-md-repo/board.md` as text, not a link.

- [ ] **Step 5: Commit**

```bash
git add src/ui/index.html src/ui/app.ts
git commit -m "feat: setup form picks the board type with markdown path and columns"
```

---

### Task 6: Acceptance per the spec's "Critério de pronto"

**Files:**
- Modify: only what the run reveals (fixes to `src/` outside the UI come with a test).

**Interfaces:**
- Consumes everything from Tasks 1–5. No new exports.

- [ ] **Step 1: Criterion 1 — markdown board, one worker, only the cell changes**

```bash
rm -rf /tmp/hive-md-repo && mkdir /tmp/hive-md-repo && cd /tmp/hive-md-repo && git init -q
cat > board.md <<'EOF'
# Tarefas

| id  | título              | status |
|-----|---------------------|--------|
| T-1 | Criar README        | Ready  |
| T-2 | Adicionar .gitignore | Ready  |

## T-1 Criar README

Escreva um README curto explicando o repo.

## T-2 Adicionar .gitignore

Node padrão.
EOF
git add board.md && git commit -qm "board" && pnpm --dir /Users/dennysazevedo/Workspace/agent-hive build && hive
```
Expected: the window opens on the form. Pick `arquivo markdown no repo`, keep `board.md` and the three defaults, set `máx. workers` = 1, `prompt do worker` = `/seu-command #{id}` (any slash command; the point is the argument), save. The dashboard shows the queue with `#T-1 Criar README` first; one iTerm tab opens running `claude --worktree=hive-t-1-criar-readme … "/seu-command #T-1"`; the card reads `#T-1 Criar README`. `git -C /tmp/hive-md-repo diff` shows exactly one changed line: `| T-1 | Criar README        | Ready  |` → `| T-1 | Criar README        | In progress  |` (padding kept, description untouched). Kill the worker from the card: the row goes back to `Ready` and, with 1 slot free, `T-2` starts (its row goes to `In progress`); kill it too, then set `máx. workers` to 0. Close the window.

- [ ] **Step 2: Criterion 2 — legacy config keeps working**

Use a repo whose `hive.config.json` still has `"project": { … }` and set `"maxConcurrent": 0` in it by hand. `cd` there and run `hive`.
Expected: the dashboard opens directly with that project's queue (no edit needed). "configurar" preselects `GitHub Project`, the owner and the project; save without changes: the file now has `"board": { "type": "github", … }` and no `project`, `port` / `claudeArgs` / `promptTemplate` preserved.

- [ ] **Step 3: Criterion 3 — tests**

Run: `pnpm test`
Expected: 85 tests PASS.

- [ ] **Step 4: Commit**

If fixes were needed, commit them with the results in the body; otherwise record the results in an empty commit:

```bash
git add -A
git commit --allow-empty -m "chore: pluggable boards acceptance

Critério 1 (markdown: fila, worker com #T-1, só a célula muda): <pass/fail>
Critério 2 (config legado com project): <pass/fail>
Critério 3 (pnpm test, 85 testes): <pass/fail>"
```

---

## Self-review notes

**Spec coverage (section → task):**
- Decisões fechadas: one adapter per file + factory (T2, T3); `board: { type, … }` with legacy `project` (T1, tested); `Task.id: string` (T1); table format and cell-only rewrite (T3, byte-for-byte test); setup select and no `gh` for markdown (T5, T4 real-factory test).
- Config: `board.type` validation naming the field, github/markdown fields, `status.*` for both, legacy read and rewritten on save, other fields unchanged (T1 `parseBoard`, T4 `saveSetup`, tested in `config.test.ts` and `setup.test.ts`).
- Tipos: `BoardConfig`, `Task` (T1); `Task.id` per adapter (T2 github, T3 markdown); slug kebab-izes the id (T1, `T-12` test); `{id}` with `{number}` synonym, markdown `{body}` = `''` and `{url}` = absolute path (T1 spawn, T3 `listQueue`); UI `#<id>` (T1, T5).
- Interface `Board` with `setupOptions` (T2 in `types.ts`); `createBoard(config, deps)` (T2/T3); `listProjects` only in the github adapter and `GET /setup/projects` calls it directly (T2); `GET /setup/columns` takes the whole board (T4, tested).
- Adapter markdown: table location rules, parse (trim, empty id skipped, duplicates rejected with ids), `listQueue` order/url/body, `setStatus` re-read + cell-only + tmp/rename + missing id error, `resolveFields` errors with path and header, `setupOptions` union and order, creation with example row only when missing, no lock (T3, 7 tests).
- Adapter github moved with `id = String(number)` and `setupOptions` (T2, tested).
- Setup UI and routes: type select with default/current type, github fields as today, markdown path + columns + "carregar", shared `máx. workers` and prompt (T5); `POST /setup` body and order, `GET /setup` with `board` (T4, tested); switching type with live workers → `setStatus` failure becomes a banner (existing `fail()` path in `runEffect`, unchanged).
- Testes: every listed file and case (T1–T4); `test/boards/markdown.test.ts` runs via the added test glob (T3).
- Critério de pronto 1–3 (T6). Fora: nothing from that list is built.

**Placeholder scan:** every code step is complete; no "add validation", "similar to", or TBD. The only `<…>` tokens are the T6 commit template results and operator-chosen paths. The temporary `ainda não suportado` guard in T1/T2 `createBoard` is removed by T3's switch.

**Type consistency across tasks:**
- `BoardConfig` (T1) is the type of `Config.board`, `SetupBody.board` (T1), `GithubBoardConfig` / `MarkdownBoardConfig` extracts (T2, T3), `boardFromQuery` output parsed by `parseConfig` (T4), and `boardFromForm()` / `columnsUrl()` in the UI (T5).
- `Task.id: string` (T1) is produced by `createGithubBoard` (T2) and `createMarkdownBoard` (T3), consumed by `slugFor` (T1), `renderPrompt` (T1), the UI (T1/T5), and the fake board in `setup.test.ts` (T1).
- `Board` (T2, `types.ts`) is implemented by both adapters (T2, T3), returned by `createBoard` (T2/T3), used by `Runtime.board` and `BoardFactory` in `server.ts` (T2), and by `fakeBoardFactory` with `setupOptions` (T2).
- `createBoard(config, { repo, exec? })` (T2) matches `hive.ts` (T2), the server default factory (T2), `board.test.ts` (T2/T3) and the real-factory setup test (T4, `createServer({ repo })`).
- `createMarkdownFileIfMissing`, `markdownPath`, `newBoardText` (T3) are the names imported by `server.ts` (T4) and `setup.test.ts` (T4).
- Test totals: 70 → 74 (T1) → 75 (T2) → 83 (T3) → 85 (T4) → 85 (T5, T6).
