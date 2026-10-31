
import { canCloseMissing, inAction, canRunIn, canMoveToStage, canSetWorkspace, canRemoveCreated, canDeleteActivity, taskId, closesAt, stageOf, dueActions, enter, isBlocked, isGate, markRemoved, mergeTasks, moveTask, nothingToDelete, onSource, renameSources, replaceSegment, resetOrder, resolveWorkspace, seenOne, sessionsOf, workersOf } from './tasks.js';
import { benchmarkReduce, isBenchmarkEvent } from './benchmark-reducer.js';
import { withBase, withLocal, withRunPick } from './task-runs.js';
import { withColumnWrite } from './column-write.js';
import { activityOf, activityOfWorker, resultOf, liveTaskId, pruneWork, recordTaskId, slugOf, taskOfActivity, taskOfWorker, withActivity, withForkSync, withLocalActivities } from './activities.js';
import { forgetFailedFreeRun, forgetFailedSession, keepRecord, touchSession, withDecompositionIssue, withEpic, withPr, withResult, withTurn } from './record-kit.js';
import { AGENTS, liveDefaultAgent, ranAgent } from './agents.js';
import { decompositionWritten } from './decomposition.js';
import { mergeRateLimits } from './rate-limits.js';
import { withPrStates } from './pull-requests.js';
import type { Activity, ActivityRecord, SourceSync, Task, TaskBase, TaskPr, PrSlice, Stage, Transition, Effect, HiveEvent, HookPayload, RateLimits, Signal, Worker, State, Status, Item, RunPick } from './types.js';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS, SPAWN_FAILED } from './types.js';
import { pruneUsage } from './usage.js';
import { disableRule, dropExpiredDisables, enableRule, namedDisables } from './usage-rules.js';
import { boot, clearSessions, closeTerminals, createActivity, dismissCrash, exit, checkpointCaptured, capturedFirst, freeSessionDone, openProjectShell, openSession, openTerminal, quit, restart, restarting, restored, restoreFailed, restoring, continueStage, stageStarted, stop } from './runs.js';
import { answer, answerFeedback, approvalExpired, approve, awaitApproval, extendApproval, typeFeedback } from './approval.js';
import { askHandoff, needsHandoff, pendingEnd, withoutPending } from './handoff.js';
import { advance, dismissError, type EndOf, keepsRun, retry, take, unrouted, withVerdict } from './transit.js';
import { exitOf, transitionByKey } from './transitions.js';
import { beingDeleted, clearedError, deletingOf, sourceWrites, continueInPlace, dropActivity, dropWorker, keptMarks, ensureActivity, emptyWorker, takeWorker, releaseWorker, liveWorker, none, occupiedCount, occupy, workerCount, patch, type Reduced, releaseRun, settleEntries, shouldWrite, slugTaken, unmarked, withError, withTask } from './reducer-kit.js';
import { clearLocalSession, copySession, dropCopiesAtBoot, forgetFailedLocal, forgetUnopenedLocal, newLocalSession, openLocalSession, settleCopy, withLocalTurn } from './session-copy.js';
import { clearSession, renameSession } from './session-clear.js';
import { canContinue, continueIntoHeld, fill, gateOf, startHeldRun } from './fill.js';
import { markForgotten, withSlept } from './slept.js';
import { captureSession, dropOrphanTerminals, forgetTerminal, recordCapturedSession, resumedStart, sleepTerminal, wakeTerminal } from './terminal-runs.js';
import { retryDue, settleWait, stopFailure } from './api-errors.js';
import { freedLostRuns, stageCommandEnded, stageCommandOutput, stageCommandStarted, stageCommandsRefused } from './stage-commands.js';
import { evaluateBroken, evaluateEnded, evaluateJudging, haltEvaluate } from './stage-evaluate.js';
import { holdsWorker } from './stage-agent.js';
import { ciClock, ciFailed, ciRead, haltCi, startCi } from './stage-ci.js';
import { renameStages } from './stage-rename.js';
import { placeVanished } from './vanished-stages.js';
import { followEpics } from './epic-follow.js';
import { blockerSet, closeRefsTo } from './hive-blockers.js';
import { isUuid } from './uuid.js';

export { isFree } from './reducer-kit.js';
export { canSchedule, canStart, effectiveLimits } from './fill.js';
export type { Reduced } from './reducer-kit.js';

// idle_prompt is not here (#367): Claude Code sends it after a stretch of idleness that follows a Stop, which already decided whether the
// user has something to do, and after a background Stop it would turn yellow a worker whose subagent is still running
export const WAITING_NOTIFICATIONS: readonly string[] = [
  'permission_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog',
];
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
export const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/; // Claude Code uses uuids; anything else came from another local process
export { isUuid, UUID } from './uuid.js'; // #347: their own module, so shim.ts reads a uuid without importing the reducer
export const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];
export const STATUSES: readonly Status[] = ['empty', 'working', 'waiting', 'review', 'approval', 'backoff'];

export function initialState(maxConcurrent: number): State {
  return {
    signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent, workers: Array.from({ length: maxConcurrent }, emptyWorker), terminals: [], stages: [], transitions: [], workspaces: [], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, tasks: [], activities: [], activityRecords: [], sourceOrder: [], usage: [], budget: {},
    usageRules: [], disabledRules: [], localCount: 0, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT,
    rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, // #805
    benchmark: { experiments: [] }, // #458
  };
}

export function extractPrUrl(command: string, response: unknown): string | undefined {
  if (!command.includes('gh pr create')) return undefined;
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return text.match(PR_URL)?.[0];
}

/** hive_pr's url: exactly a GitHub pull request link, the shape the gh pr create detection accepts. */
export const isPrUrl = (url: string): boolean => new RegExp(`^${PR_URL.source}$`).test(url);

/** Any local process can hit /hooks/event and the id reaches the panel and the log: only a plain id of a sane length is kept. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** A hook is from a subagent or teammate, not the worker's own top-level turn, when the worker already recorded a
 * session id (from its first SessionStart) and this payload carries a different, well-formed one. A missing or
 * malformed payload id, or a worker that never recorded one, is today's behaviour: treated as the main session (#24). */
export function isChildSession(worker: Worker | undefined, payload: HookPayload): boolean {
  return isSessionId(worker?.sessionId) && isSessionId(payload.session_id) && payload.session_id !== worker.sessionId;
}

/** Every event, then the shutdown-when-done step (#233), on the state as the event and its fill left it, then the show epics' pass (#31).
 * Expired disables go first (#297), on the state as it stood before the event, so a rise the event brings is counted against a rule already
 * back on. */
export function reduce(state: State, event: HiveEvent): Reduced {
  // #672: then the sleeping runs, read across the whole reduction: a run freed by the event, its fill or the shutdown sweep
  const stepped = withSlept(state, event, drainForShutdown(step(dropExpiredDisables(state, Date.now()), event), Date.now()), Date.now());
  // #31: every show epic where its children now put it, whatever moved them: one pass, so no event has to wire it
  const epics = followEpics(stepped.state);
  const reduced = epics.state === stepped.state ? stepped : { state: epics.state, effects: [...stepped.effects, ...epics.effects] };
  // #629: wherever a task left, its work went with it; #696: and the terminals of any activity gone, a removed workspace's local one included;
  // #727: and the worker of any commands run gone with it or dropped by the boot
  const { state: pruned, effects: dropped } = dropOrphanTerminals(freedLostRuns(pruneWork(reduced.state)), reduced.state);
  return pruned === reduced.state ? reduced : { ...reduced, state: pruned, effects: [...reduced.effects, ...dropped] };
}

// A disable or an enable the rules refused returns the state itself (#297): no fill then, as with any no-op. A lifted lock can open a job
// right away, like setBudget.
const refillIfChanged = (state: State, next: State): Reduced => (next === state ? none(state) : fill(none(next)));

// A run that ends frees its task (#381): a task its session held out of an action stage is acted on now, as after a stage's finish, not on the
// next poll, which can be the 5-minute idle one. Never during a Quit: its kills leave the state as the next boot must read it
const ended = (reduced: Reduced): Reduced => fill(reduced.state.cleanStop ? reduced : runActions(reduced.state, reduced.effects));

// A commands stage's answer (#755): once it changed something (the next command, or the stage's end and the move it made), the due actions
// and the fill follow, as after activityDeleted; an answer that changed nothing (an older pty, a Quit) is left as it is
const afterCommands = (state: State, reduced: Reduced): Reduced => (reduced.state === state ? reduced : fill(runActions(reduced.state, reduced.effects)));

