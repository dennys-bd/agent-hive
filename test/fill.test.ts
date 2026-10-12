import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, taskOfWorker, withActivity } from '../src/activities.js';
import type { LegacyStage } from '../src/config-migrate.js';
import { initialState, reduce, type Reduced } from '../src/orchestrator.js';
import { SIGNALS_DEFAULTS, STAGE_GONE, type Item, type Signal, type SignalBehaviour, type SignalSettings, type State, type Task, type Transition } from '../src/types.js';
import { chained, move } from './fakes.js';
import { withWork, workId } from './fixtures/work.js';

// The signal table in the reducer (#727): what each row lets the Hive start, resume, continue and run on its own. spec hands over to build,
// which goes on in the session, as in stage-caps.test.ts; the stages become #134's flowchart through chained.
const STAGES: LegacyStage[] = [
  { name: 'spec', from: { board: ['Backlog'] }, onFinish: { board: [move('Ready')] }, prompt: '/hive-spec {url}' },
  { name: 'build', from: { board: ['Ready'] }, prompt: '/hive-build {url}', session: 'continue' },
  { name: 'review', from: { board: ['In review'] } },
];
const CLEANUP: LegacyStage[] = [{ name: 'done', from: { board: ['Done'] }, action: 'deleteActivity' }, { name: 'archive', from: { board: ['Archived'] } }];
const item = (n: number): Item => ({ itemId: `board:item${n}`, id: String(n), title: `Task ${n}`, body: '', url: `https://github.com/o/r/issues/${n}`, source: 'board' });
const waiting = (n: number, stage: string): Task => ({ item: item(n), stage, boardColumn: stage, auto: true });
interface HiveOptions { signals?: SignalSettings; max?: number; stages?: LegacyStage[] }
const hive = (signal: Signal, tasks: Task[], { signals = SIGNALS_DEFAULTS, max = 1, stages = STAGES }: HiveOptions = {}): State =>
  ({ ...initialState(max), signal, signals, workspaces: ['hive'], syncs: { board: {} }, ...chained(stages), tasks });
// The defaults with one row patched
const row = (signal: 'yellow' | 'red', patch: Partial<SignalBehaviour>): SignalSettings =>
  (signal === 'yellow' ? { ...SIGNALS_DEFAULTS, yellow: { ...SIGNALS_DEFAULTS.yellow, ...patch } } : { ...SIGNALS_DEFAULTS, red: { ...SIGNALS_DEFAULTS.red, ...patch } });
