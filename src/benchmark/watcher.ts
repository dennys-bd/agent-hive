import { activityOf, resultOf, taskOfWorker } from '../activities.js';
import type { State, Task } from '../types.js';

export const DONE_STAGE = 'Done';
export const BUILD_STAGE = 'Build';
export const POLL_MS = 15_000;
const UNREACHABLE_MAX = 4; // failed reads in a row before the run is an error: a daemon busy for a minute is not dead

// #629: a task's error and stopped, and a worker's task, are read through its activity
export type Snapshot = Pick<State, 'tasks' | 'workers' | 'activities' | 'activityRecords'>;
export interface WatchTask { itemId: string; blockedBy: string[] }
export interface StageEntry { stage: string; at: string }
export interface WatchState {
  tasks: WatchTask[]; // the blocker graph, in seed order
  released: string[]; // auto tasks: the free ones at boot, the others as their blockers reach Done
  entries: Record<string, StageEntry[]>; // every stage each task entered: the State keeps only the current one
  buildRuns: Record<string, string[]>; // every run id seen while the task sat in Build
}
export type WatchEnd = { outcome: 'done' } | { outcome: 'timeout' } | { outcome: 'error'; reason: string };
export interface Step { watch: WatchState; release: string[]; end?: WatchEnd }
export interface WatchClient { state(): Promise<Snapshot>; setAuto(itemId: string): Promise<void>; setGreen(): Promise<void> }
export interface WatchDeps { client: WatchClient; now(): Date; sleep(ms: number): Promise<void>; log(line: string): void; timeoutMs: number; pollMs?: number }
export interface WatchResult { end: WatchEnd; watch: WatchState }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const taskOf = (snapshot: Snapshot, itemId: string): Task | undefined => snapshot.tasks.find((t) => t.item.itemId === itemId);
const idsOf = (watch: WatchState): string[] => watch.tasks.map((t) => t.itemId);

export const startWatch = (tasks: WatchTask[]): WatchState =>
  ({ tasks, released: tasks.filter((t) => t.blockedBy.length === 0).map((t) => t.itemId), entries: {}, buildRuns: {} });

function withEntries(watch: WatchState, snapshot: Snapshot, now: Date): WatchState['entries'] {
  return Object.fromEntries(idsOf(watch).map((id) => {
    const seen = watch.entries[id] ?? [];
    const task = taskOf(snapshot, id);
    if (!task || seen.at(-1)?.stage === task.stage) return [id, seen];
    return [id, [...seen, { stage: task.stage, at: task.enteredAt ?? now.toISOString() }]];
  }));
}

// More than one stage run id in Build means it was restarted (a Continue or a respawn)
function withBuildRuns(watch: WatchState, snapshot: Snapshot): WatchState['buildRuns'] {
  return Object.fromEntries(idsOf(watch).map((id) => {
    const seen = watch.buildRuns[id] ?? [];
    const inBuild = taskOf(snapshot, id)?.stage === BUILD_STAGE;
    const runs = inBuild ? snapshot.workers.flatMap((w) => (taskOfWorker(snapshot, w)?.item.itemId === id && w.runId !== undefined && !w.freeSession ? [w.runId] : [])) : [];
    return [id, [...seen, ...runs.filter((r) => !seen.includes(r))]];
  }));
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

/** One read of the State: its entries and runs, every task it frees (all blockers in Done), or the end it calls for. */
export function observe(watch: WatchState, snapshot: Snapshot, now: Date): Step {
  const next = { ...watch, entries: withEntries(watch, snapshot, now), buildRuns: withBuildRuns(watch, snapshot) };
  const reason = failure(watch, snapshot);
  if (reason) return { watch: next, release: [], end: { outcome: 'error', reason } };
  const done = new Set(idsOf(watch).filter((id) => taskOf(snapshot, id)?.stage === DONE_STAGE));
  if (done.size === watch.tasks.length) return { watch: next, release: [], end: { outcome: 'done' } };
  const release = watch.tasks.filter((t) => !watch.released.includes(t.itemId) && t.blockedBy.every((b) => done.has(b))).map((t) => t.itemId);
  return { watch: { ...next, released: [...watch.released, ...release] }, release };
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

/** Polls one run's daemon until every task is in Done, the timeout passes, or a task fails. Never writes state.json. */
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

export async function watchRun(tasks: WatchTask[], deps: WatchDeps): Promise<WatchResult> {
  const deadline = deps.now().getTime() + deps.timeoutMs;
  let watch = startWatch(tasks);
  // A booted daemon opens yellow (runs.ts boot), and yellow starts no task: without green the released tasks would wait out the timeout
  const refused = await turnGreen(deps);
  if (refused !== undefined) return { end: { outcome: 'error', reason: `could not turn the daemon green: ${refused}` }, watch };
  let misses = 0;
  while (deps.now().getTime() < deadline) {
    const step = await readStep(watch, deps);
    misses = step ? 0 : misses + 1;
    if (misses >= UNREACHABLE_MAX) return { end: { outcome: 'error', reason: 'the daemon stopped answering' }, watch };
    if (step) {
      watch = step.watch;
      const end = step.end ?? (await releaseAll(step.release, deps));
      if (end) return { end, watch };
    }
    await deps.sleep(deps.pollMs ?? POLL_MS);
  }
  return { end: { outcome: 'timeout' }, watch };
}