function step(state: State, event: HiveEvent): Reduced {
  if (isBenchmarkEvent(event)) return none(benchmarkReduce(state, event)); // #458: an experiment's life frees no worker and starts no job
  switch (event.type) {
    case 'boot': return dropCopiesAtBoot(state, boot(state)); // no fill: bootHive polls right after, and the source is the truth; opens on signals.onOpen, a saved red always red (#727), and that poll's fill resumes the tasks in flight (#224)
    case 'poll': return fill(poll(state, event)); // also where a dynamic red ages out: samples leave the window with time, a plan window passes its reset
    case 'itemRead': return afterCommands(state, none(itemRead(state, event))); // #686: a field write's re-read item; once its task changed, the due actions and the fill follow, as after a poll
    case 'blockerSet': return refillIfChanged(state, blockerSet(state, event)); // #56: a removed blocker may free a task a free worker can take
    case 'setMax': return fill(setMax(state, event.max));
    case 'setSignal': return fill(runActions({ ...state, signal: event.signal })); // #727: a looser workerless row acts at once
    case 'setSignals': return fill(runActions({ ...state, signals: event.signals })); // #727: idem, and a looser row may start work at once
    case 'setBudget': return fill(none({ ...state, budget: event.budget })); // raising the limit can open a job right away
    case 'setUsageRules': return fill(none({ ...state, usageRules: event.usageRules, disabledRules: namedDisables(state.disabledRules, event.usageRules, liveDefaultAgent(state)) })); // a disable never outlives its rule (#297)
    case 'disableRule': return refillIfChanged(state, disableRule(state, { source: event.source, percent: event.percent, until: event.until, ...(event.agent === undefined ? {} : { agent: event.agent }) }, Date.now()));
    case 'enableRule': return refillIfChanged(state, enableRule(state, event));
    case 'setDeleteActivity': return none({ ...state, deleteActivity: event.deleteActivity }); // no fill: what deleting an activity forgets never starts a job
    case 'setShutdownIdle': return none({ ...state, shutdownIdleMinutes: event.minutes }); // no fill: the window starts no job (#233)
    case 'setRateLimitWait': return none({ ...state, rateLimitWaitMinutes: event.minutes }); // no fill: the ceiling starts no job (#805)
    case 'setDefaultAgent': return none({ ...state, defaultAgent: event.agent }); // no fill: the default picks no task, only what a run records (#925)
    case 'setApprovalMinutes': return none({ ...state, approvalMinutes: event.minutes }); // no fill: the window starts no job (#268)
    case 'setKeepAwake': return none(setKeepAwake(state, event.on)); // no fill: keeping the machine awake starts no job (#226)
    case 'setShutdown': return fill(none(setShutdown(state, event.armed))); // arming no longer caps the signal (#727); the fill runs as after any setting
    case 'tick': return none(state); // nothing by itself: the final step reads the clock (#233)
    case 'setStages': return fill(setStages(state, event.stages, event.transitions));
    case 'setWorkspaces': return fill(setWorkspaces(state, event)); // a task that resolved to none may be a candidate now
    case 'setWorkspace': return fill(none(setWorkspace(state, event.taskId, event.workspace))); // idem
    case 'hook': return settleCopy(state, event.ptyId, event.payload.hook_event_name, applyHook(state, event.ptyId, event.payload, event.branch, event.tokens, event.title)); // a copy's SessionStart or early end drops its temporary transcript (#587)
    case 'exit': return settleCopy(state, event.ptyId, undefined, forgetUnopenedLocal(state, event.ptyId, ended(exit(state, event.ptyId))));
    case 'done': return done(state, event.ptyId, event.result, event.verdict, event.evidence); // no fill: nothing freed, nothing loosened
    case 'pr': return markPr(state, event.ptyId, event.url, event.slice); // no fill: a PR frees nothing
    case 'prStates': return prStates(state, event.states); // no fill: a merged PR frees no worker (#207)
    case 'ask': return ask(state, event.ptyId, event.question); // no fill: nothing freed
    case 'spawnFailed': return settleCopy(state, event.ptyId, undefined, ended(spawnFailed(state, event.ptyId, event.message))); // the worker frees; the failed task is out of the candidates, the next one may take it
    case 'setupStarted': return setupChanged(state, event); // no fill: a display state and a lock (#351)
    case 'setupStep': return setupChanged(state, event); // idem
    case 'setupEnded': return setupChanged(state, event); // idem: /open opens its session itself, the spawn path's worker is already there
    case 'activityDeleted': return fill(activityDeleted(state, event.activityId)); // the task may now be a candidate in a prompt stage, or have its activity deleted at once in a next delete-activity stage (#284)
    case 'deleteActivityFailed': return deleteActivityFailed(state, event.activityId, event.message); // no fill: nothing freed, nothing loosened
    case 'stageCommandEnded': return afterCommands(state, stageCommandEnded(state, event)); // #755: a passed stage moves the task on, as activityDeleted does
    case 'stageCommandsRefused': return afterCommands(state, stageCommandsRefused(state, event)); // #755: failed, nothing more runs
    case 'stageCommandStarted': return none(stageCommandStarted(state, event)); // #914: no fill: a time for the running block
    case 'stageCommandOutput': return none(stageCommandOutput(state, event)); // #914: idem
    case 'ciRead': return afterCommands(state, ciRead(state, event)); // #834: a passed wait moves the task on, as a commands stage's end does
    case 'ciClock': return afterCommands(state, ciClock(state, event)); // #834: only a timeout; #134: a routed failure moves the task, as a pass does
    case 'ciFailed': return afterCommands(state, ciFailed(state, event)); // #834; #134: a routed failure moves the task, as a pass does
    case 'stopCi': return none(haltCi(state, event.activityId)); // #834: no fill: the task stops in its stage, nothing freed
    case 'evaluateJudging': return none(evaluateJudging(state, event)); // #877: no fill: a phase for the card
    case 'evaluateEnded': return afterCommands(state, evaluateEnded(state, event)); // #877: the worker frees and the verdict routes, as a commands stage's end
    case 'evaluateBroken': return afterCommands(state, evaluateBroken(state, event)); // #877: the worker frees; the task stops, no try spent
    case 'stopEvaluate': return fill(haltEvaluate(state, event.activityId)); // #877: the freed worker may take another task
    case 'decompositionIssue': return none(decompositionIssue(state, event)); // #865: no fill, no effects: a step of the write, recorded on the task
    case 'markEpic': return none(withEpic(state, event.taskId, event.epic)); // #556: no fill, no effects: an epic frees nothing; the approve that follows ends its run, followEpics places it once its children are known
    case 'forkSynced': return none(withForkSync(state, event)); // #854: no fill: a record of how the worktree started, nothing freed
    case 'sourceActionFailed': return sourceActionFailed(state, event.taskId, event.message, event.leaving); // no fill: the error keeps the task out of it (#286)
    case 'stop': return stopped(state, event); // close: hive_stop's (#314); cause: the sleep it is (#672)
    case 'forgetSlept': return none(markForgotten(state, event.ptyId)); // #672: withSlept drops the record and forgets the transcript; a run not yet exited is marked, so its exit records nothing
    case 'quit': return quit(state); // no fill: the Hive is going down (#283)
    case 'dismissCrash': return dismissCrash(state); // no fill: a display flag (#283)
    case 'error': return { state: { ...state, error: event.message }, effects: [] };
    case 'rateLimits': return fill(setRateLimits(state, event)); // a reading is an input of the gate: a window that reset can open a job, one that filled can close it
    case 'sourceQuota': return none(withSync(state, event.source, (s) => ({ ...s, quota: event.quota }))); // display and that source's backoff only: no fill, no effects
    case 'pollFailed': return none(withSync(state, event.source, (s) => ({ ...s, error: event.message }))); // its tasks stay as they are
    case 'setSources': return none({ ...state, syncs: syncsFor(state.syncs, event.sources) }); // a removed source's tasks go missing at the next poll
    case 'renameSources': return none(renameSources(state, event.renames)); // a save that renamed sources (#278): no fill; setSources and the poll follow
    case 'renameStages': return none(renameStages(state, event.renames)); // #861: no fill; setStages follows, and a running task reads its renamed stage at once
    case 'start': return start(state, event.itemId, event.base, event.workspace, event.local, event.runPick); // no fill: nothing loosened, so nothing else could open
    case 'continue': return continueStage(state, recordTaskId(state, event.activityId)); // no fill: nothing loosened (#283); a deleted activity's record too (#629)
    case 'restarting': return restarting(state, liveTaskId(state, event.activityId)); // no fill: a mark only (#283)
    case 'restart': return restart(state, liveTaskId(state, event.activityId), event.branch); // idem (#283)
    case 'stageStarted': return stageStarted(state, event); // no fill: a record only (#283)
    case 'checkpointCaptured': return checkpointCaptured(state, event); // no fill: a record only (#619)
    case 'restoring': return restoring(state, event.itemId); // no fill: a mark only, as restarting (#619)
    case 'restored': return restored(state, event); // no fill: the task stays as it was in its stage (#619)
    case 'restoreFailed': return restoreFailed(state, event.itemId); // no fill: only the mark goes (#619)
    case 'clearSessions': return clearSessions(state, event); // no fill: the fill never reads sessions (#283)
    case 'closeTask': return fill(closeTask(state, event.taskId));
    case 'keepTask': return fill(keepTask(state, event.taskId));
    case 'closeMissing': return closeMissing(state, event.stage); // no fill: nothing freed, and a missing task was never a candidate
    case 'worktreeGone': return worktreeGone(state, event.activityId); // no fill, no effects: fill never looks at the path
    case 'deletingActivity': return deletingActivity(state, liveTaskId(state, event.activityId)); // no fill: nothing freed, one task less to pick
    case 'activityRemoved': return fill(activityRemoved(state, liveTaskId(state, event.activityId))); // the task may be a candidate again, here or in the stage it advanced to (#210)
    case 'activityKept': return activityKept(state, liveTaskId(state, event.activityId)); // no fill: nothing freed, nothing loosened
    case 'deletingTask': return deletingTask(state, event.taskId); // no fill: nothing freed, one task less to pick
    case 'taskDeleted': return fill(taskDeleted(state, event.taskId)); // one task less: what it held frees
    case 'moveTask': return fill(none({ ...state, tasks: moveTask(state.tasks, event.taskId, event.before) })); // a new position can change who takes the next free worker
    case 'resetOrder': return fill(none({ ...state, tasks: resetOrder(state.tasks, event.stage, state.sourceOrder, state) })); // idem; the source is read, never written
    case 'createTask': return fill(createTask(state, event)); // a new task in a prompt stage may take a free worker at once
    case 'setAuto': return event.auto ? fill(setAuto(state, event.taskId, true)) : setAuto(state, event.taskId, false); // turning auto on may hand a free worker the task at once
    case 'openSession': return openSession(state, event); // no fill: a session appends a worker of its own and frees none (#459)
    case 'openTerminal': return openTerminal(state, event); // no fill: a terminal takes no worker (#283, #570)
    case 'copySession': return copySession(state, event); // no fill: a copy appends a worker of its own and frees none (#459, #587)
    case 'openLocalSession': return openLocalSession(state, event); // idem (#587)
    case 'newLocalSession': return newLocalSession(state, event); // idem (#590)
    case 'clearLocalSession': return clearLocalSession(state, event); // no fill: the fill never reads sessions (#587)
    case 'openProjectShell': return openProjectShell(state, event); // no fill: a shell takes no worker (#292)
    case 'sleepTerminal': return sleepTerminal(state, event); // no fill: a terminal takes no worker (#696)
    case 'wakeTerminal': return wakeTerminal(state, event); // idem
    case 'forgetTerminal': return forgetTerminal(state, event); // idem
    case 'captureSession': return captureSession(state, event); // no fill: a free session takes no worker of the fill (#459, #696)
    case 'createActivity': return createActivity(state, event); // no fill: the work is born, no run starts (#629)
    case 'worktreeReady': return worktreeReady(state, event); // no fill: a task with auto off is never a candidate
    case 'moveToStage': return fill(moveToStage(state, event)); // any task with auto that entered a prompt stage may take a free worker (#366, #708)
    case 'approve': return fill(approve(state, liveTaskId(state, event.activityId), canContinue)); // a held worker goes on in place when canContinue allows (#321); else the fill decides
    case 'feedback': return feedback(state, event);
    case 'extendApproval': return extendApproval(state, liveTaskId(state, event.activityId)); // no fill: nothing freed (#268)
    case 'approvalExpired': return fill(approvalExpired(state, event.ptyId)); // the held worker frees (#268)
    case 'retryDue': return retryDue(state, event.ptyId, event.until); // no fill: the worker kept its slot through the wait (#805)
    case 'retry': return afterCommands(state, retry(state, event.taskId) ?? none(state)); // #915: as a routed failure: the due actions and the fill follow
    case 'dismissError': return afterCommands(state, dismissError(state, event.taskId) ?? none(state)); // #354: as retry: a due stage action and the fill follow
  }
}

