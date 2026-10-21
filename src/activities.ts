import type { Activity, ActivityRecord, ForkSyncResult, Session, StageEvaluate, State, Task, TaskPr, TaskUsage, Terminal, UsagePart, Worker } from './types.js';

// The activity's two records in State (#629): the reads the reducer, the routes and the UI share. No Node import, since the UI bundles it, and
// no import of tasks.ts, which imports this file.

/** What these reads take of the State. */
export type WorkState = Pick<State, 'activities' | 'activityRecords'>;

const LOCAL_PREFIX = 'local:';

/** A workspace's local activity id (#629): WORKSPACE_NAME keeps it safe in a URL segment, and no randomUUID starts with it. */
export const localActivityId = (workspace: string): string => `${LOCAL_PREFIX}${workspace}`;
export const isLocalActivityId = (id: string): boolean => id.startsWith(LOCAL_PREFIX);
/** The workspace a local activity id names; undefined on a task's activity. What a pty spawner with no state reads (#629). */
export const localWorkspaceOf = (id: string): string | undefined => (isLocalActivityId(id) ? id.slice(LOCAL_PREFIX.length) : undefined);

/** The record with that id. */
export const recordOf = (state: Pick<State, 'activityRecords'>, id: string): ActivityRecord | undefined =>
  state.activityRecords.find((r) => r.id === id);

/** Every record listing the task, in creation order (oldest first). */
export const recordsOf = (state: Pick<State, 'activityRecords'>, taskId: string): ActivityRecord[] =>
  state.activityRecords.filter((r) => r.taskIds.includes(taskId));

/** The id the details panel names for a task's files (#629): its live activity's, else its newest record's after a delete; undefined with neither. */
export const workIdOf = (state: WorkState, taskId: string): string | undefined => (activityOf(state, taskId) ?? recordsOf(state, taskId).at(-1))?.id;

/** The task's live activity: the one whose record lists it. At most one does at any time (#629). */
export function activityOf(state: WorkState, taskId: string): Activity | undefined {
  const ids = new Set(recordsOf(state, taskId).map((r) => r.id));
  return state.activities.find((a) => ids.has(a.id));
}

/** The slug of the task's live activity (#629): what a kill names; '' with none. */
export const slugOf = (state: WorkState, taskId: string): string => activityOf(state, taskId)?.slug ?? '';

/** What {result.<path>} reads (#99): every record's result of the task merged oldest first, a newer key winning. */
export function resultOf(state: Pick<State, 'activityRecords'>, taskId: string): Record<string, unknown> | undefined {
  const results = recordsOf(state, taskId).flatMap((r) => (r.result === undefined ? [] : [r.result]));
  // fromEntries defines each key as an own property, so a loaded `__proto__` stays a key instead of swapping the prototype as assign would
  return results.length === 0 ? undefined : Object.fromEntries(results.flatMap((r) => Object.entries(r)));
}

/** Every PR the task's activities opened, oldest record first (#207). */
export const prsOf = (state: Pick<State, 'activityRecords'>, taskId: string): TaskPr[] => recordsOf(state, taskId).flatMap((r) => r.prs ?? []);

type UsageCounts = Pick<UsagePart, 'tokens' | 'ms' | 'waitingMs'>;
const summed = (a: UsageCounts, b: UsageCounts): UsageCounts => ({ tokens: a.tokens + b.tokens, ms: a.ms + b.ms, waitingMs: a.waitingMs + b.waitingMs });
const ZERO: UsageCounts = { tokens: 0, ms: 0, waitingMs: 0 };

// #617: a pair seen again adds to its own part, a new one is appended, so the parts read as the task's path through the stages. Summing with
// ZERO copies only the three counts, so a Worker passed as the key or the counts never leaks its own fields into a part
function addToParts(parts: readonly UsagePart[], key: Pick<UsagePart, 'stage' | 'agent'>, add: UsageCounts): UsagePart[] {
  const at = parts.findIndex((p) => p.stage === key.stage && p.agent === key.agent);
  if (at >= 0) return parts.map((p, i) => (i === at ? { ...p, ...summed(p, add) } : p));
  return [...parts, { ...(key.stage === undefined ? {} : { stage: key.stage }), ...(key.agent === undefined ? {} : { agent: key.agent }), ...summed(add, ZERO) }];
}

/** `add` joined to the total and to the (stage, agent) part of `key` (#617): a worker passes itself, its stage and agent being the key. */
export const addUsage = (usage: TaskUsage, key: Pick<UsagePart, 'stage' | 'agent'>, add: UsageCounts): TaskUsage =>
  ({ ...summed(usage, add), parts: addToParts(usage.parts, key, add) });

/** Two usages summed part by part (#617), `sum`'s parts first. The totals add as they are, so a part a load dropped never shrinks them. */
export const mergeUsage = (sum: TaskUsage, next: TaskUsage): TaskUsage =>
  ({ ...summed(sum, next), parts: next.parts.reduce((parts, p) => addToParts(parts, p, p), sum.parts) });

