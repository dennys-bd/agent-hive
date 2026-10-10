---
description: "Plan stage for one task: turn the approved spec into docs/agent/hive/plans/<date>-<slug>.md with ecc:planner (opus) and commit it. May ask the user when the spec leaves something open; no approval gate."
argument-hint: "[path to the spec file]"
---

# /hive-plan

Writes the implementation plan for an approved spec and commits it on the
current feature branch. No GitHub interaction.

**Input**: `$ARGUMENTS` — optional path to the spec file. When empty, use
the spec approved in this session by `/hive-spec`; failing that, the most
recent file in `docs/agent/hive/specs/`. Say which spec you are planning
from.

**Bounded path**: when the session's spec is a `Design:` paragraph (no
spec file), there is no plan file; say that the paragraph is the plan and
stop here.

**Working tree**: must be clean and on a feature branch (not `main`).

## Plan

Dispatch `ecc:planner` (model `opus`, its declared default; planning
mistakes are the most expensive to unwind) with the spec to produce
`docs/agent/hive/plans/YYYY-MM-DD-<slug>.md` in the format of
`docs/agent/hive/plans/2026-09-16-pluggable-boards.md`: header block
(Goal, Architecture, Tech Stack, Spec), Global Constraints (copy the
existing list; it is the repo's rule set; update the test count), File map,
then task-by-task steps with checkboxes, interfaces and test code.

The planner may ask the user, with `AskUserQuestion` (prose if it is
unavailable), one question at a time, when the spec, the issue and the
existing specs and code do not settle something it needs. When they do,
it does not ask. There is no approval gate at the end: once the plan is
written, commit it and finish.

```sh
git -C docs add agent/hive/plans
git -C docs commit -m "docs: plan for #<n>"   # "docs: plan for <slug>" without an issue
```

Commit message conventions: `<type>: <description>` or
`<type>(<scope>): <description>`, English, no `Claude-Session` trailer, no
`Co-Authored-By`.

End by stating the plan path. `/hive-build` picks it up from the session.

## Stops

1. dirty working tree, or on `main`;
2. no spec found.