// Account-wide data, one reading per agent (#929). From a worker it needs a live worker, as with hooks (any local process can post to the
// route); the Hive's own reading never passes through a route, so it is always kept. The plan rules read it through limits(); the reducer
// wraps it in fill. `replace` is the user's refresh: a fresh read taken whole, because the merge keeps the higher percent inside a window and
// a bigger plan lowers it without moving the reset. A worker's snapshot can be hours old, so it is always merged. Only the event's own agent's
// reading changes.
function setRateLimits(state: State, { agent, ptyId, rateLimits, replace = false }: Extract<HiveEvent, { type: 'rateLimits' }>): Reduced {
  const readings = state.rateLimits ?? {};
  const kept = (reading: RateLimits): Reduced => none({ ...state, rateLimits: { ...readings, [agent]: reading } });
  const merged = mergeRateLimits(readings[agent], rateLimits);
  if (ptyId === undefined) return kept(replace ? rateLimits : merged);
  const worker = state.workers.find((s) => s.runId === ptyId);
  return !worker || worker.status === 'empty' ? none(state) : kept(merged);
}

// The human override: no signal, cap, budget or `after` check; the task runs in the stage it is in. Unknown, running, deleting, missing or
// leaving (#286) task, or one awaiting approval (approve or feedback moves it, #268), or running a stage action (#755, #834): unchanged; a non-auto task starts like any other (#283). A delete-activity stage acts at once, with no worker and whatever the blockers (they are about starting work), and never
// gets a base; a commands stage too, and an evaluate stage (#877), keeping the popup's base and switch for its worktree (#755). A wait for CI starts over, with a new clock and no re-run spent (#834). A prompt stage, or a manual gate carrying queued feedback (HIVE-2), needs an unblocked task; with a free worker it takes it, without one it opens a worker over the cap that leaves
// when its own worker ends: maxConcurrent is untouched and the extra worker is a draining one, as a setMax below the occupied count leaves
// behind (#116). The popup's base (#131) is written before occupy, so the spawn effect carries it; null (the popup's default) drops a saved
// one; absent (a task with a worktree, started with no popup) keeps it. A task with no workspace starts nothing; the popup's workspace is saved
// with the start (#179).
function start(state: State, itemId: string, taskBase?: TaskBase | null, workspace?: string, local?: boolean, runPick?: RunPick): Reduced {
  const found = state.tasks.find((c) => taskId(c) === itemId);
  const placed = found && workspace !== undefined ? withWorkspace(state, found, workspace) : found && { state, task: found }; // the popup's choice (#179)
  const task = placed?.task;
  const stage = task && stageOf(state.stages, task.stage);
  const activity = activityOf(state, itemId);
  if (!placed || !task || !stage || task.item.epic !== undefined || activity?.workerId !== undefined || activity?.deleting || inAction(activity) || task.missing || task.leaving || activity?.approval || activity?.setup) return none(state); // setup: #351; #31: a show epic never runs
  if (resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks) === undefined) return none(state); // the route asks for one first (#179)
  // a manual start clears the last failure (spawn, delete activity or a commands stage's) and tries again
  if (stage.action === 'deleteActivity') return startDeleteActivity(clearedError(state, task), task);
  if (stage.action === 'waitForCi') return startCi(placed.state, task); // #834: no worker, no worktree; startCi clears the last failure itself
  const isHeld = holdsWorker(stage); // #755, #877: a commands or evaluate stage runs in the worktree, holding a worker
  if (!isHeld && (!canRunIn(stage) || isBlocked(task.item))) return none(state); // a prompt (#134: a gate runs nothing)
  const retried = clearedError(placed.state, task);
  const taken = slugTaken(retried, task);
  if (taken) return none(taken); // before a worker opens over the cap (#116)
  const born = ensureActivity(retried, task);
  if (!born) return none(state);
  const chosen = withActivity(born.state, withRunPick(withLocal(withBase(born.activity, taskBase), local), isHeld ? undefined : runPick)); // the popup's base and switch (#131, #444) and the run picks (#290), on the activity so the spawn carries them
  const { state: opened, index } = takeWorker(chosen); // a free worker, else one over the cap (#116)
  return isHeld ? startHeldRun(opened, task, index, 'manualStart', stage) : occupy(opened, index, task, stage, 'manualStart'); // #755, #727: a held run in the worktree the base and switch decide
}

