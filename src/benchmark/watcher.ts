import { activityOf, resultOf, taskOfWorker } from '../activities.js';
import type { State, Status, Task } from '../types.js';

export const DONE_STAGE = 'Done';
export const POLL_MS = 15_000;
const UNREACHABLE_MAX = 4; // failed reads in a row before the run is an error: a daemon busy for a minute is not dead

// #629: a task's error and stopped, and a worker's task, are read through its activity
export type Snapshot = Pick<State, 'tasks' | 'workers' | 'activities' | 'activityRecords' | 'slept'>; // slept is optional in State
/** A task of the run (#473): its item id in the run's Hive, and the seed's key and title, which name it outside the run (no token in them). */
export interface WatchTask { itemId: string; key: string; title: string; blockedBy: string[] }
export interface StageEntry { stage: string; at: string }
export interface WatchState {
  tasks: WatchTask[]; // the blocker graph, in seed order
  released: string[]; // auto tasks: the free ones at boot, the others as their blockers reach Done
  entries: Record<string, StageEntry[]>; // every stage each task entered: the State keeps only the current one
  stageRuns: Record<string, Record<string, string[]>>; // item id → stage → every run id seen while the task sat there (#473: every stage)
  sleptRuns: string[]; // run ids seen in the daemon's slept list with cause 'all': a continue resumes them, it never restarts them (#472)
}
/** The execution bar (#473): a segment per task, green done, yellow waiting on the user, grey open. */
export interface TaskProgress { key: string; state: 'done' | 'waiting' | 'open' }
export interface Progress { delivered: number; total: number; waiting: boolean; tasks: TaskProgress[] }
export type WatchEnd = { outcome: 'done' } | { outcome: 'timeout' } | { outcome: 'aborted' } | { outcome: 'error'; reason: string };
export interface Step { watch: WatchState; release: string[]; progress: Progress; end?: WatchEnd }
export interface WatchClient { state(): Promise<Snapshot>; setAuto(itemId: string): Promise<void>; setGreen(): Promise<void> }
export interface WatchDeps {
  client: WatchClient; now(): Date; sleep(ms: number): Promise<void>; log(line: string): void; timeoutMs: number; pollMs?: number;
  onProgress?(progress: Progress): void; // 3.2 turns it into benchmarkRunChanged
  sleptMs?(): number; // the run's time asleep so far (3.2): the user's time, not the run's
  signal?: AbortSignal; // 3.2's stop
}
export interface WatchResult { end: WatchEnd; watch: WatchState }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const taskOf = (snapshot: Snapshot, itemId: string): Task | undefined => snapshot.tasks.find((t) => t.item.itemId === itemId);
const idsOf = (watch: WatchState): string[] => watch.tasks.map((t) => t.itemId);

export const startWatch = (tasks: WatchTask[]): WatchState =>
  ({ tasks, released: tasks.filter((t) => t.blockedBy.length === 0).map((t) => t.itemId), entries: {}, stageRuns: {}, sleptRuns: [] });

function withEntries(watch: WatchState, snapshot: Snapshot, now: Date): WatchState['entries'] {
  return Object.fromEntries(idsOf(watch).map((id) => {
    const seen = watch.entries[id] ?? [];
    const task = taskOf(snapshot, id);
    if (!task || seen.at(-1)?.stage === task.stage) return [id, seen];
    return [id, [...seen, { stage: task.stage, at: task.enteredAt ?? now.toISOString() }]];
  }));
}

const WAITING: readonly Status[] = ['waiting', 'approval']; // a worker held on the user: a question, a permission, an approval

const runsOf = (snapshot: Snapshot, itemId: string): string[] =>
  snapshot.workers.flatMap((w) => (taskOfWorker(snapshot, w)?.item.itemId === itemId && w.runId !== undefined && !w.freeSession ? [w.runId] : []));

// The daemon drops a slept record once its session continues, so the ids are kept from the reads made while the experiment slept
const sleptAll = (snapshot: Snapshot): string[] => (snapshot.slept ?? []).filter((s) => s.cause === 'all').map((s) => s.ptyId);

// More than one run id in a stage means the task restarted there (a Continue, a respawn, a feedback): counted in every stage (#473).
// A run that slept with the sleep all is continued by the wake (#472): the run after it takes its place, so the wake is no restart
function withStageRuns(watch: WatchState, snapshot: Snapshot): WatchState['stageRuns'] {
  return Object.fromEntries(idsOf(watch).map((id) => {
    const seen = watch.stageRuns[id] ?? {};
    const stage = taskOf(snapshot, id)?.stage;
    if (stage === undefined) return [id, seen];
    const before = seen[stage] ?? [];
    const fresh = runsOf(snapshot, id).filter((r) => !before.includes(r));
    if (fresh.length === 0) return [id, seen];
    const woke = before.length > 0 && watch.sleptRuns.includes(before[before.length - 1]);
    return [id, { ...seen, [stage]: woke ? [...before.slice(0, -1), ...fresh] : [...before, ...fresh] }];
  }));
}

// The user holds the task: a stage end waiting for approve (#268), or a worker on a question, a permission or an approval
function isWaiting(snapshot: Snapshot, itemId: string): boolean {
  if (activityOf(snapshot, itemId)?.approval !== undefined) return true;
  return snapshot.workers.some((w) => WAITING.includes(w.status) && taskOfWorker(snapshot, w)?.item.itemId === itemId);
}

export function progressOf(watch: WatchState, snapshot: Snapshot): Progress {
  const tasks = watch.tasks.map(({ itemId, key }): TaskProgress => {
    if (taskOf(snapshot, itemId)?.stage === DONE_STAGE) return { key, state: 'done' };
    return { key, state: isWaiting(snapshot, itemId) ? 'waiting' : 'open' };
  });
  return { delivered: tasks.filter((t) => t.state === 'done').length, total: tasks.length, waiting: tasks.some((t) => t.state === 'waiting'), tasks };
}

