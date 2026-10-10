import { taskOfActivity, withActivity } from './activities.js';
import { type CiVerdict, ciVerdict, cleanName } from './ci-checks.js';
import { prRepo } from './pull-requests.js';
import { withResult } from './record-kit.js';
import { ensureActivity, none, type Reduced, sourceWrites, stoppedWork, withTask } from './reducer-kit.js';
import { onSource, stageOf } from './tasks.js';
import { timeoutMs } from './timeout.js';
import { advance } from './transit.js';
import { exitOf } from './transitions.js';
import { CI_FAILED, type Activity, type CiCheck, type CiPrRead, type CiRerun, type HiveEvent, type Stage, type StageCi, type State, type Task } from './types.js';

// A stage that waits for the CI of the task's open PRs (#834), beside stage-commands.ts and out of orchestrator.ts, which is over 800 lines.
// Pure: every function returns new objects. The server reads the checks (server-ci.ts) and answers ciRead; the failed logs come back with
// ciFailed. Known ceiling: a save that removes the stage while a task waits there drops the stopped task with it, as for a commands stage.

const NAMES_SHOWN = 3; // the error names the first failures; the rest count as +n
const RERUN_GRACE_MS = 5 * 60_000; // how long after a re-run's ask an old failure still reads as pending

/** A wait-for-CI stage starts on the task (#834): its onStart list written in order, the wait on the activity, born for it when it has none,
 * its last failure cleared, and a read at once. No worker, no worktree, no signal, no budget: nothing runs here. */
export function startCi(given: State, task: Task): Reduced {
  const stage = stageOf(given.stages, task.stage);
  const born = ensureActivity(given, task);
  if (!born || stage?.action !== 'waitForCi') return none(given); // dueActions and start only pass a task with a workspace
  const written = sourceWrites(task, onSource(stage.onStart, task.item.source));
  const { stopped: _stopped, stoppedAt: _stoppedAt, error: _error, ...unstopped } = born.activity;
  const waiting: Activity = { ...unstopped, ci: { stage: stage.name, since: new Date().toISOString(), reran: [] } };
  return { state: withActivity(withTask(born.state, written.task), waiting), effects: [...written.effects, { type: 'ciRead', activityId: waiting.id }] };
}

interface Wait { activity: Activity; ci: StageCi; task: Task }

// The wait `activityId` holds, with its task; undefined during a Quit, for an activity holding none, and once the task left
function waitOf(state: State, activityId: string): Wait | undefined {
  if (state.cleanStop) return undefined;
  const activity = state.activities.find((a) => a.id === activityId);
  const task = activity && taskOfActivity(state, activity.id);
  return activity?.ci && task ? { activity, ci: activity.ci, task } : undefined;
}

const listed = (names: readonly string[]): string => {
  const rest = names.length - NAMES_SHOWN;
  return `${names.slice(0, NAMES_SHOWN).join(', ')}${rest > 0 ? ` +${rest}` : ''}`;
};

// failed: the verdict and the output on the record, the wait gone, the task stopped in its stage with the failures named, out of the automation
// until a manual start, as a commands stage leaves it; a failed transition takes the task on instead (#134)
function failCi(state: State, { activity, task }: Wait, output: string, names: readonly string[]): Reduced {
  const { ci: _ci, ...rest } = activity;
  if (exitOf(state, task.stage, 'verdict', 'failed') !== undefined) { // #134: a failed transition takes the task on with the logs on the record
    const failed = withResult(withActivity(state, rest), task, { ci: { verdict: 'failed', output } });
    const { state: advanced, effects } = advance(failed, task, { trigger: 'verdict', verdict: 'failed' });
    return { state: advanced, effects };
  }
  const stopped: Activity = { ...rest, stopped: true, stoppedAt: new Date().toISOString(), error: `${CI_FAILED}${listed(names)}` };
  return none(withResult(withActivity(state, stopped), task, { ci: { verdict: 'failed', output } }));
}

// passed: the verdict on the record, the wait gone, the task moved on as a commands stage's pass moves it
function passCi(state: State, { activity, task }: Wait): Reduced {
  const { ci: _ci, ...rest } = activity;
  const passed = withResult(withActivity(state, rest), task, { ci: { verdict: 'passed' } });
  const { state: advanced, effects } = advance(passed, task, { trigger: 'verdict', verdict: 'passed' }); // #134: passed fires its transition
  return { state: advanced, effects };
}

