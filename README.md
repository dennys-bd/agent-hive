# Agent Hive

Run several Claude Code sessions in parallel, each in its own git worktree, pulling tasks from a board — and watch them all on one panel.

Hive starts up to N `claude` workers, each working on one task; when a session ends, the next task in the queue starts on its own. One card per worker shows what it is doing, turns yellow when Claude needs you, and blue once the PR is open. Click a card for the details and `terminal` to open its session; Hive observes (through Claude Code hooks) and schedules.

Workers run in one of two modes, chosen in the setup form (`workers` in the config): **embedded** (default) — an interactive `claude` in a detached `tmux` session owned by the Hive (`tmux -L hive`), opened in your terminal on demand (`terminal` on the card), macOS and Linux; or **iterm** — one iTerm2 tab per worker, macOS only. Both are real interactive sessions: permissions and questions are answered in the terminal.

Runs 100% locally, no external service.

## How it works

```
board (GitHub Project or board.md)
        │ poll
        ▼
  ┌────────────┐  spawn   ┌──────────────────────────────────────────┐
  │ Agent Hive │ ───────▶ │ claude --worktree=<task> (tmux session)   │
  │ (Electron) │ ◀─────── │   hooks → POST /hooks/event               │
  └────────────┘  status  └──────────────────────────────────────────┘
        │ SSE
        ▼
   dashboard (cards + queue)
```

1. Hive reads the board's "queue" column and fills the free slots (`maxConcurrent`).
2. Each worker is an interactive `claude --worktree=<slug>` in a `tmux` session of the Hive, started with the rendered prompt and a `hooks.json` injected via `--settings`: `SessionStart`, `PreToolUse`, `Notification`, `PostToolUse`, `Stop` and `SessionEnd` each `curl` the Hive.
3. Cards follow the hooks: green (working), yellow (waiting for you: permission, question, idle), blue (`gh pr create` detected). The board item moves to "in progress" and later "in review".
4. A session ending frees the slot (a `Stop` with the PR open ends it); a task without a PR goes back to the queue.

## Install

Requirements: macOS or Linux, Node 24+, pnpm, `claude` (Claude Code), `tmux` for the embedded mode (`brew install tmux` / `apt install tmux`), and `gh` logged in (GitHub boards only; run `gh auth refresh -s project` once).

```sh
git clone git@github.com:dennys-bd/agent-hive.git && cd agent-hive
pnpm install && pnpm build && pnpm link --global
```

This creates the `hive` command (through `pnpm setup` if you don't have `PNPM_HOME` yet).

## Usage

```sh
cd /your/repo
hive
```

The command returns right away; the Hive and its workers keep running detached even if you close the terminal. stdout/stderr go to `<repo>/.hive/hive.log`. Running `hive` again while one is already up just prints the running instance's address instead of starting a second one.

Without a `hive.config.json` in the repo, the window opens on a setup form: board type, columns (queue / in progress / in review), max workers and the worker prompt. Saving writes the file and shows the dashboard. "configurar" reopens the form at any time.

On screen: `N/M workers ativos`, the `máx. workers` field (changes live and persists across restarts), the queue, and one card per slot. Click a card to see the pending question or the PR link, the worktree and branch and an excerpt of the transcript; `terminal` opens the worker's session in a terminal (iTerm2 or Terminal.app on macOS, `$TERMINAL` on Linux) to answer permissions and questions; `kill` stops the worker and returns the task to the queue.

The `green` / `yellow` / `red` buttons set a global signal (also `POST /signal {"signal":"red"}`): yellow opens no new job while live workers finish; red is manual mode: nothing new opens and each worker is marked `pausado` when its current turn ends, until the signal leaves red or someone types in its terminal. Nothing is ever killed mid-turn. The signal is saved with the state, so the Hive reopens in the same color.

## Boards

### GitHub Projects v2

```json
"board": { "type": "github", "owner": "@me", "number": 6 }
```

Columns are the options of the project's `Status` field. Hive moves items between them.

### Markdown

```json
"board": { "type": "markdown", "path": "board.md" }
```

The file needs a table with `| id | título | status |` (columns in any order, extra columns allowed; `title` also works). The rest of the file is free — describe the tasks below the table, your agent's command finds them by id. Hive only rewrites the `status` cell; everything else stays byte-for-byte identical.

```md
| id  | título              | status      |
|-----|---------------------|-------------|
| T-1 | OAuth login         | Ready       |
| T-2 | Profile page        | In progress |

## T-1 OAuth login
Details the worker should read…
```

If the file does not exist, setup creates it with one example row in `Done`.

## Worker prompt

`promptTemplate` is the session's initial prompt. Placeholders: `{id}`, `{title}`, `{body}`, `{url}` (`{number}` = `{id}`). A slash command from your repo works as the entrypoint:

```json
"promptTemplate": "/ship #{id}"
```

Default: `Task #{id}: {title}`, the body, and an instruction to open a PR with `gh pr create`.

## Config (`hive.config.json`)

| field | default | where to edit |
|---|---|---|
| `board` | — | form |
| `status.queue` / `working` / `review` | `Ready` / `In progress` / `In review` | form |
| `workers` | `embedded` | form (`embedded` or `iterm`) |
| `maxConcurrent` | `2` | dashboard header (only seeds the first boot; the running Hive keeps its own value across restarts) |
| `promptTemplate` | see above | form |
| `port` | `47821` | file (requires restart) |
| `claudeArgs` | `[]` | file (e.g. `["--permission-mode", "acceptEdits"]`) |
| `logLevel` | `info` | file (`info` or `debug`; re-read on every save of the setup form, no restart needed) |

Older files with `project: { owner, number }` are still accepted. Runtime state lives in `<repo>/.hive/` (kept out of git through `.git/info/exclude`), including `hive.log`: one line per thing the Hive did (`tail -f .hive/hive.log`), rotated once at 5 MB into `hive.log.1`; `logLevel: "debug"` adds every hook event and every `gh` call.

## Development

```sh
pnpm test                        # tsc + node --test
pnpm start -- /path/to/repo      # goes through bin/hive.js, detaches
node dist/src/main.js /repo      # Electron, stays attached (debugging)
node dist/src/run.js /repo       # headless server at http://127.0.0.1:47821
```

Architecture: `src/orchestrator.ts` is a pure reducer (state + event → new state + effects); `src/server.ts` receives the hooks, runs the reducer and executes the effects; `src/boards/*` are the adapters; `src/ui/` is HTML + TS with no framework. Specs and plans live in `docs/superpowers/`, next steps in the GitHub issues.

## Known limitations

- The panel shows an excerpt of the transcript; the session is the terminal (`terminal` on the card). A Hive restart does not readopt live sessions: it kills them and requeues their tasks.
- No auth: the server listens on `127.0.0.1` and rejects other `Host` values.
- Switching boards with live workers keeps those slots bound to the old ids until they exit.

## License

MIT
