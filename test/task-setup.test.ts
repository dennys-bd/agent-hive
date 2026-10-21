import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type TaskSetupDeps, removeInRun, runTaskSetup } from '../src/task-setup.js';
import { type ConsoleStore, createConsoleStore } from '../src/console.js';
import { createPtyHost, NO_PTY, type PtyHost } from '../src/pty-host.js';
import type { Task, Effect, Exec, HiveEvent, SetupRow, Workspace } from '../src/types.js';
import { SETUP_MARKER } from '../src/worktree-setup.js';
import { TEARDOWN_MARKER } from '../src/worktree-teardown.js';
import { RunFailure, type RunShell } from '../src/worktree-steps.js';
import { type AfterHost, tempDir } from './temp-dir.js';
import { fakeFacts } from './fakes.js';

const TASK: Task = {
  item: { itemId: 'board:I1', id: '1', title: 'Task 1', body: '', url: 'https://github.com/acme/r/issues/1' }, stage: 'dev', boardColumn: 'Ready', auto: true,
};
// The activities the setups act on (#629): what setupStarted, setupStep and setupEnded name
const ACTIVITY = 'a-board:I1';
const OTHER_ACTIVITY = 'a-board:I2';
const ID = 'setup:board:I1'; // the task's run, in the one setup channel
const CHANNEL = 'setup';
const TEARDOWN_HEADER = '── #1 · teardown · \\d\\d:\\d\\d:\\d\\d ──\\r\\n';
const TEARDOWN = { id: 'teardown:board:I1', label: '#1', force: false };
const HEADER = /^── #1 · setup · \d\d:\d\d:\d\d ──\r\n/;

interface Harness { deps: TaskSetupDeps; workspace: Workspace; worktree: string; gitDir: string; events: HiveEvent[]; store: ConsoleStore; ptys: PtyHost }

// A real console store and pty host, a fake dispatch that records, and git that answers the worktree's git dir only (#351).
async function harness(t: AfterHost, setup: string, run: RunShell): Promise<Harness> {
  const [repo, worktree] = await Promise.all([tempDir(t, 'repo-'), tempDir(t, 'wt-')]);
  const gitDir = join(repo, '.git', 'worktrees', basename(worktree));
  await mkdir(gitDir, { recursive: true });
  const events: HiveEvent[] = [];
  const exec: Exec = async (_file, args) => ({ stdout: args.includes('--git-common-dir') ? `${join(repo, '.git')}\n` : `${gitDir}\n` });
  const dispatch = async (event: HiveEvent): Promise<Effect[]> => {
    events.push(event);
    return [];
  };
  const store = createConsoleStore(() => 1000);
  const ptys = createPtyHost(NO_PTY);
  const workspace: Workspace = { name: 'hive', path: repo, env: {}, fork: null, memoryCap: 4000, color: 'oklch(0.72 0.12 25)', setup };
  return { deps: { exec, log: { info: () => undefined }, dispatch, ptys, consoleStore: store, run }, workspace, worktree, gitDir, events, store, ptys };
}

const quiet: RunShell = async () => undefined;
// The run's text made readable (#576): ESC stands for \x1b, since Biome refuses a control character in a pattern
const shown = (text: string | undefined): string => (text ?? '').replaceAll('\x1b', 'ESC');
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cmd = (source: string): string => `ESC\\[97m> ${source}ESC\\[0m\\r\\n`; // a command line, bright white
const fail = (source: string): string => `ESC\\[31m${source}ESC\\[0m\\r\\n`; // a failure, red
const MS = 'ESC\\[32mok \\d+msESC\\[0m\\r\\n';
const SETUP_OK_LINE = 'ESC\\[32msetup ok · \\d+ steps · \\d+msESC\\[0m\\r\\n';
const GIT_DIR = `${cmd('git -C [^\\r ]+ rev-parse --absolute-git-dir')}${MS}`;
const COMMON_DIR = `${cmd('git -C [^\\r ]+ rev-parse --git-common-dir')}${MS}`;

