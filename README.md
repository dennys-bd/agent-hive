# Agent Hive

Run several Claude Code sessions in parallel, each in a git worktree the Hive creates, pulling tasks from a source — and watch them all on one panel.

Hive starts up to N `claude` workers, each working on one task; when a session ends, the task advances to its next stage and the next task waiting for a free worker starts on its own. Each running task shows what its worker is doing, turns yellow when Claude needs you, and blue once the PR is open. Click a task for the details and `terminal` to open its session; Hive observes (through Claude Code hooks) and schedules.

Every worker is an interactive `claude` in a pty of the Hive's own, shown as a tab of the window's terminal panel. `terminal` on the task opens it. The panel docks left or at the bottom, and Cmd+J shows and hides it. A tab's right-click › **Open in a window** gives it a window of its own, which docks back through its title's right-click or its dock button. Closing a tab or a window leaves the worker running. Nothing to install. It is a real interactive session: permissions and questions are answered in the terminal.

Runs 100% locally, no external service.

## How it works

```
source (GitHub Project)
        │ poll
        ▼
  ┌────────────┐  spawn   ┌────────────────────────────────────────────────────┐
  │ Agent Hive │ ───────▶ │ claude (a pty of the Hive, in the task's worktree) │
  │ (Electron) │ ◀─────── │   hooks → POST /hooks/event                        │
  └────────────┘  status  └────────────────────────────────────────────────────┘
        │ SSE
        ▼
   dashboard (the flow + workers)
```

1. Hive polls each source and turns every item it finds into a task, sitting in whichever `stages[]` entry cites that source column in its `from`. A free worker goes to the stopped task in the latest stage of the flow (ties by the Hive's own order — drag a task to change it).
2. Each worker is an interactive `claude` started by the Hive in the task's own worktree (`.hive/worktrees/<slug>` inside the workspace, created with `git worktree add` on the task's branch) inside a pty of the Hive, with the task's stage `prompt` and a `hooks.json` injected via `--settings`: `SessionStart`, `PreToolUse`, `Notification`, `PostToolUse`, `Stop` and `SessionEnd` each `curl` the Hive, and the Hive's own skills and agents injected via `--plugin-dir` (`/hive:new-spec`, `/hive:new-plan`, `/hive:new-build`, `/hive:new-pr` — the project needs nothing in its `.claude/`).
3. Tasks follow the hooks: green (working), yellow (waiting for you: permission, question, idle), blue (`gh pr create` detected). The source's item gets its source's `onStart` actions when the run starts.
4. A `Stop` ends the run: the source's item gets its source's `onFinish` actions and the task advances to the next stage of the flow (or leaves the flow after the last one).

## Install


Requirements: macOS or Linux, Node 24+, pnpm, `claude` (Claude Code), and, for a GitHub source, whichever transport `auth.github` names: `"cli"` needs `gh` logged in (`gh auth refresh -s project` once), `"api"` needs the Hive's own login — the `connect GitHub` button on the setup screen, or `hive login`.

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

The command starts the Hive as a background process (its stdout/stderr go to `~/.config/agent-hive/hive.log`, the boot line there carries its pid) and opens its window. Closing the window changes nothing for the workers or the sources: the Hive keeps polling and the workers keep running. On macOS the viewer stays in the menu bar with the Hive's icon (the Dock icon shows only while the window is open); while the Hive runs, a small hexagon in its bottom-right corner shows the signal in force, green, yellow or red. Its menu opens with the Hive's state, **Hive running**, **Hive needs setup**, **Hive stopped** or **Hive can't start**, with the reason on a second line when it is not running. While the Hive runs, the signal comes next: **Green**, **Yellow** and **Red** switch it as the dashboard's buttons do, those a usage rule holds are disabled, and the heading names the rule's signal when one is in force. Once the plan's limits have been read, a line per plan window follows (session, week), with its percentage, the time until it resets and a small bar in the header's colors; hovering shows when it was read, and clicking one opens the dashboard. Then come the running workers, one line each with a dot in its status color and the task's id and title; clicking one opens the dashboard on that worker's panel. Below them come **Show Hive**, which reopens the window, or retries after an error, **Restart**, which stops the Hive and starts it again without opening the window, and **Quit**, which ends the Hive and its workers the way `hive stop` does and then the viewer. When workers are running, Restart and Quit ask first and name how many. Cmd+Q does the same as Quit. Settings › app › **ao fechar a janela** chooses what closing the window does: the Hive stays in the menu bar with its workers running (the default), or it quits along with its workers, asking first while any run. A `hive.config.json` from before this setting (`menuBar`, `stopOnClose`) is read with `onClose` set from them and written that way on the next save. Running `hive` again opens the window of the running Hive, or focuses it if it is already open; `hive stop` ends the Hive and its workers (`kill <pid>` does the same). There is one Hive per user: `hive` takes no folder, and `hive <anything else>` is a usage error. A daemon already running on the home refuses a second one, naming its pid (#466); a Hive with another `XDG_CONFIG_HOME` never collides, since each home has its own lock and its own port.

