import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialState, isSessionId, isUuid, SIGNALS, STATUSES } from './orchestrator.js';
import { syncOf } from './polling.js';
import { loadPlanReadings } from './rate-limits.js';
import { isLocalActivityId, pruneRecords } from './activities.js';
import { savedAgent } from './agents.js';
import { isCount, isDate, isJsonObject, isStringArray, loadActivity, loadRecord, SLUG } from './state-guards.js';
import { MOVED_TASK_KEYS, migrateLocals, migrateWork, migrateWorker } from './state-migrate.js';
import type { WorkspaceNames } from './tasks.js';
import { loadBenchmark } from './benchmark-guards.js';
import { copyDisabledRule, isDisabledRule } from './usage-rules.js';
import { AGENT_IDS, APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, MAX_CONCURRENT_DEFAULT, MAX_CONCURRENT_MAX, RATE_LIMIT_WAIT_DEFAULT, RULE_SIGNALS, RULE_SOURCES, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS, type Item, type Task, type Terminal, type Signal, type Worker, type WorkerEvent, type WorkerEventKind, type State, type Status, type UsageRule, type UsageSample } from './types.js';

const STATE_FILE = 'state.json';

const isSignal = (value: unknown): value is Signal => SIGNALS.includes(value as Signal);
const isSample = (value: unknown): value is UsageSample =>
  typeof value === 'object' && value !== null
  && typeof (value as UsageSample).at === 'string' && Number.isFinite((value as UsageSample).tokens);

// Config validates the rules; here only the shape is checked, so a hand-edited state.json cannot feed the reducer garbage.
const isRule = (value: unknown): value is UsageRule => {
  if (typeof value !== 'object' || value === null) return false;
  const { source, percent, maxWorkers, signal, stage, agent } = value as UsageRule;
  return RULE_SOURCES.includes(source) && Number.isFinite(percent) && (maxWorkers === undefined || Number.isFinite(maxWorkers))
    && (signal === undefined || RULE_SIGNALS.includes(signal)) && (maxWorkers !== undefined || signal !== undefined)
    && (stage === undefined || typeof stage === 'string') // #475
    && (agent === undefined || AGENT_IDS.includes(agent)); // #929
};

// Files written before the status keys were neutral carry the Portuguese words and a lastEvent sentence.
const LEGACY_STATUS: Record<string, Status> = { vazio: 'empty', trabalhando: 'working', esperando_voce: 'waiting', aguardando_review: 'review' };
const EVENT_KINDS: readonly WorkerEventKind[] = ['starting', 'manualStart', 'prompt', 'tool', 'waiting', 'pr', 'turn', 'continuing', 'ask', 'background', 'apiError']; // an old 'setup' is dropped (#351)

// #805: a run's wait only in the shape the reducer writes, its count only as a positive whole number; anything else drops that field, never
// the worker
const backoffOf = (value: unknown): Worker['backoff'] => {
  const { error, until } = isJsonObject(value) ? value : {};
  return typeof error === 'string' && isDate(until) ? { error, until } : undefined;
};
const isFailureCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

const isWorkerEvent = (value: unknown): value is WorkerEvent =>
  typeof value === 'object' && value !== null && EVENT_KINDS.includes((value as WorkerEvent).kind)
  && ((value as WorkerEvent).detail === undefined || typeof (value as WorkerEvent).detail === 'string');

function statusOf(raw: unknown): Status | undefined {
  if (STATUSES.includes(raw as Status)) return raw as Status;
  return typeof raw === 'string' && Object.hasOwn(LEGACY_STATUS, raw) ? LEGACY_STATUS[raw] : undefined; // hasOwn: "constructor" is not a status
}

const copyMarkOf = (value: unknown): Worker['copyOf'] => {
  const { from, dir } = isJsonObject(value) ? value : {};
  return isUuid(from) && typeof dir === 'string' ? { from, dir } : undefined;
};