// A live activity: the task is started
const begun = (state: State, n: number): State => withWork(state, `board:item${n}`, { worktree: `/wt/hive-${n}` });
const filled = (state: State): Reduced => reduce(state, { type: 'setBudget', budget: state.budget }); // any event that fills
const spawned = ({ effects }: Reduced): string[] => effects.flatMap((e) => (e.type === 'spawn' ? [e.task.item.id] : []));
const workerOf = (state: State, n: number): string => state.workers.find((s) => taskOfWorker(state, s)?.item.itemId === `board:item${n}`)!.runId!;
// hive_done, then the Stop: what ends a stage
const stageEnd = (state: State, ptyId: string): Reduced =>
  reduce(reduce(state, { type: 'done', ptyId }).state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// A goal stage with no prompt is the source's first door (#32): a root parks there and runs nothing; a child in spec or later is past it
const TREE_STAGES: LegacyStage[] = [{ name: 'goal', from: { board: ['Goals'] } }, ...STAGES];
const linked = (n: number, stage: string, links: Pick<Item, 'parent' | 'children'>): Task => ({ ...waiting(n, stage), item: { ...item(n), ...links } });
const kids = (...ns: number[]): string[] => ns.map((n) => `board:item${n}`);
const ROOT = 'board:item1';

test('yellow with the defaults: a new task waits, a started one resumes (#224, #727)', () => {
  assert.deepEqual(spawned(filled(begun(hive('yellow', [waiting(1, 'build'), waiting(2, 'build')], { max: 2 }), 2))), ['2']);
});

test('yellow with newTasks always starts a task that has not started (#727)', () => {
  assert.deepEqual(spawned(filled(hive('yellow', [waiting(1, 'build')], { signals: row('yellow', { newTasks: 'always' }) }))), ['1']);
});

test('a task whose activity a first open made is started: yellow resumes it (#727)', () => {
  const opened = reduce(hive('yellow', [waiting(1, 'build')]), { type: 'createActivity', taskId: 'board:item1' }).state;
  assert.deepEqual(spawned(filled(opened)), ['1']);
});

test('continueOnly: a started task waiting for a worker is not resumed, yet a session ending its stage goes on in place (#727)', () => {
  const only = row('yellow', { started: 'continueOnly' });
  assert.deepEqual(spawned(filled(begun(hive('yellow', [waiting(1, 'build')], { signals: only }), 1))), [], 'no resume');
  const running = filled(hive('green', [waiting(2, 'spec')], { signals: only })).state;
  const yellow = reduce(running, { type: 'setSignal', signal: 'yellow' }).state;
  assert.deepEqual(stageEnd(yellow, workerOf(yellow, 2)).effects.map((e) => e.type), ['setColumn', 'continue']);
});

test('yellow with newTasks always and stay: a new task starts, a started one is not resumed, a session ending its stage does not get its worker back (#727)', () => {
  const stay = row('yellow', { newTasks: 'always', started: 'stay' });
  assert.deepEqual(spawned(filled(begun(hive('yellow', [waiting(1, 'build'), waiting(2, 'build')], { signals: stay, max: 2 }), 1))), ['2']);
  const running = filled(hive('green', [waiting(3, 'spec')], { signals: stay })).state;
  const yellow = reduce(running, { type: 'setSignal', signal: 'yellow' }).state;
  const ended = stageEnd(yellow, workerOf(yellow, 3));
  assert.deepEqual([spawned(ended), ended.state.workers[0].status], [[], 'empty']);
});

test('yellow with newTasks always and continueOnly: a session ending its stage goes on in place, a started task without a worker is not resumed (#727)', () => {
  const only = row('yellow', { newTasks: 'always', started: 'continueOnly' });
  assert.deepEqual(spawned(filled(begun(hive('yellow', [waiting(1, 'build')], { signals: only }), 1))), [], 'no resume');
  const running = filled(hive('green', [waiting(2, 'spec')], { signals: only })).state;
  const yellow = reduce(running, { type: 'setSignal', signal: 'yellow' }).state;
  assert.deepEqual(stageEnd(yellow, workerOf(yellow, 2)).effects.map((e) => e.type), ['setColumn', 'continue']);
});

test('stay: a session ending its stage does not go on; its run ends and the worker frees (#727)', () => {
  const running = filled(hive('green', [waiting(2, 'spec')])).state;
  const red = reduce(running, { type: 'setSignal', signal: 'red' }).state;
  const { state, effects } = stageEnd(red, workerOf(red, 2));
  assert.deepEqual(effects.map((e) => e.type), ['kill', 'setColumn', 'forgetScrollback']);
  assert.equal(state.workers[0].status, 'empty');
});

test('no signal stops a running worker: red leaves it working until its stage ends (#727)', () => {
  const running = filled(hive('green', [waiting(1, 'build')])).state;
  const red = reduce(running, { type: 'setSignal', signal: 'red' });
  assert.deepEqual([red.effects, red.state.workers[0].status], [[], 'working']);
});

test('a delete-activity stage runs on its own only while the signal\'s workerless row is on; a looser signal acts at once (#727)', () => {
  const parked = (signals: SignalSettings): State => withWork(hive('red', [waiting(1, 'done')], { signals, stages: CLEANUP }), 'board:item1', { worktree: '/wt/hive-1' });
  const deletes = (r: Reduced): boolean => r.effects.some((e) => e.type === 'deleteActivity');
  assert.equal(deletes(reduce(parked(SIGNALS_DEFAULTS), { type: 'poll', items: [] })), true, 'red with the defaults');
  const off = row('red', { workerless: false });
  assert.equal(deletes(reduce(parked(off), { type: 'poll', items: [] })), false);
  assert.equal(deletes(reduce(parked(off), { type: 'setSignal', signal: 'green' })), true, 'not at the next poll');
});

test('shut down when done follows the flow\'s signal: armed under green, a free worker still takes a new task (#233, #727)', () => {
  assert.deepEqual(spawned(reduce(hive('green', [waiting(1, 'build')]), { type: 'setShutdown', armed: true })), ['1']);
});

test('setSignals replaces the table and fills: a yellow that now starts new tasks hands the free worker one (#727)', () => {
  const r = reduce(hive('yellow', [waiting(1, 'build')]), { type: 'setSignals', signals: row('yellow', { newTasks: 'always' }) });
  assert.deepEqual([spawned(r), r.state.signals.yellow.newTasks], [['1'], 'always']);
});

test('a start by hand bypasses the signal: under red, over a full cap, it opens a draining worker (#116, #727)', () => {
  const full = filled(hive('green', [waiting(1, 'build'), waiting(2, 'build')])).state;
  const red = reduce(full, { type: 'setSignal', signal: 'red' }).state;
  const { state } = reduce(red, { type: 'start', itemId: 'board:item2' });
  assert.deepEqual(state.workers.map((w) => [w.status, w.draining]), [['working', undefined], ['working', true]]);
});

test('the rules never mutate the state they are given (#727)', () => {
  const frozen = deepFreeze(begun(hive('yellow', [waiting(1, 'build'), waiting(2, 'spec')], { max: 2 }), 1));
  filled(frozen);
  reduce(frozen, { type: 'setSignals', signals: row('yellow', { newTasks: 'always' }) });
  reduce(frozen, { type: 'setSignal', signal: 'red' });
  reduce(frozen, { type: 'poll', items: [] });
});

// A commands stage (#755) holds a worker like a prompt stage (#727)
const CHECKS: LegacyStage[] = [{ name: 'checks', from: { board: ['Checks'] }, action: 'commands', commands: ['build'] }, { name: 'review', from: { board: ['In review'] } }];
const commandsRun = (r: Reduced): number => r.effects.filter((e) => e.type === 'stageCommand').length;
const ended = (state: State, code: number): Reduced => {
  const run = activityOf(state, 'board:item1')?.commands;
  return reduce(state, { type: 'stageCommandEnded', activityId: workId(state, 'board:item1'), ptyId: run?.ptyId ?? 'none', code, output: '' });
};

test('a commands stage follows the rows like a prompt stage and holds a worker until its verdict (#755, #727)', () => {
  const checks = (signal: Signal): State => hive(signal, [waiting(1, 'checks')], { stages: CHECKS });
  assert.equal(commandsRun(filled(checks('yellow'))), 0, 'a new task under the default yellow');
  const { state } = filled(checks('green'));
  const run = activityOf(state, 'board:item1')?.commands;
  assert.ok(run);
  assert.deepEqual(state.workers.map((w) => [w.id === run.workerId, w.status, w.runId, w.activityId]), [[true, 'working', undefined, undefined]]);
  assert.equal(commandsRun(filled({ ...state, tasks: [...state.tasks, waiting(2, 'checks')] })), 0, 'the one worker is the run\'s');
  const passed = ended(state, 0).state;
  assert.deepEqual([passed.tasks[0].stage, passed.workers[0].status], ['review', 'empty']);
});

test('a failed verdict frees the worker before its transition: a loop back runs again at once under green, waits under continueOnly (#134, #727)', () => {
  const retry: Transition = { from: 'checks', to: 'checks', when: 'verdict', verdict: 'failed' };
  const looped = (signal: Signal, signals: SignalSettings): Reduced => {
    const flow = { ...chained(CHECKS), transitions: [...chained(CHECKS).transitions, retry] };
    const first = filled({ ...hive('green', [waiting(1, 'checks')], { signals }), ...flow }).state;
    return ended(reduce(first, { type: 'setSignal', signal }).state, 1);
  };
  const green = looped('green', SIGNALS_DEFAULTS);
  assert.deepEqual([commandsRun(green), green.state.workers[0].status], [1, 'working']);
  const only = looped('yellow', row('yellow', { started: 'continueOnly' }));
  assert.deepEqual([commandsRun(only), only.state.workers[0].status], [0, 'empty']);
});

test('a stopped commands run frees its worker into the fill: the next task\'s run takes it at once (#727)', () => {
  const { state } = filled(hive('green', [waiting(1, 'checks'), waiting(2, 'checks')], { stages: CHECKS }));
  const r = reduce(state, { type: 'stop', ptyId: activityOf(state, 'board:item1')?.commands?.ptyId ?? '' });
  assert.equal(commandsRun(r), 1);
  assert.ok(activityOf(r.state, 'board:item2')?.commands);
  assert.equal(r.state.workers[0].status, 'working');
});

test('a commands run counts against its stage cap: a stage at maxWorkers 1 starts no second one (#475, #727)', () => {
  const capped = CHECKS.map((s) => (s.name === 'checks' ? { ...s, maxWorkers: 1 } : s));
  const r = filled(hive('green', [waiting(1, 'checks'), waiting(2, 'checks')], { max: 2, stages: capped }));
  assert.equal(commandsRun(r), 1);
  assert.equal(r.state.workers.filter((w) => w.status === 'empty').length, 1);
});

test('a session ending its stage into a commands stage hands its worker to the run under continueOnly; under stay the task waits (#727)', () => {
  const INTO: LegacyStage[] = [{ name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive-spec {url}' }, ...CHECKS];
  const stopped = (signals: SignalSettings): Reduced => {
    const running = filled(hive('green', [waiting(1, 'spec')], { signals, stages: INTO })).state;
    const yellow = reduce(running, { type: 'setSignal', signal: 'yellow' }).state;
    return stageEnd(yellow, workerOf(yellow, 1));
  };
  const only = stopped(row('yellow', { started: 'continueOnly' }));
  assert.deepEqual([commandsRun(only), only.state.workers[0].status, only.state.workers[0].runId], [1, 'working', undefined]);
  const stay = stopped(row('yellow', { started: 'stay' }));
  assert.deepEqual([commandsRun(stay), stay.state.workers[0].status], [0, 'empty']);
});

test('a start by hand runs a commands stage past red and over a full cap, in a draining worker (#116, #755, #727)', () => {
  const full = filled(hive('green', [waiting(1, 'build'), waiting(2, 'checks')], { stages: [CHECKS[0], ...STAGES] })).state;
  const red = reduce(full, { type: 'setSignal', signal: 'red' }).state;
  const r = reduce(red, { type: 'start', itemId: 'board:item2' });
  assert.equal(commandsRun(r), 1);
  assert.deepEqual(r.state.workers.map((w) => [w.status, w.draining]), [['working', undefined], ['working', true]]);
});

test('a save that removes a running commands stage frees the run\'s worker with its task and activity (#755, #727)', () => {
  const { state } = filled(hive('green', [waiting(1, 'checks')], { stages: CHECKS }));
  assert.equal(state.workers[0].status, 'working');
  const removed = reduce(state, { type: 'setStages', ...chained([{ name: 'review', from: { board: ['In review'] } }]) }).state;
  assert.deepEqual([removed.tasks.length, removed.activities.length, removed.workers[0].status], [0, 0, 'empty']);
});

test('a commands run\'s start, verdict and stop never mutate the state they are given (#727)', () => {
  const frozen = deepFreeze(filled(hive('green', [waiting(1, 'checks')], { stages: CHECKS })).state);
  ended(frozen, 0);
  ended(frozen, 1);
  reduce(frozen, { type: 'stop', ptyId: activityOf(frozen, 'board:item1')?.commands?.ptyId ?? '' });
  reduce(frozen, { type: 'boot' });
});

test('a child with no workspace of its own spawns in its parent\'s hand-picked one, frozen on the task (#32)', () => {
  const root: Task = { ...linked(1, 'goal', { children: kids(2) }), workspace: 'site' };
  const state: State = { ...hive('green', [root, linked(2, 'build', { parent: ROOT })], { stages: TREE_STAGES }), workspaces: ['hive', 'site'] };
  assert.deepEqual(filled(state).effects.flatMap((e) => (e.type === 'spawn' ? [e.task.workspace] : [])), ['site']);
});

// R (1) parks in goal with children 2 and 3; 3 is the new task that waits in spec (#32)
const tree = (two: Task, signals: SignalSettings = SIGNALS_DEFAULTS): State =>
  hive('yellow', [linked(1, 'goal', { children: kids(2, 3) }), two, linked(3, 'spec', { parent: ROOT })], { signals, stages: TREE_STAGES });

test('under tree the fill starts a child whose sibling has a live activity, and skips one of a tree with no started task (#32)', () => {
  const sibling = linked(2, 'goal', { parent: ROOT });
  assert.deepEqual(spawned(filled(begun(tree(sibling), 2))), ['3']);
  assert.deepEqual(spawned(filled(tree(sibling))), [], 'nothing of the tree started: the child waits');
});

test('under tree a sibling past the first stage counts as started with no activity: the tree\'s first children may have finished (#32)', () => {
  assert.deepEqual(spawned(filled(tree(linked(2, 'review', { parent: ROOT })))), ['3']);
});

test('under tree a standalone new task never starts, wherever it entered; a started one still follows started (#32)', () => {
  const alone = (signals: SignalSettings = SIGNALS_DEFAULTS): State => hive('yellow', [waiting(4, 'build')], { signals, stages: TREE_STAGES });
  assert.deepEqual(spawned(filled(alone())), [], 'past the first stage, but new');
  assert.deepEqual(spawned(filled(begun(alone(), 4))), ['4'], 'resumeAndContinue resumes it');
  assert.deepEqual(spawned(filled(begun(alone(row('yellow', { started: 'continueOnly' })), 4))), [], 'continueOnly does not');
});

test('always and never ignore the tree: always starts a standalone task, never not even a child of a started tree (#32)', () => {
  const always = hive('yellow', [waiting(4, 'build')], { signals: row('yellow', { newTasks: 'always' }), stages: TREE_STAGES });
  assert.deepEqual(spawned(filled(always)), ['4']);
  assert.deepEqual(spawned(filled(begun(tree(linked(2, 'goal', { parent: ROOT }), row('yellow', { newTasks: 'never' })), 2))), []);
});

test('a commands run whose stage was deleted (stageGone) routes no verdict at its end: the run goes, its worker frees and the task halts (#861)', () => {
  const { state } = filled(hive('green', [waiting(1, 'checks')], { stages: CHECKS }));
  const marked = withActivity(state, { ...activityOf(state, 'board:item1')!, stageGone: 'old' });
  const r = ended(marked, 0);
  const work = activityOf(r.state, 'board:item1');
  assert.deepEqual([r.state.tasks[0].stage, work?.error, work?.commands, work?.stageGone, r.state.workers[0].status], ['checks', `${STAGE_GONE}old`, undefined, undefined, 'empty']);
});
