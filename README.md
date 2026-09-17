# Agent Hive

Run several Claude Code sessions in parallel, each in its own git worktree, pulling tasks from a board — and watch them all on one panel.

Hive starts up to N `claude` workers, each working on one task; when a session ends, the card advances to its next column and the next card waiting for a slot starts on its own. One card per worker shows what it is doing, turns yellow when Claude needs you, and blue once the PR is open. Click a card for the details and `terminal` to open its session; Hive observes (through Claude Code hooks) and schedules.

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
   dashboard (Hive board + slots)
```

1. Hive polls the board and turns every task it finds into a card, sitting in whichever `columns[]` entry cites that board column in its `from`. A free slot goes to the stopped card whose column has the highest `weight` (ties by board order).
2. Each worker is an interactive `claude --worktree=<slug>` in a `tmux` session of the Hive, started with the card's column `prompt` and a `hooks.json` injected via `--settings`: `SessionStart`, `PreToolUse`, `Notification`, `PostToolUse`, `Stop` and `SessionEnd` each `curl` the Hive.
3. Cards follow the hooks: green (working), yellow (waiting for you: permission, question, idle), blue (`gh pr create` detected). The board item moves to the column's `onStart` when the run starts.
4. A `Stop` ends the run: the board item moves to the column's `onFinish` and the card advances to the next column in the pipeline (or leaves the board after the last one).

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

Without a `hive.config.json` in the repo, the window opens on a setup form: board type, the Hive columns (name, prompt, session, model, weight and the board columns each one maps to) and max workers. Saving writes the file and shows the dashboard. "configurar" reopens the form at any time.

On screen: `N/M workers ativos`, the `máx. workers` field (changes live and persists across restarts), the Hive board with one column per configured column, and one card per slot. Click a card to see the pending question or the PR link, the worktree and branch and an excerpt of the transcript; `terminal` opens the worker's session in a terminal (iTerm2 or Terminal.app on macOS, `$TERMINAL` on Linux) to answer permissions and questions; `kill` stops the worker and the card stays in its column, free to run again.

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

## Hive columns

`columns[]` is the Hive's own board — one entry per stage of the pipeline, array order = pipeline order:

```json
"columns": [
  { "name": "spec", "weight": 5, "from": ["Backlog"], "onFinish": "Ready",
    "prompt": "/hive-spec {url}", "session": "new", "model": "opus" },
  { "name": "dev", "weight": 1, "from": ["Ready"], "onStart": "In progress", "onFinish": "In review",
    "prompt": "/hive-build {url}", "session": "continue" },
  { "name": "review", "weight": 0, "from": ["In review"] }
]
```

Each column has a `prompt` (placeholders: `{id}`, `{title}`, `{body}`, `{url}`, `{number}` = `{id}`), a `session` policy (`new` starts a fresh session, `continue` resumes the card's own), a `model`, a `weight` (higher wins a free slot when several columns have stopped cards; ties by board order) and the board columns it enters `from` / writes to on `onStart` and `onFinish`. The card advances when the command ends (`Stop`), not by hand. A column without a `prompt` only shows the card — nothing runs there.

## Config (`hive.config.json`)

| field | default | where to edit |
|---|---|---|
| `board` | — | form |
| `columns` | — | form |
| `workers` | `embedded` | form (`embedded` or `iterm`) |
| `maxConcurrent` | `2` | dashboard header (only seeds the first boot; the running Hive keeps its own value across restarts) |
| `port` | `47821` | file (requires restart) |
| `claudeArgs` | `[]` | file (e.g. `["--permission-mode", "acceptEdits"]`) |
| `logLevel` | `info` | file (`info` or `debug`; re-read on every save of the setup form, no restart needed) |
| `language` | system (`pt` when the OS locale starts with `pt`, else `en`) | form (`pt` or `en`; the dashboard and the setup form switch on save, no reload) |

Older files with `project: { owner, number }` are still accepted. Runtime state lives in `<repo>/.hive/` (kept out of git through `.git/info/exclude`), including `hive.log`: one line per thing the Hive did (`tail -f .hive/hive.log`), rotated once at 5 MB into `hive.log.1`; `logLevel: "debug"` adds every hook event and every `gh` call.

## Development

```sh
pnpm test                        # tsc + vite build, then node --test and vitest
pnpm dev                         # Vite dev server with HMR for src/ui; proxies the API to a Hive on 127.0.0.1:47821 (HIVE_PORT overrides)
pnpm exec tsc -p src/ui          # type-checks the React side (vite build only transpiles)
pnpm start -- /path/to/repo      # goes through bin/hive.js, detaches
node dist/src/main.js /repo      # Electron, stays attached (debugging)
node dist/src/run.js /repo       # headless server at http://127.0.0.1:47821
```

Architecture: `src/orchestrator.ts` is a pure reducer (state + event → new state + effects); `src/server.ts` receives the hooks, runs the reducer and executes the effects; `src/boards/*` are the adapters; `src/ui/` is a Vite + React + shadcn/ui client of the same API (`src/ui/lib/*`, `i18n.ts` and `highlight.ts` are framework-free and tested with `node:test`; components with logic have Vitest + Testing Library tests under `test/ui/`). Specs and plans live in `docs/superpowers/`, next steps in the GitHub issues.

## Known limitations

- The panel shows an excerpt of the transcript; the session is the terminal (`terminal` on the card). A Hive restart does not readopt live sessions: it kills them; each card stays in its column and runs again when a slot is free.
- No auth: the server listens on `127.0.0.1` and rejects other `Host` values.
- Switching boards with live workers keeps those slots bound to the old ids until they exit.

## License

MIT