// Unknown status: nothing to trust beyond the id (boot gives every occupied worker with a usable run id as dead anyway). A sentence or a bad object is not a
// lastEvent. Files from before tasks existed carry task, slug, prUrl, paused on the worker: dropped, only today's fields are picked.
function normalizeWorker(worker: Worker): Worker {
  const status = statusOf(worker.status);
  // The run id is what boot hands to `pkill -f` as a regex and the only handle on the process. Occupied with one randomUUID
  // could not have written is a worker the Hive can neither kill nor free, so it is emptied like an unknown status: boot's task
  // pass then clears the workerId and the task goes back into the fill. An empty worker survives, but the field goes either way
  // (below): killStrays reads it off every worker, whatever its status. A worker's sessionId reaches --resume (#164): kept only in the shape a
  // session id has. A worker saved as `manual` before #283 is emptied: that session ran without the Hive's MCP, so nothing in it could be told
  // apart any more. A copy's mark (copyOf, #587) is kept only in its shape, so boot can remove the temporary transcript of a run it closes;
  // the server's boot then trusts it only when its dir is its own worker's (trustedCopies), so a forged file cannot point the removal anywhere.
  if (status === undefined || (worker as Worker & { manual?: unknown }).manual === true || (status !== 'empty' && !isUuid(worker.runId))) return { id: worker.id, status: 'empty' };
  const { id, runId, activityId, draining, tokens, startedAt, lastEvent, question, sessionId, freeSession, waitedMs, seenAt, waitingSince, apiErrors, stage, foldedMs, foldedWaitingMs } = worker;
  const kept = {
    runId: isUuid(runId) ? runId : undefined, activityId: typeof activityId === 'string' ? activityId : undefined, // #629
    draining, tokens, startedAt, question,
    sessionId: isSessionId(sessionId) ? sessionId : undefined,
    freeSession: freeSession === true ? freeSession : undefined, ...(isWorkerEvent(lastEvent) ? { lastEvent } : {}),
    // what boot closes a dead run with (#248): its finished waits, its last hook and a wait still open
    waitedMs: isCount(waitedMs) ? waitedMs : undefined, seenAt: isDate(seenAt) ? seenAt : undefined, waitingSince: isDate(waitingSince) ? waitingSince : undefined,
    copyOf: copyMarkOf(worker.copyOf),
    backoff: backoffOf(worker.backoff), apiErrors: isFailureCount(apiErrors) ? apiErrors : undefined, // #805
    stage: typeof stage === 'string' ? stage : undefined, foldedMs: isCount(foldedMs) ? foldedMs : undefined, // #617: boot closes the run with them
    foldedWaitingMs: isCount(foldedWaitingMs) ? foldedWaitingMs : undefined,
    agent: status !== 'empty' && isUuid(runId) ? savedAgent(worker.agent) : undefined, // #925: a worker with a run ran an agent (one saved before it ran Claude); a commands worker has no run
  };
  return { id, status, ...Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)) };
}

export { SLUG };

// #629: a run works in an activity, so an occupied worker naming none the file loaded is emptied, as migrateWorker empties one; a local
// activity's only as a free session (#590), the only run the Hive starts there
function onLoadedWork(worker: Worker, ids: ReadonlySet<string>): Worker {
  if (worker.status === 'empty') return worker;
  const { activityId } = worker;
  const owned = activityId !== undefined && ids.has(activityId) && (!isLocalActivityId(activityId) || worker.freeSession === true);
  return owned ? worker : { id: worker.id, status: 'empty' };
}

// The worker's run id reaches argv, a file path and a pkill pattern, so it is checked against what randomUUID produces: a value it could not
// have written empties the worker in normalizeWorker above. The slug and the session id are the activity's (#629): loadActivity and the
// migration check them.
const isTask = (value: unknown): value is Task => {
  if (typeof value !== 'object' || value === null) return false;
  const { item, stage, boardColumn } = value as Task;
  return typeof item === 'object' && item !== null && typeof item.itemId === 'string' && typeof stage === 'string' && typeof boardColumn === 'string';
};

