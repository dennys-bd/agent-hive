# Agent Hive — blockers / dependencies

Extends the pluggable boards spec (`docs/superpowers/specs/2026-09-16-pluggable-boards-design.md`) on top of v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`). Goal: a task only leaves the queue for a slot when it has no open dependency. Each adapter finds the dependencies in its own source and hands over only the ones still open; the orchestrator applies a pure rule on top of that. The queue keeps showing the task, marked "bloqueada por …". Only the delta is described here.

## Closed decisions

| Decision | Choice | Reason |
|---|---|---|
| Who decides whether a dependency is open | The adapter: `Task.blockedBy` lists only **open** blockers | The orchestrator does not know what "open" means in each source; the `fill` rule stays trivial and pure |
| Field shape | `blockedBy?: string[]`, omitted when empty | Zero change to existing fixtures and `deepEqual`s; absent or `[]` = free |
| Queue order | `fill` takes the first **free** task in queue order; blocked ones stay where they are | Board order is still the priority; nothing is reordered or removed |
| GitHub: source | `blockedBy` (issue dependencies) ∪ `subIssues`, both only the `OPEN` ones, via **one** `gh api graphql` call per poll with one alias per queued issue | `item-list` carries no relations; one aliased query costs one call, not N |
| GitHub: blocker id | `String(number)` of the blocking issue | Same format as `Task.id`; the UI shows `#12` |
| GitHub: empty queue | No graphql call | Nothing to resolve |
| GitHub: query failure | `listQueue` error (banner, like any poll failure) | Never swallow; pretending "no blockers" would spawn a worker on a blocked task |
| Markdown: source | Optional column whose normalized header is `depende de`, `depends on`, `depends`, `bloqueada por` or `blocked by`; cells hold ids separated by comma and/or whitespace | Same column-locating logic already used for `id`/`título`/`status`; no new format |
| Markdown: `depends: T-12` convention in prose | Out | The column covers it; parsing prose below the table is brittle and YAGNI |
| Markdown: "open" | The row for the id exists **and** its status ∈ {`status.queue`, `status.working`, `status.review`}; any other status (`Done`, `Cancelled`, …) = closed | These are the only statuses the Hive knows; everything else is "outside the flow" |
| Markdown: unknown id | Counts as open (blocks) | Fail safe; the queue shows "bloqueada por T-99" and the typo is visible |
| UI | Queue panel only: `#T-2 Segunda tarefa · bloqueada por T-1, T-3` in muted text | Slots never receive a blocked task, so the card does not change |
| Config / setup / server | Unchanged | Nothing new to configure; the whole `State` already travels over SSE |
| Task returned to the queue (`exit` without a PR) | Comes back with the `blockedBy` it had; the next poll refreshes it | Simplicity; a 30 s window at worst |

## Types

```ts
interface Task {
  itemId: string;
  id: string;
  title: string;
  body: string;
  url: string;
  blockedBy?: string[]; // ids of blockers still open, per the adapter; absent or empty = free to start
}
```

No change to `Config`, `State`, `Slot`, `HiveEvent`, `Effect`, `Board`.

## Orchestrator (`src/orchestrator.ts`)

- `export function isBlocked(task: Task): boolean` — `(task.blockedBy?.length ?? 0) > 0`. The only rule; pure.
- `fill`: for each slot that is `vazio` and not `draining`, take the **first** queued task with `!isBlocked(task)`; if there is none, the slot stays empty. The chosen task leaves the queue; blocked ones keep their position. `setStatus(working)` + `spawn` as today.
- `poll` unchanged: the queue receives every board task (blocked ones included) that is not in a slot. `exit`/`setMax`/`boot` unchanged.

## GitHub adapter (`src/boards/github.ts`)

- `listQueue()`: after filtering the queued items, if there is at least one, runs `exec(['api', 'graphql', '-f', 'query=<q>'])` and attaches `blockedBy` to every task that has an open blocker.
- Query: one alias per task (`i0`, `i1`, …), with `owner`/`name`/`number` extracted from `Task.url` by `/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/` (the values match only `[\w.-]`, so they go into the query as literals via `JSON.stringify`). A task whose url does not match: no blockers.

```graphql
query {
  i0: repository(owner: "acme", name: "r") { issue(number: 1) {
    blockedBy(first: 50) { nodes { number state } }
    subIssues(first: 50) { nodes { number state } }
  } }
}
```

- Response: `data.i<k>.issue` may be `null` (issue gone) → no blockers. `blockedBy` = `[...blockedBy.nodes, ...subIssues.nodes].filter(state === 'OPEN').map(String(number))`, deduplicated, in response order.
- `resolveFields`, `setStatus`, `setupOptions`, `listProjects`, `listStatusOptions` unchanged.

## Markdown adapter (`src/boards/markdown.ts`)

- `findColumns` gains `dependsOn?: number` (column index, when the normalized header ∈ `depende de` | `depends on` | `depends` | `bloqueada por` | `blocked by`). Without the column nothing changes.
- `readRows` reads the cell and splits it by `/[\s,]+/`, dropping empties → `dependsOn: string[]`.
- `listQueue()`: with the whole table in hand, `open = new Set(rows.filter(status ∈ {queue, working, review}).map(id))`; for each queued task, `blockedBy = dependsOn.filter((d) => open.has(d) || !ids.has(d))`, attached only when non-empty.
- `setStatus`, `resolveFields`, `setupOptions`, file creation: unchanged. The Hive never writes the column.

## UI (`src/ui/app.ts`)

Queue `render()`: `<li>#T-2 Segunda tarefa<span class="meta"> · bloqueada por T-1, T-3</span></li>` when `blockedBy` is non-empty. `index.html` unchanged (`.meta` already exists).

## Tests

- `test/orchestrator.test.ts`: `fill` skips the blocked task and takes the next free one, leaving the blocked one in the queue at the same position; `blockedBy: []` counts as free; a later poll without `blockedBy` makes the previously blocked task get picked; `isBlocked`.
- `test/board.test.ts` (GitHub, `fakeExec`): a single `api graphql` call with one alias per queued task, `blockedBy` = only the `OPEN` ones from `blockedBy` ∪ `subIssues`, deduplicated, and a task without an open blocker has no field; empty queue → no graphql call; `issue: null` → no blockers.
- `test/boards/markdown.test.ts`: `depende de` column with `T-1, T-3` (comma and space) and a `Done` dependency ignored; unknown id blocks; file without the column → tasks without `blockedBy`; `blocked by` header is recognized too.
- UI: manual (`pnpm start` with a `board.md` that has the column), in the PR test plan.

## Definition of done

1. In a `board.md` with `| id | título | status | depende de |`, `T-2` depending on `T-1` in `Ready`: the queue shows `#T-2 … · bloqueada por T-1`, and with `máx. workers = 2` only `T-1` gets a worker; when `T-1` moves to `Done` (by hand or by the Hive) the next poll starts `T-2`.
2. In a GitHub project, an issue in `Ready` with an open blocker (issue dependencies) or an open sub-issue does not get a worker; once the blocker is closed, it starts on the next poll.
3. `pnpm test` green with the tests above.

## Out of scope

Asana and Jira (roadmap 7 and 8 bring their own blockers); writing dependencies from the Hive; blockers across boards; telling a closed blocker from a non-existent one in the UI.
