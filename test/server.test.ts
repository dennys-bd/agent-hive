import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createSources } from '../src/source.js';
import { parseConfig } from '../src/config.js';
import { renderMcpConfig } from '../src/agents/claude-home.js';
import { PROTOCOL_DIR } from '../src/hooks-settings.js';
import { type Logger, shortId } from '../src/log.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { pluginRenderPath } from '../src/plugin-render.js';
import { PLAN_LIMITS_INTERVAL_MS } from '../src/rate-limits.js';
import { keepAwakeCommand, shutdownCommand } from '../src/platform-commands.js';
import { HOUR_MS } from '../src/usage.js';
import { transcriptDir } from '../src/agents/claude-transcript.js';
import { prStatesQuery } from '../src/pull-requests.js';
import { createServer, type HiveServer, killStrays, type ServerDeps } from '../src/server.js';
import { activityOf, prsOf, recordWithSession, resultOf, taskOfWorker } from '../src/activities.js';
import { activityIdOf, readyOn, withWork, workId, workPath } from './fixtures/work.js';
import { sessionsOf, slugFor } from '../src/tasks.js';
import { blockedMessage, deleteActivityOnDisk, openTask } from '../src/server-tasks.js';
import { saveState } from '../src/state-store.js';
import { createConsoleStore } from '../src/console.js';
import { createPtyHost, NO_PTY } from '../src/pty-host.js';
import { CONTINUE_PROMPT } from '../src/server-spawn.js';
import { STAGE_PROTOCOL } from '../src/protocol.js';
import { renderPrompt } from '../src/spawn.js';
import { mergeBasePrompt } from '../src/merge-prompt.js';
import { worktreePath } from '../src/worktree.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Activity, Source, SourceQuota, SourceSpec, Task, TaskPr, Session, Effect, Exec, OpenResult, RateLimits, SettingsBody, SettingsResult, Worker, State, TaskComment, WorktreeRow } from '../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, MAX_CONCURRENT_MAX, SHUTDOWN_IDLE_DEFAULT, SPAWN_FAILED, DISCARD_FAILED } from '../src/types.js';
import { AUTH, STAGES, combConfig, type FakeSpawnOptions, GITHUB_ENTRY, onOwnStages, OPTIONS, fakeSourceFactory, fakeLog, WORKSPACE, type FakePty, fakePtys, fakeSpawn, fakeKeepAwakeSpawn, type FakeWorker, getFreePort, launchFlag, move, plainArgs, workspacesAt, tempHive, chained, claudePlan, claudePlanFailure } from './fakes.js';
import { tempDir } from './temp-dir.js';
import { SECRET_HEADER } from '../src/secret.js';
import { hiveFetch, SECRET } from './secret-client.js';

// the workspace is per server: start() names its own repo (#202)
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE',
  auth: AUTH,
  sources: [GITHUB_ENTRY],
  stages: STAGES,
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [],
};

interface Started { home: string; repo: string; base: string; port: number; server: HiveServer; workers: FakeWorker[] }

const postJson = (url: string, body?: unknown): Promise<Response> =>
  hiveFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify(body ?? {}) });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;
// What POST /tasks/:id/open and POST /activities/:id/sessions/:id/open answer once the run they started exists (#249): ok and the ptyId
// pool.started confirmed, so the page can attach it with no extra click.
const opened = async (res: Response | Promise<Response>): Promise<void> => {
  const body = await json<OpenResult>(res);
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'ptyId']);
  assert.equal(typeof body.ptyId, 'string');
};
const worker0 = (server: HiveServer): Worker => server.getState()!.workers[0];
const task0 = (server: HiveServer): Task => server.getState()!.tasks[0];
// Its live activity (#629): the worktree, the branch, the base, the setup and the mark
const work0 = (server: HiveServer): Activity | undefined => activityOf(server.getState()!, task0(server).item.itemId);
// Any task's live activity (#629): where its run fields are
const runOf = (server: HiveServer, task: Task): Activity | undefined => activityOf(server.getState()!, task.item.itemId);
// What the first task's records hold (#629): its sessions, its PRs, its result
const sessions0 = (server: HiveServer): Session[] => sessionsOf(server.getState()!, task0(server).item.itemId);
const prs0 = (server: HiveServer): TaskPr[] => prsOf(server.getState()!, task0(server).item.itemId);
// A source listing entry: what the fake source would return for task `id` sitting in `column`.
const item = (id: string, column: string) => ({ item: { itemId: `board:I${id}`, source: 'board', id, title: `Task ${id}`, body: '', url: `https://github.com/acme/r/issues/${id}` }, column });
const order = (server: HiveServer): string[] => server.getState()!.tasks.map((c) => c.item.id);
const QUOTA: SourceQuota = { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };
const PLAN: RateLimits = {
  at: '2026-09-17T12:00:00.000Z',
  windows: { five_hour: { usedPercent: 23.4, resetsAt: '2026-09-17T15:00:00.000Z' }, seven_day_opus: { usedPercent: 7.5, resetsAt: '2026-09-21T00:00:00.000Z' } },
};
const NO_TOKEN = 'no Claude Code OAuth token (env, .credentials.json or macOS Keychain)';

// The state's cap is not in the body (#727): a start() gets one worker, so the fake source's single task is spawned into the fake worker,
// unless its body went through idle().
const NO_WORKER = new WeakSet<object>();
const idle = (body: Omit<SettingsBody, 'workspaces'> = BODY): Omit<SettingsBody, 'workspaces'> => {
  const marked = { ...body };
  NO_WORKER.add(marked);
  return marked;
};
async function start(t: TestContext, body: Omit<SettingsBody, 'workspaces'> = BODY, log?: Logger, spawnOptions: FakeSpawnOptions = {}, extra: Partial<ServerDeps> = {}): Promise<Started> {
  const { home, repo } = await tempHive(t, NO_WORKER.has(body) ? 0 : 1);
  const { spawn, workers } = fakeSpawn(spawnOptions);
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, log, exec: noGit, ...extra });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { workspaces: workspacesAt(repo), ...onOwnStages(body) })).status, 200); // configure validates and writes; the first poll runs in the background (#59)
  await server.poll(); // wait for the tasks to land before the tests below rely on them
  await server.dispatch({ type: 'setSignal', signal: 'green' }); // these tests exercise worker behavior, not the boot signal itself
  return { home, repo, base, port, server, workers };
}

// The fake's onExit dispatches without awaiting, like a real process event: poll the state until it settles.
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await sleep(5);
  assert.ok(check(), 'condition not met in time');
}

// An internal run's pty (#251): the fake spawner gets the server's pty host in its options and starts the worker in it, the way
// launchInternalPty does.
async function withPty(t: TestContext): Promise<Started & { pty: FakePty; ptyId: string }> {
  const { spawnPty, ptys } = fakePtys();
  const started = await start(t, BODY, undefined, {}, { spawnPty });
  const ptyId = worker0(started.server).runId!;
  const host = started.workers[0].options?.ptys;
  assert.ok(host, 'the server hands its pty host to every spawn');
  host.spawn(ptyId, ['/bin/sh', '-c', 'claude'], started.repo, {});
  return { ...started, pty: ptys[0], ptyId };
}

const openPr = (server: HiveServer, ptyId: string): Promise<Effect[]> =>
  server.dispatch({
    type: 'hook', ptyId,
    payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: 'https://github.com/acme/r/pull/9' },
  });

// What the worker's hook command posts: the JSON payload on the body, the worker id on the header.
const hookEvent = (base: string, ptyId: string, payload: unknown): Promise<Response> =>
  hiveFetch(`${base}/hooks/event`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-pty': ptyId }, body: JSON.stringify(payload) });

// What hive_done dispatches (src/mcp.ts); the route itself is covered by test/mcp.test.ts.
const markDone = (server: HiveServer, ptyId: string): Promise<Effect[]> => server.dispatch({ type: 'done', ptyId });

// A stopped task that ran once: session id from the spawn, worktree from a SessionStart at `cwd` (the repo by default), worker freed by
// an exit under red so nothing respawns (in flight since its spawn, under yellow it would resume at once, #224). The state is left red.
async function ranOnce(t: TestContext, extra: Partial<ServerDeps> = {}, cwd?: string): Promise<Started> {
  const started = await start(t, BODY, undefined, {}, extra);
  const { base, server, workers } = started;
  await hookEvent(base, worker0(server).runId!, { hook_event_name: 'SessionStart', cwd: cwd ?? started.repo });
  await server.dispatch({ type: 'setSignal', signal: 'red' });
  workers[0].handlers.onExit();
  await waitFor(() => worker0(server).status === 'empty');
  return started;
}

// Every spawn goes through ensureWorktree: the tests' repo is a bare temp dir with no git in it, so the default exec answers
// every git call with an empty stdout. A test that cares about the calls injects its own (fakeGit, or an exec of its own).
const noGit: Exec = async () => ({ stdout: '' });

// Records every git call the server makes through deps.exec; the call whose args include `failing` rejects. `clear()` drops
// what the spawn's own worktree step (the base it refreshed, the add) already recorded, so a later assertion sees only the
// commands it is about.
function fakeGit(failing?: string): { exec: Exec; calls: string[][]; clear(): void } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (failing && args.includes(failing)) throw new Error(`${failing} boom`);
    return { stdout: '' };
  };
  return { exec, calls, clear: () => { calls.length = 0; } };
}

// The git the popup tests need (#131): `worktree list` answers `answers.listing`, the one merged for-each-ref (#408) answers
// `answers.heads`/`answers.remotes` as full refnames (a remote entry is already `origin/<x>`), the remote's HEAD is origin/main, and
// rev-parse --verify succeeds only for a ref in `answers.refs`. `answers` is read at call time, so a test sets the listing once
// start() has made the repo. Every argv after `-C <repo>` is recorded.
function refsGit(answers: { listing?: string; heads?: string[]; remotes?: string[]; refs?: string[] } = {}): { exec: Exec; calls: string[][]; answers: typeof answers } {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    const command = args.slice(2);
    calls.push(command);
    if (command[0] === 'worktree' && command[1] === 'list') return { stdout: answers.listing ?? '' };
    if (command[0] === 'for-each-ref') {
      const lines = [...(answers.heads ?? []).map((name) => `refs/heads/${name}`), ...(answers.remotes ?? []).map((name) => `refs/remotes/${name}`)];
      return { stdout: `${lines.join('\n')}\n` };
    }
    if (command[0] === 'symbolic-ref' && command[1] === '--short') return { stdout: 'origin/main\n' };
    if (command[0] === 'rev-parse' && command[1] === '--verify' && !(answers.refs ?? []).includes(command.at(-1) as string)) {
      // git's own statuses: --quiet makes a missing ref exit 1 with no words (#267's set-aside reads only that as free)
      throw Object.assign(new Error('Command failed: git rev-parse'), command.includes('--quiet') ? { code: 1, stderr: '' } : { code: 128, stderr: 'fatal: Needed a single revision\n' });
    }
    return { stdout: command[0] === 'rev-parse' ? 'b2c3d4e\n' : '' };
  };
  return { exec, calls, answers };
}

const TASK_SLUG = 'hive-1-from-ready'; // the fake source's task
const TASK_BRANCH = 'hive/1-from-ready'; // what the default template renders for it
const ORPHAN_SLUG = 'hive-9-gone'; // a worktree git lists under .hive/worktrees that no task owns (#181)
const ORPHAN_BRANCH = 'hive/9-gone';

// The delete-activity and orphan routes' git (#182, #181): `worktree list` shows the main checkout, the task's worktree on its rendered branch,
// ORPHAN_SLUG on ORPHAN_BRANCH and a detached worktree outside the Hive (built from the -C repo, so the first spawn sees it too); a
// command whose argv includes `refuse` rejects with exit code 1 (git's refusal status) and `stderr` as git's words when given; `hold()`
// makes every command wait until the returned release runs, so a test can act while git runs. Every argv after `-C <dir>` is recorded.
function listedGit(refuse?: string, stderr?: string): { exec: Exec; calls: string[][]; clear(): void; hold(): () => void } {
  const calls: string[][] = [];
  let gate: Promise<void> | undefined;
  const exec: Exec = async (_file, args) => {
    const command = args.slice(2);
    calls.push(command);
    await gate;
    if (refuse !== undefined && command.includes(refuse)) {
      throw Object.assign(new Error(`Command failed: git ${command.join(' ')}`), { code: 1 }, stderr === undefined ? {} : { stderr });
    }
    const repo = args[1] as string;
    const listing = [
      `worktree ${repo}\nHEAD 1111\nbranch refs/heads/main\n`,
      `worktree ${worktreePath(repo, TASK_SLUG)}\nHEAD 2222\nbranch refs/heads/${TASK_BRANCH}\n`,
      `worktree ${worktreePath(repo, ORPHAN_SLUG)}\nHEAD 3333\nbranch refs/heads/${ORPHAN_BRANCH}\n`,
      'worktree /elsewhere/wt\nHEAD 4444\ndetached\n',
    ].join('\n');
    return { stdout: command[0] === 'worktree' && command[1] === 'list' ? listing : '' };
  };
  const hold = (): (() => void) => {
    let release = (): void => {};
    gate = new Promise((resolve) => { release = resolve; });
    return () => { gate = undefined; release(); };
  };
  return { exec, calls, clear: () => { calls.length = 0; }, hold };
}

// A local task's worktree as git lists it (#542): `worktree list` shows the repo on main and `slug`'s worktree on `branch`; the command whose
// argv includes `refuse` (read at call time) rejects with git's words. Every argv after -C <dir> is recorded.
function localGit(slug: string, branch: string): { exec: Exec; calls: string[][]; refuse?: string } {
  const git: { exec: Exec; calls: string[][]; refuse?: string } = {
    calls: [],
    exec: async (_file, args) => {
      const command = args.slice(2);
      git.calls.push(command);
      if (git.refuse !== undefined && command.includes(git.refuse)) {
        throw Object.assign(new Error(`Command failed: git ${command.join(' ')}`), { stderr: 'fatal: boom\n' });
      }
      const repo = args[1] as string;
      const listing = `worktree ${repo}\nHEAD 1111\nbranch refs/heads/main\n\nworktree ${worktreePath(repo, slug)}\nHEAD 2222\nbranch refs/heads/${branch}\n`;
      return { stdout: command[0] === 'worktree' && command[1] === 'list' ? listing : '' };
    },
  };
  return git;
}

// The git a Restart runs (#283): HEAD is `head`, origin lists `published` for the task's branch (nothing when absent), the commit count is 3,
// and the command named `failing` rejects with git's words. Every argv after -C <dir> is recorded.
function restartGit(head: string, published?: string, failing?: string, gate?: Promise<void>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    let command = args.slice(args.indexOf('-C') + 2); // after git's global options and the directory
    while (command[0] === '-c') command = command.slice(2); // and the -c settings a read runs with (#619)
    calls.push(command);
    if (command[0] === 'reset' && gate) await gate; // holds the Restart's git while a test looks at the task
    if (command[0] === failing) throw Object.assign(new Error(`Command failed: git ${command.join(' ')}`), { stderr: 'fatal: boom\n' });
    if (command[0] === 'rev-parse' && command[1] === '--show-toplevel') return { stdout: `${args[1]}\n` }; // git -C <worktree>: its own checkout
    if (command[0] === 'symbolic-ref') return { stdout: `${TASK_BRANCH}\n` };
    if (command[0] === 'rev-parse' && command[1] === 'HEAD') return { stdout: `${head}\n` };
    if (command[0] === 'ls-remote') return { stdout: published === undefined ? '' : `${published}\trefs/heads/${TASK_BRANCH}\n` };
    if (command[0] === 'rev-list') return { stdout: '3\n' };
    if (command[0] === 'diff' && command.includes('--no-renames')) return { stdout: 'a.txt\0b.txt\0' };
    if (command.join(' ') === 'ls-files -z --others --exclude-standard') return { stdout: 'b.txt\0c.txt\0' }; // b.txt in both: counted once
    return { stdout: '' };
  };
  return { exec, calls };
}
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

test('POST /settings does not override a maxConcurrent changed through POST /config', async (t) => {
  const { base, server } = await start(t);
  assert.equal(server.getState()?.maxConcurrent, 1);
  assert.equal((await postJson(`${base}/config`, { maxConcurrent: 2 })).status, 200);
  assert.equal(server.getState()?.maxConcurrent, 2);
  assert.equal((await postJson(`${base}/settings`, BODY)).status, 200); // the form re-save: the body has no cap (#727)
  assert.equal(server.getState()?.maxConcurrent, 2, 'the form re-save does not revert the header change');
});

test('POST /config answers 400 above MAX_CONCURRENT_MAX and leaves the cap alone (#727)', async (t) => {
  const { base, server } = await start(t);
  const res = await postJson(`${base}/config`, { maxConcurrent: MAX_CONCURRENT_MAX + 1 });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /maxConcurrent/);
  assert.equal(server.getState()?.maxConcurrent, 1);
});

test('POST /settings writes the branch template and keeps it when a later save omits it', async (t) => {
  const { base, home } = await start(t, { ...BODY, branch: 'feat/{id}-{title}' });
  const saved = async (): Promise<{ branch?: string }> => JSON.parse(await readFile(join(home, 'hive.config.json'), 'utf8')) as { branch?: string };
  assert.equal((await saved()).branch, 'feat/{id}-{title}');
  assert.equal((await postJson(`${base}/settings`, BODY)).status, 200); // an API caller that omits it keeps the current template
  assert.equal((await saved()).branch, 'feat/{id}-{title}');
  assert.equal((await postJson(`${base}/settings`, { ...BODY, branch: 'feat/{title}' })).status, 400);
});

test('saving the settings starts one worker with the launch: mode, cwd, port, hooks, the stage protocol and the prompt file with the rendered prompt', async (t) => {
  const { home, repo, port, server, workers } = await start(t);
  const worker = worker0(server);
  assert.equal(worker.status, 'working');
  assert.equal(work0(server)?.slug, 'hive-1-from-ready');
  assert.equal(workers.length, 1);
  const promptPath = join(home, 'prompts', 'hive-1-from-ready.md');
  assert.deepEqual(workers[0].launch, {
    ptyId: worker.runId, slug: 'hive-1-from-ready', cwd: join(repo, '.hive', 'worktrees', 'hive-1-from-ready'), port, promptPath, env: {},
    agent: {
      command: 'claude',
      argv: [
        ['--mcp-config', join(home, 'prompts', `${worker.runId}.mcp.json`)], ['--settings', join(home, 'hooks.json')], ['--plugin-dir', pluginRenderPath(home, WORKSPACE)],
        ['--append-system-prompt-file', join(home, PROTOCOL_DIR, 'workspaces', WORKSPACE, 'stage.md')], // a stage run is told how to end it (#167), its workspace's memory under it (#797)
        '--session-id', work0(server)!.sessionId!, // #629: the activity's
      ],
    },
  });
  assert.deepEqual(JSON.parse(await readFile(launchFlag(workers[0].launch, '--mcp-config')!, 'utf8')), renderMcpConfig(port, worker.runId!, SECRET), 'the tools reach this Hive as this worker');
  assert.equal(await readFile(launchFlag(workers[0].launch, '--append-system-prompt-file') ?? '', 'utf8'), STAGE_PROTOCOL, 'the boot wrote the workspace\'s file: no lesson yet, the protocol alone (#797)');
  assert.equal(workers[0].options?.secretFile, join(home, 'hive.secret'), 'the run\'s env gets the path of hive.secret from the spawner options, never the value (#467)');
  assert.match(plainArgs(workers[0].launch)[1], /^[0-9a-f-]{36}$/);
  const prompt = await readFile(promptPath, 'utf8');
  assert.match(prompt, /^Task #1: from Ready/, 'the command line reads the prompt from this file');
  assert.equal(prompt, renderPrompt(STAGES[0].prompt ?? '', task0(server).item), 'the rendered prompt and nothing after it: the protocol has its own file (#167)');
  assert.ok(!prompt.includes('curl') && !prompt.includes(worker.runId!), 'no curl and no worker id in the prompt: the id travels in the MCP config (#99)');
});

test('a spawn creates the task worktree before the worker exists and launches it there: the runner only ever gets a cwd', async (t) => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes('rev-parse')) throw new Error('not a ref'); // the branch does not exist yet: the add creates it
    return { stdout: '' };
  };
  const { repo, workers } = await start(t, BODY, undefined, {}, { exec });
  const worktree = join(repo, '.hive', 'worktrees', 'hive-1-from-ready');
  assert.deepEqual(calls.at(0)?.slice(3, 5), ['worktree', 'list'], 'the path git lists decides everything that follows');
  assert.deepEqual(calls.find((c) => c.includes('add'))?.slice(3), ['worktree', 'add', '-b', 'hive/1-from-ready', '--', worktree], 'no start point: nothing here resolves origin/main');
  assert.equal(workers[0].launch.cwd, worktree);
  assert.equal(plainArgs(workers[0].launch).some((a) => a.startsWith('--worktree')), false);
});

test('git refusing to create the worktree is a spawnFailed: the worker frees, the task keeps git\'s own words and no worker starts', async (t) => {
  const stderr = "fatal: 'hive/1-from-ready' is already checked out at '/repo/.claude/worktrees/hive-1-from-ready'\n";
  const exec: Exec = async (_file, args) => {
    if (args.includes('add')) throw Object.assign(new Error('Command failed: git …'), { stderr });
    if (args.includes('rev-parse')) throw new Error('not a ref');
    return { stdout: '' };
  };
  const { server, workers } = await start(t, BODY, undefined, {}, { exec });
  await waitFor(() => work0(server)?.error !== undefined);
  assert.equal(workers.length, 0, 'nothing was launched');
  assert.equal(worker0(server).status, 'empty', 'the worker is free again');
  assert.equal(work0(server)?.error, SPAWN_FAILED + stderr.trim(), 'git\'s words, not execFile\'s command line');
  // A git that answers nothing at all (no repository, no git on PATH) fails at the very first command: the base step tolerates
  // its own failures, but without a listing there is no worktree to hand the worker, so the task stops here too.
  const broken = await start(t, BODY, undefined, {}, { exec: async () => { throw new Error('fatal: not a git repository'); } });
  await waitFor(() => work0(broken.server)?.error !== undefined);
  assert.equal(broken.workers.length, 0);
  assert.equal(work0(broken.server)?.error, `${SPAWN_FAILED}fatal: not a git repository`);
});

test('POST /hooks/exit frees its worker and stops the task (#283)', async (t) => {
  const { base, server, workers } = await start(t);
  const { runId: ptyId } = worker0(server);
  await hiveFetch(`${base}/hooks/exit`, { method: 'POST', headers: { 'x-hive-pty': ptyId! } });
  await waitFor(() => worker0(server).status === 'empty');
  assert.equal(work0(server)?.stopped, true, 'no hive_done: the task is stopped');
  assert.equal(workers.length, 1, 'and nothing runs it again');
});

test('a workspace a worker runs in cannot move: 409; once it stopped; then the spawn and every git call follow the new repo', async (t) => {
  const git = fakeGit();
  const { base, server, workers } = await start(t, BODY, undefined, {}, { exec: git.exec });
  const other = (await tempHive(t)).repo;
  const busy = await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(other) });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: 'workspace hive has a running worker' });
  workers[0].handlers.onExit(); // no hive_done: the task is stopped (#283), nothing refills the worker
  await waitFor(() => worker0(server).status === 'empty');
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(other) })).status, 200, 'no worker left: the move goes through');
  git.clear();
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  assert.equal(workers.length, 2);
  assert.equal(workers[1].launch.cwd, worktreePath(other, TASK_SLUG), 'the task runs again, in the new repo');
  assert.ok(git.calls.length > 0 && git.calls.every((c) => c[2].startsWith(other)), git.calls.map((c) => c.join(' ')).join('\n'));
});

test('the daemon\'s own port takes a terminal socket from the board\'s origin and streams the pty\'s scrollback; close() resolves while the socket is open, terminating it (#407)', async (t) => {
  const { base, port, pty, server, ptyId } = await withPty(t);
  pty.emit('before\r\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ptys/${ptyId}/pty`, { origin: base, headers: { [SECRET_HEADER]: SECRET } });
  const first = new Promise<string>((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString()));
    ws.on('error', reject);
  });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  assert.equal(await first, 'before\r\n');
  assert.equal((await hiveFetch(`${base}/ptys/${ptyId}/pty`)).status, 404, 'the SSE stream is gone: the socket is the only way in');
  await server.close(); // without the socket's own close this never resolves: closeAllConnections() does not reach an upgraded socket
  assert.equal(await closed, 1006, 'terminated by the daemon, not a pty exit');
});