// A task saved before #286 carries its Hive stage as `column`: read as `stage`, so a running Hive keeps its tasks across the rename.
function renamedStage(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('column' in value)) return value;
  const { column, ...rest } = value as Record<string, unknown>;
  return 'stage' in rest ? rest : { ...rest, stage: column };
}

// #283: a terminal only in the shape the reducer writes (its
// run id is a uuid, the pool's key); a crash only with a date and item ids. Anything else reads as absent.
// A terminal is open in an activity (#629): a task's (#283) or a workspace's local one (#292), with the directory it wakes in (#696)
const isTerminal = (value: unknown): value is Terminal =>
  isJsonObject(value) && isUuid(value.terminalId) && isDate(value.startedAt) && typeof value.activityId === 'string' && typeof value.cwd === 'string';
// A saved terminal in the shape the Hive writes: its command, so boot drops a command's run, and asleep only as true (#696). Anything else the
// file holds is dropped, the mode a file from before #378 carries too.
const loadTerminal = ({ terminalId, startedAt, activityId, cwd, command, asleep }: Terminal): Terminal => ({
  terminalId, startedAt, activityId, cwd, ...(typeof command === 'string' ? { command } : {}), ...(asleep === true ? { asleep } : {}),
});
const isCrash = (value: unknown): value is NonNullable<State['crash']> => isJsonObject(value) && isDate(value.at) && isStringArray(value.tasks);

// A null enteredAt would never be restamped (the poll only stamps an absent one) and the task would never come due. Anything but a string is
// dropped, the key with it, so the task reads as if the field had never been set. `created` is read by placeOf (#573).
// `auto` is read by autoOf (#573). A stored `viewing` goes (#283): the saved-session viewer is gone. The task's workspace (#179) too: it names a
// workspace. The worktree fields, the sessions, result, PRs and usage are the activity's and the record's (#629): MOVED_TASK_KEYS drops them.
// #573: auto replaced manual, inverted. A task saved before it carries manual (true = no auto), one saved after carries its own auto.
const autoOf = (saved: Record<string, unknown>): boolean => (typeof saved.auto === 'boolean' ? saved.auto : saved.manual !== true);

// #573: a task saved before the rename (no boolean auto) says local for today's created; one saved after says created itself. Kept only as
// true: created decides whether a source is written (#132). Where git runs (local, #444) is the activity's (#629).
function placeOf(saved: Record<string, unknown>): Pick<Task, 'created'> {
  const created = typeof saved.auto !== 'boolean' ? saved.local : saved.created;
  return created === true ? { created: true as const } : {};
}

// #191: a listed task's item is saved lean ({ itemId, id, source }): its title, body and url read as '' until boot hydrates it or a poll
// lists it. A full item of an older file loads as it is, and the next save slims it
const loadedItem = (item: Item): Item => ({ title: '', body: '', url: '', ...(item as Partial<Item>) }) as Item; // the file may hold less than Item says

// A task from before #570 carries slotId: dropped, not read as workerId (no migration).
function normalizeTask(task: Task): Task {
  const saved = task as unknown as Record<string, unknown>;
  const { enteredAt, workspace, created: _created, auto: _auto, manual: _manual, viewing: _viewing, slotId: _slotId, ...rest } = task as Task & { manual?: unknown; prUrl?: unknown; viewing?: unknown; slotId?: unknown };
  const strings = Object.fromEntries(Object.entries({ enteredAt, workspace }).filter(([, v]) => typeof v === 'string'));
  const unmoved = Object.fromEntries(Object.entries(rest).filter(([key]) => !MOVED_TASK_KEYS.includes(key))) as typeof rest; // #629: the activity's and the record's now
  return { ...unmoved, item: loadedItem(unmoved.item), ...strings, auto: autoOf(saved), ...placeOf(saved) }; // #573
}

