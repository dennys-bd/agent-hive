import { randomUUID } from 'node:crypto';
import { activityOf, activityOfWorker, ensureLocal, localActivityId, localWorkspaceOf, recordOf, recordTaskId, recordWithSession, withRecord } from './activities.js';
import { touchFreeSession } from './record-kit.js';
import { canOpenSession, taskId, runningFirst, titled } from './tasks.js';
import { hasDirectory, localSessionsOf, continuableLocal } from './local-sessions.js';
import { ensureActivity, none, type Reduced } from './reducer-kit.js';
import { AGENTS, liveDefaultAgent } from './agents.js';
import type { Activity, AgentId, Session, Effect, HiveEvent, SessionCopy, SessionRef, SessionTarget, Worker, State } from './types.js';

// Copy (#587) and the local session, out of orchestrator.ts and runs.ts, both past 400 lines. Pure: every function returns new objects.

type CopyEvent = Extract<HiveEvent, { type: 'copySession' }>;
type LocalEvent = Extract<HiveEvent, { type: 'openLocalSession' | 'clearLocalSession' | 'newLocalSession' }>;
type Entry = (base: Session) => Session;
interface NewRun { sessionId: string; startedAt: string; worker: Worker; copy: SessionCopy; agent: AgentId }

/** The session a copy starts from (#587): any session a record lists, a live one too (the fork reads the transcript as it is), or a local one. */
export function copySource(state: State, from: SessionRef): Session | undefined {
  return recordOf(state, from.activityId)?.sessions.find((s) => s.id === from.sessionId); // a record: a deleted activity's kept session copies too (#629)
}

/** A copy onto its own task or its own local (#587): refused by the reducer and the route alike. */
export const sameOwner = (from: SessionRef, to: SessionTarget): boolean => from.activityId === to.activityId;

// A workspace's local sessions written to its local record (#629), the pair born first when a state built before boot has none
export function withLocal(state: State, workspace: string, sessions: Session[]): State {
  const ensured = ensureLocal(state, workspace);
  const record = recordOf(ensured, localActivityId(workspace));
  return record ? withRecord(ensured, { ...record, sessions }) : ensured;
}

// A workspace's local activity, what a local session's spawn effect carries (#629); withLocal has made it before any effect reads it
const localActivity = (state: State, workspace: string): Activity =>
  state.activities.find((a) => a.id === localActivityId(workspace)) ?? { id: localActivityId(workspace), kind: 'local', workspace };

// The workspace of a local run: its worker points at a local activity (#629); undefined on a task's run
const localWorkspace = (state: State, worker: Worker): string | undefined => {
  const activity = activityOfWorker(state, worker);
  return activity?.kind === 'local' ? activity.workspace : undefined;
};

// The copy's run (#283, #459): a free session of its own, past the signal, the cap and the budget. Its first delta counts from the
// source's total, which the fork already holds (#248), and the mark names the temporary transcript its SessionStart removes.
function newRun(event: CopyEvent, source: Session): NewRun {
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  const worker: Worker = {
    id: randomUUID(), runId: randomUUID(), status: 'working', startedAt, lastEvent: { kind: 'manualStart' }, sessionId, freeSession: true,
    agent: source.agent, // a copy forks its source: the same agent's transcript (#925)
    ...(source.tokens === undefined ? {} : { tokens: source.tokens }),
    ...(event.copied === undefined ? {} : { copyOf: { from: source.id, dir: event.copied } }),
  };
  return { sessionId, startedAt, worker, agent: source.agent, copy: { from: source.id, ...(event.name === undefined ? {} : { name: event.name }), ...(event.notice === undefined ? {} : { notice: event.notice }) } };
}

// The copy's entry: the dialog's name, shown before the first turn end reads it back from the fork's title, and the source's total
function copyEntry(event: CopyEvent, source: Session): Entry {
  return (base) => ({
    ...base,
    ...(event.name === undefined ? {} : { name: event.name }),
    ...(source.tokens === undefined ? {} : { tokens: source.tokens }),
  });
}

/** A copy (#587): a new session from `from`, with the dialog's name and the source's tokens, spawned as a fork in the target's directory.
 * Refused in silence: an unknown source, its own task or local, a task with no directory or one canOpenSession refuses, an unknown workspace. */