// A task created in the Hive (#132): the next local number (never reused: localCount only grows), entered into the stage like a polled task
// (enteredAt now, so `after` counts from creation) and appended right after the stage's last task, unpinned. `local` keeps it off every source
// write and out of the poll's missing mark. Unknown stage: nothing (the route checked; a race is a no-op). With pr (#67) the task holds that PR
// from birth, in a record with no live activity: the shape a deleted activity leaves, which taskOfPr, prsOf and the PR poll already read.
function createTask(state: State, { title, body, stage: name, prefix, workspace, auto, url, origin, pr }: Extract<HiveEvent, { type: 'createTask' }>): Reduced {
  const stage = stageOf(state.stages, name);
  if (!stage) return none(state);
  const n = state.localCount + 1;
  const item: Item = { itemId: `local:${n}`, id: `${prefix}-${n}`, title, body, url: url ?? '', ...(origin === undefined ? {} : { origin }) }; // #756: a copy of a source's issue keeps its link
  const placed = workspace !== undefined && state.workspaces.includes(workspace) ? { workspace } : {}; // a known workspace only (#179)
  const task = enter({ item, stage: stage.name, boardColumn: '', created: true, auto, ...placed }, stage);
  // "End of its stage" is right after the last task of that stage, as moveTask reads it; an empty stage appends to the list
  const at = state.tasks.reduce((end, c, i) => (c.stage === stage.name ? i + 1 : end), state.tasks.length);
  const held: ActivityRecord | undefined = pr && { id: pr.recordId, taskIds: [item.itemId], sessions: [], prs: [{ url: pr.url, state: 'open' }] };
  const activityRecords = held === undefined ? state.activityRecords : [...state.activityRecords, held];
  return none(settleEntries(state.tasks, { ...state, localCount: n, tasks: [...state.tasks.slice(0, at), task, ...state.tasks.slice(at)], activityRecords }));
}

// The auto switch (#164, #573): off takes the task out of the fill, the delete-activity stages (unless nonAutoTasks, #496) and every automatic
// prompt, but not out of a wait for CI, which holds no worker (#304); a worker already running is left to finish its stage. Unknown or missing
// task: nothing (the route refused it; a race is a no-op).
// On hands the task back to the fill, which never picks a stopped activity, so its stopped mark goes (#892); off leaves the mark. A failure's
// stop keeps it: its error still bars the fill until a manual start or retry, and the mark is what shows that stop.
function setAuto(state: State, id: string, auto: boolean): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  if (!task || task.missing) return none(state);
  const switched = withTask(state, { ...task, auto });
  const activity = auto ? activityOf(state, task.item.itemId) : undefined;
  if (!activity?.stopped || activity.error !== undefined) return none(switched);
  const { stopped: _stopped, stoppedAt: _stoppedAt, ...unstopped } = activity;
  return none(withActivity(switched, unstopped));
}

// POST /tasks/:id/worktree created the non-auto task's worktree (#164): where it is, its branch, and the base the popup chose (null = the
// default, which drops a saved one). The worktree button turns into the session button.
function worktreeReady(state: State, { activityId, path, branch, base, local }: Extract<HiveEvent, { type: 'worktreeReady' }>): Reduced {
  const activity = state.activities.find((a) => a.id === activityId);
  const task = taskOfActivity(state, activityId);
  if (!activity || !task) return none(state);
  const { base: _saved, worktreeGone: _gone, ...rest } = activity; // the path is written again: the mark goes (#208)
  const workspace = resolveWorkspace(task, state.workspaces, state.sourceWorkspaces, state.tasks); // frozen with the worktree (#179)
  const frozen = workspace === undefined ? state : withTask(state, { ...task, workspace });
  return none(withActivity(frozen, withLocal({ ...rest, worktree: path, branch, ...(base ? { base } : {}) }, local)));
}

// The worktree setup on the task (#351): started with its console channel, a step, ended. A start is a new attempt, so the last failure and
// its rows (lastSetup, #390) go, as a manual start clears them; setupEnded keeps a setup with a failed row as lastSetup; setupEnded's error is the /open path's failure, kept where a failed spawn keeps its own. An unknown task, or
// a step with no setup (a stale one), changes nothing.
function setupChanged(state: State, event: Extract<HiveEvent, { type: 'setupStarted' | 'setupStep' | 'setupEnded' }>): Reduced {
  const activity = state.activities.find((a) => a.id === event.activityId);
  const task = taskOfActivity(state, event.activityId);
  if (!activity || !task) return none(state);
  if (event.type === 'setupStarted') {
    const { error: _error, lastSetup: _lastSetup, ...retried } = activity;
    return none(withActivity(state, { ...retried, setup: { consoleId: event.consoleId, rows: event.rows } }));
  }
  if (event.type === 'setupStep') {
    if (!activity.setup) return none(state);
    const setup = { consoleId: activity.setup.consoleId, rows: event.rows, ...(event.step === undefined ? {} : { step: event.step }) }; // #390: replaces both
    return none(withActivity(state, { ...activity, setup }));
  }
  const { setup, ...rest } = activity;
  const isFailed = setup?.rows.some((row) => row.status === 'failed') === true; // #390: the dialog shows a failed setup once its mark is gone
  return none(withActivity(state, {
    ...rest, ...(event.error === undefined ? {} : { error: event.error }), ...(isFailed && setup ? { lastSetup: { consoleId: setup.consoleId, rows: setup.rows } } : {}),
  }));
}

// The user's answer to a stage awaiting approval (#268, #134): to its own stage, a held worker goes on in place with the transition's prompt
// and the user's own open session has it typed in (#483); otherwise the feedback transition is taken like a stage end, and the task, in its
// destination with its handover, starts now like a manual start (past the signal, the cap and the budget, #116) or waits for the fill.
function feedback(state: State, { activityId, text, start: now }: Extract<HiveEvent, { type: 'feedback' }>): Reduced {
  const id = liveTaskId(state, activityId);
  const answered = answerFeedback(state, id, text) ?? typeFeedback(state, id, text);
  if (answered) return answered;
  const routed = answer(state, id, { trigger: 'feedback', feedback: text }, canContinue);
  if (routed.state === state) return routed;
  if (!now) return fill(routed);
  const started = start(routed.state, id);
  return started.state === routed.state ? fill(routed) : { state: started.state, effects: [...routed.effects, ...started.effects] };
}

// Right-click → move to (#164) or a drag across stages (#366): a task canMoveToStage allows enters any other Hive stage (fresh enteredAt,
// unpinned) and keeps its auto setting. The source is shown the target's first `from`, the column the Hive reads as "entering that stage",
// when the task has a source to be written to. A drag's `drop` then pins it where it landed (#123), before `before` or at the end of the
// target stage; a menu move has none and keeps the task's array position.
function moveToStage(state: State, { taskId: id, stage: name, drop }: Extract<HiveEvent, { type: 'moveToStage' }>): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  const target = stageOf(state.stages, name);
  if (!task || !target || target.name === task.stage || !canMoveToStage(task, state)) return none(state);
  const [entry] = onSource(target.from, task.item.source) ?? []; // the task's source's first door (#180)
  const write = shouldWrite(task, entry);
  const written = write ? withColumnWrite(task, entry, new Date().toISOString()) : task; // #889: marked until a poll shows the new column
  const entered = withTask(state, enter(written, target));
  const tasks = drop ? moveTask(entered.tasks, id, drop.before) : entered.tasks; // `before` is in the target stage now: the route checked it
  return { state: unrouted(settleEntries(state.tasks, { ...entered, tasks }), id), effects: write ? [{ type: 'setColumn', itemId: id, column: entry }] : [] }; // #134: a move by hand drops the tries and the arrow
}

/** The Comb's sources by name (#180): a kept source keeps its status, a new one starts empty, a removed one goes. What setSources and the
 * server's boot seeding share. */
export const syncsFor = (current: Record<string, SourceSync>, names: string[]): Record<string, SourceSync> =>
  Object.fromEntries(names.map((name) => [name, Object.hasOwn(current, name) ? current[name] : {}]));

// The source's status through `change`; a source the Comb no longer has (a poll that outlived its removal) records nothing.
function withSync(state: State, source: string, change: (status: SourceSync) => SourceSync): State {
  return Object.hasOwn(state.syncs, source) ? { ...state, syncs: { ...state.syncs, [source]: change(state.syncs[source]) } } : state;
}

// A source's listing (#180) merges only its own tasks, swaps its ids in the source order and stamps when it answered, clearing its error.
// No source (#132) merges nothing but still marks a removed source's tasks and runs the deletions: the poll drives the fill and `after`.
function poll(state: State, { source, items: listed }: Extract<HiveEvent, { type: 'poll' }>): Reduced {
  const sources = Object.keys(state.syncs);
  if (source === undefined) return runActions({ ...state, tasks: markRemoved(state.tasks, sources) });
  if (!sources.includes(source)) return none(state);
  const order = replaceSegment(state.sourceOrder, source, listed.map((c) => c.item.itemId)); // what resetOrder sorts by; never written back
  const polledAt = new Date().toISOString();
  return runActions(settleEntries(state.tasks, {
    ...withSync(state, source, ({ error: _error, ...status }) => ({ ...status, polledAt })),
    tasks: mergeTasks(state.tasks, state.stages, { source, items: listed }, sources, order, state, polledAt), sourceOrder: order, error: undefined,
  }));
}

