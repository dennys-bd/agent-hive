# Agent Hive

A macOS app that keeps several `claude` workers running on the tasks of its sources. Electron window, Express server on localhost, every session and terminal in a pty of the Hive's own.

## Commands

| What | Command |
|---|---|
| Tests (the gate: lint, `tsc`, `node --test` and vitest, run in parallel) | `pnpm test` |
| Lint | `pnpm lint` |
| Run with the window | `pnpm start` |
| Run without the window | `pnpm run:headless <path>` |

`pnpm test` must be green before any commit. There is no coverage gate.

## Where things are

- `src/` — the server, the reducer, the source adapters, the spawners. `src/ui/` is the React dashboard.
- `test/` — `node:test` + `node:assert/strict`, one file per module, source adapters under `test/sources/`. The React UI is tested with vitest.
- `docs/` — not part of this repository (ignored): the clone of the private docs repository, the documentation of the whole Hive ecosystem. Its root holds what every project shares (`docs/glossary.md`); `docs/agent/` is agent-hive's (`docs/agent/design-system.md`, `docs/agent/settings-candidates.md`, the design handoffs). `docs/agent/hive/specs/`, `plans/` and `walkthroughs/` hold the specs, plans and walkthroughs of every delivery. `docs/agent/hive/specs/2026-09-15-agent-hive-design.md` is authoritative for anything a newer spec does not override; every spec says which ones it extends.
- `assets/plugin/` — the Hive's own Claude Code plugin (`/hive:new-spec`, `/hive:new-plan`, `/hive:new-build`, `/hive:new-pr`, `/hive:decomposition` and their agents). Its skills are Liquid templates (`SKILL.md.liquid`): the Hive renders the plugin per workspace into `<home>/plugins/<workspace>/` and loads that folder into every worker with `--plugin-dir`. A human session started with `claude --plugin-dir assets/plugin` gets none of the skills, since Claude Code does not load a `.liquid` file.

## The code graph (#212 experiment)

For the length of the #212 experiment, every checkout has a Graphify graph of the code at `graphify-out/` (ignored), built by the worktree setup and served over MCP. Before grepping or reading whole files to find where something lives, who calls it or what a change reaches, ask the graph (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `get_pr_impact`), then read only the files it points to. The graph can lag behind the working tree: when an answer looks wrong or stale, fall back to grep.

## The docs repository

In the main checkout, clone the docs repository at `docs/`. Each task's worktree gets a worktree of it at its own `docs/`, on a branch named after the task's branch, from these lines in the workspace's Settings:

- worktree setup:
  ```
  RUN main="$(git rev-parse --path-format=absolute --git-common-dir)/.." && branch="$(git branch --show-current)" && git -C "$main/docs" fetch -q origin && if git -C "$main/docs" show-ref --verify -q "refs/heads/$branch"; then git -C "$main/docs" worktree add "$PWD/docs" "$branch"; else git -C "$main/docs" worktree add --no-track -b "$branch" "$PWD/docs" origin/main; fi
  ```
- worktree teardown, before anything else:
  ```
  RUN git -C "$(git rev-parse --path-format=absolute --git-common-dir)/../docs" worktree remove "$PWD/docs"
  ```

The teardown has no `--force` on purpose: a doc left uncommitted fails it instead of being lost. A task's spec, plan and walkthrough are committed in its docs worktree and reach the docs repository through their own PR.

## What counts as bounded here

Bounded: one or two files, no new type in `src/types.ts`, no new source adapter, no new UI panel, no new rule in the orchestrator's reducer. Everything else is architectural and gets a spec: a new `Board` adapter, a change to `Task` / `Config` / `State` / `Card`, a new reducer rule, a new panel or route.

## Rules

- Node 24, pnpm, TypeScript strict. ESM: every relative import ends in `.js`.
- `execFile` with argv arrays, never a shell string — except three deliberate ones. The first is `ptyCommand` in `src/spawn.ts` (it renders the claude run, the shell run and a workspace's command, #300), where every user-controlled value goes through `shellQuote`. A command's own line is a shell string on purpose: the user writes it in Settings and it runs through their `"$SHELL" -c`, quoted whole; its env names are checked against `ENV_NAME` instead, since `export NAME=` cannot quote a name. The second deliberate one is `runShell` in `src/worktree-steps.ts`, which runs a worktree setup's or teardown's `RUN` line through `/bin/sh -c` because the command is the user's own text from Settings (#299, #654). The third is the custom formatter in `src/format-run.ts` (#749): its command line is the user's own text from Settings and runs through `"$SHELL" -c`; the saved file's path reaches it only as `FILE` in the env, never interpolated into the line.
- The reducer in `src/orchestrator.ts` is pure and immutable: it returns new state, never mutates.
- No new runtime dependency without saying so in the spec.
- Tokens only through the environment or the credential store; never in `hive.config.json`, never in a log line, never in a test fixture.
- No machine-specific values in `src/`, `test/` or `assets/`: no absolute home paths, no account names, no GitHub Project numbers.
- Files under 400 lines, functions under 50 lines. Code comments in English, and they say why, not what.
- UI copy ships in English and Portuguese. The signal states are always written `green` / `yellow` / `red`, in every language.
- Before touching the interface, read `docs/agent/design-system.md`. The token values live in `src/ui/theme.css` and `src/ui/index.css`.
- Name concepts as `docs/glossary.md` does: in copy, types, config keys, routes, the plugin and the MCP tools. A retired name stays only where the glossary's "Pending renames" lists it.
- Specs, plans, commit messages, PR bodies and issues are written in English; the conversation with the user is in Portuguese.
- Conventional commits (`<type>: <description>`), no `Co-Authored-By`, no `Claude-Session` trailer.

## Review

Stage 2 of `/hive:new-build` runs `hive:code-reviewer`. On top of its own checklist it must check, for this repository: `strict` holds and no `any` was introduced; every relative import ends in `.js`; the reducer was not made to mutate; no `execFile` call gained a shell string; no token, absolute home path or account name entered the code, a test or a log; every new UI string exists in both languages in `src/ui/i18n.ts`, is agent-neutral, colour is used only for status, the workspace colour and the header's agent colour of `docs/agent/design-system.md` excepted; and no retired name from `docs/glossary.md` was introduced.
