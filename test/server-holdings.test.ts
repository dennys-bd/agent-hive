import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express from 'express';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { heldActivities, heldTasks, isRunningIn, registerHoldingsRoute } from '../src/server-holdings.js';
import { resolveWorkspace } from '../src/tasks.js';
import type { Activity, Config, Exec, State, Task, TaskPr, Worker, WorkspaceHoldings } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { WORKSPACE, workspacesAt } from './fakes.js';
import { activityIdOf, withLocal, withWork } from './fixtures/work.js';

// The holdings of WORKSPACE (#750): local tasks local:<n>, each with its live activity in the workspace when a test gives it one, over a repo
// no test touches (git is a fake, and no workspace here has nested repos).
const REPO = '/repo';
const SLUG = (n: number): string => `hive-${n}-task`;
const BRANCH = (n: number): string => `hive/${n}-task`;
const TITLE = (n: number): string => `HIVE-${n} Task ${n}`;
const ON_DISK = (n: number): Partial<Activity> => ({ worktree: worktreePath(REPO, SLUG(n)), branch: BRANCH(n) });
const task = (n: number, extra: Partial<Task> = {}): Task => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: WORKSPACE, ...extra,
});
const running = (activityId: string): Worker => ({ id: 'W1', activityId, status: 'working' });

type Work = Partial<Activity> & { prs?: TaskPr[] };
// The tasks and the workspace's local pair; each task `work` names gets its live activity under SLUG(n), its record holding `prs`
function stateOf(tasks: Task[], work: Record<number, Work> = {}, extra: Partial<State> = {}): State {
  const base = withLocal({ ...initialState(0), workspaces: [WORKSPACE], tasks, ...extra }, WORKSPACE);
  return Object.entries(work).reduce((s, [n, { prs, ...w }]) => withWork(s, `local:${n}`, { slug: SLUG(Number(n)), ...w }, prs === undefined ? {} : { prs }), base);
}

// A kept activity (#861): its worktree outlived its task; its record may still hold the PRs it opened
const withKept = (state: State, n: number, prs: TaskPr[] = []): State => ({
  ...state,
  activities: [...state.activities, { id: `kept-${n}`, kind: 'task', workspace: WORKSPACE, slug: SLUG(n) }],
  activityRecords: [...state.activityRecords, { id: `kept-${n}`, taskIds: [], sessions: [], prs }],
});

const held = (n: number): { activityId: string; task: { id: string; title: string } } => ({ activityId: activityIdOf(`local:${n}`), task: { id: `local:${n}`, title: TITLE(n) } });

const PR = (n: number): string => `https://github.com/acme/app/pull/${n}`;
const MERGED_TIP = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const LATER_TIP = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5'; // a commit made after the merge
const MERGED_HEAD = { state: 'MERGED', headRefOid: MERGED_TIP };
const mergedPr = (n: number): TaskPr[] => [{ url: PR(n), state: 'merged' }];

// What the fake git and gh answer. merge-base --is-ancestor exits 1 for a branch not in `merged`; `fault` fails that command with git's words
interface World {
  worktrees: readonly (readonly [string, string | null])[]; // slug, branch (null = detached) under REPO/.hive/worktrees
  merged?: string[];
  upstreams?: Record<string, string>; // branch → its upstream ref; none = HEAD is the target
  tips?: Record<string, string>; // branch → rev-parse
  pulls?: Record<string, { state: string; headRefOid: string }>; // gh pr view url
  fault?: 'listing' | 'merge';
}

const listingOf = (worktrees: World['worktrees']): string => [`worktree ${REPO}`, 'HEAD 1111', 'branch refs/heads/main', '',
  ...worktrees.flatMap(([slug, branch]) => [`worktree ${worktreePath(REPO, slug)}`, 'HEAD 2222', branch === null ? 'detached' : `branch refs/heads/${branch}`, ''])].join('\n');

const gitFault = (fault: string): Error => Object.assign(new Error('Command failed: git'), { code: 128, stderr: `fatal: ${fault} broke\n` });