// #686: one item re-read after a field write: its task (this source's, by item id) as the poll would leave it, through the poll's own one-task
// step; no other task, no source order, no sync stamp. An item that is no task, or a task the step leaves as it is, leaves the state as it is
function itemRead(state: State, { source, itemId, entry }: Extract<HiveEvent, { type: 'itemRead' }>): State {
  const task = state.tasks.find((c) => taskId(c) === itemId && c.item.source === source);
  if (task === undefined) return state;
  const seen = seenOne(task, entry, state.stages, state, new Date().toISOString()); // #889: a re-read is held to the poll's stale-read rule
  return seen === task ? state : settleEntries(state.tasks, { ...state, tasks: state.tasks.map((c) => (c === task ? seen : c)) });
}

// A stopped task in a stage a save turned into a manual gate awaits approval from now, as if it had just entered (#315), on its activity, born
// for it when it has none (#629).
function awaitGate(state: State, task: Task): State {
  const live = activityOf(state, taskId(task));
  if (live?.workerId !== undefined || live?.approval || !isGate(stageOf(state.stages, task.stage))) return state;
  const born = ensureActivity(state, task);
  return born ? withActivity(born.state, { ...born.activity, approval: { since: new Date().toISOString() } }) : state;
}
// The tasks of a stage the save removed go where destinationOf says (#861, vanished-stages.ts): a stopped one enters its destination through
// settleEntries and the gates, keeping its activity; one a run holds is placed with no entry and halts at its run's end. A stage turned into
// deleteActivity acts now.
function setStages(state: State, stages: Stage[], transitions: Transition[]): Reduced {
  const placed = placeVanished(state, stages);
  const staged = settleEntries(placed.before, { ...placed.state, stages, transitions });
  return runActions(staged.tasks.reduce(awaitGate, staged), placed.effects);
}

// The Comb's workspaces, each source's default and each workspace's command names and colours, from the config on every save (#179, #180, #300, #78).
function setWorkspaces(state: State, { workspaces, sourceWorkspaces, commands, workspaceColors }: Extract<HiveEvent, { type: 'setWorkspaces' }>): Reduced {
  return none(withLocalActivities({ ...state, workspaces, sourceWorkspaces, commands, workspaceColors })); // an activity's workspace is frozen at its birth (#629)
}

// The task with `name` as its workspace, when it may still change and the Comb has it (#179); undefined otherwise. An activity born in
// another workspace goes (#629): its workspace is frozen at birth, so the next run's is born in the new one.
function withWorkspace(state: State, task: Task, name: string): { state: State; task: Task } | undefined {
  if (!canSetWorkspace(task, state) || !state.workspaces.includes(name)) return undefined;
  const moved: Task = { ...task, workspace: name };
  const live = activityOf(state, taskId(task));
  return { state: withTask(live && live.workspace !== name ? dropActivity(state, task) : state, moved), task: moved };
}

// Right-click › Workspace (#179): nothing unless the task exists, may still change workspace and the name is a Comb workspace. A gate task
// left with no activity gets its awaiting one in the new workspace, as if it had just entered (#629).
function setWorkspace(state: State, id: string, name: string): State {
  const found = state.tasks.find((c) => taskId(c) === id);
  const placed = found && withWorkspace(state, found, name);
  if (!placed) return state;
  const awaits = isGate(stageOf(state.stages, placed.task.stage)) && !activityOf(placed.state, id);
  return awaits ? settleEntries(placed.state.tasks.filter((c) => taskId(c) !== id), placed.state) : placed.state;
}

// The first move of a due action stage (#755, #834): delete the activity or start waiting for CI; a commands stage is the fill's (#727)
function startAction(state: State, task: Task): Reduced {
  return stageOf(state.stages, task.stage)?.action === 'waitForCi' ? startCi(state, task) : startDeleteActivity(state, task);
}

// Every stopped task whose action stage is due (#755: was runDeletions), in source order, its effects after `effects`. poll and setStages run
// it, and so do finish, activityDeleted, a commands stage's answer and a passed wait (#284, #834): a task that ends a stage into an action stage
// is acted on in that same reduction, before a poll can find its item gone from the source and mark it missing (#212). Passes repeat until none
// is due: a deleting task or one holding a stage action is never due again, a slug refusal leaves its error on the task, and a move only goes
// forward through a finite list of stages, so it ends; a pass that changes nothing stops it too. Workerless stages act only while the signal's
// row lets them (#727).
function runActions(state: State, effects: Effect[] = []): Reduced {
  const now = Date.now();
  const due = dueActions(state, now, gateOf(state, now).behaviour.workerless); // #727: the signal's workerless row
  if (due.length === 0) return { state, effects };
  const passed = due.reduce<Reduced>((r, task) => {
    const next = startAction(r.state, task);
    return { state: next.state, effects: [...r.effects, ...next.effects] };
  }, { state, effects });
  return passed.state === state ? passed : runActions(passed.state, passed.effects);
}

// The delete-activity stage acts: its onStart list written in order (as occupy does, #515), then the effect, with the scope it
// removes (#236). No worker, no signal, no budget: a git command of the Hive, not a Claude session. `deleting` marks the task until the
// answer, so a poll, a stage edit or a second start overlapping a slow remove never emits a second deletion for it. With nothing the
// scope covers on the task (#236) there is no effect and no mark: the task moves on at once.
function startDeleteActivity(given: State, task: Task): Reduced {
  // #629: a task with no activity but kept sessions in scope deletes through a fresh one, as main's delete saw them on the task
  const born = nothingToDelete(given, task, given.deleteActivity) ? undefined : ensureActivity(given, task);
  if (!born) { // #236: nothing the scope covers is on the task, so the stage only moves it on
    const { state: advanced, effects } = advance(given, task, { trigger: 'done' }); // #134: a delete activity ends with done
    return { state: advanced, effects };
  }
  const { state, activity } = born;
  const written = sourceWrites(task, onSource(stageOf(state.stages, task.stage)?.onStart, task.item.source));
  const started = written.task;
  const marked: Activity = { ...activity, deleting: true };
  const closed = closeTerminals(state, task); // its terminals first (#573): git never runs under one
  return {
    state: withActivity(withTask(closed.state, started), marked),
    effects: [...closed.effects, ...written.effects, { type: 'deleteActivity', activity: marked, task: started, scope: state.deleteActivity }],
  };
}

// Changing the cap is about the automation's workers (#459): a free session lives among the workers but outside the cap, so it is kept as
// it is, never counted and never marked draining.
function setMax(state: State, max: number): Reduced {
  const occupied = workerCount(state.workers);
  const room = Math.max(0, max - occupied);
  let occupiedSeen = 0;
  let emptyKept = 0;
  const kept = state.workers.flatMap<Worker>((s) => {
    if (s.freeSession) return [s];
    if (s.status !== 'empty') {
      const draining = occupiedSeen++ >= max;
      return [draining ? { ...s, draining: true } : { ...s, draining: undefined }];
    }
    if (emptyKept >= room) return [];
    emptyKept += 1;
    return [s];
  });
  const extra = Array.from({ length: room - emptyKept }, emptyWorker);
  return none({ ...state, maxConcurrent: max, workers: [...kept, ...extra] });
}

// hive_done from the worker: the next Stop of this run ends the stage, by its verdict when it gave one (#134). A result is shallow-merged into
// its activity's record (a newer key wins, #629), the verdict as result.verdict, so every later stage reads it as {result.<path>} (#99).
// Unknown or empty worker: ignored; a free session advances its task at once instead (#283), or, when its stage has no exit for the end, only
// records the plain result (#339).
function done(state: State, ptyId: string, result?: Record<string, unknown>, verdict?: string, evidence?: string): Reduced {
  const worker = liveWorker(state, ptyId);
  if (!worker) return none(state);
  const ended = withVerdict(result, verdict, evidence);
  if (worker.freeSession) return freeSessionDone(state, worker, ended, verdict, result);
  const task = taskOfWorker(state, worker);
  const merged = ended && task ? withResult(state, task, ended) : state;
  return patch(merged, ptyId, { done: true, verdict });
}

// The PR the worker opened, told through hive_pr or seen as a `gh pr create` on PostToolUse: the task appends it as open, once (both
// channels can report the same PR, #207) in its activity's record (#629). The status stays the run's: review is the task's state, read from
// the records once no session works (#663). A link already there keeps its state. The reporting worker's session goes with it (#62), so the
// PR page can say which session opened it.
function markPr(state: State, ptyId: string, url: string, slice?: PrSlice): Reduced {
  const worker = liveWorker(state, ptyId);
  const task = worker && taskOfWorker(state, worker);
  if (!task) return none(state);
  return none(withPr(patch(state, ptyId, { question: undefined, lastEvent: { kind: 'pr' } }).state, task, url, slice, worker.sessionId));
}

