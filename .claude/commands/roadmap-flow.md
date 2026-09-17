---
description: "Dev flow for one GitHub issue: read → brainstorm → [approve spec] → plan → branch → TDD → review → security → PR. One human gate, after the spec; the issue is the card; spec and plan are linked from the PR."
argument-hint: "<issue number or URL> [optionally followed by the issue title and body]"
---

# /roadmap-flow

Runs this repo's development pipeline end to end for **one** GitHub issue.
The spec stage is a conversation with the user and ends with their
approval; everything after that runs on its own. Each stage delegates to
an existing skill or agent; this file only sequences them. The issue is
the card: it carries the
intent and the open decisions, and the PR that closes it links the spec and
plan artifacts. The flow moves the card on the board as it advances (see
**Tracking**); `Closes #<n>` closes the issue on merge, and whether that
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

**Human input lives in Stage 1.** Brainstorming asks the user its
questions as usual (that is what the spec stage is for), and the stage
ends when the user approves the spec (see **Stage 1 — Approval**). From
Stage 2 on there are no questions: where a stage would normally ask the
user something, resolve it from the approved spec, the issue body and
comments, the existing specs in `docs/superpowers/specs/`, and the code,
and write the decision down as a stated assumption in the artifact of
that stage.

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

| When | Where it is recorded | Board column |
|---|---|---|
| Stage 0, issue read | scope restated in chat, branch name announced | — |
| End of Stage 1, spec approved | architectural path: `docs/superpowers/specs/<file>.md`; bounded path: a `Design:` paragraph in chat, carried into the PR body | `status.queue` (`Ready`) |
| End of Stage 2 | architectural path: `docs/superpowers/plans/<file>.md` | — |
| End of Stage 3 | branch exists, spec/plan committed | `status.working` (`In progress`) |
| End of Stage 7 | PR body: `Closes #<n>`, spec and plan paths, test plan | `status.review` (`In review`) |

Column names come from `status` in `hive.config.json` at the repo root
(defaults in parentheses); the board is `board.owner` / `board.number` in
the same file. Moving the card:

```sh
gh project view <number> --owner <owner> --format json --jq .id                                  # project id
gh project field-list <number> --owner <owner> --format json --jq '.fields[] | select(.name=="Status")'   # field id + option ids
gh project item-list <number> --owner <owner> --format json --limit 200 --jq '.items[] | select(.content.number==<n>) | {id, status}'
gh project item-edit --id <item-id> --project-id <project-id> --field-id <field-id> --single-select-option-id <option-id>
```

Rules:

- Never move the card backwards. Inside a Hive worker the card is already
  `In progress` when Stage 1 ends, so the `Ready` move is a no-op there;
  it matters when the flow is run by hand on an issue still in the
  backlog. Compare the current `status` from `item-list` before editing.
- No `hive.config.json`, or the issue is not on that board: say so once
  and carry on without board moves; it is not a stop.
- Announce each move in chat as it happens (`board: #<n> → In progress`).
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
| 1 — Spec | `superpowers:brainstorming` (inline, main session) | session model | interactive with the user; no dispatch |
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

## Stage 1 — Spec (brainstorming, interactive)

Invoke `superpowers:brainstorming` with the issue title and body as the
idea. **Only this piece of superpowers is in scope** for the flow. Ask the
user the skill's questions as usual, one at a time; do not answer them
yourself. Skip a question only when the issue body or comments already
close it, and say which answer you took from there.

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
- Every decision, whether taken from the issue or answered by the user,
  goes into the spec's `Decisões fechadas` table (or the `Design:`
  paragraph for bounded work) with its reason. The issue body already
  lists the decisions to close; each one gets a row.
- `docs/superpowers/specs/2026-09-15-agent-hive-design.md` is authoritative
  for anything the issue does not override.

### Stage 1 — Approval

Do not start Stage 2 until the user approves the spec.

1. Show the spec in chat: the path of the spec file plus its `Decisões
   fechadas` table (architectural), or the `Design:` paragraph (bounded).
2. Ask with `AskUserQuestion` (prose if it is unavailable): approve as is,
   or change something. Then wait.
3. On "change": apply the requested changes to the spec (or paragraph),
   show the diff of what changed, and ask again. Repeat until approved.
4. On approval: move the card to `status.queue` (`Ready`) unless it is
   already further along, and continue to Stage 2.

Approval does not commit anything; the spec is committed in Stage 3 with
the plan.

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

Then move the card to `status.working` (`In progress`) unless it is
already further along.

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

Then move the card to `status.review` (`In review`). Do not merge. The
flow ends with the PR URL in chat.

---

## Gates summary

Stage 1 is interactive and ends with the user's approval of the spec;
after that there are no questions. The stop conditions are:

1. dirty working tree, or a branch that is neither `main` nor a fresh
   worktree branch (before Stage 0);
2. no issue given, or the issue cannot be read (Stage 0);
3. a decision after Stage 1 that the approved spec does not settle and no
   assumption would settle safely;
4. `pnpm test` red after `ecc:build-error-resolver` (Stage 4);
5. CRITICAL findings that cannot be fixed without changing the spec
   (Stages 5–6).

On any stop, leave the branch and any spec/plan files in place, say exactly
which stage stopped and why, and what input would unblock it.

## Explicitly out of scope

- Any superpowers skill other than `brainstorming`.
- Labelling the issue, or moving it to any column other than the three in
  **Tracking** (done is the project's workflow after merge).
- Releasing / publishing the package.
