import { localActivityId, recordOf } from './activities.js';
import type { Activity, Session, Worker, State } from './types.js';

// The local session (#587) and a copy's destination, as the reducer, the routes and the UI read them. No Node import: the UI bundles it.

/** A task a copy can go to (#587): its live activity's worktree, or its checkout (#444), is on disk. */
export const hasDirectory = (activity: Pick<Activity, 'worktree' | 'worktreeGone'> | undefined): boolean => activity?.worktree !== undefined && !activity.worktreeGone;

/** A workspace's local sessions, oldest first: its local activity's record's (#629). */
export const localSessionsOf = (state: Pick<State, 'activityRecords'>, workspace: string): Session[] => recordOf(state, localActivityId(workspace))?.sessions ?? [];

/** The live worker running local session `sessionId` of `workspace`, if any. */
export const localWorker = (workers: Worker[], workspace: string, sessionId: string): Worker | undefined =>
  workers.find((s) => s.status !== 'empty' && s.activityId === localActivityId(workspace) && s.sessionId === sessionId);

/** The local sessions no live run holds (#587): two terminals on one transcript would corrupt it, as continuable says for a task's. */
export const continuableLocal = (state: Pick<State, 'activityRecords' | 'workers'>, workspace: string): Session[] =>
  localSessionsOf(state, workspace).filter((s) => localWorker(state.workers, workspace, s.id) === undefined);

/** A copy's run still before its SessionStart (#587) holds a temporary <from>.jsonl in `dir`: a second copy there, or a --resume of `from` from
 * there, would share the file its SessionStart removes. */
export const copyPending = (workers: Worker[], from: string, dir: string): boolean =>
  workers.some((s) => s.status !== 'empty' && s.copyOf?.from === from && s.copyOf.dir === dir);