// The PR query's answer (#207): each task's PRs take the states read. No worker changes: the task state reads the records (#663)
function prStates(state: State, states: TaskPr[]): Reduced {
  return none({ ...state, activityRecords: withPrStates(state.activityRecords, states) });
}

// hive_ask: the worker's own question, yellow at once. The worker then asks it in chat and ends its turn; that Stop and Claude Code's idle
// Notification keep it (applyHook), a prompt or a tool clears it.
function ask(state: State, ptyId: string, question: string): Reduced {
  return liveWorker(state, ptyId) ? patch(state, ptyId, { status: 'waiting', question, lastEvent: { kind: 'ask' } }) : none(state);
}

// The worker never started (a pty that would not spawn, a worktree git refused): as exit, and the task carries the message and leaves the
// candidates until a manual start; the bar shows it too. No automatic retry: the same fill would fail the same way, in a tight loop.
// Its exit stops the task too (#283), and the session its new run appended goes: the stage reads as not run, so the task offers Start again.
// The activity's error is marked SPAWN_FAILED so the page can tell a start's failure from the others' (#945); the bar keeps the raw text.
function spawnFailed(state: State, ptyId: string, message: string): Reduced {
  const terminal = state.terminals.find((s) => s.terminalId === ptyId);
  // A terminal is the bar only (#283). Its first open never ran: it goes, with whatever files its spawn made; a wake's failure sleeps it
  // again and a command's run leaves, as their exit does (#696)
  if (terminal !== undefined && terminal.command === undefined && terminal.woken === undefined) {
    return { state: { ...state, terminals: state.terminals.filter((t) => t !== terminal), error: message }, effects: [{ type: 'dropTerminalFiles', terminalId: ptyId }] };
  }
  if (terminal) return none({ ...exit(state, ptyId).state, error: message });
  const worker = state.workers.find((s) => s.runId === ptyId);
  if (!worker || worker.status === 'empty') return none(state);
  if (worker.freeSession) { // the bar only: a session is the user's own, its task waits for nothing; the session its open appended goes (#283)
    const exited = exit(state, ptyId).state;
    const owner = taskOfWorker(exited, worker);
    return none({ ...(owner ? forgetFailedFreeRun(exited, owner, worker) : forgetFailedLocal(exited, worker)), error: message });
  }
  const freed = exit(state, ptyId).state;
  const found = taskOfWorker(freed, worker); // the task as exit left it (worker already dropped): one source, never two
  const forgotten = found ? forgetFailedSession(freed, found, worker) : freed;
  const task = found && taskOfWorker(forgotten, worker);
  return none({ ...(task ? withError(forgotten, task, SPAWN_FAILED + message) : forgotten), error: message });
}

// The end of the command (a Stop after hive_done): the transition `end` fires is taken (#134), or the one a handoff waited on. The worker goes
// on in place with the destination's prompt when it can, otherwise the session dies and the task waits for a worker; a delete-activity stage
// it entered with no `after` pending cleans it at once, after the kill (#284).
function finish(state: State, ptyId: string, end: EndOf = { trigger: 'done' }): Reduced {
  const worker = state.workers.find((s) => s.runId === ptyId);
  const task = worker && taskOfWorker(state, worker);
  if (!worker || !task) return exit(state, ptyId);
  const live = activityOf(state, taskId(task));
  const pending = transitionByKey(state.transitions, live?.handoffPending); // #692, #134: the transition the handoff waited on, with its feedback
  const dropped = dropWorker(state, task);
  const { state: advanced, moved, next, effects: finished, transition, handover } = pending ? take(withoutPending(dropped, task), task, pending, pendingEnd(live, end)) : advance(dropped, task, end);
  const freed: State = { ...advanced, workers: releaseWorker(state.workers, worker) }; // as if the worker were free: what fill would see
  if (next && transition && keepsRun(state, task, transition, next) && canContinue(freed, worker, moved, next)) {
    return continueInPlace(freed, worker, ptyId, moved, next, finished, handover?.prompt, next.name === task.stage);
  }
  // the run ends here (a continuation is the same run, #248); then the due deletions, this task's included (#284)
  const ended = runActions(releaseRun(freed, worker, Date.now()), [{ type: 'kill', slug: slugOf(state, taskId(task)), ptyId }, ...finished]);
  return continueIntoHeld(ended, worker, moved, next); // #727, #877: into a commands or evaluate stage under the continuation's gate
}

// A Stop after hive_done (#268, #692, #134): its verdict when it gave one, else done. An approval stage waits for the user, unless the verdict
// has a transition of its own or what just ended is the handoff a transition asked for; then the handoff the destination asks for comes first.
// #861: a run whose stage was deleted under it asks for no approval, handoff or checkpoint: finish's advance halts the task with STAGE_GONE
function endStage(state: State, ptyId: string, task: Task | undefined): Reduced {
  if (!task) return finish(state, ptyId);
  if (activityOf(state, taskId(task))?.stageGone !== undefined) return finish(state, ptyId);
  return capturedFirst(state, task, stageEnd(state, ptyId, task)); // #619: whatever the end emits, the checkpoint that ended is captured first
}

function stageEnd(state: State, ptyId: string, task: Task): Reduced {
  const verdict = state.workers.find((s) => s.runId === ptyId)?.verdict;
  const end: EndOf = verdict === undefined ? { trigger: 'done' } : { trigger: 'verdict', verdict };
  const asked = activityOf(state, taskId(task))?.handoffPending !== undefined;
  const routed = verdict !== undefined && exitOf(state, task.stage, 'verdict', verdict) !== undefined;
  if (!asked && !routed && stageOf(state.stages, task.stage)?.approval) return awaitApproval(state, ptyId, task);
  const fired = asked ? undefined : exitOf(state, task.stage, end.trigger, end.verdict); // not `exit`: runs.ts's exit is in scope here
  return needsHandoff(state, task, fired) ? askHandoff(state, task, fired, ptyId) : finish(state, ptyId, end);
}

// Delete activity on the state (#629): the records' sessions move to the main repo (or go, under scope.session), then the activity goes and
// what it kept for the task lands on a fresh one, as main's forget kept it on the task
const deleteWork = (state: State, task: Task, activity: Activity): State => keptMarks(dropActivity(keepRecord(state, task, state.deleteActivity), task), task, activity);

// The deleteActivity effect ended well: the task advances as after a prompt, minus what the scope removed (#236). A later continue stage's spawn
// recreates a removed worktree itself, through ensureWorktree, the same way any spawn does; without the session id (#208) or with the sessions dropped it starts a new one.
// The next stage may be a due delete-activity stage too: it starts here (#284).
function activityDeleted(state: State, activityId: string): Reduced {
  const activity = beingDeleted(state, activityId);
  const task = activity && taskOfActivity(state, activity.id);
  if (!task) return none(state);
  const { state: advanced, effects } = advance(deleteWork(state, task, activity), task, { trigger: 'done' });
  return runActions(advanced, effects);
}

// git refused (a dirty worktree, an unmerged branch): the task carries git's words and the bar shows them; the next manual start tries
// again. No automatic retry: every poll would fail the same way.
function deleteActivityFailed(state: State, activityId: string, message: string): Reduced {
  const activity = beingDeleted(state, activityId);
  const task = activity && taskOfActivity(state, activity.id);
  if (!activity || !task) return none(state);
  const { deleting: _deleting, ...rest } = activity;
  return none({ ...withActivity(state, { ...rest, error: message }), error: message });
}

// The source refused the stage's action (#286), a delete without admin rights or a close on a draft: the task carries the adapter's words,
// out of the fill until a manual start. Only a refused leaving action drops the leaving mark (#515): a refused close ahead of an archive
// leaves the archive in flight, and its closeTask must still find the task leaving.
function sourceActionFailed(state: State, id: string, message: string, leaving: boolean): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  if (!task) return none(state);
  const { leaving: _leaving, ...rest } = task;
  return none(withError(withTask(state, leaving ? rest : task), task, message));
}

// The main window's power toggle (#233): arming stamps when, so a worker already waiting gets the whole window; arming again keeps the first stamp.
function setShutdown(state: State, armed: boolean): State {
  const { shutdown: _shutdown, ...off } = state;
  return armed ? { ...state, shutdown: state.shutdown ?? { armedAt: new Date().toISOString() } } : off;
}

// The footer's keep awake (#226): the server's holder follows this flag after every reduction
function setKeepAwake(state: State, on: boolean): State {
  const { keepAwake: _keepAwake, ...off } = state;
  return on ? { ...state, keepAwake: true } : off;
}

