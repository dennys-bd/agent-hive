import type { Activity, ActivityRecord, State, Task } from './types.js';

// #861: a save that renamed stages, as one map applied once per value (so A ↔ B swaps), over every State field the audit found naming a
// stage or holding a transitionKey (plan Task 1). The stages and transitions too, so no reduction between this and setStages reads a task in
// a stage the state does not have. Pure: new objects only.

type Rename = (name: string) => string;

// A transitionKey (transitions.ts) is JSON [from, when, verdict]: only `from` names a stage
function rekeyed(key: string, rename: Rename): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return key; // not a transitionKey: nothing in it names a stage
  }
  if (!Array.isArray(parsed)) return key;
  const [from, ...rest]: unknown[] = parsed;
  return typeof from === 'string' ? JSON.stringify([rename(from), ...rest]) : key;
}

const keysRenamed = <T>(map: Record<string, T>, rename: Rename): Record<string, T> =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [rename(key), value]));

function renamedTask(task: Task, stage: Rename): Task {
  const { epic } = task.item;
  return { ...task, stage: stage(task.stage), ...(epic === undefined ? {} : { item: { ...task.item, epic: { ...epic, switchAt: stage(epic.switchAt) } } }) };
}

function renamedActivity(a: Activity, stage: Rename, key: Rename): Activity {
  return {
    ...a,
    ...(a.stageStart === undefined ? {} : { stageStart: { ...a.stageStart, stage: stage(a.stageStart.stage), ...(a.stageStart.after === undefined ? {} : { after: stage(a.stageStart.after) }) } }),
    ...(a.tries === undefined ? {} : { tries: keysRenamed(a.tries, key) }),
    ...(a.via === undefined ? {} : { via: key(a.via) }),
    ...(a.handoffPending === undefined ? {} : { handoffPending: key(a.handoffPending) }),
    ...(a.tryLog === undefined ? {} : { tryLog: a.tryLog.map((r) => ({ ...r, stage: stage(r.stage), transition: key(r.transition) })) }),
    ...(a.freeSessionStage === undefined ? {} : { freeSessionStage: stage(a.freeSessionStage) }),
    ...(a.commands === undefined ? {} : { commands: { ...a.commands, stage: stage(a.commands.stage) } }),
    ...(a.ci === undefined ? {} : { ci: { ...a.ci, stage: stage(a.ci.stage) } }),
    ...(a.checkpoints === undefined ? {} : { checkpoints: a.checkpoints.map((c) => ({ ...c, stage: stage(c.stage) })) }),
    ...(a.stageGone === undefined ? {} : { stageGone: stage(a.stageGone) }),
  };
}

const renamedRecord = (r: ActivityRecord, stage: Rename): ActivityRecord => ({
  ...r, sessions: r.sessions.map((s) => ({ ...s, stages: s.stages.map(stage) })), ...(r.stageRuns === undefined ? {} : { stageRuns: keysRenamed(r.stageRuns, stage) }),
});

/** The state with every stage name and transitionKey under `renames` (old → new), applied once per value; the same object when no value
 * changes. */
export function renameStages(state: State, renames: Record<string, string>): State {
  if (Object.keys(renames).length === 0) return state;
  const stage: Rename = (name) => (Object.hasOwn(renames, name) ? renames[name] : name);
  const key: Rename = (k) => rekeyed(k, stage);
  const next: State = {
    ...state,
    stages: state.stages.map((s) => ({ ...s, name: stage(s.name) })),
    transitions: state.transitions.map((t) => ({ ...t, from: stage(t.from), to: stage(t.to) })),
    tasks: state.tasks.map((t) => renamedTask(t, stage)),
    activities: state.activities.map((a) => renamedActivity(a, stage, key)),
    activityRecords: state.activityRecords.map((r) => renamedRecord(r, stage)),
    usageRules: state.usageRules.map((r) => (r.stage === undefined ? r : { ...r, stage: stage(r.stage) })),
    ...(state.slept === undefined ? {} : { slept: state.slept.map((s) => (s.stage === undefined ? s : { ...s, stage: stage(s.stage) })) }),
  };
  // ponytail: one structural compare per save hands back the same object when no held value is renamed; per-field identity if saves get hot
  return JSON.stringify(next) === JSON.stringify(state) ? state : next;
}