/** What every run of the task added up to (#248), summed over its records part by part (#617); undefined while none recorded anything. */
export function usageOf(state: Pick<State, 'activityRecords'>, taskId: string): TaskUsage | undefined {
  const used = recordsOf(state, taskId).flatMap((r) => (r.usage === undefined ? [] : [r.usage]));
  return used.length === 0 ? undefined : used.reduce(mergeUsage);
}

/** The records still owed to someone (#629): one stays while a live activity shares its id or one of its tasks is in the Hive. The same
 * object when nothing goes. */
export function pruneRecords<S extends WorkState & Pick<State, 'tasks'>>(state: S): S {
  const live = new Set(state.activities.map((a) => a.id));
  const tasks = new Set(state.tasks.map((t) => t.item.itemId));
  const kept = state.activityRecords.filter((r) => live.has(r.id) || r.taskIds.some((id) => tasks.has(id)));
  return kept.length === state.activityRecords.length ? state : { ...state, activityRecords: kept };
}

// #861: a task activity whose tasks all left stays while its worktree is on disk and nothing runs, deletes or checks out there: a returning task
// finds it through recordsOf, and Settings › worktrees lists it until its removal marks it worktreeGone
const isKept = (a: Activity): boolean =>
  a.worktree !== undefined && a.worktreeGone === undefined && a.workerId === undefined && a.deleting === undefined && a.local === undefined
  && a.setup === undefined && a.ci === undefined;

/** A task's activity outlives none of its tasks (#629): once every task its record lists has left the Hive (dropTask, closeTask, closeMissing,
 * the last stage, a stage that vanished), it goes, and then pruneRecords, unless isKept holds it (#861). Local activities stay. The same object when nothing goes. */
export function pruneWork(state: State): State {
  const tasks = new Set(state.tasks.map((t) => t.item.itemId));
  const orphan = (a: Activity): boolean => a.kind === 'task' && !isKept(a) && !(recordOf(state, a.id)?.taskIds.some((id) => tasks.has(id)) ?? false);
  const activities = state.activities.filter((a) => !orphan(a));
  return pruneRecords(activities.length === state.activities.length ? state : { ...state, activities });
}

/** `state` with `activity` in place of the one with its id. */
export const withActivity = (state: State, activity: Activity): State =>
  ({ ...state, activities: state.activities.map((a) => (a.id === activity.id ? activity : a)) });

/** `state` with `record` in place of the one with its id. */
export const withRecord = (state: State, record: ActivityRecord): State =>
  ({ ...state, activityRecords: state.activityRecords.map((r) => (r.id === record.id ? record : r)) });

/** Every workspace's local activity and record (#590, #629): one per name in `state.workspaces`, born when missing, removed with its
 * workspace. Boot and setWorkspaces run it; the same object when nothing changes. */
export function withLocalActivities(state: State): State {
  const wanted = new Set(state.workspaces.map(localActivityId));
  const activities = state.activities.filter((a) => a.kind !== 'local' || wanted.has(a.id));
  const records = state.activityRecords.filter((r) => !isLocalActivityId(r.id) || wanted.has(r.id));
  const missing = state.workspaces.filter((ws) => !activities.some((a) => a.id === localActivityId(ws)));
  const unrecorded = state.workspaces.filter((ws) => !records.some((r) => r.id === localActivityId(ws)));
  if (missing.length === 0 && unrecorded.length === 0 && activities.length === state.activities.length && records.length === state.activityRecords.length) return state;
  const born = missing.map((workspace): Activity => ({ id: localActivityId(workspace), kind: 'local', workspace }));
  return {
    ...state,
    activities: [...activities, ...born],
    activityRecords: [...records, ...unrecorded.map((ws): ActivityRecord => ({ id: localActivityId(ws), taskIds: [], sessions: [] }))],
  };
}

/** A workspace's local pair, born on demand for a known workspace: a state built before boot (a test, a first setup) still has one. */
export const ensureLocal = (state: State, workspace: string): State => (state.workspaces.includes(workspace) ? withLocalActivities(state) : state);

/** The record of the task holding session `sessionId`: where its open, clear and copy act (#629). */
export const recordWithSession = (state: Pick<State, 'activityRecords'>, taskId: string, sessionId: string): ActivityRecord | undefined =>
  recordsOf(state, taskId).find((r) => r.sessions.some((s) => s.id === sessionId));

/** The record holding session `sessionId` and the session (#347): a task's record (a deleted activity's `repo` one too) or a workspace's local
 * one. Session ids are uuids, so at most one record holds it. */
export const heldSession = (state: Pick<State, 'activityRecords'>, sessionId: string): { record: ActivityRecord; session: Session } | undefined =>
  state.activityRecords.flatMap((record) => record.sessions.filter((s) => s.id === sessionId).map((session) => ({ record, session })))[0];

/** The occupied workers running in the activity (#629). */
export const workersIn = (workers: Worker[], activityId: string | undefined): Worker[] =>
  (activityId === undefined ? [] : workers.filter((w) => w.status !== 'empty' && w.activityId === activityId));