// Shut down when done (#233), after every reduction while armed: a worker waiting for the user past its window is closed as by Stop (#283)
// (the kill; the worker frees on the exit), and once no worker is occupied the mode ends with the shutdown effect, emitted once.
// Tasks in flight with no worker (budget, cap) hold nothing: nothing runs, so nothing would finish. A stage action in flight (a wait for CI holds no
// worker) holds it: it finishes on its own, and a Hive off meanwhile would cut it short (#515).
function drainForShutdown(reduced: Reduced, now: number): Reduced {
  if (!reduced.state.shutdown) return reduced;
  const due = reduced.state.workers.filter((s) => (closesAt(s, reduced.state) ?? Number.POSITIVE_INFINITY) <= now);
  const closed = due.reduce<Reduced>((r, worker) => {
    if (!worker.runId) return r;
    const next = stop(r.state, worker.runId, undefined, 'idle'); // #672: its exit records an idle sleep
    return { state: next.state, effects: [...r.effects, ...next.effects] };
  }, reduced);
  if (occupiedCount(closed.state.workers) > 0 || closed.state.activities.some(inAction)) return closed;
  const { shutdown: _shutdown, keepAwake: _keepAwake, ...off } = closed.state; // #226: keep awake ends with the shutdown it was waiting for
  return { state: off, effects: [...closed.effects, { type: 'shutdown' }] };
}

// The user's answer to a task that left the source, or the remove of a stopped local task (#132), or a leaving task whose source action
// succeeded (#286), or a local goal whose decomposition is on GitHub (#865). Close: the task goes, every session on
// it with it (the stage run, every session and its terminals, #164, #283); the worktree stays on disk (#182). Keep: it runs to the end on its own.
function closeTask(state: State, id: string): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  // deleting: the removal's answer must still find the task (#182); canRemoveCreated already refuses a deleting local task
  if (!task || activityOf(state, id)?.deleting || !(task.missing || task.leaving || canRemoveCreated(task, state) || isWrittenGoal(state, task))) return none(state);
  return dropTask(state, task);
}

// #865: a local goal whose tree is on GitHub closes while its approval still holds the run: the decomposition route ends the stage with it
const isWrittenGoal = (state: State, task: Task): boolean =>
  task.created === true && activityOf(state, taskId(task))?.approval !== undefined && decompositionWritten(resultOf(state, taskId(task)));

// A step of a decomposition's write (#865), keyed by task: after a restart a task awaiting approval may hold no worker
function decompositionIssue(state: State, { taskId: id, id: key, number }: Extract<HiveEvent, { type: 'decompositionIssue' }>): State {
  const task = state.tasks.find((c) => taskId(c) === id);
  return task ? withDecompositionIssue(state, task, key, number) : state;
}

// The task leaves the state with every run on it: its workers freed and killed, its terminals closed and forgotten, live or asleep (#696).
function dropTask(state: State, task: Task): Reduced {
  const held = workersOf(state, task);
  const closed = closeTerminals(state, task);
  const kills: Effect[] = held.flatMap((s) => (s.runId ? [{ type: 'kill' as const, slug: slugOf(state, taskId(task)), ptyId: s.runId }] : []));
  return {
    state: { ...closed.state, tasks: closeRefsTo(closed.state.tasks.filter((c) => c !== task), task), workers: held.reduce(releaseWorker, closed.state.workers) }, // #56: its relations stay, closed
    effects: [...kills, ...closed.effects],
  };
}

function keepTask(state: State, id: string): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  if (!task?.missing || activityOf(state, id)?.deleting) return none(state); // deleting: the removal's answer must still find the task (#182)
  const { missing: _missing, ...rest } = task;
  return none(withTask(state, { ...rest, orphan: true }));
}

// A stage's close all (#279): every missing task of the stage canCloseMissing allows goes in this one reduction, so no worker can start on
// one between the route's check and the close. None holds a worker: nothing to kill or free. The worktrees stay on disk (#182).
function closeMissing(state: State, stage: string): Reduced {
  const closable = (c: Task): boolean => c.stage === stage && canCloseMissing(c, state);
  return state.tasks.some(closable) ? none({ ...state, tasks: state.tasks.filter((c) => !closable(c)) }) : none(state);
}

// The server saw the worktree gone from disk and the Hive did not remove it (#208): a stopped task is only marked, which hides its session
// button and keeps a worktree session from opening there; the path, the branch and the sessions stay until the user resolves it (a later
// issue). The next SessionStart or worktreeReady writes the path again and drops the mark. A running task keeps it: its worker is inside.
function worktreeGone(state: State, id: string): Reduced {
  const activity = state.activities.find((a) => a.id === id);
  if (!activity || activity.workerId !== undefined || activity.worktree === undefined || activity.worktreeGone) return none(state);
  return none(withActivity(state, { ...activity, worktreeGone: true }));
}

// The delete-activity route is about to run git (#182, #573): the stage's mark, so the fill, a manual start and a delete-activity stage leave
// the task alone until the answer, and its terminals closed. Only a task canDeleteActivity allows: the route checked it, a race lands here as a no-op.
function deletingActivity(state: State, id: string): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  if (!task || !canDeleteActivity(task, state)) return none(state);
  const born = ensureActivity(state, task); // a delete-activity stage's click on a task with nothing to delete still needs the mark's activity (#629)
  if (!born) return none(state);
  const closed = closeTerminals(born.state, task);
  const activity = activityOf(closed.state, id) ?? born.activity; // #755: as closeTerminals left it, its commands stage stopped
  return { state: withActivity(closed.state, { ...activity, deleting: true }), effects: closed.effects };
}

// git removed it (#182): the task forgets what the scope removed (#236), as the delete-activity stage's `activityDeleted` does; the next spawn
// recreates the worktree at the same path (ensureWorktree). In a delete-activity stage the button did the stage's job, so the task
// goes through `activityDeleted` itself and advances (#210), minus the error an earlier refusal left: isIdle would hold it in the next stage.
// onStart is never written: the task sat in the stage only for one git call. Elsewhere it stays in its stage, its error and stopped mark kept.
function activityRemoved(state: State, id: string): Reduced {
  const activity = deletingOf(state, id);
  const task = state.tasks.find((c) => taskId(c) === id);
  if (!activity || !task) return none(state);
  if (stageOf(state.stages, task.stage)?.action === 'deleteActivity') {
    const { error: _error, ...cleared } = activity; // the error goes, so the next stage does not hold the task
    return activityDeleted(withActivity(state, cleared), activity.id);
  }
  return none(deleteWork(state, task, activity));
}

// excluir task… (#542) is about to run git on a created task's worktree: the mark holds the fill, a start and an open off until the answer,
// and its terminals are closed first (#573). The scope never blocks it: the worktree and its branch always go.
function deletingTask(state: State, id: string): Reduced {
  const task = state.tasks.find((c) => taskId(c) === id);
  const activity = activityOf(state, id);
  if (!task || activity?.worktree === undefined || activity.local || !canRemoveCreated(task, state)) return none(state);
  const closed = closeTerminals(state, task);
  return { state: withActivity(closed.state, { ...(activityOf(closed.state, id) ?? activity), deleting: true }), effects: closed.effects }; // #755: as closeTerminals left it
}

// git removed it (#542): the task goes in this same reduction, so no fill between git and the close can hand it a worker again.
function taskDeleted(state: State, id: string): Reduced {
  const task = deletingOf(state, id) && state.tasks.find((c) => taskId(c) === id);
  return task?.created ? dropTask(state, task) : none(state);
}

// A session's stop frees its worker only on the exit, which fills (#283); a commands run's stop frees it here with no exit to follow, so it
// fills now or the worker idles until the next event (#727)
function stopped(state: State, { ptyId, close, cause, block }: Extract<HiveEvent, { type: 'stop' }>): Reduced {
  const halted = stop(state, ptyId, close, cause, block);
  return state.activities.some((a) => a.commands?.ptyId === ptyId) ? fill(halted) : halted;
}

// git refused or failed: only the mark goes. Nothing was confirmed gone, so nothing is forgotten.
function activityKept(state: State, id: string): Reduced {
  const activity = deletingOf(state, id);
  return activity ? none(unmarked(state, activity)) : none(state);
}

function describeTool(p: HookPayload): string {
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const detail = String(input.command ?? input.file_path ?? input.pattern ?? '').slice(0, 60);
  const name = p.tool_name ?? 'tool';
  return detail ? `${name}: ${detail}` : name;
}

// The worker's own work still in flight at a Stop (#367): background tasks and session crons wake it without the user. Anything but an
// array (an older Claude Code without the fields, a forged hook) counts as nothing, which keeps the plain turn end's wait.
const inFlight = (p: HookPayload): number =>
  (Array.isArray(p.background_tasks) ? p.background_tasks.length : 0) + (Array.isArray(p.session_crons) ? p.session_crons.length : 0);

