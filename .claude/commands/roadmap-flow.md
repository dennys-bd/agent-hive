---
description: "Autonomous dev flow for one roadmap item: pick → brainstorm → plan → branch → TDD → review → security → PR. Tracked in docs/roadmap.md."
argument-hint: "[roadmap item number or feature substring, or empty for the next a fazer]"
---

# /roadmap-flow

Runs this repo's development pipeline end to end for **one** row of the
table in `docs/roadmap.md`, without stopping for approval. Each stage
delegates to an existing skill or agent; this file only sequences them and
keeps the roadmap row updated so `docs/roadmap.md` is the single source of
truth for what is being worked on and where the artifacts live.

**Input**: `$ARGUMENTS` — optional. A row number (`3`) or a substring of the
`Feature` cell (`blockers`). If empty, take the **first row from the top
whose `Status` is `a fazer`**. If the substring matches more than one
row, or none, list the candidates and stop; that is the only case where the
flow asks before starting.

**No human gates.** Every stage below runs straight into the next. Where a
stage would normally ask the user a question, resolve it from the item's
section in `docs/roadmap.md` (`## <n>. <Feature>`), the existing specs in
`docs/superpowers/specs/`, and the code, and write the decision down as a
stated assumption in the artifact of that stage. Stop only if the item is so
ambiguous that any assumption would make the work useless; report the
specific gap and what you would need.

**Working tree**: `git status --short --branch` must be clean before
Stage 0. If it is not, stop and say what is dirty; never stash or discard
on the user's behalf. Two ways to start:

- **on `main`**: the flow creates the feature branch itself (Stage 3);
- **on a fresh worktree branch** (Agent Hive spawns `claude --worktree=<slug>`,
  so the session already sits on a branch named after the task): keep that
  branch as the feature branch and skip the `checkout -b` in Stage 3. The
  Hive has already moved the row to `fazendo` in the main checkout; the
  worktree copy still shows `a fazer`, so the tracking edits below still
  apply. Any other branch with commits ahead of `main` is a stop.

---

## Tracking in the roadmap (do this at every stage boundary)

The row in the table plus its `## <n>. <Feature>` section is the card. Edit
in place; the section keeps its prose and gets tracking lines appended at
the end as the flow advances:

| When | Edit |
|---|---|
| Stage 0, item picked | table `Status` → `fazendo`; section header `— fazendo`; append `- Branch: <name>` |
| End of Stage 1 (architectural path) | table `Spec` → `` `docs/superpowers/specs/<file>.md` `` |
| End of Stage 2 (architectural path) | append `- Plan: docs/superpowers/plans/<file>.md` |
| End of Stage 7, PR opened | table `Status` → `feito`; section header `— feito`; append `- PR: <url>` |

Rules:

- Every edit to `docs/roadmap.md` is committed on the feature branch as
  part of the flow (`docs(roadmap): track <feature>`), so the PR carries
  the status change and `main` reflects reality after merge.
- Announce each edit in chat as it happens (`roadmap: <feature> → fazendo`).
- Never batch the edits at the end.
- Rows are never deleted or reordered by this flow. The `## Pendências`
  list is not in scope; it is not a queue.

## Model routing

Each stage uses the model its agent already declares. Bump a single stage
to `opus` by hand only when its real risk is higher than the table says
(e.g. a TDD pass that changes the orchestrator reducer or `spawn.ts`), and
say so.

| Stage | Actor | Model |
|---|---|---|
| 1 — Spec | `superpowers:brainstorming` (inline) | session model |
| 2 — Plan | `ecc:planner` agent | `opus` |
| 3 — Branch | inline `git` | session model |
| 4 — Implementation | `ecc:tdd-guide` | `sonnet` |
| 4 — Build-fix | `ecc:build-error-resolver` | `sonnet` |
| 5 — Code review | `ecc:typescript-reviewer` | `sonnet` |
| 6 — Security | `ecc:security-reviewer` | `sonnet` |
| 7 — PR | `ecc:pr` inline | session model |

## Stage 0 — Pick the item

1. Read `docs/roadmap.md` in full.
2. Select the row per **Input** above. Read its `## <n>.` section; it
   carries the intent and the open decisions.
3. Restate the scope in two or three sentences in chat.
4. Derive the branch name now: the current branch when already on a
   worktree branch, otherwise `feat/<slug>` (slug from the feature name,
   kebab-case, ≤ 5 words, e.g. `feat/blockers`, `feat/board-asana`). Record
   `fazendo` + `- Branch:` in the roadmap. Do not commit yet; Stage 3
   commits it on the branch.

## Stage 1 — Spec (brainstorming, autonomous)

Invoke `superpowers:brainstorming` with the feature name and its section as
the idea. **Only this piece of superpowers is in scope** for the flow.

- Classify per that skill's rules:
  - **bounded** (one or two files, no new type in `src/types.ts`, no new
    adapter, no UI panel): write a short design paragraph as a `- Design:`
    line under the section. No spec file.
  - **architectural** (new `Board` adapter, change to `Task`/`Config`/
    `State`, new orchestrator rule, new UI panel): write
    `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`, in Portuguese,
    following the structure of
    `docs/superpowers/specs/2026-09-16-pluggable-boards-design.md`
    (`Decisões fechadas` table, config, types, per-file behaviour, tests).
    Reference the v1 spec and the specs it extends instead of restating
    them; describe only the delta.