// The worktree's git, as the stage spawn's ensureWorktree would run it (#351): one command through the exec it is handed, then the path.
const prepareIn = (worktree: string) => async (exec: Exec): Promise<string> => {
  await exec('git', ['worktree', 'add', worktree]);
  return worktree;
};

// The branch row of every setup here (#390)
const BRANCH = { branch: 'hive/1-task-1', base: 'origin/main' };
// The rows each setupStarted and setupStep carried, in order (#390)
const rowsOf = (events: HiveEvent[]): SetupRow[][] => events.flatMap((e) => (e.type === 'setupStarted' || e.type === 'setupStep' ? [e.rows] : []));
const statuses = (rows: SetupRow[]): string => rows.map((row) => row.status).join(' ');
// An event without its rows, for the tests that read only the order and the step
const withoutRows = (event: HiveEvent): object => {
  if (event.type !== 'setupStarted' && event.type !== 'setupStep') return event;
  const { rows: _rows, ...rest } = event;
  return rest;
};

test('runTaskSetup on a worktree already on disk of a workspace with no steps prepares with the plain exec: no console run, no event (#351, #576)', async (t) => {
  const none = await harness(t, '# later\n', quiet);
  const execs: Exec[] = [];
  const path = await runTaskSetup(none.deps, TASK, ACTIVITY, none.workspace, none.worktree, async (exec) => { execs.push(exec); return none.worktree; }, BRANCH);
  assert.deepEqual([path, execs, none.events, none.store.channels()], [none.worktree, [none.deps.exec], [], []]);
});

test('runTaskSetup on a new worktree of a workspace with no steps marks the task and runs its git in the Setup worktree channel, ended by setup ok (#576)', async (t) => {
  const none = await harness(t, '# later\n', quiet);
  const worktree = join(none.worktree, 'new'); // no folder yet
  const path = await runTaskSetup(none.deps, TASK, ACTIVITY, none.workspace, worktree, prepareIn(worktree), BRANCH);
  assert.equal(path, worktree);
  assert.deepEqual(none.events.map(withoutRows), [
    { type: 'setupStarted', activityId: ACTIVITY, consoleId: ID }, { type: 'setupStep', activityId: ACTIVITY }, { type: 'setupEnded', activityId: ACTIVITY },
  ]);
  assert.deepEqual(none.store.channels(), [{ id: CHANNEL, kind: 'setup', label: 'Setup worktree', status: 'done' }]);
  assert.match(shown(none.store.history(CHANNEL)?.history), new RegExp(`${HEADER.source}${cmd(`git worktree add ${escaped(worktree)}`)}${MS}${SETUP_OK_LINE}$`));
});

test('runTaskSetup marks the task before the git, logs every git command of the preparation and of the setup as `> git <args>` then `ok <ms>ms`, then the steps and setup ok, live on the pty host; a pipe\'s newlines become \\r\\n (#351)', async (t) => {
  let whileRunning: [boolean, number] | undefined;
  // typed: the RUN below reads h, and TS cannot infer a const from an initializer that refers to it (TS7022)
  const h: Harness = await harness(t, 'RUN pnpm install', async (_file, _args, options) => {
    options.onOutput?.('added 12 packages\n');
    whileRunning = [h.ptys.has(ID), h.store.history(CHANNEL)?.live.length ?? 0];
  });
  let markedFirst = false;
  const path = await runTaskSetup(h.deps, TASK, ACTIVITY, h.workspace, h.worktree, async (exec) => {
    markedFirst = h.events.length === 1 && h.events[0].type === 'setupStarted';
    await exec('git', ['worktree', 'add', h.worktree]);
    return h.worktree;
  }, BRANCH);
  assert.equal(path, h.worktree);
  assert.ok(markedFirst, 'setupStarted before any git');
  assert.deepEqual(whileRunning, [true, 1], 'a viewer attaches it over the pty socket while it runs');
  assert.deepEqual(h.events.map(withoutRows), [
    { type: 'setupStarted', activityId: ACTIVITY, consoleId: ID },
    { type: 'setupStep', activityId: ACTIVITY }, { type: 'setupStep', activityId: ACTIVITY }, // prepared, then the plan
    { type: 'setupStep', activityId: ACTIVITY, step: 'RUN pnpm install' }, { type: 'setupStep', activityId: ACTIVITY, step: 'RUN pnpm install' },
    { type: 'setupEnded', activityId: ACTIVITY },
  ]);
  assert.deepEqual(h.store.channels(), [{ id: CHANNEL, kind: 'setup', label: 'Setup worktree', status: 'done' }]);
  const view = h.store.history(CHANNEL);
  const git = `${cmd(`git worktree add ${escaped(h.worktree)}`)}${MS}`;
  assert.match(shown(view?.history), new RegExp(`${HEADER.source}${git}${GIT_DIR}${cmd('RUN pnpm install')}added 12 packages\\r\\n${MS}${SETUP_OK_LINE}$`));
  assert.match(shown(view?.history), /setup ok · 1 steps · /);
  assert.ok(!(view?.history ?? '').includes(h.gitDir), 'a successful command\'s stdout is never written');
  assert.deepEqual([view?.live, h.ptys.has(ID)], [[], false], 'ended: in the history, gone from the host');
});