// The clock is the stage's start: a new push never resets it; no timeout, no limit
function timedOut(stage: Stage, ci: StageCi, at: string): boolean {
  const limit = stage.timeout === undefined ? undefined : timeoutMs(stage.timeout);
  return limit !== undefined && Date.parse(at) - Date.parse(ci.since) > limit;
}

// The output after a timeout, written in English as a commands stage's lines are
function timeoutOutput(stage: Stage, pending: readonly string[]): string {
  return `CI did not finish in ${stage.timeout ?? ''} · pending: ${pending.join(', ') || 'none'}`;
}

const pendingOf = (verdict: CiVerdict): string[] => {
  if (verdict.kind === 'awaiting') return verdict.workflows.map((w) => `${cleanName(w)} (awaiting approval)`); // #854: what a timeout names
  return verdict.kind !== 'pending' ? [] : verdict.waitingPr ? ['no open PR'] : verdict.pending.map(cleanName);
};
const timeoutNames = (stage: Stage): string[] => [`timed out after ${stage.timeout ?? ''}`];

// pending: the card's count; the same state when the read changed nothing, so a quiet wait writes nothing every 30 s. A running read ends a
// maintainer's wait and a held failure (#854)
function counted(state: State, activity: Activity, ci: StageCi, verdict: Extract<CiVerdict, { kind: 'pending' }>): Reduced {
  const { waitingPr: _waitingPr, awaiting: _awaiting, noRerun: _noRerun, ...rest } = ci;
  const next: StageCi = { ...rest, done: verdict.done, total: verdict.total, ...(verdict.waitingPr ? { waitingPr: true as const } : {}) };
  const was = activity.ci;
  const same = next.done === was?.done && next.total === was?.total && next.waitingPr === was?.waitingPr && next.fellBack === was?.fellBack
    && was?.awaiting === undefined && was?.noRerun === undefined;
  return none(same ? state : withActivity(state, { ...activity, ci: next }));
}

// #854: workflows await a maintainer's approval: nothing ends, the card counts them; the same state while the count holds
function awaited(state: State, activity: Activity, ci: StageCi, workflows: readonly string[]): Reduced {
  const { noRerun: _noRerun, ...rest } = ci;
  const was = activity.ci;
  const same = was?.awaiting === workflows.length && was.noRerun === undefined && was.fellBack === ci.fellBack;
  return none(same ? state : withActivity(state, { ...activity, ci: { ...rest, awaiting: workflows.length } }));
}

// #854: rerunOnce asked for a re-run the login may not ask: the wait holds for a new push or a maintainer's re-run, until its timeout
function withoutRerun(state: State, activity: Activity, ci: StageCi): Reduced {
  const was = activity.ci;
  if (was?.noRerun === true && was.awaiting === undefined && was.fellBack === ci.fellBack) return none(state);
  const { awaiting: _awaiting, ...rest } = ci;
  return none(withActivity(state, { ...activity, ci: { ...rest, noRerun: true } }));
}

const cannotRerun = (failed: readonly CiCheck[], prs: readonly CiPrRead[]): boolean => failed.some((c) => prs.find((p) => p.url === c.pr)?.canPush === false);

interface Read { activity: Activity; ci: StageCi; at: string }

// gh run rerun keeps the run's id and GitHub flips its checks to pending a little later, so a failure on a re-run head that completed by the
// re-run's ask is the old one: pending until it completes again, for RERUN_GRACE_MS at most, so a re-run gh refused still ends the wait.
// Known ceiling: one rerunAt for every head, the last re-run's
function sinceRerun({ reran, rerunAt }: StageCi, prs: readonly CiPrRead[], at: string): CiPrRead[] {
  if (rerunAt === undefined || Date.parse(at) - Date.parse(rerunAt) > RERUN_GRACE_MS) return [...prs];
  const old = (c: CiCheck): boolean => c.state === 'failure' && (c.at === undefined || Date.parse(c.at) <= Date.parse(rerunAt));
  return prs.map((p) => (reran.includes(p.head) ? { ...p, checks: p.checks.map((c) => (old(c) ? { ...c, state: 'pending' as const } : c)) } : p));
}

