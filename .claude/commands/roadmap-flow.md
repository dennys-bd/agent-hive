---
description: "Autonomous dev flow for one GitHub issue: read → brainstorm → plan → branch → TDD → review → security → PR. The issue is the card; spec and plan are linked from the PR."
argument-hint: "<issue number or URL> [optionally followed by the issue title and body]"
---

# /roadmap-flow

Runs this repo's development pipeline end to end for **one** GitHub issue,
without stopping for approval. Each stage delegates to an existing skill or
agent; this file only sequences them. The issue is the card: it carries the
intent and the open decisions, and the PR that closes it links the spec and
plan artifacts. The flow does not move board columns: when it runs inside a
Hive worker the Hive already sets `working` on spawn and `review` when the
session ends, and when run by hand the flow has no way to know which board
the issue lives on. `Closes #<n>` closes the issue on merge; whether that
moves the card to done is the project's own workflow.

**Input**: `$ARGUMENTS` — required. One of:

- an issue number (`36`, `#36`) or URL
  (`https://github.com/<owner>/<repo>/issues/36`);
- the same, followed by the issue title and body already inlined (the Hive
  template can be `/roadmap-flow {url}\n\n{title}\n\n{body}`). When the title
  and body are present in the arguments, use them as-is and skip the
  `gh issue view` in Stage 0.

If `$ARGUMENTS` is empty, run `gh issue list --state open --limit 10`, show
the candidates and stop; that is the only case where the flow asks before
starting.

**No human gates.** Every stage below runs straight into the next. Where a
stage would normally ask the user a question, resolve it from the issue
body and comments, the existing specs in `docs/superpowers/specs/`, and the
code, and write the decision down as a stated assumption in the artifact of
that stage. Stop only if the issue is so ambiguous that any assumption would
make the work useless; report the specific gap and what you would need.

**Working tree**: `git status --short --branch` must be clean before
Stage 0. If it is not, stop and say what is dirty; never stash or discard
on the user's behalf. Two ways to start:

- **on `main`**: the flow creates the feature branch itself (Stage 3);
- **on a fresh worktree branch** (Agent Hive spawns `claude --worktree=<slug>`,
  so the session already sits on a branch named after the task): keep that
  branch as the feature branch and skip the `checkout -b` in Stage 3. Any
  other branch with commits ahead of `main` is a stop.

---

## Tracking (the issue is the card)

| When | Where it is recorded |
|---|---|
| Stage 0, issue read | scope restated in chat, branch name announced |
| End of Stage 1 | architectural path: `docs/superpowers/specs/<file>.md`; bounded path: a `Design:` paragraph in chat, carried into the PR body |
| End of Stage 2 | architectural path: `docs/superpowers/plans/<file>.md` |
| End of Stage 7 | PR body: `Closes #<n>`, spec and plan paths, test plan |

Rules:

- Spec and plan files are committed on the feature branch (`docs: spec and
  plan for #<n>`), so the PR carries them.
- Comment on the issue only when the information would otherwise be lost:
  on a stop (the gap found and what would unblock it), or a decision from
  Stage 1 that changes what the issue asked for. Status never goes in a
  comment; the PR and the board carry it. Do not edit the issue body or
  its labels.

## Model routing

Each stage uses the model its agent already declares. Bump a single stage
to `opus` by hand only when its real risk is higher than the table says
(e.g. a TDD pass that changes the orchestrator reducer or `spawn.ts`), and
say so.

