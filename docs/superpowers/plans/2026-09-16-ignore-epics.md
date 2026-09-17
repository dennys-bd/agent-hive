# Agent Hive — épicos fora da fila: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** By default a GitHub epic (an issue with at least one sub-issue, open or closed) is not a task for the Hive: it never enters the queue and never gets a worker, only its sub-issues do. `"epics": "queue"` keeps today's behaviour (the epic sits in the queue `bloqueada por …` and is picked up once every sub-issue is closed). Markdown boards have no epics and ignore the option.

**Architecture:** `Config.epics: 'ignore' | 'queue'` (default `ignore`), parsed in `src/config.ts` like `workers`. The filter lives in the GitHub adapter only: `createGithubBoard(board, statusNames, epics, exec)`; `withBlockers` reads the same `subIssues` nodes the blockers query already returns (zero extra API calls) and, under `ignore`, drops the tasks whose issue is an epic before attaching `blockedBy`. `src/board.ts` passes `config.epics`. `saveSetup` forwards `body.epics ?? current?.epics`, and `sameBoard` also compares `epics` so a change from the form rebuilds the board and the next poll reflects it. The setup form gets a `<select id="epics">` inside `#github-fields`. `Task`, `State`, `Slot`, `HiveEvent`, `Effect`, `Board`, the orchestrator and the markdown adapter do not change.

**Tech Stack:** unchanged — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`, `gh` CLI (GitHub adapter only). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-16-ignore-epics-design.md` (extends `docs/superpowers/specs/2026-09-16-blockers-design.md` and `docs/superpowers/specs/2026-09-15-agent-hive-design.md`). Issue: <https://github.com/dennys-bd/agent-hive/issues/31>.

## Global Constraints

- All v1 and setup constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts`, `run.ts`, `hooks-settings.ts`, `state-store.ts` do not change. For this feature also `orchestrator.ts`, `spawn.ts`, `boards/markdown.ts` do not change.
- `Task.id` is a string in every adapter (`String(issue.number)` for GitHub, the `id` cell for markdown); `Task.itemId` stays the adapter's internal key (project item id / the same `id`).
- `Task.blockedBy` is omitted when empty; adapters only list blockers that are still **open**. Existing fixtures and `deepEqual` expectations stay valid.
- The markdown adapter never caches: every `listQueue` / `setStatus` / `setupOptions` re-reads the file. `setStatus` changes one cell of one line and writes tmp + rename; every other byte is preserved. The dependency column is never written by the Hive.
- `POST /setup` order: `parseConfig` → (markdown: create the file if missing) → `resolveFields` → write `hive.config.json` (tmp + rename) → `configure` / `reconfigure`. The markdown file creation is the only write under `<repo>` allowed before `resolveFields`, and only when the file does not exist.
- Status codes: validation / board errors on `POST /setup` → 400; board failures on listing routes → 502; write / boot failures (including creating the markdown file) → 500.
- `createBoard(config, deps)` needs `deps.repo`. `createServer` defaults `boardFactory` to `(config) => createBoard(config, { repo })`; `test/setup.test.ts` keeps its fake factory and always saves `maxConcurrent: 0`, except one test using the real factory with a markdown board (touches only a local file).
- Legacy `{ "project": { owner, number } }` without `board` parses as `{ type: 'github', owner, number }`; saving from the UI rewrites the file in the new format.
- A failing graphql call is a `listQueue` error (banner, like any poll failure); never swallowed into "no blockers".
- Files < 400 lines, functions < 50 lines, code comments in English, `execFile` argv arrays only (the injectable `Exec` in `src/boards/github.ts` is reused).
- `pnpm test` must stay green after every task (206 tests today → 209 at the end).

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `EpicsMode`; `Config.epics: EpicsMode`; `SetupBody.epics?: EpicsMode` |
| `src/config.ts` | `EPICS_MODES`; `DEFAULT_CONFIG.epics = 'ignore'`; `parseConfig` reads `epics` |
| `src/boards/github.ts` | `createGithubBoard(board, statusNames, epics, exec)`; `isEpic`; `withBlockers(tasks, epics, exec)` drops epics under `ignore` |
| `src/board.ts` | passes `config.epics` to `createGithubBoard` |
| `src/server.ts` | `saveSetup` forwards `epics: body.epics ?? current?.epics`; `sameBoard` compares `epics` too |
| `src/ui/index.html` | `<select id="epics">` inside `#github-fields` |
| `src/ui/app.ts` | `openSetup` fills `#epics`; `saveSetup` sends `epics` |
| `test/config.test.ts` | +1: accepts `ignore` / `queue`, rejects other; default asserted in the defaults test (14 tests) |
| `test/board.test.ts` | +1: `ignore` drops epics and keeps the others' `blockedBy`; the existing blockers test moves to `epics: 'queue'`; the `issue: null` test asserts the ids (13 tests) |
| `test/setup.test.ts` | +1: `epics` written / kept / rebuilds the board / rejected (25 tests) |

