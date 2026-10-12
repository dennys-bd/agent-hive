# Credits

The skills, subagents and references in this plugin are ports — adapted, not copied verbatim — of work from two other Claude Code plugins and from Impeccable. Their licences allow it; this file is the attribution.

## ecc — MIT

Source: the `ecc` plugin's `agents/`, `commands/` and `skills/`.

| File here | Ported from |
|---|---|
| `agents/architect.md` | `agents/architect.md` |
| `agents/planner.md` | `agents/planner.md` (plan format replaced, see below) |
| `agents/tdd.md` | `agents/tdd-guide.md` |
| `agents/build-fixer.md` | `agents/build-error-resolver.md` |
| `agents/code-reviewer.md` | `agents/code-reviewer.md` |
| `agents/security-reviewer.md` | `agents/security-reviewer.md` |
| `skills/new-pr/SKILL.md` | `commands/pr.md` |
| `reference/design.md` ("Direction", "Bans", "Critique") | `skills/frontend-design-direction/SKILL.md`: the direction, the anti-patterns and the review checklist; read by `agents/designer.md` and `agents/design-reviewer.md` |

## superpowers — Apache 2.0

Source: the `superpowers` plugin's `skills/brainstorming/` and `skills/writing-plans/`.

| File here | Ported from |
|---|---|
| `skills/new-spec/SKILL.md` | `skills/brainstorming/SKILL.md` |
| `agents/spec-reviewer.md` | `skills/brainstorming/spec-document-reviewer-prompt.md` |
| `skills/new-plan/SKILL.md` | `skills/writing-plans/SKILL.md` |
| `agents/plan-reviewer.md` | `skills/writing-plans/plan-document-reviewer-prompt.md` |
| `agents/planner.md` | the plan document format of `skills/writing-plans/SKILL.md` |

## Impeccable — Apache 2.0

Source: the `pbakaus/impeccable` repository at commit `c63b8dd7dd5a5f3c32eaabe1af76d0694f863ed2`, its `.agent/skills/impeccable/`.

| Section of `reference/design.md` | Ported from | Feeds |
|---|---|---|
| "Craft floor", "Bans" | `reference/craft-floor.md` | `agents/designer.md`, `agents/design-reviewer.md` |
| "Refinement preserves, redesign replaces", "Operate and Read" | `SKILL.md`, `reference/operate.md` | `agents/designer.md` |
| "Audit" | `reference/audit.md` | `agents/design-reviewer.md`, and `agents/designer.md`'s self-check as a subagent |
| "Critique" | `reference/critique.md` | `agents/design-reviewer.md`, and `agents/designer.md`'s self-check as a subagent |
| "Polish", "Distill" | `reference/polish.md`, `reference/distill.md` | `agents/designer.md` (refine) |
| "Normalize" | `reference/extract.md` | `agents/designer.md` (normalize) |

## What "ported" means here

Every reference to those plugins was removed, so this plugin needs neither of them installed: their rule files, skills, coverage policy and dispatch templates are gone, language assumptions were dropped, and the two reviewer prompt templates became real subagent definitions. From Impeccable, the launcher, the command line, the detector service and the required product and design context files were dropped; its rules were condensed into one reference, and the repository's own design system takes the context files' place. What a repository needs its subagents to know lives in that repository's `CLAUDE.md`.