test('a worktree already there and set up prepares with the plain exec: no mark, no run; a new one (no folder yet) is marked before any git (#351)', async (t) => {
  const done = await harness(t, 'RUN pnpm install', quiet);
  await writeFile(join(done.gitDir, SETUP_MARKER), '');
  const execs: Exec[] = [];
  await runTaskSetup(done.deps, TASK, ACTIVITY, done.workspace, done.worktree, async (exec) => { execs.push(exec); return done.worktree; }, BRANCH);
  assert.deepEqual([execs, done.events, done.store.channels()], [[done.deps.exec], [], []]);
  const fresh = await harness(t, 'RUN pnpm install', quiet);
  const git: string[][] = [];
  const exec: Exec = async (file, args) => { git.push(args); return fresh.deps.exec(file, args); };
  let before: string[][] = [];
  await runTaskSetup({ ...fresh.deps, exec }, TASK, ACTIVITY, fresh.workspace, join(fresh.worktree, 'new'), async (logged) => { before = [...git]; return prepareIn(fresh.worktree)(logged); }, BRANCH);
  assert.deepEqual(before, [], 'no git before the mark for a new worktree');
  assert.deepEqual(fresh.events.map((e) => e.type), ['setupStarted', 'setupStep', 'setupStep', 'setupStep', 'setupStep', 'setupEnded']);
});

test('a git command that fails writes its message under it and ends the run with it; setupEnded still comes and the failure is rethrown (#351)', async (t) => {
  const h = await harness(t, 'RUN pnpm install', quiet);
  const exec: Exec = async (_file, args) => {
    if (args[0] === 'worktree') throw new Error('fatal: invalid reference: nope');
    return h.deps.exec('git', args);
  };
  await assert.rejects(runTaskSetup({ ...h.deps, exec }, TASK, ACTIVITY, h.workspace, h.worktree, prepareIn(h.worktree), BRANCH), { message: 'fatal: invalid reference: nope' });
  assert.deepEqual(h.events.map((e) => e.type), ['setupStarted', 'setupStep', 'setupEnded']); // the failed git's end fails both rows
  assert.match(shown(h.store.history(CHANNEL)?.history), new RegExp(`\\r\\n${cmd('git worktree add [^\\r]*')}${fail('fatal: invalid reference: nope')}${fail('fatal: invalid reference: nope')}$`));
});

