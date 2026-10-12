import { activityOfWorker, withActivity } from './activities.js';
import type { ActivityRecord, Session, Worker, State } from './types.js';

// A /clear (#655): Claude Code ends the conversation and starts a new one in the same process. The run keeps going under the new id, and
// the conversation before it stops existing for the Hive: replaced, not appended. A fork's first SessionStart (#933): a copy of an agent
// that picks its own id (Codex) opened under the Hive's placeholder, and the same entry takes the fork's id, keeping what describes it.
// Out of orchestrator.ts, past 400 lines. Pure.

// The entry keeps its place, start, stages and last use. A clear forgets its total and title, which described the old transcript; a fork
// keeps the dialog's name and the source's total, which the fork holds
function renamed(sessions: Session[], from: string, id: string, keep: boolean): Session[] {
  return sessions.map((s) => {
    if (s.id !== from) return s;
    if (keep) return { ...s, id };
    const { tokens: _tokens, name: _name, ...kept } = s;
    return { ...kept, id };
  });
}

// A clear has no token baseline: the new transcript starts empty, so its first Stop counts from zero (#248). A fork's counts from the source's
function moved(worker: Worker, id: string, keep: boolean): Worker {
  if (keep) return { ...worker, sessionId: id };
  const { tokens: _tokens, ...rest } = worker;
  return { ...rest, sessionId: id };
}

// The record holding the entry (#629): the activity's own, or a deleted activity's record whose kept session a free session runs (#208).
// Session ids are uuids, so the one entry with `from` is the run's.
const renamedRecord = (record: ActivityRecord, from: string, id: string, keep: boolean): ActivityRecord =>
  (record.sessions.some((s) => s.id === from) ? { ...record, sessions: renamed(record.sessions, from, id, keep) } : record);

function moveSession(state: State, worker: Worker, id: string, keep: boolean): State {
  const next: State = { ...state, workers: state.workers.map((s) => (s.runId === worker.runId ? moved(s, id, keep) : s)) };
  const from = worker.sessionId;
  if (from === undefined) return next;
  const records: State = { ...next, activityRecords: next.activityRecords.map((r) => renamedRecord(r, from, id, keep)) };
  const activity = activityOfWorker(records, worker);
  return activity?.sessionId === from ? withActivity(records, { ...activity, sessionId: id }) : records;
}

/** The run's session replaced by `id` (#655): on the worker, on the record entry that keeps it, and on its activity's sessionId when it was
 * that one (a stage run's; a free session's entry is renamed alone). The old transcript stays on disk, as the panel's limpar leaves it (#304). */
export const clearSession = (state: State, worker: Worker, id: string): State => moveSession(state, worker, id, false);

/** A copy's placeholder replaced by the fork's own id (#933): the same rename as clearSession, the entry's name and total and the worker's
 * baseline kept. */
export const renameSession = (state: State, worker: Worker, id: string): State => moveSession(state, worker, id, true);