// #629: the activities and their records, each through its guard. An activity whose record did not load goes with it (nothing could read
// its task), and a record no live activity and no task of the file still needs is pruned.
function loadWork(parsed: State, tasks: Task[]): Pick<State, 'activities' | 'activityRecords'> {
  const records = Array.isArray(parsed.activityRecords) ? parsed.activityRecords.flatMap((r) => loadRecord(r) ?? []) : [];
  const ids = new Set(records.map((r) => r.id));
  const activities = Array.isArray(parsed.activities) ? parsed.activities.flatMap((a) => {
    const loaded = loadActivity(a);
    return loaded && ids.has(loaded.id) ? [loaded] : [];
  }) : [];
  const { activityRecords } = pruneRecords({ activities, activityRecords: records, tasks });
  return { activities, activityRecords };
}

// #629: a file from before the records: its tasks' work (steps 1 to 3), then each workspace's local pair with its saved local sessions (step 4)
function migrated(parsed: State & { localSessions?: unknown }, saved: Task[], tasks: Task[], scope?: WorkspaceNames): Pick<State, 'activities' | 'activityRecords'> {
  const workspaces = isStringArray(parsed.workspaces) ? parsed.workspaces : [];
  const work = migrateWork(saved as unknown as Record<string, unknown>[], tasks, scope ?? { workspaces, sourceWorkspaces: {} });
  const locals = migrateLocals(parsed.localSessions, workspaces);
  return { activities: [...work.activities, ...locals.activities], activityRecords: [...work.activityRecords, ...locals.activityRecords] };
}

// Files written before the signal or the budget existed lack these fields; anything unknown reads as the default. A saved shutdown is
// dropped here, not only by boot: the live state is built before boot runs, and a restart must never come back armed (#233), nor awake (#226). A `terminal`
// from before #378 goes: the rest is spread. A file from before #570 has slots and shells, never read (no migration): its runs are lost, its
// tasks stay, and it gets its cap (MAX_CONCURRENT_DEFAULT when it has none) in free workers, since boot never re-runs setMax.
function normalize(parsed: State, scope?: WorkspaceNames): State {
  const { maxConcurrent: savedMax, rateLimits, terminals, cleanStop, crash, slots: _slots, shells: _shells, cleanup: _cleanup, boardQuota: _quota, lastPolledAt: _polled, boardProject: _default, queue: _queue, shutdown: _shutdown, keepAwake: _keepAwake, columns: _columns, terminal: _terminal, localSessions: _localSessions, slept: _slept, auto: _auto, ...rest } = parsed as State & { auto?: unknown; localSessions?: unknown; slept?: unknown; slots?: unknown; shells?: unknown; cleanup?: unknown; queue?: unknown; boardProject?: unknown; boardQuota?: unknown; lastPolledAt?: unknown; columns?: unknown; terminal?: unknown };
  const maxConcurrent = isCount(savedMax) ? Math.min(Math.floor(savedMax), MAX_CONCURRENT_MAX) : MAX_CONCURRENT_DEFAULT; // #727: the state is the cap's one source, so a bad value must not crash every boot
  const saved = Array.isArray(parsed.tasks) ? parsed.tasks.map(renamedStage).filter(isTask) : [];
  const tasks = saved.map(normalizeTask);
  // #629: a file from before the activity records gets them built from its tasks' own work, its workers pointed at them; any later one is read as written
  const pre629 = !Array.isArray(parsed.activities);
  const work = pre629 ? migrated(parsed, saved, tasks, scope) : loadWork(parsed, tasks);
  const loadedIds = new Set(work.activities.map((a) => a.id));
  const workers = Array.isArray(parsed.workers)
    ? parsed.workers.map((w) => onLoadedWork(normalizeWorker((pre629 ? migrateWorker(w, work) : w) as Worker), loadedIds))
    : initialState(maxConcurrent).workers;
  const readings = loadPlanReadings(rateLimits);
  // #672: a sleeping run's transcript lived in the pty host, which died with the Hive: its record is dropped with it
  return {
    ...rest,
    maxConcurrent,
    workers,
    transitions: Array.isArray(parsed.transitions) ? parsed.transitions : [], // #134: overwritten by the config on boot, as the stages are
    stages: Array.isArray(parsed.stages) ? parsed.stages : [], // overwritten by the config on boot; a saved `columns` (before #286) is dropped
    workspaces: isStringArray(parsed.workspaces) ? parsed.workspaces : [], // overwritten by the config on boot (#179)
    sourceWorkspaces: {}, // overwritten by the config on boot (#179, #180)
    commands: {}, // overwritten by the config on boot (#300)
    workspaceColors: {}, // idem (#78)
    syncs: isJsonObject(parsed.syncs) ? Object.fromEntries(Object.entries(parsed.syncs).map(([name, sync]) => [name, syncOf(sync)])) : {}, // the keys are overwritten by the config on boot (#180)
    tasks,
    ...work,
    sourceOrder: isStringArray(parsed.sourceOrder) ? parsed.sourceOrder : [], // files from before the order existed: the first poll fills it
    localCount: Number.isInteger(parsed.localCount) && parsed.localCount >= 0 ? parsed.localCount : 0, // files from before #132: nothing handed out yet
    signal: isSignal(parsed.signal) ? parsed.signal : 'green',
    usage: Array.isArray(parsed.usage) ? parsed.usage.filter(isSample) : [],
    budget: parsed.budget ?? {},
    usageRules: Array.isArray(parsed.usageRules) ? parsed.usageRules.filter(isRule) : [],
    disabledRules: Array.isArray(parsed.disabledRules) ? parsed.disabledRules.filter(isDisabledRule).map(copyDisabledRule) : [], // #297: the route's shapes; a past `at` is kept, reduce drops it
    deleteActivity: DELETE_ACTIVITY_DEFAULTS, // overwritten by the config on boot (#236, #573)
    shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, // overwritten by the config on boot (#233)
    approvalMinutes: APPROVAL_MINUTES_DEFAULT, // overwritten by the config on boot (#268)
    rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, // overwritten by the config on boot (#805)
    signals: SIGNALS_DEFAULTS, // overwritten by the config on boot (#727)
    terminals: Array.isArray(terminals) ? terminals.filter((x) => isTerminal(x) && loadedIds.has(x.activityId)).map(loadTerminal) : [], // #283, #292, #378; on a loaded activity (#629)
    benchmark: loadBenchmark(parsed.benchmark), // #458: through its own guard and boot rule; a file from before it has no experiment
    ...(cleanStop === true ? { cleanStop } : {}), ...(isCrash(crash) ? { crash: { at: crash.at, tasks: crash.tasks } } : {}), // #283
    ...(readings === undefined ? {} : { rateLimits: readings }), // #929: per agent; a wrong shape or a pre-#929 file is no key
  };
}