test('feedback on a task awaiting approval whose stage session is open in the user\'s own session is typed into that pty as a bracketed paste and Enter, with no second process; a pty gone meanwhile logs a line without the text and throws nothing (#483)', async (t) => {
  const { log, lines } = fakeLog();
  const { spawnPty, ptys } = fakePtys();
  // no worker for the automation: the only run is the user's own session
  const { repo, server, workers } = await start(t, idle({ ...BODY, stages: [{ ...STAGES[0], approval: true }] }), log, {}, { spawnPty });
  await readyOn(server, 'board:I1', { path: worktreePath(repo, TASK_SLUG), branch: TASK_BRANCH, base: null, local: false });
  await server.dispatch({ type: 'openSession', activityId: workId(server.getState()!, 'board:I1') });
  const ptyId = server.getState()!.workers.find((s) => s.freeSession)!.runId!;
  const host = workers[0].options?.ptys;
  assert.ok(host, 'the server hands its pty host to every spawn');
  host.spawn(ptyId, ['/bin/sh', '-c', 'claude'], repo, {}); // the pty the real spawner would open
  const parks = async (): Promise<void> => {
    await server.dispatch({ type: 'done', ptyId }); // hive_done in the session, in an approval stage (freeSessionDone)
    assert.ok(work0(server)?.approval, 'the task awaits');
  };
  await parks();
  const effects = await server.dispatch({ type: 'feedback', activityId: workId(server.getState()!, 'board:I1'), text: 'split the spec\nin two', start: true });
  assert.deepEqual(effects.map((e) => e.type), ['input']);
  assert.deepEqual(ptys[0].written, ['\x1b[200~The user reviewed this stage and asks:\n\nsplit the spec\nin two\x1b[201~\r']);
  assert.equal(workers.length, 1, 'no second process on the session');
  const id8 = ptyId.slice(0, 8);
  assert.ok(lines.includes(`INFO input pty=${id8}`), lines.join('\n'));
  ptys[0].exit(); // the pty goes before the worker does
  await parks();
  await server.dispatch({ type: 'feedback', activityId: workId(server.getState()!, 'board:I1'), text: 'rename the flag', start: false });
  assert.ok(lines.includes(`INFO input pty=${id8} dropped: no pty`), lines.join('\n'));
  assert.equal('approval' in task0(server), false, 'the task already left approval');
  assert.ok(!lines.some((l) => l.includes('split the spec') || l.includes('rename the flag')), 'never the text');
});

test('a free session whose turn ended on overloaded backs off, and its retry types continue into its pty as a bracketed paste and Enter, logged without the text (#805)', async (t) => {
  const { log, lines } = fakeLog();
  const { spawnPty, ptys } = fakePtys();
  const { repo, server, workers } = await start(t, idle(), log, {}, { spawnPty });
  await readyOn(server, 'board:I1', { path: worktreePath(repo, TASK_SLUG), branch: TASK_BRANCH, base: null, local: false });
  await server.dispatch({ type: 'openSession', activityId: workId(server.getState()!, 'board:I1') });
  const ptyId = server.getState()!.workers.find((s) => s.freeSession)!.runId!;
  const host = workers[0].options?.ptys;
  assert.ok(host, 'the server hands its pty host to every spawn');
  host.spawn(ptyId, ['/bin/sh', '-c', 'claude'], repo, {});
  await server.dispatch({ type: 'hook', ptyId, payload: { hook_event_name: 'StopFailure', error: 'overloaded' } });
  const waiting = server.getState()!.workers.find((s) => s.runId === ptyId)!;
  assert.equal(waiting.status, 'backoff');
  const effects = await server.dispatch({ type: 'retryDue', ptyId, until: waiting.backoff!.until });
  assert.deepEqual(effects.map((e) => e.type), ['input']);
  assert.deepEqual(ptys[0].written, ['\x1b[200~continue\x1b[201~\r']);
  assert.ok(lines.includes(`INFO input pty=${ptyId.slice(0, 8)}`), lines.join('\n'));
  assert.equal(server.getState()!.workers.find((s) => s.runId === ptyId)!.status, 'working');
});

test('a Stop before done leaves the worker waiting; after it the Stop ends the run: the session is killed, onFinish written, the task leaves (single stage) and the worker frees; a PR seen before stays on the task until then', async (t) => {
  const { log, lines } = fakeLog();
  const { base, server, workers } = await start(t, BODY, log);
  const [worker] = workers;
  const ptyId = worker0(server).runId!;
  await openPr(server, ptyId);
  assert.equal(worker0(server).status, 'working', 'a PR leaves the run working (#663)');
  assert.deepEqual(prs0(server), [{ url: 'https://github.com/acme/r/pull/9', state: 'open' }]);
  assert.equal(worker.killed, 0, 'a PR is not a transition any more');
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'Stop' })).status, 204);
  assert.equal(worker.killed, 0, 'no done yet: the worker is idle, not finished');
  assert.equal(worker0(server).status, 'waiting');
  assert.equal(task0(server).stage, 'fila');
  await markDone(server, ptyId);
  assert.equal(worker0(server).done, true);
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'Stop' })).status, 204);
  assert.equal(worker.killed, 1, 'killed through the effect, before the answer');
  assert.equal(worker0(server).status, 'empty');
  assert.deepEqual(server.getState()?.tasks, [], 'fila is the last stage');
  assert.ok(lines.includes('INFO setColumn #board:I1 → In review ok'), lines.join('\n'));
  worker.handlers.onExit();
  await sleep(20);
  assert.equal(workers.length, 1, 'the exit of a killed session is a no-op');
});

test('a Stop from a child session (a subagent or teammate) does not end the run; the main session does (#24)', async (t) => {
  const { base, repo, server, workers } = await start(t);
  const [worker] = workers;
  const ptyId = worker0(server).runId!;
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'SessionStart', cwd: repo, session_id: mainId })).status, 204);
  await markDone(server, ptyId);
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'Stop', session_id: 'another-child-session-0001' })).status, 204);
  assert.equal(worker.killed, 0);
  assert.equal(worker0(server).status, 'working', 'a child Stop is not even a turn end');
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'Stop', session_id: mainId })).status, 204);
  assert.equal(worker.killed, 1);
});

test('an error reported by the spawner lands in State.error with the worker slug', async (t) => {
  const { server, workers } = await start(t);
  workers[0].handlers.onError('pty: kill failed');
  await waitFor(() => server.getState()?.error === 'worker hive-1-from-ready: pty: kill failed');
  assert.equal(worker0(server).status, 'working', 'only the exit frees the worker');
});

test('an exit without Stop stops the task in its stage with its session: no new worker; a start runs it again with a fresh session id (#283)', async (t) => {
  const { base, server, workers } = await start(t);
  const first = worker0(server).runId;
  const session = work0(server)?.sessionId;
  workers[0].handlers.onExit();
  await waitFor(() => worker0(server).status === 'empty');
  assert.deepEqual([task0(server).stage, work0(server)?.stopped, work0(server)?.sessionId, workers.length], ['fila', true, session, 1]);
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  assert.notEqual(worker0(server).runId, first);
  assert.notEqual(work0(server)?.sessionId, session, 'fila is new: a fresh id each run');
  assert.equal(work0(server)?.stopped, undefined);
});

test('POST /ptys/:id/stop kills the live run and keeps the session and the worktree, whatever the body; the task is stopped at once and the worker frees on its exit; an unknown worker is 404; /slots/:id/close is gone (#182, #283)', async (t) => {
  const git = fakeGit();
  const { base, server, workers } = await start(t, BODY, undefined, {}, { exec: git.exec });
  git.clear(); // the worker is up: its worktree was created through this same exec
  const { id, runId: ptyId } = worker0(server);
  const session = work0(server)?.sessionId;
  assert.equal((await postJson(`${base}/slots/${id}/close`)).status, 404);
  assert.equal((await postJson(`${base}/ptys/nope/stop`)).status, 404);
  assert.deepEqual(await json(postJson(`${base}/ptys/${ptyId}/stop`, { removeWorktree: true })), { ok: true });
  assert.equal(workers[0].killed, 1);
  assert.deepEqual([worker0(server).status, work0(server)?.stopped, work0(server)?.sessionId], ['working', true, session]);
  assert.deepEqual(git.calls, [], 'stop only stops: no git');
  workers[0].handlers.onExit();
  await waitFor(() => worker0(server).status === 'empty');
  assert.equal(workers.length, 1, 'stopped: nothing runs it again');
});

test('kill on a worker whose process the pool does not know (Hive restarted) frees the worker directly', async (t) => {
  const { home, repo } = await tempHive(t);
  const { factory } = fakeSourceFactory();
  const config = parseConfig(combConfig({ sources: BODY.sources, path: repo }));
  const sources = createSources(config, factory);
  const [source] = sources.values();
  const previous = reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, stages: config.comb.stages, transitions: config.comb.transitions }, { type: 'poll', source: 'board', items: await source.listItems() }).state; // occupied by a worker of a previous run
  const state: State = { ...previous, signal: 'yellow' }; // yellow: the freed task is not run again, so the freed worker stays visible
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: factory, launchPty: spawn, exec: noGit, runtime: { config, sources }, state });
  await server.listen(0);
  t.after(() => server.close());
  await server.dispatch({ type: 'stop', ptyId: state.workers[0].runId! });
  assert.equal(worker0(server).status, 'empty');
  assert.deepEqual(server.getState()?.tasks.map((c) => [c.item.id, runOf(server, c)?.workerId, runOf(server, c)?.stopped]), [['1', undefined, true]]);
  assert.equal(workers.length, 0);
});

test('close() kills every live worker before the HTTP server goes down, and a second close() is a no-op; it records the Quit first, which is how SIGTERM and SIGINT count as one (#283)', async (t) => {
  const { base, home, server, workers } = await start(t);
  await server.close();
  assert.equal(workers[0].killed, 1);
  const saved = JSON.parse(await readFile(join(home, 'state.json'), 'utf8')) as State;
  assert.deepEqual([saved.cleanStop, saved.workers[0].status], [true, 'working'], 'saved before the kills: the next boot resumes the task instead of reporting a crash');
  await assert.rejects(hiveFetch(`${base}/settings`));
  await server.close();
});

test('POST /stop: 403 without the UI header, 501 without an onStop dep, 200 { ok: true } with one; onStop runs once, after the answer, and closing there kills the workers', async (t) => {
  const bare = createServer({ secret: SECRET, home: await tempDir(t, 'home-'), log: fakeLog().log });
  const barePort = await bare.listen(0);
  t.after(() => bare.close());
  const noHeader = await hiveFetch(`http://127.0.0.1:${barePort}/stop`, { method: 'POST' });
  assert.equal(noHeader.status, 403, 'a form on any site cannot stop the Hive');
  const unsupported = await postJson(`http://127.0.0.1:${barePort}/stop`);
  assert.equal(unsupported.status, 501);
  assert.deepEqual(await unsupported.json(), { error: 'stop not supported' });

  const { log, lines } = fakeLog();
  let stops = 0;
  const started = await start(t, BODY, log, {}, { onStop: () => { stops += 1; void started.server.close(); } });
  const { base, workers } = started;
  const res = await postJson(`${base}/stop`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true }, 'the answer leaves before close() drops the connections');
  await waitFor(() => stops === 1 && workers[0].killed === 1);
  const saved = JSON.parse(await readFile(join(started.home, 'state.json'), 'utf8')) as State;
  assert.equal(saved.cleanStop, true, 'close() saved the quit before the kills (#283)');
  assert.ok(lines.includes('INFO stop requested'), lines.join('\n'));
  await assert.rejects(hiveFetch(`${base}/settings`), 'the server is gone');
  await sleep(20);
  assert.equal(stops, 1, 'one request, one stop');
});

test('listen keeps a free port it is given, falls back to a free one when another listener holds it, and lets the OS pick with none (#466)', async (t) => {
  const bind = async (port: number | undefined): Promise<number> => {
    const server = createServer({ secret: SECRET, home: await tempDir(t, 'home-'), log: fakeLog().log });
    t.after(() => server.close());
    return server.listen(port);
  };
  const free = await getFreePort();
  assert.equal(await bind(free), free, 'the last port, still free: the board keeps its origin');
  const picked = await bind(undefined);
  assert.ok(picked > 0, 'none recorded: the OS picks one');
  const moved = await bind(picked); // held by the server above
  assert.ok(moved > 0);
  assert.notEqual(moved, picked, 'a taken port is not an error: another one is bound');
});

test('GET /ptys counts the workers a stop would kill (#193) and lists them for the menu bar (#192): occupied workers in worker order, manual sessions included, labelled as the footer is; no empty worker, no worker whose task is gone; nothing in setup mode; a terminal counted too (#283)', async (t) => {
  const setup = createServer({ secret: SECRET, home: await tempDir(t, 'home-'), log: fakeLog().log });
  const setupPort = await setup.listen(0);
  t.after(() => setup.close());
  assert.deepEqual(await json(hiveFetch(`http://127.0.0.1:${setupPort}/ptys`)), { active: 0, ptys: [] }, 'no live state: nothing to stop, nothing to list');

  const { home, repo } = await tempHive(t);
  const { factory } = fakeSourceFactory();
  const config = parseConfig(combConfig({ sources: BODY.sources, path: repo }));
  const stage = config.comb.stages[0].name;
  const sourceTask: Task = {
    item: { itemId: 'I1', source: 'board', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' },
    stage, boardColumn: 'Ready', auto: true,
  };
  const localTask: Task = { // a local task (#132): labelled without the "#"
    item: { itemId: 'local:2', id: 'HIVE-2', title: 'Local 2', body: '', url: '' },
    stage, boardColumn: '', auto: true, created: true,
  };
  const state: State = withWork(withWork({
    ...initialState(5),
    workspaces: ['hive'],
    stages: config.comb.stages,
    tasks: [sourceTask, localTask],
    signal: 'yellow', // nothing is spawned into the empty worker while the test reads the list
    terminals: [{ terminalId: 'a1b2c3d4-0000-4000-8000-000000000009', activityId: activityIdOf('I1'), startedAt: '2026-09-25T10:00:00.000Z', cwd: '/repo' }],
    workers: [
      { id: 'A', status: 'working', runId: 'W1', activityId: activityIdOf('I1') },
      { id: 'B', status: 'waiting', runId: 'W2', activityId: activityIdOf('local:2') },
      { id: 'C', status: 'review', runId: 'W3', activityId: activityIdOf('I3') }, // its task is gone: counted for Quit, nothing to label or open
      { id: 'D', status: 'working', runId: 'W4', activityId: activityIdOf('I1'), freeSession: true }, // /stop kills a free session too, and it gets its own line
      { id: 'E', status: 'empty' },
    ],
  }, 'I1', { workerId: 'A' }), 'local:2', { workerId: 'B' }); // #629: the activities the runs point at, each with its stage run
  const server = createServer({
    secret: SECRET, home, sourceFactory: factory, launchPty: fakeSpawn().spawn, exec: noGit,
    runtime: { config, sources: createSources(config, factory) }, state,
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  assert.deepEqual(await json(hiveFetch(`http://127.0.0.1:${port}/ptys`)), {
    active: 5,
    ptys: [
      { id: 'W1', taskId: 'I1', status: 'working', label: '#1 Task 1' },
      { id: 'W2', taskId: 'local:2', status: 'waiting', label: 'HIVE-2 Local 2' },
      { id: 'W4', taskId: 'I1', status: 'working', label: '#1 Task 1' },
      { id: 'a1b2c3d4-0000-4000-8000-000000000009', taskId: 'I1', status: 'terminal', label: '#1 Task 1' },
    ],
  });
  assert.equal((await hiveFetch(`http://127.0.0.1:${port}/slots/A/output`)).status, 404, 'the Worker tab route is gone (#283)');
});

test('every poll reads the source quota afterwards and persists it; a source without quota stores nothing', async (t) => {
  const { base, server } = await start(t);
  assert.equal(server.getState()?.syncs.board?.quota, undefined, 'the default fake has no quota');
  assert.deepEqual(await json(postJson(`${base}/sources/refresh`)), { ok: true });
  assert.equal(server.getState()?.syncs.board?.quota, undefined);
  const { home, repo } = await tempHive(t, 1);
  const withQuota = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory(0, QUOTA).factory, launchPty: fakeSpawn().spawn, exec: noGit });
  const port = await withQuota.listen(0);
  t.after(() => withQuota.close());
  assert.equal((await postJson(`http://127.0.0.1:${port}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200); // configure validates and writes; the poll runs in the background (#59)
  await withQuota.poll(); // the quota is read at the end of every poll
  assert.deepEqual(withQuota.getState()?.syncs.board?.quota, QUOTA);
  await withQuota.dispatch({ type: 'sourceQuota', source: 'board', quota: { ...QUOTA, remaining: 1 } }); // overwrite, so the refresh below proves a re-read
  assert.deepEqual(await json(postJson(`http://127.0.0.1:${port}/sources/refresh`)), { ok: true });
  assert.deepEqual(withQuota.getState()?.syncs.board?.quota, QUOTA, 'read again after the manual poll');
  const saved = JSON.parse(await readFile(join(home, 'state.json'), 'utf8')) as State;
  assert.deepEqual(saved.syncs.board.quota, QUOTA, 'persisted with the rest of the state');
  assert.equal(withQuota.getState()?.error, undefined);
});

test('the manual poll is POST /sources/refresh; POST /board/refresh is gone, with no alias (#703)', async (t) => {
  const { base } = await start(t);
  assert.equal((await postJson(`${base}/board/refresh`)).status, 404);
  assert.deepEqual(await json(postJson(`${base}/sources/refresh`)), { ok: true });
});

test('the timer skips the source while nothing could start, and reads it again once the last poll is 5 min old', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() }); // the timer and the clock shouldPoll reads
  let polls = 0;
  const inner = fakeSourceFactory().factory;
  const { home, repo } = await tempHive(t);
  const server = createServer({
    secret: SECRET, home, launchPty: fakeSpawn().spawn, exec: noGit,
    sourceFactory: (config) => {
      const board = inner(config);
      return { ...board, listItems: () => { polls += 1; return board.listItems(); } };
    },
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  assert.equal((await postJson(`http://127.0.0.1:${port}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200); // no worker: nothing can start
  assert.equal(polls, 1, 'configure always polls');
  for (let i = 1; i <= 9; i += 1) { // one interval at a time, as the clock does: 9 ticks = 4 min 30 s since the configure poll
    t.mock.timers.tick(30_000);
    await sleep(5);
    assert.equal(polls, 1, `tick ${i} with no free worker: the board is not asked`);
  }
  const before = server.getState()?.syncs.board?.polledAt;
  t.mock.timers.tick(30_000); // 5 min: stale
  await waitFor(() => polls === 2 && server.getState()?.syncs.board?.polledAt !== before); // the poll landed: the next tick reads its stamp
  t.mock.timers.tick(30_000);
  await sleep(10);
  assert.equal(polls, 2, 'fresh again: the next tick skips');
  assert.equal(server.getState()?.error, undefined);
});

test('the log tells the story: worker transitions, signal and source writes at info, events at debug, and never a tool_input', async (t) => {
  const { log, lines } = fakeLog();
  const { base, repo, server } = await start(t, BODY, log);
  const ptyId = worker0(server).runId!;
  const id8 = ptyId.slice(0, 8);
  const has = (line: string): void => assert.ok(lines.includes(line), `missing "${line}" in:\n${lines.join('\n')}`);
  has('INFO signal.changed from=green to=yellow'); // boot (#742: the record's text line)
  has('INFO poll source=board items=1');
  has('INFO signal.changed from=yellow to=green');
  has(`INFO worker 1: empty → working #1 pty=${id8}`);
  has('INFO setColumn #board:I1 → In progress ok');
  has(`INFO spawn worker=${worker0(server).id.slice(0, 8)} #1 slug=hive-1-from-ready stage=fila session=new pty=${id8}`);
  has('DEBUG setSignal green');
  has(`DEBUG effects: setColumn #board:I1 → In progress; spawn worker=${worker0(server).id.slice(0, 8)} #1 slug=hive-1-from-ready stage=fila session=new pty=${id8}`);
  const session = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'SessionStart', cwd: repo, session_id: session })).status, 204);
  assert.equal(worker0(server).sessionId, session, 'the route hands the whole payload to the reducer');
  has(`DEBUG hook SessionStart pty=${id8}`);
  has(`INFO worker 1: session=${session} #1 pty=${id8}`);
  assert.equal(lines.filter((l) => l.includes(`session=${session}`)).length, 1, 'one line per session');
  await openPr(server, ptyId);
  has(`DEBUG hook PostToolUse pty=${id8} tool=Bash`);
  assert.ok(!lines.some((l) => l.includes('→ review')), 'a PR moves no worker to review: the task state shows it (#663)');
  assert.ok(!lines.some((l) => l.includes('setColumn #board:I1 → In review')), 'a PR writes nothing');
  assert.ok(!lines.some((l) => l.includes('gh pr create')), 'tool_input never reaches the log');
  assert.ok(!lines.some((l) => l.includes('pull/9')), 'tool_response never reaches the log');
  assert.ok(!lines.some((l) => l.startsWith('ERROR')), lines.filter((l) => l.startsWith('ERROR')).join('\n'));
});

test('POST /settings re-reads logLevel from hive.config.json and switches the logger level without a restart', async (t) => {
  const { log, lines } = fakeLog();
  const { base, home, port } = await start(t, BODY, log);
  assert.ok(lines.includes('LEVEL info'), 'the first save activates the default level');
  assert.ok(lines.includes(`INFO config port=${port} sources=board:github logLevel=info stages=fila`));
  assert.ok(lines.includes('INFO settings saved'));
  assert.ok(lines.includes(`INFO listening port=${port}`));
  const file = join(home, 'hive.config.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...saved, logLevel: 'debug' })); // the hand edit the spec describes
  const formBody = BODY; // the form re-save: no logLevel in the body
  assert.equal((await postJson(`${base}/settings`, formBody)).status, 200);
  assert.ok(lines.includes('LEVEL debug'), lines.filter((l) => l.startsWith('LEVEL')).join('\n'));
  assert.ok(lines.includes(`INFO config port=${port} sources=board:github logLevel=debug stages=fila`));
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as { logLevel: string }).logLevel, 'debug', 'the save keeps the level it read');
});

test('POST /settings reads the plan limits through the injected reader with no worker alive, and the timer reads again every 5 min', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] }); // before listen: the timer is armed there
  let reads = 0;
  const { home, repo } = await tempHive(t);
  const server = createServer({
    secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, exec: noGit,
    readPlanLimits: async () => { reads += 1; return claudePlan({ ...PLAN, at: `2026-09-17T12:0${reads}:00.000Z` }); },
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  assert.equal(reads, 0, 'nothing to read before the Hive is configured');
  assert.equal((await postJson(`http://127.0.0.1:${port}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200); // no worker: no worker ever
  await waitFor(() => reads === 1); // the poll and the plan-limits read both run in the background (#59)
  assert.equal(reads, 1, 'configure reads once, after the poll');
  assert.deepEqual(server.getState()?.rateLimits?.claude, { ...PLAN, at: '2026-09-17T12:01:00.000Z' });
  t.mock.timers.tick(PLAN_LIMITS_INTERVAL_MS);
  await waitFor(() => server.getState()?.rateLimits?.claude?.at === '2026-09-17T12:02:00.000Z');
  assert.equal(reads, 2);
  // the state changes before persist writes it: wait for the file, not the memory
  const saved = async (): Promise<State> => JSON.parse(await readFile(join(home, 'state.json'), 'utf8')) as State;
  for (let i = 0; i < 200 && (await saved()).rateLimits?.claude?.at !== '2026-09-17T12:02:00.000Z'; i += 1) await sleep(5);
  assert.deepEqual((await saved()).rateLimits, server.getState()?.rateLimits, 'persisted like any other reading');
  assert.equal(server.getState()?.error, undefined);
});

test('a failing agent keeps its last value and the Hive going; the reason is logged once per change and the recovery once (#929)', async (t) => {
  const { log, lines } = fakeLog();
  let failWith: string | undefined = NO_TOKEN;
  const { home, repo } = await tempHive(t);
  const server = createServer({
    secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, exec: noGit, log,
    readPlanLimits: async () => (failWith ? claudePlanFailure(failWith) : claudePlan(PLAN)),
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  const planLines = (): string[] => lines.filter((l) => l.includes('plan limits'));
  assert.equal((await postJson(`http://127.0.0.1:${port}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200, 'setup succeeds without limits');
  await waitFor(() => planLines().length > 0); // the plan-limits read runs in the background, after the poll (#59)
  assert.equal(server.getState()?.rateLimits?.claude, undefined);
  assert.equal(server.getState()?.error, undefined, 'never the error bar: an API-key user has no token, by design');
  assert.deepEqual(planLines(), [`INFO plan limits claude: ${NO_TOKEN}`]);
  await server.refreshPlanLimits();
  assert.deepEqual(planLines(), [`INFO plan limits claude: ${NO_TOKEN}`], 'same reason again: silent');
  failWith = 'HTTP 401';
  await server.refreshPlanLimits();
  assert.deepEqual(planLines(), [`INFO plan limits claude: ${NO_TOKEN}`, 'INFO plan limits claude: HTTP 401']);
  failWith = undefined;
  await server.refreshPlanLimits();
  assert.deepEqual(server.getState()?.rateLimits?.claude, PLAN);
  assert.deepEqual(planLines().at(-1), 'INFO plan limits claude: ok');
  await server.refreshPlanLimits();
  assert.equal(planLines().length, 3, 'a success after a success logs nothing');
  failWith = 'HTTP 401';
  await server.refreshPlanLimits();
  assert.deepEqual(server.getState()?.rateLimits?.claude, PLAN, 'the last value stays');
  assert.ok(!lines.some((l) => l.startsWith('ERROR')), lines.filter((l) => l.startsWith('ERROR')).join('\n'));
});

test('without a readPlanLimits dep the server never reads the plan limits and logs nothing about them', async (t) => {
  const { log, lines } = fakeLog();
  const { server } = await start(t, BODY, log);
  await server.refreshPlanLimits();
  assert.equal(server.getState()?.rateLimits, undefined);
  assert.ok(!lines.some((l) => l.includes('plan limits')), lines.join('\n'));
});

test('POST /tasks/:id/start under yellow opens the task in the pool with its slug, marked manualStart; 404 for an unknown task, 409 before the settings', async (t) => {
  const { home, repo } = await tempHive(t, 2);
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec: noGit });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/tasks/board:I1/start`)).status, 409, 'not configured');
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200); // boot opens under yellow: I1 queued, nothing spawned
  await server.poll(); // the first poll runs in the background (#59)
  assert.equal(server.getState()?.signal, 'yellow');
  assert.deepEqual(server.getState()?.tasks.filter((c) => !runOf(server, c)?.workerId).map((c) => c.item.id), ['1']);
  assert.equal(workers.length, 0);
  const missing = await postJson(`${base}/tasks/nope/start`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'tarefa desconhecida' });
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  const worker = worker0(server);
  assert.equal(worker.status, 'working');
  assert.deepEqual(worker.lastEvent, { kind: 'manualStart' });
  assert.equal(workers.length, 1, 'the spawn ran before the answer');
  assert.equal(workers[0].launch.slug, 'hive-1-from-ready');
  assert.equal(workers[0].launch.ptyId, worker.runId);
  assert.equal(server.getState()?.tasks.filter((c) => !runOf(server, c)?.workerId).length, 0);
  assert.equal(server.getState()?.signal, 'yellow', 'the signal is untouched');
  assert.equal(server.getState()?.maxConcurrent, 2, 'a free worker: the cap is untouched');
  assert.equal(server.getState()?.workers.length, 2, 'a free worker: nothing appended');
});

test('POST /tasks/:id/start is 409 for a blocked task; with every worker taken it answers ok, opens the worker in a draining worker over the cap and leaves maxConcurrent alone; the worker goes with its exit', async (t) => {
  const { log, lines } = fakeLog();
  const { base, home, server, workers } = await start(t, BODY, log); // 1 worker, I1 working
  const blocked = { itemId: 'board:I2', source: 'board', id: '2', title: 'blocked', body: '', url: 'https://github.com/acme/r/issues/2', blockedBy: ['1'] };
  const free = { itemId: 'board:I3', source: 'board', id: '3', title: 'free', body: '', url: 'https://github.com/acme/r/issues/3' };
  await server.dispatch({ type: 'poll', source: 'board', items: [{ item: { itemId: 'board:I1', source: 'board', id: '1', title: 'from Ready', body: '', url: 'https://github.com/acme/r/issues/1' }, column: 'Ready' }, { item: blocked, column: 'Ready' }, { item: free, column: 'Ready' }] }); // I1 stays in its worker; no free worker, so nothing spawns
  assert.deepEqual(server.getState()?.tasks.filter((c) => !runOf(server, c)?.workerId).map((c) => c.item.id), ['2', '3']);
  const refused = await postJson(`${base}/tasks/board:I2/start`);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'task bloqueado por 1' });
  assert.equal(workers.length, 1);
  assert.ok(!lines.some((l) => l.startsWith('DEBUG start')), 'a refusal never reaches the reducer');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I3/start`, { raiseMax: true })), { ok: true }, 'an old client\'s body is ignored, not refused');
  assert.equal(server.getState()?.maxConcurrent, 1, 'the cap never moves from a start');
  assert.equal(server.getState()?.workers.length, 2);
  const opened = server.getState()!.workers[1];
  assert.equal(taskOfWorker(server.getState()!, opened)?.item.itemId, 'board:I3');
  assert.equal(opened.draining, true);
  assert.deepEqual(opened.lastEvent, { kind: 'manualStart' });
  assert.equal(workers.length, 2);
  assert.equal(workers[1].launch.slug, 'hive-3-free');
  assert.deepEqual(server.getState()?.tasks.filter((c) => !runOf(server, c)?.workerId).map((c) => c.item.id), ['2']);
  assert.ok(lines.includes('DEBUG start #board:I3'), lines.filter((l) => l.includes('start')).join('\n'));
  assert.ok(lines.includes(`INFO worker 2: empty → working #3 pty=${opened.runId!.slice(0, 8)}`), 'the worker that appeared occupied is a transition');
  const saved = JSON.parse(await readFile(join(home, 'state.json'), 'utf8')) as State;
  assert.equal(saved.maxConcurrent, 1, 'nothing raised: the stored cap survives a restart');
  assert.equal(saved.workers[1]?.draining, true, 'the extra worker is saved as any worker, with its mark');
  workers[1].handlers.onExit();
  await waitFor(() => server.getState()!.workers.length === 1);
  assert.equal(server.getState()?.maxConcurrent, 1);
  assert.deepEqual(server.getState()?.tasks.filter((c) => !runOf(server, c)?.workerId).map((c) => c.item.id), ['3', '2'], 'the task waits for a worker again, above the blocked one its start moved it over (#117)');
  assert.equal(workers.length, 2, 'no free worker: nothing respawns');
  assert.equal(server.getState()?.error, undefined);
});