// Every call lands in `calls` as [file, ...args]: git's are ['git', '-C', REPO, <command>, …]
function fakeGit(world: World): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'gh') return { stdout: JSON.stringify(world.pulls?.[args[2] ?? ''] ?? { state: 'OPEN' }) };
    const [, , command, ...rest] = args;
    const branch = (rest.find((arg) => arg.startsWith('refs/heads/')) ?? '').slice('refs/heads/'.length);
    if (command === 'worktree') {
      if (world.fault === 'listing') throw gitFault('listing');
      return { stdout: listingOf(world.worktrees) };
    }
    if (command === 'for-each-ref') return { stdout: world.upstreams?.[branch] === undefined ? '' : `${world.upstreams[branch]}\0\n` };
    if (command === 'merge-base') {
      if (world.fault === 'merge') throw gitFault('merge');
      if (world.merged?.includes(branch)) return { stdout: '' };
      throw Object.assign(new Error('Command failed: git'), { code: 1 });
    }
    if (command === 'rev-parse') return { stdout: `${world.tips?.[branch] ?? LATER_TIP}\n` };
    return { stdout: '' };
  };
  return { exec, calls };
}

// The holdings route alone over `state` and a Comb of WORKSPACE at REPO; log.error's lines land in `errors`
function serve(t: TestContext, state: State, exec: Exec): { url: (name?: string) => string; errors: string[] } {
  const app = express();
  const errors: string[] = [];
  const config = { comb: { workspaces: workspacesAt(REPO) } as Config['comb'] };
  registerHoldingsRoute(app, { exec, log: { info: () => undefined, error: (message: string) => { errors.push(message); } }, requireLive: () => ({ state, runtime: { config, promptsDir: '' } }) });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: (name = WORKSPACE) => `${base}/workspaces/${name}/holdings`, errors };
}

const read = async (url: string): Promise<[number, unknown]> => {
  const res = await fetch(url);
  return [res.status, await res.json()];
};

test('heldActivities answers each task activity of the workspace with its reason: running, deleting, local, nothingToDelete, else removable; a kept activity, another workspace\'s and the local one are not listed (#750)', () => {
  const state = withKept(stateOf([1, 2, 3, 4, 5, 6].map((n) => task(n)), {
    1: ON_DISK(1),
    2: { ...ON_DISK(2), deleting: true },
    3: { local: true, branch: BRANCH(3) },
    4: {},
    5: ON_DISK(5),
    6: { ...ON_DISK(6), workspace: 'site' },
  }, { workers: [running(activityIdOf('local:1'))] }), 9);
  assert.deepEqual(heldActivities(state, WORKSPACE), [
    { ...held(1), removable: false, reason: 'running' },
    { ...held(2), removable: false, reason: 'deleting' },
    { ...held(3), removable: false, reason: 'local' },
    { ...held(4), removable: false, reason: 'nothingToDelete' },
    { ...held(5), removable: true },
  ]);
});

test('isRunningIn is true for a worker on a task activity or on the workspace\'s local activity alone, which is never a holding; false with none, an empty slot or another workspace\'s run (#750)', () => {
  const state = stateOf([task(1)], { 1: ON_DISK(1) });
  assert.equal(isRunningIn(state, WORKSPACE), false, 'no worker');
  assert.equal(isRunningIn({ ...state, workers: [running(activityIdOf('local:1'))] }, WORKSPACE), true, 'a stage run on its task');
  const local = stateOf([], {}, { workers: [running(localActivityId(WORKSPACE))] });
  assert.equal(isRunningIn(local, WORKSPACE), true, 'a session in its checkout');
  assert.deepEqual(heldActivities(local, WORKSPACE), [], 'the local activity is not listed');
  assert.equal(isRunningIn({ ...state, workers: [{ ...running(activityIdOf('local:1')), status: 'empty' }] }, WORKSPACE), false, 'an empty slot runs nothing');
  assert.equal(isRunningIn({ ...state, workers: [running(localActivityId('site'))] }, WORKSPACE), false, 'another workspace\'s run');
});

test('heldTasks lists a task with no activity whose own workspace is the name, not one that only resolves to it, nor one with an activity (#750)', () => {
  const hinted: Task = { item: { itemId: 'local:6', id: 'HIVE-6', title: 'Task 6', body: '', url: '', workspaceHint: WORKSPACE }, stage: 'fila', boardColumn: '', auto: true, created: true };
  const state = stateOf([task(1), task(5), hinted, task(7, { workspace: 'site' })], { 1: ON_DISK(1) });
  assert.equal(resolveWorkspace(hinted, state.workspaces), WORKSPACE, 'its rule places it in the workspace');
  assert.deepEqual(heldTasks(state, WORKSPACE), [{ id: 'local:5', title: TITLE(5) }]);
});

