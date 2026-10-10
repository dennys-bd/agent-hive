---
name: new-plan
description: Plan stage for one task: resolve the conventions, find the spec from the argument or the branch, have the planner write a sliced, indexed plan into the plans folder, review it, and commit. Asks the user in rounds only when the spec left something open; no approval gate.
---

# /hive:new-plan

Writes the implementation plan for an approved spec and commits it as
the conventions say. It does not need the session that wrote the spec:
the branch carries it.

## Input

The arguments are an optional path to the spec file. When absent, find
the spec as `reference/conventions.md` says under "Finding the previous
stage's files", in `specsDir`. Say which spec you are planning from, and
why that one.

## Conventions

First step: read `reference/conventions.md` at this plugin's root
(`../../reference/conventions.md` from this skill's directory) and
resolve the conventions as it says, then state its one line. Talk in
`chatLanguage`; the plan is written in `docsLanguage`.
Read CONTRIBUTING.md as `reference/conventions.md` says and plan the commits, tests and docs it asks for.

## Bounded path

When no spec file is found and this session, or the handoff in front of
the prompt, holds a `Design:` paragraph, there is no plan file: say the
paragraph is the plan and go to "End".

## Working tree

Must be clean and on the task's branch (not the base branch).

## Plan

Dispatch `hive:planner` with the spec's path, the plan's path —
`<plansDir>/YYYY-MM-DD-<slug>.md` in the docs repository, `<slug>` the
spec's without `-design` — the repository's agent instructions file, and
the resolved `docsLanguage`, `delivery`, `sliceSize`, `featureFlags` and
`testCommand`. It writes the plan in the format its definition gives:

- a header block: **Goal** (one sentence), **Architecture** (two to
  three sentences), **Tech Stack** (key technologies and libraries),
  **Spec** (path to the spec this plan implements);
- `## Global Constraints` — the repository's project-wide rules (version
  floors, dependency limits, naming and copy conventions, platform
  requirements, the test command), one line each, with exact values
  copied from the agent instructions file and the spec;
- `## File map` — every file the plan creates or touches and what each
  one is responsible for;
- `## Index` — a table per slice, each row a task's link (an anchor to
  its heading), its files, its estimated lines of code and its risk; no
  prose, except one line for a slice still above `sliceSize.max`;
- `## Slice <k> — <name>` sections holding the `### Task N: <name>`
  sections, each task's body inside `<details><summary>`: **Files**,
  **Interfaces**, and `- [ ]` steps with real code in every code step —
  no placeholders, no "TBD", no "similar to Task N", no reference to a
  type or function not defined in some task. The full code stays: the
  index is a map, not a digest.

`sliceSize` only shapes the split: a delivery up to `max` is one slice,
whatever its size, and is never padded; above it, slices aim inside the
range. Tasks are ordered so the test suite is green at the end of every
task, and so of every slice.

## Questions

When the spec, the issue and the code leave something the plan needs
open, the planner returns its questions instead of a plan. Ask them in
one round, as `reference/conventions.md` says under "Questions", then
dispatch the planner again with the answers. When the invoking prompt
says not to ask the user, tell the planner to answer them itself and
mark each `assumed`. When the spec, the issue and the code settle
something, nobody asks. There is no approval gate at the end: once the
plan is written and reviewed, commit it and finish.

## Review the written plan

Dispatch `hive:plan-reviewer` with the plan's path, the spec's path and
the resolved `sliceSize`, `featureFlags` and `delivery`. Apply its
Issues; its Recommendations are advisory.

## Commit

Commit the plan as `reference/conventions.md` says under "Commit": not
at all when it is ignored, in `docsRepo` when that is set (on that
checkout's branch; `/hive:new-pr` pushes it), otherwise on the task's
branch:

```sh
git add <plan file>
git commit -m "docs: plan for #<n>"
```

`#<n>` is the issue the spec's header names; use `docs: plan for <slug>`
when there is none.

## End

State the plan's path. When the Hive's `hive_done` tool exists, call it
with `{ "plan": "<path>" }`, or with no result on the bounded path.
`/hive:new-build` finds the plan from the branch or from
`{result.plan}`; it does not need this session.

## Subagent substitution

A subagent named for this stage in the repository's `CLAUDE.md`, or in the
prompt that invoked this skill, replaces `hive:planner` or
`hive:plan-reviewer` for that stage. Say which subagent you used.

## Stops

1. a dirty working tree, or the session is on the base branch;
2. no spec found, and no `Design:` paragraph either.

On a stop, say exactly which step stopped, why, and what would unblock
it.