test('blockedMessage names the task\'s own blockers, then each inherited one with the ancestor that holds it (#424)', () => {
  const item = { itemId: 'board:I2', source: 'board', id: '2', title: 'child', body: '', url: 'https://github.com/acme/r/issues/2' };
  const held = (extra: Partial<Task['item']>): Task => ({ item: { ...item, ...extra }, stage: 'dev', boardColumn: 'Ready', auto: true });
  assert.equal(blockedMessage(held({ inheritedBlockedBy: [{ id: '12', via: '7' }] })), 'task bloqueado por 12 (via 7)');
  assert.equal(blockedMessage(held({ blockedBy: ['1'], inheritedBlockedBy: [{ id: '12', via: '7' }, { id: '15', via: '3' }] })), 'task bloqueado por 1, 12 (via 7), 15 (via 3)');
  assert.equal(blockedMessage(held({ blockedBy: ['1'] })), 'task bloqueado por 1');
});

test('POST /tasks/:id/start is 409 for a show epic: it never runs (#31)', async (t) => {
  const { base, server, workers } = await start(t); // 1 worker, I1 working
  const epic = { itemId: 'board:I2', source: 'board', id: '2', title: 'epic', body: '', url: 'https://github.com/acme/r/issues/2', epic: { follows: 'behind' as const, switchAt: 'fila' } };
  await server.dispatch({ type: 'poll', source: 'board', items: [{ item: { itemId: 'board:I1', source: 'board', id: '1', title: 'from Ready', body: '', url: 'https://github.com/acme/r/issues/1' }, column: 'Ready' }, { item: epic, column: 'Ready' }] });
  const refused = await postJson(`${base}/tasks/board:I2/start`);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'um épico não executa: sua etapa vem das filhas' });
  assert.equal(workers.length, 1, 'nothing spawned');
});