- Every question the skill would ask the user is answered by you, with the
  answer and its reason written into the spec's `Decisões fechadas` table
  (or the `- Design:` line for bounded work). The roadmap section already
  lists the decisions to close; each one gets a row.
- `docs/superpowers/specs/2026-09-15-agent-hive-design.md` is authoritative
  for anything the item does not override.
- Record the path in the table's `Spec` cell when a spec file was written.

## Stage 2 — Plan

Dispatch `ecc:planner` with the spec (or the `Design:` line) to produce
`docs/superpowers/plans/YYYY-MM-DD-<slug>.md` in the format of
`docs/superpowers/plans/2026-09-16-pluggable-boards.md`: header block
(Goal, Architecture, Tech Stack, Spec), Global Constraints (copy the
existing list; it is the repo's rule set; update the test count), File map,
then task-by-task steps with checkboxes, interfaces and test code.

Bounded path: no plan file; the `Design:` line is the plan. Go to Stage 3.

Record `- Plan:` under the section when a plan file was written.

## Stage 3 — Branch

```sh
git checkout -b <branch-from-stage-0> main   # skip when already on the worktree branch
git add docs/roadmap.md docs/superpowers
git commit -m "docs(roadmap): track <feature>"
```

Commit message conventions for every commit in this flow: `<type>:
<description>` or `<type>(<scope>): <description>`, English, no
`Claude-Session` trailer, no `Co-Authored-By`.

## Stage 4 — Implementation (TDD)

Dispatch `ecc:tdd-guide` with the plan (or `Design:` line), task by task:
RED → GREEN → refactor. Tests are `node:test` + `node:assert/strict` under
`test/` (adapters under `test/boards/`), compiled by `tsc` and run with
`pnpm test`. External processes (`gh`, `claude`) are always behind an
injectable `exec` / factory so tests never shell out. Commit after each
green task.

Validation after every task and at the end:

```sh
pnpm test
```

If the build breaks and the fix is not obvious from the plan, dispatch
`ecc:build-error-resolver`. UI-only behaviour that `node:test` cannot cover
(dashboard layout, form fields) is verified by `pnpm start` (Electron) or
`pnpm run:headless` and described in the PR's test plan as a manual step;
do not skip tests for the logic behind it (reducer, adapters, routes).

Repo constraints that apply to every change (from the plans' Global
Constraints): TypeScript strict, ESM with `.js` import extensions, no new
runtime dependencies without saying so, immutable reducer in
`orchestrator.ts`, `execFile` with argv arrays (never shell strings),
tokens only via env (never in `hive.config.json`), Portuguese UI copy, no
machine-specific values (`@me` / project 6 is only a manual-test fixture),
files < 400 lines, functions < 50 lines, code comments in English.

## Stage 5 — Code review (separate pass, never self-approval)

Dispatch `ecc:typescript-reviewer` on `git diff main...HEAD`. Fix CRITICAL
and HIGH findings, commit, and re-dispatch if any fix was non-trivial.
MEDIUM findings: fix when cheap, otherwise list them in the PR body.

## Stage 6 — Security review

Dispatch `ecc:security-reviewer` on the same diff. The attack surface is
the local Express server (hook routes and dashboard routes on localhost),
child processes spawned with `execFile`, files written under `<repo>` and
`.hive/`, and any board adapter that calls a remote API with a token. The
review is mainly about host/origin checks on routes, argv construction,
path handling (tmp + rename, no writes outside `<repo>`/`.hive/`), and
tokens never reaching config files or logs. Fix CRITICAL/HIGH, re-run to
confirm.

## Stage 7 — PR

1. Mark the row `feito`, the header `— feito`, add `- PR:` with a
   placeholder, commit `docs(roadmap): mark <feature> done`.
2. Run `ecc:pr` against `main`. The body references the roadmap row, the
   spec and plan paths (when they exist), and a test plan with the
   `pnpm test` result plus any manual `pnpm start` checks from Stage 4.
3. Replace the `- PR:` placeholder with the real URL, amend or add a
   `docs(roadmap):` commit, push.

Do not merge. The flow ends with the PR URL in chat and in the roadmap.

---

## Gates summary

There are no approval gates. The stop conditions are:

1. dirty working tree, or a branch that is neither `main` nor a fresh
   worktree branch (before Stage 0);
2. ambiguous or missing roadmap match (Stage 0);
3. an item too ambiguous to implement under a stated assumption (Stage 1);
4. `pnpm test` red after `ecc:build-error-resolver` (Stage 4);
5. CRITICAL findings that cannot be fixed without changing the spec
   (Stages 5–6).

On any stop, leave the branch and roadmap edits in place, say exactly which
stage stopped and why, and what input would unblock it.

## Explicitly out of scope

- Any superpowers skill other than `brainstorming`.
- GitHub issues and project boards as a tracker; `docs/roadmap.md` is the
  tracker (the Hive itself may use a GitHub board, that is product, not
  process).
- The `## Pendências` list in the roadmap.
- Releasing / publishing the package.
