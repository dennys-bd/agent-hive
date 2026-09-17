# Agent Hive

Run several Claude Code sessions in parallel, each in its own git worktree, pulling tasks from a board — and watch them all on one panel.

Hive starts up to N `claude` workers, each working on one task; when a session ends, the next task in the queue starts on its own. One card per worker shows what it is doing, turns yellow when Claude needs you, and blue once the PR is open. Click a card to read the worker's output and send it a follow-up; Hive observes (through Claude Code hooks) and schedules.

Workers run in one of two modes, chosen in the setup form (`workers` in the config): **embedded** (default) — child processes of the Hive in print mode, JSON over stdio, output and input in the panel, macOS and Linux; or **iterm** — one iTerm2 tab per worker, interactive `claude` that asks permissions in the terminal, "ir pro terminal" on the card, macOS only.

Runs 100% locally, no external service.

## How it works

```
board (GitHub Project or board.md)
        │ poll
        ▼
  ┌────────────┐  spawn   ┌──────────────────────────────────────┐
  │ Agent Hive │ ───────▶ │ claude -p --worktree=<task> (stdio)   │
  │ (Electron) │ ◀─────── │   hooks → POST /hooks/event           │
  └────────────┘  status  └──────────────────────────────────────┘
        │ SSE
        ▼
   dashboard (cards + queue)
```

1. Hive reads the board's "queue" column and fills the free slots (`maxConcurrent`).
2. Each worker is `claude --worktree=<slug> -p --input-format stream-json --output-format stream-json`, a child process of the Hive that receives the prompt on stdin, with a `hooks.json` injected via `--settings`: `SessionStart`, `PreToolUse`, `Notification`, `PostToolUse`, `Stop` and `SessionEnd` each `curl` the Hive.
3. Cards follow the hooks: green (working), yellow (waiting for you: permission, question, idle), blue (`gh pr create` detected). The board item moves to "in progress" and later "in review".
4. A session ending frees the slot; a task without a PR goes back to the queue.

## Install

Requirements: macOS or Linux, Node 24+, pnpm, `claude` (Claude Code), and `gh` logged in (GitHub boards only; run `gh auth refresh -s project` once).

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

Without a `hive.config.json` in the repo, the window opens on a setup form: board type, columns (queue / in progress / in review), max workers and the worker prompt. Saving writes the file and shows the dashboard. "configurar" reopens the form at any time.

On screen: `N/M workers ativos`, the `máx. workers` field (changes live and persists across restarts), the queue, and one card per slot. Click a card to see the pending question or the PR link, the worker's output, and to send it a message; `kill` stops the worker and returns the task to the queue.

The `green` / `yellow` / `red` buttons set a global signal (also `POST /signal {"signal":"red"}`): yellow opens no new job while live workers finish; red is manual mode: nothing new opens and each worker is marked `pausado` when its current turn ends, until the signal leaves red or someone sends it a message from its card. Nothing is ever killed mid-turn. The signal is saved with the state, so the Hive reopens in the same color.

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
| `claudeArgs` | `[]` | file (e.g. `["--permission-mode", "acceptEdits"]`; embedded workers have no permission prompt, so this or the repo's `.claude/settings.json` must allow the tools) |

Older files with `project: { owner, number }` are still accepted. Runtime state lives in `<repo>/.hive/` (kept out of git through `.git/info/exclude`).

## Development

```sh
pnpm test                        # tsc + node --test
pnpm start -- /path/to/repo      # Electron
node dist/src/run.js /repo       # headless server at http://127.0.0.1:47821
```

Architecture: `src/orchestrator.ts` is a pure reducer (state + event → new state + effects); `src/server.ts` receives the hooks, runs the reducer and executes the effects; `src/boards/*` are the adapters; `src/ui/` is HTML + TS with no framework. Specs and plans live in `docs/superpowers/`, next steps in the GitHub issues.

## Known limitations

- Embedded workers (print mode) have no permission prompt; tools not allowed by `claudeArgs` or `.claude/settings.json` are denied. Questions from the worker show on the card; answer them from the card's input.
- iTerm workers show no output in the panel (the tab is the output) and do not free the slot by themselves when the PR opens: close the session in the tab or kill the card. A Hive restart does not readopt open tabs; it kills them and requeues their tasks.
- No auth: the server listens on `127.0.0.1` and rejects other `Host` values.
- Switching boards with live workers keeps those slots bound to the old ids until they exit.

## License

MIT