test('POST /tasks/:id/close and /keep answer a missing task: close kills and removes it, keep makes it an orphan; 404 unknown, 409 while it is still on the source', async (t) => {
  const { base, server, workers } = await start(t); // I1 running
  assert.equal((await postJson(`${base}/tasks/nope/close`)).status, 404);
  const early = await postJson(`${base}/tasks/board:I1/keep`);
  assert.equal(early.status, 409);
  assert.deepEqual(await early.json(), { error: 'tarefa ainda está na source' });
  await server.dispatch({ type: 'poll', source: 'board', items: [] }); // the source no longer lists it
  assert.equal(server.getState()?.tasks[0].missing, true);
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/keep`)), { ok: true });
  assert.deepEqual([server.getState()?.tasks[0].orphan, server.getState()?.tasks[0].missing], [true, undefined]);
  assert.equal(workers[0].killed, 0);
  const again = await start(t);
  await again.server.dispatch({ type: 'poll', source: 'board', items: [] });
  assert.deepEqual(await json(postJson(`${again.base}/tasks/board:I1/close`)), { ok: true });
  assert.equal(again.workers[0].killed, 1);
  assert.deepEqual(again.server.getState()?.tasks, []);
  assert.equal(worker0(again.server).status, 'empty');
});

test('POST /tasks/:id/close and /keep answer 409 while the missing task\'s worktree is being removed, so the removal\'s answer still finds the task (#182)', async (t) => {
  const { base, server } = await ranOnce(t);
  await server.dispatch({ type: 'poll', source: 'board', items: [] }); // the source no longer lists it
  await server.dispatch({ type: 'deletingActivity', activityId: workId(server.getState()!, 'board:I1') });
  assert.deepEqual([task0(server).missing, work0(server)?.deleting], [true, true]);
  for (const action of ['close', 'keep']) {
    const res = await postJson(`${base}/tasks/board:I1/${action}`);
    assert.equal(res.status, 409, action);
    assert.deepEqual(await res.json(), { error: 'atividade sendo excluída' });
  }
  assert.equal(server.getState()?.tasks.length, 1, 'the task is still there');
});

test('POST /settings with different stages dispatches setStages: the state follows and a stopped task in a vanished stage is dropped until the next poll re-enters it', async (t) => {
  const { base, server } = await start(t, idle()); // I1 stopped in fila
  assert.equal(server.getState()?.tasks[0].stage, 'fila');
  const stages = [{ name: 'triagem', from: { board: ['Ready'] }, prompt: 'x' }];
  assert.equal((await postJson(`${base}/settings`, onOwnStages({ ...BODY, stages }))).status, 200);
  await server.poll(); // reconfigure's poll runs in the background (#59)
  assert.deepEqual(server.getState()?.stages, stages);
  assert.equal(server.getState()?.tasks[0].stage, 'triagem', 'reconfigure polls: the task came back through the new from');
});

test('POST /settings answers once the config is written and the new stages are reduced, not after the sourceAction that reduction fires (#476)', async (t) => {
  const applied: string[] = [];
  let releaseApply: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { releaseApply = resolve; });
  // A source whose apply() hangs until the test releases it, standing in for a slow adapter request: reconfigure must not make
  // POST /settings wait on it.
  const factory = (): Source => ({
    async resolveFields() {},
    async listItems() {
      return [{ item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, column: 'Ready' }];
    },
    async setColumn() {},
    async apply(itemId, action) {
      applied.push(`${itemId} ${action.type}`);
      await held;
    },
    async settingsOptions() {
      return OPTIONS;
    },
  });
  const { base, server } = await start(t, idle(), undefined, {}, { sourceFactory: factory }); // I1 stopped in fila
  assert.equal(task0(server).stage, 'fila');

  // Turns `fila` into a delete activity stage whose onFinish archives: with nothing on the task to clean, setStages' own reduction (fill's
  // runDeletions) advances it straight into a leaving sourceAction (#286), the effect this bug used to block the answer on.
  const stages: LegacyStage[] = [{ name: 'fila', from: { board: ['Ready'] }, action: 'deleteActivity', onFinish: { board: [{ type: 'archive' }] } }];
  const setup = postJson(`${base}/settings`, onOwnStages({ ...BODY, stages }));
  const TIMEOUT = Symbol('timeout');
  const race = await Promise.race([setup, sleep(300).then(() => TIMEOUT)]);
  try {
    if (typeof race === 'symbol') throw new Error('POST /settings must answer before the sourceAction it fired settles (#476)');
    assert.equal(race.status, 200);
    assert.equal((await json<SettingsResult>(race)).ok, true);
    assert.deepEqual(server.getState()?.stages, chained(stages).stages, 'the new stages are already reduced into the state');
    assert.equal(task0(server).leaving, true, 'the reduction already ran: the task is marked leaving before the board answered');
    assert.equal(applied.length, 1, 'the sourceAction effect already started in the background');
  } finally {
    releaseApply!(); // a timed-out run must not leave the fake source's apply() hanging forever
  }
  await waitFor(() => server.getState()?.tasks.length === 0); // closeTask, once the source finally answers
  assert.deepEqual(applied, ['I1 archive']);
});

test('a refused close ahead of an archive leaves the task leaving, and the archive\'s success closes it (#515)', async (t) => {
  const applied: string[] = [];
  const factory = (): Source => ({
    async resolveFields() {},
    async listItems() {
      return [{ item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, column: 'Ready' }];
    },
    async setColumn() {},
    async apply(itemId, action) {
      if (action.type === 'close') throw new Error('drafts cannot be closed');
      applied.push(`${itemId} ${action.type}`);
    },
    async settingsOptions() {
      return OPTIONS;
    },
  });
  const { base, server } = await start(t, idle(), undefined, {}, { sourceFactory: factory });
  // A delete activity stage with nothing to delete advances at once into its onFinish: close (refused), then archive.
  const stages: LegacyStage[] = [{ name: 'fila', from: { board: ['Ready'] }, action: 'deleteActivity', onFinish: { board: [{ type: 'close' }, { type: 'archive' }] } }];
  assert.equal((await postJson(`${base}/settings`, onOwnStages({ ...BODY, stages }))).status, 200);
  await waitFor(() => server.getState()?.tasks.length === 0);
  assert.deepEqual(applied, ['I1 archive']);
});

test('a save\'s sourceAction effects stay pinned to that save\'s own runtime even once a concurrent second save renames the source (#476)', async (t) => {
  const started: string[] = [];
  const applied: string[] = [];
  let releaseI1: (() => void) | undefined;
  const heldI1 = new Promise<void>((resolve) => { releaseI1 = resolve; });
  // Lists I1 and I2 on every poll, like the single-task #476 test above: start()'s own poll and the background ones fired
  // by both saves see the same two items throughout, so neither task is ever marked missing.
  const factory = (): Source => ({
    async resolveFields() {},
    async listItems() {
      return [
        { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, column: 'Ready' },
        { item: { itemId: 'I2', id: '2', title: 'Task 2', body: '', url: 'https://github.com/acme/r/issues/2' }, column: 'Ready' },
      ];
    },
    async setColumn() {},
    async apply(itemId, action) {
      started.push(itemId);
      if (itemId === 'I1') await heldI1; // holds the effect loop here so save #2 can swap live.runtime mid-batch
      applied.push(`${itemId} ${action.type}`);
    },
    async settingsOptions() {
      return OPTIONS;
    },
  });
  const { base, server } = await start(t, idle(), undefined, {}, { sourceFactory: factory });
  assert.equal(server.getState()?.tasks.length, 2);

  // Turns `fila` into a delete activity stage: both tasks' onFinish archives in the same setStages reduction, one sourceAction effect
  // each, run in order by dispatch's effect loop (#476).
  const stages: LegacyStage[] = [{ name: 'fila', from: { board: ['Ready'] }, action: 'deleteActivity', onFinish: { board: [{ type: 'archive' }] } }];
  assert.equal((await postJson(`${base}/settings`, onOwnStages({ ...BODY, stages }))).status, 200);
  await waitFor(() => started.includes('I1')); // I1's sourceAction is running and held; I2's has not started yet

  // Save #2 renames `board` away while I1's effect is still in flight: the running batch's still-pending I2 effect must
  // resolve against save #1's own source instance, not whatever live.runtime holds once save #2 lands.
  const renamed: LegacyStage[] = [{ name: 'fila', from: { board2: ['Ready'] }, onStart: { board2: [move('In progress')] }, onFinish: { board2: [move('In review')] }, prompt: 'x' }];
  const save2 = await postJson(`${base}/settings`, {
    ...BODY, stages: renamed, sources: [{ ...GITHUB_ENTRY, name: 'board2' }], renames: { board: 'board2' },
  });
  assert.equal(save2.status, 200, await save2.clone().text());

  releaseI1!();
  // Bounded, not waitFor: a still-dropped I2 never reaches applied.length 2, and that (a mismatch, not a timeout) is the failure this
  // test means to show.
  for (let i = 0; i < 200 && applied.length < 2; i += 1) await sleep(5);
  assert.deepEqual(applied, ['I1 archive', 'I2 archive'], 'I2\'s effect was not dropped as "no board" by save #2\'s runtime');
});

test('GET / serves the built index.html and its hashed asset through express.static, and /terminal.html is the second Vite entry; the old /ui/*.js routes are gone', async (t) => {
  const server = createServer({ secret: SECRET, home: await tempDir(t, 'home-'), sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, exec: noGit }); // setup mode: the page must load before any config
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const page = await hiveFetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(asset, `no /assets/*.js script in:\n${html}`);
  const js = await hiveFetch(`${base}${asset}`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
  assert.equal((await hiveFetch(`${base}/ui/app.js`)).status, 404);
  assert.equal((await hiveFetch(`${base}/../package.json`)).status, 404, 'static never leaves UI_DIR');
  const terminal = await hiveFetch(`${base}/terminal.html?slug=hive-1-task`);
  assert.equal(terminal.status, 200);
  assert.match(await terminal.text(), /src="\/assets\/terminal-[^"]+\.js"/, 'the terminal window page, built from src/ui/terminal.html');
});

test('a spawn failure frees the worker and marks the task with the message: the bar shows it, neither fill nor a poll retries, a manual start does', async (t) => {
  const { base, server, workers } = await start(t, BODY, undefined, { startError: 'pty: posix_spawnp failed.' });
  await waitFor(() => worker0(server).status === 'empty');
  assert.equal(workers.length, 1, 'no retry');
  assert.equal(work0(server)?.error, `${SPAWN_FAILED}pty: posix_spawnp failed.`);
  assert.equal(task0(server).stage, 'fila');
  assert.equal(server.getState()?.error, 'pty: posix_spawnp failed.');
  assert.deepEqual(await json(postJson(`${base}/sources/refresh`)), { ok: true });
  assert.equal(workers.length, 1, 'a poll does not retry either');
  assert.equal(work0(server)?.error, `${SPAWN_FAILED}pty: posix_spawnp failed.`, 'the error survives the poll');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  assert.equal(workers.length, 2, 'the manual start runs it again');
  await waitFor(() => worker0(server).status === 'empty'); // the fake fails every time: the task shows the error again
  assert.equal(work0(server)?.error, `${SPAWN_FAILED}pty: posix_spawnp failed.`);
});

test('the kill effect waits for the pool before the next effect: a new stage of the same task only spawns after the old session is gone', async (t) => {
  const stages: LegacyStage[] = [
    { name: 'plan', from: { board: ['Ready'] }, onFinish: { board: [move('In progress')] }, prompt: '/hive-plan {url}' },
    { name: 'dev', from: { board: ['In progress'] }, onFinish: { board: [move('In review')] }, prompt: '/hive-build {url}' },
  ];
  const { base, server, workers } = await start(t, { ...BODY, stages }, undefined, { holdKills: true });
  const ptyId = worker0(server).runId!;
  await markDone(server, ptyId);
  const stop = hookEvent(base, ptyId, { hook_event_name: 'Stop' }); // answered only after every effect ran
  await waitFor(() => workers[0].killed === 1);
  await sleep(20);
  assert.equal(workers.length, 1, 'no spawn while the kill is pending');
  assert.equal(task0(server).stage, 'dev');
  workers[0].releaseKill();
  assert.equal((await stop).status, 204);
  assert.equal(workers.length, 2);
  assert.equal(workers[1].launch.slug, workers[0].launch.slug);
  assert.equal(workers[1].launch.ptyId, worker0(server).runId);
  workers[1].releaseKill(); // close() awaits killAll: nothing may stay pending
});

test('a spawn queued behind a slow kill is dropped once close() has begun, never reaching the spawner after pool.killAll() (#476)', async (t) => {
  const stages: LegacyStage[] = [
    { name: 'plan', from: { board: ['Ready'] }, onFinish: { board: [move('In progress')] }, prompt: '/hive-plan {url}' },
    { name: 'dev', from: { board: ['In progress'] }, onFinish: { board: [move('In review')] }, prompt: '/hive-build {url}' },
  ];
  const { server, workers } = await start(t, { ...BODY, stages }, undefined, { holdKills: true });
  const ptyId = worker0(server).runId!;
  await markDone(server, ptyId);
  // Dispatched directly (not through /hooks/event): close() below drops every open connection, and this test cares about
  // the effect batch, not the hook route's own response.
  const stopped = server.dispatch({ type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
  await waitFor(() => workers[0].killed === 1); // the batch's kill effect is running and held

  const closed = server.close(); // sets `closing` synchronously, then itself hangs in pool.killAll() behind the same held kill
  workers[0].releaseKill(); // lets both the pending kill effect and killAll's own kill resolve
  try {
    await Promise.all([stopped, closed]);
    assert.equal(workers.length, 1, 'the batch\'s spawn effect ran after close() began and must have been dropped, not started');
  } finally {
    // Still on the unfixed code, the dropped-spawn guard is missing: a second worker starts, its own kill held like the first's,
    // and t.after's own close() (a second, unguarded pool.killAll()) would hang on it forever without this.
    if (workers[1]) workers[1].releaseKill();
  }
});

const CONTINUE_STAGES: LegacyStage[] = [
  { name: 'plan', from: { board: ['Ready'] }, onFinish: { board: [move('In progress')] }, prompt: '/hive-plan {url}' },
  { name: 'dev', from: { board: ['In progress'] }, onStart: { board: [move('In progress')] }, onFinish: { board: [move('In review')] }, prompt: '/hive-build {url}', session: 'continue' },
];

test('POST /hooks/done is gone; done marks the worker, is idempotent and ignores an unknown worker; a Stop without done answers an empty 204 and leaves the worker waiting with the session alive', async (t) => {
  const { base, server, workers } = await start(t, { ...BODY, stages: CONTINUE_STAGES });
  const ptyId = worker0(server).runId!;
  const idle = await hookEvent(base, ptyId, { hook_event_name: 'Stop' });
  assert.equal(idle.status, 204);
  assert.equal(await idle.text(), '', 'no decision: Claude Code sees an empty stdout');
  assert.equal(worker0(server).status, 'waiting');
  assert.deepEqual(worker0(server).lastEvent, { kind: 'turn' });
  assert.equal(task0(server).stage, 'plan');
  assert.equal(workers[0].killed, 0);
  const gone = await hiveFetch(`${base}/hooks/done`, { method: 'POST', headers: { 'x-hive-pty': ptyId } });
  assert.equal(gone.status, 404, 'the worker calls the hive_done tool now (#99)');
  assert.equal(worker0(server).done, undefined);
  await markDone(server, 'ghost');
  assert.equal(worker0(server).done, undefined, 'unknown worker: ignored');
  await markDone(server, ptyId);
  await markDone(server, ptyId);
  assert.equal(worker0(server).done, true);
  assert.equal(worker0(server).status, 'waiting', 'done alone changes nothing else');
});

test('a Stop with done and a next continue stage answers 200 { decision: block, reason } with the next prompt alone (#167): same worker, no kill, no spawn, the task moves', async (t) => {
  const { log, lines } = fakeLog();
  const { base, home, server, workers } = await start(t, { ...BODY, stages: CONTINUE_STAGES }, log);
  const { id, runId: ptyId } = worker0(server);
  await markDone(server, ptyId!);
  const stop = await hookEvent(base, ptyId!, { hook_event_name: 'Stop' });
  assert.equal(stop.status, 200);
  const reason = '/hive-build https://github.com/acme/r/issues/1';
  assert.deepEqual(await json(stop), { decision: 'block', reason });
  assert.equal(workers.length, 1, 'no spawn');
  assert.equal(workers[0].killed, 0, 'no kill');
  const worker = worker0(server);
  assert.deepEqual([worker.id, worker.runId, worker.status, worker.done, worker.lastEvent], [id, ptyId, 'working', undefined, { kind: 'continuing' }]);
  assert.deepEqual([task0(server).stage, work0(server)?.workerId], ['dev', id]);
  assert.equal(await readFile(join(home, 'prompts', 'hive-1-from-ready.md'), 'utf8'), reason, 'the run prompt file follows the stage');
  assert.ok(lines.includes('INFO setColumn #board:I1 → In progress ok'), lines.join('\n'));
  assert.ok(lines.includes(`INFO continue stage=dev pty=${ptyId!.slice(0, 8)}`), lines.join('\n'));
  const next = await hookEvent(base, ptyId!, { hook_event_name: 'Stop' });
  assert.equal(next.status, 204, 'the reply was taken once; the next Stop needs a new done');
  assert.equal(worker0(server).status, 'waiting');
});

test('a stage prompt with {result.spec} receives what the previous stage passed with its done (#99)', async (t) => {
  const stages: LegacyStage[] = [CONTINUE_STAGES[0], { ...CONTINUE_STAGES[1], prompt: '/hive-build {result.spec}' }];
  const { base, server } = await start(t, { ...BODY, stages });
  const ptyId = worker0(server).runId!;
  await server.dispatch({ type: 'done', ptyId, result: { spec: 'docs/superpowers/specs/x-design.md' } });
  const stop = await hookEvent(base, ptyId, { hook_event_name: 'Stop' });
  assert.equal(stop.status, 200);
  const { reason } = await json<{ reason: string }>(stop);
  assert.equal(reason, '/hive-build docs/superpowers/specs/x-design.md', 'the rendered prompt alone: no protocol after it (#167)');
  assert.deepEqual(resultOf(server.getState()!, task0(server).item.itemId), { spec: 'docs/superpowers/specs/x-design.md' });
});

test('the deleteActivity effect runs git inside the batch: deleteActivityFailed puts git\'s words on the task and the bar and no poll retries; the start route accepts the delete activity stage with no worker and activityDeleted moves the task on', async (t) => {
  const { log, lines } = fakeLog();
  const message = "error: The branch 'worktree-hive-1-from-ready' is not fully merged.";
  const listings: string[][] = [];
  let refuse = true; // the listing itself is refused: the first git call, so the failure carries its stderr and nothing else runs
  const exec: Exec = async (file, args) => {
    listings.push([file, ...args]);
    if (refuse) throw Object.assign(new Error(`Command failed: git ${args.join(' ')}`), { stderr: `${message}\n` });
    return { stdout: '' }; // nothing listed, no branch on the task: nothing to remove, the delete activity is done
  };
  const stages: LegacyStage[] = [STAGES[0], { name: 'done', from: { board: ['In review'] }, onFinish: { board: [move('Done')] }, action: 'deleteActivity' }];
  const { home, repo } = await tempHive(t);
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, log, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await postJson(`${base}/settings`, { ...BODY, workspaces: workspacesAt(repo), stages })).status, 200); // boot polls: I1 in fila, nothing to delete
  assert.equal(listings.length, 0);
  // something to clean (#236): a task with nothing the scope covers just moves on. Not the rendered branch, so git's listing alone decides;
  // on disk, or the boot poll's gone-worktree check (still running in the background) drops it
  await mkdir(worktreePath(repo, 'hive-1-from-ready'), { recursive: true });
  await readyOn(server, 'board:I1', { path: worktreePath(repo, 'hive-1-from-ready'), branch: 'hive/elsewhere', base: null, local: false });
  const activity = shortId(work0(server)?.id); // #629: what the deletion's answers name
  const item = { itemId: 'board:I1', source: 'board', id: '1', title: 'from Ready', body: '', url: 'https://github.com/acme/r/issues/1' };
  await server.dispatch({ type: 'poll', source: 'board', items: [{ item, column: 'In review' }] }); // the human moved it: done column, no after, due at once
  assert.deepEqual(listings, [['git', '-C', repo, 'worktree', 'list', '--porcelain']], 'git runs against the repo; the path comes from the slug');
  assert.deepEqual([task0(server).stage, work0(server)?.error, server.getState()?.error], ['done', message, message]);
  assert.ok(lines.includes('INFO deleteActivity #1 slug=hive-1-from-ready'), lines.join('\n'));
  assert.ok(lines.includes(`DEBUG deleteActivityFailed activity=${activity}: ${message}`), lines.join('\n'));
  await server.dispatch({ type: 'poll', source: 'board', items: [{ item, column: 'In review' }] });
  assert.equal(listings.length, 1, 'errored: no retry on the next poll');
  refuse = false;
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true }, 'a delete activity stage: no worker needed, no "etapa sem prompt"');
  assert.equal(listings.length, 5, 'the delete activity ran before the answer: the listing and the stage-start ref\'s check and drop and the checkpoint refs\' listing (#812, #619)');
  assert.deepEqual(server.getState()?.tasks, [], 'done is the last stage: the task left the Hive');
  assert.equal(server.getState()?.error, undefined, 'the previous poll already cleared the bar (a poll always resets it, as after a spawn failure); a successful delete activity needs no further poll to do it');
  assert.ok(lines.includes(`DEBUG activityDeleted activity=${activity}`), lines.join('\n'));
  assert.ok(lines.includes('INFO setColumn #board:I1 → Done ok'), lines.join('\n'));
  assert.deepEqual(await json(postJson(`${base}/sources/refresh`)), { ok: true });
  assert.equal(server.getState()?.error, undefined);
  assert.ok(!lines.some((l) => l.startsWith('ERROR')), lines.filter((l) => l.startsWith('ERROR')).join('\n'));
});

test('a poll marks the worktree of a stopped task whose directory left the disk as gone (once) and keeps its path, leaves a running one alone (#208)', async (t) => {
  const { log, lines } = fakeLog();
  const worktree = await tempDir(t, 'wt-');
  const { base, server, workers } = await start(t, BODY, log); // I1 running
  await hookEvent(base, worker0(server).runId!, { hook_event_name: 'SessionStart', cwd: worktree });
  assert.equal(work0(server)?.worktree, worktree);
  await rm(worktree, { recursive: true });
  assert.deepEqual(await json(postJson(`${base}/sources/refresh`)), { ok: true });
  assert.deepEqual([work0(server)?.worktree, work0(server)?.worktreeGone], [worktree, undefined], 'running: the worker is inside it, whatever the disk says');
  await server.dispatch({ type: 'setSignal', signal: 'red' });
  workers[0].handlers.onExit();
  await waitFor(() => worker0(server).status === 'empty');
  assert.deepEqual(await json(postJson(`${base}/sources/refresh`)), { ok: true });
  assert.deepEqual([work0(server)?.worktree, work0(server)?.worktreeGone], [worktree, true], 'only marked: the Hive did not remove it');
  assert.ok(work0(server)?.sessionId, 'the session id stays');
  assert.ok(lines.includes('INFO task #1: worktree gone'), lines.join('\n'));
  assert.deepEqual(await json(postJson(`${base}/sources/refresh`)), { ok: true });
  assert.equal(lines.filter((l) => l === 'INFO task #1: worktree gone').length, 1, 'a marked task is not checked again');
});

test('POST /tasks/:id/move answers 404 for an unknown task or before, 409 for tasks in different stages, and moves otherwise: before a task, or to the end without before; nothing reaches the board', async (t) => {
  const stages: LegacyStage[] = [{ name: 'fila', from: { board: ['Ready'] }, prompt: 'x' }, { name: 'review', from: { board: ['In review'] } }];
  const { log, lines } = fakeLog();
  const { base, server } = await start(t, idle({ ...BODY, stages }), log); // no worker: the order is all that changes
  await server.dispatch({ type: 'poll', source: 'board', items: [item('1', 'Ready'), item('2', 'Ready'), item('3', 'In review'), item('4', 'Ready')] });
  assert.deepEqual(order(server), ['1', '2', '3', '4']);
  const unknown = await postJson(`${base}/tasks/nope/move`, { before: 'board:I1' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'tarefa desconhecida' });
  const unknownBefore = await postJson(`${base}/tasks/board:I1/move`, { before: 'nope' });
  assert.equal(unknownBefore.status, 404);
  assert.deepEqual(await unknownBefore.json(), { error: 'tarefa desconhecida' });
  const crossed = await postJson(`${base}/tasks/board:I1/move`, { before: 'board:I3' });
  assert.equal(crossed.status, 409);
  assert.deepEqual(await crossed.json(), { error: 'tarefas em etapas diferentes' });
  assert.deepEqual(order(server), ['1', '2', '3', '4']);
  assert.ok(!lines.some((l) => l.startsWith('DEBUG moveTask')), 'a refusal never reaches the reducer');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I4/move`, { before: 'board:I1' })), { ok: true });
  assert.deepEqual(order(server), ['4', '1', '2', '3']);
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I4/move`, { before: 7 })), { ok: true }, 'a before that is not a string is absent');
  assert.deepEqual(order(server), ['1', '2', '4', '3'], 'end of fila: right after 2; review untouched');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/move`)), { ok: true });
  assert.deepEqual(order(server), ['2', '4', '1', '3']);
  assert.ok(lines.includes('DEBUG moveTask #board:I1 before=end'), lines.filter((l) => l.includes('moveTask')).join('\n'));
  assert.deepEqual(server.getState()?.tasks.map((c) => c.pinned), [undefined, true, true, undefined], 'the route leaves the dragged tasks pinned; 3 was never touched (#123)');
  assert.ok(!lines.some((l) => l.includes('setColumn')), 'nothing is written to the board');
});

test('GET /tasks/:id/comments reads the source only when asked: 404 for an unknown task with no source call, the list otherwise, 502 with the source\'s message when it fails', async (t) => {
  const listed: TaskComment[] = [{ author: 'dennys-bd', createdAt: '2026-09-20T10:00:00Z', body: 'lgtm', url: 'https://github.com/acme/r/issues/1#issuecomment-1' }];
  const asked: string[] = [];
  let failure: string | undefined;
  const { factory } = fakeSourceFactory();
  const sourceFactory = (spec: SourceSpec): Source => ({
    ...factory(spec),
    comments: async (itemId) => {
      asked.push(itemId);
      if (failure) throw new Error(failure);
      return listed;
    },
  });
  const { base } = await start(t, BODY, undefined, {}, { sourceFactory });
  assert.deepEqual(asked, [], 'neither the settings save nor the poll reads comments');
  const missing = await hiveFetch(`${base}/tasks/nope/comments`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'tarefa desconhecida' });
  assert.deepEqual(await json(hiveFetch(`${base}/tasks/board:I1/comments`)), listed);
  failure = 'github api: HTTP 502';
  const failed = await hiveFetch(`${base}/tasks/board:I1/comments`);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'github api: HTTP 502' });
  assert.deepEqual(asked, ['I1', 'I1'], 'one board call per request, none for the unknown task; the adapter gets its own id (#180)');
});

test('GET /tasks/:id/comments answers null on a source without comments, so the panel hides the section', async (t) => {
  const { base } = await start(t); // fakeSourceFactory has no comments
  const res = await hiveFetch(`${base}/tasks/board:I1/comments`);
  assert.equal(res.status, 200);
  assert.equal(await res.json(), null);
});

test('POST /stages/:name/reset-order answers 404 for an unknown stage and puts that stage back in the order the source last listed; the Hive order survives polls and the state file', async (t) => {
  const { base, home, server } = await start(t, idle());
  await server.dispatch({ type: 'poll', source: 'board', items: [item('1', 'Ready'), item('2', 'Ready'), item('3', 'Ready')] });
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I3/move`, { before: 'board:I1' })), { ok: true });
  assert.deepEqual(order(server), ['3', '1', '2']);
  await server.dispatch({ type: 'poll', source: 'board', items: [item('2', 'Ready'), item('1', 'Ready'), item('3', 'Ready')] }); // the source reordered meanwhile
  assert.deepEqual(order(server), ['3', '2', '1'], 'the dragged task holds its worker; 1 and 2 follow the board (#123)');
  assert.deepEqual(server.getState()?.sourceOrder, ['board:I2', 'board:I1', 'board:I3']);
  const unknown = await postJson(`${base}/stages/nope/reset-order`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'etapa desconhecida' });
  assert.deepEqual(await json(postJson(`${base}/stages/fila/reset-order`)), { ok: true });
  assert.deepEqual(order(server), ['2', '1', '3']);
  assert.deepEqual(server.getState()?.tasks.map((c) => c.pinned), [undefined, undefined, undefined], 'the reset frees the whole stage (#123)');
  const saved = JSON.parse(await readFile(join(home, 'state.json'), 'utf8')) as State;
  assert.deepEqual([saved.tasks.map((c) => c.item.id), saved.sourceOrder], [['2', '1', '3'], ['board:I2', 'board:I1', 'board:I3']], 'order and board order survive a restart');
});

test('POST /stages/:name/close-missing closes the stage\'s stopped missing tasks behind the UI header and answers how many; a running one stays, unkilled; 404 unknown stage, 409 with nothing closable (#279)', async (t) => {
  const { base, server, workers } = await start(t); // one worker: I1 runs
  await server.dispatch({ type: 'poll', source: 'board', items: [item('1', 'Ready'), item('2', 'Ready'), item('3', 'Ready')] }); // 2 and 3 wait
  const nothing = await postJson(`${base}/stages/fila/close-missing`);
  assert.equal(nothing.status, 409);
  assert.deepEqual(await nothing.json(), { error: 'nenhuma tarefa dessa etapa saiu da source' });
  await server.dispatch({ type: 'poll', source: 'board', items: [] }); // the source no longer lists any of them
  const plain = await hiveFetch(`${base}/stages/fila/close-missing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(plain.status, 403);
  const unknown = await postJson(`${base}/stages/nope/close-missing`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'etapa desconhecida' });
  assert.deepEqual(await json(postJson(`${base}/stages/fila/close-missing`)), { closed: 2 });
  assert.deepEqual(order(server), ['1'], 'the running missing task stays with its own close / keep');
  assert.deepEqual([task0(server).missing, work0(server)?.workerId === undefined, workers[0].killed], [true, false, 0], 'nothing is killed in bulk');
  assert.equal((await postJson(`${base}/stages/fila/close-missing`)).status, 409, 'only a running one left');
});

test('POST /tasks/:id/close on a running missing task kills it and never touches git, whatever the body: the worktree stays (#182)', async (t) => {
  const git = fakeGit();
  const { base, server, workers } = await start(t, BODY, undefined, {}, { exec: git.exec });
  git.clear(); // the worker is up: its worktree was created through this same exec
  await server.dispatch({ type: 'poll', source: 'board', items: [] }); // the source no longer lists it
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/close`, { removeWorktree: true })), { ok: true });
  assert.equal(workers[0].killed, 1);
  assert.deepEqual(git.calls, [], 'removing the worktree is the details panel\'s own button');
  assert.deepEqual(server.getState()?.tasks, []);
});

test('the first spawn refreshes the base and creates the worktree through deps.exec before the worker starts, and the line lands in hive.log (#119)', async (t) => {
  const { log, lines } = fakeLog();
  const { home, repo } = await tempHive(t, 1);
  const { spawn, workers } = fakeSpawn();
  const calls: string[][] = [];
  const spawned: number[] = []; // how many workers had started when each git command ran
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    spawned.push(workers.length);
    return { stdout: '' }; // nothing resolves origin/main here: the start falls back to the local base
  };
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, log, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  assert.equal((await postJson(`http://127.0.0.1:${port}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  await waitFor(() => workers.length === 1);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)).at(0), ['git', '-C', repo], 'git runs against the repo, never inside the worktree');
  assert.deepEqual(calls.map((c) => c.slice(3)), [
    ['worktree', 'list', '--porcelain'],
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ['fetch', 'origin', '--end-of-options', 'main'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['status', '--porcelain', '--untracked-files=no'],
    ['rev-parse', '--verify', '--quiet', '--short', 'refs/remotes/origin/main'],
    ['rev-parse', '--verify', '--quiet', 'refs/heads/hive/1-from-ready'], // this exec resolves everything: the branch reads as one that already exists
    ['worktree', 'add', '--', join(repo, '.hive', 'worktrees', 'hive-1-from-ready'), 'hive/1-from-ready'],
    ['rev-parse', 'HEAD'], // the stage's starting commit (#283); this git prints none, so nothing is recorded
  ]);
  assert.deepEqual(spawned, [0, 0, 0, 0, 0, 0, 0, 0, 0], 'every command ran before the worker could exist');
  assert.ok(lines.includes('INFO base: origin/main unknown, starting from the local base'), lines.join('\n'));
  assert.equal(server.getState()?.error, undefined, 'never the bar: a base that cannot be refreshed still starts the worker');
});

test('a worktree git already lists on the task\'s branch is adopted: no fetch, no add, and the base is left alone (#119)', async (t) => {
  const { home, repo } = await tempHive(t, 1);
  const worktree = join(repo, '.hive', 'worktrees', 'hive-1-from-ready');
  await mkdir(worktree, { recursive: true });
  const listing = `worktree ${repo}\nHEAD 1111\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD 2222\nbranch refs/heads/hive/1-from-ready\n`;
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: args.includes('list') ? listing : '' };
  };
  const { spawn, workers } = fakeSpawn();
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: spawn, exec });
  const port = await server.listen(0);
  t.after(() => server.close());
  assert.equal((await postJson(`http://127.0.0.1:${port}/settings`, { ...BODY, workspaces: workspacesAt(repo) })).status, 200);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  await waitFor(() => workers.length === 1);
  assert.deepEqual(calls.map((c) => c.slice(3)), [['rev-parse', '--git-common-dir'], ['worktree', 'list', '--porcelain'], ['rev-parse', 'HEAD']], 'the run in progress is never rebased or recreated (the first git is the teardown marker\'s clearing, #654)');
  assert.equal(workers[0].launch.cwd, worktree);
});

test('GET /tasks/:id/bases lists the default, the other tasks that have a worktree, the local and the remote branches for a task with no worktree; one with a worktree answers hasWorktree; 404 unknown (#131)', async (t) => {
  const git = refsGit({ heads: ['main', 'hive/2-task-2', 'feature-x'], remotes: ['origin/HEAD', 'origin/main', 'origin/feature-y'] });
  const { base, repo, server } = await start(t, idle(), undefined, {}, { exec: git.exec }); // nothing spawns on its own
  await server.dispatch({ type: 'poll', source: 'board', items: [item('1', 'Ready'), item('2', 'Ready')] });
  await server.dispatch({ type: 'createActivity', taskId: 'board:I2' }); // #629: the other tasks are the other activities, task 2's with its worktree
  const main = `worktree ${repo}\nHEAD 1111\nbranch refs/heads/main\n`;
  const at = (slug: string, branch: string): string => `worktree ${worktreePath(repo, slug)}\nHEAD 2222\nbranch refs/heads/${branch}\n`;
  git.answers.listing = [main, at('hive-2-task-2', 'hive/2-task-2')].join('\n');
  assert.deepEqual(await json(hiveFetch(`${base}/tasks/board:I1/bases`)), {
    hasWorktree: false,
    defaultRef: 'origin/main',
    tasks: [{ ref: 'hive/2-task-2', id: '2', title: 'Task 2' }],
    local: ['feature-x'],
    remote: ['origin/feature-y'],
  });
  assert.equal(git.calls.some((c) => c[0] === 'fetch'), false, 'opening the popup never fetches');
  const own = slugFor(task0(server).item); // #629: with no activity yet, the slug its title gives (the poll above renamed it)
  await mkdir(worktreePath(repo, own), { recursive: true });
  git.answers.listing = [main, at(own, 'hive/1-task-1'), at('hive-2-task-2', 'hive/2-task-2')].join('\n');
  assert.deepEqual(await json(hiveFetch(`${base}/tasks/board:I1/bases`)), {
    hasWorktree: false, defaultRef: 'origin/main', tasks: [{ ref: 'hive/2-task-2', id: '2', title: 'Task 2' }], local: ['feature-x'], remote: ['origin/feature-y'],
    orphan: { worktree: true, branch: false },
  }, '#861: no activity owns it: an orphan, with the lists a discard picks its base from');
  await server.dispatch({ type: 'createActivity', taskId: 'board:I1' });
  assert.deepEqual(await json(hiveFetch(`${base}/tasks/board:I1/bases`)), { hasWorktree: true, defaultRef: 'origin/main', tasks: [], local: [], remote: [] }, 'its activity adopts it');
  const unknown = await hiveFetch(`${base}/tasks/nope/bases`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'tarefa desconhecida' });
});

test('POST /tasks/:id/start with a base: a name git lacks, one starting with - or the task\'s own branch is a 409 with the reason and starts nothing; a real one lands on the task and the worktree branches from it (#131)', async (t) => {
  const git = refsGit({ refs: ['refs/heads/feature-x'] }); // the own branch hive/1-from-ready is refused before git is asked
  const { base, server, workers } = await start(t, idle(), undefined, {}, { exec: git.exec });
  for (const [ref, reason] of [['nope', 'nope: no such branch'], ['--upload-pack=x', '--upload-pack=x: a base cannot start with "-"'], ['hive/1-from-ready', "hive/1-from-ready is the task's own branch"]]) {
    const refused = await postJson(`${base}/tasks/board:I1/start`, { base: ref, tellWorker: true });
    assert.equal(refused.status, 409, ref);
    assert.deepEqual(await refused.json(), { error: reason });
  }
  assert.equal(workers.length, 0, 'nothing was dispatched');
  assert.equal(work0(server)?.base, undefined);
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`, { base: 'feature-x' })), { ok: true });
  assert.deepEqual(work0(server)?.base, { ref: 'feature-x', tellWorker: false }, 'tellWorker absent is false');
  assert.equal(workers.length, 1, 'the spawn ran before the answer');
  assert.deepEqual(git.calls.find((c) => c[0] === 'worktree' && c[1] === 'add'), ['worktree', 'add', '-b', 'hive/1-from-ready', '--', workers[0].launch.cwd, 'feature-x']);
});

test('POST /tasks/:id/start with { base: null } drops the base the task had saved: the popup\'s default (#131)', async (t) => {
  const git = refsGit({ refs: ['refs/heads/feature-x'] });
  const { base, server, workers } = await start(t, idle(), undefined, {}, { exec: git.exec });
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`, { base: 'feature-x', tellWorker: true })), { ok: true });
  assert.deepEqual(work0(server)?.base, { ref: 'feature-x', tellWorker: true });
  await server.dispatch({ type: 'setSignal', signal: 'red' }); // nothing respawns once the worker exits (in flight: yellow would, #224)
  workers[0].handlers.onExit();
  await waitFor(() => work0(server)?.workerId === undefined);
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`, { base: null })), { ok: true });
  assert.equal(work0(server)?.base, undefined);
  assert.equal(workers.length, 2, 'the start went through');
});

test('tellWorker ends the stage prompt with the base line and nothing after it; without it the base shows only on the task and in the log (#131, #167)', async (t) => {
  const { log, lines } = fakeLog();
  const told = refsGit({ refs: ['refs/heads/feature-x'] });
  const { base, workers } = await start(t, idle(), log, {}, { exec: told.exec });
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`, { base: 'feature-x', tellWorker: true })), { ok: true });
  const line = '\n\nThis worktree branches from feature-x, not from the default base. Open the pull request against feature-x (stacked PR).';
  const prompt = await readFile(workers[0].launch.promptPath!, 'utf8');
  assert.ok(prompt.endsWith(line), prompt);
  assert.ok(lines.includes('INFO base: feature-x (b2c3d4e), chosen by hand'), lines.join('\n'));
  const quiet = refsGit({ refs: ['refs/heads/feature-x'] });
  const again = await start(t, idle(), undefined, {}, { exec: quiet.exec });
  assert.deepEqual(await json(postJson(`${again.base}/tasks/board:I1/start`, { base: 'feature-x' })), { ok: true });
  assert.equal((await readFile(again.workers[0].launch.promptPath!, 'utf8')).includes('stacked PR'), false);
  assert.deepEqual(work0(again.server)?.base, { ref: 'feature-x', tellWorker: false });
});

test('POST /activities/:id/delete refuses an unknown task (404), a running one and one that never ran (409 with the reason); none of them reaches git\'s remove (#182)', async (t) => {
  const refused = async ({ base, server }: { base: string; server: HiveServer }, id: string, status: number, error: string): Promise<void> => {
    const res = await postJson(`${base}${workPath(server, id)}/delete`);
    assert.equal(res.status, status, error);
    assert.deepEqual(await res.json(), { error });
  };
  const git = listedGit();
  const running = await start(t, BODY, undefined, {}, { exec: git.exec }); // I1 running
  await refused(running, 'nope', 404, 'atividade desconhecida'); // #629: no activity under that id
  await refused(running, 'board:I1', 409, 'tarefa já está executando');
  const never = await start(t, idle(), undefined, {}, { exec: git.exec }); // I1 never ran: no worktree
  await refused(never, 'board:I1', 404, 'atividade desconhecida'); // #629: a task that never ran has no activity to delete
  assert.equal(git.calls.some((c) => c.includes('remove')), false);
  assert.equal((await postJson(`${running.base}${workPath(running.server, 'board:I1')}/delete`)).status, 409, 'the new route answers');
  assert.equal((await postJson(`${running.base}/tasks/board:I1/remove-worktree`)).status, 404, 'the old one is gone'); // #573: the old route, on purpose
});

test('POST /activities/:id/delete without a literal force checks what git would refuse, then runs the delete activity stage\'s git (no --force, branch -d), with the task marked deleting: a start or a second removal meanwhile is a 409; then the task forgets its worktree, branch and session id, its session moves to the main repo (#208), and it stays in its stage (#182, #210)', async (t) => {
  const git = listedGit();
  const { base, repo, server, workers } = await ranOnce(t, { exec: git.exec }); // stopped; red: nothing respawns
  const worktree = worktreePath(repo, TASK_SLUG);
  await mkdir(worktree, { recursive: true });
  const session = work0(server)?.sessionId;
  git.clear();
  const release = git.hold();
  const removal = postJson(`${base}${workPath(server, 'board:I1')}/delete`, { force: 'yes' }); // only a literal true forces
  await waitFor(() => work0(server)?.deleting === true);
  for (const path of [`/tasks/board:I1/start`, `${workPath(server, 'board:I1')}/delete`]) {
    const res = await postJson(`${base}${path}`);
    assert.equal(res.status, 409, path);
    assert.deepEqual(await res.json(), { error: 'atividade sendo excluída' });
  }
  assert.equal(workers.length, 1, 'no worker started on a worktree being removed');
  release();
  assert.deepEqual(await json(removal), { removed: true });
  assert.deepEqual(git.calls, [
    ['worktree', 'list', '--porcelain'],
    ['rev-parse', '--verify', '--quiet', `refs/heads/${TASK_BRANCH}`],
    ['status', '--porcelain'], // run with -C <worktree>
    ['for-each-ref', '--format=%(upstream)', `refs/heads/${TASK_BRANCH}`],
    ['merge-base', '--is-ancestor', `refs/heads/${TASK_BRANCH}`, 'HEAD'],
    ['worktree', 'remove', '--', worktree],
    ['branch', '-d', '--', TASK_BRANCH],
    ['rev-parse', '--verify', '--quiet', `refs/hive/${TASK_SLUG}/stage-start`], ['update-ref', '-d', `refs/hive/${TASK_SLUG}/stage-start`], // #812: always
    ['for-each-ref', '--format=%(refname)', `refs/hive/${TASK_SLUG}/checkpoint/`], // #619
  ]);
  const task = task0(server);
  const { id: _id, stoppedAt, ...held } = work0(server)!; // a fresh empty activity holds the stopped mark, so the fill leaves the task (#629)
  assert.equal(typeof stoppedAt, 'string', 'the stop\'s time goes with its mark (#580)');
  assert.deepEqual([sessions0(server).map((s) => [s.id, s.repo]), held, task.stage], [[[session, true]], { kind: 'task', workspace: 'hive', slug: TASK_SLUG, stopped: true }, 'fila'], 'the activity goes with its worktree, branch, session id and mark (#629)');
});

test('POST /activities/:id/delete with a terminal open kills its pty and drops it from the terminals before git runs, then removes the worktree and the branch (#573)', async (t) => {
  const git = listedGit();
  const { base, repo, server, workers } = await ranOnce(t, { exec: git.exec }); // stopped with its worktree; red: nothing respawns
  const worktree = worktreePath(repo, TASK_SLUG);
  await mkdir(worktree, { recursive: true });
  await server.dispatch({ type: 'openTerminal', activityId: workId(server.getState()!, 'board:I1') });
  const [opened] = server.getState()!.terminals;
  await waitFor(() => workers.some((w) => w.launch.ptyId === opened.terminalId));
  const terminal = workers.find((w) => w.launch.ptyId === opened.terminalId)!;
  git.clear();
  const release = git.hold();
  const deletion = postJson(`${base}${workPath(server, 'board:I1')}/delete`);
  await waitFor(() => git.calls.length > 0); // git started, held on its first call
  assert.deepEqual([terminal.killed, server.getState()!.terminals], [1, []], 'the terminal was closed before git ran');
  release();
  assert.deepEqual(await json(deletion), { removed: true });
  assert.ok(git.calls.some((c) => c.join(' ') === `worktree remove -- ${worktree}`), 'the worktree went');
  assert.ok(git.calls.some((c) => c.join(' ') === `branch -d -- ${TASK_BRANCH}`), 'its branch went');
});

test('a refusal answers 200 { removed: false, refused } with the reason and removes nothing (the branch is not merged, so the worktree stays too); force: true then runs --force --force and branch -D, deletes the prompt file, and the task forgets its worktree and session id, its session moving to the main repo (#208) (#182, #210)', async (t) => {
  const git = listedGit('--is-ancestor'); // exit 1: the branch is not merged into HEAD
  const { base, home, repo, server } = await ranOnce(t, { exec: git.exec });
  const worktree = worktreePath(repo, TASK_SLUG);
  await mkdir(worktree, { recursive: true });
  const before = task0(server);
  const ran = work0(server)?.sessionId; // #629: the activity's
  git.clear();
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/delete`)), { removed: false, refused: `the branch '${TASK_BRANCH}' is not fully merged into HEAD` });
  assert.equal(git.calls.some((c) => c.includes('remove') || c[0] === 'branch'), false, 'all or nothing: the worktree and the branch both stay');
  assert.deepEqual(task0(server), before, 'nothing forgotten; the mark is gone');
  git.clear();
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/delete`, { force: true })), { removed: true });
  assert.deepEqual(git.calls, [
    ['worktree', 'list', '--porcelain'],
    ['worktree', 'remove', '--force', '--force', '--', worktree],
    ['worktree', 'prune'],
    ['branch', '-D', '--', TASK_BRANCH],
    ['rev-parse', '--verify', '--quiet', `refs/hive/${TASK_SLUG}/stage-start`], ['update-ref', '-d', `refs/hive/${TASK_SLUG}/stage-start`], // #812: always
    ['for-each-ref', '--format=%(refname)', `refs/hive/${TASK_SLUG}/checkpoint/`], // #619
  ], 'force skips the pre-check');
  await assert.rejects(readFile(join(home, 'prompts', `${TASK_SLUG}.md`)), { code: 'ENOENT' });
  assert.deepEqual([work0(server)?.sessionId, sessions0(server).map((s) => [s.id, s.repo]), work0(server)?.worktree, work0(server)?.deleting], [undefined, [[ran, true]], undefined, undefined]);
});

test('a forced removal git fails answers 500 with the message and unmarks the task, which keeps its fields (#182)', async (t) => {
  const git = listedGit('--force');
  const { base, repo, server } = await ranOnce(t, { exec: git.exec });
  const worktree = worktreePath(repo, TASK_SLUG);
  await mkdir(worktree, { recursive: true });
  const before = task0(server);
  const res = await postJson(`${base}${workPath(server, 'board:I1')}/delete`, { force: true });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: `Command failed: git worktree remove --force --force -- ${worktree}` });
  assert.deepEqual(task0(server), before, 'nothing was confirmed gone');
});

test('in a delete activity stage the delete-activity route finishes the stage\'s job: a refusal leaves the cleanupFailed task in place with its error; a forced removal advances it to the next stage with onFinish written, the error gone and the session kept (#210)', async (t) => {
  const git = listedGit('--is-ancestor'); // exit 1: the branch is not merged into HEAD, for the stage's delete activity and the button alike
  const stages: LegacyStage[] = [STAGES[0], { name: 'done', from: { board: ['In review'] }, onFinish: { board: [move('Done')] }, action: 'deleteActivity' }, { name: 'archive', from: { board: ['Done'] } }];
  const { base, repo, server } = await start(t, { ...BODY, stages }, undefined, {}, { exec: git.exec }); // I1 runs in fila
  await mkdir(worktreePath(repo, TASK_SLUG), { recursive: true });
  const { runId: ptyId } = worker0(server);
  await hookEvent(base, ptyId!, { hook_event_name: 'SessionStart', cwd: repo });
  await markDone(server, ptyId!);
  await hookEvent(base, ptyId!, { hook_event_name: 'Stop' }); // fila ends into done, which has no after: its delete activity runs in this very dispatch and git refuses (#284)
  const item = { itemId: 'board:I1', source: 'board', id: '1', title: 'from Ready', body: '', url: 'https://github.com/acme/r/issues/1' };
  await server.dispatch({ type: 'poll', source: 'board', items: [{ item, column: 'In review' }] }); // errored: the poll does not retry
  const refusal = `the branch '${TASK_BRANCH}' is not fully merged into HEAD`;
  const failed = task0(server);
  assert.deepEqual([failed.stage, work0(server)?.error, work0(server)?.worktree], ['done', refusal, repo], 'a cleanupFailed task');
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/delete`)), { removed: false, refused: refusal });
  assert.deepEqual(task0(server), failed, 'refused: it stays in done with its error');
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/delete`, { force: true })), { removed: true });
  const moved = task0(server);
  // #629: its activity went, its error and session id with it; a fresh one carries the in-flight mark, as main's forget kept it on the task
  assert.deepEqual([moved.stage, moved.boardColumn, work0(server)?.error, work0(server)?.sessionId, work0(server) !== undefined], ['archive', 'Done', undefined, undefined, true]);
});

// CLAUDE_CONFIG_DIR for one test (#236): where removeTranscripts looks; the suite runs one file per process, and the value is put back after.
function claudeConfigDir(t: TestContext, dir: string): void {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
}

test('POST /activities/:id/delete follows the delete-activity scope (#236, #573): the branch always goes, sessions on drops them from the task, transcripts on deletes the task\'s transcripts in Claude Code\'s directory for the worktree and nothing else', async (t) => {
  claudeConfigDir(t, await tempDir(t, 'claude-'));
  const git = listedGit();
  const scope = { session: true, transcripts: true, nonAutoTasks: false };
  const { base, repo, server, workers } = await start(t, { ...BODY, deleteActivity: scope }, undefined, {}, { exec: git.exec });
  await hookEvent(base, worker0(server).runId!, { hook_event_name: 'SessionStart', cwd: repo });
  await server.dispatch({ type: 'setSignal', signal: 'red' }); // nothing respawns once the worker exits (in flight: yellow would, #224)
  workers[0].handlers.onExit();
  await waitFor(() => worker0(server).status === 'empty');
  const worktree = worktreePath(repo, TASK_SLUG);
  await mkdir(worktree, { recursive: true });
  const session = work0(server)!.sessionId!;
  const dir = transcriptDir(worktree);
  await mkdir(join(dir, session), { recursive: true });
  for (const file of [`${session}.jsonl`, 'other-session-0001.jsonl']) await writeFile(join(dir, file), '{}\n');
  git.clear();
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/delete`)), { removed: true });
  assert.deepEqual(git.calls, [
    ['worktree', 'list', '--porcelain'],
    ['rev-parse', '--verify', '--quiet', `refs/heads/${TASK_BRANCH}`],
    ['status', '--porcelain'],
    ['for-each-ref', '--format=%(upstream)', `refs/heads/${TASK_BRANCH}`],
    ['merge-base', '--is-ancestor', `refs/heads/${TASK_BRANCH}`, 'HEAD'],
    ['worktree', 'remove', '--', worktree],
    ['branch', '-d', '--', TASK_BRANCH],
    ['rev-parse', '--verify', '--quiet', `refs/hive/${TASK_SLUG}/stage-start`], ['update-ref', '-d', `refs/hive/${TASK_SLUG}/stage-start`], // #812: always
    ['for-each-ref', '--format=%(refname)', `refs/hive/${TASK_SLUG}/checkpoint/`], // #619
  ], 'the worktree and the branch always go (#573)');
  assert.deepEqual(await readdir(dir), ['other-session-0001.jsonl'], 'only the task\'s session goes');
  const task = task0(server);
  const { id: _id, stoppedAt, ...held } = work0(server)!; // a fresh empty activity holds the stopped mark, so the fill leaves the task (#629)
  assert.equal(typeof stoppedAt, 'string', 'the stop\'s time goes with its mark (#580)');
  assert.deepEqual([held, sessions0(server), task.stage], [{ kind: 'task', workspace: 'hive', slug: TASK_SLUG, stopped: true }, [], 'fila'], 'its activity went, its session id with it (#629)');
});

test('with transcripts in scope a delete removes every record\'s transcripts, a deleted activity\'s kept session in the main repo too, as main walked every session of the task (#629)', async (t) => {
  claudeConfigDir(t, await tempDir(t, 'claude-'));
  const git = listedGit();
  const { base, repo, server, workers } = await start(t, BODY, undefined, {}, { exec: git.exec }); // sessions kept on the first delete
  await server.dispatch({ type: 'setSignal', signal: 'red' });
  await hookEvent(base, worker0(server).runId!, { hook_event_name: 'SessionStart', cwd: repo });
  workers[0].handlers.onExit();
  await waitFor(() => worker0(server).status === 'empty');
  const worktree = worktreePath(repo, TASK_SLUG);
  await mkdir(worktree, { recursive: true });
  const kept = work0(server)!.sessionId!;
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/delete`)), { removed: true });
  await mkdir(transcriptDir(repo), { recursive: true });
  await writeFile(join(transcriptDir(repo), `${kept}.jsonl`), '{}\n'); // a repo session's transcript sits in the main repo's dir (#208)
  await server.dispatch({ type: 'setDeleteActivity', deleteActivity: { session: true, transcripts: true, nonAutoTasks: false } });
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  await hookEvent(base, worker0(server).runId!, { hook_event_name: 'SessionStart', cwd: repo });
  workers[1].handlers.onExit();
  await waitFor(() => worker0(server).status === 'empty');
  await mkdir(worktree, { recursive: true });
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/delete`)), { removed: true });
  assert.deepEqual(await readdir(transcriptDir(repo)), [], 'the kept session\'s transcript goes too');
  assert.deepEqual(sessions0(server), [], 'every record\'s sessions go');
});

test('POST /activities/:id/continue takes a deleted activity\'s record id: its kept session resumes in the task\'s live activity (#629)', async (t) => {
  const git = listedGit();
  const { base, repo, server, workers } = await start(t, { ...BODY, stages: [{ ...STAGES[0], session: 'continue' }, ...STAGES.slice(1)] }, undefined, {}, { exec: git.exec });
  await server.dispatch({ type: 'setSignal', signal: 'red' });
  await hookEvent(base, worker0(server).runId!, { hook_event_name: 'SessionStart', cwd: repo });
  workers[0].handlers.onExit();
  await waitFor(() => worker0(server).status === 'empty');
  await mkdir(worktreePath(repo, TASK_SLUG), { recursive: true });
  const old = work0(server)!;
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/delete`)), { removed: true });
  assert.deepEqual(await json(postJson(`${base}/activities/${encodeURIComponent(old.id)}/continue`)), { ok: true });
  assert.deepEqual([worker0(server).status, work0(server)?.sessionId === old.sessionId, work0(server)?.id === old.id], ['working', true, false]);
});

test('the deleteActivity effect removes the worktree and the branch whatever the scope, and the sessions with them on (#236, #573); a transcript that cannot be deleted is logged and the task still moves on; it runs on the Stop that enters the stage, with no poll (#284)', async (t) => {
  const blocker = join(await tempDir(t, 'claude-'), 'a-file');
  await writeFile(blocker, ''); // CLAUDE_CONFIG_DIR names a file: every delete under it fails with ENOTDIR
  claudeConfigDir(t, blocker);
  const { log, lines } = fakeLog();
  const git = listedGit(); // lists the task's worktree on its branch, so the branch is known and goes
  const stages: LegacyStage[] = [STAGES[0], { name: 'done', from: { board: ['In review'] }, action: 'deleteActivity' }, { name: 'archive', from: { board: ['Done'] } }];
  const scope = { session: true, transcripts: true, nonAutoTasks: false };
  const { base, repo, server } = await start(t, { ...BODY, stages, deleteActivity: scope }, log, {}, { exec: git.exec }); // I1 runs in fila
  const { runId: ptyId } = worker0(server);
  await hookEvent(base, ptyId!, { hook_event_name: 'SessionStart', cwd: repo });
  await markDone(server, ptyId!);
  git.clear();
  await hookEvent(base, ptyId!, { hook_event_name: 'Stop' }); // fila ends into done, which has no after: its delete activity runs inside the Stop's own dispatch (#284)
  assert.ok(git.calls.some((c) => c.includes('branch') && c.includes('-d')), 'the branch always goes (#573)');
  const moved = task0(server);
  // #629: its activity went, its session id with it; a fresh one carries the in-flight mark, as main's forget kept it on the task
  assert.deepEqual([moved.stage, work0(server)?.sessionId, work0(server) !== undefined, sessions0(server)], ['archive', undefined, true, []], 'moved on with no poll');
  assert.ok(lines.some((l) => l.startsWith('ERROR transcripts #1: ')), lines.join('\n'));
});

test('GET /worktrees lists what git lists under .hive/worktrees with the owning task; the main checkout and a worktree elsewhere are not listed; a worktree no task owns is noTask; a git failure is a 500 with git\'s words (#181)', async (t) => {
  const git = listedGit();
  const { base, repo, server } = await ranOnce(t, { exec: git.exec }); // I1 stopped with its worktree
  const activityId = workId(server.getState()!, 'board:I1'); // #629: the route its removal posts to
  assert.deepEqual(await json(hiveFetch(`${base}/worktrees`)), [
    { workspace: 'hive', slug: TASK_SLUG, path: worktreePath(repo, TASK_SLUG), branch: TASK_BRANCH, task: { id: 'board:I1', activityId, title: '#1 from Ready', removable: true }, nested: [] },
    { workspace: 'hive', slug: ORPHAN_SLUG, path: worktreePath(repo, ORPHAN_SLUG), branch: ORPHAN_BRANCH, orphan: 'noTask', nested: [] },
  ]);
  const broken = await start(t, BODY, undefined, {}, { exec: listedGit('list', 'fatal: not a git repository').exec });
  const res = await hiveFetch(`${broken.base}/worktrees`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'fatal: not a git repository' });
});

test('POST /worktrees/:workspace/:slug/remove answers 404 for a slug git does not list under .hive/worktrees and 409 for one a task owns, and removes nothing (#181)', async (t) => {
  const git = listedGit();
  const { base } = await ranOnce(t, { exec: git.exec });
  git.clear();
  const refused: [string, number, string][] = [
    ['hive-7-nope', 404, 'worktree desconhecida'],
    ['wt', 404, 'worktree desconhecida'], // git lists /elsewhere/wt, but not under .hive/worktrees
    [TASK_SLUG, 409, "use the task's remove"],
  ];
  for (const [slug, status, error] of refused) {
    const res = await postJson(`${base}/worktrees/hive/${slug}/remove`, { force: true });
    assert.equal(res.status, status, slug);
    assert.deepEqual(await res.json(), { error }, slug);
  }
  assert.deepEqual(git.calls, [['worktree', 'list', '--porcelain'], ['worktree', 'list', '--porcelain'], ['worktree', 'list', '--porcelain']], 'only the listing');
});

test('POST /worktrees/:slug/remove without a literal force runs the delete activity stage\'s git on the branch git lists there (no --force, branch -d), answers { removed: true } and logs worktreeRemoved <slug> (#181)', async (t) => {
  const git = listedGit();
  const { log, lines } = fakeLog();
  const { base, repo } = await start(t, BODY, log, {}, { exec: git.exec });
  const path = worktreePath(repo, ORPHAN_SLUG);
  await mkdir(path, { recursive: true });
  git.clear();
  assert.deepEqual(await json(postJson(`${base}/worktrees/hive/${ORPHAN_SLUG}/remove`, { force: 'yes' })), { removed: true }); // only a literal true forces
  assert.deepEqual(git.calls, [
    ['worktree', 'list', '--porcelain'], // the route's own check
    ['worktree', 'list', '--porcelain'], // cleanWorktree's
    ['rev-parse', '--verify', '--quiet', `refs/heads/${ORPHAN_BRANCH}`],
    ['status', '--porcelain'], // run with -C <worktree>
    ['for-each-ref', '--format=%(upstream)', `refs/heads/${ORPHAN_BRANCH}`],
    ['merge-base', '--is-ancestor', `refs/heads/${ORPHAN_BRANCH}`, 'HEAD'],
    ['worktree', 'remove', '--', path],
    ['branch', '-d', '--', ORPHAN_BRANCH],
  ]);
  assert.ok(lines.includes(`INFO worktreeRemoved ${ORPHAN_SLUG}`));
});

test('a refusal answers 200 { removed: false, refused } with the reason and removes nothing; force: true then runs --force --force and branch -D on git\'s branch; the log says worktreeKept, then worktreeRemoved (#181)', async (t) => {
  const git = listedGit('--is-ancestor'); // exit 1: the branch is not merged into HEAD
  const { log, lines } = fakeLog();
  const { base, repo } = await start(t, BODY, log, {}, { exec: git.exec });
  const path = worktreePath(repo, ORPHAN_SLUG);
  await mkdir(path, { recursive: true });
  git.clear();
  assert.deepEqual(await json(postJson(`${base}/worktrees/hive/${ORPHAN_SLUG}/remove`)), { removed: false, refused: `the branch '${ORPHAN_BRANCH}' is not fully merged into HEAD` });
  assert.equal(git.calls.some((c) => c.includes('remove') || c[0] === 'branch'), false, 'all or nothing: the worktree and the branch both stay');
  assert.ok(lines.includes(`INFO worktreeKept ${ORPHAN_SLUG}`));
  git.clear();
  assert.deepEqual(await json(postJson(`${base}/worktrees/hive/${ORPHAN_SLUG}/remove`, { force: true })), { removed: true });
  assert.deepEqual(git.calls, [
    ['worktree', 'list', '--porcelain'],
    ['worktree', 'list', '--porcelain'],
    ['worktree', 'remove', '--force', '--force', '--', path],
    ['worktree', 'prune'],
    ['branch', '-D', '--', ORPHAN_BRANCH],
  ], 'force skips the pre-check');
  assert.ok(lines.includes(`INFO worktreeRemoved ${ORPHAN_SLUG}`));
});

test('a second removal of the same slug while git runs on the first answers 409 and runs no git (#181)', async (t) => {
  const git = listedGit();
  const { base, repo } = await start(t, BODY, fakeLog().log, {}, { exec: git.exec });
  await mkdir(worktreePath(repo, ORPHAN_SLUG), { recursive: true });
  git.clear();
  const release = git.hold();
  const first = postJson(`${base}/worktrees/hive/${ORPHAN_SLUG}/remove`, { force: true });
  while (git.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
  const second = await postJson(`${base}/worktrees/hive/${ORPHAN_SLUG}/remove`, { force: true });
  assert.equal(second.status, 409);
  assert.equal(git.calls.length, 1, 'the second request ran no git');
  release();
  assert.deepEqual(await json(first), { removed: true });
});

test('a forced removal git fails answers 500 with the message and logs worktreeKept <slug> (#181)', async (t) => {
  const git = listedGit('--force');
  const { log, lines } = fakeLog();
  const { base, repo } = await start(t, BODY, log, {}, { exec: git.exec });
  const path = worktreePath(repo, ORPHAN_SLUG);
  await mkdir(path, { recursive: true });
  const res = await postJson(`${base}/worktrees/hive/${ORPHAN_SLUG}/remove`, { force: true });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: `Command failed: git worktree remove --force --force -- ${path}` });
  assert.ok(lines.includes(`INFO worktreeKept ${ORPHAN_SLUG}`));
});

test('POST /tasks creates a local task in a Comb stage: 201 with the id, the task in the stage, no source write; a 400 names what is wrong and creates nothing', async (t) => {
  const { log, lines } = fakeLog();
  const { base, server } = await start(t, idle(), log); // no worker: the task waits in fila
  const created = await postJson(`${base}/tasks`, { title: '  Write the README  ', body: 'by hand', stage: 'fila' });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { id: 'HIVE-1', itemId: 'local:1' });
  const task = server.getState()!.tasks.find((c) => c.created);
  assert.deepEqual([task?.item.itemId, task?.item.title, task?.item.body, task?.stage, task?.boardColumn], ['local:1', 'Write the README', 'by hand', 'fila', '']);
  assert.deepEqual(await json(postJson(`${base}/tasks`, { title: 'No body', stage: 'fila' })), { id: 'HIVE-2', itemId: 'local:2' });
  assert.equal(server.getState()!.tasks.find((c) => c.item.id === 'HIVE-2')?.item.body, '', 'body is optional');
  await postJson(`${base}/tasks`, { title: 'Mine', stage: 'fila', auto: false });
  assert.equal(server.getState()!.tasks.find((c) => c.item.id === 'HIVE-3')?.auto, false, 'auto false: the fill leaves it to its creator (redesign 03)');
  const refused = async (body: unknown, error: string): Promise<void> => {
    const res = await postJson(`${base}/tasks`, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(await res.json(), { error });
  };
  await refused({ title: '   ', stage: 'fila' }, 'título obrigatório');
  await refused({ stage: 'fila' }, 'título obrigatório');
  await refused({ title: 'x'.repeat(201), stage: 'fila' }, 'título passa de 200 caracteres');
  await refused({ title: 'ok', body: 7, stage: 'fila' }, 'descrição precisa ser texto de até 64 KB');
  await refused({ title: 'ok', body: 'x'.repeat(64 * 1024 + 1), stage: 'fila' }, 'descrição precisa ser texto de até 64 KB');
  await refused({ title: 'ok', stage: 'nope' }, 'etapa desconhecida');
  assert.equal(server.getState()!.localCount, 3, 'a refusal hands out no number');
  assert.ok(!lines.some((l) => l.includes('setColumn')), 'nothing is written to the board');
});

test('POST /tasks keeps the url and origin of a configured source\'s item; a second task with that origin answers 409 and creates nothing (#756)', async (t) => {
  const { base, server } = await start(t, idle());
  const body = { title: 'Fix login', stage: 'fila', auto: false, url: 'https://github.com/acme/r/issues/12', origin: 'board:PVTI_12' };
  assert.deepEqual(await json(postJson(`${base}/tasks`, body)), { id: 'HIVE-1', itemId: 'local:1' });
  const task = server.getState()!.tasks.find((c) => c.item.itemId === 'local:1');
  assert.deepEqual([task?.item.url, task?.item.origin, task?.auto], [body.url, 'board:PVTI_12', false]);
  const again = await postJson(`${base}/tasks`, body);
  assert.deepEqual([again.status, await again.json()], [409, { error: 'já existe uma tarefa criada desse item' }]);
  assert.equal(server.getState()!.localCount, 1, 'nothing created');
});

test('a local task has no source behind it: comments answer null without asking the source; close refuses it while it runs and removes it once stopped', async (t) => {
  const asked: string[] = [];
  const { factory } = fakeSourceFactory();
  const sourceFactory = (spec: SourceSpec): Source => ({ ...factory(spec), comments: async (itemId) => { asked.push(itemId); return []; } });
  const { base, server, workers } = await start(t, BODY, undefined, {}, { sourceFactory }); // I1 runs in the one worker
  assert.equal((await postJson(`${base}/tasks`, { title: 'Local', stage: 'fila' })).status, 201);
  const path = `${base}/tasks/${encodeURIComponent('local:1')}`;
  const comments = await hiveFetch(`${path}/comments`);
  assert.equal(comments.status, 200);
  assert.equal(await comments.json(), null);
  assert.deepEqual(asked, [], 'the board is never asked about a task it does not have');
  assert.deepEqual(await json(postJson(`${path}/start`)), { ok: true }); // over the cap: a draining worker (#116)
  const busy = await postJson(`${path}/close`);
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: 'tarefa já está executando' });
  workers[1].handlers.onExit();
  await waitFor(() => activityOf(server.getState()!, 'local:1')?.workerId === undefined); // #629: the activity's
  assert.deepEqual(await json(postJson(`${path}/close`)), { ok: true });
  assert.equal(server.getState()!.tasks.some((c) => c.created), false);
});

test('killStrays pkills every run by its worker id: a free session carries it too, in its --mcp-config path (#283)', async () => {
  const patterns: string[] = [];
  const exec: Exec = async (_file, args) => {
    patterns.push(args.at(-1)!);
    return { stdout: '' };
  };
  const state: State = {
    ...initialState(1),
    workers: [
      { id: 'A', status: 'working', runId: 'W1', activityId: activityIdOf('board:I1') },
      { id: 'B', status: 'working', runId: 'W2', activityId: activityIdOf('board:I1'), sessionId: 'a1b2c3d4-0000-4000-8000-000000000002', freeSession: true },
      { id: 'C', status: 'empty' },
    ],
  };
  await killStrays(state, exec);
  assert.deepEqual(patterns, ['W1', 'W2']);
});

test('POST /tasks/:id/auto turns a task\'s auto off and on: 404 unknown, 400 without a boolean; a free worker under green leaves a task without auto alone, and a start runs it like any task; /auto is gone (#164, #283, #573)', async (t) => {
  const { base, server, workers } = await start(t, idle()); // no worker: I1 waits in fila
  assert.equal((await postJson(`${base}/tasks/nope/auto`, { auto: false })).status, 404);
  const bad = await postJson(`${base}/tasks/board:I1/auto`, { auto: 'yes' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'auto precisa ser true ou false' });
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/auto`, { auto: false })), { ok: true });
  assert.equal(task0(server).auto, false);
  assert.equal((await postJson(`${base}/config`, { maxConcurrent: 1 })).status, 200); // a free worker under green
  assert.equal(workers.length, 0, 'nothing takes a task without auto');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  assert.equal(workers.length, 1, 'but a start runs it');
  assert.equal((await postJson(`${base}/tasks/board:I1/manual`, { manual: true })).status, 404); // #573: the old route, on purpose
});

test('POST /tasks/:id/open on any task with no worktree creates it first on the chosen base, with no worker of its own, then opens the claude session in it: 404 unknown, 409 a base git lacks (and nothing is created); POST /tasks/:id/worktree is gone (#164, #237, #283)', async (t) => {
  const git = refsGit({ refs: ['refs/heads/feature-x'] });
  const { base, repo, server, workers } = await start(t, idle(), undefined, {}, { exec: git.exec });
  const added = (): string[][] => git.calls.filter((c) => c[0] === 'worktree' && c[1] === 'add');
  assert.equal((await postJson(`${base}/tasks/nope/open`, { kind: 'claude' })).status, 404);
  const unknown = await postJson(`${base}/tasks/board:I1/open`, { kind: 'claude', base: 'nope' });
  assert.equal(unknown.status, 409);
  assert.deepEqual(await unknown.json(), { error: 'nope: no such branch' });
  assert.deepEqual([work0(server)?.worktree, added(), workers.length], [undefined, [], 0], 'a refused base creates nothing and opens nothing');
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude', base: 'feature-x' })); // not manual: any task opens a session
  const path = worktreePath(repo, 'hive-1-from-ready');
  assert.deepEqual(added()[0], ['worktree', 'add', '-b', 'hive/1-from-ready', '--', path, 'feature-x']);
  assert.deepEqual([work0(server)?.worktree, work0(server)?.branch, work0(server)?.base], [path, 'hive/1-from-ready', { ref: 'feature-x', tellWorker: false }]);
  assert.equal(workers.length, 1, 'then the claude session, and nothing else');
  assert.equal(workers[0].launch.cwd, path);
  assert.equal((await postJson(`${base}/tasks/board:I1/worktree`, { base: null })).status, 404, 'the two-step route is gone');
});

test('POST /tasks/:id/open waits for the run to start before it answers (#249)', async (t) => {
  const { base, workers } = await start(t, idle(), undefined, { neverStarts: true });
  const answer = postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' }).catch(() => undefined); // close() drops it after the test
  const first = await Promise.race([answer.then(() => 'answered'), sleep(200).then(() => 'waiting')]);
  assert.equal(first, 'waiting');
  assert.equal(workers.length, 1);
});

test('POST /tasks/:id/open checks a resume before any git: one it cannot offer is 409 and creates no worktree; a new claude session on a task with no worktree gets one on the default base first (#237)', async (t) => {
  const git = refsGit();
  const { base, repo, server, workers } = await start(t, idle(), undefined, {}, { exec: git.exec });
  const held = await postJson(`${base}/tasks/board:I1/open`, { kind: 'claude', continueId: 'a1b2c3d4-0000-4000-8000-000000000009' });
  assert.equal(held.status, 409);
  assert.deepEqual(await held.json(), { error: 'sessão já aberta ou desconhecida' });
  assert.equal(git.calls.some((c) => c[0] === 'worktree' && c[1] === 'add'), false, 'a bad request never reaches git');
  assert.equal(work0(server)?.worktree, undefined);
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' }));
  assert.deepEqual([work0(server)?.worktree, work0(server)?.base], [worktreePath(repo, 'hive-1-from-ready'), undefined], 'worktreeReady with base null: no saved base');
  assert.equal(workers.length, 1);
});

test('POST /tasks/:id/open: a bad kind is 400 and creates nothing; terminal on a task with no worktree creates it on the default base, then opens the terminal through the pool and takes no worker; claude opens a free session in a session of its own (no prompt, no model, with the Hive\'s MCP), a second one is appended too, outside the cap, a held session is 409, the worker close kills it and the exit drops the worker for its resume (#164, #237, #459)', async (t) => {
  const { base, home, repo, server, workers } = await start(t, idle());
  const worktree = worktreePath(repo, 'hive-1-from-ready');
  await postJson(`${base}/tasks/board:I1/auto`, { auto: false });
  assert.equal((await postJson(`${base}/config`, { maxConcurrent: 1 })).status, 200); // one free worker; the manual task stays out of the fill
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'zsh' })).status, 400);
  assert.equal(work0(server)?.worktree, undefined, 'a bad kind creates nothing');
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' }));
  assert.equal(work0(server)?.worktree, worktree, 'the terminal needs the worktree too: created first');
  assert.deepEqual([workers.length, workers[0].launch.terminal, server.getState()!.terminals.length], [1, true, 1], 'the terminal runs through the pool');
  assert.equal(launchFlag(workers[0].launch, '--append-system-prompt-file'), undefined, 'a terminal runs no agent: no protocol (#167)');
  assert.equal(server.getState()!.workers.filter((s) => s.status !== 'empty').length, 0, 'a terminal holds no worker');
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' }));
  const first = server.getState()!.workers.find((s) => s.freeSession)!;
  assert.deepEqual([first.freeSession, taskOfWorker(server.getState()!, first)?.item.itemId, first.draining, worker0(server).status], [true, 'board:I1', undefined, 'empty'], 'appended: the free worker stays the fill\'s (#459)');
  assert.equal(workers.length, 2, 'the spawn ran before the answer');
  const { launch } = workers[1];
  assert.deepEqual([launch.slug, launch.cwd, launch.promptPath, plainArgs(launch), launchFlag(launch, '--mcp-config')],
    ['hive-1-from-ready', worktree, undefined, ['--session-id', first.sessionId], join(home, 'prompts', `${first.runId}.mcp.json`)]);
  assert.equal(launchFlag(launch, '--append-system-prompt-file'), join(home, PROTOCOL_DIR, 'workspaces', WORKSPACE, 'session.md'), 'a free session on a task is told the session protocol (#167)');
  assert.equal(work0(server)?.workerId, undefined, 'task.workerId stays the automatic worker\'s');
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' }));
  const live = server.getState()!.workers;
  assert.deepEqual([live.length, live[2].freeSession, live[2].draining, server.getState()!.maxConcurrent], [3, true, undefined, 1]);
  const held = await postJson(`${base}/tasks/board:I1/open`, { kind: 'claude', continueId: first.sessionId });
  assert.equal(held.status, 409);
  assert.deepEqual(await held.json(), { error: 'sessão já aberta ou desconhecida' });
  assert.deepEqual(await json(postJson(`${base}/ptys/${live[2].runId}/stop`, {})), { ok: true });
  assert.deepEqual(workers.map((w) => w.killed), [0, 0, 1], 'the task\'s close button kills that manual session only');
  workers[1].handlers.onExit();
  await waitFor(() => !server.getState()!.workers.some((s) => s.runId === first.runId));
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude', continueId: first.sessionId }));
  assert.deepEqual(plainArgs(workers[3].launch), ['--resume', first.sessionId]);
});

test('a resumed repo session runs in the workspace\'s main repo, not in the task\'s worktree path (#208)', async (t) => {
  const { repo, server, workers } = await ranOnce(t); // I1 stopped, red, not manual, its session listed
  const [session] = sessions0(server);
  await server.dispatch({ type: 'deletingActivity', activityId: workId(server.getState()!, 'board:I1') });
  await server.dispatch({ type: 'activityRemoved', activityId: workId(server.getState()!, 'board:I1') });
  assert.equal(sessions0(server)[0].repo, true);
  await server.dispatch({ type: 'openSession', activityId: workId(server.getState()!, 'board:I1'), continueId: session.id });
  assert.equal(workers.length, 2, 'the spawn ran inside the dispatch');
  assert.deepEqual([workers[1].launch.cwd, plainArgs(workers[1].launch)], [repo, ['--resume', session.id]]);
});

test('POST /activities/:id/sessions/:session/open opens a listed session in a manual worker on any task, a repo one in the main repo once its transcript moved there; refusals in order: unknown task, missing, deleting, not continuable, a worktree session with no worktree on disk, a repo session whose transcript is gone (#208)', async (t) => {
  claudeConfigDir(t, await tempDir(t, 'claude-'));
  const { base, repo, server, workers } = await ranOnce(t); // I1 stopped, red, not manual, its session listed
  // #629: under the record holding the session, as the panel addresses it: a deleted activity's record once it was removed
  const recordId = (id: string, session: string): string => recordWithSession(server.getState()!, id, session)?.id ?? workId(server.getState()!, id);
  const open = (id: string, session: string): Promise<Response> => postJson(`${base}/activities/${encodeURIComponent(recordId(id, session))}/sessions/${session}/open`);
  const refused = async (id: string, session: string, status: number, error: string): Promise<void> => {
    const res = await open(id, session);
    assert.equal(res.status, status, error);
    assert.deepEqual(await res.json(), { error });
  };
  const s = sessions0(server)[0].id;
  await refused('nope', s, 404, 'atividade desconhecida'); // #629: no record has that id
  await refused('board:I1', 'a1b2c3d4-0000-4000-8000-000000000009', 409, 'sessão já aberta ou desconhecida');
  await server.dispatch({ type: 'deletingActivity', activityId: workId(server.getState()!, 'board:I1') });
  await server.dispatch({ type: 'poll', source: 'board', items: [] }); // gone from the source while git runs
  await refused('board:I1', s, 409, 'tarefa sumiu da source: feche ou mantenha'); // missing before deleting
  // back on the source under a new title: the deleted activity's record keeps the slug its dir was named by (#629)
  await server.dispatch({ type: 'poll', source: 'board', items: [item('1', 'Ready')] });
  await refused('board:I1', s, 409, 'atividade sendo excluída');
  await server.dispatch({ type: 'activityKept', activityId: workId(server.getState()!, 'board:I1') });
  await server.dispatch({ type: 'worktreeGone', activityId: activityOf(server.getState()!, 'board:I1')!.id }); // #629: the activity's
  await refused('board:I1', s, 409, 'a worktree desta sessão não existe mais');
  await server.dispatch({ type: 'deletingActivity', activityId: workId(server.getState()!, 'board:I1') });
  await server.dispatch({ type: 'activityRemoved', activityId: workId(server.getState()!, 'board:I1') }); // the Hive removed it: the session moves to the main repo
  await refused('board:I1', s, 409, 'O histórico desta sessão não existe mais');
  const from = transcriptDir(worktreePath(repo, TASK_SLUG));
  await mkdir(join(from, s), { recursive: true });
  await writeFile(join(from, `${s}.jsonl`), '{}\n');
  await opened(open('board:I1', s));
  assert.deepEqual((await readdir(transcriptDir(repo))).sort(), [s, `${s}.jsonl`].sort(), 'moved before the session opened');
  assert.deepEqual(await readdir(from), []);
  assert.deepEqual([workers.length, workers[1].launch.cwd, plainArgs(workers[1].launch)], [2, repo, ['--resume', s]]);
  await refused('board:I1', s, 409, 'sessão já aberta ou desconhecida'); // its worker holds it now
});

test('a blocked task opens a terminal, a new claude session and a listed session by hand, and still refuses a start; openTask answers a leaving task with its own reason (#491)', async (t) => {
  const { base, server, workers } = await ranOnce(t); // I1 stopped, red, its session listed and its worktree recorded
  const [session] = sessions0(server);
  const listed = item('1', 'Ready');
  await server.dispatch({ type: 'poll', source: 'board', items: [{ ...listed, item: { ...listed.item, blockedBy: ['9'] } }] });
  assert.deepEqual(task0(server).item.blockedBy, ['9']);
  const start = await postJson(`${base}/tasks/board:I1/start`);
  assert.equal(start.status, 409);
  assert.deepEqual(await start.json(), { error: 'task bloqueado por 9' }, 'a blocker still holds the stage run');
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' }));
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' }));
  await opened(postJson(`${base}${workPath(server, 'board:I1')}/sessions/${session.id}/open`));
  assert.equal(workers.length, 4, 'the stage run, then the terminal, the new session and the resumed one');
  assert.deepEqual(plainArgs(workers[3].launch), ['--resume', session.id]);
  const state = server.getState()!;
  const leaving: State = { ...state, tasks: state.tasks.map((c) => ({ ...c, leaving: true as const })) };
  assert.deepEqual(openTask(leaving, 'board:I1'), { status: 409, message: 'tarefa saindo da source' });
});

test('POST /tasks/:id/open on a manual task whose worktree is gone from disk refuses to resume a session there, and a new session creates the worktree again first (#208)', async (t) => {
  const git = refsGit();
  const { base, repo, server, workers } = await start(t, idle(), undefined, {}, { exec: git.exec });
  const path = worktreePath(repo, TASK_SLUG);
  await postJson(`${base}/tasks/board:I1/auto`, { auto: false });
  await readyOn(server, 'board:I1', { path, branch: TASK_BRANCH, base: null, local: false });
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' }));
  const [old] = sessions0(server);
  workers[0].handlers.onExit();
  await waitFor(() => server.getState()!.workers.length === 0); // the session's worker is appended and leaves whole on its exit (#459)
  await server.dispatch({ type: 'worktreeGone', activityId: activityOf(server.getState()!, 'board:I1')!.id }); // #629: the activity's
  const held = await postJson(`${base}/tasks/board:I1/open`, { kind: 'claude', continueId: old.id });
  assert.equal(held.status, 409);
  assert.deepEqual(await held.json(), { error: 'sessão já aberta ou desconhecida' });
  git.calls.length = 0;
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' }));
  assert.ok(git.calls.some((c) => c[0] === 'worktree' && c[1] === 'add'), 'the worktree is created again');
  assert.deepEqual([work0(server)?.worktree, 'worktreeGone' in (work0(server) ?? {})], [path, false]);
  assert.equal(workers[1].launch.cwd, path);
});

test('POST /tasks/:id/move-to moves a task with auto off to another Hive stage and writes that stage\'s first from on the source, with a Claude session open on it or not: 404 unknown task, 400 unknown stage, 409 for the same stage (#164, #366, #573)', async (t) => {
  const { log, lines } = fakeLog();
  const stages: LegacyStage[] = [STAGES[0], { name: 'review', from: { board: ['In review'] } }];
  const { base, repo, server, workers } = await start(t, idle({ ...BODY, stages }), log);
  const refused = async (body: unknown, status: number, error: string, id = 'board:I1'): Promise<void> => {
    const res = await postJson(`${base}/tasks/${id}/move-to`, body);
    assert.equal(res.status, status, error);
    assert.deepEqual(await res.json(), { error });
  };
  await refused({ stage: 'review' }, 404, 'tarefa desconhecida', 'nope');
  await refused({ stage: 'nope' }, 400, 'etapa desconhecida');
  await postJson(`${base}/tasks/board:I1/auto`, { auto: false });
  await refused({ stage: 'fila' }, 409, 'tarefa já está nessa etapa');
  await readyOn(server, 'board:I1', { path: worktreePath(repo, 'hive-1-from-ready'), branch: 'hive/1-from-ready', base: null, local: false });
  assert.equal((await postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' })).status, 200);
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/move-to`, { stage: 'review' })), { ok: true }); // the session is the user's own (#366)
  assert.deepEqual([task0(server).stage, task0(server).boardColumn, task0(server).auto], ['review', 'In review', false]);
  assert.ok(lines.includes('INFO setColumn #board:I1 → In review ok'), lines.join('\n'));
  assert.deepEqual([workers.length, server.getState()!.workers.filter((s) => s.freeSession).length], [1, 1], 'the session is still open');
});

test('POST /tasks/:id/move-to moves a task created in the Hive, with auto, writing nothing on the source, and places it with drop: 400 for a malformed drop, 404 for an unknown before, 409 for a before in another stage or while a stage run holds the task, auto on or off (#366, #708)', async (t) => {
  const { log, lines } = fakeLog();
  const stages: LegacyStage[] = [STAGES[0], { name: 'review', from: { board: ['In review'] } }];
  const { base, server } = await start(t, idle({ ...BODY, stages }), log);
  const refused = async (id: string, body: unknown, status: number, error: string): Promise<void> => {
    const res = await postJson(`${base}/tasks/${id}/move-to`, body);
    assert.equal(res.status, status, error);
    assert.deepEqual(await res.json(), { error });
  };
  assert.equal((await postJson(`${base}/tasks`, { title: 'First', stage: 'review' })).status, 201); // local:1
  assert.equal((await postJson(`${base}/tasks`, { title: 'Second', stage: 'fila' })).status, 201); // local:2, held back by maxConcurrent: 0
  for (const drop of ['x', null, [], { before: 1 }]) await refused('local:2', { stage: 'review', drop }, 400, 'drop precisa ser um objeto, com before em texto');
  await refused('local:2', { stage: 'review', drop: { before: 'nope' } }, 404, 'tarefa desconhecida');
  await refused('local:2', { stage: 'review', drop: { before: 'board:I1' } }, 409, 'tarefas em etapas diferentes'); // I1 sits in fila
  assert.deepEqual(await json(postJson(`${base}/tasks/local:2/move-to`, { stage: 'review', drop: { before: 'local:1' } })), { ok: true });
  const review = server.getState()!.tasks.filter((c) => c.stage === 'review').map((c) => [c.item.itemId, c.pinned]);
  assert.deepEqual(review, [['local:2', true], ['local:1', undefined]]);
  assert.equal(lines.some((l) => l.includes('INFO setColumn')), false, 'a local task has no board to write');
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true }); // over the cap (#116): a stage run
  await refused('board:I1', { stage: 'review' }, 409, 'tarefa já está executando');
});

test('POST /tasks/:id/move-to moves a source task with auto on and writes the target\'s first from on the source; auto stays on (#708)', async (t) => {
  const { log, lines } = fakeLog();
  const stages: LegacyStage[] = [STAGES[0], { name: 'review', from: { board: ['In review'] } }];
  const { base, server } = await start(t, idle({ ...BODY, stages }), log);
  assert.equal(task0(server).auto, true);
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/move-to`, { stage: 'review' })), { ok: true });
  assert.deepEqual([task0(server).stage, task0(server).boardColumn, task0(server).auto], ['review', 'In review', true]);
  assert.ok(lines.includes('INFO setColumn #board:I1 → In review ok'), lines.join('\n'));
});

test('POST /activities/:id/delete refuses while a manual Claude session runs in the worktree, and git never runs (#164)', async (t) => {
  const git = listedGit();
  const { base, repo, server, workers } = await start(t, idle(), undefined, {}, { exec: git.exec });
  await postJson(`${base}/tasks/board:I1/auto`, { auto: false });
  await readyOn(server, 'board:I1', { path: worktreePath(repo, 'hive-1-from-ready'), branch: 'hive/1-from-ready', base: null, local: false });
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude' }));
  assert.equal(workers.length, 1);
  const res = await postJson(`${base}${workPath(server, 'board:I1')}/delete`, { force: true });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'tarefa já está executando' });
  assert.equal(git.calls.some((c) => c.includes('remove')), false);
  assert.equal(work0(server)?.deleting, undefined, 'never marked');
});

test('a manual task whose worktree is being removed refuses open, terminal and claude, with atividade sendo excluída (#164, #182)', async (t) => {
  const { base, repo, server, workers } = await start(t, idle());
  await postJson(`${base}/tasks/board:I1/auto`, { auto: false });
  await readyOn(server, 'board:I1', { path: worktreePath(repo, 'hive-1-from-ready'), branch: 'hive/1-from-ready', base: null, local: false });
  await server.dispatch({ type: 'deletingActivity', activityId: workId(server.getState()!, 'board:I1') });
  for (const body of [{ kind: 'terminal' }, { kind: 'claude' }]) {
    const res = await postJson(`${base}/tasks/board:I1/open`, body);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: 'atividade sendo excluída' });
  }
  assert.equal(workers.length, 0);
});

test('removing a local task a manual Claude session holds is refused with tarefa já está executando; once the session exits it goes (#164)', async (t) => {
  const { base, repo, server, workers } = await start(t, idle());
  assert.equal((await postJson(`${base}/tasks`, { title: 'Local', stage: 'fila' })).status, 201);
  const path = `${base}/tasks/${encodeURIComponent('local:1')}`;
  assert.deepEqual(await json(postJson(`${path}/auto`, { auto: false })), { ok: true });
  const slug = slugFor(server.getState()!.tasks.find((c) => c.created)!.item); // #629: the slug its activity gets
  await readyOn(server, 'local:1', { path: worktreePath(repo, slug), branch: `hive/${slug}`, base: null, local: false });
  await opened(postJson(`${path}/open`, { kind: 'claude' }));
  const busy = await postJson(`${path}/close`);
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: 'tarefa já está executando' });
  workers[0].handlers.onExit();
  await waitFor(() => server.getState()!.workers.every((s) => s.status === 'empty'));
  assert.deepEqual(await json(postJson(`${path}/close`)), { ok: true });
  assert.equal(server.getState()!.tasks.some((c) => c.created), false);
});

test('POST /tasks/:id/close on a local task with a worktree removes the worktree and its branch first, then the task leaves; a git failure answers 409 with git\'s words and the task stays (#542)', async (t) => {
  const git = localGit('hive-hive-1-local', 'hive/HIVE-1-local');
  const { base, repo, server } = await start(t, idle(), undefined, {}, { exec: git.exec });
  assert.equal((await postJson(`${base}/tasks`, { title: 'Local', stage: 'fila' })).status, 201);
  const local = (): Activity | undefined => activityOf(server.getState()!, 'local:1'); // #629: the worktree and the mark are its activity's
  assert.equal(slugFor(server.getState()!.tasks.find((c) => c.created)!.item), 'hive-hive-1-local');
  const worktree = worktreePath(repo, 'hive-hive-1-local');
  await mkdir(worktree, { recursive: true });
  await readyOn(server, 'local:1', { path: worktree, branch: 'hive/HIVE-1-local', base: null, local: false });
  const path = `${base}/tasks/${encodeURIComponent('local:1')}/close`;

  git.refuse = 'remove';
  const refused = await postJson(path);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'fatal: boom' });
  assert.equal(local()?.deleting, undefined, 'the mark goes with the answer');
  assert.equal(local()?.worktree, worktree, 'nothing was confirmed gone: the task stays with its worktree');

  git.refuse = undefined;
  git.calls.length = 0;
  assert.deepEqual(await json(postJson(path)), { ok: true });
  assert.ok(git.calls.some((c) => c.join(' ') === `worktree remove -- ${worktree}`), 'the worktree went');
  assert.ok(git.calls.some((c) => c.join(' ') === 'branch -d -- hive/HIVE-1-local'), 'its branch went');
  assert.equal(local(), undefined, 'then the task left the Hive');
});

test('POST /tasks/:id/close removes a created task\'s worktree whatever the delete-activity scope; a terminal open on it is closed first, then git runs; a git failure leaves the task unmarked (#542, #573)', async (t) => {
  const git = localGit('hive-hive-1-local', 'hive/HIVE-1-local');
  const { base, repo, server, workers } = await start(t, idle(), undefined, {}, { exec: git.exec });
  assert.equal((await postJson(`${base}/tasks`, { title: 'Local', stage: 'fila' })).status, 201);
  const created = (): Task | undefined => server.getState()!.tasks.find((c) => c.created);
  const worktree = worktreePath(repo, 'hive-hive-1-local');
  await mkdir(worktree, { recursive: true });
  await readyOn(server, 'local:1', { path: worktree, branch: 'hive/HIVE-1-local', base: null, local: false });
  await server.dispatch({ type: 'setDeleteActivity', deleteActivity: { ...server.getState()!.deleteActivity, session: false } });
  const path = `${base}/tasks/${encodeURIComponent('local:1')}/close`;

  git.refuse = 'remove';
  assert.equal((await postJson(path)).status, 409);
  assert.equal(activityOf(server.getState()!, 'local:1')?.deleting, undefined, 'the mark went with the failure (#629: on the activity)');

  await server.dispatch({ type: 'openTerminal', activityId: workId(server.getState()!, 'local:1') });
  const [terminal] = server.getState()!.terminals;
  await waitFor(() => workers.some((w) => w.launch.ptyId === terminal.terminalId));
  git.refuse = undefined;
  git.calls.length = 0;
  assert.deepEqual(await json(postJson(path)), { ok: true });
  assert.equal(workers.find((w) => w.launch.ptyId === terminal.terminalId)?.killed, 1, 'the terminal was closed');
  assert.deepEqual(server.getState()!.terminals, []);
  assert.ok(git.calls.some((c) => c.join(' ') === `worktree remove -- ${worktree}`), 'the worktree went, whatever the scope');
  assert.equal(created(), undefined, 'then the task left the Hive');
});

test('POST /shutdown arms and disarms shutdown when done behind the UI header; anything but a boolean is a 400 (#233)', async (t) => {
  const { base, server } = await start(t); // one worker runs: arming does not shut down yet
  const plain = await hiveFetch(`${base}/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"armed":true}' });
  assert.equal(plain.status, 403);
  assert.equal(server.getState()?.shutdown, undefined);
  const bad = await postJson(`${base}/shutdown`, { armed: 'yes' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'armed must be true or false' });
  assert.equal((await postJson(`${base}/shutdown`, { armed: true })).status, 200);
  assert.ok(server.getState()?.shutdown?.armedAt);
  assert.equal((await postJson(`${base}/shutdown`, { armed: false })).status, 200);
  assert.equal(server.getState()?.shutdown, undefined);
});

test('POST /auto is gone with the Hive\'s auto: the route answers 404 and the state has no auto (#638, #727)', async (t) => {
  const { base, server } = await start(t);
  assert.equal((await postJson(`${base}/auto`, { auto: false })).status, 404);
  assert.equal('auto' in (server.getState() ?? {}), false);
});

test('the shutdown effect runs the platform\'s shutdown command through the injected exec once no worker is left, once; a refusal lands in the bar and re-arming retries (#233, #658)', async (t) => {
  const [file, args] = shutdownCommand(process.platform); // osascript on a macOS runner, systemctl poweroff on a Linux one
  const calls: string[][] = [];
  let refuse = false;
  const exec: Exec = async (called, argv) => {
    if (called === file) {
      calls.push(argv);
      if (refuse) throw new Error('Not authorized to shut down.');
    }
    return { stdout: '' };
  };
  const { base, server } = await start(t, idle(), undefined, {}, { exec }); // nothing runs
  assert.equal((await postJson(`${base}/shutdown`, { armed: true })).status, 200);
  assert.deepEqual(calls, [args]);
  assert.equal(server.getState()?.shutdown, undefined, 'disarmed with the effect: it fires once');
  refuse = true;
  assert.equal((await postJson(`${base}/shutdown`, { armed: true })).status, 200);
  assert.equal(calls.length, 2, 're-arming retries');
  assert.equal(server.getState()?.error, 'Shutdown failed: Not authorized to shut down.');
  assert.equal(server.getState()?.shutdown, undefined);
});

test('POST /keep-awake sets and clears keepAwake behind the UI header; while set the daemon holds one keep-awake process, released on off and on close; anything but a boolean is a 400 (#226)', async (t) => {
  const { spawn, children } = fakeKeepAwakeSpawn();
  const { base, server } = await start(t, BODY, undefined, {}, { keepAwakeSpawn: spawn });
  const plain = await hiveFetch(`${base}/keep-awake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":true}' });
  assert.equal(plain.status, 403);
  const bad = await postJson(`${base}/keep-awake`, { on: 'x' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'on must be a boolean' });
  assert.equal(server.getState()?.keepAwake, undefined);
  assert.equal(children.length, 0);

  assert.deepEqual(await json(postJson(`${base}/keep-awake`, { on: true })), { ok: true });
  assert.equal(server.getState()?.keepAwake, true);
  assert.deepEqual(children.map((c) => [c.file, c.args]), [keepAwakeCommand(process.platform, process.pid)]);
  await server.dispatch({ type: 'tick' });
  assert.equal(children.length, 1, 'another reduction spawns nothing more');

  assert.equal((await postJson(`${base}/keep-awake`, { on: false })).status, 200);
  assert.equal(server.getState()?.keepAwake, undefined);
  assert.equal(children[0].kills, 1);

  assert.equal((await postJson(`${base}/keep-awake`, { on: true })).status, 200);
  await server.close();
  assert.equal(children[1].kills, 1, 'close() releases it');
});

test('a keep-awake process that dies while wanted shows Keep awake failed in the bar and turns the flag off, so a new click retries (#226)', async (t) => {
  const { spawn, children } = fakeKeepAwakeSpawn();
  const [file] = keepAwakeCommand(process.platform, process.pid);
  const { base, server } = await start(t, BODY, undefined, {}, { keepAwakeSpawn: spawn });
  assert.equal((await postJson(`${base}/keep-awake`, { on: true })).status, 200);
  children[0].emit('exit', 1, null);
  await waitFor(() => server.getState()?.error === `Keep awake failed: ${file} exited (1)`);
  assert.equal(server.getState()?.keepAwake, undefined);
  assert.equal(children.length, 1, 'no respawn while the failure is reported');
  assert.equal((await postJson(`${base}/keep-awake`, { on: true })).status, 200);
  assert.equal(children.length, 2);
});

test('the shutdown releases keep awake before the shutdown command runs (#226)', async (t) => {
  const [shutdownFile] = shutdownCommand(process.platform);
  const { spawn, children } = fakeKeepAwakeSpawn();
  const killsAtShutdown: number[] = [];
  const exec: Exec = async (called) => {
    if (called === shutdownFile) killsAtShutdown.push(children[0]?.kills ?? -1);
    return { stdout: '' };
  };
  const { base, server } = await start(t, idle(), undefined, {}, { exec, keepAwakeSpawn: spawn }); // nothing runs: arming shuts down at once
  assert.equal((await postJson(`${base}/keep-awake`, { on: true })).status, 200);
  assert.equal((await postJson(`${base}/shutdown`, { armed: true })).status, 200);
  assert.deepEqual(killsAtShutdown, [1]);
  assert.equal(server.getState()?.keepAwake, undefined);
});

test('after every poll one gh query reads the state of every open PR (#207): a failure is logged and every PR keeps its state; the worker\'s status never moves (#663); no open PR, no call', async (t) => {
  const { log, lines } = fakeLog();
  const gh: string[][] = [];
  let answer = (): string => JSON.stringify({ data: { p0: { state: 'OPEN' } } });
  const exec: Exec = async (file, args) => {
    if (file !== 'gh') return { stdout: '' };
    gh.push(args);
    if (args.some((a) => a.includes('recent: commits'))) throw new Error('gh api graphql: activity down'); // #742: the activity query never costs a merge
    return { stdout: answer() };
  };
  const { server } = await start(t, BODY, log, {}, { exec });
  assert.deepEqual(gh, [], 'no PR yet: no call');
  await openPr(server, worker0(server).runId!);
  const pr = 'https://github.com/acme/r/pull/9';
  answer = () => { throw new Error('gh api graphql: HTTP 502'); };
  await server.poll();
  assert.ok(lines.includes('ERROR pr states: gh api graphql: HTTP 502'), lines.join('\n'));
  assert.deepEqual([prs0(server), worker0(server).status], [[{ url: pr, state: 'open' }], 'working'], 'the last known state stays');
  answer = () => JSON.stringify({ data: { p0: { state: 'MERGED' } } });
  await server.poll();
  const asked = gh as string[][]; // the deepEqual above narrowed it
  assert.ok(asked.some((args) => args.join(' ') === `api graphql -f query=${prStatesQuery([pr])}`), asked.map((a) => a.join(' ')).join('\n'));
  assert.ok(lines.includes('ERROR pr activity: gh api graphql: activity down'), 'the activity query failed on its own');
  assert.deepEqual([prs0(server), worker0(server).status], [[{ url: pr, state: 'merged' }], 'working']);
  const calls = gh.length;
  await server.poll();
  assert.equal(gh.length, calls, 'no open PR left: no call');
});

test('POST /crash/dismiss drops the crash report, behind the UI header (#283)', async (t) => {
  const { base, server } = await start(t);
  await server.dispatch({ type: 'boot' }); // as if the Hive had died with I1 running: no clean stop recorded
  assert.deepEqual(server.getState()?.crash?.tasks, ['board:I1']);
  assert.equal((await hiveFetch(`${base}/crash/dismiss`, { method: 'POST' })).status, 403);
  assert.deepEqual(await json(postJson(`${base}/crash/dismiss`)), { ok: true });
  assert.equal(server.getState()?.crash, undefined);
});

test('a terminal goes through the pool with no worker: its launch is the user\'s shell in the worktree; Stop sleeps it (#283, #696)', async (t) => {
  const { base, repo, server, workers } = await start(t, idle());
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' })); // the worktree first, on the default base
  const [terminal] = server.getState()!.terminals;
  const { launch } = workers[0];
  assert.deepEqual(
    [launch.terminal, launch.ptyId, launch.cwd, launchFlag(launch, '--mcp-config'), launch.promptPath],
    [true, terminal.terminalId, worktreePath(repo, TASK_SLUG), undefined, undefined],
  );
  assert.equal(server.getState()!.workers.filter((s) => s.status !== 'empty').length, 0, 'a terminal holds no worker');
  assert.deepEqual(await json(postJson(`${base}/ptys/${terminal.terminalId}/stop`)), { ok: true });
  assert.equal(workers[0].killed, 1);
  workers[0].handlers.onExit();
  assert.equal(server.getState()!.terminals[0]?.asleep, true, 'kept, with no pty (#696)');
});

test('killStrays pkills each worker\'s worker id and runs nothing for a terminal: a terminal lived in the old daemon\'s pty host and died with it (#283, #378)', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: '' };
  };
  const task: Task = { item: { itemId: 'board:I1', id: '1', title: 'T', body: '', url: '' }, stage: 'fila', boardColumn: 'Ready', auto: true };
  const workers: Worker[] = [{ id: 'A', status: 'working', runId: 'W1', activityId: activityIdOf('board:I1') }];
  const terminals = [{ terminalId: 'a1b2c3d4-0000-4000-8000-000000000002', activityId: activityIdOf('board:I1'), startedAt: '2026-09-25T10:00:00.000Z', cwd: '/repo' }];
  await killStrays({ ...initialState(1), tasks: [task], workers, terminals }, exec);
  assert.deepEqual(calls, [['pkill', '-f', '--', 'W1']]);
});

test('POST /activities/:id/continue resumes the stopped stage\'s latest session with the continue prompt alone (#167): 404 unknown or before the stage ran (no activity, #629), 409 while a stage run holds the task (#283)', async (t) => {
  const { base, home, server, workers } = await start(t, idle()); // nothing runs on its own
  assert.equal((await postJson(`${base}${workPath(server, 'nope')}/continue`)).status, 404);
  const never = await postJson(`${base}${workPath(server, 'board:I1')}/continue`);
  assert.equal(never.status, 404); // #629: a task that never ran has no activity to continue
  assert.deepEqual(await never.json(), { error: 'atividade desconhecida' });
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  const session = work0(server)!.sessionId!;
  const running = await postJson(`${base}${workPath(server, 'board:I1')}/continue`);
  assert.equal(running.status, 409);
  assert.deepEqual(await running.json(), { error: 'tarefa já está executando' });
  workers[0].handlers.onExit(); // no hive_done: stopped
  await waitFor(() => work0(server)?.stopped === true);
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/continue`)), { ok: true });
  assert.deepEqual(plainArgs(workers[1].launch), ['--resume', session]);
  assert.equal(launchFlag(workers[1].launch, '--append-system-prompt-file'), join(home, PROTOCOL_DIR, 'workspaces', WORKSPACE, 'stage.md'), 'Continue is a stage run: the stage protocol (#167)');
  assert.equal(await readFile(workers[1].launch.promptPath!, 'utf8'), CONTINUE_PROMPT);
});

test('POST /activities/:id/continue is 409 sessão já aberta while a free session holds the stage\'s session, and starts no second process: the UI focuses that run instead (#283)', async (t) => {
  const { base, server, workers } = await start(t, idle());
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`)), { ok: true });
  const session = work0(server)!.sessionId!;
  workers[0].handlers.onExit(); // no hive_done: stopped
  await waitFor(() => work0(server)?.stopped === true);
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'claude', continueId: session }));
  const held = await postJson(`${base}${workPath(server, 'board:I1')}/continue`);
  assert.equal(held.status, 409);
  assert.deepEqual(await held.json(), { error: 'sessão já aberta' });
  assert.equal(workers.length, 2, 'the stage run and the session: no third process');
});

test('a stage spawn records where it started; GET /activities/:id/restart previews the reset; POST resets and cleans the worktree before a new session; 409 while the stage run holds the task (#283)', async (t) => {
  const git = restartGit(HEAD_SHA);
  const { base, repo, server, workers } = await start(t, BODY, undefined, {}, { exec: git.exec }); // I1 runs in fila (a new session)
  assert.deepEqual(work0(server)?.stageStart, { stage: 'fila', commit: HEAD_SHA });
  assert.equal((await hiveFetch(`${base}${workPath(server, 'board:I1')}/restart`)).status, 409, 'running: nothing to restart yet');
  workers[0].handlers.onExit();
  await waitFor(() => work0(server)?.stopped === true);
  assert.deepEqual(await json(hiveFetch(`${base}${workPath(server, 'board:I1')}/restart`)), { mode: 'reset', branch: TASK_BRANCH, commits: 3, files: 3 });
  assert.ok(git.calls.some((c) => c.join(' ') === `diff --name-only -z --no-renames ${HEAD_SHA} --`), 'reset: the files against the start commit (#580)');
  git.calls.length = 0;
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/restart`)), { ok: true });
  assert.deepEqual(git.calls.slice(0, 6), [
    ['cat-file', '-e', `${HEAD_SHA}^{commit}`], ['ls-remote', 'origin', `refs/heads/${TASK_BRANCH}`, `refs/heads/${TASK_BRANCH}-r*`],
    ['rev-parse', '--show-toplevel'], ['symbolic-ref', '--short', 'HEAD'], // its own checkout, on the task's branch
    ['reset', '--hard', HEAD_SHA], ['clean', '-fd'],
  ]);
  assert.equal(workers.length, 2, 'a new stage run');
  assert.equal(workers[1].launch.cwd, worktreePath(repo, TASK_SLUG));
  assert.notEqual(plainArgs(workers[1].launch)[1], plainArgs(workers[0].launch)[1], 'in a new session');
});

test('a stage run started in a stage that already has its start keeps that start: one stage start per stage (#812)', async (t) => {
  const git = { head: HEAD_SHA };
  const exec: Exec = (file, args) => restartGit(git.head).exec(file, args);
  const { base, server, workers } = await start(t, BODY, undefined, {}, { exec }); // I1 runs in fila, a new session
  assert.deepEqual(work0(server)?.stageStart, { stage: 'fila', commit: HEAD_SHA });
  workers[0].handlers.onExit();
  await waitFor(() => work0(server)?.stopped === true);
  git.head = 'feedfacefeedfacefeedfacefeedfacefeedface';
  assert.equal((await postJson(`${base}/tasks/board:I1/start`)).status, 200);
  await waitFor(() => workers.length === 2); // the spawn records before it starts the worker
  assert.deepEqual(work0(server)?.stageStart, { stage: 'fila', commit: HEAD_SHA });
});

test('Restart on a published branch that moved checks out <branch>-r2 and the task follows it; a git failure is a 409 with git\'s words and starts nothing (#283)', async (t) => {
  const moved = restartGit(HEAD_SHA, 'feedfacefeedfacefeedfacefeedfacefeedface');
  const one = await start(t, BODY, undefined, {}, { exec: moved.exec });
  one.workers[0].handlers.onExit();
  await waitFor(() => work0(one.server)?.stopped === true);
  assert.deepEqual(await json(hiveFetch(`${one.base}${workPath(one.server, 'board:I1')}/restart`)), { mode: 'branch', branch: TASK_BRANCH, newBranch: `${TASK_BRANCH}-r2`, commits: 3, files: 3 });
  assert.ok(moved.calls.some((c) => c.join(' ') === 'diff --name-only -z --no-renames HEAD --'), 'branch: the files against HEAD (#580)');
  assert.deepEqual(await json(postJson(`${one.base}${workPath(one.server, 'board:I1')}/restart`)), { ok: true });
  assert.ok(moved.calls.some((c) => c.join(' ') === `switch -c ${TASK_BRANCH}-r2 ${HEAD_SHA}`));
  assert.equal(work0(one.server)?.branch, `${TASK_BRANCH}-r2`);
  const broken = restartGit(HEAD_SHA, undefined, 'reset');
  const two = await start(t, BODY, undefined, {}, { exec: broken.exec });
  two.workers[0].handlers.onExit();
  await waitFor(() => work0(two.server)?.stopped === true);
  const refused = await postJson(`${two.base}${workPath(two.server, 'board:I1')}/restart`);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'fatal: boom' });
  assert.deepEqual([two.workers.length, work0(two.server)?.stopped, work0(two.server)?.deleting], [1, true, undefined], 'nothing was dispatched, and the mark went with the failure');
});

test('a stage end captures its checkpoint inside the Stop\'s batch, before the continuation records the next stage\'s start (#619)', async (t) => {
  const git = restartGit(HEAD_SHA);
  const { base, repo, server } = await start(t, { ...BODY, stages: CONTINUE_STAGES }, undefined, {}, { exec: git.exec });
  const ptyId = worker0(server).runId!;
  await hookEvent(base, ptyId, { hook_event_name: 'SessionStart', cwd: repo }); // the worktree recorded: something to capture
  git.calls.length = 0;
  await markDone(server, ptyId);
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'Stop' })).status, 200);
  const { at, ...checkpoint } = work0(server)!.checkpoints![0];
  assert.deepEqual(checkpoint, { n: 1, stage: 'plan', start: HEAD_SHA, head: HEAD_SHA, commit: HEAD_SHA, branch: TASK_BRANCH, ended: 'done' });
  assert.equal(typeof at, 'string');
  const index = (ref: string): number => git.calls.findIndex((c) => c[0] === 'update-ref' && c[1] === ref);
  assert.ok(index(`refs/hive/${TASK_SLUG}/checkpoint/1`) >= 0 && index(`refs/hive/${TASK_SLUG}/checkpoint/1`) < index(`refs/hive/${TASK_SLUG}/stage-start`), JSON.stringify(git.calls));
});

test('Restart captures the checkpoint it throws away before its git, and still restarts when the capture fails (#619)', async (t) => {
  const stoppedOn = async (exec: Exec): Promise<Started> => {
    const started = await start(t, BODY, undefined, {}, { exec });
    await hookEvent(started.base, worker0(started.server).runId!, { hook_event_name: 'SessionStart', cwd: started.repo });
    started.workers[0].handlers.onExit();
    await waitFor(() => work0(started.server)?.stopped === true);
    return started;
  };
  const git = restartGit(HEAD_SHA);
  const one = await stoppedOn(git.exec);
  git.calls.length = 0;
  assert.deepEqual(await json(postJson(`${one.base}${workPath(one.server, 'board:I1')}/restart`)), { ok: true });
  assert.deepEqual(git.calls.slice(0, 5), [
    ['rev-parse', 'HEAD'], ['symbolic-ref', '--short', 'HEAD'], ['status', '--porcelain'], ['update-ref', `refs/hive/${TASK_SLUG}/checkpoint/1`, HEAD_SHA],
    ['cat-file', '-e', `${HEAD_SHA}^{commit}`],
  ]);
  assert.deepEqual(work0(one.server)?.checkpoints?.map((a) => [a.n, a.stage, a.ended]), [[1, 'fila', 'restart']]);
  const broken = restartGit(HEAD_SHA, undefined, 'status');
  const two = await stoppedOn(broken.exec);
  assert.deepEqual(await json(postJson(`${two.base}${workPath(two.server, 'board:I1')}/restart`)), { ok: true }, 'a failed capture never fails the Restart');
  assert.equal(work0(two.server)?.checkpoints, undefined);
  assert.ok(broken.calls.some((c) => c[0] === 'reset'), 'Restart\'s git still ran');
});

test('an in-place continuation records the next stage\'s starting commit before the Stop is answered (#283)', async (t) => {
  const git = restartGit(HEAD_SHA);
  const { base, server } = await start(t, { ...BODY, stages: CONTINUE_STAGES }, undefined, {}, { exec: git.exec });
  assert.equal(work0(server)?.stageStart?.stage, 'plan');
  const ptyId = worker0(server).runId!;
  await markDone(server, ptyId);
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'Stop' })).status, 200);
  assert.deepEqual(work0(server)?.stageStart, { stage: 'dev', commit: HEAD_SHA, after: 'plan' });
});

test('POST /activities/:id/sessions/:session/clear forgets that one session and deletes only its transcript when the deleteActivity scope says so; 404 an unknown task, 409 a held or unknown session; the bulk route is gone (#304)', async (t) => {
  claudeConfigDir(t, await tempDir(t, 'claude-'));
  const scope = { session: true, transcripts: true, nonAutoTasks: false };
  const { base, repo, server, workers } = await start(t, { ...BODY, deleteActivity: scope });
  const clear = (id: string, session: string): Promise<Response> => postJson(`${base}${workPath(server, id)}/sessions/${session}/clear`);
  const refused = async (res: Promise<Response>, error: string): Promise<void> => {
    const answer = await res;
    assert.equal(answer.status, 409, error);
    assert.deepEqual(await answer.json(), { error });
  };
  const unavailable = 'Esta sessão está em uso ou não existe mais';
  const first = work0(server)!.sessionId!;
  await refused(clear('board:I1', first), unavailable); // its stage run holds it
  await hookEvent(base, worker0(server).runId!, { hook_event_name: 'SessionStart', cwd: repo }); // the worktree a new session needs
  await server.dispatch({ type: 'setSignal', signal: 'red' }); // nothing respawns once the worker exits
  workers[0].handlers.onExit();
  await waitFor(() => worker0(server).status === 'empty');
  await server.dispatch({ type: 'openSession', activityId: workId(server.getState()!, 'board:I1') }); // a second session, held by its free session
  const second = sessions0(server).at(-1)!.id;
  const dir = transcriptDir(worktreePath(repo, TASK_SLUG));
  await mkdir(dir, { recursive: true });
  for (const id of [first, second]) await writeFile(join(dir, `${id}.jsonl`), '{}\n');
  assert.equal((await clear('nope', first)).status, 404);
  await refused(clear('board:I1', second), unavailable);
  await refused(clear('board:I1', 'a1b2c3d4-0000-4000-8000-000000000009'), unavailable);
  assert.equal((await postJson(`${base}/tasks/board:I1/sessions/clear`)).status, 404, 'the bulk route is gone');
  assert.deepEqual(await json(clear('board:I1', first)), { ok: true });
  assert.deepEqual([sessions0(server).map((s) => s.id), work0(server)?.sessionId], [[second], undefined]);
  assert.deepEqual(await readdir(dir), [`${second}.jsonl`], 'only the cleared session\'s transcript goes');
});

test('POST /activities/:id/sessions/:session/clear keeps the transcript when the deleteActivity scope leaves transcripts off (#304)', async (t) => {
  claudeConfigDir(t, await tempDir(t, 'claude-'));
  const scope = { session: true, transcripts: false, nonAutoTasks: false };
  const { base, repo, server, workers } = await start(t, { ...BODY, deleteActivity: scope });
  const session = work0(server)!.sessionId!;
  workers[0].handlers.onExit();
  await waitFor(() => work0(server)?.stopped === true);
  const dir = transcriptDir(worktreePath(repo, TASK_SLUG));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${session}.jsonl`), '{}\n');
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/sessions/${session}/clear`)), { ok: true });
  assert.deepEqual([sessions0(server), work0(server)?.sessionId], [[], undefined]);
  assert.deepEqual(await readdir(dir), [`${session}.jsonl`]);
});

test('deleteActivityOnDisk also checks and deletes the own branches a Restart left behind, before and after the task\'s own, and drops the stage-start ref (#283)', async (t) => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    const command = args.slice(2);
    calls.push(command);
    const listing = command[0] === 'for-each-ref' && command[1] === '--format=%(refname:lstrip=2)';
    return { stdout: listing ? `${TASK_BRANCH}\n${TASK_BRANCH}-r2\n${TASK_BRANCH}-r3\n` : '' };
  };
  const task: Task = {
    item: { itemId: 'board:I1', id: '1', title: 'from Ready', body: '', url: '' }, stage: 'fila', boardColumn: 'Ready', auto: true,
  };
  const activity: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: TASK_SLUG, branch: `${TASK_BRANCH}-r3`, stageStart: { stage: 'fila', commit: 'a1b2c3d' } }; // #629: the activity's
  const deps = { log: fakeLog().log, exec, ptys: createPtyHost(NO_PTY), consoleStore: createConsoleStore(() => 1000) };
  await deleteActivityOnDisk({ workspace: { name: 'hive', path: await tempDir(t, 'repo-'), env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }, activity, task, sessions: [], branch: TASK_BRANCH, scope: DELETE_ACTIVITY_DEFAULTS }, deps);
  const check = (b: string): string[][] => [['for-each-ref', '--format=%(upstream)', `refs/heads/${b}`], ['merge-base', '--is-ancestor', `refs/heads/${b}`, 'HEAD']];
  assert.deepEqual(calls, [
    ['for-each-ref', '--format=%(refname:lstrip=2)', `refs/heads/${TASK_BRANCH}`, `refs/heads/${TASK_BRANCH}-r*`],
    ...check(TASK_BRANCH), ...check(`${TASK_BRANCH}-r2`),
    ['worktree', 'list', '--porcelain'], ['rev-parse', '--verify', '--quiet', `refs/heads/${TASK_BRANCH}-r3`], ...check(`${TASK_BRANCH}-r3`),
    ['branch', '-d', '--', `${TASK_BRANCH}-r3`],
    ['branch', '-d', '--', TASK_BRANCH], ['branch', '-d', '--', `${TASK_BRANCH}-r2`],
    ['rev-parse', '--verify', '--quiet', `refs/hive/${TASK_SLUG}/stage-start`], ['update-ref', '-d', `refs/hive/${TASK_SLUG}/stage-start`],
    ['for-each-ref', '--format=%(refname)', `refs/hive/${TASK_SLUG}/checkpoint/`], // #619
  ]);
});

test('deleteActivityOnDisk drops the stage-start ref of an activity whose start a stage entry already cleared: the ref never pins a commit after the delete (#812)', async (t) => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args.slice(2));
    return { stdout: '' };
  };
  const task: Task = { item: { itemId: 'board:I1', id: '1', title: 'from Ready', body: '', url: '' }, stage: 'fila', boardColumn: 'Ready', auto: true };
  const activity: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: TASK_SLUG, branch: TASK_BRANCH }; // entered a stage: no stageStart
  const deps = { log: fakeLog().log, exec, ptys: createPtyHost(NO_PTY), consoleStore: createConsoleStore(() => 1000) };
  await deleteActivityOnDisk({ workspace: { name: 'hive', path: await tempDir(t, 'repo-'), env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, color: 'oklch(0.72 0.12 25)' }, activity, task, sessions: [], branch: TASK_BRANCH, scope: DELETE_ACTIVITY_DEFAULTS }, deps);
  assert.deepEqual(calls.slice(-3), [['rev-parse', '--verify', '--quiet', `refs/hive/${TASK_SLUG}/stage-start`], ['update-ref', '-d', `refs/hive/${TASK_SLUG}/stage-start`], ['for-each-ref', '--format=%(refname)', `refs/hive/${TASK_SLUG}/checkpoint/`]]);
});

test('Restart is refused while a session or a terminal runs on the task; while its git runs the task is marked, so a continue or a start is refused (#283)', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const git = restartGit(HEAD_SHA, undefined, undefined, gate);
  const { base, server, workers } = await start(t, BODY, undefined, {}, { exec: git.exec });
  workers[0].handlers.onExit(); // no hive_done: stopped
  await waitFor(() => work0(server)?.stopped === true);
  await opened(postJson(`${base}/tasks/board:I1/open`, { kind: 'terminal' }));
  for (const res of [await hiveFetch(`${base}${workPath(server, 'board:I1')}/restart`), await postJson(`${base}${workPath(server, 'board:I1')}/restart`)]) {
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'feche as sessões abertas da tarefa antes de reiniciar' });
  }
  assert.equal(git.calls.some((c) => c[0] === 'reset'), false, 'no reset under a live terminal');
  workers[1].handlers.onExit(); // the terminal ends
  await waitFor(() => server.getState()!.terminals[0]?.asleep === true); // #696: it sleeps, and runs nothing a Restart would reset under
  const restarting = postJson(`${base}${workPath(server, 'board:I1')}/restart`);
  await waitFor(() => work0(server)?.deleting === true);
  assert.equal((await postJson(`${base}${workPath(server, 'board:I1')}/continue`)).status, 409);
  assert.equal((await postJson(`${base}/tasks/board:I1/start`)).status, 409);
  release();
  assert.deepEqual(await json(restarting), { ok: true });
  assert.deepEqual([work0(server)?.deleting, workers.length], [undefined, 3], 'the mark goes with the restart, which runs the stage');
});

const APPROVAL_STAGES: LegacyStage[] = [{ ...CONTINUE_STAGES[0], approval: true }, CONTINUE_STAGES[1]]; // plan asks for approval; dev goes on in its session
const LAST_APPROVAL: LegacyStage[] = [{ ...STAGES[0], approval: true }]; // no next stage: the stage end frees the worker
const AWAITING = 'tarefa aguarda aprovação: aprove ou envie feedback';

// hive_done then a Stop the Hive holds: the answer waits for the user, so the fetch is returned unawaited
async function heldStop(base: string, server: HiveServer, ptyId: string): Promise<{ stop: Promise<Response> }> {
  await markDone(server, ptyId);
  const stop = hookEvent(base, ptyId, { hook_event_name: 'Stop' });
  await waitFor(() => worker0(server).status === 'approval');
  return { stop };
}

test('a Stop after hive_done in an approval stage is held until POST /activities/:id/approve answers it with the next stage\'s prompt: same worker, no kill, no spawn, the task moves (#268)', async (t) => {
  const { base, server, workers } = await start(t, { ...BODY, stages: APPROVAL_STAGES });
  const { runId: ptyId } = worker0(server);
  const { stop } = await heldStop(base, server, ptyId!);
  assert.ok(work0(server)?.approval?.until);
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/approve`)), { ok: true });
  const answered = await stop;
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { decision: 'block', reason: '/hive-build https://github.com/acme/r/issues/1' });
  assert.deepEqual([worker0(server).status, worker0(server).runId, task0(server).stage, 'approval' in task0(server)], ['working', ptyId, 'dev', false]);
  assert.deepEqual([workers.length, workers[0].killed], [1, 0]);
});

test('a held Stop answered by feedback goes on in the same stage with the text; a held Stop whose run is stopped (Parar) gets no decision and the task keeps awaiting (#268)', async (t) => {
  const { base, server } = await start(t, { ...BODY, stages: APPROVAL_STAGES });
  const { runId: ptyId } = worker0(server);
  const first = await heldStop(base, server, ptyId!);
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/feedback`, { text: 'split the plan', start: false })), { ok: true });
  const answered = await first.stop;
  assert.deepEqual([answered.status, await answered.json()], [200, { decision: 'block', reason: 'The user reviewed this stage and asks:\n\nsplit the plan' }]);
  assert.deepEqual([worker0(server).status, task0(server).stage], ['working', 'plan']);
  const second = await heldStop(base, server, ptyId!);
  assert.deepEqual(await json(postJson(`${base}/ptys/${ptyId}/stop`)), { ok: true });
  assert.equal((await second.stop).status, 204);
  assert.deepEqual([typeof work0(server)?.approval?.since, work0(server)?.approval?.until, work0(server)?.stopped], ['string', undefined, undefined]);
});

test('the approval routes answer 404 for an unknown task, 409 for a task not awaiting, extend only on a held session, 400 for a bad feedback body; start, continue and restart refuse an awaiting task (#268)', async (t) => {
  const { base, server } = await start(t, { ...BODY, stages: LAST_APPROVAL });
  // #629: start stays on the task; the rest act on its live activity, `nope` naming none
  const refused = async (path: string, body: unknown, status: number, error: string): Promise<void> => {
    const [id, ...rest] = path.split('/');
    const route = rest.join('/');
    const res = await postJson(`${base}${route === 'start' ? `/tasks/${id}` : workPath(server, id)}/${route}`, body);
    assert.equal(res.status, status, `${path}: ${error}`);
    assert.deepEqual(await res.json(), { error });
  };
  await refused('nope/approve', {}, 404, 'atividade desconhecida');
  await refused('board:I1/approve', {}, 409, 'tarefa não aguarda aprovação'); // still running its stage
  await refused('board:I1/feedback', { text: 'fix it', start: false }, 409, 'tarefa não aguarda aprovação');
  const { runId: ptyId } = worker0(server);
  await markDone(server, ptyId!);
  assert.equal((await hookEvent(base, ptyId!, { hook_event_name: 'Stop' })).status, 204, 'no next stage: not held, the run ends');
  await server.dispatch({ type: 'setSignal', signal: 'red' }); // so a queued feedback stays queued
  await refused('board:I1/approval/extend', {}, 409, 'aprovação sem sessão aberta');
  await refused('board:I1/start', {}, 409, AWAITING);
  await refused('board:I1/continue', {}, 409, AWAITING);
  const preview = await hiveFetch(`${base}${workPath(server, 'board:I1')}/restart`);
  assert.deepEqual([preview.status, await preview.json()], [409, { error: AWAITING }]);
  for (const text of ['', '   ', 'x'.repeat(10_001), 42, '\x1b\x07']) await refused('board:I1/feedback', { text, start: true }, 400, 'feedback precisa ser texto de 1 a 10000 caracteres');
  await refused('board:I1/feedback', { text: 'fix it' }, 400, 'start precisa ser true ou false');
  // #483: control characters go at the route, so a pasted \x1b[201~ can never close the paste the text is typed into; CRLF and CR become LF, tabs stay
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/feedback`, { text: '  fix\x1b[201~ it\r\n!a\tb\rc\u0085  ', start: false })), { ok: true });
  assert.deepEqual([work0(server)?.handover?.prompt, 'approval' in task0(server)], ['The user reviewed this stage and asks:\n\nfix[201~ it\n!a\tb\nc', false], 'queued, cleaned, trimmed');
});

test('approve and feedback with no transition of their own answer 409 and keep the task awaiting (#134)', async (t) => {
  const { base, server } = await start(t, { ...BODY, stages: LAST_APPROVAL, transitions: [] });
  const { runId: ptyId } = worker0(server);
  await markDone(server, ptyId!);
  await hookEvent(base, ptyId!, { hook_event_name: 'Stop' });
  const since = work0(server)?.approval?.since;
  for (const [route, body, error] of [['approve', {}, 'nenhuma transição sai desta etapa ao aprovar'], ['feedback', { text: 'fix it', start: true }, 'nenhuma transição sai desta etapa com feedback']] as const) {
    const res = await postJson(`${base}${workPath(server, 'board:I1')}/${route}`, body);
    assert.deepEqual([res.status, await res.json()], [409, { error }], route);
  }
  assert.deepEqual([typeof since, work0(server)?.approval?.since, work0(server)?.error], ['string', since, undefined]);
});

test('feedback with start on a task whose run ended resumes the stage\'s session at once with the text as the prompt (#268)', async (t) => {
  const { base, server, workers } = await start(t, { ...BODY, stages: LAST_APPROVAL });
  const { runId: ptyId } = worker0(server);
  const session = work0(server)!.sessionId!;
  await markDone(server, ptyId!);
  await hookEvent(base, ptyId!, { hook_event_name: 'Stop' });
  await server.dispatch({ type: 'setSignal', signal: 'red' }); // past red, like a start
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/feedback`, { text: 'fix the flaky test', start: true })), { ok: true });
  assert.equal(workers.length, 2);
  assert.deepEqual(plainArgs(workers[1].launch).slice(-2), ['--resume', session]);
  assert.equal(await readFile(workers[1].launch.promptPath!, 'utf8'), 'The user reviewed this stage and asks:\n\nfix the flaky test');
});

test('feedback with prompt mergeBase sends the merge-from-base text, rendered on the workspace\'s base remote, as started feedback (#379)', async (t) => {
  const { base, server, workers } = await start(t, { ...BODY, stages: LAST_APPROVAL });
  const { runId: ptyId } = worker0(server);
  const session = work0(server)!.sessionId!;
  await markDone(server, ptyId!);
  await hookEvent(base, ptyId!, { hook_event_name: 'Stop' });
  await server.dispatch({ type: 'setSignal', signal: 'red' }); // past red, like a start
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/feedback`, { prompt: 'mergeBase', promptBase: 'main', start: true })), { ok: true });
  assert.deepEqual(plainArgs(workers[1].launch).slice(-2), ['--resume', session]);
  assert.equal(await readFile(workers[1].launch.promptPath!, 'utf8'), `The user reviewed this stage and asks:\n\n${mergeBasePrompt('main')}`);
});

test('feedback with a prompt and a text, another prompt or a bad promptBase answers 400 and the task keeps awaiting (#379)', async (t) => {
  const { base, server } = await start(t, { ...BODY, stages: LAST_APPROVAL });
  const { runId: ptyId } = worker0(server);
  await markDone(server, ptyId!);
  await hookEvent(base, ptyId!, { hook_event_name: 'Stop' });
  const bodies = [
    { text: 'fix it', prompt: 'mergeBase', promptBase: 'main', start: true },
    { prompt: 'rebase', promptBase: 'main', start: true },
    { prompt: 'mergeBase', promptBase: '-x', start: true },
  ];
  for (const body of bodies) {
    const res = await postJson(`${base}${workPath(server, 'board:I1')}/feedback`, body);
    assert.deepEqual([res.status, await res.json()], [400, { error: 'prompt must be mergeBase, with promptBase a branch name' }], JSON.stringify(body));
  }
  assert.equal(typeof work0(server)?.approval?.since, 'string');
});

const MANUAL_GATE: LegacyStage[] = [{ name: 'fila', from: { board: ['Ready'] }, onFinish: { board: [move('In review')] }, approval: true }]; // approval, no prompt (#315)

test('a task polled into a manual gate awaits approval with no worker, and approve moves it out after the last stage (#315)', async (t) => {
  const { base, server, workers } = await start(t, { ...BODY, stages: MANUAL_GATE });
  assert.deepEqual([workers.length, worker0(server).status, typeof work0(server)?.approval?.since], [0, 'empty', 'string']);
  assert.deepEqual(await json(postJson(`${base}${workPath(server, 'board:I1')}/approve`)), { ok: true });
  assert.deepEqual(server.getState()?.tasks, [], 'the last stage: approved out of the Hive');
});

test('a leaving sourceAction (#286): the source applies it and the task leaves the Hive through closeTask; a refusal keeps the task in its stage with the adapter\'s words, logged and on the bar', async (t) => {
  const leaving: LegacyStage = { ...STAGES[0], onFinish: { board: [{ type: 'archive' }] } };
  const archived: Omit<SettingsBody, 'workspaces'> = { ...BODY, stages: [leaving] };
  const { log, lines } = fakeLog();
  const accepting = fakeSourceFactory();
  const { base, server } = await start(t, archived, log, {}, { sourceFactory: accepting.factory });
  const ptyId = worker0(server).runId!;
  await markDone(server, ptyId);
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'Stop' })).status, 204);
  assert.deepEqual(accepting.applied, ['I1 archive'], 'the adapter sees its own id');
  assert.deepEqual(server.getState()?.tasks, [], 'closeTask took it out');
  assert.ok(lines.includes('INFO sourceAction #board:I1 archive ok'), lines.join('\n'));

  const refusing = fakeSourceFactory(0, undefined, 'must have admin rights');
  const other = await start(t, archived, undefined, {}, { sourceFactory: refusing.factory });
  const otherId = worker0(other.server).runId!;
  await markDone(other.server, otherId);
  await hookEvent(other.base, otherId, { hook_event_name: 'Stop' });
  assert.deepEqual(refusing.applied, ['I1 archive']);
  const kept = task0(other.server);
  assert.deepEqual([kept.stage, kept.leaving, work0(other.server)?.error], ['fila', undefined, 'must have admin rights']);
  assert.equal(other.server.getState()?.error, 'source.apply(archive): must have admin rights');
});

test('a poll whose read began before a leaving action answered does not bring the closed task back; a later poll that lists it again lets it enter (#353)', async (t) => {
  const leaving: LegacyStage = { ...STAGES[0], onFinish: { board: [{ type: 'archive' }] } };
  const accepting = fakeSourceFactory();
  let gate: Promise<void> | undefined; // while set, a listing started now answers only once the test opens it
  const factory = (config: SourceSpec): Source => {
    const source = accepting.factory(config);
    return { ...source, async listItems() { const held = gate; if (held) await held; return source.listItems(); } };
  };
  const { log, lines } = fakeLog();
  const { base, server } = await start(t, { ...BODY, stages: [leaving] }, log, {}, { sourceFactory: factory });
  let open!: () => void;
  gate = new Promise<void>((resolve) => { open = resolve; });
  const stale = server.poll(); // reads the board before the archive below answers
  gate = undefined;
  const ptyId = worker0(server).runId!;
  await markDone(server, ptyId);
  await hookEvent(base, ptyId, { hook_event_name: 'Stop' });
  assert.deepEqual(accepting.applied, ['I1 archive']);
  assert.deepEqual(server.getState()?.tasks, [], 'closeTask took it out');

  open();
  await stale;
  assert.deepEqual(server.getState()?.tasks, [], 'the listing read before the archive did not bring it back');
  assert.ok(lines.includes('DEBUG poll source=board dropped board:I1: closed after the read began'), lines.join('\n'));

  await sleep(5); // past the close's millisecond: a read starting in it counts the item as closed after it began
  await server.poll(); // began after the close and lists the item: restored on the source, so it enters
  assert.deepEqual(server.getState()?.tasks.map((task) => task.item.itemId), ['board:I1']);
});

test('POST /rules/disable and /rules/enable (#297): a bad source, percent or until is a 400 that changes nothing; a good one dispatches, and the disable holds until the enable', async (t) => {
  const { base, server } = await start(t, { ...BODY, usageRules: [{ source: 'session', percent: 80, signal: 'yellow' }] });
  await server.dispatch({ type: 'rateLimits', agent: 'claude', rateLimits: { at: new Date().toISOString(), windows: { five_hour: { usedPercent: 85, resetsAt: new Date(Date.now() + HOUR_MS).toISOString() } } } });
  const past = new Date(Date.now() - 60_000).toISOString();
  const bad = [
    { source: 'year', percent: 80, until: { kind: 'reset' } },
    { source: 'session', percent: '80', until: { kind: 'reset' } },
    { source: 'session', until: { kind: 'reset' } },
    { source: 'session', percent: 80 },
    { source: 'session', percent: 80, until: { kind: 'later' } },
    { source: 'session', percent: 80, until: { kind: 'at', at: 'soon' } },
    { source: 'session', percent: 80, until: { kind: 'at', at: past } },
  ];
  for (const body of bad) {
    const res = await postJson(`${base}/rules/disable`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await json<{ error: string }>(res)).error.length > 0, JSON.stringify(body));
  }
  assert.deepEqual(server.getState()?.disabledRules, []);
  assert.equal((await postJson(`${base}/rules/enable`, { source: 'year', percent: 80 })).status, 400);
  assert.equal((await postJson(`${base}/rules/enable`, { source: 'session', percent: null })).status, 400);
  const ok = await postJson(`${base}/rules/disable`, { source: 'session', percent: 80, until: { kind: 'reset' } });
  assert.deepEqual([ok.status, await json(ok)], [200, { ok: true }]);
  assert.deepEqual(server.getState()?.disabledRules, [{ source: 'session', percent: 80, until: { kind: 'reset' } }]);
  const on = await postJson(`${base}/rules/enable`, { source: 'session', percent: 80 });
  assert.deepEqual([on.status, await json(on)], [200, { ok: true }]);
  assert.deepEqual(server.getState()?.disabledRules, []);
});

test('POST /rules/disable and /rules/enable carry a plan rule\'s agent: each rule goes off on its own; an unknown agent is a 400 (#929)', async (t) => {
  const { base, server } = await start(t, { ...BODY, usageRules: [{ source: 'week', percent: 90, signal: 'red', agent: 'codex' }, { source: 'week', percent: 90, signal: 'yellow' }] });
  const week = (usedPercent: number) => ({ at: new Date().toISOString(), windows: { seven_day: { usedPercent, resetsAt: new Date(Date.now() + HOUR_MS).toISOString() } } });
  await server.dispatch({ type: 'rateLimits', agent: 'codex', rateLimits: week(95) });
  await server.dispatch({ type: 'rateLimits', agent: 'claude', rateLimits: week(10) });
  assert.equal((await postJson(`${base}/rules/disable`, { source: 'week', percent: 90, agent: 'gemini', until: { kind: 'manual' } })).status, 400);
  assert.equal((await postJson(`${base}/rules/enable`, { source: 'week', percent: 90, agent: 7 })).status, 400);
  assert.equal((await postJson(`${base}/rules/disable`, { source: 'week', percent: 90, until: { kind: 'manual' } })).status, 200);
  assert.deepEqual(server.getState()?.disabledRules, [], 'no agent: Claude\'s week, which does not fire');
  assert.equal((await postJson(`${base}/rules/disable`, { source: 'week', percent: 90, agent: 'codex', until: { kind: 'manual' } })).status, 200);
  assert.deepEqual(server.getState()?.disabledRules, [{ source: 'week', percent: 90, until: { kind: 'manual' }, agent: 'codex' }]);
  assert.equal((await postJson(`${base}/rules/enable`, { source: 'week', percent: 90, agent: 'codex' })).status, 200);
  assert.deepEqual(server.getState()?.disabledRules, []);
});

test('a save that renames a stage carries its tasks: the running one stays in it under the new name and its Stop ends the renamed stage through its transition (#861)', async (t) => {
  const { log, lines } = fakeLog();
  const { base, repo, server, workers } = await start(t, BODY, log);
  const ptyId = worker0(server).runId!;
  const renamed = { ...BODY, workspaces: workspacesAt(repo), stages: [{ ...STAGES[0], name: 'Spec' }], stageRenames: { fila: 'Spec' } };
  assert.equal((await postJson(`${base}/settings`, onOwnStages(renamed))).status, 200);
  assert.deepEqual([task0(server).stage, worker0(server).runId, work0(server)?.stageGone], ['Spec', ptyId, undefined]);
  await markDone(server, ptyId);
  assert.equal((await hookEvent(base, ptyId, { hook_event_name: 'Stop' })).status, 204);
  assert.deepEqual(server.getState()?.tasks, [], 'the renamed stage ended and its transition took the task out');
  assert.ok(lines.includes('INFO setColumn #board:I1 → In review ok'), lines.join('\n'));
  assert.equal(workers.length, 1);
});

test('a boot whose config lost a stage the saved state uses places its task in the destination instead of stranding it (#861)', async (t) => {
  const { home, repo } = await tempHive(t);
  const parked: Task = { item: { itemId: 'board:I7', source: 'board', id: '7', title: 'Task 7', body: '', url: 'https://github.com/acme/r/issues/7' }, stage: 'gone', boardColumn: 'Nowhere', auto: false };
  await saveState(home, { ...initialState(0), ...chained([...STAGES, { name: 'gone', from: {} }]), tasks: [parked] });
  const server = createServer({ secret: SECRET, home, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, exec: noGit });
  const port = await server.listen(0);
  t.after(() => server.close());
  assert.equal((await postJson(`http://127.0.0.1:${port}/settings`, { workspaces: workspacesAt(repo), ...onOwnStages(BODY) })).status, 200);
  assert.equal(server.getState()!.tasks.find((c) => c.item.itemId === 'board:I7')?.stage, 'fila', 'gone was last: fila comes before it');
});

test('a task that leaves with its worktree keeps its activity: GET /worktrees lists it as kept, and removing it lets the activity go (#861)', async (t) => {
  const git = listedGit();
  const { base, repo, server } = await ranOnce(t, { exec: git.exec });
  await server.dispatch({ type: 'poll', source: 'board', items: [] });
  await server.dispatch({ type: 'closeTask', taskId: 'board:I1' });
  assert.deepEqual([server.getState()!.tasks.length, server.getState()!.activities.filter((a) => a.kind === 'task').length], [0, 1]);
  const rows = await json<WorktreeRow[]>(hiveFetch(`${base}/worktrees`));
  assert.deepEqual(rows.find((r) => r.slug === TASK_SLUG), { workspace: 'hive', slug: TASK_SLUG, path: worktreePath(repo, TASK_SLUG), branch: TASK_BRANCH, orphan: 'kept', nested: [] });
  await mkdir(worktreePath(repo, TASK_SLUG), { recursive: true });
  assert.deepEqual(await json(postJson(`${base}/worktrees/hive/${TASK_SLUG}/remove`)), { removed: true });
  assert.equal(server.getState()!.activities.some((a) => a.kind === 'task'), false, 'worktreeGone let it go');
});

test('POST /tasks/:id/start with discardOrphan removes what git holds for a task with no activity before it starts from the base; a merged branch is deleted, an unmerged one set aside; a refusal is a 409 with git\'s words and starts nothing (#861, #267)', async (t) => {
  const refs = ['refs/heads/feature-x', `refs/heads/${TASK_BRANCH}`]; // the task's branch is there, no worktree
  const git = refsGit({ refs });
  const { base, workers } = await start(t, idle(), undefined, {}, { exec: git.exec });
  assert.deepEqual(await json(postJson(`${base}/tasks/board:I1/start`, { base: 'feature-x', discardOrphan: true })), { ok: true });
  const deleted = git.calls.findIndex((c) => c[0] === 'branch' && c[1] === '-d');
  const added = git.calls.findIndex((c) => c[0] === 'worktree' && c[1] === 'add');
  assert.ok(deleted >= 0 && deleted < added, 'the branch goes before the worktree is made');
  assert.equal(workers.length, 1);
  const notMerged = (): Promise<never> => Promise.reject(Object.assign(new Error('Command failed: git merge-base'), { code: 1 }));
  const asideGit = refsGit({ refs });
  const unmerged: Exec = async (file, args) => (args.includes('merge-base') ? notMerged() : asideGit.exec(file, args));
  const aside = await start(t, idle(), undefined, {}, { exec: unmerged });
  assert.deepEqual(await json(postJson(`${aside.base}/tasks/board:I1/start`, { base: 'feature-x', discardOrphan: true })), { ok: true });
  assert.ok(asideGit.calls.some((c) => c.join(' ') === `branch -m -- ${TASK_BRANCH} ${TASK_BRANCH}-old-b2c3d4e`), 'set aside under its tip, never deleted');
  assert.equal(aside.workers.length, 1);
  const refusingGit = refsGit({ refs });
  const words = `fatal: a branch named '${TASK_BRANCH}-old-b2c3d4e' already exists`;
  const refusing: Exec = async (file, args) => {
    if (args.includes('merge-base')) return notMerged();
    if (args.includes('-m')) throw Object.assign(new Error('Command failed: git branch -m'), { stderr: `${words}\n` });
    return refusingGit.exec(file, args);
  };
  const again = await start(t, idle(), undefined, {}, { exec: refusing });
  const res = await postJson(`${again.base}/tasks/board:I1/start`, { base: 'feature-x', discardOrphan: true });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: words, code: DISCARD_FAILED });
  assert.equal(again.workers.length, 0, 'nothing started');
});