| Stage | Actor | Model | Why |
|---|---|---|---|
| 1 — Spec | `superpowers:brainstorming` (inline, main session) | session model | the questions are answered by the session itself from the issue and the specs; no dispatch |
| 2 — Plan | `ecc:planner` agent | `opus` (`ecc:planner`'s declared default) | planning mistakes are the most expensive to unwind |
| 3 — Branch | inline `git` | session model | trivial, no dispatch |
| 4 — Implementation | `ecc:tdd-guide` | `sonnet` | high-volume, well-specified work once the plan exists |
| 4 — Build-fix | `ecc:build-error-resolver` | `sonnet` | mechanical `tsc` error resolution |
| 5 — Code review | `ecc:typescript-reviewer` | `sonnet` | ECC's own default for this agent |
| 6 — Security | `ecc:security-reviewer` on the branch diff | `sonnet` | ECC's own default; escalate to `opus` by hand when the diff touches the hook routes, `spawn.ts` or a board adapter's token handling |
| 7 — PR | `ecc:pr` inline (no subagent) | session model | mechanical push / template fill / `gh` metadata |

## Stage 0 — Read the issue

1. Extract the issue number from `$ARGUMENTS` (a bare number, `#n`, or the
   last path segment of the URL).
2. Unless the title and body came inlined in `$ARGUMENTS`, fetch them:

   ```sh
   gh issue view <n> --json number,title,body,url,labels,comments
   ```

   Read the comments too; they often close decisions the body leaves open.
   If `gh` fails (not found, rate limit), stop and report the exact error.
3. Restate the scope in two or three sentences in chat.
4. Derive the branch name now: the current branch when already on a
   worktree branch, otherwise `feat/<slug>` (slug from the issue title,
   kebab-case, ≤ 5 words, e.g. `feat/blockers`, `feat/board-asana`).

## Stage 1 — Spec (brainstorming, autonomous)

Invoke `superpowers:brainstorming` with the issue title and body as the
idea. **Only this piece of superpowers is in scope** for the flow.

- Classify per that skill's rules:
  - **bounded** (one or two files, no new type in `src/types.ts`, no new
    adapter, no UI panel): write a short `Design:` paragraph in chat. No
    spec file. The paragraph goes into the PR body in Stage 7.
  - **architectural** (new `Board` adapter, change to `Task`/`Config`/
    `State`, new orchestrator rule, new UI panel): write
    `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`, in Portuguese,
    following the structure of
    `docs/superpowers/specs/2026-09-16-pluggable-boards-design.md`
    (`Decisões fechadas` table, config, types, per-file behaviour, tests).
    Reference the v1 spec and the specs it extends instead of restating
    them; describe only the delta. Cite the issue (`#<n>`) in the header.
- Every question the skill would ask the user is answered by you, with the
  answer and its reason written into the spec's `Decisões fechadas` table
  (or the `Design:` paragraph for bounded work). The issue body already
  lists the decisions to close; each one gets a row.
- `docs/superpowers/specs/2026-09-15-agent-hive-design.md` is authoritative
  for anything the issue does not override.

## Stage 2 — Plan

Dispatch `ecc:planner` with the spec (or the `Design:` paragraph) to produce
`docs/superpowers/plans/YYYY-MM-DD-<slug>.md` in the format of
`docs/superpowers/plans/2026-09-16-pluggable-boards.md`: header block
(Goal, Architecture, Tech Stack, Spec), Global Constraints (copy the
existing list; it is the repo's rule set; update the test count), File map,
then task-by-task steps with checkboxes, interfaces and test code.

Bounded path: no plan file; the `Design:` paragraph is the plan. Go to
Stage 3.

## Stage 3 — Branch

```sh
git checkout -b <branch-from-stage-0> main   # skip when already on the worktree branch
git add docs/superpowers                      # architectural path only
git commit -m "docs: spec and plan for #<n>"  # architectural path only
```

Bounded path: nothing to commit here; the first commit is the first green
task of Stage 4.

Commit message conventions for every commit in this flow: `<type>:
<description>` or `<type>(<scope>): <description>`, English, no
`Claude-Session` trailer, no `Co-Authored-By`.

## Stage 4 — Implementation (TDD)

Dispatch `ecc:tdd-guide` with the plan (or `Design:` paragraph), task by
task: RED → GREEN → refactor. Tests are `node:test` + `node:assert/strict`
under `test/` (adapters under `test/boards/`), compiled by `tsc` and run
with `pnpm test`. External processes (`gh`, `claude`) are always behind an
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

Run `ecc:pr` against `main`. The body has, in this order:

1. `Closes #<n>` on its own line, so the merge closes the issue;
2. the spec and plan paths when they exist, or the `Design:` paragraph for
   bounded work;
3. MEDIUM review findings left open, if any;
4. a test plan with the `pnpm test` result plus any manual `pnpm start`
   checks from Stage 4.

Do not merge. The flow ends with the PR URL in chat.

---

## Gates summary

There are no approval gates. The stop conditions are:

1. dirty working tree, or a branch that is neither `main` nor a fresh
   worktree branch (before Stage 0);
2. no issue given, or the issue cannot be read (Stage 0);
3. an issue too ambiguous to implement under a stated assumption (Stage 1);
4. `pnpm test` red after `ecc:build-error-resolver` (Stage 4);
5. CRITICAL findings that cannot be fixed without changing the spec
   (Stages 5–6).

On any stop, leave the branch and any spec/plan files in place, say exactly
which stage stopped and why, and what input would unblock it.

## Explicitly out of scope

- Any superpowers skill other than `brainstorming`.
- Moving the issue between board columns or labelling it (see the
  tracking section for why).
- Releasing / publishing the package.
