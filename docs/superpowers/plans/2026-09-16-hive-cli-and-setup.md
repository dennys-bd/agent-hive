# Agent Hive — `hive` command and in-app setup: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `hive` (run inside any repo, like `claude`) opens the Agent Hive window pointing at that repo. If `hive.config.json` is missing, the window opens on a setup form that picks the GitHub Project and Status columns from lists fetched via `gh`, writes the file and switches to the dashboard without a restart. The same form reconfigures a running Hive.

**Architecture:** `bin/hive.js` spawns the package's Electron binary with `dist/src/main.js` and the repo path (`main.ts` unchanged). `server.ts` learns a *setup mode*: it can be created without config/board/state, serves `GET/POST /setup` plus two `gh` listing routes, and gains `configure(config)` (finishes the v1 boot in place) and `reconfigure(config)` (swaps the board in memory). `board.ts` gains two standalone reads, `listProjects` and `listStatusOptions`, the latter shared with `resolveFields`. The UI gets a hidden `<form id="setup">` driven by `GET /setup` on load; SSE stays the only source of dashboard state.

**Tech Stack:** unchanged from v1 — Node 24, pnpm, TypeScript strict (`tsc` only, ESM `nodenext`, `.js` import extensions), Electron, Express 5, `node:test` + `node:assert/strict`, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-16-hive-cli-and-setup-design.md` (extends `docs/superpowers/specs/2026-09-15-agent-hive-design.md`).

## Global Constraints

- All v1 constraints hold (immutable reducer, `execFile` argv arrays, Portuguese UI copy, conventional commits without `Co-Authored-By`, no hardcoded machine-specific values; `@me` / project 6 is only a manual-test fixture).
- `main.ts` does not change. `run.ts` does not change.
- Nothing under `<repo>` is written by any setup route before `parseConfig` and `resolveFields` both succeed. `hive.config.json` is written tmp + rename.
- The listening port never changes at runtime. `hooks.json` and the in-memory runtime config always use the port actually bound; the saved file keeps the user's `port`, and `POST /setup` returns `restartForPort` when they differ.
- `port`, `claudeArgs`, `promptTemplate` are never editable from the UI and are preserved from the existing file (or defaults) on every save.
- Setup mode never touches `gh`, the board or `.hive/` until `POST /setup` succeeds. Hook routes answer 200 and ignore; dashboard routes answer `409 { error }`.
- `createServer` takes an injectable `boardFactory` (default `createBoard`) so `test/setup.test.ts` drives the real Express app on an ephemeral port with a fake board. Tests always save `maxConcurrent: 0` so nothing is ever spawned (spawn opens iTerm2).
- Status codes: validation / board errors on `POST /setup` → 400; `gh` failures on listing routes → 502; write / boot failures → 500; missing `owner` / `number` → 400.
- `pnpm test` must stay green after every task (48 tests today → 61 at the end).

---

## File map

| File | Change |
|---|---|
| `bin/hive.js` | new — CLI entry: resolve repo, check `dist/src/main.js`, spawn Electron |
| `package.json` | add `"bin": { "hive": "bin/hive.js" }` |
| `src/types.ts` | add `ProjectSummary`, `SetupInfo`, `SetupBody`, `SetupResult`, `EventsPayload` |
| `src/board.ts` | add `listProjects`, `listStatusOptions`; `resolveFields` reuses `fetchStatusField` |
| `src/config.ts` | add `loadConfigIfPresent` (ENOENT → `undefined`); `loadConfig` built on it |
| `src/server.ts` | setup mode: `ServerDeps.runtime?`, `boardFactory`, `listen(port)`, `close()`, `configure`, `reconfigure`, `/setup*` routes, 409 guards, SSE `{ configured: false }` |
| `src/hive.ts` | two-mode `bootHive` |
| `src/ui/index.html` | setup form, "configurar" button, `#notice` banner, `body.setup` layout |
| `src/ui/app.ts` | `GET /setup` on load, listings, preselection, save, port notice |
| `test/hive-cli.test.ts` | new — `bin/hive.js` without `dist/` exits 2 |
| `test/board.test.ts` | +3 tests |
| `test/config.test.ts` | +1 test |
| `test/setup.test.ts` | new — 8 tests over the real Express app via `fetch` |

---

### Task 1: `hive` command

**Files:**
- Create: `bin/hive.js`, `test/hive-cli.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: the `hive [repo]` executable (`bin/hive.js`, ESM, no deps). Exit codes: child's exit code on success path, `2` when `dist/src/main.js` is missing, `1` when Electron cannot be started.
- Consumes: `dist/src/main.js` (unchanged `main.ts`: `process.argv.slice(2)` → repo).

- [ ] **Step 1: Write the failing test**

`test/hive-cli.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HIVE_BIN = fileURLToPath(new URL('../../bin/hive.js', import.meta.url));

