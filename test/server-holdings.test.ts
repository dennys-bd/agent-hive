import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localActivityId } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import { heldActivities, heldTasks, isRunningIn } from '../src/server-holdings.js';
import { resolveWorkspace } from '../src/tasks.js';
import type { Activity, State, Task, TaskPr, Worker } from '../src/types.js';
import { worktreePath } from '../src/worktree.js';
import { WORKSPACE } from './fakes.js';
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