test('a failed or stopped setup ends its run with the failure\'s first line, still dispatches setupEnded, and rethrows for the spawn\'s spawnFailed (#351)', async (t) => {
  const failing: RunShell = async () => {
    throw new RunFailure(1, 'npm ERR! TOKEN=secret');
  };
  const h = await harness(t, 'RUN pnpm install', failing);
  await assert.rejects(runTaskSetup(h.deps, TASK, ACTIVITY, h.workspace, h.worktree, prepareIn(h.worktree), BRANCH), { message: 'setup failed at step 1 of 1 (line 1, RUN pnpm install): the command exited with code 1\nnpm ERR! TOKEN=secret' });
  assert.deepEqual(h.events.at(-1), { type: 'setupEnded', activityId: ACTIVITY });
  assert.equal(h.store.channels()[0]?.status, 'failed', 'the console chip reads the failed setup (#537)');
  const history = h.store.history(CHANNEL)?.history ?? '';
  assert.match(shown(history), new RegExp(`\\r\\n${cmd('RUN pnpm install')}${fail('setup failed at step 1 of 1 \\(line 1, RUN pnpm install\\): the command exited with code 1')}$`));
  assert.ok(!history.includes('TOKEN=secret'), 'the tail stays on the task\'s error');
  const stopped = await harness(t, 'RUN pnpm install', quiet);
  await assert.rejects(runTaskSetup(stopped.deps, TASK, ACTIVITY, stopped.workspace, stopped.worktree, prepareIn(stopped.worktree), { ...BRANCH, signal: AbortSignal.abort() }), { message: 'setup failed at step 1 of 1 (line 1, RUN pnpm install): stopped' });
});

