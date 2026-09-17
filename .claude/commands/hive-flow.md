---
description: "Dev flow for one GitHub issue: /hive-spec → /hive-plan → /hive-build, moving the card on the board between them. Human input in the spec (approval) and in the plan (questions only when needed); the issue is the card; spec and plan are linked from the PR."
argument-hint: "<issue number or URL> [optionally followed by the issue title and body]"
---

# /hive-flow

Runs this repo's development pipeline end to end for **one** GitHub issue
by sequencing three commands that also work on their own:

| Stage | Command | Human input |
|---|---|---|
| Spec | `/hive-spec <issue>` | brainstorming questions, then approval of the spec |
| Plan | `/hive-plan` | questions only when the spec leaves something open |
| Build | `/hive-build #<n>` | none |

This file only adds what the pieces leave out: the board moves and the
issue comment on a stop. The issue is the card: it carries the intent and
the open decisions, and the PR that closes it links the spec and plan
artifacts. `Closes #<n>` closes the issue on merge, and whether that moves
the card to done is the project's own workflow.

**Input**: `$ARGUMENTS` — required, passed through to `/hive-spec`: an
issue number or URL, optionally followed by the issue title and body (the
Hive template can be `/hive-flow {url}\n\n{title}\n\n{body}`). If empty,
`/hive-spec` lists open issues and stops.

Free-text ideas are not accepted here (there is no card to move); use
`/hive-spec` directly.

## Sequence

1. `/hive-spec $ARGUMENTS`. Ends with the spec approved, the branch
   created and the spec committed.
2. Board: move the card to `status.queue` (`Ready`) unless it is already
   further along.
3. Board: move the card to `status.working` (`In progress`) unless it is
   already further along.
4. `/hive-plan`.
5. `/hive-build #<n>`. Ends with the PR URL.
6. Board: move the card to `status.review` (`In review`).

The flow ends with the PR URL in chat. Do not merge.

Inside a Hive worker, each stage ends only when the command runs the
`/hooks/done` curl from the trailer the Hive appends to the prompt; a turn
that ends without it leaves the slot yellow (waiting) and the card where it is.

## Tracking (the issue is the card)

| When | Where it is recorded | Board column |
|---|---|---|
| Issue read | scope restated in chat, branch name announced | — |
| Spec approved | architectural path: `docs/superpowers/specs/<file>.md`; bounded path: a `Design:` paragraph in chat, carried into the PR body | `status.queue` (`Ready`) |
| Branch created, spec committed | branch exists | `status.working` (`In progress`) |
| Plan written | architectural path: `docs/superpowers/plans/<file>.md` | — |
| PR opened | PR body: `Closes #<n>`, spec and plan paths, test plan | `status.review` (`In review`) |

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
  `In progress` when the spec is approved, so the `Ready` move is a no-op
  there; it matters when the flow is run by hand on an issue still in the
  backlog. Compare the current `status` from `item-list` before editing.
- No `hive.config.json`, or the issue is not on that board: say so once
  and carry on without board moves; it is not a stop.
- Announce each move in chat as it happens (`board: #<n> → In progress`).
- Comment on the issue only when the information would otherwise be lost:
  on a stop (the gap found and what would unblock it), or a decision from
  the spec that changes what the issue asked for. Status never goes in a
  comment; the PR and the board carry it. Do not edit the issue body or
  its labels.

## Stops

Each command has its own stop list; a stop in any of them stops the flow.
On a stop, leave the branch and any spec/plan files in place, say which
command and stage stopped and why, what input would unblock it, and
comment that on the issue.

## Explicitly out of scope

- Any superpowers skill other than `brainstorming` (inside `/hive-spec`).
- Labelling the issue, or moving it to any column other than the three in
  **Tracking** (done is the project's workflow after merge).
- Releasing / publishing the package.
