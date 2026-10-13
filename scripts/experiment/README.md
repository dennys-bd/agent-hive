# Skills A/B experiment (#105)

Compares two ways of running the Hive's stages on the Monitor View (#630). Spec: `docs/agent/hive/specs/2026-10-01-skills-ab-experiment-design.md`, in the docs repository.
- **Arm A:** the repository's commands `/hive-spec`, `/hive-plan`, `/hive-build`, which need the `superpowers` and `ecc` plugins.
- **Arm B:** the Hive plugin's skills `/hive:new-spec`, `/hive:new-plan`, `/hive:new-build`.

## How a pair runs
- **Pairing:** run n of A and run n of B start together. Each draws a token of 6 hex characters and gets its own home (`<state>/homes/<token>`), daemon, port, run branch (`feat/monitor-view-<token>`) and task prefix (`M<TOKEN>`). The next pair starts when both end.
- **Inside a run:** the 8 deliveries go through Spec, Plan, Build and Merge along their blockers. Per arm: 3 workers, 2 in Build, 1 Merge.
- **The workers never learn it is an experiment.** They start from a pair of orphan commits. The code one is the source's tree without `scripts/experiment/`, `test/experiment/` and the `experiment:*` scripts. The docs one is the docs clone's `origin/main` without any doc that names the harness (the #105 spec and plan, and every other plan that lists a harness file), and with the handoff at `agent/handoff_monitor/`. The seed refuses any prompt or text that says experiment, arm, run, benchmark or test.
- **Docs, as in the Hive:** each task worktree gets a docs worktree at `docs/`, on a branch named after its code branch, from the setup line of `CLAUDE.md`, except that a new branch starts from the docs run branch (the docs baseline) instead of `origin/main`. Specs and plans are committed there; those branches stay in the docs clone, never pushed, and the evaluation reads each run's from them.
- **The reviewers never learn the arm.** The tester and the judge work in bare temp folders and see a run only by its token. Every arm tell in the bundle becomes `[redacted]`.
- **Evaluation:** after both runs end, each is evaluated, one at a time.

**Every run spends plan usage.** Nothing touches GitHub but the pushes of the run branches, and nothing at all of a run reaches the real docs repository.

## Before the first night
- **The docs clone.** This clone needs its own clone of the docs repository at `docs/`, whose `origin` is a local repository, as the code side's is: the harness refuses to start otherwise, since a run pushes its docs run branch there. For example, `git clone --bare <the docs repository> ../hive-docs.git`, then `git clone ../hive-docs.git docs`. The docs baseline is taken from that origin's `main`: push the docs there before creating an experiment.
- `pnpm install`, then `pnpm exec playwright install chromium` (the smoke check and the tester share that one Chromium); `claude` logged in, with `superpowers` and `ecc` installed.
- Every worker's Bash runs in Claude Code's sandbox (`sandbox.ts`). At the start the harness writes `.claude/settings.local.json` into this clone (listed in `.git/info/exclude`, so no worker commits it), and each task worktree's setup copies it in. Commands inside the sandbox run without a prompt, so no night stalls on one; none may run outside it; writes reach only the worktree (its docs worktree included), the `.git` of this clone and of `docs/`, and their local origins; reads of `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg` and the experiment's state folder are denied; the network reaches only the npm registry and localhost.
- The clone's commits go unsigned (`git config --local commit.gpgsign false`, set by the harness): the sandbox cannot reach your signing agent, and the workers' commits should not carry your key.
- Claude Code must trust this clone once: run `claude` in it and accept the trust dialog, or every worker waits on it.
- On top of the sandbox, workers run in `--permission-mode dontAsk`: a command Claude Code would still ask about (a `${var}` it cannot check, a `git -c`) is refused at once instead of waiting on a prompt, and the worker writes it another way. They keep the allowlist and the deny list in `seeds/monitor-view/stages.json` (no push but the run's own, no `gh`). The sandbox is what bounds them: it holds the programs a worker runs too, `pnpm test` included.
- **The handoff is the designer's, verbatim** (`seeds/monitor-view/handoff/`: the README, the two `.dc.html`, `support.js` and `png/`, one PNG per `artboards.json` entry). Never edit or regenerate it; the docs baseline carries the whole folder as `agent/handoff_monitor/`, which a worker reads at `docs/agent/handoff_monitor/`. The harness refuses to start if a PNG is missing.
- **The sample state** (`seeds/monitor-view/sample-state.json`) is committed: eight fictional activities in the states the click scenarios need (awaiting approval, stopped, an open PR, two sessions, spread over the stages). The evaluation boots each run's build on it. To use your own data instead, `pnpm experiment:snapshot` replaces it with a sanitized snapshot of your live Hive, which must hold those states at that moment; review the file before committing.
- Start from a terminal, not inside a Claude session. The handoff comes from this checkout, so the default source ref `origin/main` works.
- Review each arm's config first: `pnpm run:experiment-a` and `pnpm run:experiment-b` open a Hive window on that arm's home (`<state>/homes/preview-a` or `preview-b`), with the stages, the worker rules and the 8 deliveries exactly as a run writes them. Every task has auto off, so nothing starts while you look; starting one by hand would run it for real.

## Start
`pnpm experiment:skills --runs 3 --until 07:00`

| Flag | Meaning |
|---|---|
| `--experiment <id>` | the experiment to create or resume |
| `--runs <n>` | pairs; default 3 |
| `--until <HH:MM>` | local time: no new pair after it, and the pair going is never cut |
| `--run-timeout` | default `20h`; a pair can outlast a night |
| `--judge-model` | default `claude-fable-5-1` |
| `--baseline <ref>` | only on creation |

## Resume
`pnpm experiment:skills --experiment <id> [--runs <n>]` picks up at the next pair.
- A pair with one finished run reruns only the other, alone. The report flags it `unpaired`.
- An attempt cut by Ctrl-C or a crash is marked interrupted. Its run branches stay on both origins, and its slot starts over with a new token.
- A changed seed is refused.

## Judge again
`pnpm experiment:evaluate --experiment <id> [--run a1]`

## Where things are
`<state>` is `$XDG_STATE_HOME/agent-hive-lab`, else `~/.local/state/agent-hive-lab`: outside the repository, so a worker cannot reach a home or a result through its own tree (mode 0700).

Under `<state>/experiments/<id>/`:
- `manifest.json`: every attempt, its token, arm, slot and outcome;
- `report.md`: the only file that maps tokens to arms;
- `<token>/`: `metrics.json`, `eval.json`, `clicks.json`, `judge.json`, `screens/`, `bundle/` (what the judge read).

Run homes are under `<state>/homes/<token>/`.