---

### Task 1: `EpicsMode`, `Config.epics`, `SetupBody.epics?`, parsing with default `ignore` (TDD)

**Files:**
- Modify: `src/types.ts`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `export type EpicsMode = 'ignore' | 'queue'`; `Config.epics: EpicsMode`; `SetupBody.epics?: EpicsMode`.
- Produces (in `src/config.ts`): `export const EPICS_MODES: readonly EpicsMode[] = ['ignore', 'queue']`; `DEFAULT_CONFIG.epics = 'ignore'`; `parseConfig` accepts an optional `epics` ∈ `EPICS_MODES`, default `'ignore'`, error `hive.config.json: "epics" must be one of: ignore, queue`.
- Consumed by: Task 2 (`createBoard` reads `config.epics`), Task 3 (`saveSetup`), Task 4 (form).

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, inside `parseConfig applies defaults on top of a minimal config` add after `assert.equal(config.workers, 'embedded');`:

```ts
  assert.equal(config.epics, 'ignore');
```

Append after the `parseConfig accepts workers embedded or iterm…` test:

```ts
test('parseConfig accepts epics ignore or queue and rejects anything else', () => {
  assert.equal(parseConfig({ board: GITHUB, epics: 'queue' }).epics, 'queue');
  assert.equal(parseConfig({ board: GITHUB, epics: 'ignore' }).epics, 'ignore');
  assert.throws(() => parseConfig({ board: GITHUB, epics: 'label' }), /"epics" must be one of: ignore, queue/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error — `Property 'epics' does not exist on type 'Config'`.

- [ ] **Step 3: Edit `src/types.ts`**

Insert after `export type WorkersMode = …`:

```ts
/** What the GitHub adapter does with an issue that has sub-issues: drop it (only the sub-issues are tasks) or queue it like any other. */
export type EpicsMode = 'ignore' | 'queue';
```

In `Config`, add after `workers: WorkersMode;`:

```ts
  epics: EpicsMode; // GitHub only; the markdown adapter has no epics and ignores it
```

In `SetupBody`, add after the `workers?: WorkersMode;` entry:

```ts
  /** Optional; missing keeps the current mode (or `ignore` on first setup). */
  epics?: EpicsMode;
```

- [ ] **Step 4: Edit `src/config.ts`**

Import `EpicsMode` from `./types.js`. Add after `WORKERS_MODES`:

```ts
export const EPICS_MODES: readonly EpicsMode[] = ['ignore', 'queue'];
```

In `DEFAULT_CONFIG` add after `workers: 'embedded',`:

```ts
  epics: 'ignore',
```

In `parseConfig`'s returned object, add after the `workers: optional(…)` entry:

```ts
    epics: optional(raw.epics, DEFAULT_CONFIG.epics, (v) => {
      if (!EPICS_MODES.includes(v as EpicsMode)) throw new Error(`${CONFIG_FILE}: "epics" must be one of: ${EPICS_MODES.join(', ')}`);
      return v as EpicsMode;
    }),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 207 tests PASS. `test/setup.test.ts` (`{ ...DEFAULT_CONFIG, ...BODY }`) keeps passing because the written file and `DEFAULT_CONFIG` both carry `epics: 'ignore'`.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "feat(config): epics mode (ignore | queue), default ignore"