test('hive exits 2 with a build hint when dist/src/main.js is missing', async () => {
  // copy the script into a tree without dist/ (and without node_modules, so electron is never resolved)
  const root = await mkdtemp(join(tmpdir(), 'hive-cli-'));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await copyFile(HIVE_BIN, join(root, 'bin', 'hive.js'));
  await assert.rejects(
    execFileAsync(process.execPath, [join(root, 'bin', 'hive.js'), root]),
    (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? '', /pnpm build/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: `hive-cli.test.js` fails with `ENOENT` copying `bin/hive.js` (file does not exist yet).

- [ ] **Step 3: Create `bin/hive.js`**

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MISSING_BUILD = 2;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = join(root, 'dist', 'src', 'main.js');
const repo = resolve(process.argv[2] ?? process.cwd());

if (!existsSync(mainJs)) {
  console.error(`${mainJs} não existe: rode \`pnpm build\` primeiro`);
  process.exit(MISSING_BUILD);
}

// the electron package exports the path of its binary; required lazily so the check above runs without it
const electronPath = createRequire(import.meta.url)('electron');
const child = spawn(electronPath, [mainJs, repo], { stdio: 'inherit' });
child.on('error', (err) => {
  console.error(`não consegui iniciar o Electron: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
```

Run: `chmod +x bin/hive.js`

- [ ] **Step 4: Register the bin in `package.json`**

Add after `"main"`:

```json
  "bin": { "hive": "bin/hive.js" },
```

Resulting file:

```json
{
  "name": "agent-hive",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/src/main.js",
  "bin": { "hive": "bin/hive.js" },
  "scripts": {
    "build": "tsc && mkdir -p dist/src/ui && cp src/ui/index.html dist/src/ui/",
    "test": "pnpm build && node --test \"dist/test/*.test.js\"",
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
  },
  "pnpm": {
    "onlyBuiltDependencies": ["electron"]
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 49 tests PASS.

- [ ] **Step 6: Link and smoke the happy path (manual)**

```bash
pnpm build && pnpm link --global
which hive
cd /Users/dennysazevedo/Workspace/agent-hive && hive /path/to/a/repo/with/hive.config.json
```
Expected: `which hive` prints a path under the pnpm global bin; the second command opens the v1 dashboard for that repo (config still required until Task 4). Closing the window returns to the shell with exit 0.

- [ ] **Step 7: Commit**

```bash
git add bin/hive.js package.json test/hive-cli.test.ts
git commit -m "feat: hive command that opens the dashboard for the current repo"
```

---

### Task 2: Board listings (`listProjects`, `listStatusOptions`) (TDD)

**Files:**
- Modify: `src/board.ts`, `src/types.ts`
- Test: `test/board.test.ts`

**Interfaces:**
- Produces (in `src/types.ts`): `interface ProjectSummary { number: number; title: string; url: string }`
- Produces (in `src/board.ts`):
  - `listProjects(owner: string, exec?: Exec): Promise<ProjectSummary[]>` — `gh project list --owner <owner> --limit 100 --format json`, open projects only
  - `listStatusOptions(owner: string, number: number, exec?: Exec): Promise<string[]>` — option names of the single-select `Status` field, in board order; rejects with `Error('board has no single-select "Status" field')`
  - `resolveFields` behaviour and `Board` interface unchanged.
- Consumed by: Task 3 (`server.ts` listing routes), Task 5 (`ProjectSummary` in the UI).

- [ ] **Step 1: Write the failing tests**

Change the import at the top of `test/board.test.ts` to:

```ts
import { createBoard, listProjects, listStatusOptions } from '../src/board.js';
```

Append to `test/board.test.ts`:

```ts
test('listProjects lists only open projects as { number, title, url }', async () => {
  const { exec, calls } = fakeExec({
    'project list --owner': {
      projects: [
        { id: 'PVT_1', number: 6, title: 'Roadmap', url: 'https://github.com/users/acme/projects/6', closed: false },
        { id: 'PVT_0', number: 2, title: 'Antigo', url: 'https://github.com/users/acme/projects/2', closed: true },
      ],
      totalCount: 2,
    },
  });
  assert.deepEqual(await listProjects('acme', exec), [
    { number: 6, title: 'Roadmap', url: 'https://github.com/users/acme/projects/6' },
  ]);
  assert.deepEqual(calls[0], ['project', 'list', '--owner', 'acme', '--limit', '100', '--format', 'json']);
});

test('listStatusOptions returns the Status option names in board order without resolveFields', async () => {
  const { exec, calls } = fakeExec({ 'project field-list 6': fields });
  assert.deepEqual(await listStatusOptions('acme', 6, exec), ['Ready', 'In progress', 'In review', 'Done']);
  assert.deepEqual(calls[0], ['project', 'field-list', '6', '--owner', 'acme', '--format', 'json']);
});

test('listStatusOptions fails when the board has no single-select Status field', async () => {
  const { exec } = fakeExec({ 'project field-list 6': { fields: [{ id: 'F_title', name: 'Title', type: 'ProjectV2Field' }] } });
  await assert.rejects(listStatusOptions('acme', 6, exec), /"Status"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: build error `Module '"../src/board.js"' has no exported member 'listProjects'`.

- [ ] **Step 3: Add `ProjectSummary` to `src/types.ts`**

Append at the end of `src/types.ts`:

```ts
export interface ProjectSummary {
  number: number;
  title: string;
  url: string;
}
```

- [ ] **Step 4: Rewrite `src/board.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, ProjectSummary, StatusKey, Task } from './types.js';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 20 * 1024 * 1024;
const ITEM_LIMIT = 200;
const PROJECT_LIMIT = 100;
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

export function createBoard(config: Config, exec: Exec = ghExec): Board {
  const { owner, number } = config.project;
  const base = (sub: string) => projectArgs(sub, owner, number);
  let resolved: { projectId: string; statusFieldId: string; optionIds: Record<StatusKey, string> } | undefined;

  async function resolveFields(): Promise<void> {
    const view = JSON.parse(await exec(base('view'))) as { id: string };
    const status = await fetchStatusField(owner, number, exec);
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

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: 52 tests PASS (the four pre-existing board tests still pass: `fakeExec` keys `project view 6` / `project field-list 6` are unchanged).

- [ ] **Step 6: Check the real `gh` output shape (manual)**

```bash
gh project list --owner @me --limit 100 --format json | head -c 400; echo
gh project field-list 6 --owner @me --format json | head -c 400; echo
```
Expected: the first prints `{"projects":[{...,"closed":false,...,"number":6,"title":...,"url":...}],"totalCount":N}`; the second prints `{"fields":[...]}` with a `Status` entry that has `options`. If `projects` or `closed` are named differently, adapt `GhProject` / the filter and re-run the tests.

- [ ] **Step 7: Commit**

```bash
git add src/board.ts src/types.ts test/board.test.ts
git commit -m "feat: board listings for setup (projects and status options)"
```

---

### Task 3: Server setup mode, `/setup` routes, `configure` / `reconfigure` (TDD)

**Files:**
- Modify: `src/config.ts`, `src/types.ts`, `src/server.ts`, `src/hive.ts` (call-site adaptation only; two-mode boot is Task 4)
- Test: `test/config.test.ts` (+1), `test/setup.test.ts` (new)

**Interfaces:**
- Produces (in `src/config.ts`):
  - `loadConfigIfPresent(repo: string): Promise<Config | undefined>` — `undefined` only on `ENOENT`; any other read error, invalid JSON or invalid config throws.
  - `loadConfig(repo: string): Promise<Config>` — unchanged signature, now built on the above.
- Produces (in `src/types.ts`):
  - `interface SetupInfo { configured: boolean; repo: string; config?: Omit<Config, 'promptTemplate'> }`
  - `interface SetupBody { project: { owner: string; number: number }; status: Record<StatusKey, string>; maxConcurrent: number }`
  - `interface SetupResult { ok: true; restartForPort?: number }`
  - `type EventsPayload = State | { configured: false }`
- Produces (in `src/server.ts`):
  - `type BoardFactory = (config: Config) => Board`
  - `interface Runtime { config: Config; board: Board; hiveDir: string; hooksPath: string; promptsDir: string }`
  - `interface ServerDeps { repo: string; runtime?: Runtime; state?: State; boardFactory?: BoardFactory }`
  - `interface HiveServer { dispatch(event: HiveEvent): Promise<void>; poll(): Promise<void>; listen(port: number): Promise<number>; close(): Promise<void>; configure(config: Config): Promise<void>; reconfigure(config: Config): Promise<void>; getState(): State | undefined }`
  - `createServer(deps: ServerDeps): HiveServer`; `detectAlive(state: State): Promise<string[]>` unchanged.
  - Routes added: `GET /setup`, `GET /setup/projects?owner=`, `GET /setup/columns?owner=&number=`, `POST /setup`.
- Consumed by: Task 4 (`hive.ts`), Task 5 (UI types and routes).

- [ ] **Step 1: Write the failing config test**

Change the import in `test/config.test.ts` to:

```ts
import { DEFAULT_CONFIG, loadConfig, loadConfigIfPresent, parseConfig } from '../src/config.js';
```

Append to `test/config.test.ts`:

```ts
test('loadConfigIfPresent returns undefined only when the file is missing', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  assert.equal(await loadConfigIfPresent(repo), undefined);
  await writeFile(join(repo, 'hive.config.json'), '{not json');
  await assert.rejects(loadConfigIfPresent(repo), /JSON inválido/);
  await writeFile(join(repo, 'hive.config.json'), JSON.stringify({ project: { owner: '@me', number: 9 } }));
  assert.equal((await loadConfigIfPresent(repo))?.project.number, 9);
});
```

- [ ] **Step 2: Write the failing setup tests**

`test/setup.test.ts`:

```ts
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Board } from '../src/board.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createServer, type HiveServer } from '../src/server.js';
import type { Config, SetupBody, SetupInfo } from '../src/types.js';

const OPTIONS = ['Ready', 'In progress', 'In review', 'Done'];
const BODY: SetupBody = {
  project: { owner: 'acme', number: 6 },
  status: { queue: 'Ready', working: 'In progress', review: 'In review' },
  maxConcurrent: 0, // zero slots: nothing is ever spawned (spawn would open an iTerm tab)
};

// A board that has the OPTIONS columns and returns one task named after the configured queue column.
function fakeBoardFactory(): { factory: (config: Config) => Board; configs: Config[] } {
  const configs: Config[] = [];
  const factory = (config: Config): Board => {
    configs.push(config);
    return {
      async resolveFields() {
        for (const key of ['queue', 'working', 'review'] as const) {
          const wanted = config.status[key];
          if (!OPTIONS.includes(wanted)) {
            throw new Error(`status.${key} "${wanted}" not found in board Status options: ${OPTIONS.join(', ')}`);
          }
        }
      },
      async listQueue() {
        return [{ itemId: 'I1', number: 1, title: `from ${config.status.queue}`, body: '', url: 'https://github.com/acme/r/issues/1' }];
      },
      async setStatus() {},
    };
  };
  return { factory, configs };
}

interface Started { repo: string; base: string; port: number; server: HiveServer; configs: Config[] }

async function start(t: TestContext): Promise<Started> {
  const repo = await mkdtemp(join(tmpdir(), 'hive-setup-'));
  const { factory, configs } = fakeBoardFactory();
  const server = createServer({ repo, boardFactory: factory });
  const port = await server.listen(0);
  t.after(() => server.close());
  return { repo, base: `http://127.0.0.1:${port}`, port, server, configs };
}

const postSetup = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
const configFile = (repo: string): string => join(repo, 'hive.config.json');

test('GET /setup reports configured: false and the repo in setup mode', async (t) => {
  const { base, repo } = await start(t);
  assert.deepEqual(await json<SetupInfo>(fetch(`${base}/setup`)), { configured: false, repo });
});

test('GET /events streams { configured: false } until setup is saved', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  assert.match(new TextDecoder().decode(value), /^data: \{"configured":false\}\n\n/);
});

test('setup listings reject a missing owner or number with 400', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/setup/projects`)).status, 400);
  assert.equal((await fetch(`${base}/setup/columns?owner=acme`)).status, 400);
});

test('dashboard routes answer 409 before setup', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/board/refresh`, { method: 'POST' })).status, 409);
});

test('POST /setup writes the config with defaults, boots the runtime and reports the port mismatch', async (t) => {
  const { base, repo, port, server } = await start(t);
  const res = await postSetup(base, BODY);
  assert.equal(res.status, 200);
  // the test binds an ephemeral port, so the saved default port differs from the one in use
  assert.deepEqual(await json(res), { ok: true, restartForPort: DEFAULT_CONFIG.port });
  assert.deepEqual(JSON.parse(await readFile(configFile(repo), 'utf8')), { ...DEFAULT_CONFIG, ...BODY });
  const state = server.getState();
  assert.equal(state?.slots.length, 0);
  assert.deepEqual(state?.queue.map((task) => task.title), ['from Ready']);
  assert.match(await readFile(join(repo, '.hive', 'hooks.json'), 'utf8'), new RegExp(`127\\.0\\.0\\.1:${port}/hooks/event`));
  const info = await json<SetupInfo>(fetch(`${base}/setup`));
  assert.equal(info.configured, true);
  assert.equal(info.config?.project.number, 6);
  assert.ok(info.config && !('promptTemplate' in info.config));
});

test('POST /setup with a column the board does not have answers 400 and writes nothing', async (t) => {
  const { base, repo, server } = await start(t);
  const res = await postSetup(base, { ...BODY, status: { ...BODY.status, queue: 'Todo' } });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /"Todo".*Ready, In progress, In review, Done/);
  await assert.rejects(stat(configFile(repo)));
  assert.equal(server.getState(), undefined);
  assert.equal((await json<SetupInfo>(fetch(`${base}/setup`))).configured, false);
});

test('POST /setup with an invalid body answers 400 naming the field', async (t) => {
  const { base, repo } = await start(t);
  const res = await postSetup(base, { ...BODY, project: { owner: 'acme' } });
  assert.equal(res.status, 400);
  assert.match((await json<{ error: string }>(res)).error, /project\.number/);
  await assert.rejects(stat(configFile(repo)));
});

test('a second POST /setup reconfigures in memory and preserves port, claudeArgs and promptTemplate', async (t) => {
  const { base, repo, server, configs } = await start(t);
  assert.equal((await postSetup(base, BODY)).status, 200);
  const saved = JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  await writeFile(configFile(repo), JSON.stringify({ ...saved, port: 5000, claudeArgs: ['--model', 'sonnet'], promptTemplate: 'só {title}' }));
  const res = await postSetup(base, { ...BODY, status: { ...BODY.status, queue: 'Done' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, restartForPort: 5000 });
  const rewritten = JSON.parse(await readFile(configFile(repo), 'utf8')) as Config;
  assert.equal(rewritten.status.queue, 'Done');
  assert.equal(rewritten.port, 5000);
  assert.deepEqual(rewritten.claudeArgs, ['--model', 'sonnet']);
  assert.equal(rewritten.promptTemplate, 'só {title}');
  assert.deepEqual(server.getState()?.queue.map((task) => task.title), ['from Done']);
  assert.equal(configs.at(-1)?.status.queue, 'Done');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: build errors — `has no exported member 'loadConfigIfPresent'`, `'boardFactory' does not exist in type 'ServerDeps'`, `'SetupBody'` missing from `types.js`.

- [ ] **Step 4: Add `loadConfigIfPresent` to `src/config.ts`**

Replace the `loadConfig` function at the end of `src/config.ts` with:

```ts
export async function loadConfigIfPresent(repo: string): Promise<Config | undefined> {
  const path = join(repo, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path}: erro de leitura (${(err as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: JSON inválido (${(err as Error).message})`);
  }
  return parseConfig(raw);
}

export async function loadConfig(repo: string): Promise<Config> {
  const config = await loadConfigIfPresent(repo);
  if (!config) throw new Error(`${CONFIG_FILE} não encontrado em ${repo}`);
  return config;
}
```

- [ ] **Step 5: Add the setup types to `src/types.ts`**

Append at the end of `src/types.ts`:

```ts
export interface SetupInfo {
  configured: boolean;
  repo: string;
  config?: Omit<Config, 'promptTemplate'>;
}

export interface SetupBody {
  project: { owner: string; number: number };
  status: Record<StatusKey, string>;
  maxConcurrent: number;
}

export interface SetupResult {
  ok: true;
  restartForPort?: number;
}

/** What `GET /events` streams: the whole State, or a marker while the Hive has no config yet. */
export type EventsPayload = State | { configured: false };
```

- [ ] **Step 6: Rewrite `src/server.ts`**

```ts
import { execFile } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import { createBoard, listProjects, listStatusOptions, type Board } from './board.js';
import { CONFIG_FILE, loadConfigIfPresent, parseConfig } from './config.js';
import { prepareHiveDir } from './hooks-settings.js';
import { reduce } from './orchestrator.js';
import { aliveSlugs, focusWorker, killWorker, openWorker, renderPrompt, workerCommand, writePrompt } from './spawn.js';
import { loadState, saveState } from './state-store.js';
import type {
  Config, Effect, EventsPayload, HiveEvent, HookPayload, SetupBody, SetupInfo, SetupResult, Slot, State,
} from './types.js';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 30_000;
const SSE_HEARTBEAT_MS = 25_000;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_CONFIGURED = 409;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const NOT_CONFIGURED_MESSAGE = 'Hive não configurado: salve o setup primeiro';

export type BoardFactory = (config: Config) => Board;

export interface Runtime {
  config: Config;
  board: Board;
  hiveDir: string;
  hooksPath: string;
  promptsDir: string;
}

export interface ServerDeps {
  repo: string;
  runtime?: Runtime;
  state?: State;
  boardFactory?: BoardFactory;
}

export interface HiveServer {
  dispatch(event: HiveEvent): Promise<void>;
  poll(): Promise<void>;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  configure(config: Config): Promise<void>;
  reconfigure(config: Config): Promise<void>;
  getState(): State | undefined;
}

interface Live {
  runtime: Runtime;
  state: State;
}

export async function detectAlive(state: State): Promise<string[]> {
  return aliveSlugs(state.slots.flatMap((s) => (s.status !== 'vazio' && s.slug ? [s.slug] : [])));
}

function publicConfig(config: Config): Omit<Config, 'promptTemplate'> {
  const { promptTemplate: _omitted, ...rest } = config;
  return rest;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createServer(deps: ServerDeps): HiveServer {
  const { repo, boardFactory = createBoard } = deps;
  let live: Live | undefined = deps.runtime && deps.state ? { runtime: deps.runtime, state: deps.state } : undefined;
  let boundPort: number | undefined;
  let httpServer: HttpServer | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  const clients = new Set<Response>();
  let saveChain: Promise<void> = Promise.resolve();

  function eventsPayload(): EventsPayload {
    return live?.state ?? { configured: false };
  }

  function broadcast(): void {
    const data = `data: ${JSON.stringify(eventsPayload())}\n\n`;
    for (const res of clients) res.write(data);
  }

  // Serializes writes: dispatch calls can overlap (a hook arriving mid-poll, or the
  // nested `spawned` dispatch inside spawn()), and two concurrent saveState calls
  // would race on the same state.json.tmp. Chaining onto saveChain queues them, and
  // reading `live` inside the .then ensures a queued save always persists the latest.
  function persist(): Promise<void> {
    saveChain = saveChain
      .then(() => (live ? saveState(live.runtime.hiveDir, live.state) : undefined))
      .catch((err: Error) => console.error('persist failed:', err.message));
    return saveChain;
  }

  async function dispatch(event: HiveEvent): Promise<void> {
    if (!live) return;
    const result = reduce(live.state, event);
    live = { runtime: live.runtime, state: result.state };
    await persist();
    broadcast();
    for (const effect of result.effects) await runEffect(effect);
  }

  async function fail(context: string, err: unknown): Promise<void> {
    const message = `${context}: ${errorMessage(err)}`;
    console.error(message);
    await dispatch({ type: 'error', message });
  }

  async function runEffect(effect: Effect): Promise<void> {
    const runtime = live?.runtime;
    if (!runtime) return;
    switch (effect.type) {
      case 'setStatus':
        await runtime.board.setStatus(effect.itemId, effect.key).catch((err) => fail(`board.setStatus(${effect.key})`, err));
        return;
      case 'kill':
        try {
          // no live process (tab closed by hand, exit signal lost): free the slot ourselves
          const matched = await killWorker(effect.slug);
          if (!matched) await dispatch({ type: 'exit', workerId: effect.workerId });
        } catch (err) {
          await fail('kill', err);
        }
        return;
      case 'spawn':
        await spawn(runtime, effect.slot).catch((err) => fail(`spawn ${effect.slot.slug}`, err));
        return;
    }
  }

  async function spawn(runtime: Runtime, slot: Slot): Promise<void> {
    if (!slot.task || !slot.slug || !slot.workerId) return;
    const { config, hooksPath, promptsDir } = runtime;
    const promptPath = await writePrompt(promptsDir, slot.slug, renderPrompt(config.promptTemplate, slot.task));
    const command = workerCommand({
      repo, workerId: slot.workerId, port: config.port, slug: slot.slug, hooksPath, promptPath, claudeArgs: config.claudeArgs,
    });
    const itermSessionId = await openWorker(command);
    await dispatch({ type: 'spawned', workerId: slot.workerId, itermSessionId });
  }

  async function poll(): Promise<void> {
    const runtime = live?.runtime;
    if (!runtime) return;
    try {
      const tasks = await runtime.board.listQueue();
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

  // Builds a Runtime for `config` on the port actually in use: hooks.json and the worker
  // command must target the listening port even when the saved file asks for another one.
  async function activate(config: Config): Promise<Runtime> {
    if (boundPort === undefined) throw new Error('listen() precisa rodar antes de configure()');
    const effective: Config = { ...config, port: boundPort };
    const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, boundPort);
    const board = boardFactory(effective);
    await board.resolveFields();
    return { config: effective, board, hiveDir, hooksPath, promptsDir };
  }

  async function configure(config: Config): Promise<void> {
    if (live) throw new Error('Hive já configurado: use reconfigure()');
    const runtime = await activate(config);
    const saved = await loadState(runtime.hiveDir, config.maxConcurrent);
    live = { runtime, state: saved };
    await dispatch({ type: 'boot', aliveSlugs: await detectAlive(saved) });
    await poll();
  }

  async function reconfigure(config: Config): Promise<void> {
    if (!live) throw new Error('Hive não configurado: use configure()');
    const runtime = await activate(config);
    live = { runtime, state: live.state };
    if (live.state.maxConcurrent !== config.maxConcurrent) await dispatch({ type: 'setMax', max: config.maxConcurrent });
    await poll();
  }

  async function writeConfigFile(config: Config): Promise<void> {
    const path = join(repo, CONFIG_FILE);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2) + '\n');
    await rename(tmp, path);
  }

  function requireLive(res: Response): Live | undefined {
    if (!live) res.status(HTTP_NOT_CONFIGURED).json({ error: NOT_CONFIGURED_MESSAGE });
    return live;
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
    res.write(`data: ${JSON.stringify(eventsPayload())}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });

  app.get('/setup', (_req: Request, res: Response) => {
    const info: SetupInfo = live
      ? { configured: true, repo, config: publicConfig(live.runtime.config) }
      : { configured: false, repo };
    res.json(info);
  });

  app.get('/setup/projects', async (req: Request, res: Response) => {
    const owner = req.query.owner;
    if (typeof owner !== 'string' || owner === '') {
      res.status(HTTP_BAD_REQUEST).json({ error: 'owner obrigatório' });
      return;
    }
    try {
      res.json(await listProjects(owner));
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });

  app.get('/setup/columns', async (req: Request, res: Response) => {
    const { owner, number } = req.query;
    const parsed = typeof number === 'string' && number !== '' ? Number(number) : Number.NaN;
    if (typeof owner !== 'string' || owner === '' || !Number.isInteger(parsed) || parsed < 0) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'owner e number obrigatórios' });
      return;
    }
    try {
      res.json(await listStatusOptions(owner, parsed));
    } catch (err) {
      res.status(HTTP_BAD_GATEWAY).json({ error: errorMessage(err) });
    }
  });

  app.post('/setup', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<SetupBody>;
    let config: Config;
    try {
      const current = await loadConfigIfPresent(repo);
      config = parseConfig({
        project: body.project,
        status: body.status,
        maxConcurrent: body.maxConcurrent,
        port: current?.port,
        claudeArgs: current?.claudeArgs,
        promptTemplate: current?.promptTemplate,
      });
      await boardFactory(config).resolveFields(); // validates columns against the real board before anything is written
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
  });

  app.post('/config', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    const max = (req.body as { maxConcurrent?: unknown }).maxConcurrent;
    if (!Number.isInteger(max) || (max as number) < 0) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'maxConcurrent must be a non-negative integer' });
      return;
    }
    await dispatch({ type: 'setMax', max: max as number });
    res.json({ ok: true });
  });

  app.post('/slots/:id/kill', async (req: Request, res: Response) => {
    if (!requireLive(res)) return;
    await dispatch({ type: 'kill', slotId: req.params.id as string });
    res.json({ ok: true });
  });

  app.post('/slots/:id/focus', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const slot = current.state.slots.find((s) => s.id === req.params.id);
    if (!slot?.itermSessionId) {
      res.status(404).json({ error: 'slot has no terminal session' });
      return;
    }
    try {
      await focusWorker(slot.itermSessionId);
      res.json({ ok: true });
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: errorMessage(err) });
    }
  });

  app.post('/board/refresh', async (_req: Request, res: Response) => {
    if (!requireLive(res)) return;
    await poll();
    res.json({ ok: true });
  });

  app.get('/', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'index.html')));
  app.get('/ui/app.js', (_req: Request, res: Response) => res.sendFile(join(UI_DIR, 'app.js')));

  async function listen(port: number): Promise<number> {
    const bound = await new Promise<number>((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
      server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE'
          ? new Error(`porta ${port} em uso (outro Agent Hive rodando? veja: lsof -i :${port})`)
          : err);
      });
      httpServer = server;
    });
    boundPort = bound;
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS); // no-op until configured
    return bound;
  }

  async function close(): Promise<void> {
    if (pollTimer) clearInterval(pollTimer);
    const server = httpServer;
    if (!server) return;
    server.closeAllConnections(); // drops open SSE streams so close() does not wait for them
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  return { dispatch, poll, listen, close, configure, reconfigure, getState: () => live?.state };
}
```

- [ ] **Step 7: Adapt the call site in `src/hive.ts`**

Replace the two lines that create and start the server:

```ts
  const server = createServer({ repo, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state: saved });
  await server.listen(config.port);
```

(The rest of `bootHive` is unchanged in this task; Task 4 adds the setup-mode branch.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm test`
Expected: 61 tests PASS (`setup.test.js` 8, `config.test.js` 5). The process exits promptly: every test closes its server in `t.after`.

- [ ] **Step 9: Headless regression on a configured repo (manual)**

```bash
pnpm build && node dist/src/run.js /path/to/configured-repo &
curl -s localhost:47821/setup; echo
curl -s -N localhost:47821/events | head -c 200; echo
kill %1
```
Expected: `/setup` prints `{"configured":true,"repo":"...","config":{...}}` without a `promptTemplate` key and with `port` equal to 47821; `/events` prints a `data: {"maxConcurrent":...` line as in v1.

- [ ] **Step 10: Commit**

```bash
git add src/config.ts src/types.ts src/server.ts src/hive.ts test/config.test.ts test/setup.test.ts
git commit -m "feat: server setup mode with /setup routes, configure and reconfigure"
```

---

### Task 4: Two-mode boot in `hive.ts`

**Files:**
- Modify: `src/hive.ts`

**Interfaces:**
- Produces: `bootHive(repo: string): Promise<{ port: number; server: HiveServer }>` — unchanged signature. Missing `hive.config.json` (`ENOENT`) → server in setup mode listening on `DEFAULT_CONFIG.port`; any other read error or invalid config still rejects.
- Consumes: `loadConfigIfPresent`, `DEFAULT_CONFIG` (Task 3), `createServer` with `runtime`/`state` (Task 3).

- [ ] **Step 1: Rewrite `src/hive.ts`**

```ts
import { createBoard } from './board.js';
import { DEFAULT_CONFIG, loadConfigIfPresent } from './config.js';
import { prepareHiveDir } from './hooks-settings.js';
import { createServer, detectAlive, type HiveServer } from './server.js';
import { loadState } from './state-store.js';

export interface BootedHive {
  port: number;
  server: HiveServer;
}

export async function bootHive(repo: string): Promise<BootedHive> {
  const config = await loadConfigIfPresent(repo);
  if (!config) return bootSetupMode(repo);
  const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, config.port);
  const board = createBoard(config);
  await board.resolveFields();
  const saved = await loadState(hiveDir, config.maxConcurrent);
  const server = createServer({ repo, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state: saved });
  const port = await server.listen(config.port);
  await server.dispatch({ type: 'boot', aliveSlugs: await detectAlive(saved) });
  await server.poll();
  console.log(`Agent Hive em http://127.0.0.1:${port} (repo: ${repo})`);
  return { port, server };
}

// No hive.config.json: serve only the setup form; POST /setup finishes the boot in place.
async function bootSetupMode(repo: string): Promise<BootedHive> {
  const server = createServer({ repo });
  const port = await server.listen(DEFAULT_CONFIG.port);
  console.log(`Agent Hive em modo setup em http://127.0.0.1:${port} (repo: ${repo}, sem hive.config.json)`);
  return { port, server };
}
```

- [ ] **Step 2: Build and run the existing tests**

Run: `pnpm test`
Expected: 61 tests PASS (no new automated tests; `run.ts` and `main.ts` compile unchanged against the same `bootHive` signature).

- [ ] **Step 3: Headless setup flow against a real board (manual)**

```bash
rm -rf /tmp/hive-test-repo && mkdir /tmp/hive-test-repo && git -C /tmp/hive-test-repo init -q
pnpm build && node dist/src/run.js /tmp/hive-test-repo &
curl -s localhost:47821/setup; echo
curl -s 'localhost:47821/setup/projects?owner=@me'; echo
curl -s 'localhost:47821/setup/columns?owner=@me&number=6'; echo
curl -s -X POST localhost:47821/setup -H 'content-type: application/json' \
  -d '{"project":{"owner":"@me","number":6},"status":{"queue":"Ready","working":"In progress","review":"In review"},"maxConcurrent":0}'; echo
cat /tmp/hive-test-repo/hive.config.json
curl -s localhost:47821/setup; echo
kill %1
```
Expected, in order: `{"configured":false,"repo":"/tmp/hive-test-repo"}`; a JSON array of your open projects; the array of Status option names; `{"ok":true}` (no `restartForPort`: the default port is the one in use); a `hive.config.json` with the three chosen values plus `port: 47821`, `claudeArgs: []` and the default `promptTemplate`; `{"configured":true,...}`. A second run of `node dist/src/run.js /tmp/hive-test-repo` now boots straight into the dashboard mode (`/setup` → `configured: true` immediately).

Also check the failure paths keep failing high: `echo '{' > /tmp/hive-test-repo/hive.config.json && node dist/src/run.js /tmp/hive-test-repo` prints `JSON inválido` and exits 1.

- [ ] **Step 4: Commit**

```bash
git add src/hive.ts
git commit -m "feat: boot in setup mode when hive.config.json is missing"
```

---

### Task 5: Setup form in the UI

**Files:**
- Modify: `src/ui/index.html`, `src/ui/app.ts`

**Interfaces:**
- Consumes (type-only, erased at build): `EventsPayload`, `ProjectSummary`, `SetupBody`, `SetupInfo`, `SetupResult`, `Slot`, `State`, `StatusKey` from `../types.js`; routes from Task 3.
- DOM ids added: `configure`, `notice`, `setup`, `owner`, `load-projects`, `project`, `col-queue`, `col-working`, `col-review`, `max-workers`, `setup-error`, `save`, `cancel`. Dashboard-only header controls carry class `dash`; `body.setup` toggles form vs dashboard.

- [ ] **Step 1: Rewrite `src/ui/index.html`**

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
  button:disabled { opacity: 0.5; cursor: default; }
  button.danger { border-color: var(--danger); color: var(--danger); }
  #error { display: none; background: var(--danger); color: #fff; padding: 8px 20px; }
  #error.show { display: block; }
  #notice { display: none; background: #3a3110; color: var(--esperando); padding: 8px 20px; }
  #notice.show { display: block; }
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
  #setup { display: none; max-width: 520px; margin: 24px auto; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; }
  #setup h2 { font-size: 15px; margin: 0 0 12px; }
  #setup label { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; color: var(--muted); }
  #setup input[type=text], #setup select, #setup input[type=number] { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
  #setup .row { display: flex; gap: 8px; align-items: flex-end; }
  #setup .row label { flex: 1; }
  #setup .row button { margin-bottom: 12px; }
  #setup-error { color: var(--danger); min-height: 1.4em; margin-bottom: 8px; white-space: pre-wrap; }
  #setup .actions { display: flex; gap: 8px; }
  body.setup #setup { display: block; }
  body.setup main, body.setup .dash, body.setup #configure { display: none; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Agent Hive</h1>
  <span id="summary" class="dash">0/0 workers ativos</span>
  <label class="dash">máx. workers <input id="max" type="number" min="0" step="1"></label>
  <button id="refresh" class="dash">atualizar board</button>
  <button id="configure">configurar</button>
  <span id="polled" class="dash" style="color: var(--muted); margin-left: auto;"></span>
</header>
<div id="error"></div>
<div id="notice"></div>
<form id="setup">
  <h2>configuração do board</h2>
  <div class="row">
    <label>owner <input id="owner" type="text" value="@me" required></label>
    <button type="button" id="load-projects">carregar</button>
  </div>
  <label>project <select id="project" required><option value="">carregue os projects do owner</option></select></label>
  <label>coluna da fila <select id="col-queue" required></select></label>
  <label>coluna em andamento <select id="col-working" required></select></label>
  <label>coluna em review <select id="col-review" required></select></label>
  <label>máx. workers <input id="max-workers" type="number" min="0" step="1" value="2" required></label>
  <div id="setup-error"></div>
  <div class="actions">
    <button type="submit" id="save">salvar</button>
    <button type="button" id="cancel">cancelar</button>
  </div>
</form>
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

- [ ] **Step 2: Rewrite `src/ui/app.ts`**

```ts
import type { EventsPayload, ProjectSummary, SetupBody, SetupInfo, SetupResult, Slot, State, StatusKey } from '../types.js';

const STATUS_LABEL: Record<Slot['status'], string> = {
  vazio: 'vazio', trabalhando: 'trabalhando', esperando_voce: 'esperando você', aguardando_review: 'aguardando review',
};
const RERENDER_MS = 30_000;
// Mirrors DEFAULT_CONFIG in config.ts, which cannot be imported here (it pulls node:fs into the browser).
const PRESELECT: Record<StatusKey, string> = { queue: 'Ready', working: 'In progress', review: 'In review' };
const DEFAULT_MAX = 2;
const DEFAULT_OWNER = '@me';
const STATUS_KEYS: StatusKey[] = ['queue', 'working', 'review'];
const COLUMN_SELECT: Record<StatusKey, string> = { queue: 'col-queue', working: 'col-working', review: 'col-review' };

let state: State | undefined;
let selectedSlotId: string | undefined;
let setupInfo: SetupInfo | undefined;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function elapsed(iso?: string): string {
  if (!iso) return '';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function showBanner(id: 'error' | 'notice', message?: string): void {
  const el = $(id);
  el.textContent = message ?? '';
  el.classList.toggle('show', Boolean(message));
}
const showError = (message?: string): void => showBanner('error', message);
const showNotice = (message?: string): void => showBanner('notice', message);

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({ error: res.statusText }))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function getJson<T>(path: string): Promise<T> {
  return fetch(path).then((res) => parseJson<T>(res));
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => parseJson<T>(res));
}

function post(path: string, body?: unknown): void {
  postJson(path, body).catch((err: Error) => showError(err.message));
}

// ---------- dashboard ----------

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
    const payload = JSON.parse(event.data) as EventsPayload;
    if (!('slots' in payload)) return; // setup mode: the form is already showing, the first real State follows the save
    state = payload;
    render();
  };
  source.onerror = () => showError('conexão com o Agent Hive perdida; reconectando…');
}

// ---------- setup form ----------

function setupError(message?: string): void {
  $('setup-error').textContent = message ?? '';
}

function fillSelect(select: HTMLSelectElement, options: { value: string; label: string }[], selected?: string): void {
  select.innerHTML = options
    .map((o) => `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');
}

function ownerValue(): string {
  return $<HTMLInputElement>('owner').value.trim();
}

async function loadColumns(): Promise<void> {
  const owner = ownerValue();
  const number = $<HTMLSelectElement>('project').value;
  if (!owner || !number) return;
  setupError();
  try {
    const options = await getJson<string[]>(`/setup/columns?owner=${encodeURIComponent(owner)}&number=${encodeURIComponent(number)}`);
    const current = setupInfo?.config;
    for (const key of STATUS_KEYS) {
      const wanted = current && options.includes(current.status[key]) ? current.status[key] : PRESELECT[key];
      fillSelect($(COLUMN_SELECT[key]), options.map((o) => ({ value: o, label: o })), wanted);
    }
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
  document.body.classList.add('setup');
  $<HTMLButtonElement>('cancel').hidden = !setupInfo?.configured;
  $<HTMLInputElement>('owner').value = config?.project.owner ?? DEFAULT_OWNER;
  $<HTMLInputElement>('max-workers').value = String(config?.maxConcurrent ?? DEFAULT_MAX);
  setupError();
  await loadProjects(config?.project.number);
}

function closeSetup(): void {
  document.body.classList.remove('setup');
}

async function saveSetup(): Promise<void> {
  const projectValue = $<HTMLSelectElement>('project').value;
  if (!projectValue) {
    setupError('escolha um project');
    return;
  }
  const body: SetupBody = {
    project: { owner: ownerValue(), number: Number(projectValue) },
    status: {
      queue: $<HTMLSelectElement>(COLUMN_SELECT.queue).value,
      working: $<HTMLSelectElement>(COLUMN_SELECT.working).value,
      review: $<HTMLSelectElement>(COLUMN_SELECT.review).value,
    },
    maxConcurrent: Number($<HTMLInputElement>('max-workers').value),
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

async function init(): Promise<void> {
  try {
    setupInfo = await getJson<SetupInfo>('/setup');
  } catch (err) {
    showError((err as Error).message);
    return;
  }
  if (!setupInfo.configured) await openSetup();
  connect();
}

// ---------- events ----------

$('grid').addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const killId = target.dataset.kill;
  if (killId) {
    event.stopPropagation();
    if (confirm('Matar esse worker? A task volta pra fila.')) post(`/slots/${killId}/kill`);
    return;
  }
  const card = target.closest<HTMLElement>('.card.occupied');
  if (!card) return;
  selectedSlotId = card.dataset.id;
  renderDetail();
});

$('max').addEventListener('change', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isInteger(value) && value >= 0) post('/config', { maxConcurrent: value });
});
$('refresh').addEventListener('click', () => post('/board/refresh'));
$('focus').addEventListener('click', () => {
  if (selectedSlotId) post(`/slots/${selectedSlotId}/focus`);
});
$('close').addEventListener('click', () => {
  selectedSlotId = undefined;
  renderDetail();
});

$('configure').addEventListener('click', () => void openSetup());
$('load-projects').addEventListener('click', () => void loadProjects());
$('project').addEventListener('change', () => void loadColumns());
$('setup').addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSetup();
});
$('cancel').addEventListener('click', closeSetup);

setInterval(render, RERENDER_MS);
void init();
```

- [ ] **Step 3: Build and run the tests**

Run: `pnpm test`
Expected: 61 tests PASS (the UI compiles under `strict`; `EventsPayload` narrows via `'slots' in payload`).

- [ ] **Step 4: Check both modes in a browser (manual)**

Setup mode:
```bash
rm -rf /tmp/hive-test-repo && mkdir /tmp/hive-test-repo && git -C /tmp/hive-test-repo init -q
pnpm build && node dist/src/run.js /tmp/hive-test-repo
```
Open `http://127.0.0.1:47821/` in Chrome. Expected: the form is visible, the dashboard and the header controls are hidden, "cancelar" is hidden. "carregar" with `@me` fills the project list; picking a project fills the three column selects with `Ready` / `In progress` / `In review` preselected when they exist; picking a column name that the board lacks is impossible (selects only). Saving with `máx. workers` = 0 hides the form and shows the dashboard with the queue from the board and `0/0 workers ativos`; no yellow notice. `cat /tmp/hive-test-repo/hive.config.json` has the chosen values.

Reconfigure: click "configurar". Expected: the form opens with the current owner, the current project selected and the current three columns selected; "cancelar" closes it without changes. Change "coluna da fila" to another column and save: the queue panel updates to that column's issues without restarting the process. Edit the file by hand to `"port": 5000`, click "configurar", save without changes: the yellow notice reads `reinicie o Hive pra usar a porta 5000` and the dashboard keeps working on 47821.

Failure path: stop `gh` auth (`gh auth status` → temporarily `gh auth logout` or set `GH_TOKEN=bad`), click "carregar": the error appears inside the form, nothing is written. Restore auth afterwards.

- [ ] **Step 5: Commit**

```bash
git add src/ui/index.html src/ui/app.ts
git commit -m "feat: setup form in the dashboard for choosing project and columns"
```

---

### Task 6: Acceptance per the spec's "Critério de pronto"

**Files:**
- Modify: only what the acceptance run reveals (fixes must come with a test when they touch `src/` outside the UI).

**Interfaces:**
- Consumes: everything from Tasks 1–5. No new exports.

- [ ] **Step 1: Install the command**

```bash
pnpm build && pnpm link --global && which hive
```
Expected: a path under the pnpm global bin directory.

- [ ] **Step 2: Criterion 1 — fresh repo**

```bash
rm -rf /tmp/hive-test-repo && mkdir /tmp/hive-test-repo && git -C /tmp/hive-test-repo init -q
cd /tmp/hive-test-repo && hive
```
Expected: the Electron window opens on the form. Pick the test project and its columns from the lists, keep `máx. workers` at 2 or set it to 0 if the board has `Ready` issues you do not want to start, save. The file is created, the dashboard appears with the board's queue, no restart. Close the window; the shell returns.

- [ ] **Step 3: Criterion 2 — configured repo and reconfigure**

```bash
cd /tmp/hive-test-repo && hive
```
Expected: the dashboard opens directly. "configurar" shows the current values. Change "coluna da fila" to another column (for example `Done`) and save: the queue panel switches to that column's issues without restarting; `hive.config.json` reflects the new column and still has `port`, `claudeArgs`, `promptTemplate`. Switch it back the same way.

- [ ] **Step 4: Criterion 3 — tests**

Run: `pnpm test`
Expected: 61 tests PASS.

- [ ] **Step 5: Bin failure path**

```bash
mv dist dist.bak && hive; echo "exit=$?"; mv dist.bak dist
```
Expected: `... não existe: rode \`pnpm build\` primeiro` and `exit=2`.

- [ ] **Step 6: Commit**

If the run required fixes, commit them with the smoke results in the body; otherwise record the results in an empty commit:

```bash
git add -A
git commit --allow-empty -m "chore: hive setup acceptance

Critério 1 (repo sem config → form → dashboard): <pass/fail>
Critério 2 (repo configurado → dashboard; reconfigurar fila): <pass/fail>
Critério 3 (pnpm test, 61 testes): <pass/fail>
bin sem dist → exit 2: <pass/fail>"
```

---

## Self-review notes

**Spec coverage (section → task):**
- Decisões fechadas: entrada `bin/hive.js` + `bin` + `pnpm link --global` (T1); repo `argv[2] ?? cwd` (T1); sem config → modo setup (T3, T4); listas do GitHub (T2, T5); campos avançados só no arquivo e preservados (T3 `POST /setup` merge, tested; T5 never sends them); reconfigurar sem restart pela mesma rota (T3 `reconfigure`, T5 "configurar").
- Comando `hive` steps 1–4 and `main.ts` unchanged (T1).
- Boot em dois modos: `bootHive` always returns `{ port, server }`; ENOENT → setup on 47821, other errors fail high (T4, `loadConfigIfPresent` in T3); SSE `{ configured: false }` (T3, tested); `createServer` without config/board/state + `configure` + `boardFactory` (T3); port unchanged at runtime + `restartForPort` + UI notice (T3 tested, T5).
- Board: `listProjects` (open only, `{ number, title, url }`) and `listStatusOptions` (error without `Status`), both independent of `resolveFields`, which reuses `fetchStatusField` (T2, tested).
- Rotas de setup: all four routes, response shapes, `promptTemplate` omitted, 400/502 codes, tmp+rename write, nothing written before validation (T3, tested).
- UI: form hidden by default, "configurar" button, owner + carregar, project select `#número título`, three column selects with preselection, máx. workers default 2, errors inside the form, success hides the form and shows the port notice, `GET /setup` on load, SSE remains the only dashboard source (T5).
- Testes: `board.test.ts` (T2), `setup.test.ts` with every listed case plus `GET /events`, invalid body and 409 guard (T3), `bin/hive.js` exit 2 (T1), happy path manual (T1 step 6, T6).
- Critério de pronto 1–3 (T6). Fora do spec: nothing from that list is built.

**Placeholder scan:** every code step is complete (no "add validation", no "similar to", no TBD). The only `<...>` tokens are in the T6 commit template for recording results and in shell paths the operator chooses.

**Type consistency across tasks:**
- `ProjectSummary` (T2 types) is what `listProjects` returns (T2), what `GET /setup/projects` sends (T3) and what `loadProjects` parses (T5).
- `SetupInfo` / `SetupBody` / `SetupResult` / `EventsPayload` (T3 types) are used identically by the routes (T3), the tests (T3) and `app.ts` (T5). `SetupInfo.config` is `Omit<Config, 'promptTemplate'>` everywhere.
- `ServerDeps.runtime` / `state` / `boardFactory` (T3) match the calls in `hive.ts` (T3 step 7, T4) and `setup.test.ts` (T3). `listen(port): Promise<number>` is used by T3, T4; `close()` by the tests; `getState(): State | undefined` by the tests.
- `loadConfigIfPresent` (T3) is used by `POST /setup` (T3) and `bootHive` (T4); `loadConfig` keeps its signature and its existing test.
- `Board`, `Exec`, `createBoard(config, exec?)` are unchanged, so `spawn.ts`, `orchestrator.ts`, `state-store.ts`, `hooks-settings.ts`, `main.ts` and `run.ts` are untouched.

**Decisions where the spec was silent (kept consistent across tasks):**
- `config?`/`board?`/`state?` grouped as `runtime?: Runtime` + `state?: State` (one invariant instead of six optionals).
- `configure`/`reconfigure` use the bound port for `hooks.json` and the runtime config; the file keeps the user's port.
- `POST /setup` validates with a throwaway `boardFactory(config)` and `configure` resolves again (spec lists `resolveFields` inside `configure`); two extra `gh` calls per save.
- `reconfigure` dispatches `setMax` when `maxConcurrent` changed; verified manually only (a unit test with slots would spawn iTerm).
- Dashboard routes → 409 in setup mode; hook routes → 200 and ignored.
- `listProjects` filters `!p.closed`.
- `bin/hive.js` is ESM with `createRequire` after the dist check; the test copies it into a temp package to make `dist/` absent.
- UI duplicates the three default column names and `DEFAULT_MAX = 2` (`config.ts` is not browser-loadable).
