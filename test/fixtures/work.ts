import { activityOf, localActivityId, recordsOf } from '../../src/activities.js';
import { slugFor } from '../../src/tasks.js';
import type { Activity, ActivityRecord, Effect, HiveEvent, Session, State, Task } from '../../src/types.js';

// What a fixture sets instead of the work fields Task no longer has (#629): the task's live activity and its record, a record alone (a deleted
// activity's), or a workspace's local pair. Deterministic ids, so a test can name them in a route or an assertion.

type Made = Partial<Omit<ActivityRecord, 'id' | 'taskIds'>>;

/** A saved task activity's id (#629): loadActivity keeps only the uuid shape randomUUID writes, so a fixture saved to disk uses this one. */
export const savedActivityId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The id a fixture gives a task's activity. */
export const activityIdOf = (itemId: string): string => `a-${itemId}`;

/** The id a work event names for the task (#629): its live activity's, else its newest record's (a deleted activity's kept session); 'none'
 * when it has neither, which every handler ignores, as an unknown task before. */
export const workId = (state: Pick<State, 'activities' | 'activityRecords'>, itemId: string): string =>
  activityOf(state, itemId)?.id ?? recordsOf(state, itemId).at(-1)?.id ?? 'none';

/** A work route's prefix on a live server (#629): /activities/ and the task's work id, encoded. */
export const workPath = (server: { getState(): State | undefined }, itemId: string): string =>
  `/activities/${encodeURIComponent(workId(server.getState()!, itemId))}`;

const without = <T extends { id: string }>(list: T[], id: string): T[] => list.filter((entry) => entry.id !== id);

/** `state` with the task's live activity and its record, replacing a pair already under that id. */
export function withWork(state: State, itemId: string, work: Partial<Activity> = {}, made: Made = {}): State {
  const { activity, record } = taskPairOf(itemId, work, made);
  return { ...state, activities: [...without(state.activities, activity.id), activity], activityRecords: [...without(state.activityRecords, record.id), record] };
}

/** `state` with a record alone: the work of an activity already deleted. */
export function withKeptRecord(state: State, itemId: string, id: string, made: Made = {}): State {
  return { ...state, activityRecords: [...without(state.activityRecords, id), { id, taskIds: [itemId], sessions: [], ...made }] };
}

/** `state` with a workspace's local activity and its record. */
export function withLocal(state: State, workspace: string, sessions: Session[] = []): State {
  const id = localActivityId(workspace);
  return {
    ...state,
    activities: [...without(state.activities, id), { id, kind: 'local', workspace }],
    activityRecords: [...without(state.activityRecords, id), { id, taskIds: [], sessions }],
  };
}

/** A workspace's local activity and record, as the dashboard's LocalActivity carries them (#629). */
export function localPairOf(workspace: string, sessions: Session[] = []): { activity: Activity; record: ActivityRecord } {
  const id = localActivityId(workspace);
  return { activity: { id, kind: 'local', workspace }, record: { id, taskIds: [], sessions } };
}

/** Every workspace's local activity and record, as withLocalActivities keeps them in state (#629): what a partial fixture state spreads. */
export function localPairs(workspaces: readonly string[]): Pick<State, 'activities' | 'activityRecords'> {
  const pairs = workspaces.map((workspace) => localPairOf(workspace));
  return { activities: pairs.map((p) => p.activity), activityRecords: pairs.map((p) => p.record) };
}

/** A task's live activity, its record and its records, as the dashboard's TaskActivity carries them (#629): the pair withWork writes. */
export function taskPairOf(itemId: string, work: Partial<Activity> = {}, made: Made = {}): { activity: Activity; record: ActivityRecord; records: ActivityRecord[] } {
  const id = work.id ?? activityIdOf(itemId);
  const activity: Activity = { id, kind: 'task', workspace: 'hive', slug: `hive-${itemId.replace(/[^a-z0-9]+/g, '-')}`, ...work };
  const record: ActivityRecord = { id, taskIds: [itemId], sessions: [], ...made };
  return { activity, record, records: [record] };
}

type Pointed = Pick<State, 'tasks' | 'workers' | 'activities' | 'activityRecords'> & { terminals?: State['terminals'] };

/** `state` with the live activity every worker and terminal points at through activityIdOf, and its record when the fixture has none: a
 * fixture writes its runs and leaves the pair to this (#629). A task no run points at gets nothing, unless it carries worktree fields:
 * movedWork moves those onto its activity. */
export function withPointedWork<S extends Pointed>(state: S): S {
  return movedWork(pointedWork(state));
}

function pointedWork<S extends Pointed>(state: S): S {
  const pointed = new Set([...state.workers.flatMap((w) => (w.activityId === undefined ? [] : [w.activityId])), ...(state.terminals ?? []).map((t) => t.activityId)]);
  const owed = state.tasks.filter((task) => pointed.has(activityIdOf(task.item.itemId)) && !state.activities.some((a) => a.id === activityIdOf(task.item.itemId)));
  const activities = owed.map((task): Activity => ({ id: activityIdOf(task.item.itemId), kind: 'task', workspace: 'hive', slug: slugFor(task.item) }));
  const records = owed.filter((task) => !state.activityRecords.some((r) => r.id === activityIdOf(task.item.itemId)))
    .map((task): ActivityRecord => ({ id: activityIdOf(task.item.itemId), taskIds: [task.item.itemId], sessions: [] }));
  return { ...state, activities: [...state.activities, ...activities], activityRecords: [...state.activityRecords, ...records] };
}