The Hive keeps its own files in `${XDG_CONFIG_HOME:-~/.config}/agent-hive/`: `hive.config.json`, `state.json`, `hive.log`, `hooks.json`, `prompts/` and `plugin/`, next to `credentials.json`. Only the workers' worktrees live in the workspace, under `.hive/worktrees/` (kept out of git through `.git/info/exclude`). A `hive.config.json` or `.hive/state.json` an older build left in a repo is ignored and never deleted; copy it into the home by hand before the first run if you want to keep it.

Without a `hive.config.json` in the home, the window opens on a setup form. Settings › workspaces starts with the workspaces: one row per git repository the workers run in, each with a name (letters, digits, `.`, `_`, `-`) and a folder. A first run proposes one row for the folder you ran `hive` from, when that is a repository's top level. Inside the window, `Choose…` opens the folder picker. The save refuses a folder that is not the top level of a git repository, and refuses to remove or move a workspace while one of its tasks runs; a workspace with no running task may go, and its worktrees stay where they are. The rest of the form: the Comb's task id prefix, fluxo › sources (empty at first: only tasks created in the Hive; `editar →` opens a source's fields, filter and workspace, `+ source` adds one, saved once a stage enters from it), the stages (name, prompt, session, model, visible tasks and, per source, the source columns each one maps to) and max workers. Saving writes the file and shows the dashboard. Settings… in the app menu, Cmd+, or the menu bar icon reopens the form at any time.

Each workspace in Settings › workspaces has its name and folder, its worktree setup (`COPY`, `RUN` and `LOAD` lines, run once in each new worktree) with a `timeout per step` written as `30s`, `10m` or `1h` (empty = no limit, at most 24h), and its environment: variables in the environment of everything the Hive runs in that workspace (workers, sessions, terminals, run commands and the worktree setup's and teardown's RUN steps). A terminal keeps its own history file and puts the Hive's claude first on PATH. The names the Hive sets itself (HIVE_PTY_ID, HIVE_PORT, HIVE_SECRET_FILE, HIVE_SECRET, TMPDIR) cannot be used. Run commands are defined once, in the `commands` section on the same page: each has a name, a command line, the workspaces it is enabled in, an optional timeout written the same way, and its own variables, which win over the workspace's. A task's menu and details panel offer only the commands enabled for its workspace, and a command whose timeout runs out is stopped like its Stop, its console run ending with `tempo esgotado`. A `hive.config.json` from before this layout (commands under each workspace, `setupTimeoutMinutes`) is read in the new shape and written that way on the next save.

On screen: the **Automação** tab (the left panel by default, movable like any tab) with `N/M workers ativos`, the `máx. workers` field (changes live and persists across restarts), the green / yellow / red signal toggle, the shut-down-when-done toggle and one chip per running task; the signal strip, with the rules in force, in the bar at the bottom; and the flow, one stage beside the next, with one entry per task. Click a task to see the pending question or the PR link, the worktree and branch and an excerpt of the transcript; `terminal` opens the worker's session (a tab of the window's terminal panel, or the window it was opened in) to answer permissions and questions; `close` ends the worker and keeps its worktree for a later resume; the task stays in its stage, free to run again. A task that left its source closes the same way. A stopped task with a worktree has **delete activity** in its ⋯ menu: it closes the task's terminals, then removes the worktree and its local branch only when git would (no uncommitted changes, branch merged), and otherwise shows git's reason and offers `force`, which deletes them along with any commit not pushed; the sessions follow Settings › execution's **delete activity** switches. A stopped task that already ran shows `open session`: it opens a terminal with that Claude session resumed in the task's worktree; the task waits (no worker starts on it) until you leave the terminal.

The **Desligar ao terminar** toggle in the Automação tab arms **shut down when done** (it asks first). No new task starts, as under yellow, while the tasks already in flight go on through their stages. A worker waiting for you longer than Settings › execução's shutdown window (10 minutes by default, counted from when it started waiting or from the arming, whichever is later) is closed as by its `close` button and not started again. Once no worker is left, the Hive shuts the computer down: `osascript` on macOS, `systemctl poweroff` on Linux. macOS asks for the Automation permission the first time and an app with unsaved work can still hold the shutdown; Linux refuses it outside a local session, over SSH for instance. The reason then shows in the bar. While armed, the strip above the flow says so and a waiting worker's chip shows when it closes. Pressing the toggle again disarms it; restarting the Hive disarms it too.

Every click on one of an activity's files opens it in the **editor pane**, a tab of the activity's center: a file of the files sidebar, a file path in a worker's terminal (a panel tab or a detached window: `src/a.ts`, `docs/x.md:42`, an absolute path inside the worktree, with an optional `:line` or `:line:col`), a result file the details panel lists (`spec: docs/…`), and the diff pane's `abrir arquivo`. It is Monaco with syntax highlighting; `⌘S` saves to the disk, and a file an agent changed meanwhile shows `mudou no disco` instead of being overwritten. UTF-8 text files up to 1 MB.