// failed: a re-run once per head when every failure is an Actions run on a head not re-run yet, each run once; else the logs are fetched and
// the stage ends when they are in
function failedRead(state: State, { activity, ci, at }: Read, stage: Stage, failed: CiCheck[], prs: readonly CiPrRead[]): Reduced {
  const headOf = (check: CiCheck): string => prs.find((p) => p.url === check.pr)?.head ?? '';
  const rerun = stage.rerunOnce === true && failed.every((c) => c.runId !== undefined && !ci.reran.includes(headOf(c)));
  if (!rerun) return { state: withActivity(state, { ...activity, ci: { ...ci, collecting: true } }), effects: [{ type: 'ciCollect', activityId: activity.id, failed }] };
  const runs = [...new Map(failed.flatMap((c): [string, CiRerun][] => (c.runId === undefined ? [] : [[`${prRepo(c.pr)}#${c.runId}`, { repo: prRepo(c.pr), runId: c.runId }]]))).values()];
  const reran = [...new Set([...ci.reran, ...failed.map(headOf)])];
  return { state: withActivity(state, { ...activity, ci: { ...ci, reran, rerunAt: at } }), effects: [{ type: 'ciRerun', activityId: activity.id, runs }] };
}

/** One read of the wait's PRs (#834): the timeout first, then the verdict. A wait fetching its logs, an unknown activity and a Quit ignore it.
 * The first read whose required fell back marks it, so the event log says so once. */
export function ciRead(state: State, { activityId, at, prs }: Extract<HiveEvent, { type: 'ciRead' }>): Reduced {
  const wait = waitOf(state, activityId);
  const stage = wait && stageOf(state.stages, wait.ci.stage);
  if (!wait || !stage || wait.ci.collecting) return none(state);
  const verdict = ciVerdict(sinceRerun(wait.ci, prs, at), stage);
  const ci: StageCi = verdict.fellBack && !wait.ci.fellBack ? { ...wait.ci, fellBack: true } : wait.ci;
  if (timedOut(stage, ci, at)) return failCi(state, wait, timeoutOutput(stage, pendingOf(verdict)), timeoutNames(stage));
  if (verdict.kind === 'passed') return passCi(state, wait);
  if (verdict.kind === 'awaiting') return awaited(state, wait.activity, ci, verdict.workflows);
  if (verdict.kind === 'failed') {
    if (stage.rerunOnce === true && cannotRerun(verdict.failed, prs)) return withoutRerun(state, wait.activity, ci);
    return failedRead(state, { activity: wait.activity, ci, at }, stage, verdict.failed, prs);
  }
  return counted(state, wait.activity, ci, verdict);
}

/** A tick with no read (#834): the query failed or left a PR out, so only the timeout is checked. The names pending are unknown without a
 * read; the last one's no open PR is kept. */
export function ciClock(state: State, { activityId, at }: Extract<HiveEvent, { type: 'ciClock' }>): Reduced {
  const wait = waitOf(state, activityId);
  const stage = wait && stageOf(state.stages, wait.ci.stage);
  if (!wait || !stage || wait.ci.collecting || !timedOut(stage, wait.ci, at)) return none(state);
  return failCi(state, wait, timeoutOutput(stage, wait.ci.waitingPr ? ['no open PR'] : []), timeoutNames(stage));
}

/** The failed logs are in (#834): the wait ends failed. Only for a wait that is fetching them. */
export function ciFailed(state: State, { activityId, names, output }: Extract<HiveEvent, { type: 'ciFailed' }>): Reduced {
  const wait = waitOf(state, activityId);
  return wait?.ci.collecting ? failCi(state, wait, output, names) : none(state);
}

/** The activity's wait stopped (#834): the user's Stop or a sleep (stopCi), its activity deleted, or its task closed or deleted. The wait goes
 * and the activity is stopped, with no verdict and nothing to kill; the same state when nothing waits there. */
export function haltCi(state: State, activityId: string): State {
  const activity = state.activities.find((a) => a.id === activityId);
  if (activity?.ci === undefined) return state;
  const { ci: _ci, ...rest } = activity;
  return withActivity(state, stoppedWork(rest));
}

/** A wait past a boot (#834): a log fetch in flight died with the Hive, so the next read decides again. */
export const uncollected = ({ collecting: _collecting, ...ci }: StageCi): StageCi => ci;