type Ready = Omit<Extract<HiveEvent, { type: 'worktreeReady' }>, 'type' | 'activityId'>;

/** A first open's two events on a live server (#629): createActivity, then worktreeReady on the activity it made (or the one the task has). */
export async function readyOn(server: { dispatch(event: HiveEvent): Promise<Effect[]>; getState(): State | undefined }, taskId: string, ready: Ready): Promise<void> {
  await server.dispatch({ type: 'createActivity', taskId });
  const activityId = activityOf(server.getState()!, taskId)?.id ?? 'none';
  await server.dispatch({ type: 'worktreeReady', activityId, ...ready });
}

// The fields a fixture task may carry that the reducer keeps on its activity (#629): the worktree's, then the run's
const WORK_KEYS: readonly (keyof Activity)[] = [
  'worktree', 'branch', 'worktreeGone', 'local', 'base', 'setup', 'lastSetup', 'deleting',
  'sessionId', 'workerId', 'stopped', 'stoppedAt', 'stageStart', 'error', 'approval', 'handover', 'commands', 'ci', 'tries', 'via', 'freeSessionStage', 'checkpoints',
];
type WorkKey = 'worktree' | 'branch' | 'worktreeGone' | 'local' | 'base' | 'setup' | 'lastSetup' | 'deleting'
  | 'sessionId' | 'workerId' | 'stopped' | 'stoppedAt' | 'stageStart' | 'error' | 'approval' | 'handover' | 'commands' | 'ci' | 'tries' | 'via' | 'freeSessionStage' | 'checkpoints';
const isWorkKey = (key: string): boolean => (WORK_KEYS as readonly string[]).includes(key);

/** A fixture task with the worktree and run fields its activity holds (#629): what a test writes before saveState splits it. */
export type WithWork = Task & Partial<Pick<Activity, WorkKey>>;

/** `state` with each fixture appended as its Task and, when it carries a worktree field, its activity under a saved id and `slugOf`'s slug,
 * born in the task's workspace, and its record. */
// A fixture split into its Task and the worktree fields its activity holds
function split(fixture: WithWork): { task: Task; work: Partial<Activity> } {
  const entries = Object.entries(fixture);
  return {
    task: Object.fromEntries(entries.filter(([key]) => !isWorkKey(key))) as unknown as Task,
    work: Object.fromEntries(entries.filter(([key, v]) => isWorkKey(key) && v !== undefined)) as Partial<Activity>,
  };
}

export function savedTasks(state: State, fixtures: WithWork[], slugOf: (task: Task) => string): State {
  const parts = fixtures.map(split);
  const placed: State = { ...state, tasks: [...state.tasks, ...parts.map((p) => p.task)] };
  let saved = placed;
  parts.forEach(({ task, work }, i) => {
    if (Object.keys(work).length > 0) saved = withWork(saved, task.item.itemId, { id: savedActivityId(i + 1), slug: slugOf(task), workspace: task.workspace ?? 'hive', ...work });
  });
  return saved;
}

type Held = Pick<State, 'tasks' | 'activities' | 'activityRecords'>;

/** `state` with the worktree fields its fixture tasks still carry moved onto each task's activity (#629): the one under activityIdOf, its
 * identity kept and its fields the fixture's alone, born with its record when the fixture has neither, in the task's workspace under
 * slugFor's slug. A task with none of them is left as it is, its activity too. */
export function movedWork<S extends Held>(state: S): S {
  const carrying = state.tasks.filter((c) => Object.keys(c).some((key) => isWorkKey(key)));
  if (carrying.length === 0) return state;
  const ids = new Set(carrying.map((c) => activityIdOf(c.item.itemId)));
  const moved = carrying.map((fixture): Activity => {
    const { task, work } = split(fixture);
    const id = activityIdOf(task.item.itemId);
    const held = state.activities.find((a) => a.id === id);
    const identity: Activity = held ? { id, kind: held.kind, workspace: held.workspace, ...(held.slug === undefined ? {} : { slug: held.slug }) }
      : { id, kind: 'task', workspace: task.workspace ?? 'hive', slug: slugFor(task.item) };
    return { ...identity, ...work };
  });
  const recorded = new Set(state.activityRecords.map((r) => r.id));
  const born = carrying.filter((c) => !recorded.has(activityIdOf(c.item.itemId))).map((c): ActivityRecord => ({ id: activityIdOf(c.item.itemId), taskIds: [c.item.itemId], sessions: [] }));
  return {
    ...state,
    tasks: state.tasks.map((c) => (carrying.includes(c) ? split(c).task : c)),
    activities: [...state.activities.filter((a) => !ids.has(a.id)), ...moved],
    activityRecords: [...state.activityRecords, ...born],
  };
}

/** `state` with `tasks` in place of its own, their worktree fields on their activities (#629). */
export const withTasks = <S extends Held>(state: S, tasks: WithWork[]): S => movedWork({ ...state, tasks });

/** A fixture's Task alone (#629): what the reducer stores, the worktree fields gone to its activity. */
export const bareTask = (fixture: WithWork): Task => split(fixture).task;

/** A fixture's live activity (#629): its worktree fields under activityIdOf and slugFor's slug, in its workspace; none when it carries none. */
export function liveOf(fixture: WithWork): Activity | undefined {
  const { task, work } = split(fixture);
  if (Object.keys(work).length === 0) return undefined;
  return { id: activityIdOf(task.item.itemId), kind: 'task', workspace: task.workspace ?? 'hive', slug: slugFor(task.item), ...work };
}