The activity sidebar's **files** view lists the activity's worktree (a local activity's checkout) as a tree, empty folders included, and works like VS Code's explorer. A click opens a file in the editor pane; ⌘-click (Ctrl-click off macOS) adds a row to the selection and ⇧-click selects a range. Right-click a file, a folder or the empty area for `novo arquivo`, `nova pasta`, `abrir alterações` (that file's changes pane), `abrir no terminal integrado`, `revelar no Finder`, `recortar`, `copiar`, `colar`, `copiar caminho`, `copiar caminho relativo`, `renomear` and `excluir`. A new name or a rename is typed in the row: Enter confirms, Esc cancels, and a name with `/` makes the folders between; a taken name is refused, never overwritten. `excluir` always asks, then moves the items to the system trash (`/usr/bin/trash`, macOS 14 and later; `gio trash` on Linux). ⌘C and ⌘X put the files on the system clipboard, so they paste in Finder too; ⌘V pastes Finder's files or the tree's own, and a cut pasted in the same activity moves them. With the focus in the tree, rename is ↵ (F2 off macOS), delete ⌘⌫ (Delete) and reveal ⌥⌘R (Ctrl+Alt+R); new file, new folder, the terminal and the two copy paths have no key until one is set in Settings › atalhos. A renamed or moved file keeps its open tabs and their unsaved edits. The +'s `arquivo` opens an untitled file; ⌘S asks where to save it, inside the activity's folder.

Right-click a task → turn **start on its own** off (the task's `auto`): the Hive never starts it on its own, never deletes its activity (unless `deleteActivity.nonAutoTasks`) and never sends it a stage prompt (a worker already running finishes its stage). Its `open session` button starts it in one step: a single popup asks, while the task has no worktree yet, for the base to create it from (the same choice as a start, without the stacked-PR toggle, and the workspace when no rule places the task), then for the type, `claude` or `shell`, and for Claude the session, new or an earlier session of the task to resume (a session already open is not offered; a `continue` stage preselects the newest). The worktree, when missing, is created right before the session opens. Each Claude session is a free session: it takes no worker, passes the signal and the cap like a manual start, and gets its own `terminal` button on the task; a shell takes none. Move a task without auto to another stage with right-click → `move to` once no session is open on it; turning `auto` back on hands it back to the orchestrator.

Tasks are ordered inside the Hive: drag one onto another task of its stage (or below the last one) to reorder. The order survives polls and restarts and decides who takes a free worker among tasks of the same stage; the source is never written. When the source's own order differs, the stage header shows `ordem da source` / `source order`, which adopts the source's order for that stage only.

The `green` / `yellow` / `red` toggle in the flow sidebar sets the manual signal (also `POST /signal {"signal":"red"}`); usage rules can only make it stricter. What each signal lets the Hive do on its own (start new tasks, resume and continue started ones, run workerless stages) is the `signals` table in Settings › rules; green is fixed. No signal stops a running worker: it finishes its stage, and the signal decides the next step. The Hive opens on `signals.onOpen` (`yellow`, `last` or `green`); a saved red always opens red.

## The Comb and its sources

```json
"comb": { "prefix": "HIVE", "workspaces": [{ "name": "app", "path": "/path/to/repo", "format": { "onSave": true, "formatters": {}, "custom": [] } }], "sources": [ … ], "stages": [ … ] }
```

The Comb is the Hive's set of sources, workspaces and flow. `prefix` names the tasks created in the Hive (see below).

### Several workspaces

`workspaces` holds one or more `{ name, path, format }` entries, names and paths unique. `format` is required: `{ "onSave": true, "formatters": {}, "custom": [] }` formats on save with whatever supported formatter is installed; `"onSave": false` turns it off. Each task runs in one of them, decided by the first rule that answers:

1. the workspace chosen by hand (right-click › Workspace, or the start popup);
2. the workspace of the first matching rule that sets one, on the task's source;
3. the source's default workspace;
4. the Comb's only workspace.

A task nothing places waits with **no workspace** until you pick one; with one workspace every task has it.

The workspace is fixed once the task's worktree exists (`<workspace>/.hive/worktrees/<slug>`): to move it, remove the worktree first.

The worker cap is shared by every workspace.

Each source's `taskProps` is required: `{ "defaults": { "workspace": "app", "auto": true }, "rules": [{ "field": "labels", "op": "icontains", "value": "manual", "set": { "auto": false } }] }`. It says what each task of the source gets when it first enters the Hive. `defaults.auto` is required and `defaults.workspace` optional. A rule has a condition and a `set` with one or more of `workspace` and `auto`: for each property, the first matching rule that sets it wins, else the default. A property no rule sets is fixed. With no default workspace at least one rule must set one, and a task no rule places waits with no workspace. Auto is applied once, at birth: a later poll or a move on the source never changes a task's auto switch. `field` is `title`, `labels` (GitHub: any of the issue's labels), or the name of a GitHub Project field (single-select or text). `op` is `equals`, `iequals`, `contains` or `icontains`: both sides are trimmed, and the `i` forms ignore case. A source has 0 to 50 rules, a field up to 100 characters and a value 1 to 200.

Settings › fluxo › sources, on a source's detail page (`editar →` from the sources list), sets its task properties: the defaults and the rules. Settings › manutenção lists each workspace's worktrees under its name.

`sources` lists the sources, possibly none. Each entry has a `name` (letters, digits, `.`, `_`, `-`; not `local`; unique), `qualifyId` and an optional `prefix`, then its type's fields. A task's id on screen is the source's own (`12`) unless `qualifyId` is `true`: then it is `<prefix or name>-12`, which keeps two sources with the same ids apart.

Each stage's `from`, `onStart` and `onFinish` are maps keyed by source name: `"from": { "work": ["Todo"], "notes": ["todo"] }`, `"onStart": { "work": [{ "type": "move", "column": "In progress" }] }`. A task enters through its own source's `from` and is written only to its own source; a source with no entry in a stage's `onStart` / `onFinish` is not written there.

Every source needs at least one stage with a `from` for it.

Each source is polled on its own: a source in quota backoff or failing does not stop the others; the header shows one meter per source, and a failing source's error beside its name.

Removing a source in Settings marks its tasks missing at the next poll.

Two unqualified sources feeding one workspace with the same id and title cannot share a worktree: the second task shows `slug <slug> is used by <id>` until you start it by hand.

With no sources, nothing is polled from or written to a source, no `auth` is needed, and every task enters by hand, through the `+` on a stage header or `POST /tasks`.

### GitHub Projects v2

```json
"comb": { "prefix": "HIVE", "workspaces": [{ "name": "app", "path": "/path/to/repo", "format": { "onSave": true, "formatters": {}, "custom": [] } }],
  "sources": [{ "name": "work", "qualifyId": false, "type": "github", "owner": "@me", "number": 6, "filter": [{ "field": "assignee", "op": "any", "values": ["@me"] }, { "field": "label", "op": "none", "values": ["blocked"] }], "taskProps": { "defaults": { "workspace": "app", "auto": true }, "rules": [] }, "epics": "show", "epicFollows": "aheadThenBehind", "switchAt": "Build" }],
  "stages": [ … ] }
```

The source's columns are the options of the GitHub Project's `Status` field. Hive moves items between them.

`filter` narrows which issues in those columns the Hive takes. It is a list of rules, and a task must pass every one. A rule names a `field`: `assignee`, `label`, `milestone`, `repository` (as `owner/name`), or `projectField` with the GitHub Project's single-select field in `name` (priority, size, any custom field). It also names an `op` and its `values`. `any` takes a task carrying at least one of the values, and `none` a task carrying none of them. A task with no value for the field fails `any` and passes `none`, and `[]` takes every task. A `blocked` rule takes no `values`: `{ "field": "blocked", "op": "none" }` keeps out an issue with an open blocker (an open blocked-by dependency or an open sub-issue), and `any` keeps only those. Matching is case-insensitive. `@me` in an `assignee` rule is the account the Hive polls with: the `gh` login on `cli`, the Hive's own on `api`. A task that stops matching is treated like one that left its source: `missing` if it is running, dropped if it is stopped. `filter` is required on a GitHub source; edit it in Settings, where each rule's values are picked from the source's own or typed.

`epics`, `epicFollows` and `switchAt` are required on a GitHub source. `epics` says what an issue with sub-issues is: `ignore` makes it a regular task, `show` lists it with its children (its open sub-issues block it), and `hide` keeps it out, so only its sub-issues come in. `epicFollows` (`behind`, `ahead` or `aheadThenBehind`) and `switchAt`, a stage name of `comb.stages`, say which child the epic's stage follows. A `switchAt` that names no stage is refused, and so is a top-level `epics`: the key lives in each source.

The Hive reaches a GitHub source through `auth.github`:

```json
"auth": { "github": "api" }
```

`"cli"` runs every call through `gh api graphql`, so `gh` must be installed and logged in with the `project` scope. `"api"` calls `api.github.com` with a token of the Hive's own: `hive login` (or `connect GitHub` on the setup screen) opens GitHub's device page, you type the code it shows, and the token goes to `${XDG_CONFIG_HOME:-~/.config}/agent-hive/credentials.json` (directory `0700`, file `0600`) — per user, so one login serves every repo you run the Hive on. The scopes are `project` (read and write the GitHub Project's Status field) and `repo` (read issue bodies and relations in private repositories). Running the login again replaces the token; there is no logout.

`auth` is required when any source is GitHub; two GitHub sources share it, and has no default: a `hive.config.json` with a GitHub source but without `auth` fails to parse with `"auth.github" is required and must be one of: cli, api`. The file lives in the home, not in any repo: add the key there by hand. Without a GitHub source, `auth` is never required, and a saved one is left untouched.

The PR page (a repository's `PRs` tab, a task's PR link in its details, `mostrar PR`, or an issue page's `abrir PR ›`) reads and writes the PR through `gh`, the login the workers open their PRs with, whatever `auth.github` says. Comments, replies, resolves, reviews (a comment, an approval or a change request), edits of the title and description, general comments and the merge need `gh` logged in with the `repo` scope (its default login has it); the Hive checks no scope, and GitHub's refusal shows on the page as it came. A merge from the page on a task awaiting approval approves it and the task enters its next stage; a merge done on GitHub does not.

## Stages

`comb.stages[]` is the flow — one entry per stage, array order = flow order:

```json
"stages": [
  { "name": "spec", "visible": 5, "from": { "work": ["Backlog"] }, "onFinish": { "work": [{ "type": "move", "column": "Ready" }] },
    "prompt": "/hive:new-spec {url}", "session": "new", "model": "opus" },
  { "name": "dev", "from": { "work": ["Ready"] }, "onStart": { "work": [{ "type": "move", "column": "In progress" }] },
    "onFinish": { "work": [{ "type": "move", "column": "In review" }, { "type": "close" }] },
    "prompt": "/hive:new-build {url}", "session": "continue" },
  { "name": "review", "from": { "work": ["In review"] } },
  { "name": "done", "from": { "work": ["Done"] }, "action": "deleteActivity", "after": "5d" }
]
```

Each stage has a `prompt` (placeholders: `{id}`, `{title}`, `{body}`, `{url}`, `{number}` = `{id}`), a `session` policy (`new` starts a fresh session, `continue` resumes the task's own), a `model`, a `visible` cap (how many tasks the stage shows before its `mais` button pages in the next ones; absent = 10, `0` = all; running tasks always show and count against it) and, per source, the source columns it enters `from` and the actions its source takes on `onStart` and `onFinish`. Each source's list runs in order: the actions its source's type supports, on GitHub `move` (to a source column), `remove`, `close`, `archive` and `delete`; one of each, and `archive` / `remove` / `delete` only at the end of an `onFinish`. A file written with a single action per source is read as one-element lists, and the next save writes lists. The task advances when the command ends (`Stop`), not by hand. When several stages have stopped tasks, the later stage in the array wins a free worker; ties by the Hive's order. A stage without a `prompt` only shows the task — nothing runs there. A prompt stage may pin an `agent` (optional; absent = `defaultAgent`), and its `model` is passed to that agent as written.

Instead of a `prompt`, a stage can carry an `action`: `"action": "deleteActivity"` deletes the activity of each task that enters it: its terminals are closed, then its worktree (`.hive/worktrees/<slug>`) and its local branch are removed, both without force; Settings › execution's **delete activity** switches add the task's agent sessions (the next run starts a new one) and their transcripts in the agent's own directory. The ⋯ menu's **delete activity** does the same. A task without auto is left to that item unless **tasks without auto too** (`nonAutoTasks`) is on; then such a stage deletes its activity like any other task's, ones already sitting in it included, unless a session run is open in it, and the fill still never starts it. A task with nothing to delete just moves on — a dirty worktree or an unmerged branch leaves git's message on the task and `start` retries — and then the stage advances the task like a finished prompt (`onFinish`, next stage or out). The remote branch is not touched. Any stage with a prompt or an action can wait with `after` (`"30m"`, `"12h"`, `"5d"`), counted from the moment the task entered the stage; `start` ignores it.

### Tasks created in the Hive

The `+` beside a stage's kebab opens a dialog for a title and a description; the task enters that stage right away, named `<prefix>-<n>` (`HIVE-1`, `HIVE-2`, …), whose number is never reused even once the task is removed. A local task moves through the flow like any task — it runs the stage's `prompt`, advances on `Stop` — but it is never written to a source: `onStart` / `onFinish` are for source columns, and a Comb without a source allows none of them. `{url}` renders empty for a local task, so a stage meant to serve them should build its prompt from `{body}` instead. Once stopped, a local task shows **remove** instead of the missing-task buttons: a single confirm; its worktree stays on disk (**delete activity** removes it first, if you want it gone).

The same route any local process can call, guarded by the dashboard's CSRF header:

```sh
curl -s -X POST http://127.0.0.1:$(cat ~/.config/agent-hive/hive.port)/tasks -H 'content-type: application/json' -H 'x-hive-ui: 1' \
  -d '{"title":"Write the README","body":"…","stage":"dev"}'
```

`title` must be non-empty and at most 200 characters (after trimming); `body` is optional text up to 64 KB; `stage` must name an existing stage; `workspace`, optional, must name a Comb workspace. A refusal answers `400 {"error": "…"}`; success answers `201 {"id":"HIVE-3"}`.

## Config (`hive.config.json`)

| field | default | where to edit |
|---|---|---|
| `comb` | — (required) | form (`prefix` defaults to `HIVE`; `workspaces` is Settings › workspaces' list; `sources` is Settings › fluxo › sources' list, each row's detail page with its name, qualify-the-id switch and prefix, its type's fields and its `taskProps`; `stages` is the flow; `commands` is Settings › workspaces' commands section, each with its `workspaces` and an optional `timeout`) |
| `auth` | — (required when any source is GitHub) | form (`cli` = `gh`, `api` = the Hive's own login) |
| `signals` | — (required; the form starts with today's table) | form, `regras` section: `yellow` and `red`, each `{ "newTasks", "started": "resumeAndContinue" \| "continueOnly" \| "stay", "workerless" }`, red never looser than yellow; `onOpen`: `yellow` \| `last` \| `green`. The worker cap is not in the file: the flow sidebar edits it and the state keeps it |
| `agentArgs` | `{ "claude": [] }` | Settings › Execution, one list per agent (e.g. `{ "claude": ["--permission-mode", "acceptEdits"] }`) |
| `logLevel` | `info` | file (`info` or `debug`; re-read on every save of the setup form, no restart needed) |
| `baseBranch` | the remote's default (`origin/HEAD`, else `main`) | form, `geral` tab (empty = automatic) |
| `onClose` | — (required; the form starts on `menuBar`) | form, `app` section: `menuBar` keeps the Hive in the menu bar when the window closes, `quit` stops it and its workers |
| `deleteActivity` | — (required; the form starts with every switch off) | form, execution section (`session`, `transcripts`, `nonAutoTasks`; `transcripts` needs `session`; the worktree, its branch and its terminals always go; `nonAutoTasks` lets delete-activity stages take tasks without auto too; a file still carrying `cleanup` is refused: rename the key by hand and drop its `worktree` and `branch`) |
| `shutdownIdleMinutes` | — (required; the form starts with `10`) | form, `geral` tab (whole minutes, 1 to 1440: how long a worker may wait for you while shut down when done is armed) |
| `defaultAgent` | — (required; the form starts on `claude`; a file without it is read as `claude`) | form, `execução` section, **agente padrão** (`claude`, the only agent today; one whose command is not on PATH is disabled, and a stage that runs it is refused on the task with the reason) |
| `language` | system (`pt` when the OS locale starts with `pt`, else `en`) | form (`pt` or `en`; the dashboard and the setup form switch on save, no reload) |
| `theme` | — (required; the form starts on `system`) | form, `geral` tab (`system` follows the macOS appearance live, `light` or `dark` force one; the dashboard switches on save, an open terminal window the next time it opens) |
| `terminalFont` | — (required; the form starts empty) | form, `geral` tab (one font family name, e.g. `MesloLGS NF`; empty = the system monospace, which also backs a misspelled or missing name; a Nerd Font shows the icons of prompt themes like oh-my-zsh's; the panel's terminals switch on save, an open terminal window the next time it opens) |
| `trustedDomains` | — (required; the form starts empty) | form, `app` section (one chip per host, e.g. `github.com`: no scheme, port, path or `*`; a host covers its subdomains). A terminal link to a listed host opens in the browser without asking; any other `http(s)` link asks in the Hive's own dialog, whose "always trust" adds its host here through `POST /trusted-domains {"host": "…"}`; other schemes never open. The panel follows a save at once, an open terminal window the next time it opens |
| `consoleLines` | — (required; the form starts with `5000`) | form, `app` section (whole lines, 100 to 100000: how many lines each console channel keeps, over all its runs, the oldest going first; a save applies to the next output) |
| `shortcuts` | — (required; `{}` = every default) | form, `atalhos` tab. Only your changes, by shortcut id, over the defaults of the platform the Hive runs on (macOS has its own table; Linux and Windows share one where every key a terminal program reads moves to Ctrl+Shift). An Electron accelerator like `CmdOrCtrl+Shift+T` rebinds one, `null` turns it off. Ids, by where the key acts: global `viewFlow`, `viewActivities`, `search`, `searchOperations`, `newActivity`, `runCommand`, `toggleConsole`, `toggleLeft`, `toggleRight`, `shortcutMap`, `fullScreen`, `closeWindow`; activities `newTerminal`, `newSession`, `openDiff`, `close`, `splitSame`, `clear`, `toggleSideTab`, `sleepSession`, `sleepAll`; flow `searchTasks`, `refreshFlow`, `goBack`, `zoomOut`, `zoomIn`, `zoomReset`; dialogs `confirm`, `feedbackQueue`, `switchStartMode`. `nextTab`, `prevTab`, `splitTerminalVertical`, `splitTerminalHorizontal`, `nextPane`, `prevPane`, `nextActivity` and `prevActivity` are listed as soon: their keys are reserved and they cannot be named yet. Two keys collide when both act in one scope or one of them is global; a collision, a key the Edit and app menus keep (copy, paste, undo, quit…) or a fixed key is refused, and Escape is no binding at all. Off macOS `Ctrl` and `CmdOrCtrl` are one key, and the terminal copies, pastes and selects all with `Ctrl+Shift+C` / `Ctrl+Shift+V` / `Ctrl+Shift+A` (and `Ctrl+Insert` / `Shift+Insert`), fixed keys no shortcut may take, while `Ctrl+C`, `Ctrl+V`, `Ctrl+X`, `Ctrl+Z` and `Ctrl+A` stay the program's. The dashboard follows a save at once, an open terminal window the next time it opens |

A `hive.config.json` from before #571 names `comb.projects`, `comb.boards` and each source's `project`: it fails to parse naming `comb.workspaces` or `comb.sources`. Rename the keys by hand in the home's file: `comb.projects` → `comb.workspaces`, `comb.boards` → `comb.sources`, and in each source `"project": { "mode": "fixed", "project": … }` → `"workspace": { "mode": "fixed", "workspace": … }` (a dynamic one's rules: `"project"` → `"workspace"`).

A `hive.config.json` from before #688 carries each source's `workspace` setting (`fixed` or `dynamic`): it fails to parse naming `taskProps`, and the Hive opens the settings form with the error. Set each source's task properties there.

The Hive's keyboard shortcuts, listed with their current keys in Settings › `atalhos` by where they act, each rebindable, off-able or resettable there. `⌘/` (`Ctrl+/` off macOS) shows the keys that work now in a read-only map, grouped the same way, whose link opens that tab; the search lists it too. Click a key to record a new one; `Esc` cancels the recording. The defaults:

| Operation | macOS | Linux / Windows |
|---|---|---|
| go to the activities / flow | `⌘1` / `⌘2` | `Ctrl+1` / `Ctrl+2` |
| search / search operations | `⌘P` / `⌘⇧P` | `Ctrl+Shift+P` / `F1` |
| new activity / run a command | `⌘N` / `⌘R` | `Ctrl+Shift+N` / `Ctrl+Shift+R` |
| console / left side / right side | `⌘J` / `⌘B` / `⌘⇧B` | `Ctrl+Shift+J` / `Ctrl+Shift+B` / `Ctrl+Alt+Shift+B` |
| the shortcut map / full screen / close the window | `⌘/` / `⌘⇧F` / `⌘⇧W` | `Ctrl+/` / `F11` / `Ctrl+Alt+Shift+W` |
| new terminal / new session / diff | `⌘T` / `⌘⇧N` / `⌘⌥C` | `Ctrl+Shift+T` / `Ctrl+Alt+Shift+N` / `Ctrl+Shift+G` |
| close the tab / split / clear the terminal | `⌘W` / `⌘\` / `⌘K` | `Ctrl+Shift+W` / `Ctrl+Shift+\` / `Ctrl+Shift+K` |
| files and details / sleep the session / sleep all | `⌘⇧E` / `⌘.` / `⌘⇧.` | `Ctrl+Alt+Shift+E` / `Ctrl+Shift+.` / `Ctrl+Alt+Shift+.` |
| search the flow / refresh it | `⌘F` / `⌘⌥R` | `Ctrl+F` / `F5` |
| confirm a dialog / send feedback in order / switch the start mode | `⌘↵` / `⌘⇧↵` / `⌘⇧M` | `Ctrl+Enter` / `Ctrl+Shift+Enter` / `Ctrl+Shift+M` |

Fixed keys, listed read only: `⌘,` opens Settings, `⌘Q` quits, `⌘⌥1–3` (`Ctrl+Shift+1–3`) sets the signal green, yellow or red, `Shift+Enter` inserts a newline in the agent's prompt, and `Escape` closes the details or a dialog. With a task focused on the flow, the arrows move between tasks, `Enter` opens its details, `F` opens them on the feedback box while the task awaits approval, and `I`, `L`, `A`, `O`, `S` and `M` run stages, open a free session, approve, open the activity, turn auto on or off and open its menu (`Shift+F10` too off macOS); `⌥0–9` (`Alt+0–9`) filters by source.

`branch` (optional) is the name of the branch each task's worktree gets, as a template: `{id}`, `{title}` (the same kebab title the slug carries, capped at 30) and `{slug}` are replaced per task. The default is `hive/{id}-{title}`; the field lives in Settings › execução and an empty field means the default. It must contain `{id}` or `{slug}` — without one, two tasks would render the same branch and the second `git worktree add` would fail.

At a task's first spawn the Hive creates the worktree from the latest merged code: it runs `git fetch origin <base>` and branches `.hive/worktrees/<slug>` off `origin/<base>`. When your checkout happens to be on the base branch and clean it is fast-forwarded too (the `git pull` you would run by hand), but that is a courtesy — the worker's start point is `origin/<base>` either way, and on any other branch, detached or dirty your checkout is not touched. A task that already has its worktree is left alone: work in progress is never refreshed under the worker. The base step cannot fail a start — offline, without `origin`, or with a branch the remote does not have, the worktree is created from the local base and `hive.log` says why on one `base: …` line. What does fail a start is the creation itself: a worktree already staged at that path on another branch, or a `git worktree add` git refuses, leaves git's own words on the task until you start it again.

A `hive.config.json` from before the Comb (no `comb`, or a top-level `board` / `columns`) is not accepted: the Hive opens the setup form empty with the reason instead of dying, and saving re-enters the settings once. Runtime state lives in the home (`~/.config/agent-hive/`), including `hive.log`: one line per thing the Hive did (`tail -f ~/.config/agent-hive/hive.log`), rotated once at 5 MB into `hive.log.1`; `logLevel: "debug"` adds every hook event and every GraphQL call (its variables, its query and the duration — never the response, and never the token).

The daemon has no fixed port (#466). It tries the one it bound last, so the dashboard keeps its origin and the layout saved in the browser. When another program holds that port, the OS picks a free one. The daemon records the port in `<home>/hive.port`, where `hive`, `hive stop` and the viewer look for it. `<home>/hive.lock` holds its pid, so a second daemon never starts on the same home.

Every boot also writes a new random secret to `<home>/hive.secret` (mode `0600`, removed on a clean stop), and the daemon refuses any request that does not carry it (#467): the API, the hooks, the MCP route, the dashboard page and the terminal sockets alike, with `403 {"error": "segredo inválido"}`. `hive`, `hive stop` and the menu bar send it as the `x-hive-secret` header; the workers get `HIVE_SECRET_FILE` in their environment, the path of `hive.secret`, whose one line is the header itself: their hooks and exit trailer send it with curl's `-H @"$HIVE_SECRET_FILE"`, so the value never reaches an argv; claude's MCP client sends it as a header from the worker's own `0600` MCP config. The viewer sets it as an `HttpOnly` cookie before the page loads. A cookie ignores the port, so its name carries it (`hive_secret_<port>`), and before setting one the viewer closes every window still open on another port and removes the other ports' cookies: a daemon that moved never has its secret sent to the port it left.

`HIVE_HOME` moves the whole home elsewhere, in place of `${XDG_CONFIG_HOME:-~/.config}/agent-hive` (an empty or relative value is invalid and counts as unset, like `XDG_CONFIG_HOME`): a test Hive runs beside the installed one with `HIVE_HOME=$PWD/.hive/test-home pnpm run:headless` (or `pnpm start`, which also gives the test window its own `userData`); each home's daemon binds a free port of its own. `.hive/` is already excluded from git. The two must not work the same task in the same repo at once — they share the `.hive/worktrees/<slug>` name, derived from the task's slug.

`pnpm run:test-hive` does that for you with a ready-made home (HIVE-6). It stops a test Hive still running in `<worktree>/.hive/test-home`, copies the committed fixture there (`test/fixtures/test-home/`: the five stages of a real Hive, about 15 local `TEST-n` tasks over them, the worktree as the workspace), deletes `hive.log`, and opens the window. A login (`credentials.json`) and the window's `userData` (`electron/`) are kept. The test Hive binds a free port of its own (its home's `hive.port`) and starts with no free worker (`maxConcurrent: 0`): raise it in Settings to let workers run, until the next `run:test-hive`. Its GitHub source is a sandbox Project that `HIVE_TEST_BOARD_OWNER=<user or org> pnpm seed:test-board` creates once, idempotently: the private repo `<owner>/hive-test-board`, the Project `Hive test board` with the `Status` options `Backlog`, `Ready`, `In progress`, `In review` and `Done`, and three fake issues in each. `gh` must be logged in with the `project` scope. The seed prints the Project number. Then run the Hive with both variables: `HIVE_TEST_BOARD_OWNER=<owner> HIVE_TEST_BOARD_NUMBER=<n> pnpm run:test-hive`.

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

Architecture: `src/orchestrator.ts` is a pure reducer (state + event → new state + effects); `src/server.ts` receives the hooks, runs the reducer and executes the effects; `src/sources/*` are the adapters; `src/ui/` is a Vite + React + shadcn/ui client of the same API (`src/ui/lib/*`, `i18n.ts` and `highlight.ts` are framework-free and tested with `node:test`; components with logic have Vitest + Testing Library tests under `test/ui/`). Specs and plans live in `docs/superpowers/`, next steps in the GitHub issues.

## Known limitations

- The panel shows an excerpt of the transcript; the session is the terminal (`terminal` on the task). A Hive restart does not readopt live sessions: it kills them; each task stays in its stage and runs again when a worker is free.
- The Hive cannot focus an open session terminal again; close it and open it again.
- A reopened session runs with the same `agentArgs` as the workers (permission mode included) and without the Hive's hooks: what it does is not counted against the budget or the usage rules, and a PR it opens is not detected. Closing the terminal tab without leaving `claude` skips the exit trailer; the next poll notices the process is gone and frees the task.
- The daemon listens on `127.0.0.1`, rejects other `Host` values, and refuses every request without the per-boot secret of `<home>/hive.secret` (#467). A process running as your own user can read that file, the workers' environment and the daemon's memory: the secret keeps other accounts and other programs out, not your own.
- Switching sources with live workers keeps those workers bound to the old ids until they exit.

## License

The Hive is licensed under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2). You may use, copy, modify and redistribute it, keeping the license and copyright notices, for any purpose other than a Competing Use: making it available to others in a commercial product or service that substitutes for the Hive or for another product or service the licensor already offers using it, or that offers the same or substantially similar functionality. Each version becomes available under the Apache License 2.0 two years after its release.

Files ported from other projects keep their own licences; `assets/plugin/CREDITS.md` lists them.

Contributions are accepted under the [Contributor License Agreement](CLA.md), signed once on your first pull request.
