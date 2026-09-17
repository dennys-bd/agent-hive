---
description: "Spec stage for one task: read the issue (or a free-text idea) → brainstorm with the user → approve the spec → create the branch and commit the spec. Interactive; no board moves."
argument-hint: "<issue number or URL | free-text idea> [optionally followed by the issue title and body]"
---

# /hive-spec

Turns a GitHub issue or a free-text idea into an approved spec on its own
feature branch. It is the first piece of `/hive-flow` and also works on its
own. It reads GitHub (the issue) but never moves the card on the board;
that is `/hive-flow`'s job.

**Input**: `$ARGUMENTS` — required. One of:

- an issue number (`36`, `#36`) or URL
  (`https://github.com/<owner>/<repo>/issues/36`), optionally followed by
  the issue title and body already inlined (`{url}\n\n{title}\n\n{body}`).
  When the title and body are present, use them as-is and skip the
  `gh issue view`;
- anything else: a free-text idea, used verbatim as the brainstorming input.

If `$ARGUMENTS` is empty, run `gh issue list --state open --limit 10`, show
the candidates and stop.

**Working tree**: `git status --short --branch` must be clean. If it is
not, stop and say what is dirty; never stash or discard on the user's
behalf. Two ways to start:

- **on `main`**: this command creates the feature branch (step 3);
- **on a fresh worktree branch** (Agent Hive spawns `claude --worktree=<slug>`,
  so the session already sits on a branch named after the task): keep that
  branch as the feature branch and skip the `checkout -b`. Any other branch
  with commits ahead of `main` is a stop.

## 1. Read the issue

Skip when the input is a free-text idea.

1. Extract the issue number (a bare number, `#n`, or the last path segment
   of the URL).
2. Unless the title and body came inlined, fetch them:

   ```sh
   gh issue view <n> --json number,title,body,url,labels,comments
   ```

   Read the comments too; they often close decisions the body leaves open.
   If `gh` fails (not found, rate limit), stop and report the exact error.
3. Restate the scope in two or three sentences in chat.
4. Derive the branch name now: the current branch when already on a
   worktree branch, otherwise `feat/<slug>` (slug from the issue title or
   the idea, kebab-case, ≤ 5 words, e.g. `feat/blockers`, `feat/board-asana`).

## 2. Spec (brainstorming, interactive)

Invoke `superpowers:brainstorming` with the issue title and body (or the
idea) as the input. **Only this piece of superpowers is in scope.** Ask
the user the skill's questions as usual, one at a time; do not answer them
yourself. Skip a question only when the issue body or comments already
close it, and say which answer you took from there.

Runs inline in the current session (session model); no dispatch.

- Classify per that skill's rules:
  - **bounded** (one or two files, no new type in `src/types.ts`, no new
    adapter, no UI panel): write a short `Design:` paragraph in chat. No
    spec file. The paragraph goes into the PR body later.
  - **architectural** (new `Board` adapter, change to `Task`/`Config`/
    `State`, new orchestrator rule, new UI panel): write
    `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`, in Portuguese,
    following the structure of
    `docs/superpowers/specs/2026-09-16-pluggable-boards-design.md`
    (`Decisões fechadas` table, config, types, per-file behaviour, tests).
    Reference the v1 spec and the specs it extends instead of restating
    them; describe only the delta. Cite the issue (`#<n>`) in the header
    when there is one.
- Every decision, whether taken from the issue or answered by the user,
  goes into the spec's `Decisões fechadas` table (or the `Design:`
  paragraph for bounded work) with its reason. The issue body already
  lists the decisions to close; each one gets a row.
- `docs/superpowers/specs/2026-09-15-agent-hive-design.md` is authoritative
  for anything the issue does not override.

### Approval

Do not go to step 3 until the user approves the spec.

1. Show the spec in chat: the path of the spec file plus its `Decisões
   fechadas` table (architectural), or the `Design:` paragraph (bounded).
2. Ask with `AskUserQuestion` (prose if it is unavailable): approve as is,
   or change something. Then wait.
3. On "change": apply the requested changes to the spec (or paragraph),
   show the diff of what changed, and ask again. Repeat until approved.
4. On approval, continue to step 3.

## 3. Branch and commit

```sh
git checkout -b <branch-from-step-1> main   # skip when already on the worktree branch
git add docs/superpowers/specs               # architectural path only
git commit -m "docs: spec for #<n>"          # architectural path only; "docs: spec for <slug>" without an issue
```

Bounded path: nothing to commit; the first commit is the first green task
of `/hive-build`.

Commit message conventions: `<type>: <description>` or
`<type>(<scope>): <description>`, English, no `Claude-Session` trailer, no
`Co-Authored-By`.

End by stating the branch, the issue number (if any) and the spec path (or
the `Design:` paragraph). `/hive-plan` picks them up from the session.

## Stops

1. dirty working tree, or a branch that is neither `main` nor a fresh
   worktree branch;
2. no input given, or the issue cannot be read.

On a stop, say exactly which step stopped and why, and what input would
unblock it.
