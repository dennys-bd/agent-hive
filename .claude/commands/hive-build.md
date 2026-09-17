---
description: "Build stage for one task: TDD from the plan → build-fix → code review → security review → PR. Autonomous, no questions; opens the PR with gh but never moves the board card."
argument-hint: "[path to the plan file] [#issue]"
---

# /hive-build

Implements an approved plan on the current feature branch and opens the PR.
It is the last piece of `/hive-flow` and also works on its own. The only
GitHub interaction is `gh pr create`; the board is `/hive-flow`'s job.

**Input**: `$ARGUMENTS` — optional, in any order:

- path to the plan file. When empty, use the plan written in this session
  by `/hive-plan`; failing that, the most recent file in
  `docs/superpowers/plans/`. Bounded path: the session's `Design:`
  paragraph is the plan.
- an issue number (`36`, `#36`). When empty, use the issue `/hive-spec`
  read in this session, if any. Without an issue the PR has no `Closes`
  line.

Say which plan and issue you are building from.

**No questions.** Where a stage would normally ask the user something,
resolve it from the plan, the spec, the issue body and comments, the
existing specs in `docs/superpowers/specs/`, and the code, and write the
decision down as a stated assumption (in the commit message or the PR
body).

**Working tree**: must be clean and on a feature branch (not `main`).

## Model routing

Each stage uses the model its agent already declares. Bump a single stage
to `opus` by hand only when its real risk is higher than the table says,
and say so.

| Stage | Actor | Model | Why |
|---|---|---|---|
| 1 — Implementation | `ecc:tdd-guide` | `sonnet` | high-volume, well-specified work once the plan exists; `opus` by hand for a task that changes the orchestrator reducer or `spawn.ts` |
| 1 — Build-fix | `ecc:build-error-resolver` | `sonnet` | mechanical `tsc` error resolution |
| 2 — Code review | `ecc:typescript-reviewer` | `sonnet` | ECC's own default for this agent |
| 3 — Security | `ecc:security-reviewer` on the branch diff | `sonnet` | ECC's own default; `opus` by hand when the diff touches the hook routes, `spawn.ts` or a board adapter's token handling |
| 4 — PR | `ecc:pr` inline (no subagent) | session model | mechanical push / template fill / `gh` metadata |

## Stage 1 — Implementation (TDD)

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

Commit message conventions: `<type>: <description>` or
`<type>(<scope>): <description>`, English, no `Claude-Session` trailer, no
`Co-Authored-By`.

## Stage 2 — Code review (separate pass, never self-approval)

Dispatch `ecc:typescript-reviewer` on `git diff main...HEAD`. Fix CRITICAL
and HIGH findings, commit, and re-dispatch if any fix was non-trivial.
MEDIUM findings: fix when cheap, otherwise list them in the PR body.

## Stage 3 — Security review

Dispatch `ecc:security-reviewer` on the same diff. The attack surface is
the local Express server (hook routes and dashboard routes on localhost),
child processes spawned with `execFile`, files written under `<repo>` and
`.hive/`, and any board adapter that calls a remote API with a token. The
review is mainly about host/origin checks on routes, argv construction,
path handling (tmp + rename, no writes outside `<repo>`/`.hive/`), and
tokens never reaching config files or logs. Fix CRITICAL/HIGH, re-run to
confirm.

## Stage 4 — PR

Run `ecc:pr` against `main`. The body has, in this order:

1. `Closes #<n>` on its own line, so the merge closes the issue (omit
   without an issue);
2. the spec and plan paths when they exist, or the `Design:` paragraph for
   bounded work;
3. MEDIUM review findings left open, if any;
4. a test plan with the `pnpm test` result plus any manual `pnpm start`
   checks from Stage 1.

Do not merge. End with the PR URL in chat.

## Stops

1. dirty working tree, or on `main`;
2. no plan found;
3. a decision the plan and spec do not settle and no assumption would
   settle safely;
4. `pnpm test` red after `ecc:build-error-resolver` (Stage 1);
5. CRITICAL findings that cannot be fixed without changing the spec
   (Stages 2–3).

On any stop, leave the branch and commits in place, say exactly which
stage stopped and why, and what input would unblock it.