// One sample per turn: the delta against the total seen at this worker's previous turn end. A smaller total means the
// transcript was replaced, so the whole new total counts. A delta of 0 adds nothing; pruning happens on insert.
// The task counts the same delta, and its session keeps the total a resume measures from (#248) and the /rename title the turn read (#489).
function recordUsage(state: State, worker: Worker, tokens: number, title?: string): State {
  const previous = worker.tokens ?? 0;
  const delta = tokens >= previous ? tokens - previous : tokens;
  const now = new Date();
  const workers = state.workers.map((s) => (s.runId === worker.runId ? { ...s, tokens } : s));
  const usage = delta > 0 ? pruneUsage([...state.usage, { at: now.toISOString(), tokens: delta }], now.getTime()) : state.usage;
  const task = taskOfWorker(state, worker);
  const counted = task ? withTurn(state, task, worker, tokens, delta, title) : withLocalTurn(state, worker, tokens, title);
  return { ...counted, workers, usage };
}

// A free session running a session whose worktree the Hive removed (#208): its cwd is the main repo, never the task's worktree.
const inMainRepo = (state: State, task: Task, worker: Worker): boolean => worker.freeSession === true && sessionsOf(state, taskId(task)).some((s) => s.id === worker.sessionId && s.repo === true);

// #927: a stage run that started with no id, for an agent that picks its own (Codex), takes its first SessionStart's onto its activity and into
// a session of the running stage, as occupy records the id the Hive chose. An activity that holds an id (Claude's, or a continue) keeps it
function firstSession(state: State, worker: Worker, id: string): State {
  const task = taskOfWorker(state, worker);
  const activity = activityOfWorker(state, worker);
  if (!task || !activity || activity.sessionId !== undefined) return state;
  return touchSession(withActivity(state, { ...activity, sessionId: id }), task, id, task.stage, worker.startedAt ?? new Date().toISOString(), ranAgent(worker));
}

// #932: a free run that started with no id (a captured Codex) records its first SessionStart's where captureSession records Claude's, with its
// agent. The activity's own sessionId stays the stage run's: a free session never takes its place. #347: a resumed capture goes through
// resumedStart first, which releases it or places it with the activity holding the session
function firstFreeSession(state: State, worker: Worker, id: string, cwd?: unknown): State {
  const resumed = worker.resumed ? resumedStart(state, worker, id, cwd) : undefined;
  if (resumed !== undefined) return resumed;
  const activity = activityOfWorker(state, worker);
  return (activity && recordCapturedSession(state, activity, id, worker.startedAt ?? new Date().toISOString(), ranAgent(worker), worker.launch)) ?? state; // #257: its picks too
}

// #933: a copy of an agent that picks its own id (Codex) opened under the Hive's placeholder; the fork's SessionStart (source=fork, finding
// §3) names it, whatever hook came before. A subagent's or a resume's SessionStart is never a fork. A free run with no id at all is #932's
// capture below, not a copy
const namedFork = (worker: Worker, p: HookPayload): p is HookPayload & { session_id: string } =>
  p.source === 'fork' && worker.freeSession === true && worker.sessionId !== undefined && !AGENTS[ranAgent(worker)].canChooseSessionId
  && isUuid(p.session_id) && p.session_id !== worker.sessionId;

// The first session id wins (#24): a subagent's or a teammate's SessionStart never replaces it. A /clear's does (#655): it is the run's own new
// conversation, so the old one's entry takes the new id. A stage run with none takes the first it hears (#927), and so does a free run with none (#932).
// Only a uuid can replace or record one: it reaches --resume / codex resume, and SESSION_ID admits a leading '-'.
function namedSession(state: State, ptyId: string, worker: Worker, p: HookPayload): State {
  const id = p.session_id;
  if (namedFork(worker, p)) return renameSession(state, worker, p.session_id);
  if (p.source === 'clear' && isUuid(id) && id !== worker.sessionId) return clearSession(state, worker, id);
  if (worker.sessionId === undefined && isUuid(id)) {
    const named = patch(state, ptyId, { sessionId: id }).state;
    return worker.freeSession === true ? firstFreeSession(named, worker, id, p.cwd) : firstSession(named, worker, id);
  }
  return patch(state, ptyId, { sessionId: worker.sessionId ?? (isSessionId(id) ? id : undefined) }).state;
}

// The worktree write below goes after the session's: inMainRepo reads the session the run now runs
function sessionStart(state: State, ptyId: string, worker: Worker, p: HookPayload, branch?: string): Reduced {
  const started = namedSession(state, ptyId, worker, p);
  const current = started.workers.find((s) => s.runId === ptyId); // inMainRepo reads the session it now runs
  if (!current) return none(started); // #347: a resumed capture of another folder was released: its cwd is no activity's to write
  const task = taskOfWorker(started, current);
  const activity = activityOfWorker(started, current);
  if (!task || !activity || inMainRepo(started, task, current)) return none(started); // the activity keeps no path: a repo session's cwd is the main repo (#208)
  const { worktreeGone: _gone, ...seen } = activity; // the path is written again: the mark goes (#208)
  return none(withActivity(started, { ...seen, worktree: p.cwd, branch }));
}

function applyHook(initial: State, ptyId: string, p: HookPayload, branch?: string, tokens?: number, title?: string): Reduced {
  const worker = initial.workers.find((s) => s.runId === ptyId);
  if (!worker || worker.status === 'empty') return none(initial);
  // A Stop / StopFailure / SessionEnd from a subagent or teammate is not the worker's turn end: skip before the token sample lands (#24, #805)
  const turnEnd = p.hook_event_name === 'Stop' || p.hook_event_name === 'StopFailure' || p.hook_event_name === 'SessionEnd';
  if (turnEnd && isChildSession(worker, p)) return none(initial);
  const seen = patch(initial, ptyId, { seenAt: new Date().toISOString() }).state; // where boot closes the run (#248)
  const counted = tokens === undefined ? seen : recordUsage(seen, worker, tokens, title); // only the server sets tokens and title (turn ends)
  const state = settleWait(counted, ptyId, p.hook_event_name); // #805: a Stop ends a wait and its count, a prompt or a tool the wait only
  const task = taskOfWorker(state, worker);
  switch (p.hook_event_name) {
    case 'SessionStart': return sessionStart(state, ptyId, worker, p, branch);
    case 'UserPromptSubmit':
      return patch(state, ptyId, { status: 'working', question: undefined, lastEvent: { kind: 'prompt' } });
    case 'PreToolUse':
      return patch(state, ptyId, { status: 'working', question: undefined, lastEvent: { kind: 'tool', detail: describeTool(p) } });
    case 'Notification': {
      const kind = String(p.notification_type ?? '');
      if (!WAITING_NOTIFICATIONS.includes(kind)) return none(state);
      if (worker.lastEvent?.kind === 'ask') return patch(state, ptyId, { status: 'waiting' }); // the worker's own question outranks the generic text
      return patch(state, ptyId, { status: 'waiting', question: String(p.message ?? kind), lastEvent: { kind: 'waiting', detail: kind } });
    }
    case 'PostToolUse': {
      const prUrl = extractPrUrl(String((p.tool_input as { command?: unknown } | undefined)?.command ?? ''), p.tool_response);
      return prUrl ? markPr(state, ptyId, prUrl) : none(state); // the safety net under hive_pr
    }
    case 'Stop': { // the end of the command only after hive_done; otherwise the worker is idle and the worker waits, unless its own work will wake it
      if (worker.done) return fill(endStage(state, ptyId, task)); // an approval stage waits for the user (#268); a handoff the next stage needs comes first (#692)
      // after hive_ask the worker ends its turn to wait for the answer: the question and the ask stay until a prompt or a tool (#99), background work or not (#367)
      if (worker.lastEvent?.kind === 'ask') return patch(state, ptyId, { status: 'waiting' });
      const pending = inFlight(p);
      // a subagent, a shell or a cron will wake the worker: not the user's turn, so green with the count; its next Stop decides again (#367)
      if (pending > 0) return patch(state, ptyId, { status: 'working', question: undefined, lastEvent: { kind: 'background', detail: String(pending) } });
      return patch(state, ptyId, { status: 'waiting', question: undefined, lastEvent: { kind: 'turn' } });
    }
    case 'StopFailure': // #805: after hive_done the stage already reported done, so the failure is that run's Stop: its wait and count go, the
      // stage ends (or awaits approval, or asks its handoff) and the fill runs, with no backoff and no error. Otherwise the rule decides; no
      // fill on a wait: the worker keeps its slot, and a stop frees it on the exit
      return worker.done ? fill(endStage(settleWait(state, ptyId, 'Stop'), ptyId, task)) : stopFailure(state, ptyId, worker, p, Date.now());
    case 'SessionEnd': return p.reason === 'clear' ? none(state) : ended(exit(state, ptyId)); // a /clear ends the conversation, not the process (#655)
    default: return none(state);
  }
}
