import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, canOpenSession, sessionsOf, canDeleteActivity, differsFromSource, isBlocked, mergeTasks, moveTask, removalBlocker, type RemovalBlocker, resetOrder, type Runs, slugFor } from '../src/tasks.js';
import { canSchedule, canStart, effectiveLimits, extractPrUrl, initialState, isChildSession, isFree, reduce, type Reduced, WAITING_NOTIFICATIONS } from '../src/orchestrator.js';
import { startMode } from '../src/task-runs.js';
import { localSessionsOf } from '../src/local-sessions.js';
import { activityOf, localActivityId, prsOf, recordOf, recordsOf, resultOf, taskOfPr, taskOfWorker, usageOf, withActivity, withRecord } from '../src/activities.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Activity, ActivityRecord, ForkSyncResult } from '../src/types.js';
import { describeEvent } from '../src/log.js';
import { savedWork } from '../src/state-guards.js';
import { HOUR_MS } from '../src/usage.js';
import type { SourceItem, SourceQuota, Budget, Task, TaskBase, TaskPr, DeleteActivityScope, Stage, DisableUntil, Effect, HiveEvent, HookPayload, RateLimits, RuleSource, Terminal, Signal, Worker, State, Item, UsageRule } from '../src/types.js';
import { DELETE_ACTIVITY_DEFAULTS, SIGNALS_DEFAULTS, SPAWN_FAILED, STAGE_GONE } from '../src/types.js';
import { behaviourOf } from '../src/signals.js';
import { transitionKey } from '../src/transitions.js';
import { move, chained } from './fakes.js';
import { activityIdOf, movedWork, withLocal, withWork, type WithWork, workId } from './fixtures/work.js';

const GREEN = behaviourOf('green', SIGNALS_DEFAULTS);
// The defaults with a yellow that starts no new task: what "yellow could start nothing" read as before tree existed (#32)
const NO_NEW = { ...SIGNALS_DEFAULTS, yellow: { ...SIGNALS_DEFAULTS.yellow, newTasks: 'never' as const } };

const STAGES: LegacyStage[] = [
  { name: 'spec', from: { board: ['Backlog'] }, onFinish: { board: [move('Ready')] }, prompt: '/hive-spec {url}', session: 'new', model: 'opus' },
  { name: 'dev', from: { board: ['Ready'] }, onStart: { board: [move('In progress')] }, onFinish: { board: [move('In review')] }, prompt: '/hive-build {url}', session: 'continue' },
  { name: 'review', from: { board: ['In review'] } },
];
const item = (n: number): Item => ({ itemId: `board:item${n}`, id: String(n), title: `Task ${n}`, body: `body ${n}`, url: `https://github.com/o/r/issues/${n}`, source: 'board' });
const listed = (n: number, column = 'Backlog'): SourceItem => ({ item: item(n), column });
const many = (n: number, column = 'Backlog'): SourceItem[] => Array.from({ length: n }, (_, i) => listed(i + 1, column));
const base = (max: number, stages: LegacyStage[] = STAGES): State => ({ ...initialState(max), workspaces: ['hive'], syncs: { board: {} }, ...chained(stages) });
const ONE = { workspaces: ['hive'], sourceWorkspaces: {} };
const NO_RUNS: Runs = { workers: [], terminals: [], activities: [], activityRecords: [] };
const polled = (state: State, items: SourceItem[]) => reduce(state, { type: 'poll', source: 'board', items });
const filled = (max: number, n: number) => polled(base(max), many(n)); // n Backlog tasks into spec; up to max running
const hook = (state: State, ptyId: string, payload: Partial<HookPayload> & { hook_event_name: string }) =>
  reduce(state, { type: 'hook', ptyId, payload });
const occupied = (s: State) => s.workers.filter((x) => x.status !== 'empty');
// The task a worker runs on (#629): its activity's first task
const ownerOf = (s: State, w: Worker | undefined): string | undefined => (w === undefined ? undefined : taskOfWorker(s, w)?.item.itemId);
const ownerAt = (s: State, i: number): string | undefined => ownerOf(s, s.workers[i]);
const owners = (s: State, list: Worker[] = s.workers): (string | undefined)[] => list.map((w) => ownerOf(s, w));
const task = (s: State, n: number): Task | undefined => s.tasks.find((c) => c.item.itemId === `board:item${n}`);
const work = (s: State, n: number) => activityOf(s, `board:item${n}`);
// Whether task n's live activity carries `key` (#629): the run fields are dropped, never set to undefined
const holds = (s: State, n: number, key: keyof Activity): boolean => key in (work(s, n) ?? {});
// Any task's live activity (#629): where its run fields are
const runOf = (s: State, c: Task): Activity | undefined => activityOf(s, c.item.itemId);
// What task n's records hold (#629): its result, its PRs, its sessions, its usage
const resultN = (s: State, n: number) => resultOf(s, `board:item${n}`);
const prsN = (s: State, n: number) => prsOf(s, `board:item${n}`);
const sessionsN = (s: State, n: number) => sessionsOf(s, `board:item${n}`);
const usageN = (s: State, n: number) => usageOf(s, `board:item${n}`);
// Task n's live record with `made` set on it: the reducer's own when a run gave the task its activity, else a fixture pair
const withMade = (s: State, n: number, made: Partial<Omit<ActivityRecord, 'id' | 'taskIds'>>): State => {
  const live = work(s, n);
  return live ? withRecord(s, { ...recordOf(s, live.id)!, ...made }) : withWork(s, `board:item${n}`, {}, made);
};
const keptSession = (id: string, stages: string[] = ['spec']) => ({ id, startedAt: PAST, stages, agent: 'claude' as const, lastUsedAt: PAST });
// Task n's live activity id, what the worktree and deletion events name (#629); 'none' while it has none
const ACT = (s: State, n: number): string => work(s, n)?.id ?? 'none';
// Task n's live activity with `fields` on it (#629): the reducer's own when a run gave the task one, else a fixture pair under its slug
const withLiveFor = (s: State, it: Item, fields: Partial<Activity>): State => {
  const live = activityOf(s, it.itemId);
  return live ? withActivity(s, { ...live, ...fields }) : withWork(s, it.itemId, { slug: slugFor(it), ...fields });
};
const withLive = (s: State, n: number, fields: Partial<Activity>): State => withLiveFor(s, item(n), fields);
// Every task's live activity with `fields` on it (#629)
const everyLive = (s: State, fields: Partial<Activity>): State => s.tasks.reduce((acc, c) => withLiveFor(acc, c.item, fields), s);
// The server's gone check on task 1's activity (#208, #629)
const markGone = (s: State): State => reduce(s, { type: 'worktreeGone', activityId: ACT(s, 1) }).state;
// The first open's createActivity (#629): what a setup needs before its setupStarted
const born = (s: State, n: number): State => reduce(s, { type: 'createActivity', taskId: `board:item${n}` }).state;
// The deleteActivity effect task n's delete activity emits, its marked activity with it (#629)
const deletion = (s: State, n: number, scope: DeleteActivityScope = DELETE_ACTIVITY_DEFAULTS): Effect => ({ type: 'deleteActivity', activity: work(s, n)!, task: task(s, n)!, scope });
// #629: candidates reads the state
const cands = (s: State, stages: LegacyStage[] = s.stages): Task[] => candidates({ ...s, stages }, Date.now());
const signaled = (state: State, signal: Signal) => reduce(state, { type: 'setSignal', signal });
const done = (state: State, ptyId: string): State => reduce(state, { type: 'done', ptyId }).state;
// The worker's Stop after its hive_done: what ends a stage now
const stopped = (state: State, ptyId: string) => hook(done(state, ptyId), ptyId, { hook_event_name: 'Stop' });
const counted = (state: State, ptyId: string, tokens: number) =>
  reduce(done(state, ptyId), { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' }, tokens }).state;
const spent = (tokens: number, ageMs: number, budget: Budget): State => ({
  ...base(1), budget, usage: [{ at: new Date(Date.now() - ageMs).toISOString(), tokens }],
});
const RULES: UsageRule[] = [{ source: 'hour', percent: 50, maxWorkers: 1 }, { source: 'hour', percent: 80, signal: 'yellow' }, { source: 'hour', percent: 90, signal: 'red' }];
const ruled = (state: State, tokens: number, ageMs = 0): State => ({
  ...state, budget: { maxTokensPerHour: 1000 }, usageRules: RULES, usage: [{ at: new Date(Date.now() - ageMs).toISOString(), tokens }],
});
const started = (state: State, itemId: string) => reduce(state, { type: 'start', itemId });
const LIMITS: RateLimits = { at: '2026-09-16T12:00:00.000Z', windows: { five_hour: { usedPercent: 23, resetsAt: '2026-09-16T15:00:00.000Z' } } };
const limited = (state: State, ptyId: string, rateLimits: RateLimits = LIMITS) => reduce(state, { type: 'rateLimits', agent: 'claude', ptyId, rateLimits });
const PLAN_RULES: UsageRule[] = [{ source: 'session', percent: 80, signal: 'yellow' }, { source: 'week', percent: 50, maxWorkers: 1 }];
const FUTURE = new Date(Date.now() + HOUR_MS).toISOString();
const PAST = new Date(Date.now() - HOUR_MS).toISOString();
const LATER = new Date(Date.now() + 5 * HOUR_MS).toISOString(); // the next window: what a reading carries once the current one has reset
const windows = (session: number, week = 0, resetsAt = FUTURE): RateLimits =>
  ({ at: LIMITS.at, windows: { five_hour: { usedPercent: session, resetsAt }, seven_day: { usedPercent: week, resetsAt } } });
const planned = (state: State, rateLimits: RateLimits): State => ({ ...state, usageRules: PLAN_RULES, rateLimits: { claude: rateLimits } });
const WORKTREE = '/tmp/worktrees/hive-1-task-1';
// A task that ran once and stopped: session id from the spawn, worktree and branch from its SessionStart, worker freed by an exit under red
// (in flight since its spawn, under yellow it would resume at once, #224)
function ranOnce(n = 1): State {
  const first = filled(1, n).state;
  const id = first.workers[0].runId!;
  const seen = reduce(first, { type: 'hook', ptyId: id, payload: { hook_event_name: 'SessionStart', cwd: WORKTREE }, branch: 'hive-1-task-1' }).state;
  return reduce(signaled(seen, 'red').state, { type: 'exit', ptyId: id }).state;
}
// A task a clean restart left started (#224, #283, #727): its worker freed, its activity kept and not stopped, which is what a boot after a quit
// leaves. Built from an exit, which stops the task, so the worker and the run's time are freed as a real exit frees them.
function parkedStarted(state: State, ptyId: string): State {
  const itemId = ownerOf(state, state.workers.find((s) => s.runId === ptyId));
  const exited = reduce(state, { type: 'exit', ptyId }).state;
  const own = itemId === undefined ? undefined : activityOf(exited, itemId)?.id; // #629: the stop marks are the activity's
  const activities = exited.activities.map((a) => {
    if (a.id !== own) return a;
    const { stopped: _stopped, stoppedAt: _stoppedAt, ...kept } = a;
    return kept;
  });
  return { ...exited, activities };
}
const QUOTA: SourceQuota = { limit: 5000, remaining: 4320, resetsAt: '2026-09-16T13:00:00.000Z', at: '2026-09-16T12:00:00.000Z' };
const DAY_MS = 86_400_000;
const DELETE_STAGES: LegacyStage[] = [
  STAGES[1], // dev
  { name: 'done', from: { board: ['Done'] }, onFinish: { board: [move('Archived')] }, action: 'deleteActivity', after: '5d' },
  { name: 'archive', from: { board: ['Archived'] } },
];
const aged = (state: State, itemId: string, ageMs: number): State =>
  ({ ...state, tasks: state.tasks.map((c) => (c.item.itemId === itemId ? { ...c, enteredAt: new Date(Date.now() - ageMs).toISOString() } : c)) });
// Something for a delete activity to remove (#236): a task with nothing the scope covers just moves on, so the deleteActivity-effect tests give theirs a worktree
const withWorktree = (state: State, n = 1): State => withLive(state, n, { worktree: WORKTREE }); // #629: on the task's activity
// A task already sitting in `stages`' done stage with its worktree: what a delete activity stage with no `after` finds on the next poll (#236)
const parkedIn = (stages: LegacyStage[]): State =>
  withLive({ ...base(1, stages), tasks: [{ item: item(1), stage: 'done', boardColumn: 'Done', auto: true }] }, 1, { worktree: WORKTREE });

test('poll enters unknown tasks through the first stage whose from contains their source column, keeps source order and ignores the rest', () => {
  const { state, effects } = polled(signaled(base(2), 'yellow').state, [listed(1, 'Ready'), listed(2, 'Backlog'), listed(3, 'Done'), listed(4, 'In review'), listed(5, 'In progress')]);
  assert.deepEqual(state.tasks.map((c) => [c.item.id, c.stage, c.boardColumn]), [['1', 'dev', 'Ready'], ['2', 'spec', 'Backlog'], ['4', 'review', 'In review']]);
  assert.deepEqual(['slug' in task(state, 1)!, work(state, 1)], [false, undefined], 'the slug is the activity\'s, born with the first run (#629)');
  assert.equal(task(state, 5), undefined, 'a column that appears only in onStart / onFinish is not a door');
  assert.deepEqual(state.sourceOrder, ['board:item1', 'board:item2', 'board:item3', 'board:item4', 'board:item5'], 'every listed id, in board order, whether or not it entered the Hive');
  assert.equal(effects.length, 0);
  assert.ok(state.syncs.board.polledAt);
});

test('poll fills free workers by stage position, a later stage first, ties by source order, and marks the task with its worker (#316)', () => {
  const { state, effects } = polled(base(2), [listed(1, 'Backlog'), listed(2, 'Backlog'), listed(3, 'Ready')]);
  assert.deepEqual(occupied(state).map((s) => taskOfWorker(state, s)?.item.id), ['3', '1'], 'dev comes after spec: 3 first though listed last; then spec by board order, 1 before 2');
  assert.deepEqual(state.tasks.filter((c) => runOf(state, c)?.workerId).map((c) => c.item.id).sort(), ['1', '3']);
  assert.equal(work(state, 3)?.workerId, state.workers[0].id);
  assert.equal(ownerAt(state, 0), 'board:item3');
  assert.equal(state.workers[0].status, 'working');
  assert.deepEqual(state.workers[0].lastEvent, { kind: 'starting' });
  assert.ok(state.workers[0].startedAt && state.workers[0].runId);
  assert.deepEqual(effects.map((e) => e.type), ['setColumn', 'spawn', 'spawn'], 'dev writes its onStart; spec has none');
  const spawn = effects[2];
  assert.ok(spawn.type === 'spawn' && spawn.task.item.id === '1' && spawn.stage.name === 'spec' && spawn.session === 'new');
});

test('occupy writes onStart only when it differs from boardColumn, generates a session id for new and keeps it for continue', () => {
  const dev = polled(base(1), [listed(1, 'Ready')]);
  assert.deepEqual(dev.effects.map((e) => e.type), ['setColumn', 'spawn']);
  assert.deepEqual(dev.effects[0], { type: 'setColumn', itemId: 'board:item1', column: 'In progress' });
  assert.equal(task(dev.state, 1)?.boardColumn, 'In progress', 'the Hive remembers what it wrote');
  const fresh = work(dev.state, 1)?.sessionId;
  assert.ok(fresh && /^[0-9a-f-]{36}$/.test(fresh), 'continue without an id runs as new');
  assert.equal(dev.effects[1].type === 'spawn' && dev.effects[1].session, 'new');
  const known: State = withLive({ ...base(1), tasks: [{ item: item(1), stage: 'dev', boardColumn: 'In progress', auto: true }] }, 1, { sessionId: 'kept-session-id-0001' }); // #629: the activity's
  const again = reduce(known, { type: 'setSignal', signal: 'green' });
  assert.deepEqual(again.effects.map((e) => e.type), ['spawn'], 'already In progress: nothing to write');
  assert.equal(work(again.state, 1)?.sessionId, 'kept-session-id-0001');
  assert.equal(again.effects[0].type === 'spawn' && again.effects[0].session, 'continue');
});

test('candidates skips running, missing, blocked tasks and stages without a prompt, a later stage first (#316)', () => {
  const tasks: WithWork[] = [
    { item: item(1), stage: 'review', boardColumn: 'In review', auto: true },
    { item: item(2), stage: 'dev', boardColumn: 'Ready', auto: true },
    { item: { ...item(3), blockedBy: ['9'] }, stage: 'spec', boardColumn: 'Backlog', auto: true },
    { item: item(4), stage: 'spec', boardColumn: 'Backlog', auto: true, missing: true },
    { item: item(5), stage: 'spec', boardColumn: 'Backlog', auto: true, workerId: 's1' },
    { item: item(6), stage: 'dev', boardColumn: 'Ready', auto: true },
    { item: item(7), stage: 'spec', boardColumn: 'Backlog', auto: true },
  ];
  assert.deepEqual(candidates(movedWork({ tasks, stages: STAGES, ...NO_RUNS, ...ONE }), Date.now()).map((c) => c.item.id), ['2', '6', '7']); // #629: 5's run on its activity
});

test('Stop kills the session, writes onFinish when it differs, moves the task to the next stage and frees the worker; fill then runs the next stage', () => {
  const first = signaled(filled(1, 1).state, 'red').state; // red: no continuation in place, the task waits for a worker
  const id = first.workers[0].runId!;
  const { state, effects } = stopped(first, id);
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: id }, { type: 'setColumn', itemId: 'board:item1', column: 'Ready' }, { type: 'forgetScrollback', ptyId: id }]);
  assert.deepEqual([task(state, 1)?.stage, task(state, 1)?.boardColumn, work(state, 1)?.workerId], ['dev', 'Ready', undefined]);
  assert.equal(work(state, 1)?.sessionId, work(first, 1)?.sessionId, 'the session id travels with the task');
  assert.deepEqual(state.workers[0], { id: first.workers[0].id, status: 'empty' });
  const green = signaled(state, 'green');
  assert.deepEqual(green.effects.map((e) => e.type), ['setColumn', 'spawn']);
  assert.equal(green.effects[1].type === 'spawn' && green.effects[1].session, 'continue');
  assert.deepEqual(reduce(green.state, { type: 'exit', ptyId: id }).effects, [], 'the exit of the killed session finds no worker: no-op');
});

test('a stage finishing with close emits sourceAction and advances like a finish with no write: boardColumn unchanged, the task in the next stage; a close failure only marks the task (#286)', () => {
  const stages: LegacyStage[] = [{ ...STAGES[0], onFinish: { board: [{ type: 'close' }] } }, STAGES[1], STAGES[2]];
  const first = signaled(polled(base(1, stages), many(1)).state, 'red').state; // red: no continuation in place
  const id = first.workers[0].runId!;
  const { state, effects } = stopped(first, id);
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: id }, { type: 'sourceAction', itemId: 'board:item1', taskId: 'board:item1', action: { type: 'close' } }, { type: 'forgetScrollback', ptyId: id }]);
  assert.deepEqual([task(state, 1)?.stage, task(state, 1)?.boardColumn, task(state, 1)?.leaving], ['dev', 'Backlog', undefined], 'a closed issue stays on the source, in its stage');
  const failed = reduce(state, { type: 'sourceActionFailed', taskId: 'board:item1', message: 'Could not resolve to an Issue', leaving: false }).state;
  assert.deepEqual([task(failed, 1)?.stage, work(failed, 1)?.error], ['dev', 'Could not resolve to an Issue']);
});

test('a stage finishing with archive holds the task in its stage, leaving: sourceAction emitted, the worker closed instead of continued, out of the fill and of the missing mark; start refuses it, closeTask removes it (#286)', () => {
  const stages: LegacyStage[] = [{ ...STAGES[0], onFinish: { board: [{ type: 'archive' }] } }, STAGES[1], STAGES[2]];
  const first = polled(base(1, stages), many(1)).state; // green, one worker, dev continues: a move here would continue in place
  const id = first.workers[0].runId!;
  const { state, effects } = stopped(first, id);
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: id }, { type: 'sourceAction', itemId: 'board:item1', taskId: 'board:item1', action: { type: 'archive' } }, { type: 'forgetScrollback', ptyId: id }]);
  const held = task(state, 1)!;
  assert.deepEqual([held.stage, held.leaving, work(state, 1)?.workerId, held.boardColumn], ['spec', true, undefined, 'Backlog']);
  assert.equal(state.workers[0].status, 'empty', 'the worker closes as at the end of the pipeline');
  assert.deepEqual(reduce(state, { type: 'setSignal', signal: 'green' }).effects, [], 'fill skips a leaving task');
  assert.equal(task(polled(state, []).state, 1)?.missing, undefined, 'gone from the listing: not marked missing, the write answers');
  assert.equal(started(state, 'board:item1').state, state, 'start refuses it');
  assert.equal(startMode(held, state), 'none', 'the task offers no run while it leaves');
  assert.deepEqual(reduce(state, { type: 'closeTask', taskId: 'board:item1' }).state.tasks, [], 'closeTask takes it out');
});

test('sourceActionFailed drops leaving and sets the error, with no fill: a manual start runs the stage again; boot turns a leaving task into an error (#286)', () => {
  const stages: LegacyStage[] = [{ ...STAGES[0], onFinish: { board: [{ type: 'delete' }] } }, STAGES[1], STAGES[2]];
  const first = signaled(polled(base(1, stages), many(1)).state, 'red').state;
  const leaving = stopped(first, first.workers[0].runId!).state;
  const failed = reduce(signaled(leaving, 'green').state, { type: 'sourceActionFailed', taskId: 'board:item1', message: 'must have admin rights to Repository.', leaving: true });
  assert.deepEqual([task(failed.state, 1)?.leaving, work(failed.state, 1)?.error, task(failed.state, 1)?.stage], [undefined, 'must have admin rights to Repository.', 'spec']);
  assert.deepEqual(failed.effects, [], 'the error keeps it out of the fill');
  assert.deepEqual(started(failed.state, 'board:item1').effects.map((e) => e.type), ['spawn'], 'a manual start clears the error and runs the stage');
  const booted = reduce(leaving, { type: 'boot' }).state;
  assert.deepEqual([task(booted, 1)?.leaving, work(booted, 1)?.error], [undefined, 'a ação na source não terminou']);
});

test('Stop on the last stage drops the task; a stage without a prompt parks it; onFinish equal to boardColumn is not written', () => {
  const stages: LegacyStage[] = [{ name: 'only', from: { board: ['Ready'] }, onFinish: { board: [move('Ready')] }, prompt: 'x' }];
  const first = polled(base(1, stages), [listed(1, 'Ready')]).state;
  const { state, effects } = stopped(first, first.workers[0].runId!);
  assert.deepEqual(effects.map((e) => e.type), ['kill', 'forgetScrollback'], 'onFinish is where the board already shows it');
  assert.deepEqual(state.tasks, []);
  const parked = polled(signaled(base(1), 'yellow').state, [listed(1, 'In review')]);
  assert.equal(task(parked.state, 1)?.stage, 'review');
  assert.equal(signaled(parked.state, 'green').effects.length, 0, 'no prompt: the task just sits');
});

test('an exit without Stop frees the worker, keeps the task in its stage with its session id and writes nothing; stopped, the fill leaves it until a start (#283)', () => {
  const first = filled(1, 2).state;
  const id = first.workers[0].runId!;
  const { state, effects } = reduce(signaled(first, 'red').state, { type: 'exit', ptyId: id });
  assert.equal(state.workers[0].status, 'empty');
  assert.deepEqual([task(state, 1)?.stage, work(state, 1)?.workerId, work(state, 1)?.stopped], ['spec', undefined, true]);
  assert.equal(work(state, 1)?.sessionId, work(first, 1)?.sessionId);
  assert.deepEqual(effects, [{ type: 'forgetScrollback', ptyId: id }]);
  const again = signaled(state, 'green');
  assert.equal(taskOfWorker(again.state, again.state.workers[0])?.item.id, '2', 'the stopped task waits for a start');
  const restarted = started(again.state, 'board:item1');
  assert.notEqual(work(restarted.state, 1)?.sessionId, work(first, 1)?.sessionId, 'spec is new: a fresh session each run');
  const draining = reduce(filled(2, 2).state, { type: 'setMax', max: 1 }).state;
  const gone = reduce(draining, { type: 'exit', ptyId: draining.workers[1].runId! }).state;
  assert.equal(gone.workers.length, 1, 'a draining worker is removed');
  assert.equal(work(gone, 2)?.workerId, undefined);
});

test('poll rules on a known task: same board column nothing; moved by hand into a from while stopped → the stage follows; while running only boardColumn', () => {
  const two = signaled(polled(base(1), [listed(1, 'Backlog'), listed(2, 'Backlog')]).state, 'red').state; // 1 running in spec, 2 stopped in spec
  const moved = polled(two, [listed(1, 'In review'), listed(2, 'In review')]).state;
  assert.deepEqual([task(moved, 1)?.stage, task(moved, 1)?.boardColumn], ['spec', 'In review'], 'running: the Hive stage waits for the Stop');
  assert.deepEqual([task(moved, 2)?.stage, task(moved, 2)?.boardColumn], ['review', 'In review']);
  const outside = polled(moved, [listed(1, 'In review'), listed(2, 'In progress')]).state;
  assert.deepEqual([task(outside, 2)?.stage, task(outside, 2)?.boardColumn], ['review', 'In progress'], 'not a from: only boardColumn');
  assert.deepEqual(polled(outside, [listed(1, 'In review'), listed(2, 'In progress')]).state.tasks, outside.tasks, 'same again: same content');
  const done = stopped(outside, outside.workers[0].runId!);
  assert.deepEqual(done.effects[1], { type: 'setColumn', itemId: 'board:item1', column: 'Ready' }, 'onFinish overwrites the human move');
});

test('poll updates the task fields, keeps the running and unlisted tasks in place, moves the untouched ones to their source position and records the source order (#123)', () => {
  const first = signaled(polled(base(1), [listed(1), listed(2), listed(3)]).state, 'yellow').state;
  assert.deepEqual(first.sourceOrder, ['board:item1', 'board:item2', 'board:item3']);
  const { state } = polled(first, [{ item: { ...item(3), title: 'Renamed', blockedBy: ['1'] }, column: 'Backlog' }, listed(1)]);
  assert.deepEqual(state.tasks.map((c) => c.item.id), ['1', '2', '3'], '1 runs, 2 is unlisted, 3 is the only task left to place: nothing moves');
  assert.deepEqual(state.sourceOrder, ['board:item3', 'board:item1'], 'what a reset would sort by');
  assert.equal(task(state, 3)?.item.title, 'Renamed');
  assert.deepEqual(task(state, 3)?.item.blockedBy, ['1']);
  assert.equal(task(state, 2)?.missing, true, 'not listed: missing, kept at its index');
  assert.equal(task(state, 1)?.missing, undefined);
  const grown = polled(state, [listed(4), listed(3), listed(2), listed(1)]).state;
  assert.deepEqual(grown.tasks.map((c) => c.item.id), ['1', '4', '3', '2'], 'the running task holds position 0; the rest, the task new to the Hive included, take the board order');
  assert.equal(task(grown, 2)?.missing, undefined, 'listed again: the mark drops and the task follows the board like any other');
});

test('a task the source stops listing is missing (out of contention, keeps running); listed again it loses the mark', () => {
  const first = signaled(polled(base(1), [listed(1), listed(2)]).state, 'yellow').state; // 1 running, 2 stopped
  const gone = polled(first, []).state;
  assert.deepEqual(gone.tasks.map((c) => [c.item.id, c.missing, runOf(gone, c)?.workerId !== undefined]), [['1', true, true], ['2', true, false]]);
  assert.equal(signaled(gone, 'green').effects.length, 0, 'missing: never started');
  const back = polled(gone, [listed(2)]).state;
  assert.equal(task(back, 2)?.missing, undefined);
  const finished = stopped(back, back.workers[0].runId!);
  assert.deepEqual(finished.effects.map((e) => e.type), ['kill', 'forgetScrollback'], 'a missing task finishes without a board write');
  assert.equal(task(finished.state, 1)?.stage, 'dev');
});

test('closeTask removes a missing task, killing its session when it runs; keepTask turns it into an orphan that runs to the end without source writes and is ignored by the poll', () => {
  const first = signaled(polled(base(2), [listed(1), listed(2)]).state, 'red').state; // both running; red: the Stop frees the worker
  const gone = polled(first, []).state;
  const closed = reduce(gone, { type: 'closeTask', taskId: 'board:item1' });
  assert.deepEqual(closed.effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: first.workers[0].runId }, { type: 'forgetScrollback', ptyId: first.workers[0].runId }]);
  assert.deepEqual(closed.state.tasks.map((c) => c.item.id), ['2']);
  assert.equal(closed.state.workers[0].status, 'empty');
  const kept = reduce(closed.state, { type: 'keepTask', taskId: 'board:item2' });
  assert.equal(kept.effects.length, 0);
  assert.deepEqual([task(kept.state, 2)?.orphan, task(kept.state, 2)?.missing], [true, undefined]);
  const finished = stopped(kept.state, kept.state.workers[1].runId!);
  assert.deepEqual(finished.effects.map((e) => e.type), ['kill', 'forgetScrollback']);
  assert.equal(task(finished.state, 2)?.stage, 'dev');
  const green = signaled(finished.state, 'green');
  assert.deepEqual(green.effects.map((e) => e.type), ['spawn'], 'orphan in dev: no onStart write');
  assert.equal(polled(green.state, [listed(2, 'In review')]).state.tasks.find((c) => c.item.id === '2')?.stage, 'dev', 'the poll ignores an orphan');
  assert.equal(reduce(closed.state, { type: 'closeTask', taskId: 'nope' }).state, closed.state, 'unknown: same object');
  assert.equal(reduce(first, { type: 'closeTask', taskId: 'board:item1' }).state, first, 'not missing: refused');
  assert.equal(reduce(first, { type: 'keepTask', taskId: 'board:item1' }).state, first);
  const deleting: State = withLive(gone, 1, { deleting: true }); // git is removing its worktree (#182), the mark on the activity (#629)
  assert.equal(reduce(deleting, { type: 'closeTask', taskId: 'board:item1' }).state, deleting, 'deleting: refused until git answers');
  assert.equal(reduce(deleting, { type: 'keepTask', taskId: 'board:item1' }).state, deleting);
});

test('reducer never mutates its input', () => {
  const before = base(2);
  const snapshot = JSON.stringify(before);
  reduce(before, { type: 'poll', source: 'board', items: many(3) });
  reduce(before, { type: 'setSignal', signal: 'red' });
  reduce(before, { type: 'setUsageRules', usageRules: RULES });
  assert.equal(JSON.stringify(before), snapshot);
  const first = filled(1, 2).state;
  const firstSnapshot = JSON.stringify(first);
  const id = first.workers[0].runId!;
  reduce(first, { type: 'hook', ptyId: id, payload: { hook_event_name: 'Stop' }, tokens: 900 });
  reduce(first, { type: 'poll', source: 'board', items: [] });
  reduce(first, { type: 'start', itemId: 'board:item2' }); // no free worker: the start appends a worker over the cap
  reduce(first, { type: 'setStages', ...chained([]) });
  reduce(first, { type: 'done', ptyId: id });
  reduce(first, { type: 'done', ptyId: id, result: { spec: 'docs/x.md' } });
  reduce(first, { type: 'pr', ptyId: id, url: 'https://github.com/o/r/pull/1' });
  reduce(first, { type: 'ask', ptyId: id, question: 'Which base?' });
  reduce(first, { type: 'spawnFailed', ptyId: id, message: 'pty: boom' });
  reduce(first, { type: 'activityDeleted', activityId: ACT(first, 1) });
  reduce(first, { type: 'deleteActivityFailed', activityId: ACT(first, 2), message: 'error: boom' });
  reduce(first, { type: 'moveTask', taskId: 'board:item2', before: 'board:item1' });
  reduce(first, { type: 'resetOrder', stage: 'spec' });
  reduce(first, { type: 'quit' }); reduce(first, { type: 'boot' }); reduce(first, { type: 'dismissCrash' }); reduce(first, { type: 'stop', ptyId: id });
  assert.equal(JSON.stringify(first), firstSnapshot);
  const seen = ranOnce(1);
  const seenSnapshot = JSON.stringify(seen);
  reduce(seen, { type: 'worktreeGone', activityId: ACT(seen, 1) });
  reduce(seen, { type: 'openSession', activityId: workId(seen, 'board:item1') });
  const marked = reduce(seen, { type: 'deletingActivity', activityId: workId(seen, 'board:item1') }).state;
  const markedSnapshot = JSON.stringify(marked);
  reduce(marked, { type: 'activityRemoved', activityId: workId(marked, 'board:item1') });
  reduce(marked, { type: 'activityKept', activityId: workId(marked, 'board:item1') });
  assert.equal(JSON.stringify(marked), markedSnapshot);
  assert.equal(JSON.stringify(seen), seenSnapshot);
  const gone = polled(first, []).state;
  const goneSnapshot = JSON.stringify(gone);
  reduce(gone, { type: 'closeTask', taskId: 'board:item1' });
  reduce(gone, { type: 'stop', ptyId: gone.workers[0].runId! });
  reduce(gone, { type: 'keepTask', taskId: 'board:item2' });
  assert.equal(JSON.stringify(gone), goneSnapshot);
});

test('setStages moves the tasks of a deleted stage instead of dropping them: a stopped one enters its destination, a running one is placed with stageGone and halts at its Stop (#861)', () => {
  const first = signaled(polled(base(1), [listed(1), listed(2)]).state, 'yellow').state; // 1 runs spec, 2 waits there
  const triage: LegacyStage[] = [{ name: 'triage', from: { board: ['Backlog'] }, prompt: 'x' }];
  const { state, effects } = reduce(first, { type: 'setStages', ...chained(triage) });
  assert.deepEqual(state.stages, triage);
  assert.deepEqual(state.tasks.map((c) => [c.item.id, c.stage]), [['1', 'triage'], ['2', 'triage']], 'the stage that pulls their column');
  assert.equal(work(state, 1)?.stageGone, 'spec');
  assert.equal(effects.length, 0);
  const done = stopped(state, state.workers[0].runId!);
  assert.equal(done.effects.some((e) => e.type === 'setColumn' || e.type === 'sourceAction'), false, 'no transition, no source action');
  assert.deepEqual([task(done.state, 1)?.stage, work(done.state, 1)?.error, holds(done.state, 1, 'stageGone')], ['triage', `${STAGE_GONE}spec`, false]);
  const again = started(done.state, 'board:item1');
  assert.deepEqual(again.effects.flatMap((e) => (e.type === 'spawn' ? [e.stage.name] : [])), ['triage'], 'a start runs it in its new stage');
});

test('setMax up adds empty workers and fills them; down marks extra occupied workers draining and drops surplus empty ones', () => {
  const { state, effects } = reduce(filled(1, 3).state, { type: 'setMax', max: 2 });
  assert.equal(state.maxConcurrent, 2);
  assert.equal(occupied(state).length, 2);
  assert.equal(effects.filter((e) => e.type === 'spawn').length, 1);
  const down = reduce(filled(3, 3).state, { type: 'setMax', max: 1 });
  assert.equal(down.effects.length, 0);
  assert.deepEqual(down.state.workers.map((s) => s.draining), [undefined, true, true]);
  assert.equal(reduce(base(3), { type: 'setMax', max: 1 }).state.workers.length, 1);
});

test('SessionStart records worktree and branch on the task and the session id on the worker; the first session id wins; malformed values are dropped', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const uuid = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const { state } = reduce(first, {
    type: 'hook', ptyId: id, branch: 'hive-1-task-1',
    payload: { hook_event_name: 'SessionStart', cwd: '/repo/.claude/worktrees/hive-1-task-1', transcript_path: '/Users/x/.claude/projects/p/abc.jsonl', session_id: uuid },
  });
  assert.equal(work(state, 1)?.worktree, '/repo/.claude/worktrees/hive-1-task-1');
  assert.equal(work(state, 1)?.branch, 'hive-1-task-1');
  assert.equal(state.workers[0].sessionId, uuid);
  assert.equal('transcriptPath' in state.workers[0], false, 'the Worker tab is gone: nothing reads it (#283)');
  const teammate = hook(state, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id: 'another-session-id-0001' }).state;
  assert.equal(teammate.workers[0].sessionId, uuid, 'a teammate SessionStart does not replace the main session (#24)');
  for (const bad of ['', 'short', 'has space-in-it', 'x'.repeat(65), '../../etc/passwd']) {
    assert.equal(hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id: bad }).state.workers[0].sessionId, undefined, JSON.stringify(bad));
  }
});

test('isChildSession: no worker id, no payload id, a malformed payload id and a matching id are all false; a different well-formed id is true (#24)', () => {
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const childId = 'another-child-session-0001';
  const worker: Worker = { id: 's1', status: 'working', sessionId: mainId };
  assert.equal(isChildSession(undefined, { hook_event_name: 'Stop', session_id: childId }), false);
  assert.equal(isChildSession({ id: 's1', status: 'working' }, { hook_event_name: 'Stop', session_id: childId }), false);
  assert.equal(isChildSession(worker, { hook_event_name: 'Stop' }), false);
  assert.equal(isChildSession(worker, { hook_event_name: 'Stop', session_id: 'short' }), false);
  assert.equal(isChildSession(worker, { hook_event_name: 'Stop', session_id: mainId }), false);
  assert.equal(isChildSession(worker, { hook_event_name: 'Stop', session_id: childId }), true);
});

test('Stop or SessionEnd from a child session changes nothing: no finish, no exit, no token sample (#24)', () => {
  const first = filled(1, 2).state;
  const id = first.workers[0].runId!;
  const mainId = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const started = hook(first, id, { hook_event_name: 'SessionStart', cwd: '/w', session_id: mainId }).state;
  const child = reduce(started, { type: 'hook', ptyId: id, payload: { hook_event_name: 'Stop', session_id: 'another-child-session-0001' }, tokens: 999 });
  assert.equal(child.state, started, 'same object');
  assert.equal(child.effects.length, 0);
  const end = hook(started, id, { hook_event_name: 'SessionEnd', session_id: 'another-child-session-0001' });
  assert.equal(end.state, started);
  assert.deepEqual(stopped(started, id).effects.map((e) => e.type), ['captureCheckpoint', 'setColumn', 'setColumn', 'continue'], 'the main session still finishes its stage and goes on into dev in place: dev outranks task 2 in spec (#316)');
  assert.deepEqual(hook(done(started, id), id, { hook_event_name: 'Stop', session_id: mainId }).effects.map((e) => e.type), ['captureCheckpoint', 'setColumn', 'setColumn', 'continue']);
});

// A /clear (#655): Claude Code's SessionEnd reason=clear with the old id, then a SessionStart source=clear with a new one, in the same process
const CLEARED = 'c1ea4ed0-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
// A stage run past its first SessionStart: the worker holds the session id the spawn chose, as Claude Code reports it back
function sessionStarted(): { state: State; id: string; first: string } {
  const spawned = filled(1, 1).state;
  const id = spawned.workers[0].runId!;
  const first = work(spawned, 1)!.sessionId!; // #629: the activity's
  return { state: hook(spawned, id, { hook_event_name: 'SessionStart', cwd: WORKTREE, session_id: first, source: 'startup' }).state, id, first };
}
const clearedFrom = (state: State, id: string, first: string): State => {
  const ended = hook(state, id, { hook_event_name: 'SessionEnd', session_id: first, reason: 'clear' }).state;
  return hook(ended, id, { hook_event_name: 'SessionStart', cwd: WORKTREE, session_id: CLEARED, source: 'clear' }).state;
};

test('a SessionEnd with reason clear leaves the worker live on its task and counts its tokens; any other reason, or none, still frees it (#655)', () => {
  const { state, id, first } = sessionStarted();
  const ended = reduce(state, { type: 'hook', ptyId: id, payload: { hook_event_name: 'SessionEnd', session_id: first, reason: 'clear' }, tokens: 900 });
  const worker = ended.state.workers[0];
  assert.deepEqual([worker.runId, worker.status, worker.sessionId, worker.tokens], [id, 'working', first, 900]);
  assert.equal(work(ended.state, 1)?.workerId, worker.id, 'the task keeps its worker');
  assert.deepEqual([ended.state.usage.map((s) => s.tokens), usageN(ended.state, 1)?.tokens], [[900], 900], 'the old transcript\'s last turn is counted');
  assert.deepEqual(ended.effects, []);
  for (const reason of ['logout', 'prompt_input_exit', 'other', undefined]) {
    const freed = hook(state, id, { hook_event_name: 'SessionEnd', session_id: first, ...(reason === undefined ? {} : { reason }) }).state;
    assert.equal(freed.workers[0].status, 'empty', String(reason));
  }
});

test('a SessionStart with source clear and a new id replaces the worker\'s and the task\'s session, and the next Stop is the worker\'s own turn end, not a child\'s (#655)', () => {
  const { state, id, first } = sessionStarted();
  const cleared = clearedFrom(state, id, first);
  assert.equal(cleared.workers[0].sessionId, CLEARED);
  assert.equal(work(cleared, 1)?.sessionId, CLEARED);
  assert.deepEqual(sessionsN(cleared, 1).map((s) => s.id), [CLEARED], 'the conversation before the /clear is gone');
  assert.equal(work(cleared, 1)?.worktree, WORKTREE, 'the worktree write still happens');
  const turned = hook(cleared, id, { hook_event_name: 'Stop', session_id: CLEARED }).state;
  assert.deepEqual([turned.workers[0].status, turned.workers[0].lastEvent], ['waiting', { kind: 'turn' }]);
});

test('a stage run that called hive_done before a /clear finishes its stage on the cleared session\'s next Stop, and goes on in that session (#655)', () => {
  const { state, id, first } = sessionStarted();
  const cleared = clearedFrom(done(state, id), id, first);
  assert.equal(cleared.workers[0].done, true, 'the /clear neither finishes nor stops the stage');
  const finished = hook(cleared, id, { hook_event_name: 'Stop', session_id: CLEARED });
  assert.deepEqual(finished.effects.map((e) => e.type), ['captureCheckpoint', 'setColumn', 'setColumn', 'continue']);
  assert.equal(task(finished.state, 1)?.stage, 'dev');
  assert.deepEqual(sessionsN(finished.state, 1).map((s) => [s.id, s.stages]), [[CLEARED, ['spec', 'dev']]]);
});

test('a SessionStart with another source, or none, and another id keeps the first session id (#24, #655)', () => {
  const { state, id, first } = sessionStarted();
  for (const source of ['startup', 'compact', 'resume', undefined]) {
    const next = hook(state, id, { hook_event_name: 'SessionStart', cwd: WORKTREE, session_id: CLEARED, ...(source === undefined ? {} : { source }) }).state;
    assert.deepEqual([next.workers[0].sessionId, work(next, 1)?.sessionId, sessionsN(next, 1).map((s) => s.id)], [first, first, [first]], String(source));
  }
});

test('a SessionStart with source clear and a malformed, missing or unchanged id changes no session (#655)', () => {
  const { state, id, first } = sessionStarted();
  const counted = reduce(state, { type: 'hook', ptyId: id, payload: { hook_event_name: 'Stop', session_id: first }, tokens: 700 }).state;
  for (const bad of ['', 'short', 'has space-in-it', '../../etc/passwd', '--dangerously-skip-permissions', first, undefined]) {
    const next = hook(counted, id, { hook_event_name: 'SessionStart', cwd: WORKTREE, source: 'clear', ...(bad === undefined ? {} : { session_id: bad }) }).state;
    assert.deepEqual([next.workers[0].sessionId, next.workers[0].tokens, sessionsN(next, 1)], [first, 700, sessionsN(counted, 1)], JSON.stringify(bad));
  }
});

test('Notification of a waiting type turns the worker yellow with the message; other types are ignored; a prompt or a tool brings it back', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const yellow = hook(first, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' }).state;
  assert.equal(yellow.workers[0].status, 'waiting');
  assert.equal(yellow.workers[0].question, 'Allow Bash?');
  assert.deepEqual(yellow.workers[0].lastEvent, { kind: 'waiting', detail: 'permission_prompt' });
  assert.equal(hook(first, id, { hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok' }).state.workers[0].status, 'working');
  const green = hook(yellow, id, { hook_event_name: 'UserPromptSubmit' }).state;
  assert.equal(green.workers[0].status, 'working');
  assert.equal(green.workers[0].question, undefined);
  assert.deepEqual(green.workers[0].lastEvent, { kind: 'prompt' });
  const tool = hook(yellow, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } }).state;
  assert.equal(tool.workers[0].status, 'working');
  assert.deepEqual(tool.workers[0].lastEvent, { kind: 'tool', detail: 'Bash: pnpm test' });
});

test('done with a result merges it into the task: a second done overrides one key and keeps the others; the result rides the continuation and survives a kill (#99)', () => {
  const first = filled(1, 1).state; // task 1 running in spec; dev continues the session
  const id = first.workers[0].runId!;
  const once = reduce(first, { type: 'done', ptyId: id, result: { spec: 'docs/a.md', n: 1 } }).state;
  assert.deepEqual(resultN(once, 1), { spec: 'docs/a.md', n: 1 });
  assert.equal(once.workers[0].done, true);
  const twice = reduce(once, { type: 'done', ptyId: id, result: { n: 2 } }).state;
  assert.deepEqual(resultN(twice, 1), { spec: 'docs/a.md', n: 2 });
  assert.deepEqual(resultN(reduce(twice, { type: 'done', ptyId: id }).state, 1), { spec: 'docs/a.md', n: 2 }, 'a done without result keeps it');
  const { state, effects } = hook(twice, id, { hook_event_name: 'Stop' });
  const continued = effects.find((e) => e.type === 'continue');
  assert.deepEqual(continued?.type === 'continue' ? continued.result : undefined, { spec: 'docs/a.md', n: 2 }, 'the next prompt is rendered from the task\'s records (#629)');
  assert.deepEqual([task(state, 1)?.stage, resultN(state, 1)], ['dev', { spec: 'docs/a.md', n: 2 }]);
  const killed = reduce(state, { type: 'exit', ptyId: id }).state;
  assert.deepEqual(resultN(killed, 1), { spec: 'docs/a.md', n: 2 });
});

test('pr records the link and its lastEvent, the status left as it was, like a detected gh pr create; ask turns the worker yellow with the question, which a Stop without done and an idle Notification keep and a prompt clears (#99, #663)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const pr = reduce(first, { type: 'pr', ptyId: id, url: 'https://github.com/o/r/pull/7' });
  assert.deepEqual(prsN(pr.state, 1), [{ url: 'https://github.com/o/r/pull/7', state: 'open' }]);
  assert.deepEqual([pr.state.workers[0].status, pr.state.workers[0].lastEvent], ['working', { kind: 'pr' }], 'review is the task\'s state now (#663)');
  assert.deepEqual(pr.effects, []);
  const asked = reduce(first, { type: 'ask', ptyId: id, question: 'Which base?' }).state;
  assert.deepEqual([asked.workers[0].status, asked.workers[0].question, asked.workers[0].lastEvent], ['waiting', 'Which base?', { kind: 'ask' }]);
  const idle = hook(asked, id, { hook_event_name: 'Stop' }).state;
  assert.deepEqual([idle.workers[0].status, idle.workers[0].question, idle.workers[0].lastEvent], ['waiting', 'Which base?', { kind: 'ask' }], 'the worker ended its turn to wait: the question stays');
  const nudged = hook(idle, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' }).state;
  assert.deepEqual([nudged.workers[0].status, nudged.workers[0].question], ['waiting', 'Which base?'], 'a prompt\'s generic text never replaces the question of the worker');
  const answered = hook(nudged, id, { hook_event_name: 'UserPromptSubmit' }).state;
  assert.deepEqual([answered.workers[0].status, answered.workers[0].question, answered.workers[0].lastEvent], ['working', undefined, { kind: 'prompt' }]);
  const plain = hook(answered, id, { hook_event_name: 'Stop' }).state;
  assert.deepEqual([plain.workers[0].question, plain.workers[0].lastEvent], [undefined, { kind: 'turn' }], 'a Stop after anything but an ask is the plain turn end');
});

// What Claude Code 2.1.283 sends on a Stop while the worker's own work runs (#367): only the length is read
const BACKGROUND = [
  { id: 'b1', type: 'subagent', status: 'running', description: 'review the diff' },
  { id: 'b2', type: 'shell', status: 'running', description: 'pnpm test' },
];

test('a Stop without done while background tasks or session crons are in flight keeps the worker green with the count and no question, an open PR or not (#367, row 1, #663)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const busy = hook(first, id, { hook_event_name: 'Stop', background_tasks: BACKGROUND, session_crons: [] });
  assert.deepEqual([busy.state.workers[0].status, busy.state.workers[0].question, busy.state.workers[0].lastEvent], ['working', undefined, { kind: 'background', detail: '2' }]);
  assert.deepEqual(busy.effects, []);
  assert.equal('waitingSince' in busy.state.workers[0], false, 'no wait was entered');
  const cron = hook(first, id, { hook_event_name: 'Stop', session_crons: [{ id: 'c1' }] }).state;
  assert.deepEqual([cron.workers[0].status, cron.workers[0].lastEvent], ['working', { kind: 'background', detail: '1' }], 'a scheduled wake counts too');
  const both = hook(first, id, { hook_event_name: 'Stop', background_tasks: BACKGROUND, session_crons: [{ id: 'c1' }] }).state;
  assert.deepEqual(both.workers[0].lastEvent, { kind: 'background', detail: '3' });
  const reviewing = reduce(first, { type: 'pr', ptyId: id, url: 'https://github.com/o/r/pull/7' }).state;
  const inReview = hook(reviewing, id, { hook_event_name: 'Stop', background_tasks: BACKGROUND }).state;
  assert.equal(inReview.workers[0].status, 'working', 'an open PR no longer turns the run review: the task state shows it (#663)');
});

test('a Stop without done and with nothing in flight still turns the worker yellow as the plain turn end (#367, row 2)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const idle = hook(first, id, { hook_event_name: 'Stop', background_tasks: [], session_crons: [] }).state;
  assert.deepEqual([idle.workers[0].status, idle.workers[0].question, idle.workers[0].lastEvent], ['waiting', undefined, { kind: 'turn' }]);
  assert.ok(idle.workers[0].waitingSince, 'the wait is stamped as today (#233)');
});

test('an idle_prompt Notification no longer turns a worker yellow: a worker waiting on its subagent stays green (#367, row 3)', () => {
  assert.equal(WAITING_NOTIFICATIONS.includes('idle_prompt'), false);
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const busy = hook(first, id, { hook_event_name: 'Stop', background_tasks: BACKGROUND }).state;
  const nudged = hook(busy, id, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }).state;
  assert.deepEqual([nudged.workers[0].status, nudged.workers[0].question, nudged.workers[0].lastEvent], ['working', undefined, { kind: 'background', detail: '2' }]);
});

test('the blocking prompts still turn a worker yellow, and a Stop with background work after hive_ask keeps the question (#367, row 4, #99)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const busy = hook(first, id, { hook_event_name: 'Stop', background_tasks: BACKGROUND }).state;
  for (const kind of ['permission_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog']) {
    const blocked = hook(busy, id, { hook_event_name: 'Notification', notification_type: kind, message: 'needs you' }).state;
    assert.deepEqual([blocked.workers[0].status, blocked.workers[0].question, blocked.workers[0].lastEvent], ['waiting', 'needs you', { kind: 'waiting', detail: kind }], kind);
  }
  const asked = reduce(first, { type: 'ask', ptyId: id, question: 'Which base?' }).state;
  const idle = hook(asked, id, { hook_event_name: 'Stop', background_tasks: BACKGROUND }).state;
  assert.deepEqual([idle.workers[0].status, idle.workers[0].question, idle.workers[0].lastEvent], ['waiting', 'Which base?', { kind: 'ask' }], 'the worker asked: the user owes the answer, whatever runs meanwhile');
});

test('a Stop whose payload lacks the fields, or carries anything but arrays in them, counts as nothing in flight: the plain turn end (#367, row 5)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const payloads: Partial<HookPayload>[] = [{}, { background_tasks: null, session_crons: undefined }, { background_tasks: 'x', session_crons: { length: 3 } }, { background_tasks: 7 }];
  for (const extra of payloads) {
    const idle = hook(first, id, { ...extra, hook_event_name: 'Stop' }).state;
    assert.deepEqual([idle.workers[0].status, idle.workers[0].lastEvent], ['waiting', { kind: 'turn' }], JSON.stringify(extra));
  }
});

test('no timer releases the background wait: the next Stop decides again, yellow once nothing is in flight and green again while work runs (#367, row 6)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const busy = hook(first, id, { hook_event_name: 'Stop', background_tasks: BACKGROUND }).state;
  const settled = hook(busy, id, { hook_event_name: 'Stop', background_tasks: [] }).state; // the hand-back woke the worker, which ended its turn again
  assert.deepEqual([settled.workers[0].status, settled.workers[0].lastEvent], ['waiting', { kind: 'turn' }]);
  const again = hook(settled, id, { hook_event_name: 'Stop', background_tasks: BACKGROUND.slice(0, 1) }).state;
  assert.deepEqual([again.workers[0].status, again.workers[0].lastEvent], ['working', { kind: 'background', detail: '1' }]);
  assert.equal('waitingSince' in again.workers[0], false, 'a yellow worker whose worker started more background work leaves the wait');
});

test('done, pr and ask ignore an unknown worker (#99)', () => {
  const events: HiveEvent[] = [
    { type: 'done', ptyId: 'ghost', result: { a: 1 } },
    { type: 'pr', ptyId: 'ghost', url: 'https://github.com/o/r/pull/1' },
    { type: 'ask', ptyId: 'ghost', question: 'q?' },
  ];
  for (const state of [filled(1, 1).state, base(1)]) {
    for (const event of events) assert.equal(reduce(state, event).state, state, event.type);
  }
});

test('PostToolUse with gh pr create records the PR on the task with no effect and leaves the status; other commands change nothing (#663)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const { state, effects } = hook(first, id, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: { stdout: 'https://github.com/o/r/pull/42\n' } });
  assert.equal(state.workers[0].status, 'working');
  assert.deepEqual(prsN(state, 1), [{ url: 'https://github.com/o/r/pull/42', state: 'open' }]);
  assert.deepEqual(state.workers[0].lastEvent, { kind: 'pr' });
  assert.equal(effects.length, 0);
  const back = hook(hook(state, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }).state, id, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).state;
  assert.equal(back.workers[0].status, 'working', 'a hook sets working, an open PR or not (#663)');
  const other = hook(first, id, { hook_event_name: 'PostToolUse', tool_input: { command: 'git status' }, tool_response: 'clean' });
  assert.equal(other.state.workers[0].status, 'working');
  assert.equal(other.effects.length, 0);
  const finished = stopped(state, id);
  assert.deepEqual(prsN(finished.state, 1), [{ url: 'https://github.com/o/r/pull/42', state: 'open' }], 'the PR travels with the task');
});

test('markPr appends every PR the worker opens as open, oldest first, and ignores a link already on the task; a PreToolUse sets working, an open PR or not (#207, #663)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const PR = 'https://github.com/o/r/pull/';
  const pr = (state: State, n: number): State => reduce(state, { type: 'pr', ptyId: id, url: `${PR}${n}` }).state;
  const twice = pr(pr(pr(first, 7), 8), 7);
  assert.deepEqual(prsN(twice, 1), [{ url: `${PR}7`, state: 'open' }, { url: `${PR}8`, state: 'open' }]);
  const detected = hook(twice, id, { hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create --fill' }, tool_response: `${PR}8` }).state;
  assert.deepEqual(prsN(detected, 1), prsN(twice, 1), 'hive_pr and the gh pr create safety net report the same PR once');
  const settle = (prs: TaskPr[]): State => withMade(twice, 1, { prs });
  const tool = (state: State): string => hook(state, id, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }).state.workers[0].status;
  assert.equal(tool(settle([{ url: `${PR}7`, state: 'merged' }, { url: `${PR}8`, state: 'closed' }])), 'working');
  assert.equal(tool(settle([{ url: `${PR}7`, state: 'merged' }, { url: `${PR}8`, state: 'open' }])), 'working', 'one open PR left: still working (#663)');
});

test('markPr keeps hive_pr\'s slice: a new link is appended with it, a link the detection recorded takes it, a report without one keeps it and the record (#698)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const url = 'https://github.com/o/r/pull/7';
  const detected = hook(first, id, { hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create --fill' }, tool_response: url }).state;
  assert.deepEqual(prsN(detected, 1), [{ url, state: 'open' }], 'the detection brings no slice');
  const told = reduce(detected, { type: 'pr', ptyId: id, url, slice: { k: 2, type: 'stacked' } }).state;
  assert.deepEqual(prsN(told, 1), [{ url, state: 'open', slice: { k: 2, type: 'stacked' } }]);
  const again = reduce(told, { type: 'pr', ptyId: id, url }).state;
  assert.equal(recordOf(again, work(again, 1)!.id), recordOf(told, work(told, 1)!.id), 'no slice: the same record');
  const fresh = reduce(first, { type: 'pr', ptyId: id, url: 'https://github.com/o/r/pull/8', slice: { k: 1, type: 'integration' } }).state;
  assert.deepEqual(prsN(fresh, 1), [{ url: 'https://github.com/o/r/pull/8', state: 'open', slice: { k: 1, type: 'integration' } }]);
});

test('hive_pr and the gh pr create detection record the reporting worker\'s session on the task\'s PR (#62)', () => {
  const { state: started, id, first } = sessionStarted();
  const url = 'https://github.com/o/r/pull/7';
  const told = reduce(started, { type: 'pr', ptyId: id, url }).state;
  assert.deepEqual(prsN(told, 1), [{ url, state: 'open', sessionId: first }]);
  const detected = hook(started, id, { hook_event_name: 'PostToolUse', tool_input: { command: 'gh pr create --fill' }, tool_response: url }).state;
  assert.deepEqual(prsN(detected, 1), [{ url, state: 'open', sessionId: first }]);
});

test('prStates takes the states the PR query read (#207): the matching PRs change, a task with nothing new is the same object, and no worker changes (#663)', () => {
  const PR = 'https://github.com/o/r/pull/';
  const pr = (state: State, ptyId: string, n: number): State => reduce(state, { type: 'pr', ptyId, url: `${PR}${n}` }).state;
  const first = filled(2, 2).state; // item1 and item2 running in spec
  const [one, two] = [1, 2].map((n) => first.workers.find((s) => ownerOf(first, s) === `board:item${n}`)!.runId!);
  const opened = pr(pr(pr(first, one, 7), one, 8), two, 9);
  const merged = reduce(opened, { type: 'prStates', states: [{ url: `${PR}7`, state: 'merged' }] });
  assert.deepEqual(merged.effects, []);
  assert.deepEqual(prsN(merged.state, 1), [{ url: `${PR}7`, state: 'merged' }, { url: `${PR}8`, state: 'open' }]);
  const record2 = (state: State) => recordOf(state, work(state, 2)!.id); // #629: the PRs are the record's
  assert.equal(record2(merged.state), record2(opened), 'nothing read for it: the same object');
  assert.equal(merged.state.workers, opened.workers, 'the workers are untouched (#663)');
  const same = reduce(opened, { type: 'prStates', states: [{ url: `${PR}9`, state: 'open' }] }).state;
  assert.equal(record2(same), record2(opened), 'a state that did not change: the same object');
  const settled = reduce(merged.state, { type: 'prStates', states: [{ url: `${PR}8`, state: 'closed' }, { url: `${PR}9`, state: 'merged' }] }).state;
  assert.equal(settled.workers, merged.state.workers, 'no open PR left: still no worker changes (#663)');
  assert.deepEqual(prsN(settled, 1)?.map((p) => p.state), ['merged', 'closed']);
});

test('SessionEnd behaves like exit; exit is idempotent and ignores unknown or replaced worker ids', () => {
  const first = filled(1, 2).state;
  const id = first.workers[0].runId!;
  const { state, effects } = hook(first, id, { hook_event_name: 'SessionEnd' });
  assert.equal(taskOfWorker(state, state.workers[0])?.item.id, '2', 'task 1 is stopped (#283): task 2 takes the worker');
  assert.equal(effects.length, 2, 'the next spawn, and the transcript of a run that never opened');
  const w2 = state.workers[0].runId!;
  assert.ok(w2 !== id, 'refill assigns a fresh worker id');
  const stale = reduce(state, { type: 'exit', ptyId: id });
  assert.equal(stale.state, state);
  assert.equal(reduce(first, { type: 'exit', ptyId: 'nope' }).state, first);
  const staleHook = hook(state, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' });
  assert.equal(staleHook.state.workers[0].status, 'working');
  const s = base(1);
  assert.equal(hook(s, 'ghost', { hook_event_name: 'Stop' }).state, s);
});

test('boot gives every occupied worker as dead: workers empty, tasks keep their stage and session id, no effects, and opens under yellow unless red', () => {
  const first = filled(2, 3).state;
  const { state, effects } = reduce(first, { type: 'boot' });
  assert.deepEqual(state.workers.map((s) => s.status), ['empty', 'empty']);
  assert.deepEqual(state.tasks.map((c) => [c.stage, runOf(state, c)?.workerId]), [['spec', undefined], ['spec', undefined], ['spec', undefined]]);
  assert.equal(work(state, 1)?.sessionId, work(first, 1)?.sessionId);
  assert.equal(effects.length, 0, 'no board write, no spawn');
  assert.equal(state.signal, 'yellow');
  assert.equal(reduce(signaled(base(1), 'red').state, { type: 'boot' }).state.signal, 'red');
});

test('boot clears a workerId that points at no occupied worker, so a task from a tampered or half-written state.json is not stuck', () => {
  const first = filled(1, 1).state;
  const stale: State = { ...first, workers: first.workers.map((s) => ({ id: s.id, status: 'empty' as const })) }; // normalizeWorker on an unknown status
  const { state } = reduce(stale, { type: 'boot' });
  assert.equal(work(state, 1)?.workerId, undefined);
  assert.equal(task(state, 1)?.stage, 'spec');
});

test('stop emits only the kill and marks the task stopped, keeping its session, worktree and branch; the exit that follows starts nothing, even under green; an unknown worker is nothing (#182, #283)', () => {
  const dev = polled(base(1), [listed(1, 'Ready')]).state; // dev continues the session
  const { runId: ptyId } = dev.workers[0];
  const located = reduce(dev, { type: 'hook', ptyId: ptyId!, branch: 'hive/1-task-1', payload: { hook_event_name: 'SessionStart', cwd: WORKTREE } }).state;
  const stopping = reduce(located, { type: 'stop', ptyId: ptyId! });
  assert.deepEqual(stopping.effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId }]);
  const kept = work(located, 1)!; // #629: the marks are the activity's
  const marked = work(stopping.state, 1)!;
  assert.equal(typeof marked.stoppedAt, 'string', 'the stop is stamped (#580)');
  assert.deepEqual(stopping.state, withActivity(located, { ...kept, stopped: true, stoppedAt: marked.stoppedAt }), 'the mark only: the worker frees on the exit');
  const again = reduce(stopping.state, { type: 'exit', ptyId: ptyId! });
  assert.deepEqual(again.effects, [], 'stopped: the free worker stays free');
  assert.deepEqual([work(again.state, 1)?.sessionId, work(again.state, 1)?.worktree, work(again.state, 1)?.branch], [work(located, 1)?.sessionId, WORKTREE, 'hive/1-task-1']);
  const idle = base(1);
  assert.equal(reduce(idle, { type: 'stop', ptyId: 'nope' }).state, idle, 'unknown worker: same object');
});

test('error sets and poll clears state.error', () => {
  const withError = reduce(base(1), { type: 'error', message: 'gh: boom' }).state;
  assert.equal(withError.error, 'gh: boom');
  assert.equal(polled(withError, []).state.error, undefined);
});

test('closeTask never removes the worktree: a running missing task leaves with the kill alone; an idle missing task with a worktree leaves with no effect (#182)', () => {
  const first = signaled(polled(base(1), [listed(1), listed(2)]).state, 'yellow').state; // 1 running, 2 stopped
  const id = first.workers[0].runId!;
  const located = reduce(first, { type: 'hook', ptyId: id, branch: 'hive-1-task-1', payload: { hook_event_name: 'SessionStart', cwd: '/w/hive-1-task-1' } }).state;
  const gone = polled(located, []).state;
  const running = reduce(gone, { type: 'closeTask', taskId: 'board:item1' });
  assert.deepEqual(running.effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: id }, { type: 'forgetScrollback', ptyId: id }]);
  assert.deepEqual(running.state.tasks.map((c) => c.item.id), ['2']);
  assert.equal(running.state.workers[0].status, 'empty');
  const ran: State = everyLive(running.state, { worktree: '/w/hive-2-task-2', sessionId: 'kept-session-id-0002' }); // #629: the activity's
  const idle = reduce(ran, { type: 'closeTask', taskId: 'board:item2' });
  assert.deepEqual(idle.effects, [], 'the worktree stays on disk: removing it is the details panel\'s own button');
  assert.deepEqual(idle.state.tasks, []);
});

test('initialState starts green with no tasks, no stages, no usage; canStart is true only under green with a free, non-draining worker', () => {
  const idle = initialState(2);
  assert.deepEqual([idle.signal, idle.tasks, idle.stages, idle.usage, idle.budget], ['green', [], [], [], {}]);
  assert.equal(canStart(GREEN, idle.workers), true);
  assert.equal(canStart(GREEN, filled(2, 2).state.workers), false);
  assert.equal(canStart(GREEN, [{ id: 'x', status: 'empty', draining: true }]), false);
  assert.equal(canStart(GREEN, []), false);
  assert.equal(canStart(SIGNALS_DEFAULTS.red, idle.workers), false, 'never starts none');
  assert.equal(canStart(SIGNALS_DEFAULTS.yellow, idle.workers), true, 'tree could start one: which task qualifies is the fill\'s question (#32)');
  assert.equal(canStart(GREEN, filled(2, 1).state.workers, 1), false, 'occupied 1 = limit 1');
  assert.equal(canStart(GREEN, filled(2, 1).state.workers, 2), true);
});

test('poll under yellow or red enters the tasks and spawns nothing; setSignal green fills', () => {
  const yellow = polled(signaled(base(2), 'yellow').state, many(3));
  assert.equal(yellow.state.tasks.length, 3);
  assert.equal(occupied(yellow.state).length, 0);
  assert.equal(yellow.effects.length, 0);
  const red = signaled(yellow.state, 'red');
  assert.equal(red.effects.length, 0);
  const green = signaled(red.state, 'green');
  assert.equal(occupied(green.state).length, 2);
  assert.deepEqual(green.effects.map((e) => e.type), ['spawn', 'spawn']);
  assert.equal(reduce(signaled(filled(1, 3).state, 'red').state, { type: 'setMax', max: 3 }).effects.length, 0, 'setMax up under red spawns nothing');
});

test('Stop with tokens records the sample even though the worker is freed; a SessionEnd with tokens too; no tokens adds nothing; unknown worker is ignored', () => {
  const first = signaled(filled(1, 1).state, 'red').state; // red: dev continues the session, so under green or yellow the Stop would go on in place
  const id = first.workers[0].runId!;
  const one = counted(first, id, 1200);
  assert.deepEqual(one.usage.map((s) => s.tokens), [1200]);
  assert.ok(Number.isFinite(Date.parse(one.usage[0].at)));
  assert.equal(one.workers[0].status, 'empty', 'Stop finishes the run');
  const partial = reduce(first, { type: 'hook', ptyId: id, payload: { hook_event_name: 'SessionEnd' }, tokens: 800 }).state;
  assert.deepEqual(partial.usage.map((s) => s.tokens), [800]);
  assert.equal(stopped(first, id).state.usage.length, 0);
  assert.equal(reduce(first, { type: 'hook', ptyId: 'nope', payload: { hook_event_name: 'Stop' }, tokens: 999 }).state, first);
});

test('poll under an exhausted hour budget enters tasks and starts nothing; a sample outside the hour does not count; setBudget can reopen', () => {
  const blocked = polled(spent(1000, 0, { maxTokensPerHour: 1000 }), many(2));
  assert.equal(occupied(blocked.state).length, 0);
  assert.equal(blocked.state.tasks.length, 2);
  assert.equal(blocked.effects.length, 0);
  const reopened = polled(spent(1000, 2 * HOUR_MS, { maxTokensPerHour: 1000 }), many(2));
  assert.equal(occupied(reopened.state).length, 1);
  assert.equal(occupied(polled(spent(1000, 2 * HOUR_MS, { maxTokensPerDay: 1000 }), many(1)).state).length, 0);
  const raised = reduce(blocked.state, { type: 'setBudget', budget: { maxTokensPerHour: 5000 } });
  assert.deepEqual(raised.state.budget, { maxTokensPerHour: 5000 });
  assert.deepEqual(raised.effects.map((e) => e.type), ['spawn']);
});

test('usage rules: a cap opens up to the cap and drains nothing; yellow stops fill without touching the manual signal; aging out reopens', () => {
  const capped = polled(ruled(base(3), 550), many(3)); // 55%: cap 1
  assert.equal(capped.state.maxConcurrent, 3);
  assert.equal(occupied(capped.state).length, 1);
  assert.ok(capped.state.workers.every((s) => !s.draining));
  const three = ruled(filled(3, 4).state, 550); // 3 running, 1 stopped, cap 1
  const freed = reduce(three, { type: 'exit', ptyId: three.workers[0].runId! });
  assert.deepEqual(freed.effects.map((e) => e.type), ['forgetScrollback'], 'the freed worker stays empty while occupied >= cap');
  assert.equal(occupied(freed.state).length, 2);
  const yellow = polled(ruled(base(1), 850), many(1)); // 85%: dynamic yellow
  assert.equal(yellow.state.signal, 'green');
  assert.equal(occupied(yellow.state).length, 0);
  const aged = polled(ruled(yellow.state, 850, 2 * HOUR_MS), many(1));
  assert.equal(occupied(aged.state).length, 1);
  const loosened = reduce(capped.state, { type: 'setUsageRules', usageRules: [] });
  assert.deepEqual(loosened.state.usageRules, []);
  assert.deepEqual(loosened.effects.map((e) => e.type), ['spawn', 'spawn'], 'lifting the cap pulls the rest right away');
  assert.equal(reduce(loosened.state, { type: 'setUsageRules', usageRules: RULES }).effects.length, 0, 'rules that tighten never kill or drain');
});

test('Stop under a red signal (manual or dynamic) still finishes the run: there is no paused state any more', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const manual = stopped(signaled(first, 'red').state, id);
  assert.equal(manual.state.workers[0].status, 'empty');
  assert.equal(manual.effects[0].type, 'kill');
  assert.equal(task(manual.state, 1)?.stage, 'dev');
  const dynamic = counted(ruled({ ...first, usage: [] }, 0), id, 950); // 95% in one turn
  assert.equal(dynamic.workers[0].status, 'empty');
  assert.equal('paused' in dynamic.workers[0], false);
});

test('rateLimits from an occupied worker stores the reading and runs fill; unknown or exited worker leaves the state; the Hive own reading is always kept', () => {
  const first = filled(1, 2).state;
  const id = first.workers[0].runId!;
  const roomy: State = { ...first, maxConcurrent: 2, workers: [...first.workers, { id: 'free', status: 'empty' }] };
  const { state, effects } = limited(roomy, id);
  assert.deepEqual(state.rateLimits?.claude, LIMITS);
  assert.deepEqual(effects.map((e) => e.type), ['spawn'], 'a reading is an input of the gate: fill runs and the free worker takes task 2');
  assert.equal(ownerAt(state, 1), 'board:item2');
  assert.equal(limited(first, 'ghost').state, first, 'nothing stored, nothing to fill: same object');
  const gone = reduce(first, { type: 'exit', ptyId: id }).state;
  assert.equal(limited(gone, id).state.rateLimits?.claude, undefined);
  const own = reduce(base(1), { type: 'rateLimits', agent: 'claude', rateLimits: LIMITS });
  assert.deepEqual(own.state.rateLimits?.claude, LIMITS);
  assert.equal(own.effects.length, 0, 'no task: nothing to fill');
  assert.deepEqual(reduce(reduce(state, { type: 'poll', source: 'board', items: many(2) }).state, { type: 'boot' }).state.rateLimits?.claude, LIMITS, 'survives poll and boot');
});

test('a reading is merged window by window: a stale snapshot from a long-running worker never drags a window back, a reset does', () => {
  const two: State = { ...filled(2, 3).state, usageRules: PLAN_RULES };
  const high = reduce(two, { type: 'rateLimits', agent: 'claude', rateLimits: windows(85) }).state;
  const id = high.workers[0].runId!;
  const stale = limited(high, id, { ...windows(20), at: '2026-09-16T13:00:00.000Z' }); // the cached snapshot this worker's Claude Code still replays
  assert.deepEqual(stale.state.rateLimits?.claude, { ...windows(85), at: '2026-09-16T13:00:00.000Z' }, 'inside one window use only grows: the higher reading stands');
  assert.equal(stale.effects.length, 0, 'the floor still holds: nothing is filled on a stale reading');
  const older = limited(high, id, windows(90, 0, PAST));
  assert.deepEqual(older.state.rateLimits?.claude, windows(85), 'a window that already reset is behind the one held: dropped');
  const rolled = limited(high, id, windows(20, 0, LATER));
  assert.deepEqual(rolled.state.rateLimits?.claude, windows(20, 0, LATER), 'the next window wins outright, lower percent and all');
  assert.equal(rolled.effects.length, 0, 'the floor is lifted but both workers are taken: nothing to fill');
});

test('sourceQuota stores the reading on its source, emits no effect and never fills, and a poll keeps it; setSources keeps a kept source\'s status, starts a new one empty and drops a removed one (#180)', () => {
  const first = filled(1, 2).state;
  const roomy: State = { ...first, maxConcurrent: 2, workers: [...first.workers, { id: 'free', status: 'empty' }] };
  const { state, effects } = reduce(roomy, { type: 'sourceQuota', source: 'board', quota: QUOTA });
  assert.deepEqual([state.syncs.board.quota, effects], [QUOTA, []]);
  assert.equal(state.workers[1].status, 'empty');
  assert.deepEqual(polled(state, many(2)).state.syncs.board.quota, QUOTA);
  const next = reduce(state, { type: 'setSources', sources: ['notes', 'board'] }).state;
  assert.deepEqual(next.syncs, { notes: {}, board: state.syncs.board });
  assert.deepEqual(reduce(next, { type: 'setSources', sources: [] }).state.syncs, {});
  assert.equal(reduce(roomy, { type: 'sourceQuota', source: 'gone', quota: QUOTA }).state, roomy, 'a board the Comb no longer has records nothing');
});

test('plan-window rules: session ≥ 80 blocks fill with no usage samples, week ≥ 50 caps, a reading over the floor stops fill without kill or drain, and the manual signal stays green', () => {
  const blocked = polled(planned(base(2), windows(85)), many(2));
  assert.equal(occupied(blocked.state).length, 0);
  assert.equal(blocked.effects.length, 0);
  assert.deepEqual([blocked.state.signal, blocked.state.usage], ['green', []], 'neither the manual signal nor the samples are what blocks');
  assert.equal(occupied(polled(planned(base(2), windows(10)), many(2)).state).length, 2, 'under the floor: nothing fires');
  assert.equal(occupied(polled(planned(base(2), windows(10, 60)), many(2)).state).length, 1, 'week 60 ≥ 50: cap 1');
  const two: State = { ...filled(2, 3).state, usageRules: PLAN_RULES }; // 2 running, 1 waiting
  const read = reduce(two, { type: 'rateLimits', agent: 'claude', rateLimits: windows(85) });
  assert.deepEqual(read.state.rateLimits?.claude, windows(85));
  assert.equal(read.effects.length, 0, 'no kill');
  assert.equal(occupied(read.state).length, 2);
  assert.ok(read.state.workers.every((s) => !s.draining), 'no drain');
  const freed = reduce(read.state, { type: 'exit', ptyId: read.state.workers[0].runId! });
  assert.deepEqual(freed.effects.map((e) => e.type), ['forgetScrollback'], 'session 85: the task that exited is stopped (#283), and the never-started task waits for green');
  assert.equal(occupied(freed.state).length, 1);
  assert.equal(work(freed.state, 3)?.workerId, undefined, 'the never-started task still waits for green');
});

test('a plan rule stops firing when its window passes resetsAt or a fresh reading comes below the floor: the next poll or the reading itself fills; a manual yellow stays yellow', () => {
  const blocked = polled(planned(base(1), windows(85)), many(1)).state;
  assert.equal(occupied(blocked).length, 0);
  const reset = polled({ ...blocked, rateLimits: { claude: windows(85, 0, PAST) } }, many(1));
  assert.deepEqual(reset.effects.map((e) => e.type), ['spawn'], 'past resetsAt the window reads 0 even before the reader catches up');
  const lower = reduce(blocked, { type: 'rateLimits', agent: 'claude', rateLimits: windows(70, 0, LATER) });
  assert.deepEqual(lower.effects.map((e) => e.type), ['spawn'], 'a reading below the floor reopens at once, no poll needed');
  assert.deepEqual(lower.state.rateLimits?.claude, windows(70, 0, LATER));
  const manual = signaled(blocked, 'yellow').state;
  const stillYellow = polled({ ...manual, rateLimits: { claude: windows(70, 0, PAST) } }, many(1));
  assert.equal(stillYellow.effects.length, 0, 'a rule never touches the manual signal');
  assert.equal(stillYellow.state.signal, 'yellow');
});

test('canSchedule asks whether a new task could start: newTasks with a free worker and budget; not under a yellow that starts no new task, a reached cap or an exhausted budget (#727)', () => {
  const now = Date.now();
  assert.equal(canSchedule(base(1), now), true);
  assert.equal(canSchedule(filled(1, 1).state, now), false);
  assert.equal(canSchedule({ ...signaled(base(1), 'yellow').state, signals: NO_NEW }, now), false);
  assert.equal(canSchedule(signaled(base(1), 'yellow').state, now), true, 'the default yellow is tree (#32)');
  assert.equal(canSchedule(spent(1000, 0, { maxTokensPerHour: 1000 }), now), false);
  assert.equal(canSchedule(spent(1000, 2 * HOUR_MS, { maxTokensPerHour: 1000 }), now), true);
  assert.equal(canSchedule(ruled(filled(2, 1).state, 550), now), false, '55%: cap 1 with one occupied');
  assert.equal(canSchedule({ ...ruled(base(1), 850), signals: NO_NEW }, now), false, '85%: dynamic yellow');
  assert.equal(canSchedule({ ...planned(base(1), windows(85)), signals: NO_NEW }, now), false, 'session 85 ≥ 80: dynamic yellow from the plan window, no samples at all');
  assert.equal(canSchedule(planned(base(1), windows(85, 0, PAST)), now), true, 'past its reset the window reads 0');
  assert.equal(canSchedule(ruled(base(1), 100), now), true);
});

test('effectiveLimits: the merged limits, the floor the fired rules alone impose, and the rules behind each side of it (signalRules at the floor signal, capRules at the floor cap)', () => {
  const now = Date.now();
  const none = { floor: { signal: 'green' }, signalRules: [], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} };
  assert.deepEqual(effectiveLimits(base(1), now), { signal: 'green', ...none });
  assert.deepEqual(effectiveLimits(ruled(base(1), 0), now), { signal: 'green', ...none }, 'nothing fired');
  const yellowRule = ruled(base(1), 850); // 85%: RULES fires yellow at 80 and maxWorkers 1 at 50
  assert.deepEqual(effectiveLimits(yellowRule, now), { signal: 'yellow', maxWorkers: 1, floor: { signal: 'yellow', maxWorkers: 1 }, signalRules: [RULES[1]], capRules: [RULES[0]], disabledRules: [], stageCaps: {}, stageCapRules: {} }, 'manual green + a fired yellow rule: the rule is the floor');
  const redManual = signaled(yellowRule, 'red').state;
  assert.deepEqual(effectiveLimits(redManual, now), { signal: 'red', maxWorkers: 1, floor: { signal: 'yellow', maxWorkers: 1 }, signalRules: [RULES[1]], capRules: [RULES[0]], disabledRules: [], stageCaps: {}, stageCapRules: {} }, 'manual red is stricter: red in force, yet the floor stays yellow and its rule is still listed (green is locked by it)');
  const capped = ruled(base(3), 550); // 55%: cap 1 only, no signal rule fires
  assert.deepEqual(effectiveLimits(capped, now), { signal: 'green', maxWorkers: 1, floor: { signal: 'green', maxWorkers: 1 }, signalRules: [], capRules: [RULES[0]], disabledRules: [], stageCaps: {}, stageCapRules: {} }, 'a cap-only rule: in capRules, not in signalRules');
  const caps: UsageRule[] = [{ source: 'hour', percent: 50, maxWorkers: 3 }, { source: 'hour', percent: 60, maxWorkers: 1 }];
  assert.deepEqual(effectiveLimits({ ...ruled(base(3), 700), usageRules: caps }, now).capRules, [caps[1]], 'two fired caps: only the smallest is behind the floor');
  const loose: UsageRule[] = [{ source: 'hour', percent: 50, maxWorkers: 4 }];
  const under = effectiveLimits({ ...ruled(base(3), 550), usageRules: loose }, now);
  assert.deepEqual([under.maxWorkers, under.floor.maxWorkers, under.capRules], [3, 4, loose], 'manual 3 under a cap of 4: 3 in force, the floor still says 4');
  const plan = planned(base(2), windows(85)); // PLAN_RULES: session >= 80 -> yellow (signal only); week 0 < 50: no cap
  assert.deepEqual(effectiveLimits(plan, now), { signal: 'yellow', floor: { signal: 'yellow' }, signalRules: [PLAN_RULES[0]], capRules: [], disabledRules: [], stageCaps: {}, stageCapRules: {} }, 'a signal-only rule never lands in capRules');
});
const switchOff = (state: State, source: RuleSource, percent: number, until: DisableUntil = { kind: 'reset' }): Reduced =>
  reduce(state, { type: 'disableRule', source, percent, until });

test('disableRule switches off a firing rule (#297): out of the floor, signalRules and capRules, listed in disabledRules with when it comes back', () => {
  const now = Date.now();
  const plan = planned(base(2), windows(85, 60)); // session 85 ≥ 80: yellow; week 60 ≥ 50: cap 1
  const off = switchOff(plan, 'session', 80).state;
  assert.deepEqual(off.disabledRules, [{ source: 'session', percent: 80, until: { kind: 'reset' } }]);
  assert.deepEqual(effectiveLimits(off, now), {
    signal: 'green', maxWorkers: 1, floor: { signal: 'green', maxWorkers: 1 }, signalRules: [], capRules: [PLAN_RULES[1]],
    disabledRules: [{ rule: PLAN_RULES[0], until: 'reset', backAt: FUTURE, estimate: false }], stageCaps: {}, stageCapRules: {},
  }, 'the session rule is off: its yellow goes, the week cap stays');
  const hour = switchOff(ruled(base(3), 850), 'hour', 80).state; // RULES: cap 1 at 50, yellow at 80, red at 90
  const [status] = effectiveLimits(hour, now).disabledRules;
  assert.deepEqual([status.rule, status.until, status.estimate], [RULES[1], 'reset', true]);
  assert.equal(status.backAt, new Date(Date.parse(hour.usage[0].at) + HOUR_MS).toISOString(), 'hour: when its one sample ages out');
  assert.equal(effectiveLimits(hour, now).floor.signal, 'green');
  const manual = switchOff(plan, 'week', 50, { kind: 'manual' }).state;
  assert.deepEqual(effectiveLimits(manual, now).disabledRules, [{ rule: PLAN_RULES[1], until: 'manual', estimate: false }], 'manual: no backAt');
});

test('disableRule leaves the state as is for a rule below its percent, a pair the table does not have, or one already disabled (#297)', () => {
  const plan = planned(base(1), windows(70)); // session 70 < 80
  for (const [source, percent, why] of [['session', 80, 'below its percent'], ['session', 75, 'no such percent'], ['hour', 80, 'no such source']] as const) {
    const { state, effects } = switchOff(plan, source, percent);
    assert.equal(state, plan, why);
    assert.deepEqual(effects, [], why);
  }
  const off = switchOff(planned(base(1), windows(85)), 'session', 80).state;
  assert.equal(switchOff(off, 'session', 80, { kind: 'manual' }).state, off, 'already disabled');
});

test('a disabled session rule is dropped by the first event after its window resets, and a later reading above its percent fires it again (#297)', () => {
  const off = switchOff(planned(base(1), windows(85)), 'session', 80).state;
  assert.equal(reduce(off, { type: 'tick' }).state.disabledRules.length, 1, 'still above 80 before the reset');
  const reset = reduce({ ...off, rateLimits: { claude: windows(85, 0, PAST) } }, { type: 'tick' }).state; // time passed its resetsAt, no reading since
  assert.deepEqual(reset.disabledRules, []);
  const risen = reduce(reset, { type: 'rateLimits', agent: 'claude', rateLimits: windows(90, 0, LATER) }).state;
  assert.deepEqual(effectiveLimits(risen, Date.now()).signalRules, [PLAN_RULES[0]], 'the next window above 80: the rule fires as usual');
});

test('a disabled hour rule is dropped once its samples age out below the percent, before a hook that adds tokens is counted (#297)', () => {
  const running = ruled(filled(1, 1).state, 850, HOUR_MS - 60_000); // 85% from a sample one minute from ageing out
  const off = switchOff(running, 'hour', 80).state;
  assert.equal(reduce(off, { type: 'tick' }).state.disabledRules.length, 1, 'still 85% inside the hour');
  const aged: State = { ...off, usage: off.usage.map((s) => ({ ...s, at: new Date(Date.parse(s.at) - 120_000).toISOString() })) }; // two minutes later
  const id = aged.workers[0].runId!;
  const turn = reduce(aged, { type: 'hook', ptyId: id, payload: { hook_event_name: 'Stop' }, tokens: 850 }).state;
  assert.deepEqual(turn.disabledRules, [], 'dropped on the state before the hook');
  assert.deepEqual(effectiveLimits(turn, Date.now()).signalRules, [RULES[1]], 'the new 850 tokens fire it again');
});

test('an at disable survives a window reset and is dropped on the first event at or after its time; effectiveLimits already ignores it past that time (#297)', () => {
  const off = switchOff(planned(base(1), windows(85)), 'session', 80, { kind: 'at', at: FUTURE }).state;
  const reset = reduce({ ...off, rateLimits: { claude: windows(85, 0, PAST) } }, { type: 'tick' }).state;
  assert.equal(reset.disabledRules.length, 1, 'the window reset: an at disable holds until its time');
  const due: State = { ...reset, rateLimits: { claude: windows(85, 0, LATER) }, disabledRules: [{ source: 'session', percent: 80, until: { kind: 'at', at: PAST } }] }; // its time has come
  assert.deepEqual(effectiveLimits(due, Date.now()).signalRules, [PLAN_RULES[0]], 'past its time the rule counts again, before any event');
  assert.deepEqual(effectiveLimits(due, Date.now()).disabledRules, []);
  assert.deepEqual(reduce(due, { type: 'tick' }).state.disabledRules, []);
});

test('a manual disable survives a window reset and a later rise; only enableRule drops it, and the rule is back in the floor (#297)', () => {
  const off = switchOff(planned(base(1), windows(85)), 'session', 80, { kind: 'manual' }).state;
  const reset = reduce({ ...off, rateLimits: { claude: windows(85, 0, PAST) } }, { type: 'tick' }).state;
  const risen = reduce(reset, { type: 'rateLimits', agent: 'claude', rateLimits: windows(95, 0, LATER) }).state;
  assert.equal(risen.disabledRules.length, 1);
  assert.equal(effectiveLimits(risen, Date.now()).floor.signal, 'green');
  const on = reduce(risen, { type: 'enableRule', source: 'session', percent: 80 }).state;
  assert.deepEqual(on.disabledRules, []);
  assert.deepEqual(effectiveLimits(on, Date.now()).floor, { signal: 'yellow' });
  assert.equal(reduce(on, { type: 'enableRule', source: 'session', percent: 80 }).state, on, 'nothing to enable: unchanged');
});

test('setUsageRules drops every disable whose source and percent no longer name a rule (#297)', () => {
  const off = switchOff(switchOff(planned(base(1), windows(85, 60)), 'session', 80).state, 'week', 50, { kind: 'manual' }).state;
  const edited = reduce(off, { type: 'setUsageRules', usageRules: [{ source: 'session', percent: 85, signal: 'yellow' }, PLAN_RULES[1]] }).state;
  assert.deepEqual(edited.disabledRules, [{ source: 'week', percent: 50, until: { kind: 'manual' } }], 'session 80 is now 85: another rule, its disable goes');
});

test('disableRule lifts the floor and fills a free worker at once, like setBudget (#297)', () => {
  const blocked = polled(planned(base(1), windows(85)), many(1)).state; // session 85 ≥ 80: yellow, nothing starts
  assert.equal(occupied(blocked).length, 0);
  const { state, effects } = switchOff(blocked, 'session', 80);
  assert.deepEqual(effects.map((e) => e.type), ['spawn']);
  assert.equal(ownerAt(state, 0), 'board:item1');
});


test('slugFor strips accents, lowercases, caps the title at 30 chars and kebab-izes the id; isBlocked is true only for a non-empty blockedBy', () => {
  assert.equal(slugFor({ ...item(12), title: 'Adicionar Autenticação OAuth no backend da API v2' }), 'hive-12-adicionar-autenticacao-oauth-n');
  assert.equal(slugFor({ ...item(3), title: '  --weird__title!!  ' }), 'hive-3-weird-title');
  assert.equal(slugFor({ ...item(1), id: 'T-12', title: 'Exemplo' }), 'hive-t-12-exemplo');
  assert.equal(slugFor({ ...item(1), id: 'Épico #3', title: 'x' }), 'hive-epico-3-x');
  assert.equal(isBlocked(item(1)), false);
  assert.equal(isBlocked({ ...item(1), blockedBy: [] }), false);
  assert.equal(isBlocked({ ...item(1), blockedBy: ['T-1'] }), true);
});

test('fill skips a blocked task, takes the next free one and moves it above the blocked one (#117); a later poll without blockedBy starts it', () => {
  const { state, effects } = polled(base(1), [{ item: { ...item(1), blockedBy: ['3'] }, column: 'Backlog' }, listed(2), listed(3)]);
  assert.equal(taskOfWorker(state, state.workers[0])?.item.id, '2');
  assert.deepEqual(state.tasks.map((c) => c.item.id), ['2', '1', '3'], 'the started task sits above the blocked one it was picked over; 1 and 3 keep their order');
  assert.deepEqual(effects.map((e) => e.type), ['spawn']);
  const waiting = polled(base(1), [{ item: { ...item(1), blockedBy: ['2'] }, column: 'Backlog' }]);
  assert.equal(waiting.state.workers[0].status, 'empty');
  assert.equal(ownerAt(polled(waiting.state, [listed(1)]).state, 0), 'board:item1');
  assert.equal(ownerAt(polled(base(1), [{ item: { ...item(1), blockedBy: [] }, column: 'Backlog' }]).state, 0), 'board:item1', 'blockedBy: [] counts as free');
});

test('extractPrUrl finds the PR url only for gh pr create; isFree is true only for an empty worker that is not draining', () => {
  assert.equal(extractPrUrl('gh pr create --fill', 'https://github.com/a/b/pull/9\n'), 'https://github.com/a/b/pull/9');
  assert.equal(extractPrUrl('gh pr create', { stdout: 'x https://github.com/a/b-c/pull/10 y' }), 'https://github.com/a/b-c/pull/10');
  assert.equal(extractPrUrl('gh pr view', 'https://github.com/a/b/pull/9'), undefined);
  assert.equal(isFree({ id: 'x', status: 'empty' }), true);
  assert.equal(isFree({ id: 'x', status: 'empty', draining: true }), false);
  assert.equal(isFree(filled(1, 1).state.workers[0]), false);
});

test('start under yellow or red runs a stopped task in its own stage, marked manualStart, ignoring the cap and the budget, and never fills; with a free worker nothing is appended and nothing drains', () => {
  const yellow = polled(signaled(base(2), 'yellow').state, [listed(1, 'Ready'), listed(2), listed(3)]).state;
  const { state, effects } = started(yellow, 'board:item1');
  assert.equal(state.signal, 'yellow');
  assert.equal(ownerAt(state, 0), 'board:item1');
  assert.deepEqual(state.workers[0].lastEvent, { kind: 'manualStart' });
  assert.equal(task(state, 1)?.stage, 'dev', 'its own stage, whichever stage would win a free worker');
  assert.equal(state.workers[1].status, 'empty', 'only the task asked for opens');
  assert.equal(state.workers.length, 2, 'a free worker: nothing appended');
  assert.ok(state.workers.every((s) => !s.draining), 'nothing drains');
  assert.equal(state.maxConcurrent, 2);
  assert.deepEqual(effects.map((e) => e.type), ['setColumn', 'spawn']);
  assert.equal(ownerAt(started(signaled(yellow, 'red').state, 'board:item3').state, 0), 'board:item3');
  const capped = polled(ruled(base(3), 550), many(3)).state; // cap 1: one running
  const both = started(capped, 'board:item3').state;
  assert.deepEqual(owners(both, occupied(both)), ['board:item1', 'board:item3']);
  const broke = polled(spent(1000, 0, { maxTokensPerHour: 1000 }), many(1)).state;
  assert.equal(ownerAt(started(broke, 'board:item1').state, 0), 'board:item1');
});

test('start leaves the state as is for an unknown, running, missing or blocked task and a stage without prompt', () => {
  const queued = polled(signaled(base(1), 'yellow').state, [{ item: { ...item(1), blockedBy: ['3'] }, column: 'Backlog' }, listed(2, 'In review'), listed(3)]).state;
  for (const [itemId, why] of [['nope', 'unknown'], ['board:item1', 'blocked'], ['board:item2', 'no prompt']] as const) {
    const { state, effects } = started(queued, itemId);
    assert.equal(state, queued, why);
    assert.equal(effects.length, 0, why);
  }
  const full = filled(1, 2).state;
  assert.equal(started(full, 'board:item1').state, full, 'already running');
  const gone = polled(full, [listed(1)]).state;
  assert.equal(started(gone, 'board:item2').state, gone, 'missing');
});

test('start with no free worker appends a draining worker over the cap and runs the task there: maxConcurrent untouched, setColumn (when due) + spawn, no fill; each such start adds one', () => {
  const full = filled(2, 4).state; // 1 and 2 running in spec; 3 and 4 waiting
  const { state, effects } = started(full, 'board:item3');
  assert.equal(state.maxConcurrent, 2, 'the cap never moves from a start');
  assert.equal(state.workers.length, 3);
  assert.deepEqual(owners(state), ['board:item1', 'board:item2', 'board:item3']);
  assert.deepEqual(state.workers.map((s) => s.draining), [undefined, undefined, true], 'only the worker the start opened drains');
  assert.equal(state.workers[2].status, 'working');
  assert.deepEqual(state.workers[2].lastEvent, { kind: 'manualStart' });
  assert.equal(work(state, 3)?.workerId, state.workers[2].id);
  assert.deepEqual(effects.map((e) => e.type), ['spawn'], 'spec has no onStart: no board write');
  assert.ok(effects[0].type === 'spawn' && effects[0].worker.id === state.workers[2].id && effects[0].worker.draining === true, 'the spawn carries the worker as stored');
  assert.deepEqual(state.tasks.filter((c) => !runOf(state, c)?.workerId).map((c) => c.item.id), ['4'], 'no fill: 4 stays where it is');
  const withDev = polled(filled(1, 1).state, [listed(1), listed(2, 'Ready')]).state; // 1 runs in spec; 2 waits in dev: no free worker
  const over = started(withDev, 'board:item2');
  assert.deepEqual(over.effects.map((e) => e.type), ['setColumn', 'spawn'], 'dev has onStart: the board write comes first, as through fill');
  assert.deepEqual(over.state.workers.map((s) => s.draining), [undefined, true]);
  const twice = started(state, 'board:item4');
  assert.equal(twice.state.maxConcurrent, 2);
  assert.deepEqual(twice.state.workers.map((s) => s.draining), [undefined, undefined, true, true], 'each start without a free worker adds one');
  assert.deepEqual(owners(twice.state), ['board:item1', 'board:item2', 'board:item3', 'board:item4']);
});

test('the extra worker leaves when its own worker ends (exit, or Stop with done: kill, no continuation); a regular worker that empties first is refilled while the extra one keeps draining', () => {
  const over = started(filled(2, 4).state, 'board:item3').state; // 1 and 2 running; 3 over the cap; 4 waiting
  const extra = over.workers[2];
  const gone = reduce(over, { type: 'exit', ptyId: extra.runId! });
  assert.equal(gone.state.workers.length, 2, 'back to the cap');
  assert.ok(gone.state.workers.every((s) => !s.draining));
  assert.equal(gone.state.maxConcurrent, 2);
  assert.deepEqual([task(gone.state, 3)?.stage, work(gone.state, 3)?.workerId], ['spec', undefined], 'the task stays where it is');
  assert.deepEqual(gone.effects.map((e) => e.type), ['forgetScrollback'], 'no free worker: fill opens nothing');
  const regular = reduce(over, { type: 'exit', ptyId: over.workers[0].runId! });
  assert.deepEqual(owners(regular.state), ['board:item4', 'board:item2', 'board:item3'], 'worker 1 refilled by fill under green with the next task: task 1 stopped at its exit (#283)');
  assert.equal(regular.state.workers[0].status, 'working');
  assert.notEqual(regular.state.workers[0].runId, over.workers[0].runId, 'a new worker in the regular worker');
  assert.deepEqual(regular.state.workers.map((s) => s.draining), [undefined, undefined, true], 'the extra worker keeps draining');
  assert.deepEqual(regular.effects.map((e) => e.type), ['spawn', 'forgetScrollback']);
  const finished = stopped(over, extra.runId!);
  assert.deepEqual(finished.effects.map((e) => e.type), ['kill', 'setColumn', 'forgetScrollback'], 'draining: no continuation in place; spec writes onFinish');
  assert.equal(finished.state.workers.length, 2, 'the worker leaves at its Stop too');
  assert.deepEqual([task(finished.state, 3)?.stage, work(finished.state, 3)?.workerId], ['dev', undefined], 'the task moves on and waits for a worker');
});

test('setMax up past the occupied count clears the extra worker\'s draining as any drain, down re-marks by order; boot drops the extra worker with the rest', () => {
  const over = started(filled(2, 3).state, 'board:item3').state; // 3 running over a cap of 2
  const raised = reduce(over, { type: 'setMax', max: 3 });
  assert.equal(raised.state.workers.length, 3);
  assert.ok(raised.state.workers.every((s) => !s.draining), 'a cap that fits the occupied count: nothing drains');
  assert.equal(raised.effects.length, 0);
  const lowered = reduce(over, { type: 'setMax', max: 1 }).state;
  assert.deepEqual(lowered.workers.map((s) => s.draining), [undefined, true, true], 'by order against the new max, as today');
  const booted = reduce(over, { type: 'boot' }).state;
  assert.deepEqual(booted.workers.map((s) => s.status), ['empty', 'empty'], 'the extra worker is gone, the two regular ones are emptied');
  assert.equal(booted.maxConcurrent, 2);
  assert.ok(booted.tasks.every((c) => runOf(booted, c)?.workerId === undefined));
});

test('start moves the task right below the running ones of its stage and above the waiting ones, with a free worker or over the cap; sourceOrder untouched, no extra effect; the next start regroups running tasks a drag scattered (#117)', () => {
  const ids = (s: State): string[] => s.tasks.map((c) => c.item.id);
  const waiting = polled(signaled(base(2), 'yellow').state, many(4)).state; // spec: 1, 2, 3, 4; nothing runs under yellow
  const first = started(waiting, 'board:item1');
  assert.deepEqual(ids(first.state), ['1', '2', '3', '4'], 'already on top: nothing moves');
  const last = started(first.state, 'board:item4'); // the bottom task, by hand, into the second free worker
  assert.deepEqual(ids(last.state), ['1', '4', '2', '3'], 'right below the running one, above the waiting ones, which keep their order');
  assert.deepEqual(last.effects.map((e) => e.type), ['spawn'], 'spec has no onStart: no board write, and the reorder adds no effect');
  assert.deepEqual(last.state.sourceOrder, ['board:item1', 'board:item2', 'board:item3', 'board:item4'], 'the board is never written');
  assert.equal(differsFromSource(last.state.tasks, 'spec', last.state.sourceOrder, last.state), false, 'both running tasks on top and the stopped ones still in board order: nothing to reset yet (#212)');
  assert.equal(last.state.workers.length, 2, 'a free worker was taken: nothing appended');
  assert.equal(work(last.state, 4)?.workerId, last.state.workers[1].id);
  const over = started(last.state, 'board:item3'); // no free worker: a draining worker over the cap (#116)
  assert.deepEqual(ids(over.state), ['1', '4', '3', '2'], 'a start over the cap moves the task too');
  assert.equal(over.state.workers[2]?.draining, true);
  assert.deepEqual(over.effects.map((e) => e.type), ['spawn']);
  const dragged = reduce(over.state, { type: 'moveTask', taskId: 'board:item1' }).state; // a running task dragged to the bottom (#48 allows it)
  assert.deepEqual(ids(dragged), ['4', '3', '2', '1']);
  const regrouped = started(dragged, 'board:item2');
  assert.deepEqual(ids(regrouped.state), ['4', '3', '1', '2'], 'the next start puts the running ones back on top in their order, the started one last among them');
  assert.deepEqual(regrouped.state.sourceOrder, ['board:item1', 'board:item2', 'board:item3', 'board:item4']);
});

test('a poll reorders the tasks that follow the source and leaves the dragged, running and unlisted ones where they are; the grouping a start applied survives it; nothing reaches the source (#123)', () => {
  const ids = (s: State): string[] => s.tasks.map((c) => c.item.id);
  const waiting = polled(signaled(base(2), 'yellow').state, many(4)).state; // spec: 1, 2, 3, 4; nothing runs under yellow
  const dragged = reduce(waiting, { type: 'moveTask', taskId: 'board:item4', before: 'board:item1' }).state;
  assert.deepEqual(ids(dragged), ['4', '1', '2', '3']);
  const reshuffled = polled(dragged, [listed(3), listed(2), listed(1), listed(4)]);
  assert.deepEqual(ids(reshuffled.state), ['4', '3', '2', '1'], 'the dragged task holds the worker it claimed; the three it displaced follow the board');
  assert.deepEqual(reshuffled.state.sourceOrder, ['board:item3', 'board:item2', 'board:item1', 'board:item4']);
  assert.equal(task(reshuffled.state, 4)?.pinned, true, 'a poll never drops the pin');
  assert.deepEqual(reshuffled.effects, [], 'the board is read, never written');
  const started1 = started(reshuffled.state, 'board:item1').state; // by hand from the bottom: #117 puts it on top of its stage
  assert.deepEqual(ids(started1), ['1', '4', '3', '2']);
  const again = polled(started1, [listed(3), listed(2), listed(1), listed(4)]).state;
  assert.deepEqual(ids(again), ['1', '4', '3', '2'], 'the running task and the pinned one both hold their positions: #117 survives the poll');
  const freed = reduce(again, { type: 'resetOrder', stage: 'spec' }).state;
  assert.deepEqual(ids(freed), ['1', '3', '2', '4'], 'the reset puts the running task back on top (#212) and orders the stopped ones by the board, dropping 4\'s pin too');
  assert.deepEqual(ids(polled(freed, [listed(4), listed(3), listed(2), listed(1)]).state), ['1', '4', '3', '2'], 'freed: only the running task still holds a position (index 0, #212), the other three follow the board again');
});

test('a poll takes a grouped listing as the source order: sourceOrder in that order, a task dragged before the poll keeps its worker, the reset restores the grouping and hides the button (#211)', () => {
  const ids = (s: State): string[] => s.tasks.map((c) => c.item.id);
  const waiting = polled(signaled(base(2), 'yellow').state, [listed(1), listed(3), listed(4), listed(6), listed(7)]).state; // spec; nothing runs under yellow
  const dragged = reduce(waiting, { type: 'moveTask', taskId: 'board:item4', before: 'board:item1' }).state;
  assert.deepEqual(ids(dragged), ['4', '1', '3', '6', '7']);
  // 6 and 7 became sub-issues of the (ignored) epic 2, which sits right after 1: the adapter now lists 1, 6, 7, 3, 4
  const grouped = polled(dragged, [listed(1), listed(6), listed(7), listed(3), listed(4)]);
  assert.deepEqual(grouped.state.sourceOrder, ['board:item1', 'board:item6', 'board:item7', 'board:item3', 'board:item4'], 'the listing order is the board order, grouped or not');
  assert.deepEqual(ids(grouped.state), ['4', '1', '6', '7', '3'], 'the dragged task holds its worker; the free ones follow the grouped order');
  assert.deepEqual(grouped.effects, [], 'the board is read, never written');
  const reset = reduce(grouped.state, { type: 'resetOrder', stage: 'spec' }).state;
  assert.deepEqual(ids(reset), ['1', '6', '7', '3', '4'], '"board order" restores the grouping');
  assert.equal(differsFromSource(reset.tasks, 'spec', reset.sourceOrder, reset), false, 'grouped is the default: no "board order" button');
});

test('mergeTasks is pure: an empty listing over no tasks is no tasks, and a task in an unknown stage is left alone apart from the enteredAt stamp', () => {
  const at = '2026-10-09T12:00:00.000Z';
  assert.deepEqual(mergeTasks([], STAGES, { source: 'board', items: [] }, ['board'], [], NO_RUNS, at), []);
  const stray: Task = { item: item(1), stage: 'gone', boardColumn: 'Backlog', auto: true };
  const [{ enteredAt, ...merged }] = mergeTasks([stray], STAGES, { source: 'board', items: [listed(1)] }, ['board'], ['board:item1'], NO_RUNS, at);
  assert.equal(enteredAt, at, 'a task without enteredAt gets the poll time');
  assert.deepEqual(merged, { ...stray, item: item(1) });
});

test('moveTask puts the task before another of its stage or at the end of its (non-contiguous) stage; unknown ids or another stage leave the same list, a move that changes no order still pins (#123)', () => {
  const tasks = polled(signaled(base(0), 'yellow').state, [listed(1, 'Ready'), listed(2), listed(3, 'Ready'), listed(4)]).state.tasks; // dev, spec, dev, spec
  const ids = (list: Task[]): string[] => list.map((c) => c.item.id);
  assert.deepEqual(ids(tasks), ['1', '2', '3', '4']);
  assert.deepEqual(ids(moveTask(tasks, 'board:item3', 'board:item1')), ['3', '1', '2', '4'], 'before a task of the same stage');
  assert.deepEqual(ids(moveTask(tasks, 'board:item2')), ['1', '3', '4', '2'], 'end of spec: right after 4; dev untouched');
  assert.deepEqual(ids(moveTask(tasks, 'board:item1')), ['2', '3', '1', '4'], 'end of dev: right after 3');
  assert.deepEqual(ids(moveTask(tasks, 'board:item4', 'board:item2')), ['1', '4', '2', '3']);
  assert.equal(moveTask(tasks, 'board:item9', 'board:item1'), tasks, 'unknown task');
  assert.equal(moveTask(tasks, 'board:item1', 'board:item9'), tasks, 'unknown before');
  assert.equal(moveTask(tasks, 'board:item1', 'board:item2'), tasks, 'different stages');
  assert.deepEqual(ids(moveTask(tasks, 'board:item1', 'board:item1')), ['1', '2', '3', '4'], 'itself: the order stands, the task is pinned (#123)');
  assert.deepEqual(ids(moveTask(tasks, 'board:item4')), ['1', '2', '3', '4'], 'already the last of its stage: the order stands, the task is pinned (#123)');
  assert.deepEqual(ids(moveTask(tasks, 'board:item1', 'board:item3')), ['1', '2', '3', '4'], 'already right before it: idem');
  assert.deepEqual(ids(moveTask([tasks[0]], 'board:item1')), ['1'], 'alone in its stage: nothing to move');
});

test('resetOrder sorts only the asked stage by the source order, unindexed tasks last in their relative order; differsFromSource is what shows the button', () => {
  const tasks = polled(signaled(base(0), 'yellow').state, [listed(1, 'Ready'), listed(2), listed(3, 'Ready'), listed(4), listed(5)]).state.tasks; // dev, spec, dev, spec, spec
  const ids = (list: Task[]): string[] => list.map((c) => c.item.id);
  const sourceOrder = ['board:item5', 'board:item3', 'board:item4', 'board:item1']; // the source reordered and no longer lists 2
  assert.equal(differsFromSource(tasks, 'spec', sourceOrder, NO_RUNS), true, '4 before 5 in the Hive, 5 before 4 on the board');
  assert.equal(differsFromSource(tasks, 'dev', sourceOrder, NO_RUNS), true);
  const reset = resetOrder(tasks, 'spec', sourceOrder, NO_RUNS);
  assert.deepEqual(ids(reset), ['1', '5', '3', '4', '2'], 'spec refills its own positions: 5, 4, then the unlisted 2; dev untouched');
  assert.equal(differsFromSource(reset, 'spec', sourceOrder, NO_RUNS), false);
  assert.equal(differsFromSource(reset, 'dev', sourceOrder, NO_RUNS), true, 'the other stage is not reset');
  assert.deepEqual(ids(resetOrder(reset, 'dev', sourceOrder, NO_RUNS)), ['3', '5', '1', '4', '2']);
  assert.equal(differsFromSource(tasks, 'review', sourceOrder, NO_RUNS), false, 'no task at all');
  assert.equal(differsFromSource(tasks, 'spec', [], NO_RUNS), false, 'only unindexed tasks: nothing to differ from');
  assert.equal(differsFromSource(tasks, 'spec', ['board:item4'], NO_RUNS), false, 'one indexed task is in order by definition');
  assert.deepEqual(ids(resetOrder(tasks, 'spec', [], NO_RUNS)), ['1', '2', '3', '4', '5'], 'no index at all: the relative order is kept');
  assert.deepEqual(ids(resetOrder(tasks, 'nope', sourceOrder, NO_RUNS)), ids(tasks), 'unknown stage: same content');
});

test('resetOrder puts the running tasks first, in the order they currently have, then the stopped ones by the source; a running task dragged below the stopped ones goes back to the top; differsFromSource follows that same layout (#212)', () => {
  const ids = (list: Task[]): string[] => list.map((c) => c.item.id);
  const running = filled(2, 4).state; // spec: 1 and 2 running (same stage, source order), 3 and 4 waiting
  const sourceOrder = running.sourceOrder;
  assert.deepEqual(ids(running.tasks), ['1', '2', '3', '4']);
  assert.equal(differsFromSource(running.tasks, 'spec', sourceOrder, running), false, 'running on top, stopped in board order already: no button');
  const dragged = reduce(running, { type: 'moveTask', taskId: 'board:item1' }).state; // #48: a running task may be dragged, here below the stopped ones
  assert.deepEqual(ids(dragged.tasks), ['2', '3', '4', '1']);
  assert.equal(differsFromSource(dragged.tasks, 'spec', sourceOrder, dragged), true, 'a running task (1) now sits below a stopped one');
  const reset = resetOrder(dragged.tasks, 'spec', sourceOrder, dragged);
  assert.deepEqual(ids(reset), ['2', '1', '3', '4'], 'the running ones keep their order (2 then 1) and return to the top; the stopped ones follow the board');
  assert.equal(differsFromSource(reset, 'spec', sourceOrder, dragged), false, 'back to the layout a reset gives: nothing left to offer');
});

test('moveTask moves the task and fills: the task moved to the front is the next to take a free worker; resetOrder adopts the source order of that stage and fills too; a refused move leaves the list as is', () => {
  const waiting = polled(signaled(base(1), 'yellow').state, many(3)).state; // spec: 1, 2, 3; nothing runs under yellow
  const moved = reduce(waiting, { type: 'moveTask', taskId: 'board:item3', before: 'board:item1' });
  assert.deepEqual(moved.state.tasks.map((c) => c.item.id), ['3', '1', '2']);
  assert.equal(moved.effects.length, 0, 'yellow: nothing fills, and the move itself writes nothing');
  const opened = signaled(moved.state, 'green');
  assert.equal(taskOfWorker(opened.state, opened.state.workers[0])?.item.id, '3', 'same stage: the Hive order decides');
  const running = filled(1, 3).state; // 1 runs in spec; 2 and 3 wait
  const later = reduce(running, { type: 'moveTask', taskId: 'board:item3', before: 'board:item2' });
  assert.deepEqual(later.state.tasks.map((c) => c.item.id), ['1', '3', '2']);
  assert.equal(later.effects.length, 0, 'no free worker');
  const ended = reduce(later.state, { type: 'exit', ptyId: running.workers[0].runId! }); // 1 exits and stops (#283); 3 and 2 wait in spec
  assert.deepEqual(ended.effects.map((e) => e.type), ['spawn', 'forgetScrollback']);
  assert.equal(taskOfWorker(ended.state, ended.state.workers[0])?.item.id, '3', 'the moved task takes the freed worker');
  assert.equal(reduce(waiting, { type: 'moveTask', taskId: 'board:item9' }).state.tasks, waiting.tasks, 'unknown task: the same list');
  const reset = reduce(moved.state, { type: 'resetOrder', stage: 'spec' });
  assert.deepEqual(reset.state.tasks.map((c) => c.item.id), ['1', '2', '3'], 'sourceOrder from the poll: 1, 2, 3');
  assert.equal(reset.effects.length, 0);
  assert.deepEqual(reduce(waiting, { type: 'resetOrder', stage: 'nope' }).state.tasks, waiting.tasks, 'unknown stage: same content');
});

test('done marks the occupied worker; a Stop without it leaves the worker waiting with no effects and the task in place; a prompt or a tool brings it back; boot clears it', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const { state, effects } = hook(first, id, { hook_event_name: 'Stop' });
  assert.equal(effects.length, 0, 'no kill, no write, no spawn');
  assert.equal(state.workers[0].status, 'waiting');
  assert.deepEqual(state.workers[0].lastEvent, { kind: 'turn' });
  assert.equal(state.workers[0].runId, id, 'the session stays alive');
  assert.deepEqual([task(state, 1)?.stage, work(state, 1)?.workerId], ['spec', first.workers[0].id]);
  assert.equal(hook(state, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).state.workers[0].status, 'working');
  assert.equal(hook(state, id, { hook_event_name: 'UserPromptSubmit' }).state.workers[0].status, 'working');
  const marked = done(state, id);
  assert.equal(marked.workers[0].done, true);
  assert.equal(marked.workers[0].status, 'waiting', 'done alone changes nothing else');
  assert.equal(done(marked, id).workers[0].done, true, 'idempotent');
  assert.equal(done(first, 'ghost'), first, 'unknown worker: same object');
  assert.equal(reduce(marked, { type: 'boot' }).state.workers[0].done, undefined);
  assert.equal(stopped(signaled(state, 'red').state, id).effects[0].type, 'kill', 'with done the Stop ends the stage');
});

test('Stop with done continues in place when the next stage has a prompt and session continue and the task is next in line: no kill, same worker, onFinish then onStart written, task in the next stage with its worker', () => {
  const first = filled(1, 1).state; // green: spec → dev, dev continues the session
  const id = first.workers[0].runId!;
  const { state, effects } = stopped(first, id);
  const moved = task(state, 1)!;
  assert.deepEqual(effects, [
    { type: 'setColumn', itemId: 'board:item1', column: 'Ready' },
    { type: 'setColumn', itemId: 'board:item1', column: 'In progress' },
    { type: 'continue', ptyId: id, activity: work(state, 1), task: moved, stage: chained(STAGES).stages[1] },
  ]);
  assert.deepEqual([moved.stage, moved.boardColumn, work(state, 1)?.workerId, work(state, 1)?.sessionId], ['dev', 'In progress', first.workers[0].id, work(first, 1)?.sessionId]);
  const worker = state.workers[0];
  assert.deepEqual([worker.runId, worker.status, worker.done, worker.question, ownerOf(state, worker)], [id, 'working', undefined, undefined, 'board:item1']);
  assert.deepEqual(worker.lastEvent, { kind: 'continuing' });
  assert.equal(worker.startedAt, first.workers[0].startedAt, 'the same run goes on');
  assert.equal(hook(state, id, { hook_event_name: 'Stop' }).effects.length, 0, 'done was cleared: the next Stop waits for a new done');
  const again = stopped(state, id); // dev is the last stage with a prompt: the task parks in review, the session dies
  assert.deepEqual(again.effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: id }, { type: 'setColumn', itemId: 'board:item1', column: 'In review' }]);
  assert.deepEqual([task(again.state, 1)?.stage, work(again.state, 1)?.workerId, again.state.workers[0].status], ['review', undefined, 'empty']);
});

test('the #793 sequence: a poll that still shows a column from before the Hive\'s own write leaves the task in its new stage; the poll that shows the written column clears the mark (#889)', () => {
  const first = filled(1, 1).state; // green: spec → dev in place
  const id = first.workers[0].runId!;
  const { state, effects } = stopped(stopped(first, id).state, id); // dev's onFinish writes In review, the task parks in review
  assert.deepEqual(effects.filter((e) => e.type === 'setColumn'), [{ type: 'setColumn', itemId: 'board:item1', column: 'In review' }]);
  assert.equal(task(state, 1)?.columnWrite?.column, 'In review');
  const stale = polled(state, [listed(1, 'Ready')]).state; // Ready is dev's door: a read from before the write landed
  assert.deepEqual([task(stale, 1)?.stage, task(stale, 1)?.boardColumn, task(stale, 1)?.columnWrite?.column], ['review', 'In review', 'In review']);
  const confirmed = polled(stale, [listed(1, 'In review')]).state;
  assert.deepEqual([task(confirmed, 1)?.stage, task(confirmed, 1)?.columnWrite], ['review', undefined]);
});

test('Stop with done kills and respawns instead when a task in a later stage waits, when the next stage is new, under red, or on a draining worker (#316)', () => {
  const SHIP: LegacyStage = { name: 'ship', from: { board: ['Ship'] }, prompt: '/ship {url}' }; // after dev in the stages array
  const specRun = polled(base(1, [...STAGES, SHIP]), [listed(1)]).state; // 1 runs in spec
  const two = polled(specRun, [listed(1), listed(2, 'Ship')]).state; // 2 waits in ship, a later stage than dev, where 1 goes next
  const later = stopped(two, two.workers[0].runId!);
  assert.deepEqual(later.effects.map((e) => e.type), ['kill', 'setColumn', 'spawn', 'forgetScrollback']);
  assert.ok(later.effects[2].type === 'spawn' && later.effects[2].task.item.id === '2', 'the task in the later stage takes the worker');
  assert.deepEqual([task(later.state, 1)?.stage, work(later.state, 1)?.workerId], ['dev', undefined]);
  const fresh: LegacyStage[] = [STAGES[0], { ...STAGES[1], session: 'new' }, STAGES[2]];
  const one = polled(base(1, fresh), many(1)).state;
  const renewed = stopped(one, one.workers[0].runId!);
  assert.deepEqual(renewed.effects.map((e) => e.type), ['kill', 'setColumn', 'setColumn', 'spawn', 'forgetScrollback'], 'same task, new session: kill then spawn in the same batch');
  assert.ok(renewed.effects[3].type === 'spawn' && renewed.effects[3].task.item.id === '1' && renewed.effects[3].session === 'new');
  assert.notEqual(renewed.state.workers[0].runId, one.workers[0].runId);
  const single = filled(1, 1).state;
  const red = stopped(signaled(single, 'red').state, single.workers[0].runId!);
  assert.deepEqual(red.effects.map((e) => e.type), ['kill', 'setColumn', 'forgetScrollback']);
  assert.deepEqual([task(red.state, 1)?.stage, work(red.state, 1)?.workerId, red.state.workers[0].status], ['dev', undefined, 'empty']);
  assert.equal(work(red.state, 1)?.sessionId, work(single, 1)?.sessionId, 'waits for a worker and resumes later');
  const drained = reduce(filled(2, 2).state, { type: 'setMax', max: 1 }).state; // worker 2 draining
  const gone = stopped(drained, drained.workers[1].runId!);
  assert.deepEqual(gone.effects.map((e) => e.type), ['kill', 'setColumn', 'forgetScrollback']);
  assert.equal(gone.state.workers.length, 1, 'the draining worker leaves');
  assert.deepEqual([task(gone.state, 2)?.stage, work(gone.state, 2)?.workerId], ['dev', undefined]);
});

test('Stop with done continues in place under yellow (manual or dynamic) without starting anything new; red, an exhausted budget or a full cap kill it (#85)', () => {
  const two = polled(signaled(base(2), 'yellow').state, [listed(1), listed(2, 'Ready')]).state; // yellow: 1 in spec, 2 in dev, nothing starts
  const manual = started(two, 'board:item1').state; // the human override runs 1 in spec
  const id = manual.workers[0].runId!;
  const yellow = stopped(manual, id);
  assert.deepEqual(yellow.effects.map((e) => e.type), ['setColumn', 'setColumn', 'continue'], 'no kill, and no spawn for the task waiting in dev');
  const worker = yellow.state.workers[0];
  assert.deepEqual([worker.runId, worker.status, worker.lastEvent], [id, 'working', { kind: 'continuing' }]);
  assert.deepEqual([task(yellow.state, 1)?.stage, work(yellow.state, 1)?.workerId], ['dev', worker.id]);
  assert.equal(work(yellow.state, 2)?.workerId, undefined, 'yellow still starts no new task');
  assert.equal(yellow.state.workers[1].status, 'empty');
  const red = stopped(signaled(manual, 'red').state, id);
  assert.deepEqual(red.effects.map((e) => e.type), ['kill', 'setColumn', 'forgetScrollback']);
  assert.deepEqual([task(red.state, 1)?.stage, work(red.state, 1)?.workerId, work(red.state, 1)?.sessionId], ['dev', undefined, work(manual, 1)?.sessionId]);
  const first = filled(1, 1).state;
  const one = first.workers[0].runId!;
  const dynamicYellow = counted(ruled({ ...first, usage: [] }, 0), one, 850); // 85% in one turn: dynamic yellow, cap 1 with the worker freed
  assert.deepEqual([dynamicYellow.workers[0].runId, dynamicYellow.workers[0].status, task(dynamicYellow, 1)?.stage], [one, 'working', 'dev']);
  const dynamicRed = counted(ruled({ ...first, usage: [] }, 0), one, 950); // 95%: dynamic red
  assert.deepEqual([dynamicRed.workers[0].status, work(dynamicRed, 1)?.workerId], ['empty', undefined]);
  const broke = stopped({ ...signaled(first, 'yellow').state, budget: { maxTokensPerHour: 1000 }, usage: [{ at: new Date().toISOString(), tokens: 1000 }] }, one);
  assert.deepEqual(broke.effects.map((e) => e.type), ['kill', 'setColumn', 'forgetScrollback'], 'the budget still blocks the continuation');
  const capped = stopped({ ...first, budget: { maxTokensPerHour: 1000 }, usageRules: [{ source: 'hour', percent: 50, maxWorkers: 0 }], usage: [{ at: new Date().toISOString(), tokens: 600 }] }, one);
  assert.deepEqual(capped.effects.map((e) => e.type), ['kill', 'setColumn', 'forgetScrollback'], 'a cap with no room still blocks the continuation');
});

test('under yellow fill resumes a started task, with the budget, cap and room of green; a new task waits for green (#224, #727)', () => {
  const two = filled(2, 3).state; // green: 1 and 2 run in spec (started), 3 waits and was never started
  const parked = parkedStarted(signaled(two, 'red').state, two.workers[1].runId!); // red: nothing refills the worker
  assert.deepEqual([work(parked, 2) !== undefined, work(parked, 2)?.workerId, work(parked, 3) !== undefined], [true, undefined, false]);
  const yellow = signaled(parked, 'yellow');
  assert.deepEqual(yellow.effects.map((e) => e.type), ['spawn']);
  assert.equal(ownerAt(yellow.state, 1), 'board:item2', 'started: resumed under yellow');
  const fresh: State = { ...parked, activities: parked.activities.filter((a) => a.id !== work(parked, 2)?.id) }; // #727: no activity, a new task
  assert.deepEqual(signaled(fresh, 'yellow').effects, [], 'nothing started: yellow starts no task');
  assert.deepEqual(signaled(fresh, 'green').effects.map((e) => e.type), ['spawn'], 'green takes any candidate');
  assert.deepEqual(signaled(ruled(parked, 550), 'yellow').effects, [], '55%: cap 1 with one running, no room, as under green');
  const broke: State = { ...parked, budget: { maxTokensPerHour: 1000 }, usage: [{ at: new Date().toISOString(), tokens: 1000 }] };
  assert.deepEqual(signaled(broke, 'yellow').effects, [], 'no budget: nothing');
});

// #224's case: max 3 under a usage cap of 2 (60% of the hour), yellow. Task 2 (B) runs in spec in worker 0 and task 3 in dev in worker 2; task
// 1 (A), ahead of both in dev, was started and stopped (the red exit stands in for the cap), so it is started and the cap holds it back.
const CAP_2: UsageRule[] = [{ source: 'hour', percent: 50, maxWorkers: 2 }];
function startedAhead(): State {
  const listedAll = polled(signaled(base(3), 'yellow').state, [listed(1, 'Ready'), listed(2), listed(3, 'Ready')]).state; // yellow: nothing starts
  const three = signaled(started(listedAll, 'board:item2').state, 'green').state; // 2 (B) in spec in worker 0, then 1 and 3 (dev) by source order
  const parked = parkedStarted(signaled(three, 'red').state, three.workers[1].runId!);
  const capped: State = { ...parked, budget: { maxTokensPerHour: 1000 }, usageRules: CAP_2, usage: [{ at: new Date().toISOString(), tokens: 600 }] };
  return signaled(capped, 'yellow').state;
}

test('yellow, cap 2: when B finishes its stage while A, started and ahead of it in the next stage, waits on the cap, B is killed and A takes the worker in the same dispatch (#224)', () => {
  const issue = startedAhead();
  assert.deepEqual(owners(issue), ['board:item2', undefined, 'board:item3'], 'two running = the cap: A waits');
  assert.deepEqual([task(issue, 1)?.stage, work(issue, 1) !== undefined], ['dev', true]);
  const finished = stopped(issue, issue.workers[0].runId!);
  assert.deepEqual(finished.effects.map((e) => e.type), ['kill', 'setColumn', 'spawn', 'forgetScrollback']);
  const spawn = finished.effects[2];
  assert.ok(spawn.type === 'spawn' && spawn.task.item.id === '1' && spawn.session === 'continue', 'A resumes its dev session');
  assert.equal(ownerAt(finished.state, 0), 'board:item1', 'in the worker B left: it is not left empty');
  assert.equal(occupied(finished.state).length, 2, 'the cap holds');
  assert.deepEqual([task(finished.state, 2)?.stage, work(finished.state, 2)?.workerId, work(finished.state, 2) !== undefined], ['dev', undefined, true], 'B waits, started, for the next room');
});

test('yellow: a new task ahead could not start anyway, so the finishing worker continues in place (#224, #727)', () => {
  const issue = startedAhead();
  const ahead: State = { ...issue, activities: issue.activities.filter((a) => a.id !== work(issue, 1)?.id) }; // #727: no activity, new
  const id = ahead.workers[0].runId!;
  const finished = stopped(ahead, id);
  assert.deepEqual(finished.effects.map((e) => e.type), ['setColumn', 'setColumn', 'continue'], 'no kill: the worker is not given up for a task yellow holds back');
  assert.deepEqual([finished.state.workers[0].runId, ownerAt(finished.state, 0)], [id, 'board:item2']);
  assert.deepEqual([work(finished.state, 1)?.workerId, task(finished.state, 2)?.stage], [undefined, 'dev']);
});

test('red: a started task is never started and a finishing worker never continues (#224)', () => {
  const issue = startedAhead();
  const red = signaled(issue, 'red');
  assert.deepEqual(red.effects, []);
  const finished = stopped(red.state, issue.workers[0].runId!);
  assert.deepEqual(finished.effects.map((e) => e.type), ['kill', 'setColumn', 'forgetScrollback']);
  assert.equal(work(finished.state, 1)?.workerId, undefined, 'A stays stopped');
  assert.equal(occupied(finished.state).length, 1);
});

test('spawnFailed frees the worker, keeps the task in its stage with the error and sets the bar; fill skips it, another task may take the worker; start clears it and runs; the activity\'s error carries SPAWN_FAILED, the bar the raw message (#945)', () => {
  const two = filled(1, 2).state; // 1 runs, 2 waits
  const { state, effects } = reduce(two, { type: 'spawnFailed', ptyId: two.workers[0].runId!, message: 'pty: posix_spawnp failed.' });
  assert.equal(work(state, 1)?.error, `${SPAWN_FAILED}pty: posix_spawnp failed.`);
  assert.deepEqual([task(state, 1)?.stage, work(state, 1)?.workerId], ['spec', undefined]);
  assert.equal(state.error, 'pty: posix_spawnp failed.');
  assert.equal(ownerAt(state, 0), 'board:item2', 'the freed worker goes to the next task, never back to the failed one');
  assert.deepEqual(effects.map((e) => e.type), ['spawn', 'forgetScrollback']);
  assert.deepEqual(cands(state), [], 'a task with an error is never picked');
  assert.equal(reduce(two, { type: 'spawnFailed', ptyId: 'ghost', message: 'x' }).state, two, 'unknown worker: same object');
  const single = filled(1, 1).state;
  const failed = reduce(single, { type: 'spawnFailed', ptyId: single.workers[0].runId!, message: 'pty: posix_spawnp failed.' });
  assert.deepEqual(failed.effects.map((e) => e.type), ['forgetScrollback'], 'no retry');
  assert.equal(failed.state.workers[0].status, 'empty');
  assert.equal(polled(failed.state, many(1)).effects.length, 0, 'a poll does not retry either');
  assert.equal(work(polled(failed.state, many(1)).state, 1)?.error, `${SPAWN_FAILED}pty: posix_spawnp failed.`, 'the error survives the poll');
  const retried = started(failed.state, 'board:item1');
  assert.equal(work(retried.state, 1)?.error, undefined, 'start clears it');
  assert.deepEqual(retried.effects.map((e) => e.type), ['spawn']);
  assert.deepEqual(retried.state.workers[0].lastEvent, { kind: 'manualStart' });
});

test('setupStarted puts the setup on the task with its console id and drops its last failure, setupStep names the running step, setupEnded drops it and, with an error, keeps that on the task; none of them has effects (#351)', () => {
  const idle = polled(signaled(base(1), 'red').state, many(1)).state; // a task in spec with no worker: red fills nothing
  const earlier = 'setup failed at line 1 (COPY .env): not found in hive';
  const opened = born(idle, 1); // #629: the open makes the activity first, and the last failure is on it
  const failedBefore: State = withActivity(opened, { ...work(opened, 1)!, error: earlier });
  const id = ACT(failedBefore, 1);
  const began = reduce(failedBefore, { type: 'setupStarted', activityId: id, consoleId: 'setup:board:item1' });
  assert.deepEqual([work(began.state, 1)?.setup, work(began.state, 1)?.error, began.effects], [{ consoleId: 'setup:board:item1' }, undefined, []]);
  const stepped = reduce(began.state, { type: 'setupStep', activityId: id, step: 'RUN pnpm install' }).state;
  assert.deepEqual(work(stepped, 1)?.setup, { consoleId: 'setup:board:item1', step: 'RUN pnpm install' });
  assert.equal(reduce(failedBefore, { type: 'setupStep', activityId: id, step: 'COPY .env' }).state, failedBefore, 'no setup on the activity: same object');
  assert.equal(reduce(idle, { type: 'setupStarted', activityId: 'ghost', consoleId: 'setup:ghost' }).state, idle, 'unknown activity: same object');
  const ended = reduce(stepped, { type: 'setupEnded', activityId: id });
  assert.deepEqual([work(ended.state, 1)?.setup, work(ended.state, 1)?.error, ended.effects], [undefined, undefined, []]);
  const message = 'setup failed at line 1 (RUN pnpm install): exit 1\nERR_PNPM_NO_LOCKFILE';
  const failed = reduce(stepped, { type: 'setupEnded', activityId: id, error: message }).state;
  assert.deepEqual([work(failed, 1)?.setup, work(failed, 1)?.error, failed.error], [undefined, message, undefined], 'the /open path\'s failure lands on the task, not the bar');
  const running = filled(1, 1).state;
  const spawnFailed = reduce(running, { type: 'spawnFailed', ptyId: running.workers[0].runId!, message }).state;
  assert.deepEqual([spawnFailed.workers[0].status, work(spawnFailed, 1)?.error, spawnFailed.error], ['empty', SPAWN_FAILED + message, message], 'the spawn path\'s failure, marked as a start\'s (#945)');
});

test('a task whose setup runs is no candidate, takes no Start, Continue, Restart or session, and a boot drops the setup (#351)', () => {
  const idle = polled(signaled(base(1), 'red').state, many(1)).state;
  const opened = born(idle, 1); // #629: the open makes the activity first
  const setting = reduce(opened, { type: 'setupStarted', activityId: ACT(opened, 1), consoleId: 'setup:board:item1' }).state;
  const opening = task(setting, 1)!;
  assert.deepEqual(cands(setting), []);
  assert.deepEqual(signaled(setting, 'green').effects, [], 'green hands it no worker');
  assert.equal(started(setting, 'board:item1').state, setting, 'a Start: same object');
  assert.deepEqual([startMode(opening, setting), canOpenSession(opening, work(setting, 1))], ['none', false]);
  const booted = reduce(setting, { type: 'boot' }).state;
  assert.equal(work(booted, 1)?.setup, undefined, 'a setup never survives a boot');
  assert.deepEqual(cands(booted).map((c) => c.item.itemId), ['board:item1']);
});

test('a poll finds a stopped task whose delete activity stage is due and emits the deleteActivity effect, after onStart when it differs; not yet due, or no after, as the stage says', () => {
  const entered = polled(base(1, DELETE_STAGES), [listed(1, 'Done')]);
  assert.deepEqual([task(entered.state, 1)?.stage, entered.effects], ['done', []], 'just entered: 5d to go');
  const due = polled(withWorktree(aged(entered.state, 'board:item1', 6 * DAY_MS)), [listed(1, 'Done')]);
  assert.deepEqual(due.effects, [deletion(due.state, 1)]);
  assert.deepEqual([task(due.state, 1)?.stage, work(due.state, 1)?.workerId, due.state.workers[0].status], ['done', undefined, 'empty'], 'the task sits until the answer; no worker is taken');
  assert.equal(work(due.state, 1)?.deleting, true, 'marked in flight until the answer');
  assert.equal(polled(due.state, [listed(1, 'Done')]).effects.length, 0, 'no answer yet: a poll overlapping a slow remove does not ask twice');
  assert.equal(reduce(due.state, { type: 'setStages', ...chained(DELETE_STAGES) }).effects.length, 0, 'nor does an edit of the stages');
  assert.equal(started(due.state, 'board:item1').state, due.state, 'nor a second start: same object');
  assert.deepEqual(cands(due.state, [DELETE_STAGES[0], { ...DELETE_STAGES[1], action: undefined, prompt: '/x' }]), [], 'a deleting task is never spawned, even if its stage turns into a prompt stage mid-flight');
  const rebooted = reduce(due.state, { type: 'boot' }).state;
  assert.equal('deleting' in (work(rebooted, 1) ?? {}), false, 'the answer never arrives after a restart: boot drops the mark');
  assert.deepEqual(polled(rebooted, [listed(1, 'Done')]).effects.map((e) => e.type), ['deleteActivity'], 'and the next poll asks again');
  const withStart: LegacyStage[] = [DELETE_STAGES[0], { ...DELETE_STAGES[1], onStart: { board: [move('Cleaning')] } }, DELETE_STAGES[2]];
  const written = polled(withWorktree(aged(polled(base(1, withStart), [listed(1, 'Done')]).state, 'board:item1', 6 * DAY_MS)), [listed(1, 'Done')]);
  assert.deepEqual(written.effects.map((e) => e.type), ['setColumn', 'deleteActivity']);
  assert.deepEqual(written.effects[0], { type: 'setColumn', itemId: 'board:item1', column: 'Cleaning' });
  assert.equal(task(written.state, 1)?.boardColumn, 'Cleaning', 'the Hive remembers what it wrote, as occupy does');
  const atOnce = polled(parkedIn([DELETE_STAGES[0], { ...DELETE_STAGES[1], after: undefined }]), [listed(1, 'Done')]);
  assert.deepEqual(atOnce.effects.map((e) => e.type), ['deleteActivity'], 'no after: the next poll cleans it');
  assert.equal(polled(signaled(base(1), 'red').state, [listed(1, 'Done')]).effects.length, 0, 'no delete activity stage in STAGES: Done is not even a door');
  assert.deepEqual(signaled(parkedIn([DELETE_STAGES[0], { ...DELETE_STAGES[1], after: undefined }]), 'red').effects.map((e) => e.type), ['deleteActivity'], 'red means no new workers, not no housekeeping: its default workerless row acts at the switch (#727)');
});

test('cleaned writes onFinish, moves the task to the next stage with a fresh enteredAt and no worktree, branch or session id (#208), drops it after the last stage, and fills; unknown, running or not in a delete activity stage: ignored', () => {
  const first = polled(base(1, DELETE_STAGES), [listed(1, 'Done')]).state;
  const withGit: State = withMade(withLive({
    ...first,
    tasks: [{ ...task(first, 1)!, enteredAt: '2026-09-01T00:00:00.000Z' }],
  }, 1, { worktree: '/repo/.claude/worktrees/hive-1-task-1', branch: 'hive-1-task-1', deleting: true, sessionId: 'kept-session-id-0001' }), 1, { sessions: [keptSession('kept-session-id-0001')], prs: [{ url: 'https://github.com/o/r/pull/1', state: 'merged' }] });
  const { state, effects } = reduce(withGit, { type: 'activityDeleted', activityId: ACT(withGit, 1) });
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:item1', column: 'Archived' }]);
  const moved = task(state, 1)!;
  assert.deepEqual([moved.stage, moved.boardColumn, work(state, 1)?.sessionId, prsN(state, 1)], ['archive', 'Archived', undefined, [{ url: 'https://github.com/o/r/pull/1', state: 'merged' }]]);
  assert.deepEqual(sessionsN(state, 1).map((s) => [s.id, s.repo]), [['kept-session-id-0001', true]], 'the session moves to the main repo (#208)');
  assert.deepEqual([work(state, 1), 'sessionId' in moved], [undefined, false], 'the activity goes with its worktree, branch, mark and session id; nothing is left on the task (#629)');
  assert.ok(Date.parse(moved.enteredAt!) > Date.parse('2026-09-01T00:00:00.000Z'), 'a fresh enteredAt: archive\'s own after would count from now');
  const last = polled(withWorktree(aged(polled(base(1, [DELETE_STAGES[0], DELETE_STAGES[1]]), [listed(1, 'Done')]).state, 'board:item1', 6 * DAY_MS)), [listed(1, 'Done')]).state;
  const gone = reduce(last, { type: 'activityDeleted', activityId: ACT(last, 1) });
  assert.deepEqual([gone.state.tasks, gone.effects], [[], [{ type: 'setColumn', itemId: 'board:item1', column: 'Archived' }]], 'last stage: the task leaves the Hive');
  const rerun: LegacyStage[] = [{ name: 'done', from: { board: ['Done'] }, onFinish: { board: [move('Ready')] }, action: 'deleteActivity' }, STAGES[1]];
  const again = polled(parkedIn(rerun), [listed(1, 'Done')]);
  assert.deepEqual(again.effects.map((e) => e.type), ['deleteActivity']);
  const back = reduce(again.state, { type: 'activityDeleted', activityId: ACT(again.state, 1) });
  assert.deepEqual(back.effects.map((e) => e.type), ['setColumn', 'setColumn', 'spawn'], 'onFinish, then dev\'s onStart and the spawn: fill runs after the move');
  assert.equal(ownerAt(back.state, 0), 'board:item1');
  assert.equal(reduce(withGit, { type: 'activityDeleted', activityId: 'nope' }).state, withGit, 'unknown: same object');
  const running = polled(base(1), [listed(1, 'Ready')]).state;
  assert.equal(reduce(running, { type: 'activityDeleted', activityId: ACT(running, 1) }).state, running, 'running: ignored');
  assert.equal(reduce(state, { type: 'activityDeleted', activityId: ACT(state, 1) }).state, state, 'already moved to archive (a second answer): ignored');
  const stale = polled(base(1, DELETE_STAGES), [listed(1, 'Done')]).state; // in the stage, not yet due: nothing was emitted
  assert.equal(reduce(stale, { type: 'activityDeleted', activityId: ACT(stale, 1) }).state, stale, 'no delete activity in flight: ignored');
});

test('deleteActivityFailed puts git\'s words on the task and on the bar; a poll does not retry; start clears it and runs the delete activity at once, whatever after says; start on a prompt stage ignores after too', () => {
  const entered = polled(base(1, DELETE_STAGES), [listed(1, 'Done')]).state;
  const due = polled(withWorktree(aged(entered, 'board:item1', 6 * DAY_MS)), [listed(1, 'Done')]).state; // the delete activity is in flight
  const message = "error: The branch 'hive-1-task-1' is not fully merged.";
  const { state, effects } = reduce(due, { type: 'deleteActivityFailed', activityId: ACT(due, 1), message });
  assert.equal(effects.length, 0);
  assert.equal(work(state, 1)?.error, message);
  assert.equal('deleting' in (work(state, 1) ?? {}), false, 'the mark goes with the answer');
  assert.equal(state.error, message);
  assert.equal(polled(aged(state, 'board:item1', 6 * DAY_MS), [listed(1, 'Done')]).effects.length, 0, 'due but errored: no retry, it would fail the same way');
  assert.equal(work(polled(aged(state, 'board:item1', 6 * DAY_MS), [listed(1, 'Done')]).state, 1)?.error, message, 'the error survives the poll');
  assert.equal(reduce(due, { type: 'deleteActivityFailed', activityId: 'nope', message }).state, due, 'unknown task: same object');
  assert.equal(reduce(entered, { type: 'deleteActivityFailed', activityId: ACT(entered, 1), message }).state, entered, 'no delete activity in flight (a stale answer): same object');
  const retried = started(state, 'board:item1'); // 5d away and no free worker needed
  assert.deepEqual(retried.effects, [deletion(retried.state, 1)]);
  assert.equal(work(retried.state, 1)?.error, undefined, 'start clears it');
  assert.equal(retried.state.workers[0].status, 'empty', 'no worker taken');
  assert.deepEqual([retried.state.maxConcurrent, retried.state.workers.length], [1, 1], 'no worker involved: nothing appended, the cap untouched');
  assert.deepEqual(started(withWorktree(entered), 'board:item1').effects.map((e) => e.type), ['deleteActivity'], 'no error to clear: still at once');
  const blocked = polled(base(1, DELETE_STAGES), [{ item: { ...item(1), blockedBy: ['9'] }, column: 'Done' }]).state;
  assert.deepEqual(started(withWorktree(blocked), 'board:item1').effects.map((e) => e.type), ['deleteActivity'], 'blockers are about starting work');
  const delayed: LegacyStage[] = [{ ...STAGES[1], after: '12h' }];
  const waiting = polled(base(1, delayed), [listed(1, 'Ready')]);
  assert.equal(waiting.effects.length, 0, 'not due: fill skips it');
  assert.deepEqual(started(waiting.state, 'board:item1').effects.map((e) => e.type), ['setColumn', 'spawn'], 'the button means now');
});

test('setStages: a stopped task in a stage turned into delete activity is cleaned on that dispatch; a running one is left alone, and its Stop moves it on into the next delete activity stage and cleans it there at once (#284)', () => {
  const two = withWorktree(withWorktree(signaled(polled(base(1), [listed(1, 'Ready'), listed(2, 'Ready')]).state, 'yellow').state, 2), 1); // 1 runs in dev, 2 waits in dev; both have something to clean
  const turned: LegacyStage[] = [
    { name: 'dev', from: { board: ['Ready'] }, onFinish: { board: [move('In review')] }, action: 'deleteActivity' },
    { name: 'review', from: { board: ['In review'] }, action: 'deleteActivity' },
  ];
  const { state, effects } = reduce(two, { type: 'setStages', ...chained(turned) });
  assert.deepEqual(effects, [deletion(state, 2)], 'the stopped one at once; the running one waits for its Stop');
  assert.equal(work(state, 1)?.workerId, state.workers[0].id);
  const finished = stopped(state, state.workers[0].runId!);
  assert.deepEqual(finished.effects.map((e) => e.type), ['captureCheckpoint', 'kill', 'setColumn', 'deleteActivity', 'forgetScrollback'], 'the Stop ends the stage as before (the checkpoint first, #619; onFinish, next stage, no delete activity of dev), then review, with no after, cleans it in the same reduction');
  assert.deepEqual(finished.effects[3], deletion(finished.state, 1));
  assert.deepEqual([task(finished.state, 1)?.stage, work(finished.state, 1)?.deleting], ['review', true], 'no poll needed');
});

// Task 1 running dev with its worktree (something to clean, #236), in dev → done → archive, done as `done` makes it: its Stop moves it into done (#284)
function devBeforeDone(done: Partial<Stage>): { state: State; id: string } {
  const first = polled(base(1, [DELETE_STAGES[0], { ...DELETE_STAGES[1], ...done }, DELETE_STAGES[2]]), [listed(1, 'Ready')]).state;
  const id = first.workers[0].runId!;
  return { state: hook(first, id, { hook_event_name: 'SessionStart', cwd: WORKTREE }).state, id };
}

test('a Stop that finishes a task into a delete activity stage with no after starts its delete activity in the same reduction: kill, onFinish, onStart, delete activity, and the task is marked deleting (#284)', () => {
  const { state: running, id } = devBeforeDone({ after: undefined, onStart: { board: [move('Cleaning')] } });
  const { state, effects } = stopped(running, id);
  assert.deepEqual(effects.map((e) => e.type), ['captureCheckpoint', 'kill', 'setColumn', 'setColumn', 'deleteActivity']);
  assert.deepEqual(effects[1], { type: 'kill', slug: 'hive-1-task-1', ptyId: id }, 'right after the checkpoint (#619): the server awaits it, so the delete\'s git only runs once the session is gone');
  assert.deepEqual(effects.slice(2, 4), [{ type: 'setColumn', itemId: 'board:item1', column: 'In review' }, { type: 'setColumn', itemId: 'board:item1', column: 'Cleaning' }], 'dev\'s onFinish, then done\'s onStart against the board as just written');
  assert.deepEqual(effects[4], deletion(state, 1));
  assert.deepEqual([task(state, 1)?.stage, task(state, 1)?.boardColumn, work(state, 1)?.deleting, work(state, 1)?.worktree], ['done', 'Cleaning', true, WORKTREE]);
  assert.equal(state.workers[0].status, 'empty', 'a delete activity takes no worker');
});

test('a Stop into a delete activity stage whose after has not passed only writes onFinish; the poll past the after cleans it, as before (#284)', () => {
  const { state: running, id } = devBeforeDone({}); // done keeps its after: 5d
  const { state, effects } = stopped(running, id);
  assert.deepEqual(effects.map((e) => e.type), ['captureCheckpoint', 'kill', 'setColumn'], 'just entered: 5d to go');
  assert.deepEqual([task(state, 1)?.stage, 'deleting' in (work(state, 1) ?? {})], ['done', false]);
  const due = polled(aged(state, 'board:item1', 6 * DAY_MS), [listed(1, 'In review')]);
  assert.deepEqual(due.effects, [deletion(due.state, 1)]);
});

test('a task cleaned on its finish is not left missing with a worktree when the stage took the item off the source: the next poll finds it already cleaned (#212, #284)', () => {
  const { state: running, id } = devBeforeDone({ after: undefined });
  const finished = stopped(running, id).state;
  const answered = reduce(finished, { type: 'activityDeleted', activityId: ACT(finished, 1) }).state; // the server reduces git's answer inside the Stop's own batch
  const after = polled(answered, []).state; // Done merged the PR: the source lists the item no more
  const left = task(after, 1)!;
  const { id: _id, ...fresh } = work(after, 1)!;
  // #629: the activity went; a fresh one carries no worktree: nothing left behind on disk
  assert.deepEqual([left.stage, left.missing, work(after, 1)?.id === work(finished, 1)?.id, fresh], ['archive', true, false, { kind: 'task', workspace: 'hive', slug: 'hive-1-task-1', via: transitionKey({ from: 'done', when: 'done' }) }], 'missing, but nothing left behind on disk; #134: the arrow it came through stays');
});

test('a finish runs every due delete activity, not only the task that moved: another task already due in the stage is cleaned in the same reduction, in source order (#284)', () => {
  const { state: running, id } = devBeforeDone({ after: undefined });
  // 2 sits in done, due and not yet cleaned: as a boot leaves a task whose delete activity never answered, before the next poll
  const waiting: Task = { item: item(2), stage: 'done', boardColumn: 'Done', auto: true };
  const { state, effects } = stopped(withLive({ ...running, tasks: [...running.tasks, waiting] }, 2, { worktree: '/tmp/worktrees/hive-2-task-2' }), id);
  assert.deepEqual(effects.map((e) => e.type), ['captureCheckpoint', 'kill', 'setColumn', 'deleteActivity', 'deleteActivity']);
  assert.deepEqual(effects.flatMap((e) => (e.type === 'deleteActivity' ? [e.task.item.id] : [])), ['1', '2']);
  assert.deepEqual([work(state, 1)?.deleting, work(state, 2)?.deleting], [true, true]);
});

const TIDY: LegacyStage = { name: 'tidy', from: { board: ['Tidy'] }, onFinish: { board: [move('Tidied')] }, action: 'deleteActivity' };

test('cleaned into a second delete activity stage moves the task on through it in the same reduction, and a poll chains delete activity stages the same way: nothing is left to clean under the global scope (#284)', () => {
  const stages: LegacyStage[] = [DELETE_STAGES[0], { ...DELETE_STAGES[1], after: undefined }, TIDY, DELETE_STAGES[2]];
  const deleting = polled(parkedIn(stages), [listed(1, 'Done')]).state; // done, no after: the poll starts the delete activity
  const { state, effects } = reduce(deleting, { type: 'activityDeleted', activityId: ACT(deleting, 1) });
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:item1', column: 'Archived' }, { type: 'setColumn', itemId: 'board:item1', column: 'Tidied' }], 'done\'s onFinish, then tidy\'s: no poll in between');
  assert.deepEqual([task(state, 1)?.stage, task(state, 1)?.boardColumn, 'deleting' in (work(state, 1) ?? {})], ['archive', 'Tidied', false]);
  const entered = polled(base(1, stages), [listed(1, 'Done')]); // never ran: nothing to delete in done nor in tidy
  assert.deepEqual([entered.effects.map((e) => e.type), task(entered.state, 1)?.stage], [['setColumn', 'setColumn'], 'archive'], 'one poll, both stages');
});

test('canOpenSession: any task on the source not being deleted, set up or leaving it, running, manual, stopped or blocked alike (#283, #351, #491)', () => {
  const ok: Task = { item: item(1), stage: 'spec', boardColumn: 'Backlog', auto: true };
  const live: Activity = { id: 'a1', kind: 'task', workspace: 'hive', slug: 'hive-1-task-1' }; // #629: the deleting and setup marks are the activity's
  assert.equal(canOpenSession(ok, undefined), true);
  assert.equal(canOpenSession(ok, live), true);
  assert.equal(canOpenSession({ ...ok, auto: false }, { ...live, workerId: 's1', stopped: true }), true); // #629: the run fields are the activity's
  assert.equal(canOpenSession({ ...ok, item: { ...item(1), blockedBy: ['9'] } }, live), true, 'a blocker holds the stage run, not what the user opens (#491)');
  const refused: [Task, Activity, string][] = [
    [{ ...ok, missing: true }, live, 'missing'], [ok, { ...live, deleting: true }, 'deleting'], [{ ...ok, leaving: true }, live, 'leaving'], [ok, { ...live, setup: { consoleId: 'C1' } }, 'setting up'],
  ];
  for (const [c, a, why] of refused) assert.equal(canOpenSession(c, a), false, why);
});

test('a delete activity stage skips a task a manual Claude session holds, and cleans the same task when no worker holds it (#208)', () => {
  const parked = parkedIn([DELETE_STAGES[0], { ...DELETE_STAGES[1], after: undefined }, DELETE_STAGES[2]]); // done, no after: due on the next poll; #629: its activity holds the worktree
  const session: Worker = { id: parked.workers[0].id, status: 'working', runId: 'aaaaaaaa-0000-4000-8000-000000000001', activityId: work(parked, 1)!.id, sessionId: 'kept-session-id-0001', freeSession: true };
  assert.deepEqual(polled({ ...parked, workers: [session] }, [listed(1, 'Done')]).effects, [], 'git never runs with a session inside the worktree');
  assert.deepEqual(polled(parked, [listed(1, 'Done')]).effects.map((e) => e.type), ['deleteActivity']);
});

test('canDeleteActivity needs something to clean, no worker (a manual session counts, #164) and not deleting; a missing task qualifies (#182, #236)', () => {
  const ok: Task = { item: item(1), stage: 'spec', boardColumn: 'Backlog', auto: false };
  const WT: Partial<Activity> = { worktree: '/wt/a' };
  // #629: what the workers point at; task 1's activity holds the worktree and the mark
  const at = (workers: Worker[], live: Partial<Activity> = WT): Pick<State, 'workers' | 'terminals' | 'stages' | 'deleteActivity' | 'activities' | 'activityRecords'> => {
    const { activities, activityRecords } = withWork(withWork(initialState(0), 'board:item1', live), 'board:item2');
    return { workers, stages: STAGES, deleteActivity: DELETE_ACTIVITY_DEFAULTS, terminals: [], activities, activityRecords };
  };
  assert.equal(canDeleteActivity(ok, at([])), true);
  assert.equal(canDeleteActivity({ ...ok, missing: true }, at([])), true, 'a task that left the board can drop its worktree before it is closed');
  const sessionWorker: Worker = { id: 's2', status: 'working', runId: 'w2', activityId: activityIdOf('board:item1'), sessionId: 'manual-session-0001', freeSession: true };
  const refused: [Task, Worker[], Partial<Activity>, string][] = [
    [ok, [], {}, 'nothing to clean'], [ok, [], { ...WT, workerId: 's1' }, 'running'], [ok, [], { ...WT, deleting: true }, 'deleting'],
    [ok, [sessionWorker], WT, 'a manual claude session runs inside the worktree'],
  ];
  for (const [c, workers, live, why] of refused) assert.equal(canDeleteActivity(c, at(workers, live)), false, why);
  assert.equal(canDeleteActivity(ok, at([{ ...sessionWorker, activityId: activityIdOf('board:item2') }])), true, 'another task\'s manual session does not refuse');
});

test('removalBlocker names why the delete activity button cannot run, in the order running, deleting, nothing to delete; nothing to delete follows the scope (#236) and never blocks in a delete activity stage, where the click moves the task on (#210, #236)', () => {
  const ok: Task = { item: item(1), stage: 'spec', boardColumn: 'Backlog', auto: true };
  const WT: Partial<Activity> = { worktree: '/wt/a' }; // #629: task 1's activity holds the worktree and the mark
  const withSession: Task = { ...ok, item: item(3) }; // #629: its live activity's record holds a session (below)
  const sessioned = (live: Partial<Activity>) => withWork(withWork(withWork(initialState(0), 'board:item3', {}, { sessions: [keptSession('kept-session-id-0001')] }), 'board:item1', live), 'board:item2');
  const SESSIONS_ONLY: DeleteActivityScope = { session: true, transcripts: false, nonAutoTasks: false };
  const sessionWorker: Worker = { id: 's2', status: 'working', runId: 'w2', activityId: activityIdOf('board:item1'), sessionId: 'manual-session-0001', freeSession: true };
  const deleting = { ...WT, deleting: true as const };
  const cases: [Task, Partial<Activity>, Worker[], DeleteActivityScope, RemovalBlocker | undefined, string][] = [
    [ok, WT, [], DELETE_ACTIVITY_DEFAULTS, undefined, 'stopped with a worktree'],
    [{ ...ok, missing: true }, WT, [], DELETE_ACTIVITY_DEFAULTS, undefined, 'a task that left the board can still be cleaned'],
    [ok, { ...WT, workerId: 's1' }, [], DELETE_ACTIVITY_DEFAULTS, 'running', 'its worker'],
    [ok, WT, [sessionWorker], DELETE_ACTIVITY_DEFAULTS, 'running', 'a manual claude session (#164)'],
    [ok, deleting, [], DELETE_ACTIVITY_DEFAULTS, 'deleting', 'git already runs on it'],
    [ok, {}, [], DELETE_ACTIVITY_DEFAULTS, 'nothingToDelete', 'no worktree, and the scope keeps sessions'],
    [withSession, {}, [], DELETE_ACTIVITY_DEFAULTS, 'nothingToDelete', 'a session the scope keeps is nothing to clean'],
    [withSession, {}, [], SESSIONS_ONLY, undefined, 'the scope drops sessions, and there is one'],
    [ok, { ...deleting, workerId: 's1' }, [], DELETE_ACTIVITY_DEFAULTS, 'running', 'running wins over deleting'],
    [ok, { deleting: true }, [], DELETE_ACTIVITY_DEFAULTS, 'deleting', 'deleting wins over nothing to clean'],
    [{ ...ok, stage: 'done' }, {}, [], DELETE_ACTIVITY_DEFAULTS, undefined, 'in a delete activity stage the button stays: it moves the task on by hand'],
  ];
  for (const [c, live, workers, deleteActivity, blocker, why] of cases) {
    const pair = sessioned(live);
    const state = { workers, stages: [...STAGES, DELETE_STAGES[1]], deleteActivity, terminals: [], activities: pair.activities, activityRecords: pair.activityRecords };
    assert.equal(removalBlocker(c, state), blocker, why);
    assert.equal(canDeleteActivity(c, state), blocker === undefined, `canDeleteActivity follows: ${why}`);
  }
  const pair = sessioned(WT);
  assert.equal(removalBlocker(ok, { workers: [{ ...sessionWorker, activityId: activityIdOf('board:item2') }], stages: STAGES, deleteActivity: DELETE_ACTIVITY_DEFAULTS, activities: pair.activities, activityRecords: pair.activityRecords }), undefined, 'another task\'s session does not block');
  assert.equal(removalBlocker(ok, { workers: [], stages: STAGES, deleteActivity: DELETE_ACTIVITY_DEFAULTS, activities: pair.activities, activityRecords: pair.activityRecords }), undefined, 'a terminal holds nothing: deleting closes it (#573)');
});

test('deletingActivity closes the task\'s terminals: a kill for each, dropped from the state, the mark set; another task\'s terminal and a workspace\'s stay (#573)', () => {
  const stopped = withLocal(withWork(ranOnce(2), 'board:item2'), 'hive'); // board:item1 stopped with its worktree; #696: every terminal's activity is there
  const own: Terminal = { terminalId: 'shell-worker-1', activityId: work(stopped, 1)!.id, startedAt: PAST, cwd: '/repo' };
  const other: Terminal = { terminalId: 'shell-worker-2', activityId: activityIdOf('board:item2'), startedAt: PAST, cwd: '/repo' };
  const workspace: Terminal = { terminalId: 'shell-worker-3', activityId: localActivityId('hive'), startedAt: PAST, cwd: '/repo' };
  const { state, effects } = reduce({ ...stopped, terminals: [own, other, workspace] }, { type: 'deletingActivity', activityId: workId(stopped, 'board:item1') });
  assert.equal(work(state, 1)?.deleting, true);
  assert.deepEqual(effects, [{ type: 'kill', slug: work(stopped, 1)!.slug, ptyId: own.terminalId }, { type: 'dropTerminalFiles', terminalId: own.terminalId }]);
  assert.deepEqual(state.terminals, [other, workspace]);
});

test('a due delete-activity stage takes a task with a terminal open and closes it before the effect (#573)', () => {
  const stages: LegacyStage[] = [DELETE_STAGES[0], { ...DELETE_STAGES[1], after: undefined }, DELETE_STAGES[2]];
  const parked = parkedIn(stages); // #629: its activity, the one the terminal is open in
  const terminal: Terminal = { terminalId: 'shell-worker-1', activityId: work(parked, 1)!.id, startedAt: PAST, cwd: '/repo' };
  const { state, effects } = polled({ ...parked, terminals: [terminal] }, [listed(1, 'Done')]);
  assert.deepEqual(effects.map((e) => e.type), ['kill', 'dropTerminalFiles', 'deleteActivity']);
  assert.deepEqual([state.terminals, work(state, 1)?.deleting], [[], true]);
});

test('deletingActivity marks only a task canDeleteActivity allows, with no effects and no fill; the mark keeps it out of the fill and of a manual start (#182)', () => {
  const stopped = ranOnce(2); // board:item1 stopped with a session and a worktree, board:item2 never ran, one free worker, red
  const { state, effects } = reduce(stopped, { type: 'deletingActivity', activityId: workId(stopped, 'board:item1') });
  assert.equal(work(state, 1)?.deleting, true);
  assert.deepEqual(effects, []);
  assert.deepEqual(started(state, 'board:item1').effects, [], 'a manual start waits for the answer');
  assert.equal(ownerAt(signaled(state, 'green').state, 0), 'board:item2', 'the fill skips it');
  const first = filled(1, 1).state;
  const running = hook(first, first.workers[0].runId!, { hook_event_name: 'SessionStart', cwd: WORKTREE }).state;
  const noOps: [State, string, string][] = [
    [stopped, 'board:item2', 'no worktree'], [running, 'board:item1', 'running'], [state, 'board:item1', 'already deleting'], [stopped, 'nope', 'unknown'],
  ];
  for (const [s, id, why] of noOps) assert.equal(reduce(s, { type: 'deletingActivity', activityId: workId(s, id) }).state, s, why);
});

test('worktreeRemoved outside a delete activity stage forgets the worktree, the branch and the session id, moves the session to the main repo (#208) and drops the mark: the task stays in its stage with its error and its stopped mark, so the fill leaves it; worktreeKept drops only the mark; both ignore an unmarked or unknown task (#182, #210)', () => {
  const stopped = ranOnce(1); // red: nothing respawns
  const marked = reduce(stopped, { type: 'deletingActivity', activityId: workId(stopped, 'board:item1') }).state;
  const kept = reduce(marked, { type: 'activityKept', activityId: workId(marked, 'board:item1') });
  assert.deepEqual(task(kept.state, 1), task(stopped, 1), 'git refused: the task is as it was');
  assert.deepEqual(kept.effects, []);
  const removed = reduce(marked, { type: 'activityRemoved', activityId: workId(marked, 'board:item1') });
  const forgotten = task(removed.state, 1)!;
  // #629: the stopped mark outlives the deleted activity on a fresh empty one, as withError holds an error: no worktree, branch or session id
  assert.deepEqual([work(removed.state, 1), sessionsN(removed.state, 1).map((s) => [s.id, s.repo])], [{ id: work(removed.state, 1)?.id, kind: 'task', workspace: 'hive', slug: 'hive-1-task-1', stopped: true, stoppedAt: work(stopped, 1)?.stoppedAt }, [[work(stopped, 1)?.sessionId, true]]], 'the session opens in the main repo from the sidebar (#208); the session id went with the activity (#629)');
  assert.notEqual(work(removed.state, 1)?.id, work(marked, 1)?.id, 'a new activity');
  assert.deepEqual(['worktree' in forgotten, 'branch' in forgotten, 'deleting' in forgotten], [false, false, false]);
  assert.equal(forgotten.stage, 'spec', 'it stays in its stage');
  const failed: State = withActivity(marked, { ...work(marked, 1)!, error: 'pty: boom' });
  assert.equal(work(reduce(failed, { type: 'activityRemoved', activityId: workId(failed, 'board:item1') }).state, 1)?.error, 'pty: boom', 'outside a delete activity stage the error stays: it waits for a manual start');
  const green = reduce({ ...marked, signal: 'green' }, { type: 'activityRemoved', activityId: workId(marked, 'board:item1') });
  assert.deepEqual(green.effects, [], 'stopped (#283): the fill leaves it until a start');
  for (const type of ['activityRemoved', 'activityKept'] as const) {
    assert.equal(reduce(stopped, { type, activityId: workId(stopped, 'board:item1') }).state, stopped, `${type}: no mark, same object`);
    assert.equal(reduce(marked, { type, activityId: 'nope' }).state, marked, `${type}: unknown activity`);
  }
});

test('a delete outside a delete activity stage keeps the old record, its sessions moved to the main repo, apart from the empty record of the activity that holds the marks; an activity with no mark leaves no activity behind (#629)', () => {
  const given = ranOnce(1);
  const marked = reduce(given, { type: 'deletingActivity', activityId: workId(given, 'board:item1') }).state;
  const old = work(marked, 1)!;
  const { state } = reduce(marked, { type: 'activityRemoved', activityId: workId(marked, 'board:item1') });
  const fresh = work(state, 1)!;
  assert.deepEqual(recordOf(state, old.id)?.sessions.map((s) => s.repo), [true], 'the old record stays, its session in the main repo');
  assert.deepEqual(recordOf(state, fresh.id), { id: fresh.id, taskIds: ['board:item1'], slug: old.slug, sessions: [] }, 'the new record is empty');
  assert.deepEqual(recordsOf(state, 'board:item1').map((r) => r.id), [old.id, fresh.id]);
  const { stopped: _stopped, stoppedAt: _stoppedAt, ...unmarked } = old;
  const bare = withActivity(marked, unmarked);
  const plain = reduce(bare, { type: 'activityRemoved', activityId: workId(bare, 'board:item1') }).state;
  assert.equal(work(plain, 1), undefined, 'no mark to hold: the task is left with no activity');
});

// A task in the first delete activity stage of `stages` (after 5d: the poll has not cleaned it) with a worktree, a branch, a session and the
// refusal of an earlier delete activity, marked by the delete-activity route: what the delete activity button's answer lands on (#210).
function inDeleteActivity(stages: LegacyStage[]): State {
  const first = polled(base(1, stages), [listed(1, 'Done')]).state;
  const refused = "the branch 'hive/1-task-1' is not fully merged into HEAD";
  const withGit: State = withMade(withLive(first, 1, { worktree: WORKTREE, branch: 'hive/1-task-1', sessionId: 'kept-session-id-0001', error: refused }), 1, { sessions: [keptSession('kept-session-id-0001')] });
  return reduce(withGit, { type: 'deletingActivity', activityId: workId(withGit, 'board:item1') }).state;
}

test('worktreeRemoved in a delete activity stage advances the task as cleaned does: onFinish written, the next stage entered, the error, worktree, branch and mark gone, the session id gone (#208), then the fill; after the last stage the task leaves and only onFinish is written (#210)', () => {
  const redo: LegacyStage[] = [{ name: 'done', from: { board: ['Done'] }, onFinish: { board: [move('Ready')] }, action: 'deleteActivity', after: '5d' }, STAGES[1]];
  const given = inDeleteActivity(redo);
  const { state, effects } = reduce(given, { type: 'activityRemoved', activityId: workId(given, 'board:item1') });
  assert.deepEqual(effects.map((e) => e.type), ['setColumn', 'setColumn', 'spawn'], 'onFinish, then dev\'s onStart and the spawn: the fill runs after the move');
  assert.deepEqual(effects[0], { type: 'setColumn', itemId: 'board:item1', column: 'Ready' });
  const moved = task(state, 1)!;
  assert.deepEqual([moved.stage, work(state, 1)?.sessionId === 'kept-session-id-0001'], ['dev', false], 'the fill\'s new session gets a fresh id');
  assert.deepEqual([work(state, 1)?.worktree, work(state, 1)?.deleting, 'error' in moved], [undefined, undefined, false], 'the fill\'s run has a new activity, no worktree yet (#629); no error left to hold it out of the fill in the next stage');
  assert.ok(effects[2].type === 'spawn' && effects[2].session === 'new', 'dev starts a new session: the old one opens only in the main repo (#208); the spawn recreates the worktree');
  const last = inDeleteActivity([DELETE_STAGES[0], DELETE_STAGES[1]]);
  const gone = reduce(last, { type: 'activityRemoved', activityId: workId(last, 'board:item1') });
  assert.deepEqual([gone.state.tasks, gone.effects], [[], [{ type: 'setColumn', itemId: 'board:item1', column: 'Archived' }]], 'last stage: the task leaves the Hive; the board only gets onFinish');
});

test('worktreeGone marks a stopped task only and keeps its path, branch and sessions (#208); a running task keeps it', () => {
  const stopped = ranOnce(1);
  const lost = reduce(stopped, { type: 'worktreeGone', activityId: ACT(stopped, 1) });
  const marked = work(lost.state, 1)!; // #629: the mark and the path are the activity's
  assert.equal(marked.worktreeGone, true);
  assert.deepEqual([marked.worktree, marked.branch, work(lost.state, 1)?.sessionId, sessionsN(lost.state, 1)], [WORKTREE, 'hive-1-task-1', work(stopped, 1)?.sessionId, sessionsN(stopped, 1)], 'only marked: the Hive did not remove it (#208)');
  assert.equal(lost.effects.length, 0);
  assert.equal(reduce(lost.state, { type: 'worktreeGone', activityId: ACT(lost.state, 1) }).state, lost.state, 'already marked: same object');
  assert.equal(reduce(stopped, { type: 'worktreeGone', activityId: 'nope' }).state, stopped, 'unknown task');
  const first = filled(1, 1).state;
  const running = hook(first, first.workers[0].runId!, { hook_event_name: 'SessionStart', cwd: WORKTREE }).state;
  assert.equal(reduce(running, { type: 'worktreeGone', activityId: ACT(running, 1) }).state, running, 'running: the worker is inside it, whatever the disk says');
});

const CHOSEN: TaskBase = { ref: 'hive/41-parent', tellWorker: true };

test('start with a base writes it on the task before the spawn, so the spawn effect carries it; a failed spawn and a later start without a base keep it (#131)', () => {
  const queued = polled(signaled(base(1), 'yellow').state, [listed(1)]).state; // yellow: the task waits, nothing spawns on its own
  const { state, effects } = reduce(queued, { type: 'start', itemId: 'board:item1', base: CHOSEN });
  assert.deepEqual(work(state, 1)?.base, CHOSEN);
  const spawn = effects.find((e) => e.type === 'spawn');
  assert.deepEqual(spawn?.type === 'spawn' ? spawn.activity.base : undefined, CHOSEN, 'the first spawn already reads it');
  const failed = reduce(state, { type: 'spawnFailed', ptyId: state.workers[0].runId!, message: 'base: hive/41-parent unknown (fatal: Needed a single revision)' }).state;
  assert.deepEqual(work(failed, 1)?.base, CHOSEN, 'the choice survives the failure it caused');
  const again = started(failed, 'board:item1');
  assert.deepEqual(work(again.state, 1)?.base, CHOSEN, 'a start without a base keeps the one already saved');
  const spawnAgain = again.effects.find((e) => e.type === 'spawn');
  assert.deepEqual(spawnAgain?.type === 'spawn' ? spawnAgain.activity.base : undefined, CHOSEN);
});

test('start with base null (the popup\'s default) drops a saved base: the next spawn uses the default (#131)', () => {
  const queued = polled(signaled(base(1), 'yellow').state, [listed(1)]).state;
  const chosen = reduce(queued, { type: 'start', itemId: 'board:item1', base: CHOSEN }).state;
  const failed = reduce(chosen, { type: 'spawnFailed', ptyId: chosen.workers[0].runId!, message: 'base: hive/41-parent unknown' }).state;
  const { state, effects } = reduce(failed, { type: 'start', itemId: 'board:item1', base: null });
  assert.equal('base' in (work(state, 1) ?? {}), false);
  const spawn = effects.find((e) => e.type === 'spawn');
  assert.equal(spawn?.type === 'spawn' ? 'base' in spawn.activity : 'no spawn', false);
});

test('a delete activity stage ignores a base: the deleteActivity effect runs and the task gets no base (#131)', () => {
  const queued = withWorktree(polled(signaled(base(1, DELETE_STAGES), 'yellow').state, [listed(1, 'Done')]).state); // after 5d: the poll does not clean it
  const { state, effects } = reduce(queued, { type: 'start', itemId: 'board:item1', base: CHOSEN });
  assert.deepEqual(effects.map((e) => e.type), ['deleteActivity']);
  assert.equal('base' in (work(state, 1) ?? {}), false);
});

test('start with local true marks the task before the spawn, so the spawn reads it; absent keeps it; false drops it; a delete activity stage ignores it (#444)', () => {
  const queued = polled(signaled(base(1), 'yellow').state, [listed(1)]).state;
  const on = reduce(queued, { type: 'start', itemId: 'board:item1', base: null, local: true });
  assert.equal(work(on.state, 1)?.local, true);
  const spawn = on.effects.find((e) => e.type === 'spawn');
  assert.equal(spawn?.type === 'spawn' ? spawn.activity.local : undefined, true, 'the first spawn already reads it');
  const failed = reduce(on.state, { type: 'spawnFailed', ptyId: on.state.workers[0].runId!, message: '/repo has changes that are not committed' }).state;
  assert.equal(work(started(failed, 'board:item1').state, 1)?.local, true, 'a start with no popup keeps it');
  const off = reduce(failed, { type: 'start', itemId: 'board:item1', base: null, local: false }).state;
  assert.equal('local' in (work(off, 1) ?? {}), false);
  const cleanup = withWorktree(polled(signaled(base(1, DELETE_STAGES), 'yellow').state, [listed(1, 'Done')]).state);
  assert.equal('local' in task(reduce(cleanup, { type: 'start', itemId: 'board:item1', local: true }).state, 1)!, false);
});

const created = (state: State, stage: string, title = 'Local task') =>
  reduce(state, { type: 'createTask', title, body: 'by hand', stage, prefix: 'HIVE', auto: true });

test('createTask hands out HIVE-1 then HIVE-2, appends to the stage with enteredAt now, never reuses a number after a close, and ignores an unknown stage', () => {
  const listedFirst = polled(signaled(base(0), 'yellow').state, [listed(1), listed(2, 'Ready')]).state; // 1 in spec, 2 in dev; no worker
  const before = Date.now();
  const one = created(listedFirst, 'spec').state;
  const two = created(one, 'spec', 'Second').state;
  assert.deepEqual(two.tasks.map((c) => [c.item.id, c.stage]), [['1', 'spec'], ['HIVE-1', 'spec'], ['HIVE-2', 'spec'], ['2', 'dev']], 'right after the stage\'s last task');
  const { enteredAt, ...first } = two.tasks[1];
  assert.deepEqual(first, {
    item: { itemId: 'local:1', id: 'HIVE-1', title: 'Local task', body: 'by hand', url: '' },
    stage: 'spec', boardColumn: '', auto: true, created: true,
  }, 'no slug: its activity takes slugFor\'s at its birth (#629)');
  assert.ok(Date.parse(enteredAt ?? '') >= before, 'entered now: after counts from creation');
  assert.equal(two.localCount, 2);
  const closed = reduce(two, { type: 'closeTask', taskId: 'local:2' }).state;
  const third = created(closed, 'dev').state;
  assert.equal(third.tasks.find((c) => c.item.itemId === 'local:3')?.item.id, 'HIVE-3', 'HIVE-2 was removed, its number stays used');
  assert.equal(third.tasks.at(-1)?.item.id, 'HIVE-3', 'dev\'s last task was 2, the list\'s last');
  const unknown = created(two, 'nope');
  assert.equal(unknown.state, two, 'unknown stage: the same object, no number handed out');
  assert.deepEqual(unknown.effects, []);
});

test('a local task runs through the stages like any task and never produces a source write: not on start, on finish nor in place', () => {
  const made = created(base(1), 'dev'); // dev: onStart In progress, onFinish In review
  assert.deepEqual(made.effects.map((e) => e.type), ['spawn'], 'fill took it at once, with no onStart write');
  const finished = stopped(made.state, made.state.workers[0].runId!);
  assert.deepEqual(finished.effects.map((e) => e.type), ['kill', 'forgetScrollback'], 'no onFinish write either');
  assert.deepEqual([finished.state.tasks[0].stage, finished.state.tasks[0].boardColumn], ['review', '']);
  const spec = created(base(1), 'spec').state; // spec onFinish Ready, then dev (continue) onStart In progress
  assert.deepEqual(stopped(spec, spec.workers[0].runId!).effects.map((e) => e.type), ['continue'], 'in place: neither write');
});

test('closeTask removes a stopped local task and leaves its worktree on disk (#182); a running one or one being cleaned is left alone', () => {
  const running = created(base(1), 'dev').state;
  assert.equal(reduce(running, { type: 'closeTask', taskId: 'local:1' }).state, running, 'running: refused');
  const idle = reduce(signaled(running, 'red').state, { type: 'exit', ptyId: running.workers[0].runId! }).state;
  const removed = reduce(idle, { type: 'closeTask', taskId: 'local:1' });
  assert.deepEqual([removed.state.tasks, removed.effects], [[], []], 'no removal effect: the details panel removes the worktree');
  const deleting = withLiveFor(idle, idle.tasks[0].item, { deleting: true }); // #629: the mark is the activity's
  assert.equal(reduce(deleting, { type: 'closeTask', taskId: 'local:1' }).state, deleting, 'deleting: refused');
});

test('an open hive blocker stops its task\'s start; closing the blocker leaves a closed ref and frees it (#56)', () => {
  const two = created(created(base(0), 'dev').state, 'dev', 'Blocker').state; // no worker: nothing fills on its own
  const blocked = reduce(two, { type: 'blockerSet', itemId: 'local:1', change: { action: 'add', kind: 'blockedBy', ref: 'HIVE-2' } }).state;
  assert.deepEqual(blocked.tasks.find((c) => c.item.itemId === 'local:1')?.item.blockedBy, ['HIVE-2']);
  assert.equal(reduce(blocked, { type: 'start', itemId: 'local:1' }).effects.some((e) => e.type === 'spawn'), false, 'blocked: no spawn');
  const freed = reduce(blocked, { type: 'closeTask', taskId: 'local:2' }).state;
  const first = freed.tasks.find((c) => c.item.itemId === 'local:1');
  assert.deepEqual([first?.item.blockedBy, first?.item.blockers?.blockedBy], [undefined, [{ id: 'HIVE-2', title: 'Blocker', state: 'closed' }]]);
  assert.equal(reduce(freed, { type: 'start', itemId: 'local:1' }).effects.some((e) => e.type === 'spawn'), true, 'freed: it starts');
});

test('a settings save that removes the stage of a stopped local task moves it to the nearest surviving stage before it (#861)', () => {
  const made = created(signaled(base(1), 'yellow').state, 'review').state; // yellow: nothing spawns, the task stays stopped
  const stages = made.stages.filter((c) => c.name !== 'review');
  const saved = reduce(made, { type: 'setStages', ...chained(stages) }).state;
  assert.deepEqual(saved.tasks.map((c) => [c.item.id, c.stage]), [['HIVE-1', 'dev']], 'review was last: dev comes before it');
});

// A stopped task in spec, marked manual and with its worktree, under yellow so nothing fills on its own (#164)
// #629: the worktree and run fields of `extra` go on the task's activity, born only when one of them is set (worktree: undefined leaves none)
const WORK_KEYS = [
  'worktree', 'branch', 'base', 'local', 'setup', 'deleting', 'worktreeGone', 'sessionId', 'workerId', 'stopped', 'stageStart', 'error', 'approval', 'handover',
] as const;
type Manual = Partial<Task> & Partial<Pick<Activity, (typeof WORK_KEYS)[number]>>;
const manualState = (max: number, extra: Manual = {}): State => {
  const queued = polled(signaled(base(max), 'yellow').state, [listed(1)]).state;
  const isWork = (key: string): boolean => (WORK_KEYS as readonly string[]).includes(key);
  const live = Object.fromEntries(Object.entries({ worktree: WORKTREE, ...extra }).filter(([key, v]) => isWork(key) && v !== undefined)) as Partial<Activity>;
  const own = Object.fromEntries(Object.entries(extra).filter(([key]) => !isWork(key))) as Partial<Task>;
  const placed = { ...queued, tasks: queued.tasks.map((c) => ({ ...c, auto: false as const, ...own })) };
  return Object.keys(live).length === 0 ? placed : withLive(placed, 1, live);
};

test('setAuto turns auto off and on: off keeps a free worker under green from taking the task and emits nothing; on fills at once; unknown and missing tasks change nothing (#164, #573)', () => {
  const queued = polled(signaled(base(1), 'yellow').state, [listed(1)]).state;
  const off = reduce(queued, { type: 'setAuto', taskId: 'board:item1', auto: false });
  assert.equal(task(off.state, 1)?.auto, false);
  assert.deepEqual(off.effects, []);
  const green = signaled(off.state, 'green');
  assert.deepEqual(green.effects, [], 'green with a free worker: a task without auto is not a candidate');
  const on = reduce(green.state, { type: 'setAuto', taskId: 'board:item1', auto: true });
  assert.equal(task(on.state, 1)?.auto, true);
  assert.deepEqual(on.effects.map((e) => e.type), ['spawn'], 'the fill takes it with the stage\'s prompt');
  assert.equal(reduce(queued, { type: 'setAuto', taskId: 'nope', auto: false }).state, queued);
  const gone: State = { ...queued, tasks: queued.tasks.map((c) => ({ ...c, missing: true as const })) };
  assert.equal(reduce(gone, { type: 'setAuto', taskId: 'board:item1', auto: false }).state, gone);
});

test('setAuto on clears the activity\'s stopped mark so the fill may pick the task; off leaves the mark (#892)', () => {
  const STOPPED_AT = '2026-10-10T00:00:00.000Z';
  const stopped = withLive(manualState(1), 1, { stopped: true, stoppedAt: STOPPED_AT });
  const off = reduce(stopped, { type: 'setAuto', taskId: 'board:item1', auto: false }).state;
  assert.deepEqual([work(off, 1)?.stopped, work(off, 1)?.stoppedAt], [true, STOPPED_AT], 'auto off keeps the mark');
  const queued = reduce(signaled(stopped, 'red').state, { type: 'setAuto', taskId: 'board:item1', auto: true });
  assert.deepEqual([work(queued.state, 1)?.stopped, work(queued.state, 1)?.stoppedAt], [undefined, undefined], 'auto on clears it');
  assert.deepEqual(queued.effects, [], 'under red nothing fills: the task waits for a worker');
  const green = signaled(stopped, 'green').state;
  assert.deepEqual(reduce(green, { type: 'setAuto', taskId: 'board:item1', auto: true }).effects.map((e) => e.type), ['spawn'], 'a free worker takes it at once');
  const failed = withLive(green, 1, { error: 'commands failed' });
  const kept = reduce(failed, { type: 'setAuto', taskId: 'board:item1', auto: true });
  assert.deepEqual([work(kept.state, 1)?.stopped, work(kept.state, 1)?.stoppedAt, kept.effects], [true, STOPPED_AT, []], 'a failure\'s stop keeps its mark: the error still bars the fill');
});

test('the fill skips a task with auto false and takes one with auto true (#573)', () => {
  const queued = polled(signaled(base(1), 'red').state, [listed(1)]).state; // red: the poll starts nothing
  const withAuto = (auto: boolean): State => ({ ...queued, tasks: queued.tasks.map((c) => ({ ...c, auto })) });
  const skipped = signaled(withAuto(false), 'green');
  assert.deepEqual(skipped.effects, [], 'auto false: no worker picks it up');
  assert.equal(work(skipped.state, 1)?.workerId, undefined);
  const taken = signaled(withAuto(true), 'green');
  assert.deepEqual(taken.effects.map((e) => e.type), ['spawn']);
  assert.equal(work(taken.state, 1)?.workerId, taken.state.workers[0].id);
});

const NON_AUTO: DeleteActivityScope = { ...DELETE_ACTIVITY_DEFAULTS, nonAutoTasks: true };
// Task 1 without auto, sitting in a done stage with no after and its worktree: due on the next poll unless the scope leaves it out (#496)
const parkedWithoutAuto = (deleteActivity: DeleteActivityScope): State => {
  const parked = parkedIn([DELETE_STAGES[0], { ...DELETE_STAGES[1], after: undefined }, DELETE_STAGES[2]]);
  return { ...parked, deleteActivity, tasks: parked.tasks.map((c) => ({ ...c, auto: false as const })) };
};

test('with nonAutoTasks on, a poll cleans a task without auto in a due delete activity stage, and cleaned moves it on still without auto; off, the poll leaves it (#496)', () => {
  assert.deepEqual(polled(parkedWithoutAuto(DELETE_ACTIVITY_DEFAULTS), [listed(1, 'Done')]).effects, [], 'off: left for a delete activity by hand, as before');
  const { state, effects } = polled(parkedWithoutAuto(NON_AUTO), [listed(1, 'Done')]);
  assert.deepEqual(effects, [deletion(state, 1, NON_AUTO)]);
  assert.equal(work(state, 1)?.deleting, true);
  const after = reduce(state, { type: 'activityDeleted', activityId: ACT(state, 1) }).state;
  const moved = task(after, 1)!;
  assert.deepEqual([moved.stage, moved.auto, work(after, 1)], ['archive', false, undefined], 'its activity went (#629)');
});

test('with nonAutoTasks on, a task without auto whose stage run ends into a delete activity stage with no after is cleaned in that same reduction (#284, #496)', () => {
  const { state: running, id } = devBeforeDone({ after: undefined });
  // marked mid-run: its stage run goes on (#164)
  const marked = (deleteActivity: DeleteActivityScope): State => reduce({ ...running, deleteActivity }, { type: 'setAuto', taskId: 'board:item1', auto: false }).state;
  assert.deepEqual(stopped(marked(DELETE_ACTIVITY_DEFAULTS), id).effects.map((e) => e.type), ['captureCheckpoint', 'kill', 'setColumn'], 'off: it only moves into done');
  const { state, effects } = stopped(marked(NON_AUTO), id);
  assert.deepEqual(effects.map((e) => e.type), ['captureCheckpoint', 'kill', 'setColumn', 'deleteActivity']);
  assert.deepEqual([task(state, 1)?.stage, work(state, 1)?.deleting, task(state, 1)?.auto], ['done', true, false]);
});

test('with nonAutoTasks on, the fill still never picks up a task without auto (#496)', () => {
  const green = signaled({ ...manualState(1), deleteActivity: NON_AUTO }, 'green');
  assert.deepEqual(green.effects, [], 'the switch is about delete activity only');
  assert.equal(work(green.state, 1)?.workerId, undefined);
});

test('openSession claude opens past red and an exhausted budget, as a free session appended to state.workers with a new session appended to the task; a second one is appended too, neither draining, and each leaves with its exit; neither touches task.workerId, task.sessionId or the board (#164, #459)', () => {
  const red: State = { ...signaled(manualState(1), 'red').state, budget: { maxTokensPerHour: 1 }, usage: [{ at: new Date().toISOString(), tokens: 5 }] };
  const first = reduce(red, { type: 'openSession', activityId: workId(red, 'board:item1') });
  const [worker] = occupied(first.state);
  assert.deepEqual([worker.freeSession, ownerOf(first.state, worker), worker.status, worker.lastEvent, worker.draining], [true, 'board:item1', 'working', { kind: 'manualStart' }, undefined]);
  assert.match(worker.sessionId!, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first.state.workers[0], red.workers[0], 'the free worker stays the fill\'s (#459)');
  const opened = task(first.state, 1)!;
  assert.deepEqual([work(first.state, 1)?.workerId, work(first.state, 1)?.sessionId], [undefined, undefined], 'the activity\'s workerId and sessionId stay the pipeline\'s (#629)');
  assert.deepEqual(sessionsN(first.state, 1), [{ id: worker.sessionId, startedAt: worker.startedAt, stages: [], agent: 'claude', lastUsedAt: worker.startedAt, free: true }]); // a free session runs no stage (#812)
  assert.deepEqual(first.effects, [{ type: 'spawnSession', worker, activity: work(first.state, 1), task: opened, sessionId: worker.sessionId, continues: false }], 'no setColumn: nothing reaches the board');
  const second = reduce(first.state, { type: 'openSession', activityId: workId(first.state, 'board:item1') }).state;
  assert.deepEqual([second.workers.length, second.workers[2].draining, second.workers[2].freeSession, second.maxConcurrent], [3, undefined, true, 1]);
  assert.equal(sessionsN(second, 1)?.length, 2, 'two sessions: two workers on one task');
  const left = reduce(second, { type: 'exit', ptyId: second.workers[2].runId! }).state;
  assert.equal(left.workers.length, 2, 'a session\'s worker leaves with its exit');
});

test('openSession on a task whose worktree git is removing changes nothing: no session inside a worktree being removed (#164, #182)', () => {
  const deleting = manualState(1, { deleting: true });
  const { state, effects } = reduce(deleting, { type: 'openSession', activityId: workId(deleting, 'board:item1') });
  assert.equal(state, deleting);
  assert.deepEqual(effects, []);
});

test('openSession with resume reuses the session and appends nothing; a session a live worker holds, an unknown id, a task without worktree or an unknown task change nothing (#164, #283, #491)', () => {
  const at = '2026-09-22T10:00:00.000Z';
  const ran = withMade(manualState(2, { sessionId: 'kept-session-id-0001', enteredAt: at }), 1, { sessions: [{ id: 'kept-session-id-0001', startedAt: at, stages: ['spec'], agent: 'claude' as const, lastUsedAt: at }] }); // #629: the record holds it
  const resumed = reduce(ran, { type: 'openSession', activityId: workId(ran, 'board:item1'), continueId: 'kept-session-id-0001' });
  assert.equal(occupied(resumed.state)[0].sessionId, 'kept-session-id-0001');
  assert.deepEqual(sessionsN(resumed.state, 1), [{ id: 'kept-session-id-0001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['spec'], agent: 'claude', lastUsedAt: occupied(resumed.state)[0].startedAt }], 'one row per session: a resume adds none, it uses the one again (#236)');
  assert.deepEqual(resumed.effects.map((e) => (e.type === 'spawnSession' ? e.continues : e.type)), [true]);
  const refused: [State, string | undefined, string][] = [
    [resumed.state, 'kept-session-id-0001', 'held by a live worker: two terminals on one transcript'],
    [ran, 'not-a-session-0001', 'an id the task never had'],
    [manualState(1, { worktree: undefined }), undefined, 'no worktree yet'],
  ];
  for (const [state, resume, why] of refused) assert.equal(reduce(state, { type: 'openSession', activityId: workId(state, 'board:item1'), continueId: resume }).state, state, why);
  assert.equal(reduce(ran, { type: 'openSession', activityId: workId(ran, 'nope') }).state, ran);
});

test('openSession resumes on any task: a repo session opens with no worktree in a free session, and its SessionStart leaves the task without a path; a worktree session needs its worktree on disk; a new session needs a worktree, on any task (#208, #283)', () => {
  const idle = ranOnce(1); // spec, red, not manual: worktree, branch and the session of its run
  const marked = reduce(idle, { type: 'deletingActivity', activityId: workId(idle, 'board:item1') }).state;
  const removed = reduce(marked, { type: 'activityRemoved', activityId: workId(marked, 'board:item1') }).state;
  const [session] = sessionsN(removed, 1);
  assert.deepEqual([task(removed, 1)?.auto, work(removed, 1)?.worktree, session.repo], [true, undefined, true]);
  const opened = reduce(removed, { type: 'openSession', activityId: workId(removed, 'board:item1'), continueId: session.id });
  const [worker] = occupied(opened.state);
  assert.deepEqual([worker.freeSession, worker.sessionId, ownerOf(opened.state, worker)], [true, session.id, 'board:item1']);
  assert.deepEqual(opened.effects.map((e) => (e.type === 'spawnSession' ? [e.sessionId, e.continues, e.repo] : e.type)), [[session.id, true, true], 'forgetScrollback'], '#672: the continued session\'s sleeping record goes');
  const seen = hook(opened.state, worker.runId!, { hook_event_name: 'SessionStart', cwd: '/repo' }).state;
  assert.equal('worktree' in (work(seen, 1) ?? {}), false, 'it ran in the main repo: the task still has no worktree');
  const gone = reduce(idle, { type: 'worktreeGone', activityId: ACT(idle, 1) }).state;
  assert.equal(reduce(gone, { type: 'openSession', activityId: workId(gone, 'board:item1'), continueId: sessionsN(idle, 1)[0].id }).state, gone, 'a worktree session with its worktree gone from disk');
  assert.equal(reduce(removed, { type: 'openSession', activityId: workId(removed, 'board:item1') }).state, removed, 'a new session on a task with no worktree: the route creates it first');
  assert.deepEqual(reduce(idle, { type: 'openSession', activityId: workId(idle, 'board:item1') }).effects.map((e) => e.type), ['spawnSession'], 'with its worktree, manual or not (#283)');
});

test('a free session\'s Stop never ends a stage; its exit frees the worker and leaves the task as it was but for its totals; a spawn failure goes to the bar only (#164, #248, #283)', () => {
  const given = manualState(1);
  const opened = reduce(given, { type: 'openSession', activityId: workId(given, 'board:item1') }).state;
  const id = opened.workers[1].runId!; // appended past the free worker (#459)
  const stop = hook(opened, id, { hook_event_name: 'Stop' });
  assert.deepEqual(stop.effects, []);
  assert.deepEqual([stop.state.workers[1].status, task(stop.state, 1)?.stage], ['waiting', 'spec']);
  const exited = reduce(stop.state, { type: 'exit', ptyId: id }).state;
  assert.deepEqual(exited.workers, opened.workers.slice(0, 1), 'its worker leaves; the free one stays (#459)');
  assert.deepEqual(task(exited, 1), task(stop.state, 1), 'no task field moves');
  assert.ok(usageN(exited, 1), 'the session\'s time joins the task\'s record (#248, #629)');
  const failed = reduce(opened, { type: 'spawnFailed', ptyId: id, message: 'pty: boom' }).state;
  assert.deepEqual([failed.workers.length, work(failed, 1)?.error, failed.error], [1, undefined, 'pty: boom']);
});

test('a manual task continues in place like any other: its stage-ending Stop answers with the next stage\'s prompt; after a kill and an advance the fill leaves it alone (#164, #283)', () => {
  const first = filled(1, 1).state; // green: spec continues into dev in place
  const id = first.workers[0].runId!;
  const marked = reduce(first, { type: 'setAuto', taskId: 'board:item1', auto: false }).state;
  const continued = stopped(marked, id);
  assert.equal(continued.effects.at(-1)?.type, 'continue');
  assert.deepEqual([task(continued.state, 1)?.stage, work(continued.state, 1)?.workerId, task(continued.state, 1)?.auto], ['dev', first.workers[0].id, false]);
  const parked = stopped(signaled(marked, 'red').state, id).state; // red: the session dies, the task waits in dev
  assert.equal(task(parked, 1)?.stage, 'dev');
  assert.deepEqual(signaled(parked, 'green').effects, [], 'manual: the fill never starts it');
});

test('occupy appends a new session to task.sessions and a continue appends nothing (#164)', () => {
  const first = filled(1, 1).state; // spec: a new session
  assert.deepEqual(sessionsN(first, 1), [{ id: work(first, 1)?.sessionId, startedAt: first.workers[0].startedAt, stages: ['spec'], agent: 'claude', lastUsedAt: first.workers[0].startedAt }]);
  const known: State = withMade(withLive({ ...base(1), tasks: [{ item: item(1), stage: 'dev', boardColumn: 'In progress', auto: true }] }, 1, { sessionId: 'kept-session-id-0001' }), 1, { sessions: [keptSession('kept-session-id-0001', ['dev'])] });
  const resumed = reduce(known, { type: 'setSignal', signal: 'green' }).state;
  assert.equal(occupied(resumed).length, 1);
  assert.deepEqual(sessionsN(resumed, 1)?.map((s) => [s.id, s.stages]), [['kept-session-id-0001', ['dev']]], 'the resumed session, used in dev again: no second row (#236)');
});

test('worktreeReady writes the worktree, the branch and the base on the task\'s activity, null drops a saved base; an unknown activity changes nothing; no effects (#164, #629)', () => {
  const marked = manualState(1, { worktree: undefined, base: { ref: 'old', tellWorker: true } });
  const ready = reduce(marked, { type: 'worktreeReady', activityId: ACT(marked, 1), path: WORKTREE, branch: 'hive/1-task-1', base: { ref: 'feature-x', tellWorker: false }, local: false });
  const written = work(ready.state, 1)!;
  assert.deepEqual([written.worktree, written.branch, written.base], [WORKTREE, 'hive/1-task-1', { ref: 'feature-x', tellWorker: false }]);
  assert.deepEqual(ready.effects, []);
  const byDefault = reduce(marked, { type: 'worktreeReady', activityId: ACT(marked, 1), path: WORKTREE, branch: 'hive/1-task-1', base: null, local: false }).state;
  assert.equal('base' in (work(byDefault, 1) ?? {}), false);
  assert.equal(reduce(marked, { type: 'worktreeReady', activityId: 'nope', path: WORKTREE, branch: 'b', base: null, local: false }).state, marked);
});

test('worktreeReady sets checkout from the event and drops it when false (#444)', () => {
  const marked = born(manualState(1, { worktree: undefined }), 1); // #629: the first open makes the activity first
  const ready = reduce(marked, { type: 'worktreeReady', activityId: ACT(marked, 1), path: '/repo', branch: 'hive/1-task-1', base: null, local: true }).state;
  assert.equal(work(ready, 1)?.local, true);
  const back = reduce(ready, { type: 'worktreeReady', activityId: ACT(ready, 1), path: WORKTREE, branch: 'hive/1-task-1', base: null, local: false }).state;
  assert.equal('local' in (work(back, 1) ?? {}), false);
});

test('moveToStage puts a stopped manual task in another stage (fresh enteredAt, unpinned, still manual) and writes the target\'s first from; a local task writes nothing; refused while its stage run holds it, auto on or off, for an unknown or the same stage (#164, #366, #708)', () => {
  const marked = manualState(1, { pinned: true, enteredAt: PAST });
  const { state, effects } = reduce(marked, { type: 'moveToStage', taskId: 'board:item1', stage: 'review' });
  const moved = task(state, 1)!;
  assert.deepEqual([moved.stage, moved.boardColumn, moved.pinned, moved.auto], ['review', 'In review', undefined, false]);
  assert.ok(Date.parse(moved.enteredAt!) > Date.parse(PAST));
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:item1', column: 'In review' }]);
  const local: State = { ...marked, tasks: marked.tasks.map((c) => ({ ...c, created: true as const, boardColumn: '' })) };
  const quiet = reduce(local, { type: 'moveToStage', taskId: 'board:item1', stage: 'review' });
  assert.deepEqual([task(quiet.state, 1)?.stage, quiet.effects], ['review', []]);
  const running = reduce(filled(1, 1).state, { type: 'setAuto', taskId: 'board:item1', auto: false }).state; // marked mid-run: its stage run goes on (#164)
  for (const [state, stage] of [[running, 'review'], [filled(1, 1).state, 'review'], [marked, 'nope'], [marked, 'spec']] as const) {
    assert.equal(reduce(state, { type: 'moveToStage', taskId: 'board:item1', stage }).state, state, stage);
  }
});

test('moveToStage marks its write, and a stale poll right after it does not move the task back; a third column still follows at once (#889)', () => {
  const { state } = reduce(manualState(1), { type: 'moveToStage', taskId: 'board:item1', stage: 'review' });
  assert.deepEqual([task(state, 1)?.columnWrite?.column, task(state, 1)?.columnWrite?.stale], ['In review', ['Backlog']]);
  const stale = polled(state, [listed(1)]).state; // still Backlog: the write has not landed
  assert.deepEqual([task(stale, 1)?.stage, task(stale, 1)?.boardColumn], ['review', 'In review']);
  const moved = polled(stale, [listed(1, 'Ready')]).state; // someone moved it on the source meanwhile
  assert.deepEqual([task(moved, 1)?.stage, task(moved, 1)?.boardColumn, task(moved, 1)?.columnWrite], ['dev', 'Ready', undefined]);
});

test('moveToStage moves a task a free session is open on: the session stays open, and its hive_done advances the task from the stage it now sits in (#366, #283)', () => {
  const given = manualState(1);
  const open = reduce(given, { type: 'openSession', activityId: workId(given, 'board:item1') }).state;
  const [session] = occupied(open);
  const moved = reduce(open, { type: 'moveToStage', taskId: 'board:item1', stage: 'dev' }).state;
  assert.deepEqual([task(moved, 1)?.stage, occupied(moved)], ['dev', [session]]);
  assert.equal(task(done(moved, session.runId!), 1)?.stage, 'review', 'dev finished: onFinish, then the next stage');
});

test('moveToStage hands a task that entered a prompt stage to the fill: a non-manual local task takes a free worker and waits while the cap is reached; a manual one never starts (#366)', () => {
  const local = (s: State): Task | undefined => s.tasks.find((c) => c.item.itemId === 'local:1');
  const create = (state: State): State => reduce(state, { type: 'createTask', title: 'Local', body: '', stage: 'review', prefix: 'HIVE', auto: true }).state;
  const moveTo = (state: State) => reduce(state, { type: 'moveToStage', taskId: 'local:1', stage: 'spec' });
  const started = moveTo(create(base(1)));
  assert.deepEqual([local(started.state)?.stage, ownerAt(started.state, 0)], ['spec', 'local:1']);
  assert.ok(runOf(started.state, local(started.state)!)?.workerId !== undefined);
  assert.ok(started.effects.some((e) => e.type === 'spawn'), JSON.stringify(started.effects));
  const full = moveTo(create(filled(1, 1).state));
  assert.deepEqual([local(full.state)?.stage, runOf(full.state, local(full.state)!)?.workerId, full.effects], ['spec', undefined, []], 'the only worker runs another task');
  const manual = moveTo(reduce(create(base(1)), { type: 'setAuto', taskId: 'local:1', auto: false }).state);
  assert.deepEqual([local(manual.state)?.stage, runOf(manual.state, local(manual.state)!)?.workerId, manual.effects], ['spec', undefined, []], 'manual: isIdle excludes it');
});

test('moveToStage takes a source task with auto on: it writes the target\'s first from, keeps auto on, and the fill starts it in a prompt stage or leaves it waiting while the cap is reached (#708)', () => {
  const parked = polled(base(1), [listed(1, 'In review')]).state; // auto on, in review: no prompt, so nothing runs
  const started = reduce(parked, { type: 'moveToStage', taskId: 'board:item1', stage: 'spec' });
  const moved = task(started.state, 1);
  assert.deepEqual([moved?.stage, moved?.boardColumn, moved?.auto, ownerAt(started.state, 0)], ['spec', 'Backlog', true, 'board:item1']);
  assert.deepEqual(started.effects.filter((e) => e.type === 'setColumn'), [{ type: 'setColumn', itemId: 'board:item1', column: 'Backlog' }]);
  assert.ok(started.effects.some((e) => e.type === 'spawn'), JSON.stringify(started.effects));
  const busy = polled(base(1), [listed(1, 'In review'), listed(2)]).state; // task 2 in spec takes the only worker
  assert.equal(ownerAt(busy, 0), 'board:item2');
  const waiting = reduce(busy, { type: 'moveToStage', taskId: 'board:item1', stage: 'spec' });
  assert.deepEqual([task(waiting.state, 1)?.stage, work(waiting.state, 1)?.workerId, waiting.effects], ['spec', undefined, [{ type: 'setColumn', itemId: 'board:item1', column: 'Backlog' }]], 'the only worker runs another task');
});

test('a source task with auto on moved by hand stays where the user put it until its source column changes: the written column, or an unchanged one when the target has no from on its source (#708)', () => {
  const moved = reduce(manualState(1, { auto: true }), { type: 'moveToStage', taskId: 'board:item1', stage: 'review' }).state; // yellow: nothing fills
  assert.equal(task(polled(moved, [listed(1, 'In review')]).state, 1)?.stage, 'review', 'the source shows the written column');
  const stages: LegacyStage[] = [...STAGES, { name: 'parked', from: {} }];
  const queued = polled(signaled(base(1, stages), 'yellow').state, [listed(1)]).state; // auto on, in spec
  const parked = reduce(queued, { type: 'moveToStage', taskId: 'board:item1', stage: 'parked' });
  assert.deepEqual([task(parked.state, 1)?.stage, task(parked.state, 1)?.boardColumn, parked.effects], ['parked', 'Backlog', []], 'no from on its source: nothing written');
  assert.equal(task(polled(parked.state, [listed(1)]).state, 1)?.stage, 'parked', 'the source column did not change');
  assert.equal(task(polled(parked.state, [listed(1, 'Ready')]).state, 1)?.stage, 'dev', 'the source moved it: the task follows, as any source task');
});

test('moveToStage clears stopped on a source task with auto on, so the fill starts it in the prompt stage it entered (#708)', () => {
  const halted = signaled(manualState(1, { auto: true, stopped: true }), 'green').state;
  assert.deepEqual([holds(halted, 1, 'stopped'), ownerAt(halted, 0)], [true, undefined], 'stopped: green does not start it');
  const moved = reduce(halted, { type: 'moveToStage', taskId: 'board:item1', stage: 'dev' });
  assert.deepEqual([task(moved.state, 1)?.stage, holds(moved.state, 1, 'stopped'), ownerAt(moved.state, 0)], ['dev', false, 'board:item1']);
  assert.ok(moved.effects.some((e) => e.type === 'spawn'), JSON.stringify(moved.effects));
});

test('moveToStage with drop pins the task where it landed in the target stage, before `before` or at its end with drop: {}; without drop it keeps its array position, unpinned (#366, #123)', () => {
  const queued = polled(signaled(base(1), 'yellow').state, [listed(1), listed(2, 'In review'), listed(3, 'In review')]).state;
  const marked = reduce(queued, { type: 'setAuto', taskId: 'board:item1', auto: false }).state;
  const review = (s: State): [string, true | undefined][] => s.tasks.filter((c) => c.stage === 'review').map((c) => [c.item.itemId, c.pinned]);
  const moved = (drop?: { before?: string }) => reduce(marked, { type: 'moveToStage', taskId: 'board:item1', stage: 'review', ...(drop ? { drop } : {}) }).state;
  assert.deepEqual(review(moved({ before: 'board:item3' })), [['board:item2', undefined], ['board:item1', true], ['board:item3', undefined]]);
  assert.deepEqual(review(moved({})), [['board:item2', undefined], ['board:item3', undefined], ['board:item1', true]]);
  assert.deepEqual(review(moved()), [['board:item1', undefined], ['board:item2', undefined], ['board:item3', undefined]], 'a menu move has no drop point');
});

test('closeTask kills every worker of the task, the manual ones too, and frees them; a local task is not removable while any worker holds it (#164)', () => {
  const given = manualState(1);
  const one = reduce(given, { type: 'openSession', activityId: workId(given, 'board:item1') }).state;
  const two = reduce(one, { type: 'openSession', activityId: workId(one, 'board:item1') }).state; // appended too, outside the cap (#459)
  const ids = occupied(two).map((s) => s.runId);
  const gone = polled(two, []).state; // off the source: missing
  const { state, effects } = reduce(gone, { type: 'closeTask', taskId: 'board:item1' });
  assert.deepEqual(effects, [...ids.map((ptyId) => ({ type: 'kill', slug: 'hive-1-task-1', ptyId })), ...ids.map((ptyId) => ({ type: 'forgetScrollback', ptyId }))]);
  assert.deepEqual([state.tasks, state.workers.length, occupied(state).length], [[], 1, 0]);
  const local: State = { ...two, tasks: two.tasks.map((c) => ({ ...c, created: true as const })) };
  assert.equal(reduce(local, { type: 'closeTask', taskId: 'board:item1' }).state, local);
});

test('closeMissing closes the stopped missing tasks of the stage in one reduction, with no effect, and leaves the running and deleting ones, orphans, tasks on the source and other stages; nothing closable keeps the same state (#279)', () => {
  const at = (n: number, stage: string, extra: Partial<Task> = {}): Task => ({ item: item(n), stage, boardColumn: 'Backlog', auto: true, ...extra });
  const workers: Worker[] = [
    { id: 's1', status: 'working', runId: 'worker-2', activityId: activityIdOf('board:item2') }, // task 2's automatic worker
    { id: 's2', status: 'working', runId: 'worker-3', activityId: activityIdOf('board:item3'), freeSession: true }, // a Claude session on task 3 (#164)
  ];
  const state: State = {
    ...withWork(withWork(withWork(base(2), 'board:item2', { workerId: 's1' }), 'board:item3'), 'board:item5', { deleting: true }), workers, // #629: the activities the workers point at; 2's holds its run, 5's the mark
    tasks: [
      at(1, 'spec', { missing: true }), at(2, 'spec', { missing: true }), at(3, 'spec', { missing: true }),
      at(4, 'spec', { missing: true }), at(5, 'spec', { missing: true }), at(6, 'spec', { orphan: true }),
      at(7, 'spec'), at(8, 'dev', { missing: true }), at(9, 'spec', { missing: true }),
    ],
  };
  const closed = reduce(state, { type: 'closeMissing', stage: 'spec' });
  assert.deepEqual(closed.state.tasks.map((c) => c.item.id), ['2', '3', '5', '6', '7', '8']);
  assert.deepEqual(closed.effects, [], 'none of them holds a worker: nothing to kill, and the worktrees stay (#182)');
  assert.equal(closed.state.workers, state.workers, 'no worker freed');
  assert.equal(reduce(closed.state, { type: 'closeMissing', stage: 'spec' }).state, closed.state, 'nothing closable left: same object');
  assert.equal(reduce(state, { type: 'closeMissing', stage: 'nope' }).state, state, 'unknown stage: same object');
});

const twoWorkspaces = (max: number): State => ({ ...base(max), workspaces: ['hive', 'site'] });

test('setWorkspaces stores the names and the source default, drops a stale default, and fills: a task that resolved to none becomes a candidate (#179)', () => {
  const waiting = polled(twoWorkspaces(1), [listed(1)]);
  assert.deepEqual(waiting.effects, [], 'two workspaces, no rule: no workspace, no spawn');
  const { state, effects } = reduce(waiting.state, { type: 'setWorkspaces', workspaces: ['hive', 'site'], sourceWorkspaces: { board: 'site' }, commands: {}, workspaceColors: {} });
  assert.deepEqual([state.workspaces, state.sourceWorkspaces], [['hive', 'site'], { board: 'site' }]);
  assert.deepEqual(effects.map((e) => e.type), ['spawn']);
  assert.equal(task(state, 1)?.workspace, 'site', 'the spawn froze the board default');
  assert.deepEqual(reduce(state, { type: 'setWorkspaces', workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, workspaceColors: {} }).state.sourceWorkspaces, {});
});

test('setWorkspaces leaves every task as it is: an activity\'s workspace is frozen at its birth, so a save never re-resolves a worktree onto another workspace (#179, #629)', () => {
  const legacy: Task = { item: item(1), stage: 'dev', boardColumn: 'In progress', auto: true };
  const noWorktree: Task = { item: item(2), stage: 'spec', boardColumn: 'Backlog', auto: true };
  const already: Task = { item: item(3), stage: 'dev', boardColumn: 'In progress', auto: true, workspace: 'other' };
  const held = withLive(withLive({ ...base(0), tasks: [legacy, noWorktree, already] }, 1, { worktree: WORKTREE }), 3, { worktree: '/w3', workspace: 'other' });
  const { state: next } = reduce(held, { type: 'setWorkspaces', workspaces: ['hive'], sourceWorkspaces: {}, commands: {}, workspaceColors: {} }); // no free worker: no fill
  assert.deepEqual([task(next, 1)?.workspace, work(next, 1)?.workspace], [undefined, 'hive'], 'a worktree: its activity holds the workspace it was born in');
  assert.equal(task(next, 2)?.workspace, undefined, 'no worktree: nothing to freeze');
  assert.deepEqual([task(next, 3)?.workspace, work(next, 3)?.workspace], ['other', 'other'], 'left as it is, even though "other" is not a workspace here');
});

test('setWorkspaces carries the workspaces\' colours into the state with their names (#78)', () => {
  const workspaceColors = { hive: 'oklch(0.72 0.12 25)', site: '#a1b2c3' };
  const { state } = reduce(base(0), { type: 'setWorkspaces', workspaces: ['hive', 'site'], sourceWorkspaces: {}, commands: {}, workspaceColors });
  assert.deepEqual(state.workspaceColors, workspaceColors);
});

test('setWorkspaces stores each workspace\'s command names and a later save replaces them, with no fill of its own for them (#300)', () => {
  const { state } = reduce(base(0), { type: 'setWorkspaces', workspaces: ['hive', 'site'], sourceWorkspaces: {}, commands: { hive: ['Run Frontend'], site: [] }, workspaceColors: {} });
  assert.deepEqual(state.commands, { hive: ['Run Frontend'], site: [] });
  assert.deepEqual(reduce(state, { type: 'setWorkspaces', workspaces: ['hive'], sourceWorkspaces: {}, commands: { hive: [] }, workspaceColors: {} }).state.commands, { hive: [] });
  assert.deepEqual(initialState(1).commands, {}, 'until the config sets them');
});

test('setWorkspace sets the workspace of a fresh task and fills; it ignores an unknown name, an unknown task, and a task with a worktree or a session (#179)', () => {
  const waiting = polled(twoWorkspaces(1), [listed(1), listed(2)]).state;
  const { state, effects } = reduce(waiting, { type: 'setWorkspace', taskId: 'board:item2', workspace: 'site' });
  assert.equal(task(state, 2)?.workspace, 'site');
  assert.deepEqual(effects.map((e) => e.type), ['spawn'], 'now a candidate: the fill takes it');
  assert.equal(reduce(waiting, { type: 'setWorkspace', taskId: 'board:item1', workspace: 'nope' }).state, waiting);
  assert.equal(reduce(waiting, { type: 'setWorkspace', taskId: 'nope', workspace: 'site' }).state, waiting);
  const ran: State = withLive(waiting, 1, { worktree: '/w' }); // #629: the worktree is the activity's
  assert.equal(reduce(ran, { type: 'setWorkspace', taskId: 'board:item1', workspace: 'site' }).state, ran);
  assert.equal(reduce(state, { type: 'setWorkspace', taskId: 'board:item2', workspace: 'hive' }).state, state, 'running, with a session: frozen');
});

test('the spawn freezes the resolved workspace on the task and a later hint does not move it; worktreeReady freezes it too (#179)', () => {
  const hinted = (hint: string): SourceItem => ({ item: { ...item(1), workspaceHint: hint }, column: 'Backlog' });
  const first = polled(twoWorkspaces(1), [hinted('site')]);
  assert.equal(task(first.state, 1)?.workspace, 'site');
  const spawn = first.effects.find((e) => e.type === 'spawn');
  assert.equal(spawn?.type === 'spawn' ? spawn.task.workspace : undefined, 'site', 'the spawn effect\'s task carries it');
  const repolled = polled(first.state, [hinted('hive')]).state;
  assert.equal(task(repolled, 1)?.item.workspaceHint, 'hive', 'mergeTasks copies the fresh hint');
  assert.equal(task(repolled, 1)?.workspace, 'site', 'frozen: the hint no longer decides');
  const manual: State = { ...twoWorkspaces(1), sourceWorkspaces: { board: 'site' }, tasks: [{ item: item(2), stage: 'spec', boardColumn: 'Backlog', auto: false }] };
  const opened = born(manual, 2); // #629: the first open makes the activity first
  const ready = reduce(opened, { type: 'worktreeReady', activityId: ACT(opened, 2), path: '/w/2', branch: 'hive/2-task-2', base: null, local: false }).state;
  assert.equal(task(ready, 2)?.workspace, 'site');
});

test('start with a workspace sets it and starts; an unknown name, a task with a session, or no workspace on a task that resolves to none starts nothing (#179)', () => {
  const waiting = polled(signaled(twoWorkspaces(1), 'yellow').state, [listed(1)]).state;
  assert.equal(started(waiting, 'board:item1').state, waiting, 'no workspace: the route refuses it, the reducer ignores it');
  assert.equal(reduce(waiting, { type: 'start', itemId: 'board:item1', workspace: 'nope' }).state, waiting);
  const { state, effects } = reduce(waiting, { type: 'start', itemId: 'board:item1', workspace: 'site' });
  assert.equal(task(state, 1)?.workspace, 'site');
  assert.deepEqual(effects.map((e) => e.type), ['spawn']);
  const ran: State = withMade(withLive(waiting, 1, { sessionId: 'kept-session-id-0001' }), 1, { sessions: [keptSession('kept-session-id-0001')] }); // #629: the activity's
  assert.equal(reduce(ran, { type: 'start', itemId: 'board:item1', workspace: 'site' }).state, ran);
});

test('createTask with a Comb workspace sets task.workspace; an unknown one is ignored (#179)', () => {
  const two = signaled(twoWorkspaces(0), 'yellow').state;
  const make = (workspace: string) => reduce(two, { type: 'createTask', title: 'x', body: '', stage: 'spec', prefix: 'HIVE', auto: true, workspace }).state.tasks[0];
  assert.equal(make('site').workspace, 'site');
  assert.equal('workspace' in make('nope'), false);
});

test('createTask with auto false leaves the new task to its creator, so the fill never takes it; with auto true the task is auto (redesign 03, #573)', () => {
  const two = signaled(twoWorkspaces(0), 'yellow').state;
  const make = (auto: boolean) => reduce(two, { type: 'createTask', title: 'x', body: '', stage: 'spec', prefix: 'HIVE', auto }).state.tasks[0];
  assert.equal(make(false).auto, false);
  assert.equal(make(true).auto, true);
});

test('createTask keeps the url and the origin on the new item and returns a new state; without them the url is empty and there is no origin (#756)', () => {
  const two = signaled(twoWorkspaces(0), 'yellow').state;
  const before = two.tasks.length;
  const { state } = reduce(two, { type: 'createTask', title: 'x', body: 'b', stage: 'spec', prefix: 'HIVE', auto: false, url: 'https://github.com/acme/r/issues/12', origin: 'board:PVTI_12' });
  const made = state.tasks.find((c) => c.created)!.item;
  assert.deepEqual([made.url, made.origin], ['https://github.com/acme/r/issues/12', 'board:PVTI_12']);
  assert.notEqual(state, two);
  assert.equal(two.tasks.length, before, 'the input state is untouched');
  const plain = reduce(two, { type: 'createTask', title: 'x', body: '', stage: 'spec', prefix: 'HIVE', auto: true }).state.tasks.find((c) => c.created)!.item;
  assert.deepEqual([plain.url, 'origin' in plain], ['', false]);
});

test('createTask with pr adds exactly one record holding the PR for the new task and no activity, so taskOfPr finds it; without pr the records stay as they are (#67)', () => {
  const two = signaled(twoWorkspaces(0), 'yellow').state;
  const link = 'https://github.com/acme/app/pull/7';
  const recordId = '0d9a2f3e-1111-4222-8333-444455556666';
  const { state } = reduce(two, { type: 'createTask', title: 'The PR', body: '', stage: 'spec', prefix: 'HIVE', auto: false, url: link, pr: { url: link, recordId } });
  const made = state.tasks.find((c) => c.created)!.item.itemId;
  assert.deepEqual(state.activityRecords.slice(0, two.activityRecords.length), two.activityRecords, 'the records before it stay');
  assert.deepEqual(state.activityRecords.slice(two.activityRecords.length), [{ id: recordId, taskIds: [made], sessions: [], prs: [{ url: link, state: 'open' }] }]);
  assert.deepEqual(state.activities, two.activities, 'no activity is created');
  assert.equal(taskOfPr(state, link)?.item.itemId, made);
  assert.deepEqual(prsOf(state, made), [{ url: link, state: 'open' }]);
  const plain = reduce(two, { type: 'createTask', title: 'x', body: '', stage: 'spec', prefix: 'HIVE', auto: false }).state;
  assert.deepEqual(plain.activityRecords, two.activityRecords, 'no pr: no record');
});

test('a task writes only to its own source: its source\'s onStart and onFinish, nothing where its source has no entry (#180)', () => {
  const stages: LegacyStage[] = [
    { name: 'dev', from: { board: ['Ready'], notes: ['todo'] }, onStart: { board: [move('In progress')] }, onFinish: { notes: [move('review')] }, prompt: 'x' },
  ];
  const notesTask: Item = { ...item(2), itemId: 'notes:2', source: 'notes' };
  const tasks: Task[] = [
    { item: item(1), stage: 'dev', boardColumn: 'Ready', auto: true },
    { item: notesTask, stage: 'dev', boardColumn: 'todo', auto: true },
  ];
  const writes = (effects: Effect[]) => effects.flatMap((e) => (e.type === 'setColumn' ? [[e.itemId, e.column]] : []));
  const workerOf = (s: State, id: string): string => s.workers.find((x) => ownerOf(s, x) === id)?.runId ?? '';
  const one = started({ ...base(2, stages), tasks }, 'board:item1');
  assert.deepEqual(writes(one.effects), [['board:item1', 'In progress']]);
  const two = started(one.state, 'notes:2');
  assert.deepEqual(writes(two.effects), [], 'notes has no onStart');
  assert.deepEqual(writes(stopped(two.state, workerOf(two.state, 'notes:2')).effects), [['notes:2', 'review']]);
  assert.deepEqual(writes(stopped(two.state, workerOf(two.state, 'board:item1')).effects), [], 'board has no onFinish');
});

test('a source\'s poll merges only its own tasks and stamps its polledAt, clearing its error; a source the Comb no longer has changes nothing; a source-less poll merges nothing yet marks a removed source\'s tasks (#180)', () => {
  const first = polled({ ...base(0), syncs: { board: { error: 'boom' }, notes: {} } }, [listed(1, 'Ready')]).state;
  assert.ok(first.syncs.board.polledAt);
  assert.equal('error' in first.syncs.board, false);
  assert.deepEqual(first.syncs.notes, {});
  const notes = reduce(first, { type: 'poll', source: 'notes', items: [] }).state;
  assert.deepEqual(notes.tasks.map((c) => [c.item.itemId, c.missing === true]), [['board:item1', false]], 'the notes poll leaves board\'s task alone');
  assert.equal(reduce(first, { type: 'poll', source: 'gone', items: [listed(2, 'Ready')] }).state, first);
  const sourceless = reduce({ ...first, syncs: { notes: {} } }, { type: 'poll', items: [] }).state; // source left the Comb (setSources)
  assert.equal(sourceless.tasks[0].missing, true, 'its board is gone');
  assert.deepEqual(sourceless.sourceOrder, first.sourceOrder, 'nothing merged');
});

test('pollFailed records the error on its source and leaves every task as it is; the next success clears it (#180)', () => {
  const first = polled({ ...base(0), syncs: { board: {}, notes: {} } }, [listed(1, 'Ready')]).state;
  const failed = reduce(first, { type: 'pollFailed', source: 'board', message: 'gh: 502' });
  assert.deepEqual([failed.state.tasks, failed.effects], [first.tasks, []]);
  assert.equal(failed.state.syncs.board.error, 'gh: 502');
  assert.equal(failed.state.syncs.board.polledAt, first.syncs.board.polledAt, 'the last success stands');
  assert.equal(polled(failed.state, [listed(1, 'Ready')]).state.syncs.board.error, undefined);
  assert.equal(reduce(first, { type: 'pollFailed', source: 'gone', message: 'x' }).state, first, 'a removed board records nothing');
});

test('renameSources carries a source to its new name (#278): every task of it, missing and orphan ones too, the running one\'s worker, the source order and its status; another source\'s task stays; a poll of the new name then matches every task', () => {
  const first = filled(1, 3).state; // item1 runs in spec, item2 and item3 wait
  const notes: Task = { item: { ...item(9), itemId: 'notes:item9', source: 'notes' }, stage: 'review', boardColumn: 'In review', auto: true };
  const marked: State = {
    ...first,
    syncs: { ...first.syncs, notes: {}, work: { error: 'a removed board of that name' } },
    tasks: [
      ...first.tasks.map((c) => (c.item.itemId === 'board:item2' ? { ...c, missing: true as const } : c.item.itemId === 'board:item3' ? { ...c, orphan: true as const } : c)),
      notes,
    ],
  };
  const { state, effects } = reduce(marked, { type: 'renameSources', renames: { board: 'work' } });
  assert.deepEqual(effects, []);
  assert.deepEqual(state.tasks.map((c) => [c.item.itemId, c.item.source, c.missing, c.orphan]), [
    ['work:item1', 'work', undefined, undefined], ['work:item2', 'work', true, undefined], ['work:item3', 'work', undefined, true], ['notes:item9', 'notes', undefined, undefined],
  ]);
  assert.deepEqual(state.tasks.map((c) => [c.stage, c.item.id]), marked.tasks.map((c) => [c.stage, c.item.id]), 'stage and the shown id stay');
  assert.equal(activityOf(state, 'work:item1')?.slug, work(marked, 1)?.slug, 'the slug stays: its activity\'s, whose record follows the rename (#629)');
  assert.equal(ownerAt(state, 0), 'work:item1');
  assert.equal(state.workers[0].runId, first.workers[0].runId, 'the same worker holds it');
  assert.equal(activityOf(state, 'work:item1')?.workerId, state.workers[0].id, 'worker and activity still point at each other (#629)');
  assert.deepEqual(state.sourceOrder, ['work:item1', 'work:item2', 'work:item3']);
  assert.deepEqual(state.syncs, { work: first.syncs.board, notes: {} }, 'the status moves with its board; the stale one under the new name gives way');
  assert.equal(reduce(marked, { type: 'renameSources', renames: {} }).state, marked, 'an empty map: the same state');
  const onWork = (n: number): SourceItem => ({ item: { ...item(n), itemId: `work:item${n}`, source: 'work' }, column: 'Backlog' });
  const next = reduce(state, { type: 'poll', source: 'work', items: [onWork(1), onWork(2), onWork(3)] }).state;
  assert.deepEqual(next.tasks.map((c) => [c.item.itemId, c.missing === true]), [
    ['work:item1', false], ['work:item2', false], ['work:item3', false], ['notes:item9', false],
  ], 'seen again under the new name: no task lost, none added');
});

test('a start whose slug another task of the same workspace owns spawns nothing: the task carries the reason and leaves the fill; a manual start meets the same owner; another workspace\'s task is no owner (#180)', () => {
  const stages: LegacyStage[] = [{ name: 'dev', from: { board: ['Ready'], notes: ['Ready'] }, prompt: 'x' }, { name: 'review', from: {} }];
  const twin = (board: string): Task => ({ item: { ...item(12), itemId: `${board}:12`, source: board }, stage: 'dev', boardColumn: 'Ready', auto: true });
  const owner: Task = { ...twin('board'), stage: 'review' };
  const owning = (s: State, workspace = 'hive'): State => withWork(s, 'board:12', { slug: 'hive-12-task-12', worktree: '/w', workspace }); // #629: the worktree is its activity's
  const { state, effects } = reduce(owning({ ...base(1, stages), tasks: [owner, twin('notes')] }), { type: 'setSignal', signal: 'green' });
  assert.deepEqual(effects, [], 'no spawn');
  assert.equal(activityOf(state, 'notes:12')?.error, 'slug hive-12-task-12 is used by 12', 'on its activity, born for it (#629)');
  assert.equal(state.error, 'slug hive-12-task-12 is used by 12', 'the bar says it too');
  assert.deepEqual(reduce(state, { type: 'start', itemId: 'notes:12' }).effects, []);
  const elsewhere: State = owning({ ...base(1, stages), workspaces: ['hive', 'site'], tasks: [{ ...owner, workspace: 'site' }, { ...twin('notes'), workspace: 'hive' }] }, 'site');
  assert.deepEqual(reduce(elsewhere, { type: 'setSignal', signal: 'green' }).effects.map((e) => e.type), ['spawn']);
});

test('a session records every stage it ran in and when the Hive last put it to work (#236): a new spawn, an in-place continuation, a continue spawn and a manual resume; the same stage twice in a row is kept once', () => {
  const first = filled(1, 1).state; // spec: a new session
  const [spec] = sessionsN(first, 1);
  assert.deepEqual(spec, { id: work(first, 1)?.sessionId, startedAt: first.workers[0].startedAt, stages: ['spec'], agent: 'claude', lastUsedAt: first.workers[0].startedAt });
  const [inPlace] = sessionsN(stopped(first, first.workers[0].runId!).state, 1); // green: dev continues the session in the same process
  assert.deepEqual([inPlace.id, inPlace.startedAt, inPlace.stages], [spec.id, spec.startedAt, ['spec', 'dev']]);
  assert.ok(inPlace.lastUsedAt >= spec.lastUsedAt, 'used again now');
  const parked = stopped(signaled(first, 'red').state, first.workers[0].runId!).state; // red: the session dies, the task waits in dev
  const respawned = signaled(parked, 'green');
  assert.ok(respawned.effects.some((e) => e.type === 'spawn' && e.session === 'continue'));
  assert.deepEqual(sessionsN(respawned.state, 1).map((s) => [s.id, s.stages]), [[spec.id, ['spec', 'dev']]], 'a continue spawn: the same session, one stage more');
  const at = '2026-09-22T10:00:00.000Z';
  const ran = withMade(manualState(2, { sessionId: 'kept-session-id-0001', enteredAt: at }), 1, { sessions: [{ id: 'kept-session-id-0001', startedAt: at, stages: ['spec'], agent: 'claude' as const, lastUsedAt: at }] });
  const resumed = reduce(ran, { type: 'openSession', activityId: workId(ran, 'board:item1'), continueId: 'kept-session-id-0001' }).state;
  assert.deepEqual(sessionsN(resumed, 1), [{ id: 'kept-session-id-0001', startedAt: '2026-09-22T10:00:00.000Z', stages: ['spec'], agent: 'claude', lastUsedAt: occupied(resumed)[0].startedAt }], 'resumed in the stage it ran in: no repeat');
});

test('cleaned and worktreeRemoved forget only what the scope removed (#236): the worktree, its branch and the id a continue would resume with worktree on (#208), the sessions and the id a continue would resume with session on; the PRs stay; setCleanup replaces the scope with no effects', () => {
  const SESSIONS_TOO: DeleteActivityScope = { session: true, transcripts: true, nonAutoTasks: false };
  // git's fields on the task's activity and the session id on the task, then whether its records still hold a session (#629)
  const left = (s: State): boolean[] => [work(s, 1)?.worktree !== undefined, work(s, 1)?.branch !== undefined, holds(s, 1, 'sessionId'), sessionsN(s, 1).length > 0];
  const first = polled(base(1, DELETE_STAGES), [listed(1, 'Done')]).state; // in done, 5d to go: the test marks it deleting itself
  const sessions = [{ id: 'kept-session-id-0001', startedAt: PAST, stages: ['dev'], agent: 'claude' as const, lastUsedAt: PAST }];
  const pr = 'https://github.com/o/r/pull/1';
  const inFlight = (deleteActivity: DeleteActivityScope): State => withMade(withLive({
    ...first, deleteActivity,
  }, 1, { worktree: WORKTREE, branch: 'hive/1-task-1', deleting: true, sessionId: 'kept-session-id-0001' }), 1, { sessions, prs: [{ url: pr, state: 'open' }] });
  const cleanedWith = (deleteActivity: DeleteActivityScope): State => {
    const flying = inFlight(deleteActivity);
    return reduce(flying, { type: 'activityDeleted', activityId: ACT(flying, 1) }).state;
  };
  assert.deepEqual(left(cleanedWith(DELETE_ACTIVITY_DEFAULTS)), [false, false, false, true], 'today\'s scope: git\'s fields and the session id go, the sessions stay (in the main repo, #208)');
  assert.deepEqual(left(cleanedWith(SESSIONS_TOO)), [false, false, false, false]);
  assert.deepEqual([prsN(cleanedWith(SESSIONS_TOO), 1), task(cleanedWith(SESSIONS_TOO), 1)?.stage], [[{ url: pr, state: 'open' }], 'archive']);
  const idle = ranOnce(1); // stopped in spec with its worktree, branch and session; yellow
  const removedWith = (deleteActivity: DeleteActivityScope): State => {
    const scoped = reduce(idle, { type: 'setDeleteActivity', deleteActivity }).state;
    const marked = reduce(scoped, { type: 'deletingActivity', activityId: workId(scoped, 'board:item1') }).state;
    return reduce(marked, { type: 'activityRemoved', activityId: workId(marked, 'board:item1') }).state;
  };
  assert.deepEqual(left(removedWith(DELETE_ACTIVITY_DEFAULTS)), [false, false, false, true]);
  assert.deepEqual(left(removedWith(SESSIONS_TOO)), [false, false, false, false]);
  assert.equal(task(removedWith(SESSIONS_TOO), 1)?.stage, 'spec', 'outside a delete activity stage it stays where it is');
  const set = reduce(idle, { type: 'setDeleteActivity', deleteActivity: SESSIONS_TOO });
  assert.deepEqual([set.state.deleteActivity, set.effects], [SESSIONS_TOO, []]);
});

test('a removal that covers the worktree forgets its path, branch, session id and gone mark and moves every session to the main repo; with the sessions in scope no session is left (#208)', () => {
  const first = polled(base(1, DELETE_STAGES), [listed(1, 'Done')]).state; // in done, 5d to go: the test marks it deleting itself
  const sessions = [{ id: 'kept-session-id-0001', startedAt: PAST, stages: ['dev'], agent: 'claude' as const, lastUsedAt: PAST }, { id: 'kept-session-id-0002', startedAt: PAST, stages: ['done'], agent: 'claude' as const, lastUsedAt: PAST }];
  const inFlight = (deleteActivity: DeleteActivityScope): State => withMade(withLive({
    ...first, deleteActivity,
  }, 1, { worktree: WORKTREE, branch: 'hive/1-task-1', worktreeGone: true, deleting: true, sessionId: 'kept-session-id-0002' }), 1, { sessions });
  // #629: the path, the branch and the gone mark are the activity's, which goes; the session id is the task's
  const forgotten = (s: State): boolean[] => [work(s, 1)?.worktree !== undefined, work(s, 1)?.branch !== undefined, holds(s, 1, 'sessionId'), work(s, 1)?.worktreeGone === true];
  const answered = (deleteActivity: DeleteActivityScope): State => {
    const flying = inFlight(deleteActivity);
    return reduce(flying, { type: 'activityDeleted', activityId: ACT(flying, 1) }).state;
  };
  const deleted = answered(DELETE_ACTIVITY_DEFAULTS);
  assert.deepEqual(forgotten(deleted), [false, false, false, false]);
  assert.deepEqual(sessionsN(deleted, 1), sessions.map((s) => ({ ...s, repo: true })), 'each one opens in the main repo from now on');
  const idle = markGone(ranOnce(1)); // spec: not a delete activity stage
  const marked = reduce(idle, { type: 'deletingActivity', activityId: workId(idle, 'board:item1') }).state;
  const removed = reduce(marked, { type: 'activityRemoved', activityId: workId(marked, 'board:item1') }).state;
  assert.deepEqual(forgotten(removed), [false, false, false, false]);
  assert.deepEqual(sessionsN(removed, 1).map((s) => [s.id, s.repo]), [[work(idle, 1)?.sessionId, true]]);
  const both = answered({ ...DELETE_ACTIVITY_DEFAULTS, session: true });
  assert.deepEqual([...forgotten(both), sessionsN(both, 1).length > 0], [false, false, false, false, false]);
});

test('a SessionStart and worktreeReady write the path again and drop the worktreeGone mark (#208)', () => {
  const marked = markGone(ranOnce(1));
  const again = started(marked, 'board:item1').state; // stopped (#283): a start runs it, and the spawn recreates the worktree (ensureWorktree)
  const seen = hook(again, again.workers[0].runId!, { hook_event_name: 'SessionStart', cwd: WORKTREE }).state;
  assert.deepEqual([work(seen, 1)?.worktree, 'worktreeGone' in (work(seen, 1) ?? {})], [WORKTREE, false]);
  const manual: State = { ...marked, tasks: marked.tasks.map((c) => ({ ...c, auto: false as const })) };
  const ready = reduce(manual, { type: 'worktreeReady', activityId: ACT(manual, 1), path: WORKTREE, branch: 'hive/1-task-1', base: null, local: false }).state;
  assert.deepEqual([work(ready, 1)?.worktree, work(ready, 1)?.branch, 'worktreeGone' in (work(ready, 1) ?? {})], [WORKTREE, 'hive/1-task-1', false]);
});

test('a delete activity stage with nothing the scope covers on the task just moves it on (#236): no effect and no mark, onFinish written, the next stage entered; a start with something to clean still gets the effect with the scope', () => {
  const stages: LegacyStage[] = [DELETE_STAGES[0], { ...DELETE_STAGES[1], after: undefined }, DELETE_STAGES[2]];
  const entered = polled(base(1, stages), [listed(1, 'Done')]); // never ran: no worktree, no session
  assert.deepEqual(entered.effects, [{ type: 'setColumn', itemId: 'board:item1', column: 'Archived' }]);
  assert.deepEqual([task(entered.state, 1)?.stage, work(entered.state, 1)?.deleting], ['archive', undefined]);
  const parked = (deleteActivity: DeleteActivityScope): State => ({ ...parkedIn(stages), deleteActivity });
  const deleting = started(parked(DELETE_ACTIVITY_DEFAULTS), 'board:item1');
  assert.deepEqual(deleting.effects, [deletion(deleting.state, 1)]);
});

test('waitingSince is stamped when a worker enters waiting, kept while it stays there, and dropped when it leaves, the in-place continuation included (#233)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  assert.equal(first.workers[0].waitingSince, undefined);
  const idle = hook(first, id, { hook_event_name: 'Stop' }).state; // no hive_done: the worker waits for the user
  const since = idle.workers[0].waitingSince;
  assert.ok(idle.workers[0].status === 'waiting' && since);
  const noticed = hook(idle, id, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' }).state;
  assert.equal(noticed.workers[0].waitingSince, since, 'the same wait: the clock does not restart');
  const back = hook(noticed, id, { hook_event_name: 'UserPromptSubmit' }).state;
  assert.equal(back.workers[0].status, 'working');
  assert.equal('waitingSince' in back.workers[0], false, 'dropped, not kept as undefined');
  const asked = reduce(back, { type: 'ask', ptyId: id, question: 'Which base?' }).state;
  assert.ok(asked.workers[0].waitingSince, 'hive_ask enters waiting too');
  const continued = stopped(asked, id); // hive_done + Stop under green: spec continues into dev in place
  assert.equal(continued.effects.at(-1)?.type, 'continue');
  assert.equal(continued.state.workers[0].status, 'working');
  assert.equal('waitingSince' in continued.state.workers[0], false, 'the continuation leaves waiting');
});

// Shut down when done (#233)
const MINUTE = 60_000;
const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString();
const armed = (state: State) => reduce(state, { type: 'setShutdown', armed: true });
const ticked = (state: State) => reduce(state, { type: 'tick' });
// One worker waiting for the user since `waitedMs` ago, the mode armed `armedMs` ago, the default 10-minute window
function waitingArmed(waitedMs: number, armedMs: number): State {
  const first = filled(1, 1).state;
  const idle = hook(first, first.workers[0].runId!, { hook_event_name: 'Stop' }).state;
  return { ...idle, workers: idle.workers.map((s) => ({ ...s, waitingSince: agoIso(waitedMs) })), shutdown: { armedAt: agoIso(armedMs) } };
}

test('armed, the signal is the flow\'s: under green a free worker takes a new task, and a manual red stays red (#233, #727)', () => {
  const armed = reduce(polled(base(2), many(1)).state, { type: 'setShutdown', armed: true });
  assert.equal(effectiveLimits(armed.state, Date.now()).signal, 'green');
  const red = reduce(signaled(base(1), 'red').state, { type: 'setShutdown', armed: true }).state;
  assert.equal(effectiveLimits(red, Date.now()).signal, 'red');
});

test('armed, a worker waiting past the window is closed as by Stop, the window counted from the later of its wait and the arming; the task is stopped, nothing restarts it, and its exit shuts the Mac down (#233)', () => {
  assert.deepEqual(ticked(waitingArmed(9 * MINUTE, 20 * MINUTE)).effects, [], 'waiting 9 min: inside the window');
  assert.deepEqual(ticked(waitingArmed(30 * MINUTE, 9 * MINUTE)).effects, [], 'waiting 30 min, armed 9 min ago: the window counts from the arming');
  const due = waitingArmed(11 * MINUTE, 20 * MINUTE);
  assert.deepEqual(reduce(due, { type: 'setShutdownIdle', minutes: 30 }).effects, [], 'a longer window from a save: not due');
  const closed = ticked(due);
  assert.deepEqual(closed.effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: due.workers[0].runId }]);
  assert.equal(work(closed.state, 1)?.stopped, true, 'closed as by Stop (#283): no signal restarts it');
  assert.ok(closed.state.shutdown, 'the worker frees only on the exit: still armed');
  const exited = reduce(closed.state, { type: 'exit', ptyId: due.workers[0].runId! });
  assert.deepEqual(exited.effects, [{ type: 'shutdown' }], 'yellow does not start it again: nothing runs');
  assert.equal(exited.state.shutdown, undefined);
});

test('armed with no worker occupied, the reduction disarms and emits shutdown once; a task in flight with no worker holds nothing; unarmed, the same states emit nothing and close nothing (#233)', () => {
  const idle = armed(base(1));
  assert.deepEqual(idle.effects, [{ type: 'shutdown' }], 'an idle Hive shuts down at once');
  assert.equal(idle.state.shutdown, undefined);
  assert.deepEqual(ticked(idle.state).effects, [], 'once');
  assert.deepEqual(armed(ranOnce()).effects, [{ type: 'shutdown' }], 'in flight but parked (red here): nothing runs, nothing would finish');
  const { shutdown: _shutdown, ...unarmed } = waitingArmed(11 * MINUTE, 20 * MINUTE);
  const still = ticked(unarmed);
  assert.equal(still.state, unarmed, 'unarmed: same object, nothing closed');
  assert.deepEqual(still.effects, []);
});

test('boot drops the mode: a restart never shuts the Mac down (#233)', () => {
  const running = armed(filled(1, 1).state).state;
  assert.ok(running.shutdown);
  const booted = reduce(running, { type: 'boot' });
  assert.equal(booted.state.shutdown, undefined);
  assert.deepEqual(booted.effects, []);
});

// Totals per task (#248). The first worker of a state as if its clock had run: a start, a wait, a last hook in the past
const backdated = (state: State, changes: Partial<Worker>): State => ({ ...state, workers: state.workers.map((s, i) => (i === 0 ? { ...s, ...changes } : s)) });

test('a worker adds each wait to waitedMs as it leaves waiting, the in-place continuation included, and every hook of a live worker stamps seenAt (#248)', () => {
  const first = filled(1, 1).state; // green: spec continues into dev in place
  const id = first.workers[0].runId!;
  const tool = hook(first, id, { hook_event_name: 'PreToolUse', tool_name: 'Bash' }).state;
  assert.ok(tool.workers[0].seenAt && Date.parse(tool.workers[0].seenAt) >= Date.parse(first.workers[0].startedAt!), 'the last hook of the run');
  const idle = backdated(hook(tool, id, { hook_event_name: 'Stop' }).state, { waitingSince: agoIso(5 * MINUTE) });
  const back = hook(idle, id, { hook_event_name: 'UserPromptSubmit' }).state;
  const once = back.workers[0].waitedMs ?? 0;
  assert.ok(once >= 5 * MINUTE && once < 6 * MINUTE, `the wait that ended: ${once}`);
  const asked = backdated(reduce(back, { type: 'ask', ptyId: id, question: 'Which base?' }).state, { waitingSince: agoIso(2 * MINUTE) });
  const continued = stopped(asked, id); // hive_done + Stop: dev continues the session in place
  assert.equal(continued.effects.at(-1)?.type, 'continue');
  assert.ok((continued.state.workers[0].waitedMs ?? 0) >= once + 2 * MINUTE, 'the continuation leaves waiting outside patch: that wait counts too');
});

test('a Stop adds its delta to the task\'s usage.tokens and writes the transcript total as its session\'s tokens; the next Stop adds only the new delta, the same one the budget gets (#248)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const sessionId = work(first, 1)!.sessionId!;
  const started = hook(first, id, { hook_event_name: 'SessionStart', cwd: WORKTREE, session_id: sessionId }).state;
  const turn = (state: State, tokens: number): State => reduce(state, { type: 'hook', ptyId: id, payload: { hook_event_name: 'Stop' }, tokens }).state;
  const one = turn(started, 1000);
  assert.deepEqual([usageN(one, 1), sessionsN(one, 1)?.[0].tokens], [{ tokens: 1000, ms: 0, waitingMs: 0 }, 1000]);
  const two = turn(one, 1500);
  assert.deepEqual([usageN(two, 1)?.tokens, sessionsN(two, 1)?.[0].tokens], [1500, 1500]);
  assert.deepEqual(two.usage.map((s) => s.tokens), [1000, 500], 'the budget and the task count the same deltas');
});

test('a turn end with a title names the worker\'s session; one without keeps the name; the last /rename wins; the state it reduced is not mutated (#489)', () => {
  const first = filled(1, 1).state;
  const id = first.workers[0].runId!;
  const sessionId = work(first, 1)!.sessionId!;
  const started = hook(first, id, { hook_event_name: 'SessionStart', cwd: WORKTREE, session_id: sessionId }).state;
  const turn = (state: State, tokens: number, title?: string): State =>
    reduce(state, { type: 'hook', ptyId: id, payload: { hook_event_name: 'Stop' }, tokens, title }).state;
  const before = structuredClone(started);
  const named = turn(started, 1000, 'fix the login');
  assert.deepEqual(started, before, 'the reducer returned a new state');
  assert.deepEqual([sessionsN(named, 1)?.[0].id, sessionsN(named, 1)?.[0].name], [sessionId, 'fix the login']);
  const kept = turn(named, 1200);
  assert.equal(sessionsN(kept, 1)?.[0].name, 'fix the login', 'no title this turn: a name is never cleared');
  assert.equal(sessionsN(kept, 1)?.[0].tokens, 1200, 'the tokens still move');
  assert.equal(sessionsN(turn(kept, 1300, 'renamed'), 1)[0]?.name, 'renamed');
  assert.equal(sessionsN(turn(started, 1000), 1)[0]?.name, undefined, 'never renamed: no name');
});

test('a spawn that resumes a session starts its worker from the session\'s last total, so the first Stop counts only what the run added, on the task and in the budget; a manual resume too; a new session starts empty (#248)', () => {
  const sessions = [{ id: 'kept-session-id-0001', startedAt: PAST, stages: ['spec'], agent: 'claude' as const, lastUsedAt: PAST, tokens: 1000 }];
  const known: State = withMade(withLive({ ...base(1), tasks: [{ item: item(1), stage: 'dev', boardColumn: 'In progress', auto: true }] }, 1, { sessionId: 'kept-session-id-0001' }), 1, { sessions });
  const resumed = reduce(known, { type: 'setSignal', signal: 'green' });
  assert.equal(resumed.effects[0].type === 'spawn' && resumed.effects[0].session, 'continue');
  assert.equal(resumed.state.workers[0].tokens, 1000);
  const id = resumed.state.workers[0].runId!;
  const started = hook(resumed.state, id, { hook_event_name: 'SessionStart', cwd: WORKTREE, session_id: 'kept-session-id-0001' }).state;
  const turned = reduce(started, { type: 'hook', ptyId: id, payload: { hook_event_name: 'Stop' }, tokens: 1200 }).state;
  assert.equal(usageN(turned, 1)?.tokens, 200);
  assert.deepEqual(turned.usage.map((s) => s.tokens), [200], 'the budget no longer counts the old turns again');
  assert.equal(sessionsN(turned, 1)?.[0].tokens, 1200);
  assert.equal(filled(1, 1).state.workers[0].tokens, undefined, 'a new session starts empty');
  const manual = withMade(manualState(1, { sessionId: 'kept-session-id-0001' }), 1, { sessions });
  const reopened = reduce(manual, { type: 'openSession', activityId: workId(manual, 'board:item1'), continueId: 'kept-session-id-0001' }).state;
  assert.equal(occupied(reopened)[0].tokens, 1000);
  assert.equal(occupied(reduce(manual, { type: 'openSession', activityId: workId(manual, 'board:item1') }).state)[0].tokens, undefined, 'a new manual session starts empty');
});

test('an exit folds the run into its task: the wall clock since it started and the waiting inside it, a wait still open closed at the exit; a manual session\'s exit too (#248)', () => {
  const first = signaled(filled(1, 1).state, 'red').state; // red: nothing takes the worker again
  const id = first.workers[0].runId!;
  const ran = backdated(first, { startedAt: agoIso(30 * MINUTE), status: 'waiting', waitedMs: 5 * MINUTE, waitingSince: agoIso(10 * MINUTE) });
  const usage = usageN(reduce(ran, { type: 'exit', ptyId: id }).state, 1)!;
  assert.ok(usage.ms >= 30 * MINUTE && usage.ms < 31 * MINUTE, `wall clock: ${usage.ms}`);
  assert.ok(usage.waitingMs >= 15 * MINUTE && usage.waitingMs < 16 * MINUTE, `the finished 5 min plus the open 10: ${usage.waitingMs}`);
  assert.equal(usage.tokens, 0);
  const given = manualState(1);
  const opened = reduce(given, { type: 'openSession', activityId: workId(given, 'board:item1') }).state;
  const session: State = { ...opened, workers: opened.workers.map((s) => (s.freeSession ? { ...s, startedAt: agoIso(20 * MINUTE) } : s)) }; // appended past the free worker (#459)
  const left = reduce(session, { type: 'exit', ptyId: session.workers[1].runId! }).state;
  assert.ok(usageN(left, 1)!.ms >= 20 * MINUTE, 'a session the user opened counts too');
});

test('a Stop that ends the stage folds the run into the task, which carries it into the next stage; an in-place continuation folds nothing, and the next release counts the whole run once (#248)', () => {
  const first = filled(1, 1).state; // green: spec continues into dev in place
  const id = first.workers[0].runId!;
  const ran = backdated(first, { startedAt: agoIso(40 * MINUTE) });
  const parked = stopped(signaled(ran, 'red').state, id).state; // red: the session dies, the task waits in dev
  assert.equal(task(parked, 1)?.stage, 'dev');
  assert.ok(usageN(parked, 1)!.ms >= 40 * MINUTE);
  const continued = stopped(ran, id);
  assert.equal(continued.effects.at(-1)?.type, 'continue');
  assert.equal(usageN(continued.state, 1), undefined, 'the same run goes on: nothing folded yet');
  const { ms } = usageN(reduce(signaled(continued.state, 'red').state, { type: 'exit', ptyId: id }).state, 1)!;
  assert.ok(ms >= 40 * MINUTE && ms < 41 * MINUTE, `the whole run, once: ${ms}`);
});

test('boot closes each dead run at its last hook, not at the restart, so the hours the Hive was down never land on a task; with no hook seen, where it started (#248)', () => {
  const two = filled(2, 2).state;
  const ran: State = { ...two, workers: two.workers.map((s, i) => ({ ...s, startedAt: agoIso(2 * HOUR_MS), ...(i === 0 ? { seenAt: agoIso(HOUR_MS) } : {}) })) };
  const booted = reduce(ran, { type: 'boot' }).state;
  const closed = usageN(booted, 1)!.ms;
  assert.ok(Math.abs(closed - HOUR_MS) < MINUTE, `closed at seenAt: ${closed}`);
  assert.equal(usageN(booted, 2)!.ms, 0, 'no hook: closed where it started');
});

test('a delete activity that drops the sessions keeps the task\'s totals, like its PRs (#236, #248)', () => {
  const first = polled(base(1, DELETE_STAGES), [listed(1, 'Done')]).state; // in done, 5d to go: the test marks it deleting itself
  const usage = { tokens: 5000, ms: HOUR_MS, waitingMs: MINUTE };
  const deleting: State = withMade(withLive({
    ...first, deleteActivity: { session: true, transcripts: true, nonAutoTasks: false },
  }, 1, { worktree: WORKTREE, deleting: true, sessionId: 'kept-session-id-0001' }), 1, { sessions: [keptSession('kept-session-id-0001')], usage });
  const deleted = reduce(deleting, { type: 'activityDeleted', activityId: ACT(deleting, 1) }).state;
  assert.equal(holds(deleted, 1, 'sessionId'), false, 'the scope dropped the sessions');
  assert.deepEqual(usageN(deleted, 1), usage);
});

test('stop on a stage worker kills it and marks the task stopped; its exit frees the worker and a free worker under green does not take it (#283)', () => {
  const first = filled(2, 1).state; // green: task 1 runs in spec, a second worker is free
  const id = first.workers[0].runId!;
  const { state, effects } = reduce(first, { type: 'stop', ptyId: id });
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: id }]);
  assert.deepEqual([work(state, 1)?.stopped, state.workers[0].status], [true, 'working'], 'the worker frees on the exit');
  const exited = reduce(state, { type: 'exit', ptyId: id });
  assert.deepEqual([exited.state.workers[0].status, work(exited.state, 1)?.workerId, work(exited.state, 1)?.stopped, exited.effects], ['empty', undefined, true, [{ type: 'forgetScrollback', ptyId: id }]]);
  assert.equal(work(exited.state, 1)?.sessionId, work(first, 1)?.sessionId, 'the session is kept');
});

test('an exit without hive_done stops the task, a SessionEnd too; an exit after hive_done does not (#283)', () => {
  const first = filled(1, 2).state; // green: 1 runs, 2 waits
  const id = first.workers[0].runId!;
  const exited = reduce(first, { type: 'exit', ptyId: id });
  assert.equal(work(exited.state, 1)?.stopped, true);
  assert.equal(ownerAt(exited.state, 0), 'board:item2', 'the freed worker goes to the next task, never back to the stopped one');
  assert.equal(work(hook(first, id, { hook_event_name: 'SessionEnd' }).state, 1)?.stopped, true);
  assert.equal(work(reduce(signaled(done(first, id), 'red').state, { type: 'exit', ptyId: id }).state, 1)?.stopped, undefined, 'hive_done was reached');
});

test('quit marks a clean stop: every exit is then ignored, so the kills of a Quit leave the workers and the tasks for the next boot (#283)', () => {
  const first = filled(1, 1).state;
  const quitting = reduce(first, { type: 'quit' });
  assert.deepEqual([quitting.state.cleanStop, quitting.effects], [true, []]);
  assert.equal(reduce(quitting.state, { type: 'exit', ptyId: first.workers[0].runId! }).state, quitting.state, 'same object');
});

test('boot after a quit: each stage worker closes with its task\'s activity kept, the signal opens yellow and the next fill resumes the task; cleanStop goes and no crash is reported (#224, #283)', () => {
  const first = filled(2, 1).state; // green: task 1 runs, a second worker is free
  const booted = reduce(reduce(first, { type: 'quit' }).state, { type: 'boot' }).state;
  assert.deepEqual(
    [booted.workers.map((s) => s.status), work(booted, 1) !== undefined, work(booted, 1)?.stopped, booted.signal, booted.cleanStop, booted.crash],
    [['empty', 'empty'], true, undefined, 'yellow', undefined, undefined],
  );
  assert.deepEqual(polled(booted, many(1)).effects.map((e) => e.type), ['spawn'], 'yellow resumes a started task');
});

test('boot after a crash: each task a stage worker held is stopped and listed in crash; dismissCrash drops it; a boot with no stage run reports nothing (#283)', () => {
  const two = filled(2, 3).state; // 1 and 2 run, 3 waits
  const booted = reduce(two, { type: 'boot' }).state;
  assert.deepEqual(booted.tasks.map((c) => [c.item.id, runOf(booted, c)?.stopped]), [['1', true], ['2', true], ['3', undefined]]);
  assert.deepEqual(booted.crash?.tasks, ['board:item1', 'board:item2']);
  assert.ok(booted.crash && Number.isFinite(Date.parse(booted.crash.at)));
  assert.deepEqual(polled(booted, many(3)).effects, [], 'stopped: yellow resumes nothing, and 3 was never started');
  assert.equal(reduce(booted, { type: 'dismissCrash' }).state.crash, undefined);
  assert.equal(reduce(base(1), { type: 'boot' }).state.crash, undefined);
});

test('a spawn that fails drops the session its new run appended, so the stage reads as not run and the task offers Start again; a resumed session stays (#283)', () => {
  const first = filled(1, 2).state; // spec: a new session for task 1
  const failed = reduce(first, { type: 'spawnFailed', ptyId: first.workers[0].runId!, message: 'pty: boom' }).state;
  assert.deepEqual([sessionsN(failed, 1), holds(failed, 1, 'sessionId'), work(failed, 1)?.error], [[], false, `${SPAWN_FAILED}pty: boom`]);
  assert.equal(startMode(task(failed, 1)!, failed), 'start');
  const sessions = [{ id: 'kept-session-id-0001', startedAt: PAST, stages: ['spec', 'dev'], agent: 'claude' as const, lastUsedAt: PAST }];
  const known: State = withMade(withLive({ ...base(1), tasks: [{ item: item(1), stage: 'dev', boardColumn: 'In progress', auto: true }] }, 1, { sessionId: 'kept-session-id-0001' }), 1, { sessions });
  const resumed = reduce(known, { type: 'setSignal', signal: 'green' }).state; // dev continues the kept session
  const kept = reduce(resumed, { type: 'spawnFailed', ptyId: resumed.workers[0].runId!, message: 'git: boom' }).state;
  assert.deepEqual([work(kept, 1)?.sessionId, sessionsN(kept, 1)?.map((s) => s.id)], ['kept-session-id-0001', ['kept-session-id-0001']]);
});

test('start runs a manual task like any other: its stage\'s prompt in a worker, run stage (#283)', () => {
  const { state, effects } = started(manualState(1), 'board:item1'); // yellow, a free worker
  const spawn = effects.at(-1);
  assert.ok(spawn?.type === 'spawn' && spawn.run === 'stage' && spawn.stage.name === 'spec');
  assert.equal(work(state, 1)?.workerId, state.workers[0].id);
});

test('resume continues the stage\'s latest session past red with run continue, and the stage run drops stopped; a running task or one whose stage has not run is ignored (#283)', () => {
  const idle = ranOnce(1); // stopped in spec, red
  const sessionId = work(idle, 1)!.sessionId!;
  const { state, effects } = reduce(idle, { type: 'continue', activityId: workId(idle, 'board:item1') });
  const spawn = effects.find((e) => e.type === 'spawn'); // #672: its sleeping record's forgetScrollback follows it
  assert.ok(spawn?.type === 'spawn');
  assert.deepEqual([spawn.run, spawn.session, spawn.activity.sessionId, spawn.stage.name, spawn.worker.lastEvent], ['continue', 'continue', sessionId, 'spec', { kind: 'manualStart' }]);
  assert.deepEqual([work(state, 1)?.stopped, work(state, 1)?.workerId], [undefined, state.workers[0].id]);
  assert.equal(reduce(state, { type: 'continue', activityId: workId(state, 'board:item1') }).state, state, 'running: ignored');
  const fresh = polled(signaled(base(1), 'red').state, [listed(2)]).state;
  assert.equal(reduce(fresh, { type: 'continue', activityId: workId(fresh, 'board:item2') }).state, fresh, 'the stage never ran: Start, not Continue');
  assert.equal(reduce(idle, { type: 'continue', activityId: workId(idle, 'nope') }).state, idle);
});

test('restart runs the stage\'s prompt in a new session and takes the branch the server created; it needs the stage\'s start recorded (#283)', () => {
  const idle = ranOnce(1); // spec: a new session each run
  assert.equal(reduce(idle, { type: 'restart', activityId: workId(idle, 'board:item1') }).state, idle, 'no starting commit recorded for the stage: ignored');
  const recorded = reduce(idle, { type: 'stageStarted', activityId: ACT(idle, 1), stage: 'spec', commit: 'a1b2c3d' }).state;
  const { state, effects } = reduce(recorded, { type: 'restart', activityId: workId(recorded, 'board:item1'), branch: 'hive-1-task-1-r2' });
  const spawn = effects.at(-1);
  assert.ok(spawn?.type === 'spawn');
  assert.deepEqual([spawn.run, spawn.session, spawn.activity.branch], ['stage', 'new', 'hive-1-task-1-r2']);
  assert.notEqual(spawn.activity.sessionId, work(idle, 1)?.sessionId, 'a new session');
  assert.equal(work(state, 1)?.stopped, undefined);
  assert.equal(work(reduce(recorded, { type: 'restart', activityId: workId(recorded, 'board:item1') }).state, 1)?.branch, 'hive-1-task-1', 'no branch: the task keeps its own');
});

test('restart is ignored on a stage that continues the previous stage\'s session; resume still works there (#283)', () => {
  const sessions = [{ id: 'kept-session-id-0001', startedAt: PAST, stages: ['spec', 'dev'], agent: 'claude' as const, lastUsedAt: PAST }];
  const inDev: State = withMade(withLive({
    ...signaled(base(1), 'red').state,
    tasks: [{ item: item(1), stage: 'dev', boardColumn: 'In progress', auto: true }],
  }, 1, { worktree: WORKTREE, sessionId: 'kept-session-id-0001', stopped: true, stageStart: { stage: 'dev', commit: 'a1b2c3d' } }), 1, { sessions });
  assert.equal(reduce(inDev, { type: 'restart', activityId: workId(inDev, 'board:item1') }).state, inDev);
  assert.deepEqual(reduce(inDev, { type: 'continue', activityId: workId(inDev, 'board:item1') }).effects.map((e) => e.type), ['spawn']);
});

test('stageStarted stores the stage and the commit a stage run started at, only while the task is still in that stage (#283)', () => {
  const first = filled(1, 1).state; // task 1 in spec
  const recorded = reduce(first, { type: 'stageStarted', activityId: ACT(first, 1), stage: 'spec', commit: 'a1b2c3d4' });
  assert.deepEqual([work(recorded.state, 1)?.stageStart, recorded.effects], [{ stage: 'spec', commit: 'a1b2c3d4' }, []]);
  const moved = stopped(first, first.workers[0].runId!).state; // green: dev in place
  assert.equal(reduce(moved, { type: 'stageStarted', activityId: ACT(moved, 1), stage: 'spec', commit: 'a1b2c3d4' }).state, moved, 'the task moved on: ignored');
  assert.equal(reduce(first, { type: 'stageStarted', activityId: 'nope', stage: 'spec', commit: 'a1b2c3d4' }).state, first, 'an unknown activity: ignored (#629)');
});

// A task in `stage` whose sessions ran `runs`, oldest first, each used a minute after the one before: what a spawn leaves before its
// stageStarted arrives (#580)
function ranIn(stage: string, runs: string[][]): State {
  const sessions = runs.map((stages, i) => ({ id: `session-${i}`, startedAt: PAST, stages, agent: 'claude' as const, lastUsedAt: new Date(Date.parse(PAST) + i * 60_000).toISOString() }));
  return withWork({ ...base(1), tasks: [{ item: item(1), stage, boardColumn: '', auto: true }] }, 'board:item1', { slug: 'hive-1-task-1' }, { sessions }); // #629
}
const recordedStart = (state: State, stage: string) =>
  work(reduce(state, { type: 'stageStarted', activityId: ACT(state, 1), stage, commit: 'a1b2c3d4' }).state, 1)?.stageStart;

test('stageStarted records after: the last other stage of the latest-used session, walking back while a session ran only this stage (#580)', () => {
  const start = { stage: 'dev', commit: 'a1b2c3d4' };
  assert.deepEqual(recordedStart(ranIn('dev', [['spec'], ['dev']]), 'dev'), { ...start, after: 'spec' }, 'a new session in dev: the session before it');
  assert.deepEqual(recordedStart(ranIn('dev', [['spec', 'dev']]), 'dev'), { ...start, after: 'spec' }, 'dev goes on in spec\'s session');
  assert.deepEqual(recordedStart(ranIn('dev', [['spec'], ['dev'], ['review'], ['dev']]), 'dev'), { ...start, after: 'review' }, 'moved back from review to dev');
  assert.deepEqual(recordedStart(ranIn('spec', [['spec']]), 'spec'), { stage: 'spec', commit: 'a1b2c3d4' }, 'no earlier stage: no after');
});

test('stageStarted breaks a lastUsedAt tie by the later-listed session (#580)', () => {
  const tied = ranIn('dev', [['spec'], ['review']]);
  const sessions = sessionsN(tied, 1).map((s) => ({ ...s, lastUsedAt: PAST }));
  assert.equal(recordedStart(withMade(tied, 1, { sessions }), 'dev')?.after, 'review');
});

test('a restart\'s stageStarted keeps the after the run it throws away had (#580)', () => {
  const restartable: LegacyStage[] = [STAGES[0], { ...STAGES[1], session: 'new' }, STAGES[2]]; // dev starts a new session each run
  const parked = ranIn('dev', [['spec'], ['dev'], ['review'], ['dev']]);
  const idle: State = withActivity({ ...parked, stages: restartable }, { ...work(parked, 1)!, stopped: true, stageStart: { stage: 'dev', commit: 'a1b2c3d4', after: 'review' } });
  const { state } = reduce(idle, { type: 'restart', activityId: ACT(idle, 1) });
  assert.equal(sessionsN(state, 1).length, 5, 'the restart ran dev in a new session');
  assert.equal(recordedStart(state, 'dev')?.after, 'review');
});

test('an exit without hive_done stamps stoppedAt with the stopped mark; a run by hand drops both (#580)', () => {
  const idle = ranOnce(1);
  const parked = work(idle, 1)!; // #629: the marks are the activity's
  assert.deepEqual([parked.stopped, typeof parked.stoppedAt], [true, 'string']);
  const resumed = work(reduce(idle, { type: 'continue', activityId: ACT(idle, 1) }).state, 1)!;
  assert.deepEqual(['stopped' in resumed, 'stoppedAt' in resumed], [false, false], 'occupy drops both');
});

test('clearSessions forgets only the named session, and sessionId only when it is that one; a session a live run holds, an unknown session and an unknown task leave the same state (#304)', () => {
  const held = 'aaaaaaaa-0000-4000-8000-000000000001';
  const loose = 'bbbbbbbb-0000-4000-8000-000000000002';
  const other = 'dddddddd-0000-4000-8000-000000000004';
  const idle = ranOnce(1);
  const withSessions: State = withMade({
    ...withActivity(idle, { ...work(idle, 1)!, sessionId: loose }), // #629: the activity's
    workers: [{ id: 'm1', status: 'working', runId: 'cccccccc-0000-4000-8000-000000000003', activityId: work(idle, 1)!.id, sessionId: held, freeSession: true }],
  }, 1, { sessions: [held, loose, other].map((id) => ({ id, startedAt: PAST, stages: ['spec'], agent: 'claude' as const, lastUsedAt: PAST })) });
  const { state, effects } = reduce(withSessions, { type: 'clearSessions', activityId: workId(withSessions, 'board:item1'), sessionId: loose });
  assert.deepEqual([sessionsN(state, 1)?.map((s) => s.id), holds(state, 1, 'sessionId'), effects], [[held, other], false, []]);
  const kept = reduce(withSessions, { type: 'clearSessions', activityId: workId(withSessions, 'board:item1'), sessionId: other }).state;
  assert.deepEqual([sessionsN(kept, 1)?.map((s) => s.id), work(kept, 1)?.sessionId], [[held, loose], loose], 'another session: sessionId stays');
  const ignored: [string, string][] = [['board:item1', held], ['board:item1', 'eeeeeeee-0000-4000-8000-000000000005'], ['nope', loose]];
  for (const [taskId, sessionId] of ignored) {
    assert.equal(reduce(withSessions, { type: 'clearSessions', activityId: workId(withSessions, taskId), sessionId }).state, withSessions, `${taskId} ${sessionId}: same object`);
  }
});

test('clearSessions: the stage reads as not run again only once no other session lists it (#304)', () => {
  const idle = ranOnce(1); // task 1 stopped in spec, one session
  const only = work(idle, 1)!.sessionId!;
  const cleared = reduce(idle, { type: 'clearSessions', activityId: workId(idle, 'board:item1'), sessionId: only }).state;
  assert.equal(startMode(task(cleared, 1)!, cleared), 'start');
  const other = 'dddddddd-0000-4000-8000-000000000004';
  const two: State = withMade(idle, 1, { sessions: [only, other].map((id) => keptSession(id)) });
  const one = reduce(two, { type: 'clearSessions', activityId: workId(two, 'board:item1'), sessionId: only }).state;
  assert.equal(typeof startMode(task(one, 1)!, one), 'object', 'the other session still ran spec: Continue');
});

test('openSession claude opens the user\'s own session on any task with a worktree, manual or not, running or not: a free session past red, the session appended, spawnSession emitted; a missing or worktree-less task is refused (#283, #491)', () => {
  const red = signaled(manualState(1, { auto: true }), 'red').state;
  const { state, effects } = reduce(red, { type: 'openSession', activityId: workId(red, 'board:item1') });
  const [worker] = occupied(state);
  assert.deepEqual([worker.freeSession, ownerOf(state, worker), worker.lastEvent], [true, 'board:item1', { kind: 'manualStart' }]);
  assert.deepEqual(effects, [{ type: 'spawnSession', worker, activity: work(state, 1), task: task(state, 1), sessionId: worker.sessionId, continues: false }]);
  const running = filled(1, 1).state; // task 1 runs its stage in spec
  const located: State = everyLive(running, { worktree: WORKTREE });
  assert.deepEqual(reduce(located, { type: 'openSession', activityId: workId(located, 'board:item1') }).effects.map((e) => e.type), ['spawnSession'], 'beside its stage run, over the cap');
  const refused: [State, string][] = [
    [manualState(1, { missing: true }), 'missing'],
    [manualState(1, { worktree: undefined }), 'no worktree yet: the route creates it first'],
  ];
  for (const [s, why] of refused) assert.equal(reduce(s, { type: 'openSession', activityId: workId(s, 'board:item1') }).state, s, why);
});

test('openSession on a blocked task opens what the user asked for: claude emits spawnSession, terminal emits spawnTerminal; the blocker holds the stage run only (#491)', () => {
  const blocked = manualState(1, { item: { ...item(1), blockedBy: ['9'] } }); // with its worktree
  const claude = reduce(blocked, { type: 'openSession', activityId: workId(blocked, 'board:item1') });
  assert.deepEqual(claude.effects.map((e) => e.type), ['spawnSession']);
  assert.equal(occupied(claude.state)[0].freeSession, true);
  const terminal = reduce(blocked, { type: 'openTerminal', activityId: workId(blocked, 'board:item1') });
  assert.deepEqual(terminal.effects.map((e) => e.type), ['spawnTerminal']);
  assert.equal(terminal.state.terminals.length, 1);
});

test('hive_done in a free session advances the task at once, onFinish written and the result merged, with no kill; the session stays open, its Stop only waits, and the fill leaves a task a worker holds (#283)', () => {
  const given = manualState(1, { auto: true });
  const opened = reduce(given, { type: 'openSession', activityId: workId(given, 'board:item1') }).state;
  const id = opened.workers[1].runId!; // appended past the free worker (#459)
  const { state, effects } = reduce(opened, { type: 'done', ptyId: id, result: { spec: 'docs/x.md' } });
  assert.deepEqual([effects[0]?.type, effects.slice(1)], ['captureCheckpoint', [{ type: 'setColumn', itemId: 'board:item1', column: 'Ready' }]], 'the checkpoint first (#619)');
  assert.deepEqual([task(state, 1)?.stage, resultN(state, 1), state.workers[1].status, state.workers[1].runId], ['dev', { spec: 'docs/x.md' }, 'working', id]);
  const stop = hook(state, id, { hook_event_name: 'Stop' });
  assert.deepEqual([stop.effects, stop.state.workers[1].status], [[], 'waiting']);
  assert.deepEqual(signaled(stop.state, 'green').effects, [], 'held by its session: the fill never starts it, though a worker is free (#459)');
});

test('hive_done in a free session advances the task even while its stage run holds it; the stage worker goes on, and its own stage end later applies from the stage the task is in then (#283)', () => {
  const running = filled(1, 1).state; // task 1 runs its stage in spec
  const stageWorker = running.workers[0].runId!;
  const located: State = everyLive(running, { worktree: WORKTREE });
  const opened = reduce(located, { type: 'openSession', activityId: workId(located, 'board:item1') }).state; // appended: worker 2, outside the cap (#459)
  const advanced = reduce(opened, { type: 'done', ptyId: opened.workers[1].runId! }).state;
  assert.deepEqual([task(advanced, 1)?.stage, work(advanced, 1)?.workerId, advanced.workers[0].runId], ['dev', running.workers[0].id, stageWorker], 'the stage run is not touched');
  const later = stopped(signaled(advanced, 'red').state, stageWorker); // red: no continuation in place
  assert.deepEqual([task(later.state, 1)?.stage, later.effects[1]], ['review', { type: 'kill', slug: 'hive-1-task-1', ptyId: stageWorker }], 'dev ends: the task moves on from dev');
});

test('stop on a free session only kills it; a boot drops free sessions with no stopped task and no crash line for them (#283)', () => {
  const given = manualState(1);
  const opened = reduce(given, { type: 'openSession', activityId: workId(given, 'board:item1') }).state;
  const id = opened.workers[1].runId!; // appended past the free worker (#459)
  const { state, effects } = reduce(opened, { type: 'stop', ptyId: id });
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: id }]);
  assert.equal(state, opened, 'nothing changes until the exit');
  const booted = reduce(opened, { type: 'boot' }).state;
  assert.deepEqual([booted.workers.length, booted.workers[0].status, work(booted, 1)?.stopped, booted.crash], [1, 'empty', undefined, undefined], 'the session worker leaves; the free one stays');
});

test('stop with a close emits the kill then the sourceAction on the task\'s item and leaves the task as a bare stop does; a free session closes its task too; an unknown worker is nothing (#314)', (t) => {
  t.mock.timers.enable({ apis: ['Date'] }); // both stops stamp stoppedAt (#580); one clock keeps them equal
  const running = filled(1, 1).state;
  const ptyId = running.workers[0].runId!;
  const close = { type: 'close', reason: 'duplicate', duplicateOf: 7 } as const;
  const { state, effects } = reduce(running, { type: 'stop', ptyId, close });
  assert.deepEqual(effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId }, { type: 'sourceAction', itemId: 'board:item1', taskId: 'board:item1', action: close }]);
  assert.deepEqual(state, reduce(running, { type: 'stop', ptyId }).state, 'the same stop: the task stopped, the worker frees on the exit');
  assert.equal(work(state, 1)?.stopped, true);
  const given = manualState(1);
  const opened = reduce(given, { type: 'openSession', activityId: workId(given, 'board:item1') }).state;
  const id = opened.workers[1].runId!; // appended past the free worker (#459)
  const wontDo = { type: 'close', reason: 'wontDo' } as const;
  const closed = reduce(opened, { type: 'stop', ptyId: id, close: wontDo });
  assert.deepEqual(closed.effects, [{ type: 'kill', slug: 'hive-1-task-1', ptyId: id }, { type: 'sourceAction', itemId: 'board:item1', taskId: 'board:item1', action: wontDo }]);
  assert.equal(closed.state, opened, 'no stopped mark: only the session dies');
  const idle = base(1);
  assert.deepEqual(reduce(idle, { type: 'stop', ptyId: 'nope', close }), { state: idle, effects: [] }, 'unknown worker: nothing');
});

test('resume is ignored while a free session holds the stage\'s latest session: startMode names that run as live, which Continue focuses instead of spawning a second process (#283)', () => {
  const idle = ranOnce(1); // stopped in spec with its session and worktree, red
  const sessionId = work(idle, 1)!.sessionId!;
  const opened = reduce(idle, { type: 'openSession', activityId: workId(idle, 'board:item1'), continueId: sessionId }).state;
  const live = opened.workers.find((s) => s.freeSession)!.runId;
  assert.deepEqual(startMode(task(opened, 1)!, opened), { continue: true, restart: false, live });
  assert.equal(reduce(opened, { type: 'continue', activityId: workId(opened, 'board:item1') }).state, opened, 'no second process on the same transcript');
});

test('openTerminal adds a terminal and emits spawnTerminal with no worker, past red and a full cap; stop reads its cwd and its exit sleeps it; a first open that fails to spawn goes, files and all, a wake that fails sleeps again (#696); closeTask kills it with the task\'s other runs and forgets it; boot keeps it asleep (#283)', () => {
  const full = signaled(filled(1, 1).state, 'red').state; // the only worker runs task 1
  const located: State = everyLive(full, { worktree: WORKTREE });
  const { state, effects } = reduce(located, { type: 'openTerminal', activityId: workId(located, 'board:item1') });
  const [terminal] = state.terminals;
  assert.deepEqual(effects, [{ type: 'spawnTerminal', terminal, activity: work(state, 1), task: task(state, 1) }]);
  assert.equal(state.workers, located.workers, 'no worker, no cap');
  assert.deepEqual(reduce(state, { type: 'stop', ptyId: terminal.terminalId }).effects, [{ type: 'readCwd', terminalId: terminal.terminalId }]); // #696: it sleeps
  assert.deepEqual(reduce(state, { type: 'exit', ptyId: terminal.terminalId }).state.terminals, [{ ...terminal, asleep: true }]);
  const failed = reduce(state, { type: 'spawnFailed', ptyId: terminal.terminalId, message: 'pty: boom' });
  assert.deepEqual([failed.state.terminals, failed.state.error, failed.effects], [[], 'pty: boom', [{ type: 'dropTerminalFiles', terminalId: terminal.terminalId }]], 'it never ran');
  const woken = reduce(reduce(state, { type: 'exit', ptyId: terminal.terminalId }).state, { type: 'wakeTerminal', terminalId: terminal.terminalId }).state;
  const refailed = reduce(woken, { type: 'spawnFailed', ptyId: terminal.terminalId, message: 'pty: boom' });
  assert.deepEqual([refailed.state.terminals.map((t) => [t.terminalId, t.asleep]), refailed.state.error, refailed.effects], [[[terminal.terminalId, true]], 'pty: boom', []], 'a wake that fails keeps it asleep');
  const closed = reduce(polled(state, []).state, { type: 'closeTask', taskId: 'board:item1' }); // off the source: close is allowed
  assert.deepEqual(closed.effects.map((e) => (e.type === 'kill' ? e.ptyId : e.type)), [state.workers[0].runId, terminal.terminalId, 'dropTerminalFiles', 'forgetScrollback']);
  assert.deepEqual(closed.state.terminals, []);
  assert.deepEqual(reduce(state, { type: 'boot' }).state.terminals, [{ ...terminal, asleep: true }], 'a terminal sleeps through a boot (#696)');
});

test('openTerminal with a command keeps its name on the Terminal and in spawnTerminal, with no worker past red; no worktree, or one gone from disk, and nothing opens, as for a plain terminal; a plain terminal carries no command (#300)', () => {
  const red = signaled(manualState(1, { auto: true }), 'red').state;
  const { state, effects } = reduce(red, { type: 'openTerminal', activityId: workId(red, 'board:item1'), command: 'Run Frontend' });
  const [terminal] = state.terminals;
  assert.equal(terminal.command, 'Run Frontend');
  assert.deepEqual(effects, [{ type: 'spawnTerminal', terminal, activity: work(state, 1), task: task(state, 1) }]);
  assert.equal(state.workers, red.workers, 'no worker, no cap');
  const refused: [State, string][] = [[manualState(1, { worktree: undefined }), 'no worktree'], [manualState(1, { worktreeGone: true }), 'gone from disk (#208)']];
  for (const [s, why] of refused) assert.equal(reduce(s, { type: 'openTerminal', activityId: workId(s, 'board:item1'), command: 'Run Frontend' }).state, s, why);
  assert.equal('command' in reduce(red, { type: 'openTerminal', activityId: workId(red, 'board:item1') }).state.terminals[0], false);
});

test('openProjectShell opens a shell on the project with no task and no worker, past red and a full cap, and emits spawnTerminal with no task; an unknown project opens nothing; stop reads its cwd and its exit sleeps it, a first open that fails to spawn goes (#696), closing a task leaves it alone and boot keeps it asleep (#292)', () => {
  const full = signaled(filled(1, 1).state, 'red').state; // the only worker runs task 1
  const { state, effects } = reduce(full, { type: 'openProjectShell', project: 'hive', cwd: '/repo' });
  const [terminal] = state.terminals;
  assert.deepEqual(terminal, { terminalId: terminal.terminalId, activityId: localActivityId('hive'), startedAt: terminal.startedAt, cwd: '/repo' }); // #629: the workspace's local activity
  assert.deepEqual(effects, [{ type: 'spawnTerminal', terminal, activity: { id: localActivityId('hive'), kind: 'local', workspace: 'hive' } }], 'no task on the effect: the local activity (#629)');
  assert.equal(state.workers, full.workers, 'no worker, no cap');
  assert.equal(state.tasks, full.tasks, 'no task to move to the top (#356)');
  assert.deepEqual(reduce(state, { type: 'stop', ptyId: terminal.terminalId }).effects, [{ type: 'readCwd', terminalId: terminal.terminalId }], 'it sleeps (#696)');
  assert.deepEqual(reduce(state, { type: 'exit', ptyId: terminal.terminalId }).state.terminals, [{ ...terminal, asleep: true }]);
  const failed = reduce(state, { type: 'spawnFailed', ptyId: terminal.terminalId, message: 'workspace "hive" não existe mais' });
  assert.deepEqual([failed.state.terminals, failed.state.error, failed.effects], [[], 'workspace "hive" não existe mais', [{ type: 'dropTerminalFiles', terminalId: terminal.terminalId }]]);
  const closed = reduce(polled(state, []).state, { type: 'closeTask', taskId: 'board:item1' }); // off the source: close is allowed
  assert.deepEqual([closed.effects.map((e) => (e.type === 'kill' ? e.ptyId : e.type)), closed.state.terminals], [[state.workers[0].runId, 'forgetScrollback'], [terminal]], 'no task counts it');
  assert.deepEqual(reduce(state, { type: 'boot' }).state.terminals, [{ ...terminal, asleep: true }], 'a terminal sleeps through a boot (#696)');
  assert.equal(reduce(full, { type: 'openProjectShell', project: 'nope', cwd: '/repo' }).state, full, 'unknown project');
});

test('opening a session or a terminal moves the task to the top of its stage, last among the live tasks; a terminal on a task already there leaves the same tasks; a poll keeps a live task in place and the reset keeps it on top; once its run ends the next poll puts it back in source order (#356)', () => {
  const ids = (s: State): string[] => s.tasks.map((c) => c.item.id);
  // red (#727): every task here has a live activity, so it is started and yellow would resume it
  const waiting = polled(signaled(base(1), 'red').state, many(4)).state; // spec: 1, 2, 3, 4; nothing runs under red
  const located: State = everyLive(waiting, { worktree: WORKTREE });
  assert.equal(reduce(located, { type: 'openTerminal', activityId: workId(located, 'board:item1') }).state.tasks, located.tasks, 'already on top: the same list');
  const terminal = reduce(located, { type: 'openTerminal', activityId: workId(located, 'board:item3') }).state;
  assert.deepEqual(ids(terminal), ['3', '1', '2', '4'], 'a terminal is a live run');
  const session = reduce(terminal, { type: 'openSession', activityId: workId(terminal, 'board:item4') }).state;
  assert.deepEqual(ids(session), ['3', '4', '1', '2'], 'so is a free session, last among the live tasks');
  assert.equal(work(session, 4)?.workerId, undefined, 'Task.workerId stays the stage run\'s (#283)');
  const repolled = polled(session, many(4)).state;
  assert.deepEqual(ids(repolled), ['3', '4', '1', '2'], 'the poll anchors both');
  assert.deepEqual(ids(reduce(repolled, { type: 'resetOrder', stage: 'spec' }).state), ['3', '4', '1', '2'], 'the reset keeps the live tasks on top');
  const ptyId = session.workers.find((s) => s.freeSession)?.runId ?? '';
  const ended = reduce(repolled, { type: 'exit', ptyId }).state;
  assert.deepEqual(ids(ended), ['3', '4', '1', '2'], 'nothing moves as the run ends');
  assert.deepEqual(ids(polled(ended, many(4)).state), ['3', '1', '2', '4'], 'the next poll puts 4 back in board order; 3 keeps its terminal and its place');
});

test('restarting marks a task whose Restart is offered and that no other run holds: a start, a continue and a session leave it alone; worktreeKept drops the mark; restart runs the stage and drops it, and a restart the reducer ignores drops it too (#283)', () => {
  const idle = ranOnce(1); // stopped in spec, red
  const recorded = reduce(idle, { type: 'stageStarted', activityId: ACT(idle, 1), stage: 'spec', commit: 'a1b2c3d' }).state;
  const marked = reduce(recorded, { type: 'restarting', activityId: workId(recorded, 'board:item1') }).state;
  assert.equal(work(marked, 1)?.deleting, true);
  assert.deepEqual(started(marked, 'board:item1').effects, []);
  assert.equal(reduce(marked, { type: 'continue', activityId: workId(marked, 'board:item1') }).state, marked);
  assert.equal(reduce(marked, { type: 'openSession', activityId: workId(marked, 'board:item1') }).state, marked);
  assert.equal(work(reduce(marked, { type: 'activityKept', activityId: workId(marked, 'board:item1') }).state, 1)?.deleting, undefined, 'the git failed');
  const run = reduce(marked, { type: 'restart', activityId: workId(marked, 'board:item1') });
  assert.deepEqual([run.effects.at(-1)?.type, work(run.state, 1)?.deleting], ['spawn', undefined]);
  const moved: State = withActivity(marked, { ...work(marked, 1)!, stageStart: { stage: 'dev', commit: 'a1b2c3d' } }); // #629: the activity's
  const ignored = reduce(moved, { type: 'restart', activityId: workId(moved, 'board:item1') });
  assert.deepEqual([ignored.effects, work(ignored.state, 1)?.deleting], [[], undefined], 'ignored: the mark still goes');
  const opened = reduce(recorded, { type: 'openTerminal', activityId: workId(recorded, 'board:item1') }).state;
  assert.equal(reduce(opened, { type: 'restarting', activityId: workId(opened, 'board:item1') }).state, opened, 'a terminal on the task');
  assert.equal(reduce(idle, { type: 'restarting', activityId: workId(idle, 'board:item1') }).state, idle, 'no recorded start');
});

test('a claude session that never opened forgets the session its open appended, only in the bar; a resumed session that fails stays listed (#283)', () => {
  const ran = ranOnce(1); // stopped in spec: one session from its stage run
  // backdated: in a test the stage run's session and a resume can share one millisecond, which a real resume never does
  const idle: State = withMade(ran, 1, { sessions: sessionsN(ran, 1).map((x) => ({ ...x, startedAt: PAST })) });
  const listed = sessionsN(idle, 1).map((s) => s.id);
  const opened = reduce(idle, { type: 'openSession', activityId: workId(idle, 'board:item1') }).state;
  const fresh = opened.workers.find((s) => s.freeSession)!;
  assert.equal(sessionsN(opened, 1)?.length, 2);
  const failed = reduce(opened, { type: 'spawnFailed', ptyId: fresh.runId!, message: 'pty: boom' }).state;
  assert.deepEqual([sessionsN(failed, 1)?.map((s) => s.id), work(failed, 1)?.sessionId, work(failed, 1)?.error, failed.error], [listed, work(idle, 1)?.sessionId, undefined, 'pty: boom']);
  const resumed = reduce(idle, { type: 'openSession', activityId: workId(idle, 'board:item1'), continueId: listed[0] }).state;
  const worker = resumed.workers.find((s) => s.freeSession)!;
  const kept = reduce(resumed, { type: 'spawnFailed', ptyId: worker.runId!, message: 'pty: boom' }).state;
  assert.deepEqual(sessionsN(kept, 1)?.map((s) => s.id), listed, 'an older session stays');
});

// A manual gate (#315): approval and no prompt. gate → signoff (a second gate) → dev
const GATED: LegacyStage[] = [
  { name: 'gate', from: { board: ['Backlog'] }, onStart: { board: [move('Reviewing')] }, onFinish: { board: [move('Approved')] }, approval: true },
  { name: 'signoff', from: { board: ['Approved'] }, onFinish: { board: [move('Ready')] }, approval: true },
  { name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' },
];
const approved = (state: State) => reduce(state, { type: 'approve', activityId: workId(state, 'board:item1') });

test('a polled task entering a manual gate awaits approval at once: no worker, no spawn, no onStart write, and a free worker never takes it (#315)', () => {
  const { state, effects } = polled(base(1, GATED), [listed(1)]);
  const entered = task(state, 1)!;
  assert.deepEqual([entered.stage, work(state, 1)?.workerId, work(state, 1)?.approval], ['gate', undefined, { since: entered.enteredAt }], 'on an activity born for it (#629)');
  assert.deepEqual(effects, [], 'the fill ran with a free worker under green and found nothing');
  assert.equal(occupied(state).length, 0);
  assert.equal(started(state, 'board:item1').state, state, 'Start is refused, as on any task awaiting approval');
});

test('approve on a gate task writes onFinish and moves it on: into a second gate it awaits again, into a prompt stage the fill takes it; after the last stage it leaves (#315)', () => {
  const first = approved(polled(base(1, GATED), [listed(1)]).state);
  const signoff = task(first.state, 1)!;
  assert.deepEqual(first.effects, [{ type: 'setColumn', itemId: 'board:item1', column: 'Approved' }]);
  assert.deepEqual([signoff.stage, work(first.state, 1)?.approval], ['signoff', { since: signoff.enteredAt }], 'the next gate awaits from its own entry');
  const second = approved(first.state);
  assert.deepEqual(second.effects[0], { type: 'setColumn', itemId: 'board:item1', column: 'Ready' });
  assert.ok(second.effects.some((e) => e.type === 'spawn'), 'dev has a prompt: the free worker takes the task');
  const dev = task(second.state, 1)!;
  assert.deepEqual([dev.stage, 'approval' in dev], ['dev', false]);
  const last = approved(polled(base(1, [GATED[0]]), [listed(1)]).state);
  assert.deepEqual([last.state.tasks, last.effects], [[], [{ type: 'setColumn', itemId: 'board:item1', column: 'Approved' }]]);
});

test('setStages that turns stages into manual gates makes their stopped tasks await approval and leaves a running task to its run (#315)', () => {
  const before = polled(base(1), [listed(1), listed(2, 'In review')]).state; // 1 runs spec, 2 sits in the prompt-less review
  const { prompt: _prompt, ...spec } = STAGES[0];
  const gated: LegacyStage[] = [{ ...spec, approval: true }, STAGES[1], { ...STAGES[2], approval: true }];
  const { state, effects } = reduce(before, { type: 'setStages', ...chained(gated) });
  assert.equal(typeof work(state, 2)?.approval?.since, 'string', 'otherwise it would sit there with no Aprovar');
  assert.deepEqual([work(state, 1)?.workerId, work(state, 1)?.approval], [work(before, 1)?.workerId, undefined]);
  assert.deepEqual(effects, []);
});

// excluir task… (#542): a stopped local task with a worktree in `spec`, no worker to fill, whatever the delete-activity scope
function deletable(): State {
  const made = created(base(0), 'spec').state;
  const kept = reduce(made, { type: 'setDeleteActivity', deleteActivity: { ...DELETE_ACTIVITY_DEFAULTS, session: false } }).state;
  return withWork(kept, 'local:1', { slug: slugFor(kept.tasks[0].item), worktree: WORKTREE }); // #629: the worktree is its activity's
}
const localWork = (s: State) => activityOf(s, 'local:1');

test('deletingTask marks a local task with a worktree whatever the delete-activity scope and closes its terminals first (#573); a worker, no worktree, a source task or the mark already there are no-ops (#542)', () => {
  const idle = deletable();
  const { state, effects } = reduce(idle, { type: 'deletingTask', taskId: 'local:1' });
  assert.equal(localWork(state)?.deleting, true, 'the scope keeps worktrees, yet excluir task… always removes it');
  assert.deepEqual(effects, []);
  const terminal: Terminal = { terminalId: 'shell-worker-1', activityId: activityIdOf('local:1'), startedAt: PAST, cwd: '/repo' };
  const closed = reduce({ ...idle, terminals: [terminal] }, { type: 'deletingTask', taskId: 'local:1' }); // #629: open in the task's activity
  assert.deepEqual([localWork(closed.state)?.deleting, closed.state.terminals, closed.effects], [true, [], [{ type: 'kill', slug: localWork(idle)!.slug, ptyId: terminal.terminalId }, { type: 'dropTerminalFiles', terminalId: terminal.terminalId }]], 'a terminal is closed first (#573)');
  const { worktree: _worktree, ...bare } = localWork(idle)!;
  const noOps: [State, string, string][] = [
    [withActivity(idle, { ...localWork(idle)!, workerId: 's1' }), 'local:1', 'its stage run'],
    [withActivity(idle, bare), 'local:1', 'no worktree'],
    [ranOnce(1), 'board:item1', 'a board task'],
    [state, 'local:1', 'already deleting'],
    [idle, 'nope', 'unknown'],
  ];
  for (const [s, id, why] of noOps) assert.equal(reduce(s, { type: 'deletingTask', taskId: id }).state, s, why);
});

test('a fill after deletingTask leaves the task alone; taskDeleted drops it and fills; worktreeKept drops only the mark; taskDeleted ignores an unmarked task (#542)', () => {
  const idle = deletable();
  assert.deepEqual(reduce(idle, { type: 'setMax', max: 1 }).effects.map((e) => e.type), ['spawn'], 'unmarked, the fill takes it');
  const marked = reduce(idle, { type: 'deletingTask', taskId: 'local:1' }).state;
  assert.deepEqual(reduce(marked, { type: 'setMax', max: 1 }).effects, [], 'marked: git runs, no worker recreates the worktree');
  const kept = reduce(marked, { type: 'activityKept', activityId: workId(marked, 'local:1') }).state;
  assert.deepEqual(kept.tasks, idle.tasks, 'git failed: only the mark goes');
  const deleted = reduce(marked, { type: 'taskDeleted', taskId: 'local:1' });
  assert.deepEqual([deleted.state.tasks, deleted.effects], [[], []]);
  assert.equal(reduce(idle, { type: 'taskDeleted', taskId: 'local:1' }).state, idle, 'no mark: no-op');
});

test('a new local session\'s Stop records the turn on its entry, its SessionEnd or exit frees the worker and keeps the session; no task is touched (#590)', () => {
  const running = filled(1, 1).state; // task 1 runs its stage
  const opened = reduce({ ...running, workspaces: ['hive'] }, { type: 'newLocalSession', activityId: localActivityId('hive') }).state;
  const worker = opened.workers.find((s) => s.activityId === localActivityId('hive'))!;
  const id = worker.runId!;
  const started = hook(opened, id, { hook_event_name: 'SessionStart', cwd: '/repo', session_id: worker.sessionId }).state;
  assert.equal(started.tasks, opened.tasks, 'no task keeps a path or a branch');
  const turned = reduce(started, { type: 'hook', ptyId: id, payload: { hook_event_name: 'Stop' }, tokens: 1500, title: 'fix login' }).state;
  assert.deepEqual([localSessionsOf(turned, 'hive')[0].tokens, localSessionsOf(turned, 'hive')[0].name, turned.workers.find((s) => s.runId === id)?.status], [1500, 'fix login', 'waiting']);
  assert.equal(turned.tasks, started.tasks);
  for (const ended of [hook(turned, id, { hook_event_name: 'SessionEnd' }).state, reduce(turned, { type: 'exit', ptyId: id }).state]) {
    assert.equal(ended.workers.some((s) => s.runId === id), false, 'its own worker leaves with its run (#459)');
    assert.deepEqual(localSessionsOf(ended, 'hive').map((s) => s.id), [worker.sessionId]);
  }
});

test('the fill never takes a local session\'s worker and the cap does not count it (#590)', () => {
  const opened = reduce({ ...signaled(base(1), 'red').state, workspaces: ['hive'] }, { type: 'newLocalSession', activityId: localActivityId('hive') }).state;
  const local = opened.workers.find((s) => s.activityId === localActivityId('hive'))!;
  const filledUp = polled(signaled(opened, 'green').state, many(2)).state;
  assert.equal(filledUp.workers.filter((s) => ownerOf(filledUp, s) !== undefined).length, 1, 'the one worker takes task 1');
  assert.deepEqual(filledUp.workers.find((s) => s.id === local.id), local, 'the session\'s worker is left as it was');
});

test('a stage spawn gives a task with no activity an Activity and an ActivityRecord with one id, and a second run reuses them (#629)', () => {
  const first = filled(1, 1).state;
  const activity = work(first, 1);
  assert.ok(activity);
  assert.deepEqual([activity.kind, activity.workspace], ['task', 'hive']);
  assert.deepEqual(recordOf(first, activity.id)?.taskIds, ['board:item1']);
  const once = ranOnce();
  const id = work(once, 1)?.id;
  const rerun = started(once, 'board:item1').state;
  assert.equal(work(rerun, 1)?.id, id);
  assert.deepEqual([rerun.activities.length, rerun.activityRecords.length], [1, 1]);
});

test('a manual start and a first open each create the task\'s activity once (#629)', () => {
  const ready = polled(signaled(base(1), 'red').state, [listed(1, 'Ready'), listed(2, 'Ready')]).state;
  const startedState = reduce(ready, { type: 'start', itemId: 'board:item1', base: { ref: 'origin/x', tellWorker: false }, local: true }).state;
  assert.equal(startedState.activities.length, 1);
  const born2 = born(ready, 2); // the first open's createActivity, then its worktreeReady
  const made = reduce(born2, { type: 'worktreeReady', activityId: ACT(born2, 2), path: '/w/2', branch: 'hive/2-task-2', base: null, local: false }).state;
  const opened = reduce(made, { type: 'openSession', activityId: workId(made, 'board:item2') }).state;
  assert.equal(opened.activities.length, 1);
  assert.equal(work(opened, 2)?.id, work(made, 2)?.id);
});

test('delete activity removes the Activity, keeps its record and the task in its stage, and a later run makes a new pair (#629)', () => {
  const ran = ranOnce();
  const { stopped: _stopped, stoppedAt: _stoppedAt, ...unstopped } = work(ran, 1)!; // a stopped mark would outlive the delete on an empty activity (#629)
  const once = withActivity(ran, unstopped);
  const old = work(once, 1);
  assert.ok(old);
  const marked = reduce(once, { type: 'deletingActivity', activityId: workId(once, 'board:item1') }).state;
  const removed = reduce(marked, { type: 'activityRemoved', activityId: workId(marked, 'board:item1') }).state;
  assert.equal(work(removed, 1), undefined);
  assert.deepEqual(recordsOf(removed, 'board:item1').map((r) => r.id), [old.id]);
  assert.equal(task(removed, 1)?.stage, 'spec');
  const rerun = started(removed, 'board:item1').state;
  const fresh = work(rerun, 1);
  assert.ok(fresh && fresh.id !== old.id);
  assert.deepEqual(recordsOf(rerun, 'board:item1').map((r) => r.id), [old.id, fresh.id]);
});

test('closing a task that left the source prunes its activity and its records (#629)', () => {
  const missing = polled(ranOnce(), []).state;
  const closed = reduce(missing, { type: 'closeTask', taskId: 'board:item1' }).state;
  assert.equal(closed.activities.length, 1, 'kept while its worktree is on disk (#861)');
  const gone = reduce(closed, { type: 'worktreeGone', activityId: closed.activities[0].id }).state;
  assert.deepEqual([gone.activities, gone.activityRecords], [[], []]);
});

test('renaming a source carries its tasks\' ids in the records, so nothing is pruned (#629)', () => {
  const renamed = reduce(ranOnce(), { type: 'renameSources', renames: { board: 'tracker' } }).state;
  assert.deepEqual(renamed.activityRecords.map((r) => r.taskIds), [['tracker:item1']]);
  assert.equal(renamed.activities.length, 1);
});

test('hive_done and hive_pr from a worker land in its activity\'s record (#629)', () => {
  const first = filled(1, 1).state;
  const ptyId = first.workers[0].runId!;
  const told = reduce(first, { type: 'done', ptyId, result: { spec: 'a.md' } }).state;
  const opened = reduce(told, { type: 'pr', ptyId, url: 'https://github.com/o/r/pull/9' }).state;
  const record = recordOf(opened, work(opened, 1)!.id);
  assert.deepEqual([record?.result, record?.prs], [{ spec: 'a.md' }, [{ url: 'https://github.com/o/r/pull/9', state: 'open' }]]);
});

test('after delete activity and a new run, resultOf merges both records, the newer key winning, and the panel reads both PRs (#629)', () => {
  const run1 = filled(1, 1).state;
  const p1 = run1.workers[0].runId!;
  const seen = hook(run1, p1, { hook_event_name: 'SessionStart', cwd: WORKTREE }).state;
  const told = reduce(reduce(seen, { type: 'done', ptyId: p1, result: { spec: 'a.md', plan: 'p1.md' } }).state, { type: 'pr', ptyId: p1, url: 'https://github.com/o/r/pull/1' }).state;
  const ended = reduce(signaled(told, 'red').state, { type: 'exit', ptyId: p1 }).state;
  const deleting = reduce(ended, { type: 'deletingActivity', activityId: workId(ended, 'board:item1') }).state;
  const removed = reduce(deleting, { type: 'activityRemoved', activityId: workId(deleting, 'board:item1') }).state;
  const run2 = started(removed, 'board:item1').state;
  const p2 = run2.workers.find((w) => w.status !== 'empty')!.runId!;
  const told2 = reduce(run2, { type: 'done', ptyId: p2, result: { plan: 'p2.md' } }).state;
  assert.deepEqual(resultOf(told2, 'board:item1'), { spec: 'a.md', plan: 'p2.md' });
  assert.deepEqual(prsOf(told2, 'board:item1').map((pr) => pr.url), ['https://github.com/o/r/pull/1']);
});

test('a task entering a manual gate awaits approval on an activity born for it, and approve moves it on (#629)', () => {
  const stages: LegacyStage[] = [{ name: 'ready', from: { board: ['Ready'] } }, { name: 'gate', from: { board: ['Gate'] }, approval: true }, { name: 'next', from: { board: ['Next'] } }];
  const entered = polled(signaled(base(1, stages), 'red').state, [listed(1, 'Gate')]).state;
  const gate = work(entered, 1);
  assert.equal(gate?.approval?.since, task(entered, 1)?.enteredAt);
  assert.equal(gate?.worktree, undefined, 'no run started: no worktree');
  const approved = reduce(entered, { type: 'approve', activityId: workId(entered, 'board:item1') }).state;
  assert.deepEqual([task(approved, 1)?.stage, work(approved, 1)?.approval], ['next', undefined]);
});

test('a slug refusal lands on the task\'s activity, born for it, and keeps the task out of the fill (#629)', () => {
  const two = polled(signaled(base(2), 'red').state, [listed(1, 'Ready')]).state;
  const owner = withWork(two, 'board:other', { slug: slugFor(item(1)), worktree: '/w/x' });
  const withOther: State = { ...owner, tasks: [...owner.tasks, { item: { ...item(1), itemId: 'board:other' }, stage: 'review', boardColumn: 'In review', auto: true }] };
  const refused = reduce(signaled(withOther, 'green').state, { type: 'poll', source: 'board', items: [listed(1, 'Ready')] }).state;
  assert.match(work(refused, 1)?.error ?? '', /is used by/);
  assert.equal(refused.workers.filter((w) => w.status !== 'empty').length, 0);
});

test('a gate task with no workspace awaits nothing until setWorkspace places it, then awaits approval on an activity born there (#629)', () => {
  const stages: LegacyStage[] = [{ name: 'gate', from: { board: ['Gate'] }, approval: true }, { name: 'next', from: { board: ['Next'] } }];
  const two: State = { ...signaled(base(1, stages), 'red').state, workspaces: ['hive', 'site'] }; // two workspaces and no hint: none resolves
  const entered = polled(two, [listed(1, 'Gate')]).state;
  assert.equal(work(entered, 1), undefined, 'no workspace: no activity to await on');
  const placed = reduce(entered, { type: 'setWorkspace', taskId: 'board:item1', workspace: 'site' }).state;
  assert.deepEqual([work(placed, 1)?.workspace, work(placed, 1)?.approval], ['site', { since: task(placed, 1)?.enteredAt }]);
});

test('a replacing reading (the header\'s refresh) takes the windows as read: a lower percent in the same window wins and a window it lacks goes; a worker\'s never replaces', () => {
  const held: RateLimits = { ...windows(85, 95), windows: { ...windows(85, 95).windows, seven_day_opus: { usedPercent: 10, resetsAt: FUTURE } } };
  const high = reduce(base(1), { type: 'rateLimits', agent: 'claude', rateLimits: held }).state;
  const upgraded = windows(30, 40); // a bigger plan: the same windows, lower percents
  assert.deepEqual(reduce(high, { type: 'rateLimits', agent: 'claude', rateLimits: upgraded, replace: true }).state.rateLimits?.claude, upgraded);
  assert.deepEqual(reduce(high, { type: 'rateLimits', agent: 'claude', rateLimits: upgraded }).state.rateLimits?.claude?.windows.five_hour.usedPercent, 85, 'without replace the merge keeps the higher percent');
  const busy = filled(1, 1).state;
  const id = busy.workers[0].runId!;
  const fromWorker = reduce({ ...busy, rateLimits: { claude: held } }, { type: 'rateLimits', agent: 'claude', ptyId: id, rateLimits: upgraded, replace: true }).state;
  assert.equal(fromWorker.rateLimits?.claude?.windows.five_hour.usedPercent, 85, 'a worker\'s cached snapshot is always merged');
});

test('every stage run counts on its activity record: the spawn, the continue in place into the next stage, a Continue; a free session does not (#742)', () => {
  const first = filled(1, 1).state; // task 1 spawns in spec
  const ptyId = first.workers[0].runId!;
  assert.deepEqual(recordOf(first, ACT(first, 1))?.stageRuns, { spec: 1 });
  const moved = stopped(first, ptyId).state;
  assert.equal(moved.workers[0].runId, ptyId, 'spec ended and dev continues the session in place');
  assert.deepEqual(recordOf(moved, ACT(moved, 1))?.stageRuns, { spec: 1, dev: 1 });
  const parked = ranOnce();
  const resumed = reduce(parked, { type: 'continue', activityId: ACT(parked, 1) }).state;
  assert.deepEqual(recordOf(resumed, ACT(resumed, 1))?.stageRuns, { spec: 2 });
  const opened = reduce(parked, { type: 'openSession', activityId: ACT(parked, 1) }).state;
  assert.deepEqual(recordOf(opened, ACT(opened, 1))?.stageRuns, { spec: 1 }, 'a free session runs no stage');
});

test('forkSynced sets the sync on its activity, a new object, with no effect and never mutating the state; an unknown activity is ignored; a saved activity keeps it, a malformed one reads as none; the log names mode and result only (#854)', () => {
  const sync: ForkSyncResult = { result: 'diverged', mode: 'github', commits: 2, base: 'me:main', sha: 'a1b2c3d', at: '2026-10-08T10:00:00.000Z' };
  const task: Task = { item: { itemId: 'I1', id: '1', title: 'T', body: '', url: '' }, stage: 'dev', boardColumn: '', auto: true, workspace: 'hive' };
  const freeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
  };
  const state = freeze(withWork({ ...initialState(0), workspaces: ['hive'], tasks: [task] }, 'I1'));
  const id = workId(state, 'I1');
  const { state: next, effects } = reduce(state, { type: 'forkSynced', activityId: id, sync });
  assert.deepEqual([activityOf(next, 'I1')?.sync, effects], [sync, []]);
  assert.notEqual(activityOf(next, 'I1'), activityOf(state, 'I1'));
  assert.equal(reduce(state, { type: 'forkSynced', activityId: 'gone', sync }).state.activities, state.activities);
  assert.deepEqual(savedWork({ sync }).sync, sync);
  assert.equal(savedWork({ sync: { ...sync, result: 'maybe' } }).sync, undefined);
  assert.equal(savedWork({ sync: { ...sync, at: 'yesterday' } }).sync, undefined);
  assert.equal(describeEvent({ type: 'forkSynced', activityId: id, sync: { ...sync, reason: 'fatal: secret words' } }).includes('secret'), false);
  assert.match(describeEvent({ type: 'forkSynced', activityId: id, sync }), /^forkSynced activity=\S+ github diverged$/);
});

test('the fill never picks a show epic: the leaf behind it takes the worker (#31)', () => {
  const epic: SourceItem = { item: { ...item(1), children: ['board:item2'], epic: { follows: 'behind', switchAt: 'dev' } }, column: 'Backlog' };
  const { state } = polled(base(1), [epic, listed(2)]);
  assert.deepEqual(owners(state, occupied(state)), ['board:item2']);
  assert.ok(!cands(state).some((c) => c.item.itemId === 'board:item1'));
});

test('moveToStage and a start on a show epic are no-ops: its children decide its stage, and it never runs (#31)', () => {
  const epic: SourceItem = { item: { ...item(1), epic: { follows: 'behind', switchAt: 'dev' } }, column: 'Backlog' };
  const before = polled(base(0), [epic]).state;
  const moved = reduce(before, { type: 'moveToStage', taskId: 'board:item1', stage: 'review' });
  assert.equal(task(moved.state, 1)?.stage, 'spec');
  assert.deepEqual(moved.effects, []);
  const start = started(before, 'board:item1');
  assert.deepEqual(start.effects, [], 'no spawn');
  assert.equal(work(start.state, 1), undefined, 'no activity born for it');
});

test('a poll that moves the children moves their show epic in the same reduction, its column written like any move (#31)', () => {
  const epic = (column: string): SourceItem => ({ item: { ...item(1), children: ['board:item2', 'board:item3'], epic: { follows: 'behind', switchAt: 'dev' } }, column });
  const first = polled(base(0), [epic('Backlog'), listed(2), listed(3)]).state;
  assert.equal(task(first, 1)?.stage, 'spec', 'every child in spec: the epic stays');
  const { state, effects } = polled(first, [epic('Backlog'), listed(2, 'Ready'), listed(3, 'Ready')]);
  assert.equal(task(state, 1)?.stage, 'dev', 'the furthest-behind child is in dev now');
  assert.equal(task(state, 1)?.boardColumn, 'Ready');
  assert.deepEqual(effects.filter((e) => e.type === 'setColumn'), [{ type: 'setColumn', itemId: 'board:item1', column: 'Ready' }]);
});

test('renameStages renames every task and the flow in one reduction, with no fill; the renamed run ends through its renamed stage (#861)', () => {
  const running = polled(base(1), [listed(1), listed(2)]).state; // 1 runs spec, 2 waits there
  const { state, effects } = reduce(running, { type: 'renameStages', renames: { spec: 'Spec' } });
  assert.deepEqual(effects, []);
  assert.deepEqual([state.tasks.map((c) => c.stage), state.stages[0].name], [['Spec', 'Spec'], 'Spec']);
  assert.equal(reduce(running, { type: 'renameStages', renames: {} }).state, running, 'an empty map: the same state');
  const ended = stopped(state, state.workers[0].runId!);
  assert.ok(ended.effects.some((e) => e.type === 'setColumn'), 'the renamed stage\'s transition wrote the source');
  assert.equal(task(ended.state, 1)?.stage, 'dev');
});

test('a run whose stage was deleted (stageGone) ends at its Stop with no transition and no source action: the task halts with STAGE_GONE and the mark goes (#861)', () => {
  const marked = withLive(polled(base(1), [listed(1)]).state, 1, { stageGone: 'old' }); // 1 runs spec
  const { state, effects } = stopped(marked, marked.workers[0].runId!);
  assert.equal(effects.some((e) => e.type === 'setColumn' || e.type === 'sourceAction'), false, 'spec\'s transition would have moved it to Ready');
  assert.deepEqual([task(state, 1)?.stage, work(state, 1)?.error, work(state, 1)?.stopped, holds(state, 1, 'stageGone')], ['spec', `${STAGE_GONE}old`, true, false]);
});

test('stageGone never outlives its run: a manual stop clears it, and so does a move by hand (#861)', () => {
  const running = withLive(polled(base(1), [listed(1)]).state, 1, { stageGone: 'old' });
  assert.equal(holds(reduce(running, { type: 'stop', ptyId: running.workers[0].runId! }).state, 1, 'stageGone'), false, 'a manual stop');
  const parked = withLive(polled(base(0), [listed(1)]).state, 1, { stageGone: 'old' });
  assert.equal(holds(reduce(parked, { type: 'moveToStage', taskId: 'board:item1', stage: 'dev' }).state, 1, 'stageGone'), false, 'a move by hand');
});

test('a restart after the halt carries no stageGone into the new run (#861)', () => {
  const marked = withLive(polled(base(1), [listed(1)]).state, 1, { stageGone: 'old' });
  const halted = stopped(marked, marked.workers[0].runId!).state;
  const recorded = reduce(halted, { type: 'stageStarted', activityId: ACT(halted, 1), stage: 'spec', commit: 'a1b2c3d' }).state;
  const { effects } = reduce(recorded, { type: 'restart', activityId: workId(recorded, 'board:item1') });
  const spawn = effects.at(-1);
  assert.ok(spawn?.type === 'spawn');
  assert.equal('stageGone' in spawn.activity, false);
});

test('setStages sends a stopped task of a deleted stage to the stage that pulls its column, else the nearest surviving one before it, else the first after it; its activity stays (#861)', () => {
  const red = signaled(base(1), 'red').state;
  const parked = withLive(polled(red, [listed(1, 'Ready')]).state, 1, { worktree: WORKTREE }); // stopped in dev
  const id = ACT(parked, 1);
  const saved = (stages: LegacyStage[]): State => reduce(parked, { type: 'setStages', ...chained(stages) }).state;
  const pulled = saved([STAGES[0], { name: 'build', from: { board: ['Ready'] }, prompt: 'x' }, STAGES[2]]);
  assert.deepEqual([task(pulled, 1)?.stage, ACT(pulled, 1)], ['build', id], 'the stage that pulls Ready, the same activity');
  assert.equal(task(saved([STAGES[0], STAGES[2]]), 1)?.stage, 'spec', 'none pulls Ready: the nearest surviving stage before dev');
  const first = polled(red, [listed(2)]).state; // stopped in spec
  assert.equal(task(reduce(first, { type: 'setStages', ...chained([STAGES[1], STAGES[2]]) }).state, 2)?.stage, 'dev', 'spec was first: the first surviving stage after it');
});

test('a running task moved into an action or a gate stage by a deletion fires no entry, gate or action while its worker runs (#861)', () => {
  const running = withLive(polled(base(1), [listed(1)]).state, 1, { worktree: WORKTREE }); // 1 runs spec, with something to clean
  const intos: LegacyStage[] = [{ name: 'clean', from: { board: ['Backlog'] }, action: 'deleteActivity' }, { name: 'gate', from: { board: ['Backlog'] }, approval: true }];
  for (const into of intos) {
    const { state, effects } = reduce(running, { type: 'setStages', ...chained([into]) });
    assert.deepEqual([task(state, 1)?.stage, work(state, 1)?.stageGone], [into.name, 'spec'], into.name);
    assert.deepEqual(effects, [], `${into.name}: no deleteActivity, no source write`);
    assert.deepEqual([work(state, 1)?.approval, work(state, 1)?.deleting], [undefined, undefined], into.name);
  }
});

test('one save that renames a stage and deletes another: the deletion\'s destination is read under the new names (#861)', () => {
  const parked = polled(signaled(base(1), 'red').state, [listed(1, 'Ready')]).state; // stopped in dev
  const renamed = reduce(parked, { type: 'renameStages', renames: { spec: 'Spec' } }).state;
  const saved = reduce(renamed, { type: 'setStages', ...chained([{ ...STAGES[0], name: 'Spec' }, STAGES[2]]) }).state;
  assert.equal(task(saved, 1)?.stage, 'Spec', 'dev went: the stage before it, under its new name');
});

test('a task that leaves with its worktree keeps its activity, and the same item coming back finds it (#861)', () => {
  const seen = ranOnce(1); // stopped in spec, its worktree from SessionStart
  const id = ACT(seen, 1);
  const gone = reduce(polled(seen, []).state, { type: 'closeTask', taskId: 'board:item1' }).state;
  assert.deepEqual([gone.tasks.length, gone.activities.some((a) => a.id === id)], [0, true], 'kept while its worktree is on disk');
  assert.equal(ACT(polled(gone, [listed(1)]).state, 1), id, 'the returning task finds it through its record');
});

test('a rateLimits event merges or replaces only its own agent\'s reading; the other agent\'s stays as it was (#929)', () => {
  const claude = windows(85);
  const codex: RateLimits = { at: LIMITS.at, windows: { thirty_day: { usedPercent: 40, resetsAt: FUTURE } } };
  const both = reduce(reduce(base(1), { type: 'rateLimits', agent: 'claude', rateLimits: claude }).state, { type: 'rateLimits', agent: 'codex', rateLimits: codex }).state;
  assert.deepEqual(both.rateLimits, { claude, codex });
  const lower = windows(20);
  assert.deepEqual(reduce(both, { type: 'rateLimits', agent: 'claude', rateLimits: lower, replace: true }).state.rateLimits, { claude: lower, codex }, 'replace: Claude\'s only');
  const codexLower: RateLimits = { at: LIMITS.at, windows: { thirty_day: { usedPercent: 10, resetsAt: FUTURE } } };
  assert.deepEqual(reduce(both, { type: 'rateLimits', agent: 'codex', rateLimits: codexLower }).state.rateLimits, { claude, codex }, 'merged: the higher percent stands, Claude\'s untouched');
});