export function copySession(state: State, event: CopyEvent): Reduced {
  const source = copySource(state, event.from);
  if (!source || sameOwner(event.from, event.to)) return none(state);
  const run = newRun(event, source);
  const entry = copyEntry(event, source);
  const local = localWorkspaceOf(event.to.activityId); // a workspace's local activity, born on demand as a local session's own events do (#629)
  if (local !== undefined) return copyToLocal(state, local, run, entry);
  // a task's live activity: a copy needs a directory to land in
  return state.activities.some((a) => a.id === event.to.activityId) ? copyToTask(state, recordTaskId(state, event.to.activityId), run, entry) : none(state);
}

// Into a task: its session list gets the copy (#236), the task goes on top of its stage (#356); the activity's sessionId stays the stage run's
function copyToTask(state: State, id: string, run: NewRun, entry: Entry): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  const live = activityOf(state, id);
  if (!task || !canOpenSession(task, live) || !hasDirectory(live)) return none(state);
  const born = ensureActivity(state, task);
  if (!born) return none(state);
  const touched = touchFreeSession(born.state, task, run.sessionId, run.startedAt, run.agent); // a copy runs no stage (#812); its entry applies on top below
  const holder = recordWithSession(touched, id, run.sessionId);
  const named = holder ? withRecord(touched, { ...holder, sessions: holder.sessions.map((s) => (s.id === run.sessionId ? entry(s) : s)) }) : touched;
  const worker: Worker = { ...run.worker, activityId: born.activity.id };
  const next: State = { ...named, workers: [...named.workers, worker] };
  return {
    state: { ...next, tasks: runningFirst(next.tasks, id, next) },
    effects: [{ type: 'spawnSession', worker, activity: activityOf(next, id) ?? born.activity, task, sessionId: run.sessionId, continues: false, copy: run.copy }], // #812: its mark included
  };
}

// Into a workspace's local: a local session, with no stage and no task
function copyToLocal(state: State, workspace: string, run: NewRun, entry: Entry): Reduced {
  if (!state.workspaces.includes(workspace)) return none(state);
  const worker: Worker = { ...run.worker, activityId: localActivityId(workspace) };
  const created = entry({ id: run.sessionId, startedAt: run.startedAt, stages: [], lastUsedAt: run.startedAt, agent: run.agent });
  const next = withLocal({ ...state, workers: [...state.workers, worker] }, workspace, [...localSessionsOf(state, workspace), created]);
  return { state: next, effects: [{ type: 'spawnSession', worker, activity: localActivity(next, workspace), sessionId: run.sessionId, continues: false, copy: run.copy }] };
}

/** Continue a local session (#587): one continuableLocal offers, in a free session of its workspace, from its last total (#248). */
export function openLocalSession(state: State, { activityId, sessionId }: Extract<LocalEvent, { type: 'openLocalSession' }>): Reduced {
  const workspace = localWorkspaceOf(activityId) ?? '';
  const session = continuableLocal(state, workspace).find((s) => s.id === sessionId);
  if (!session || !state.workspaces.includes(workspace)) return none(state);
  const startedAt = new Date().toISOString();
  const worker: Worker = {
    id: randomUUID(), runId: randomUUID(), activityId: localActivityId(workspace), agent: session.agent, status: 'working', startedAt, lastEvent: { kind: 'manualStart' }, sessionId, freeSession: true,
    ...(session.tokens === undefined ? {} : { tokens: session.tokens }),
  };
  const used = localSessionsOf(state, workspace).map((s) => (s.id === sessionId ? { ...s, lastUsedAt: startedAt } : s));
  const next = withLocal({ ...state, workers: [...state.workers, worker] }, workspace, used);
  return { state: next, effects: [{ type: 'spawnSession', worker, activity: localActivity(next, workspace), sessionId, continues: true }] };
}

/** A new session in a workspace's local activity (#590): a free session of its own, past the signal, the cap and the budget, as a copy
 * into the local is (#587), minus the fork. Its entry is appended at the start, or at its first SessionStart for an agent that picks its own
 * id (#931, recordCapturedSession); forgetFailedLocal and forgetUnopenedLocal drop it if it never opens. */
export function newLocalSession(state: State, { activityId, agent: asked }: Extract<LocalEvent, { type: 'newLocalSession' }>): Reduced {
  const workspace = localWorkspaceOf(activityId) ?? '';
  if (!state.workspaces.includes(workspace)) return none(state);
  const agent = asked ?? liveDefaultAgent(state); // #925: the local route's kind, else the default
  const sessionId = AGENTS[agent].canChooseSessionId ? randomUUID() : undefined; // #931: Codex's comes with its first SessionStart
  const startedAt = new Date().toISOString();
  const held = sessionId === undefined ? {} : { sessionId };
  const worker: Worker = { id: randomUUID(), runId: randomUUID(), activityId: localActivityId(workspace), agent, status: 'working', startedAt, lastEvent: { kind: 'manualStart' }, ...held, freeSession: true };
  const sessions = localSessionsOf(state, workspace);
  const created: Session[] = sessionId === undefined ? [] : [{ id: sessionId, startedAt, stages: [], lastUsedAt: startedAt, agent }];
  const next = withLocal({ ...state, workers: [...state.workers, worker] }, workspace, [...sessions, ...created]);
  return { state: next, effects: [{ type: 'spawnSession', worker, activity: localActivity(next, workspace), ...held, continues: false }] };
}

