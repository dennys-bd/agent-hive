import { activityOfWorker, withActivity } from './activities.js';
import type { ActivityRecord, Session, Worker, State } from './types.js';

// A /clear (#655): Claude Code ends the conversation and starts a new one in the same process. The run keeps going under the new id, and
// the conversation before it stops existing for the Hive: replaced, not appended. Out of orchestrator.ts, past 400 lines. Pure.

// The cleared entry keeps its place, start, stages and last use; its total and title described the old transcript
function renamed(sessions: Session[], from: string, id: string): Session[] {
  return sessions.map((s) => {
    if (s.id !== from) return s;
    const { tokens: _tokens, name: _name, ...kept } = s;
    return { ...kept, id };
  });
}

// No token baseline: the new transcript starts empty, so its first Stop counts from zero (#248)
function cleared({ tokens: _tokens, ...worker }: Worker, id: string): Worker {
  return { ...worker, sessionId: id };
}

// The record holding the entry (#629): the activity's own, or a deleted activity's record whose kept session a free session runs (#208).
// Session ids are uuids, so the one entry with `from` is the run's.
const renamedRecord = (record: ActivityRecord, from: string, id: string): ActivityRecord =>
  (record.sessions.some((s) => s.id === from) ? { ...record, sessions: renamed(record.sessions, from, id) } : record);

/** The run's session replaced by `id` (#655): on the worker, on the record entry that keeps it, and on its activity's sessionId when it was
 * that one (a stage run's; a free session's entry is renamed alone). The old transcript stays on disk, as the panel's limpar leaves it (#304). */
export function clearSession(state: State, worker: Worker, id: string): State {
  const next: State = { ...state, workers: state.workers.map((s) => (s.runId === worker.runId ? cleared(s, id) : s)) };
  const from = worker.sessionId;
  if (from === undefined) return next;
  const records: State = { ...next, activityRecords: next.activityRecords.map((r) => renamedRecord(r, from, id)) };
  const activity = activityOfWorker(records, worker);
  return activity?.sessionId === from ? withActivity(records, { ...activity, sessionId: id }) : records;
}