// Unattended, nothing restarts a failed task
function failure(watch: WatchState, snapshot: Snapshot): string | undefined {
  for (const id of idsOf(watch)) {
    const task = taskOf(snapshot, id);
    if (!task) return `${id} left the Hive`;
    const activity = activityOf(snapshot, id);
    if (activity?.error) return `${task.item.id}: ${activity.error}`;
    if (activity?.stopped) return `${task.item.id}: its ${task.stage} run ended without hive_done`;
    // A Merge that could not push still ends with hive_done, and the task reaches Done without its delivery on the run branch
    const result = task.stage === DONE_STAGE ? resultOf(snapshot, id) : undefined;
    if (result?.merged === false) return `${task.item.id}: its Merge ended without merging: ${String(result.reason ?? 'no reason given')}`;
  }
  return undefined;
}

/** One read of the State: its entries and runs, its progress, every task it frees (all blockers in Done), or the end it calls for. */
export function observe(watch: WatchState, snapshot: Snapshot, now: Date): Step {
  const sleptRuns = [...new Set([...watch.sleptRuns, ...sleptAll(snapshot)])]; // before the stage runs, so a slept record and its wake in one read still pair
  const next = { ...watch, sleptRuns, entries: withEntries(watch, snapshot, now), stageRuns: withStageRuns({ ...watch, sleptRuns }, snapshot) };
  const progress = progressOf(watch, snapshot);
  const reason = failure(watch, snapshot);
  if (reason) return { watch: next, release: [], progress, end: { outcome: 'error', reason } };
  if (progress.delivered === watch.tasks.length) return { watch: next, release: [], progress, end: { outcome: 'done' } };
  const done = new Set(idsOf(watch).filter((id) => taskOf(snapshot, id)?.stage === DONE_STAGE));
  const release = watch.tasks.filter((t) => !watch.released.includes(t.itemId) && t.blockedBy.every((b) => done.has(b))).map((t) => t.itemId);
  return { watch: { ...next, released: [...watch.released, ...release] }, release, progress };
}

async function readStep(watch: WatchState, deps: WatchDeps): Promise<Step | undefined> {
  try {
    return observe(watch, await deps.client.state(), deps.now());
  } catch (err) {
    deps.log(`state read failed: ${message(err)}`);
    return undefined;
  }
}

// A refused release ends the run: nothing else would ever start that task
async function releaseAll(itemIds: readonly string[], deps: WatchDeps): Promise<WatchEnd | undefined> {
  for (const itemId of itemIds) {
    const refused = await retried(() => deps.client.setAuto(itemId), deps);
    if (refused !== undefined) return { outcome: 'error', reason: `could not release ${itemId}: ${refused}` };
    deps.log(`released ${itemId}`);
  }
  return undefined;
}

// A busy daemon (just booted beside its pair's, or starting the task a release just freed) can miss a request's timeout: both requests
// are idempotent, so each is tried as often as a read may miss, a poll apart. Returns the last refusal, or undefined once one went through.
async function retried(call: () => Promise<void>, deps: WatchDeps): Promise<string | undefined> {
  for (let tries = 1; ; tries += 1) {
    try {
      await call();
      return undefined;
    } catch (err) {
      if (tries >= UNREACHABLE_MAX) return message(err);
      await deps.sleep(deps.pollMs ?? POLL_MS);
    }
  }
}

const turnGreen = (deps: WatchDeps): Promise<string | undefined> => retried(() => deps.client.setGreen(), deps);

// The poll's sleep, cut short by an abort: a Stop must not wait out a poll
function napOf(deps: WatchDeps): (ms: number) => Promise<void> {
  const { signal } = deps;
  if (!signal) return (ms) => deps.sleep(ms);
  const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  return (ms) => Promise.race([deps.sleep(ms), aborted]);
}

const sameProgress = (a: Progress | undefined, b: Progress): boolean => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/** Polls one run's daemon until every task is in Done, the timeout passes (slept time off the clock), a task fails or the signal aborts.
 *  Never writes state.json. An abort ends the poll's sleep; a release being retried finishes its tries first. */
export async function watchRun(tasks: WatchTask[], deps: WatchDeps): Promise<WatchResult> {
  const startedAt = deps.now().getTime();
  const awakeMs = (): number => deps.now().getTime() - startedAt - (deps.sleptMs?.() ?? 0);
  let watch = startWatch(tasks);
  // A booted daemon opens yellow (runs.ts boot), and yellow starts no task: without green the released tasks would wait out the timeout
  const refused = await turnGreen(deps);
  if (refused !== undefined) return { end: { outcome: 'error', reason: `could not turn the daemon green: ${refused}` }, watch };
  let misses = 0;
  let reported: Progress | undefined;
  const nap = napOf(deps);
  while (awakeMs() < deps.timeoutMs && !deps.signal?.aborted) {
    const step = await readStep(watch, deps);
    misses = step ? 0 : misses + 1;
    if (misses >= UNREACHABLE_MAX) return { end: { outcome: 'error', reason: 'the daemon stopped answering' }, watch };
    if (step) {
      watch = step.watch;
      if (!sameProgress(reported, step.progress)) {
        reported = step.progress;
        deps.onProgress?.(step.progress);
      }
      const end = step.end ?? (await releaseAll(step.release, deps));
      if (end) return { end, watch };
    }
    await nap(deps.pollMs ?? POLL_MS);
  }
  return { end: deps.signal?.aborted ? { outcome: 'aborted' } : { outcome: 'timeout' }, watch };
}