/** A local session's limpar (#587): one no run holds is forgotten; the route removes its transcript when the deleteActivity scope says so. */
export function clearLocalSession(state: State, { activityId, sessionId }: Extract<LocalEvent, { type: 'clearLocalSession' }>): Reduced {
  const workspace = localWorkspaceOf(activityId) ?? ''; // '' is no workspace: an id that is not a local one changes nothing
  if (!continuableLocal(state, workspace).some((s) => s.id === sessionId)) return none(state);
  return none(withLocal(state, workspace, localSessionsOf(state, workspace).filter((s) => s.id !== sessionId)));
}

/** A turn end on a local run (#587), as withTurn for a task's (#248, #489): the total and the /rename title go to its entry. */
export function withLocalTurn(state: State, worker: Worker, total: number, title?: string): State {
  const workspace = localWorkspace(state, worker);
  if (workspace === undefined) return state;
  const sessions = localSessionsOf(state, workspace).map((s) => (s.id === worker.sessionId ? { ...titled(s, title), tokens: total } : s));
  return withLocal(state, workspace, sessions);
}

/** A local run that never opened (#587), as forgetFailedSession for a task's (#283): the entry its start appended goes; a continued one stays. */
export function forgetFailedLocal(state: State, worker: Worker): State {
  const workspace = localWorkspace(state, worker);
  if (workspace === undefined) return state;
  return withLocal(state, workspace, localSessionsOf(state, workspace).filter((s) => !(s.id === worker.sessionId && s.startedAt === worker.startedAt)));
}

/** The exit of a local run that never opened (#587): no hook seen, so no SessionStart and no transcript; the entry its start appended goes,
 * as a failed spawn's. A run the exit left live (a clean stop) keeps it. */
export function forgetUnopenedLocal(before: State, ptyId: string, reduced: Reduced): Reduced {
  const worker = before.workers.find((s) => s.runId === ptyId && s.status !== 'empty');
  if (worker === undefined || localWorkspace(before, worker) === undefined || worker.seenAt !== undefined) return reduced;
  if (reduced.state.workers.some((s) => s.runId === ptyId && s.status !== 'empty')) return reduced;
  return { ...reduced, state: forgetFailedLocal(reduced.state, worker) };
}

const unmarked = ({ copyOf: _copyOf, ...worker }: Worker): Worker => worker;

/** The temporary transcript a copy's run no longer needs (#587): at its SessionStart (the fork wrote its own by then), or when the run ends
 * before one (exit, spawnFailed, SessionEnd). The mark goes with the effect, so it fires once. */
export function settleCopy(before: State, ptyId: string, hook: string | undefined, reduced: Reduced): Reduced {
  const mark = before.workers.find((s) => s.runId === ptyId && s.status !== 'empty')?.copyOf;
  if (mark === undefined) return reduced;
  const live = reduced.state.workers.find((s) => s.runId === ptyId && s.status !== 'empty');
  if (live !== undefined && hook !== 'SessionStart') return reduced;
  const drop: Effect = { type: 'dropCopiedTranscript', dir: mark.dir, sessionId: mark.from };
  return { state: { ...reduced.state, workers: reduced.state.workers.map((s) => (s === live ? unmarked(s) : s)) }, effects: [...reduced.effects, drop] };
}

/** A boot (#587): it closes every run, so the temporary transcript of each copy still before its SessionStart goes, and the marks with it.
 * The marks are the ones trustedCopies kept. */
export function dropCopiesAtBoot(before: State, reduced: Reduced): Reduced {
  const drops = before.workers.flatMap((s): Effect[] => (s.copyOf === undefined ? [] : [{ type: 'dropCopiedTranscript', dir: s.copyOf.dir, sessionId: s.copyOf.from }]));
  if (drops.length === 0) return reduced;
  return { state: { ...reduced.state, workers: reduced.state.workers.map((s) => (s.copyOf === undefined ? s : unmarked(s))) }, effects: [...reduced.effects, ...drops] };
}
