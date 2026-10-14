import { setTimeout as sleep } from 'node:timers/promises';
import { activityOf, localActivityId, recordWithSession } from './activities.js';
import { continuableLocal, localWorker } from './local-sessions.js';
import { spawnedRun, worktreeSessions } from './tasks.js';
import { bracketedPaste, withoutControls } from './pty-paste.js';
import { type Effect, type HiveEvent, NEW_SESSION, type Worker, type State } from './types.js';

/** The longest a message waits for an opened session to come up (#591). */
export const DELIVER_WAIT_MS = 30_000;
const POLL_MS = 100;

export type Delivery = { ok: true; session: string } | { ok: false; reason: string };
/** key: a task's item id, or a workspace for a local delivery (#344). */
export type Deliver = (key: string, to: string, text: string) => Promise<Delivery>;

export interface DeliverDeps {
  state(): State | undefined;
  dispatch(event: HiveEvent): Promise<Effect[]>;
  started(ptyId: string): Promise<void>; // the pool's: the run's pty exists
  write(ptyId: string, data: string): boolean; // the pty host's: false once the pty is gone
  waitMs?: number; // tests shorten both
  pollMs?: number;
}

const GONE: Delivery = { ok: false, reason: 'the session\'s terminal is gone' };
const BUSY: Delivery = { ok: false, reason: 'the session is showing a prompt' };

// A permission prompt, an elicitation, a hive_ask question or a held Stop: the paste and its Enter would answer it. A waiting worker is only
// safe once its turn ended (lastEvent 'turn'), when the input box is Claude Code's own.
const answersPrompt = (worker: Worker | undefined): boolean =>
  worker?.status === 'approval' || (worker?.status === 'waiting' && worker.lastEvent?.kind !== 'turn');

// The text is cleaned here, the one door to the pty: it holds an excerpt of the repository, which may carry any byte (#483's defence)
function paste(deps: DeliverDeps, ptyId: string, session: string, text: string): Delivery {
  if (answersPrompt(deps.state()?.workers.find((s) => s.runId === ptyId))) return BUSY;
  return deps.write(ptyId, bracketedPaste(withoutControls(text))) ? { ok: true, session } : GONE;
}

// The session opened for the message, resumed or new, as openSession runs it (#283); undefined when the task cannot open it
async function open(deps: DeliverDeps, taskId: string, to: string): Promise<string | undefined> {
  const state = deps.state();
  const task = state?.tasks.find((c) => c.item.itemId === taskId);
  if (!task || !state || (to !== NEW_SESSION && !worktreeSessions(task, state).some((s) => s.id === to))) return undefined;
  // a new session in the live activity; a resumed one names its record, and the reducer opens it in the live one, born when none (#629)
  const activityId = to === NEW_SESSION ? activityOf(state, taskId)?.id : recordWithSession(state, taskId, to)?.id;
  if (activityId === undefined) return undefined;
  const run = spawnedRun(await deps.dispatch({ type: 'openSession', activityId, ...(to === NEW_SESSION ? {} : { continueId: to }) }));
  if (!run) return undefined;
  return deps.started(run.ptyId).then(() => run.ptyId, () => undefined);
}

// openSession names the session id at spawn; the run's first hook (its SessionStart stamps seenAt) says Claude Code is up to take a paste
async function ready(deps: DeliverDeps, ptyId: string): Promise<string | undefined> {
  const deadline = Date.now() + (deps.waitMs ?? DELIVER_WAIT_MS);
  for (;;) {
    const worker = deps.state()?.workers.find((s) => s.runId === ptyId);
    if (worker?.seenAt !== undefined && worker.sessionId !== undefined) return worker.sessionId;
    if (worker === undefined || worker.status === 'empty' || Date.now() >= deadline) return undefined;
    await sleep(deps.pollMs ?? POLL_MS);
  }
}

// The live run holding session `sessionId` of the task: a worker in the task's activity (#629)
function liveHolder(state: State | undefined, taskId: string, sessionId: string): Worker | undefined {
  const activityId = state && activityOf(state, taskId)?.id;
  return activityId === undefined ? undefined : state?.workers.find((s) => s.status !== 'empty' && s.activityId === activityId && s.sessionId === sessionId);
}

// A run opened for the message, pasted into once its first hook landed; undefined: it could not be opened
async function pasteOpened(deps: DeliverDeps, ptyId: string | undefined, text: string): Promise<Delivery> {
  if (ptyId === undefined) return { ok: false, reason: 'the session could not be opened' };
  const session = await ready(deps, ptyId);
  if (session === undefined) return { ok: false, reason: 'the session did not start in time' };
  return paste(deps, ptyId, session, text);
}

/** A text delivered to a session of the task (#591): pasted into the run that holds it, else into a run opened for it. Answers the session it
 * reached (a new one's id), or why not. */
export async function deliver(deps: DeliverDeps, taskId: string, to: string, text: string): Promise<Delivery> {
  const live = to === NEW_SESSION ? undefined : liveHolder(deps.state(), taskId, to);
  if (live?.runId) return paste(deps, live.runId, to, text);
  return pasteOpened(deps, await open(deps, taskId, to), text);
}

export const createDeliver = (deps: DeliverDeps): Deliver => (taskId, to, text) => deliver(deps, taskId, to, text);

// The local session opened for the message (#344), through the sidebar's own events, so the run is an ordinary local session: a known one
// resumed in the main checkout, or a new one. Undefined when the workspace is gone or the session is not one of its local sessions
async function openLocal(deps: DeliverDeps, workspace: string, to: string): Promise<string | undefined> {
  const state = deps.state();
  if (!state?.workspaces.includes(workspace)) return undefined;
  if (to !== NEW_SESSION && !continuableLocal(state, workspace).some((s) => s.id === to)) return undefined;
  const activityId = localActivityId(workspace);
  const run = spawnedRun(await deps.dispatch(to === NEW_SESSION ? { type: 'newLocalSession', activityId } : { type: 'openLocalSession', activityId, sessionId: to }));
  if (!run) return undefined;
  return deps.started(run.ptyId).then(() => run.ptyId, () => undefined);
}

/** A text delivered to a local session of the workspace (#344), as deliver does for a task: pasted into the live local run holding it, else
 * into one opened for it. Same prompt guard, same cleaning. */
export async function deliverLocal(deps: DeliverDeps, workspace: string, to: string, text: string): Promise<Delivery> {
  const live = to === NEW_SESSION ? undefined : localWorker(deps.state()?.workers ?? [], workspace, to);
  if (live?.runId) return paste(deps, live.runId, to, text);
  return pasteOpened(deps, await openLocal(deps, workspace, to), text);
}

export const createDeliverLocal = (deps: DeliverDeps): Deliver => (workspace, to, text) => deliverLocal(deps, workspace, to, text);
