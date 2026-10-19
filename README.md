# Agent Hive

**Design the flow once. Let the agents run it.**

Agent Hive orchestrates your coding agents through the stages you design, from spec to merged PR, and stops only where you said to. Claude Code and Codex today, more to come.

Point the Hive at your tracker (a GitHub Project, your repository's issues, or tasks you create in the Hive) and it starts several agents in parallel, each on its own task in its own git worktree. Every task moves through the stages you define: spec, design, plan, build, run the tests, wait for CI, open the PR. A stage routes by its result, retries within the limits you set, and stops for your approval only where you kept a gate. When an agent has a question or needs a permission, the task turns yellow and you get a notification.

What the Hive does:

- **Runs several agents at once.** Any supported agent, picked per stage (Claude Code and Codex today), each an interactive session in a terminal of the Hive's own. Open any of them, answer it, put it to sleep, wake it later.
- **Drives work through a flow.** Stages are the nodes of a flowchart, agent stages beside deterministic ones (your build and test commands, waiting for CI), with an approval gate where you want a human.
- **Turns a goal into tasks.** The decomposition stage designs a goal layer by layer and splits it into a reviewed tree of tasks with acceptance criteria and blockers, ready to become issues.
- **Keeps the review in your hands.** Approve or send feedback at a gate, comment on a diff line or a rendered design screen and the comment goes back to the agent that made it, review and merge the PR without leaving the window.
- **Is a full workspace.** Files tree, an editor with language servers, diffs, PR pages, search, and terminals, all on the task's own worktree.
- **Watches your plan limits.** The green / yellow / red signal reads your agents' plan usage and your token budget, and decides whether the Hive starts new work, continues started work, or waits.
- **Learns your way of working.** Its own skills and agents (spec, plan, build, PR, decomposition, design, reviews) are templates you edit per workspace, and workers keep a shared memory of what they learned.

Runs locally on macOS and Linux: a daemon on localhost, your own agent CLIs and your own GitHub login, no Hive server in between.

## How it works

```
source (GitHub Project, issues, the Hive's own tasks)
        │ poll
        ▼
  ┌────────────┐  spawn   ┌────────────────────────────────────────────────────────────┐
  │ Agent Hive │ ───────▶ │ claude / codex (a pty of the Hive, in the task's worktree) │
  │ (Electron) │ ◀─────── │   hooks + MCP tools → the Hive                             │
  └────────────┘  status  └────────────────────────────────────────────────────────────┘
        │ SSE
        ▼
   window (the flow, the activities, the review)
```

1. Hive polls each source and turns every item it finds into a task, sitting in whichever `stages[]` entry cites that source column in its `from`. A free worker goes to the stopped task in the latest stage of the flow (ties by the Hive's own order — drag a task to change it).
2. Each worker is an interactive agent CLI (the stage's `agent`, else `defaultAgent`: `claude` or `codex` today) started by the Hive in the task's own worktree (`.hive/worktrees/<slug>` inside the workspace, created with `git worktree add` on the task's branch) inside a pty of the Hive, with the task's stage `prompt`, the Hive's hooks, which report every session event to the Hive, and the Hive's own plugin, its skills and agents (`/hive:new-spec`, `/hive:new-plan`, `/hive:new-build`, `/hive:new-pr`, `/hive:decomposition` — the project needs nothing of its own). For Claude Code the hooks go in through `--settings` and the plugin through `--plugin-dir`.
3. Tasks follow the hooks: green (working), yellow (waiting for you: permission, question, idle), blue (`gh pr create` detected). The source's item gets its source's `onStart` actions when the run starts.
4. A `Stop` ends the run: the source's item gets its source's `onFinish` actions and the task advances to the next stage of the flow (or leaves the flow after the last one).

## Usage

```sh
cd /your/repo
hive
```

The command starts the Hive as a background process (its stdout/stderr go to `~/.config/agent-hive/hive.log`, the boot line there carries its pid) and opens its window. Closing the window changes nothing for the workers or the sources: the Hive keeps polling and the workers keep running. On macOS the viewer stays in the menu bar with the Hive's icon (the Dock icon shows only while the window is open); while the Hive runs, a small hexagon in its bottom-right corner shows the signal in force, green, yellow or red. Its menu opens with the Hive's state, **Hive running**, **Hive needs setup**, **Hive stopped** or **Hive can't start**, with the reason on a second line when it is not running. While the Hive runs, the signal comes next: **Green**, **Yellow** and **Red** switch it as the dashboard's buttons do, those a usage rule holds are disabled, and the heading names the rule's signal when one is in force. Once the plan's limits have been read, a line per plan window follows (session, week), with its percentage, the time until it resets and a small bar in the header's colors; hovering shows when it was read, and clicking one opens the dashboard. Then come the running workers, one line each with a dot in its status color and the task's id and title; clicking one opens the dashboard on that worker's panel. Below them come **Show Hive**, which reopens the window, or retries after an error, **Restart**, which stops the Hive and starts it again without opening the window, and **Quit**, which ends the Hive and its workers the way `hive stop` does and then the viewer. When workers are running, Restart and Quit ask first and name how many. Cmd+Q does the same as Quit. Settings › app › **ao fechar a janela** chooses what closing the window does: the Hive stays in the menu bar with its workers running (the default), or it quits along with its workers, asking first while any run. Running `hive` again opens the window of the running Hive, or focuses it if it is already open; `hive stop` ends the Hive and its workers (`kill <pid>` does the same). There is one Hive per user: `hive` takes no folder, and `hive <anything else>` is a usage error. A daemon already running on the home refuses a second one, naming its pid (#466); a Hive with another `XDG_CONFIG_HOME` never collides, since each home has its own lock and its own port.

The Hive keeps its own files in `${XDG_CONFIG_HOME:-~/.config}/agent-hive/`: `hive.config.json`, `state.json`, `hive.log`, `hooks.json`, `prompts/` and `plugin/`, next to `credentials.json`. Only the workers' worktrees live in the workspace, under `.hive/worktrees/` (kept out of git through `.git/info/exclude`).

Without a `hive.config.json` in the home, the window opens on a setup form. Settings › workspaces starts with the workspaces: one row per git repository the workers run in, each with a name (letters, digits, `.`, `_`, `-`) and a folder. A first run proposes one row for the folder you ran `hive` from, when that is a repository's top level. Inside the window, `Choose…` opens the folder picker. The save refuses a folder that is not the top level of a git repository, and refuses to remove or move a workspace while one of its tasks runs; a workspace with no running task may go, and its worktrees stay where they are. The rest of the form: the Comb's task id prefix, fluxo › sources (empty at first: only tasks created in the Hive; `editar →` opens a source's fields, filter and workspace, `+ source` adds one, saved once a stage enters from it), the stages (name, prompt, session, model, visible tasks and, per source, the source columns each one maps to) and max workers. Saving writes the file and shows the dashboard. Settings… in the app menu, Cmd+, or the menu bar icon reopens the form at any time.

Each workspace in Settings › workspaces has its name and folder, its worktree setup (`COPY`, `RUN` and `LOAD` lines, run once in each new worktree) with a `timeout per step` written as `30s`, `10m` or `1h` (empty = no limit, at most 24h), and its environment: variables in the environment of everything the Hive runs in that workspace (workers, sessions, terminals, run commands and the worktree setup's and teardown's RUN steps). A terminal keeps its own history file and puts the Hive's shims of the agents first on PATH, so an agent typed there runs as the Hive's. The names the Hive sets itself (HIVE_PTY_ID, HIVE_PORT, HIVE_SECRET_FILE, HIVE_SECRET, TMPDIR) cannot be used. Run commands are defined once, in the `commands` section on the same page: each has a name, a command line, the workspaces it is enabled in, an optional timeout written the same way, and its own variables, which win over the workspace's. A task's menu and details panel offer only the commands enabled for its workspace, and a command whose timeout runs out is stopped like its Stop, its console run ending with `tempo esgotado`.

On screen: the **Automação** tab (the left panel by default, movable like any tab) with `N/M workers ativos`, the `máx. workers` field (changes live and persists across restarts), the green / yellow / red signal toggle, the shut-down-when-done toggle and one chip per running task; the signal strip, with the rules in force, in the bar at the bottom; and the flow, one stage beside the next, with one entry per task. Click a task to see the pending question or the PR link, the worktree and branch and an excerpt of the transcript; `terminal` opens the worker's session (a tab of the window's terminal panel, or the window it was opened in) to answer permissions and questions; `close` ends the worker and keeps its worktree for a later resume; the task stays in its stage, free to run again. A task that left its source closes the same way. A stopped task with a worktree has **delete activity** in its ⋯ menu: it closes the task's terminals, then removes the worktree and its local branch only when git would (no uncommitted changes, branch merged), and otherwise shows git's reason and offers `force`, which deletes them along with any commit not pushed; the sessions follow Settings › execution's **delete activity** switches. A stopped task that already ran shows `open session`: it opens a terminal with that agent session resumed in the task's worktree; the task waits (no worker starts on it) until you leave the terminal.

The **Desligar ao terminar** toggle in the Automação tab arms **shut down when done** (it asks first). No new task starts, as under yellow, while the tasks already in flight go on through their stages. A worker waiting for you longer than Settings › execução's shutdown window (10 minutes by default, counted from when it started waiting or from the arming, whichever is later) is closed as by its `close` button and not started again. Once no worker is left, the Hive shuts the computer down: `osascript` on macOS, `systemctl poweroff` on Linux. macOS asks for the Automation permission the first time and an app with unsaved work can still hold the shutdown; Linux refuses it outside a local session, over SSH for instance. The reason then shows in the bar. While armed, the strip above the flow says so and a waiting worker's chip shows when it closes. Pressing the toggle again disarms it; restarting the Hive disarms it too.

Every click on one of an activity's files opens it in the **editor pane**, a tab of the activity's center: a file of the files sidebar, a file path in a worker's terminal (a panel tab or a detached window: `src/a.ts`, `docs/x.md:42`, an absolute path inside the worktree, with an optional `:line` or `:line:col`), a result file the details panel lists (`spec: docs/…`), and the diff pane's `abrir arquivo`. It is Monaco with syntax highlighting; `⌘S` saves to the disk, and a file an agent changed meanwhile shows `mudou no disco` instead of being overwritten. UTF-8 text files up to 1 MB.

The activity sidebar's **files** view lists the activity's worktree (a local activity's checkout) as a tree, empty folders included, and works like VS Code's explorer. A click opens a file in the editor pane; ⌘-click (Ctrl-click off macOS) adds a row to the selection and ⇧-click selects a range. Right-click a file, a folder or the empty area for `novo arquivo`, `nova pasta`, `abrir alterações` (that file's changes pane), `abrir no terminal integrado`, `revelar no Finder`, `recortar`, `copiar`, `colar`, `copiar caminho`, `copiar caminho relativo`, `renomear` and `excluir`. A new name or a rename is typed in the row: Enter confirms, Esc cancels, and a name with `/` makes the folders between; a taken name is refused, never overwritten. `excluir` always asks, then moves the items to the system trash (`/usr/bin/trash`, macOS 14 and later; `gio trash` on Linux). ⌘C and ⌘X put the files on the system clipboard, so they paste in Finder too; ⌘V pastes Finder's files or the tree's own, and a cut pasted in the same activity moves them. With the focus in the tree, rename is ↵ (F2 off macOS), delete ⌘⌫ (Delete) and reveal ⌥⌘R (Ctrl+Alt+R); new file, new folder, the terminal and the two copy paths have no key until one is set in Settings › atalhos. A renamed or moved file keeps its open tabs and their unsaved edits. The +'s `arquivo` opens an untitled file; ⌘S asks where to save it, inside the activity's folder.

Right-click a task → turn **start on its own** off (the task's `auto`): the Hive never starts it on its own, never deletes its activity (unless `deleteActivity.nonAutoTasks`) and never sends it a stage prompt (a worker already running finishes its stage). Its `open session` button starts it in one step: a single popup asks, while the task has no worktree yet, for the base to create it from (the same choice as a start, without the stacked-PR toggle, and the workspace when no rule places the task), then for the type, an agent or `shell`, and for an agent the session, new or an earlier session of the task to resume (a session already open is not offered; a `continue` stage preselects the newest). The worktree, when missing, is created right before the session opens. Each agent session is a free session: it takes no worker, passes the signal and the cap like a manual start, and gets its own `terminal` button on the task; a shell takes none. Move a task without auto to another stage with right-click → `move to` once no session is open on it; turning `auto` back on hands it back to the orchestrator.

Tasks are ordered inside the Hive: drag one onto another task of its stage (or below the last one) to reorder. The order survives polls and restarts and decides who takes a free worker among tasks of the same stage; the source is never written. When the source's own order differs, the stage header shows `ordem da source` / `source order`, which adopts the source's order for that stage only.

The `green` / `yellow` / `red` toggle in the flow sidebar sets the manual signal (also `POST /signal {"signal":"red"}`); usage rules can only make it stricter. What each signal lets the Hive do on its own (start new tasks, resume and continue started ones, run workerless stages) is the `signals` table in Settings › rules; green is fixed. No signal stops a running worker: it finishes its stage, and the signal decides the next step. The Hive opens on `signals.onOpen` (`yellow`, `last` or `green`); a saved red always opens red.

## Configuration

Everything is set in Settings (Cmd+, or the menu bar icon), which writes `hive.config.json` in the Hive's home (`${XDG_CONFIG_HOME:-~/.config}/agent-hive/`).

## Development

```sh
pnpm test                        # in parallel: lint, tsc -p src/ui, tsc + vite build + node --test, vitest
HIVE_PORT=$(cat ~/.config/agent-hive/hive.port) pnpm dev   # Vite dev server with HMR for src/ui; proxies the API to the running Hive
pnpm build                       # tsc, tsc -p src/ui (type-checks the React side; vite build only transpiles), then vite build
pnpm start                       # goes through bin/hive.js: starts the daemon if none answers, opens the viewer
hive stop                        # POST /stop on the daemon, waits until the daemon no longer answers
node dist/src/main.js            # the Electron viewer, attached (debugging); starts the daemon if none answers
node dist/src/run.js             # the daemon in the foreground, on the port it prints (also in `<home>/hive.port`) (pnpm run:headless); Ctrl-C stops it; the dashboard opens only in the viewer: a plain browser has no cookie with the daemon's secret (#467)
```

`HIVE_HOME` moves the whole home elsewhere, in place of `${XDG_CONFIG_HOME:-~/.config}/agent-hive` (an empty or relative value is invalid and counts as unset, like `XDG_CONFIG_HOME`): a test Hive runs beside the installed one with `HIVE_HOME=$PWD/.hive/test-home pnpm run:headless` (or `pnpm start`, which also gives the test window its own `userData`); each home's daemon binds a free port of its own. `.hive/` is already excluded from git. The two must not work the same task in the same repo at once — they share the `.hive/worktrees/<slug>` name, derived from the task's slug.

`pnpm run:test-hive` does that for you with a ready-made home (HIVE-6). It stops a test Hive still running in `<worktree>/.hive/test-home`, copies the committed fixture there (`test/fixtures/test-home/`: the five stages of a real Hive, about 15 local `TEST-n` tasks over them, the worktree as the workspace), deletes `hive.log`, and opens the window. A login (`credentials.json`) and the window's `userData` (`electron/`) are kept. The test Hive binds a free port of its own (its home's `hive.port`) and starts with no free worker (`maxConcurrent: 0`): raise it in Settings to let workers run, until the next `run:test-hive`. Its GitHub source is a sandbox Project that `HIVE_TEST_BOARD_OWNER=<user or org> pnpm seed:test-board` creates once, idempotently: the private repo `<owner>/hive-test-board`, the Project `Hive test board` with the `Status` options `Backlog`, `Ready`, `In progress`, `In review` and `Done`, and three fake issues in each. `gh` must be logged in with the `project` scope. The seed prints the Project number. Then run the Hive with both variables: `HIVE_TEST_BOARD_OWNER=<owner> HIVE_TEST_BOARD_NUMBER=<n> pnpm run:test-hive`.

Architecture: `src/orchestrator.ts` is a pure reducer (state + event → new state + effects); `src/server.ts` receives the hooks, runs the reducer and executes the effects; `src/sources/*` are the adapters; `src/ui/` is a Vite + React + shadcn/ui client of the same API (`src/ui/lib/*`, `i18n.ts` and `highlight.ts` are framework-free and tested with `node:test`; components with logic have Vitest + Testing Library tests under `test/ui/`). Next steps live in the GitHub issues.

## Known limitations

- The panel shows an excerpt of the transcript; the session is the terminal (`terminal` on the task). A Hive restart does not readopt live sessions: it kills them; each task stays in its stage and runs again when a worker is free.
- The Hive cannot focus an open session terminal again; close it and open it again.
- A reopened session runs with the same `agentArgs` as the workers (permission mode included) and without the Hive's hooks: what it does is not counted against the budget or the usage rules, and a PR it opens is not detected. Closing the terminal tab without leaving the agent skips the exit trailer; the next poll notices the process is gone and frees the task.
- The daemon listens on `127.0.0.1`, rejects other `Host` values, and refuses every request without the per-boot secret of `<home>/hive.secret` (#467). A process running as your own user can read that file, the workers' environment and the daemon's memory: the secret keeps other accounts and other programs out, not your own.
- Switching sources with live workers keeps those workers bound to the old ids until they exit.

## License

The Hive is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2). You may use, copy, modify and redistribute it, keeping the license and copyright notices, for any purpose other than a Competing Use: making it available to others in a commercial product or service that substitutes for the Hive or for another product or service the licensor already offers using it, or that offers the same or substantially similar functionality. Each version becomes available under the Apache License 2.0 two years after its release.

Files ported from other projects keep their own licences; `assets/plugin/CREDITS.md` lists them.

Contributions are accepted under the [Contributor License Agreement](CLA.md), signed once on your first pull request.