test('GET /workspaces/:name/holdings answers a task activity, its worktree, a kept activity\'s orphan worktree and their unmerged branches, each under its own key; a worker on the activity makes it running (#750)', async (t) => {
  const idle = withKept(stateOf([task(1)], { 1: ON_DISK(1) }), 9);
  const world: World = { worktrees: [[SLUG(1), BRANCH(1)], [SLUG(9), BRANCH(9)]] };
  assert.deepEqual(await read(serve(t, idle, fakeGit(world).exec).url()), [200, {
    activities: [{ ...held(1), removable: true }],
    worktrees: [
      { workspace: WORKSPACE, slug: SLUG(1), path: worktreePath(REPO, SLUG(1)), branch: BRANCH(1), task: { id: 'local:1', activityId: activityIdOf('local:1'), title: TITLE(1), removable: true }, nested: [] },
      { workspace: WORKSPACE, slug: SLUG(9), path: worktreePath(REPO, SLUG(9)), branch: BRANCH(9), orphan: 'kept', nested: [] },
    ],
    branches: [{ slug: SLUG(1), branch: BRANCH(1), target: 'HEAD' }, { slug: SLUG(9), branch: BRANCH(9), target: 'HEAD' }],
    tasks: [],
    running: false,
  }]);
  const [, busy] = await read(serve(t, { ...idle, workers: [running(activityIdOf('local:1'))] }, fakeGit(world).exec).url());
  const holdings = busy as WorkspaceHoldings;
  assert.deepEqual([holdings.running, holdings.activities, holdings.worktrees[0]?.task?.removable], [true, [{ ...held(1), removable: false, reason: 'running' }], false]);
});

test('GET /workspaces/:name/holdings leaves out a branch merged into its upstream and a squash-merged one at its PR\'s head; lists one with a commit after the merge with its target, and an orphan\'s with no gh call (#750)', async (t) => {
  const upstream = (n: number): string => `refs/remotes/origin/${BRANCH(n)}`;
  const state = withKept(stateOf([1, 2, 3].map((n) => task(n)), {
    1: ON_DISK(1),
    2: { ...ON_DISK(2), prs: mergedPr(2) },
    3: { ...ON_DISK(3), prs: mergedPr(3) },
  }), 9, mergedPr(9));
  const git = fakeGit({
    worktrees: [1, 2, 3, 9].map((n): [string, string] => [SLUG(n), BRANCH(n)]),
    upstreams: { [BRANCH(1)]: upstream(1), [BRANCH(3)]: upstream(3) },
    merged: [BRANCH(1)],
    tips: { [BRANCH(2)]: MERGED_TIP, [BRANCH(3)]: LATER_TIP },
    pulls: { [PR(2)]: MERGED_HEAD, [PR(3)]: MERGED_HEAD },
  });
  const [status, body] = await read(serve(t, state, git.exec).url());
  assert.equal(status, 200);
  assert.deepEqual((body as WorkspaceHoldings).branches, [
    { slug: SLUG(3), branch: BRANCH(3), target: upstream(3) },
    { slug: SLUG(9), branch: BRANCH(9), target: 'HEAD' },
  ]);
  assert.ok(git.calls.some((c) => c.includes('merge-base') && c.includes(upstream(1))), 'checked against its upstream');
  assert.deepEqual(git.calls.filter(([file]) => file === 'gh').map((c) => c[3]).sort(), [PR(2), PR(3)], 'the kept record holds a merged PR, and no gh reads it');
});

test('GET /workspaces/:name/holdings answers every list empty and running false for a workspace that holds nothing (#750)', async (t) => {
  assert.deepEqual(await read(serve(t, stateOf([]), fakeGit({ worktrees: [] }).exec).url()), [200, { activities: [], worktrees: [], branches: [], tasks: [], running: false }]);
});

test('GET /workspaces/:name/holdings: 404 for a workspace not in the config, running no git; 500 unexpected for a failing listing or merge check, git\'s words in log.error only (#750)', async (t) => {
  const git = fakeGit({ worktrees: [] });
  assert.deepEqual(await read(serve(t, stateOf([]), git.exec).url('nope')), [404, { error: 'unknown workspace' }]);
  assert.deepEqual(git.calls, []);
  for (const fault of ['listing', 'merge'] as const) {
    const failing = serve(t, stateOf([task(1)], { 1: ON_DISK(1) }), fakeGit({ worktrees: [[SLUG(1), BRANCH(1)]], fault }).exec);
    assert.deepEqual(await read(failing.url()), [500, { error: 'unexpected' }], fault);
    assert.deepEqual(failing.errors, [`holdings ${WORKSPACE}: fatal: ${fault} broke`], fault);
  }
});