export async function loadState(hiveDir: string, scope?: WorkspaceNames): Promise<State> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(hiveDir, STATE_FILE), 'utf8'));
    if (isJsonObject(raw)) return normalize(raw as unknown as State, scope); // #727: the cap comes from the file, or its default
  } catch {
    // missing or corrupt: start fresh
  }
  return initialState(MAX_CONCURRENT_DEFAULT);
}

/** A task as state.json holds it (#191): a listed one's item cut to what names it. */
type SavedTask = Omit<Task, 'item'> & { item: Pick<Item, 'itemId' | 'id' | 'source'> };

// #191: the read model holds a listed task's source fields and boot hydrates them back, so the file keeps only what names the item. A
// created task's data is the Hive's own, and a missing or orphan one has no model row left, so those keep their whole item
function leanTask(task: Task): Task | SavedTask {
  if (task.created || task.missing || task.orphan) return task;
  const { itemId, id, source } = task.item;
  return { ...task, item: { itemId, id, ...(source === undefined ? {} : { source }) } };
}

export async function saveState(hiveDir: string, state: State): Promise<void> {
  const path = join(hiveDir, STATE_FILE);
  const tmp = `${path}.tmp`;
  const { slept: _slept, ...saved } = state; // #672: the sleeping runs die with the Hive, so they are never saved
  await writeFile(tmp, JSON.stringify({ ...saved, tasks: saved.tasks.map(leanTask) }, null, 2));
  await rename(tmp, path);
}