```

---

### Task 2: GitHub adapter — drop epics from the queue under `ignore` (TDD)

**Files:**
- Modify: `src/boards/github.ts`, `src/board.ts`
- Test: `test/board.test.ts`

**Interfaces:**
- Produces (in `src/boards/github.ts`): `export function createGithubBoard(board, statusNames, epics: EpicsMode, exec: Exec = ghExec): Board`; module-private `isEpic(issue): boolean` — `(issue?.subIssues?.nodes.length ?? 0) > 0`; `withBlockers(tasks, epics, exec)` — after reading `data`, under `ignore` drops every task whose `data.i<k>.issue` is an epic, the rest get `blockedBy` as today; under `queue` nothing changes.
- Behaviour: `issue: null`, a null repository or a missing alias → not an epic, no blockers (as today). The query, `resolveFields`, `setStatus`, `setupOptions`, `listProjects`, `listStatusOptions` unchanged.
- `src/board.ts`: `createGithubBoard(board, status, config.epics, deps.exec)`.
- Existing blockers test: its fixture puts sub-issues on `i0` (one OPEN) and `i1` (all CLOSED), so under the new default both issues `1` and `3` would be dropped. The fixture encodes the `blockedBy ∪ subIssues` union that only exists in `queue` mode, so the **test moves to an `epics: 'queue'` config** (it becomes the spec's "queue keeps today's behaviour" test); the fixture does not change.

- [ ] **Step 1: Write the failing tests**

In `test/board.test.ts`, add after `const config = …`:

```ts
const queued = parseConfig({ board: { type: 'github', owner: 'acme', number: 6 }, epics: 'queue' });
```

Change the existing blockers test title and its `createBoard` call:

```ts
test('with epics: queue, listQueue keeps epics and resolves open blockers with one graphql call, one alias per queued issue, OPEN only and deduped', async () => {
```

```ts
  const queue = await createBoard(queued, { repo: REPO, exec }).listQueue();
```

In `listQueue treats issue: null, a null repository or a missing alias as no blockers`, change the title and add one assertion:

```ts
test('listQueue treats issue: null, a null repository or a missing alias as no blockers and not as an epic', async () => {
```

```ts
  assert.deepEqual(queue.map((t) => t.id), ['1', '2', '3'], 'nothing dropped under the default epics: ignore');
```

Append at the end of the file:

```ts
test('listQueue drops epics (issues with any sub-issue, open or closed) by default and keeps the others with their blockedBy', async () => {
  const { exec, calls } = fakeExec({
    'project item-list 6': { items: [issue(1), issue(2), issue(3), issue(4)] },
    'api graphql -f': {
      data: {
        i0: relations([], [[5, 'OPEN']]), // epic with an open sub-issue
        i1: relations([[7, 'OPEN']], [[8, 'CLOSED']]), // epic whose sub-issues are all closed: still an epic
        i2: relations([[7, 'OPEN']]), // blocked by a dependency, not an epic
        i3: relations([[9, 'CLOSED']]),
      },
    },
  });
  const queue = await createBoard(config, { repo: REPO, exec }).listQueue();
  assert.deepEqual(queue.map((t) => [t.id, t.blockedBy]), [['3', ['7']], ['4', undefined]]);
  assert.equal(calls.filter((c) => c[0] === 'api').length, 1, 'same single query as before: no extra call to detect epics');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: `listQueue drops epics…` fails (queue has 4 entries). The moved `queue` test and the `issue: null` test already pass and stay as the guards for those rules.

- [ ] **Step 3: Edit `src/boards/github.ts`**

Import `EpicsMode` from `../types.js`. Insert before `async function withBlockers`:

```ts
// An epic is any issue with at least one sub-issue, whatever its state: the same relation GitHub shows as an epic.
const isEpic = (issue: GhIssueRelations | null | undefined): boolean => (issue?.subIssues?.nodes.length ?? 0) > 0;
```

Replace `withBlockers`:

```ts
async function withBlockers(tasks: Task[], epics: EpicsMode, exec: Exec): Promise<Task[]> {
  const query = relationsQuery(tasks);
  if (!query) return tasks;
  const { data } = JSON.parse(await exec(['api', 'graphql', '-f', `query=${query}`])) as { data: GhRelationsData };
  return tasks.flatMap((task, i) => {
    const issue = data[`i${i}`]?.issue;
    if (epics === 'ignore' && isEpic(issue)) return []; // not a task for the Hive: only its sub-issues are
    const blockedBy = openBlockers(issue);
    return [blockedBy.length > 0 ? { ...task, blockedBy } : task];
  });
}
```

Change the `createGithubBoard` signature:

```ts
export function createGithubBoard(
  board: GithubBoardConfig, statusNames: Record<StatusKey, string>, epics: EpicsMode, exec: Exec = ghExec,
): Board {
```

Change the last line of `listQueue`:

```ts
    return withBlockers(queued, epics, exec); // item-list carries no relations; a failed query rejects the poll, never "no blockers"
```

- [ ] **Step 4: Edit `src/board.ts`**

```ts
  const { board, status, epics } = config;
```

```ts
      return createGithubBoard(board, status, epics, deps.exec);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 208 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/boards/github.ts src/board.ts test/board.test.ts
git commit -m "feat(github): drop epics from the queue unless epics: queue"
```

---

### Task 3: Server — `epics` through `POST /setup`, board rebuilt when it changes (TDD)

**Files:**
- Modify: `src/server.ts`
- Test: `test/setup.test.ts`

**Interfaces:**
- `saveSetup`: `epics: body.epics ?? current?.epics` (absent → current value → `parseConfig` default `ignore` on first setup; invalid → 400 with the config message).
- `sameBoard(a, b)`: compares `[board, status, epics]`. Without it `activate` would reuse the live board instance built with the old mode and a change from the form would only take effect after a restart. A different `epics` therefore costs one more board (validation + activate), exactly like a different `status`.

- [ ] **Step 1: Write the failing test**

Append to `test/setup.test.ts`:

```ts
test('POST /setup with epics writes it, a save without the key keeps it, a change rebuilds the board and a bad value answers 400', async (t) => {
  const { base, repo, configs } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).epics, 'ignore', 'default on first setup');
  const before = configs.length;
  assert.equal((await postSetup(base, { ...BODY, epics: 'queue' })).status, 200);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).epics, 'queue');
  assert.equal((await json<SetupInfo>(fetch(`${base}/setup`))).config?.epics, 'queue');
  assert.equal(configs.at(-1)?.epics, 'queue', 'the live board is built with the new mode');
  assert.equal(configs.length, before + 2, 'a different epics mode needs a new board: validation + activate');
  // a save without the key keeps the file's (the API caller that omits it, like `workers`)
  assert.equal((await postSetup(base, BODY)).status, 200);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).epics, 'queue');
  const bad = await postSetup(base, { ...BODY, epics: 'label' });
  assert.equal(bad.status, 400);
  assert.match((await json<{ error: string }>(bad)).error, /"epics" must be one of: ignore, queue/);
  assert.equal((JSON.parse(await readFile(configFile(repo), 'utf8')) as Config).epics, 'queue', 'rejected before the write');
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `pnpm test`
Expected: the new test fails on the second `epics` assertion (`saveSetup` does not forward the field yet).

- [ ] **Step 3: Edit `src/server.ts`**

Replace `sameBoard`:

```ts
// epics is baked into the GitHub adapter at creation, so a change needs a new instance like a change of board or status.
const sameBoard = (a: Config, b: Config): boolean => isDeepStrictEqual([a.board, a.status, a.epics], [b.board, b.status, b.epics]);
```

In `saveSetup`, add after `workers: body.workers ?? current?.workers,`:

```ts
        epics: body.epics ?? current?.epics,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: 209 tests PASS. `a second POST /setup with the same board and status keeps the live board instance` still passes: its bodies carry no `epics`, so every save resolves to the same value.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/setup.test.ts
git commit -m "feat(setup): epics mode saved from POST /setup, board rebuilt when it changes"
```

---

### Task 4: UI — `épicos` select in the GitHub setup form

**Files:**
- Modify: `src/ui/index.html`, `src/ui/app.ts`

**Interfaces:**
- `index.html`: `<select id="epics">` inside `#github-fields`, after `coluna em review`, values `ignore` / `queue`.
- `app.ts`: `openSetup` sets `$('epics').value = config?.epics ?? 'ignore'`; `saveSetup` always sends `epics` in the body (a disabled fieldset on the markdown board does not stop reading the value; it is harmless for that board).
- No automated test (spec: manual).

- [ ] **Step 1: Edit `src/ui/index.html`**

Insert after `<label>coluna em review …</label>`, still inside `<fieldset id="github-fields">`:

```html
    <label>épicos (issues com sub-issues)
      <select id="epics">
        <option value="ignore">ignorar: só as sub-issues entram na fila</option>
        <option value="queue">enfileirar quando todas as sub-issues fecharem</option>
      </select>
    </label>
```

- [ ] **Step 2: Edit `src/ui/app.ts`**

Import `EpicsMode` from `../types.js`. In `openSetup`, after the `workers-mode` line:

```ts
  $<HTMLSelectElement>('epics').value = config?.epics ?? 'ignore';
```

In `saveSetup`'s `body`, after `workers: …`:

```ts
      epics: $<HTMLSelectElement>('epics').value as EpicsMode,
```

- [ ] **Step 3: Build and run the tests**

Run: `pnpm test`
Expected: 209 tests PASS (UI compiles under `strict`).

- [ ] **Step 4: Check the form in the app (manual)**

`pnpm start` in a repo with a GitHub project whose queue column holds an epic and its sub-issues: the setup form shows `épicos (issues com sub-issues)` under `coluna em review` with `ignorar…` preselected; save with `máx. workers` = 0: the queue panel lists the sub-issues only. Reopen `configurar`, pick `enfileirar…`, save: `hive.config.json` reads `"epics": "queue"` and on the next poll the epic appears as `#<n> <título> · bloqueada por <open sub-issues>`. Switch `tipo de board` to markdown: the select is greyed out with the rest of `#github-fields`, and saving still works.

- [ ] **Step 5: Commit**

```bash
git add src/ui/index.html src/ui/app.ts
git commit -m "feat(ui): epics select in the GitHub setup form"
```

---

## Notes

- **Deviation from the spec's first draft:** `sameBoard` also compares `epics` (spec updated). Without it the form change has no effect until a restart.
- `src/server.ts` (532 lines) and `src/ui/app.ts` (512 lines) already exceed the 400-line bullet; this plan adds 2 and 3 lines to them and does not refactor.
- Deliberate simplifications: no shared `oneOf` helper for `workers` / `epics` / `signal` parsing (extract when a fourth enum appears); no `Task.epic` flag or "ignored epics" list in the panel (out of scope); the `epics` select is rendered for both board types and simply disabled with the fieldset on markdown.