test('the setups of two tasks are runs of the one Setup worktree channel: each keeps its own run id, and its header names its task (#351)', async (t) => {
  const h = await harness(t, 'RUN pnpm install', quiet);
  const other: Task = { ...TASK, item: { ...TASK.item, itemId: 'board:I2', id: '2', title: 'Task 2' } };
  const second = await harness(t, 'RUN pnpm install', quiet); // its own worktree and git dir, the first one's console
  await runTaskSetup(h.deps, TASK, ACTIVITY, h.workspace, h.worktree, prepareIn(h.worktree), BRANCH);
  await runTaskSetup({ ...second.deps, consoleStore: h.store, ptys: h.ptys }, other, OTHER_ACTIVITY, second.workspace, second.worktree, prepareIn(second.worktree), BRANCH);
  assert.deepEqual([h.events[0], second.events[0]].map(withoutRows), [
    { type: 'setupStarted', activityId: ACTIVITY, consoleId: 'setup:board:I1' },
    { type: 'setupStarted', activityId: OTHER_ACTIVITY, consoleId: 'setup:board:I2' },
  ]);
  assert.deepEqual(h.store.channels(), [{ id: CHANNEL, kind: 'setup', label: 'Setup worktree', status: 'done' }]);
  const runs = (h.store.history(CHANNEL)?.history ?? '').match(/── #\d+ · /g);
  assert.deepEqual(runs, ['── #1 · ', '── #2 · ']);
  assert.match(shown(h.store.history(CHANNEL)?.history), new RegExp(`${SETUP_OK_LINE}── #2 [^\\n]*\\n[\\s\\S]*${SETUP_OK_LINE}$`));
});

test('removeInRun runs the teardown inside the removal, after git\'s checks and before the remove, in a teardown run ended by its summary; it writes the marker and dispatches nothing (#654)', async (t) => {
  const order: string[] = [];
  const h = await harness(t, '', async () => { order.push('teardown'); });
  const workspace: Workspace = { ...h.workspace, teardown: 'RUN docker compose down' };
  await removeInRun(h.deps, { ...TEARDOWN, workspace }, async (before) => {
    order.push('checks');
    await before?.(h.worktree, true);
    order.push('remove');
  });
  assert.deepEqual(order, ['checks', 'teardown', 'remove']);
  assert.ok(await access(join(h.gitDir, TEARDOWN_MARKER)).then(() => true, () => false));
  assert.deepEqual(h.events, [], 'a teardown has no progress line on the task');
  const teardownOk = 'ESC\\[32mteardown ok · 1 steps · \\d+msESC\\[0m\\r\\n';
  assert.match(shown(h.store.history(CHANNEL)?.history), new RegExp(`^${TEARDOWN_HEADER}${COMMON_DIR}${cmd('RUN docker compose down')}${MS}${teardownOk}$`));
});

test('removeInRun writes why it skipped: already torn down, worktree gone, no teardown lines, and forced, where remove gets no hook; each ends clean (#654)', async (t) => {
  const h = await harness(t, '', quiet);
  const workspace: Workspace = { ...h.workspace, teardown: 'RUN docker compose down' };
  await writeFile(join(h.gitDir, TEARDOWN_MARKER), '');
  const hooks: (string | undefined)[] = [];
  await removeInRun(h.deps, { ...TEARDOWN, workspace }, async (before) => before?.(h.worktree, true));
  await removeInRun(h.deps, { ...TEARDOWN, workspace }, async (before) => before?.(h.worktree, false));
  await removeInRun(h.deps, { ...TEARDOWN, workspace: h.workspace }, async (before) => before?.(h.worktree, true));
  await removeInRun(h.deps, { ...TEARDOWN, workspace, force: true }, async (before) => { hooks.push(typeof before); });
  assert.deepEqual(hooks, ['undefined'], 'force: no teardown hook');
  const skips = (h.store.history(CHANNEL)?.history ?? '').match(/teardown skipped: [^\r]+/g);
  assert.deepEqual(skips, ['teardown skipped: already torn down', 'teardown skipped: worktree gone', 'teardown skipped: no teardown lines', 'teardown skipped: forced']);
  assert.equal(h.store.channels()[0]?.status, 'done');
});

test('a failing teardown step rejects removeInRun with its message before the remove, ends the run red and writes no marker; a run for an orphan is labelled by its slug (#654)', async (t) => {
  const h = await harness(t, '', async () => { throw new RunFailure(1, 'Error: no such service'); });
  const workspace: Workspace = { ...h.workspace, teardown: 'RUN docker compose down' };
  let removed = false;
  const target = { id: 'teardown:hive:hive-9-gone', label: 'hive-9-gone', workspace, force: false };
  await assert.rejects(removeInRun(h.deps, target, async (before) => { await before?.(h.worktree, true); removed = true; }), { message: 'teardown failed at step 1 of 1 (line 1, RUN docker compose down): the command exited with code 1\nError: no such service' });
  assert.equal(removed, false);
  assert.equal(await access(join(h.gitDir, TEARDOWN_MARKER)).then(() => true, () => false), false);
  assert.equal(h.store.channels()[0]?.status, 'failed');
  const history = shown(h.store.history(CHANNEL)?.history);
  assert.match(history, /^── hive-9-gone · teardown · /);
  assert.match(history, new RegExp(`${fail('teardown failed at step 1 of 1 \\(line 1, RUN docker compose down\\): the command exited with code 1')}$`));
});

test('a git refusal before the teardown is reached propagates unchanged and ends the run clean, with no red teardown failure line (#654)', async (t) => {
  const h = await harness(t, '', quiet);
  const workspace: Workspace = { ...h.workspace, teardown: 'RUN docker compose down' };
  await assert.rejects(removeInRun(h.deps, { ...TEARDOWN, workspace }, async () => { throw new Error('contains modified files'); }), { message: 'contains modified files' });
  assert.equal(h.store.channels()[0]?.status, 'done');
  const history = h.store.history(CHANNEL)?.history ?? '';
  assert.doesNotMatch(history, /failed/);
  assert.match(history, /teardown skipped: removal refused/);
});

test('runTaskSetup deletes the teardown marker of a worktree on disk before it reads isSetUp: a worktree used again gets its teardown on the next removal (#654)', async (t) => {
  const h = await harness(t, 'RUN pnpm install', quiet);
  await writeFile(join(h.gitDir, SETUP_MARKER), '');
  await writeFile(join(h.gitDir, TEARDOWN_MARKER), '');
  await runTaskSetup(h.deps, TASK, ACTIVITY, h.workspace, h.worktree, async () => h.worktree, BRANCH);
  assert.equal(await access(join(h.gitDir, TEARDOWN_MARKER)).then(() => true, () => false), false);
  assert.deepEqual(h.events, [], 'set up already: still no run');
});

test('a task\'s setup writes worktree.step for each step with its activity and phase, error on a failure, never the line (#742)', async (t) => {
  const failing: RunShell = async () => {
    throw new RunFailure(1, 'TOKEN=secret');
  };
  const h = await harness(t, 'RUN pnpm install', failing);
  const { facts, records } = fakeFacts();
  await assert.rejects(runTaskSetup({ ...h.deps, facts }, TASK, ACTIVITY, h.workspace, h.worktree, prepareIn(h.worktree), BRANCH));
  assert.deepEqual(records.map((r) => ({ ...(r as unknown as Record<string, unknown>), duration_ms: 0 })),
    [{ event: 'worktree.step', level: 'error', activity_id: ACTIVITY, phase: 'setup', index: 0, kind: 'RUN', duration_ms: 0, outcome: 'failed' }]);
  assert.ok(!JSON.stringify(records).includes('pnpm'));
  assert.ok(!JSON.stringify(records).includes('secret'));
});

test('a task\'s setup dispatches its rows on every change: the worktree and branch running from the mark and done once prepared, then each step queued, running and done in order; its run is a console group of its own (#390)', async (t) => {
  const h = await harness(t, 'RUN one\nRUN two', quiet);
  await runTaskSetup(h.deps, TASK, ACTIVITY, h.workspace, h.worktree, prepareIn(h.worktree), BRANCH);
  assert.deepEqual(rowsOf(h.events).map(statuses), [
    'running running', 'done done', 'done done queued queued', 'done done running queued', 'done done done queued', 'done done done running', 'done done done done',
  ]);
  const [worktree, branch, ...steps] = rowsOf(h.events).at(-1) ?? [];
  assert.ok(Number.isInteger(worktree?.durationMs), 'the worktree row has its time');
  assert.deepEqual(branch, { kind: 'branch', status: 'done', ...BRANCH }, 'the branch row none');
  assert.deepEqual(steps.map(({ durationMs: _ms, ...row }) => row), [
    { kind: 'step', status: 'done', header: 'RUN one', label: 'one' }, { kind: 'step', status: 'done', header: 'RUN two', label: 'two' },
  ]);
  const stepsShown = h.events.flatMap((e) => (e.type === 'setupStep' ? [e.step] : []));
  assert.deepEqual(stepsShown, [undefined, undefined, 'RUN one', 'RUN one', 'RUN two', 'RUN two'], 'the flow card\'s step goes with the rows');
  assert.match(h.store.history(CHANNEL, ID)?.history ?? '', /^── #1 · setup · /, 'GET /console/setup?run=<id> reads this task\'s runs');
});

test('a RUN that fails marks its row failed with its exit code; a git failure marks the worktree and branch rows failed with no code (#390)', async (t) => {
  const failing: RunShell = async () => { throw new RunFailure(1, ''); };
  const h = await harness(t, 'RUN pnpm install', failing);
  await assert.rejects(runTaskSetup(h.deps, TASK, ACTIVITY, h.workspace, h.worktree, prepareIn(h.worktree), BRANCH));
  const failed = rowsOf(h.events).at(-1) ?? [];
  assert.deepEqual([statuses(failed), failed[2]?.code], ['done done failed', '1']);
  const git = await harness(t, 'RUN pnpm install', quiet);
  const refusing: Exec = async (_file, args) => {
    if (args[0] === 'worktree') throw new Error('fatal: invalid reference: nope');
    return git.deps.exec('git', args);
  };
  await assert.rejects(runTaskSetup({ ...git.deps, exec: refusing }, TASK, ACTIVITY, git.workspace, git.worktree, prepareIn(git.worktree), BRANCH));
  assert.deepEqual((rowsOf(git.events).at(-1) ?? []).map(({ kind, status, code }) => [kind, status, code]), [['worktree', 'failed', undefined], ['branch', 'failed', undefined]]);
});