/** The live terminals of the activity (#629): a sleeping one (#696) holds no pty and runs nothing. */
export const terminalsIn = (terminals: Terminal[], activityId: string | undefined): Terminal[] =>
  (activityId === undefined ? [] : terminals.filter((t) => t.activityId === activityId && t.asleep === undefined));

/** Every plain terminal the activity keeps (#696), live or asleep, in open order: what numbers them and what its lines list. */
export const keptTerminalsIn = (terminals: Terminal[], activityId: string): Terminal[] =>
  terminals.filter((t) => t.activityId === activityId && t.command === undefined);

/** The task an activity works on: its record's first task (#629); undefined on a local activity, or once that task left. */
export function taskOfActivity(state: Pick<State, 'tasks' | 'activityRecords'>, activityId: string): Task | undefined {
  const first = recordOf(state, activityId)?.taskIds[0];
  return first === undefined ? undefined : state.tasks.find((t) => t.item.itemId === first);
}

/** The task that holds a PR (#758): the task of the live activity whose record lists the link, else the first task, in the State's order, one
 * of whose records lists it; none for a PR the Hive did not open. */
export function taskOfPr(state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, url: string): Task | undefined {
  const holds = (record: ActivityRecord): boolean => (record.prs ?? []).some((pr) => pr.url === url);
  const live = state.activityRecords.find((record) => holds(record) && state.activities.some((a) => a.id === record.id));
  if (live !== undefined) return taskOfActivity(state, live.id);
  return state.tasks.find((task) => recordsOf(state, task.item.itemId).some(holds));
}

/** The task a work event names (#629): a live activity's task; '' on an unknown, deleted or local id, which every task handler ignores. */
export const liveTaskId = (state: WorkState & Pick<State, 'tasks'>, activityId: string): string =>
  (state.activities.some((a) => a.id === activityId) ? taskOfActivity(state, activityId)?.item.itemId ?? '' : '');

/** The task an event on a kept session names (#629): its record's first task, a deleted activity's record too; '' when none. */
export const recordTaskId = (state: Pick<State, 'tasks' | 'activityRecords'>, recordId: string): string => taskOfActivity(state, recordId)?.item.itemId ?? '';

export const activityOfWorker = (state: Pick<State, 'activities'>, worker: Worker): Activity | undefined =>
  state.activities.find((a) => a.id === worker.activityId);

/** Wherever a worker's task is needed (hooks, hive_done): its activity's first task; none on a local activity. */
export const taskOfWorker = (state: Pick<State, 'tasks' | 'activityRecords'>, worker: Worker): Task | undefined =>
  (worker.activityId === undefined ? undefined : taskOfActivity(state, worker.activityId));

/** The task that owns the worktree `slug` of `workspace` (#181, #179, #629): the task of the live activity with that slug there. */
export function worktreeOwner(state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, workspace: string, slug: string): Task | undefined {
  const owner = state.activities.find((a) => a.kind === 'task' && a.workspace === workspace && a.slug === slug);
  return owner && taskOfActivity(state, owner.id);
}

/** The task activity of `workspace` with the worktree `slug` whose tasks all left (#861): kept by pruneWork for a task that may return. */
export const keptActivity = (state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, workspace: string, slug: string): Activity | undefined =>
  state.activities.find((a) => a.kind === 'task' && a.workspace === workspace && a.slug === slug && taskOfActivity(state, a.id) === undefined);

/** An activity that holds its slug (#180): a worktree, a run or a session on it. */
export const holdsSlug = (state: Pick<State, 'activityRecords'>, activity: Activity): boolean =>
  activity.worktree !== undefined || (recordOf(state, activity.id)?.sessions.length ?? 0) > 0 || activity.workerId !== undefined;

/** The other task activities' slugs, with their task's id and title (#131, #629): what the start popup's other-tasks list reads git at. */
export const otherSlugs = (state: Pick<State, 'tasks' | 'activities' | 'activityRecords'>, own: Activity | undefined): { slug: string; id: string; title: string }[] =>
  state.activities.flatMap((a) => {
    const task = a !== own && a.slug !== undefined ? taskOfActivity(state, a.id) : undefined;
    return task && a.slug !== undefined ? [{ slug: a.slug, id: task.item.id, title: task.item.title }] : [];
  });

/** forkSynced (#854): the sync on its activity, a new object; an unknown activity leaves the state as it is. */
export function withForkSync(state: State, { activityId, sync }: { activityId: string; sync: ForkSyncResult }): State {
  const activity = state.activities.find((a) => a.id === activityId);
  return activity === undefined ? state : withActivity(state, { ...activity, sync });
}

/** The stage run that holds a worker with no session on the activity (#727, #877): a commands stage's or an evaluation's. What frees, counts and
 * times that worker, which holds no activity of its own. */
export const heldRun = (a: Pick<Activity, 'commands' | 'evaluate'> | undefined): Pick<StageEvaluate, 'stage' | 'workerId'> | undefined => a?.commands ?? a?.evaluate;
