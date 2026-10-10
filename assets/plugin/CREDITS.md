# Credits

The skills and subagents in this plugin are ports — adapted, not copied verbatim — of work from two other Claude Code plugins. Their licences allow it; this file is the attribution.

## ecc — MIT

Source: the `ecc` plugin's `agents/` and `commands/`.

| File here | Ported from |
|---|---|
| `agents/architect.md` | `agents/architect.md` |
| `agents/planner.md` | `agents/planner.md` (plan format replaced, see below) |
| `agents/tdd.md` | `agents/tdd-guide.md` |
| `agents/build-fixer.md` | `agents/build-error-resolver.md` |
| `agents/code-reviewer.md` | `agents/code-reviewer.md` |
| `agents/security-reviewer.md` | `agents/security-reviewer.md` |
| `skills/new-pr/SKILL.md` | `commands/pr.md` |

## superpowers — Apache 2.0

Source: the `superpowers` plugin's `skills/brainstorming/` and `skills/writing-plans/`.

| File here | Ported from |
|---|---|
| `skills/new-spec/SKILL.md` | `skills/brainstorming/SKILL.md` |
| `agents/spec-reviewer.md` | `skills/brainstorming/spec-document-reviewer-prompt.md` |
| `skills/new-plan/SKILL.md` | `skills/writing-plans/SKILL.md` |
| `agents/plan-reviewer.md` | `skills/writing-plans/plan-document-reviewer-prompt.md` |
| `agents/planner.md` | the plan document format of `skills/writing-plans/SKILL.md` |

## What "ported" means here

Every reference to those plugins was removed, so this plugin needs neither of them installed: their rule files, skills, coverage policy and dispatch templates are gone, language assumptions were dropped, and the two reviewer prompt templates became real subagent definitions. What a repository needs its subagents to know lives in that repository's `CLAUDE.md`.
