import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { activityOf } from '../src/activities.js';
import { HANDOFF_PROMPT } from '../src/spawn.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Activity, Effect, Item, SourceItem, State, Task } from '../src/types.js';
import { move, chained } from './fakes.js';
import { workId } from './fixtures/work.js';
import { transitionKey } from '../src/transitions.js';
import { sessionsOf } from '../src/tasks.js';

// spec runs in its own session; plan starts a new one and asks for a handoff (#692)
const SPEC: LegacyStage = { name: 'spec', from: { board: ['Backlog'] }, onFinish: { board: [move('Ready')] }, prompt: '/hive:new-spec {url}' };
const PLAN: LegacyStage = { name: 'plan', from: { board: ['Ready'] }, prompt: '/hive:new-plan {url}', handoff: true };
const PLAIN: LegacyStage = { name: 'plan', from: { board: ['Ready'] }, prompt: '/hive:new-plan {url}' };
const GATED: LegacyStage[] = [{ ...SPEC, approval: true }, PLAN];
const ID = 'board:item1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const listed: SourceItem = { item, column: 'Backlog' };
// The task as these tests read it (#629): its own fields over its live activity's, where the run fields live
const task = (s: State): Task & Partial<Activity> => ({ ...activityOf(s, ID), ...s.tasks.find((c) => c.item.itemId === ID)! });
const types = (effects: Effect[]): string[] => effects.map((e) => e.type);
// Task 1 running spec in the only worker, green
const running = (stages: LegacyStage[] = [SPEC, PLAN]): State =>
  reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, ...chained(stages) }, { type: 'poll', source: 'board', items: [listed] }).state;
// hive_done (with its result) then the Stop: what ends a stage
const stageEnd = (state: State, result?: Record<string, unknown>) => {
  const ptyId = state.workers[0].runId!;
  return reduce(reduce(state, { type: 'done', ptyId, ...(result ? { result } : {}) }).state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
};

test('a stage end whose next stage asks for a handoff keeps the task, marks it handoffPending and answers the Stop with HANDOFF_PROMPT in the same session; the input is never mutated (#692)', () => {
  const first = running();
  const ptyId = first.workers[0].runId!;
  const frozen = structuredClone(first);
  const { state, effects } = stageEnd(first);
  assert.deepEqual(first, frozen);
  const kept = task(state);
  assert.deepEqual([kept.stage, kept.boardColumn, kept.handoffPending, kept.workerId, state.workers[0].status, state.workers[0].done], ['spec', 'Backlog', transitionKey({ from: 'spec', when: 'done' }), state.workers[0].id, 'working', undefined]);
  assert.deepEqual(effects.map((e) => (e.type === 'continue' ? [e.type, e.ptyId, e.stage.name, e.prompt] : [e.type])), [['continue', ptyId, 'spec', HANDOFF_PROMPT]], 'no onFinish yet, no kill');
});

test('the handoff\'s hive_done and Stop move the task as usual and clear the flag; the next stage\'s new session carries result.handoff (#692)', () => {
  const asked = stageEnd(running()).state;
  const ptyId = asked.workers[0].runId!;
  const { state, effects } = stageEnd(asked, { handoff: 'spec at docs/s.md; plan next' });
  const moved = task(state);
  assert.deepEqual([moved.stage, 'handoffPending' in moved], ['plan', false]);
  assert.deepEqual(types(effects), ['kill', 'setColumn', 'spawn']);
  const spawn = effects.find((e) => e.type === 'spawn');
  assert.ok(spawn?.type === 'spawn' && spawn.stage.name === 'plan' && spawn.session === 'new' && spawn.worker.runId !== ptyId, JSON.stringify(spawn));
  assert.deepEqual(spawn.result, { handoff: 'spec at docs/s.md; plan next' });
  const bare = task(stageEnd(asked).state);
  assert.deepEqual([bare.stage, 'handoffPending' in bare], ['plan', false], 'a hive_done without handoff moves it too');
});

test('a stage end whose next stage has no handoff moves at once (#692)', () => {
  const { state, effects } = stageEnd(running([SPEC, PLAIN]));
  assert.deepEqual([task(state).stage, 'handoffPending' in task(state)], ['plan', false]);
  assert.deepEqual(types(effects), ['kill', 'setColumn', 'spawn', 'forgetScrollback']);
});

test('approve takes the same path: the task stays, marked, and the stage\'s session resumes with HANDOFF_PROMPT; the handoff\'s end moves it past the approval (#692)', () => {
  const awaiting = stageEnd(running(GATED)).state; // plan starts a new session: the run ended, nothing holds the Stop
  const session = task(awaiting).sessionId;
  const { state, effects } = reduce(awaiting, { type: 'approve', activityId: workId(awaiting, ID) });
  const asked = task(state);
  assert.deepEqual([asked.stage, asked.handoffPending, 'approval' in asked, 'handover' in asked], ['spec', transitionKey({ from: 'spec', when: 'approved' }), false, false]);
  const [spawn] = effects;
  assert.ok(spawn?.type === 'spawn' && spawn.prompt === HANDOFF_PROMPT && spawn.run === 'continue' && spawn.session === 'continue' && spawn.activity.sessionId === session, JSON.stringify(effects));
  const ended = stageEnd(state, { handoff: 'h' }).state;
  assert.deepEqual([task(ended).stage, 'approval' in task(ended), 'handoffPending' in task(ended)], ['plan', false, false], 'approved once: no second wait');
});

test('approve with the stage\'s session open in the user\'s own session types HANDOFF_PROMPT there; its hive_done moves the task past the approval (#692, #483)', () => {
  const first = running(GATED);
  const worker = first.workers[0].runId!;
  const seen = reduce(first, { type: 'hook', ptyId: worker, payload: { hook_event_name: 'SessionStart', cwd: '/tmp/worktrees/hive-1-task-1' } }).state;
  const idle = reduce(reduce(seen, { type: 'stop', ptyId: worker }).state, { type: 'exit', ptyId: worker }).state;
  const opened = reduce(idle, { type: 'openSession', activityId: workId(idle, ID) }).state;
  const ptyId = opened.workers.find((s) => s.freeSession)!.runId!;
  const parked = reduce(opened, { type: 'done', ptyId }).state;
  const { state, effects } = reduce(parked, { type: 'approve', activityId: workId(parked, ID) });
  assert.deepEqual(effects, [{ type: 'input', ptyId, text: HANDOFF_PROMPT }]);
  assert.deepEqual([task(state).stage, task(state).handoffPending], ['spec', transitionKey({ from: 'spec', when: 'approved' })]);
  const moved = reduce(state, { type: 'done', ptyId, result: { handoff: 'h' } }).state;
  assert.deepEqual([task(moved).stage, 'handoffPending' in task(moved), 'approval' in task(moved)], ['plan', false, false]);
});

test('approve after a new free session\'s hive_done asks that session for the handoff: once it is closed, the handover resumes it (#812, #692)', () => {
  const first = running(GATED);
  const worker = first.workers[0].runId!;
  const seen = reduce(first, { type: 'hook', ptyId: worker, payload: { hook_event_name: 'SessionStart', cwd: '/tmp/worktrees/hive-1-task-1' } }).state;
  const idle = reduce(reduce(seen, { type: 'stop', ptyId: worker }).state, { type: 'exit', ptyId: worker }).state;
  const opened = reduce(idle, { type: 'openSession', activityId: workId(idle, ID) }).state;
  const own = opened.workers.find((s) => s.freeSession)!;
  const closed = reduce(reduce(opened, { type: 'done', ptyId: own.runId! }).state, { type: 'exit', ptyId: own.runId! }).state;
  const approved = reduce(closed, { type: 'approve', activityId: workId(closed, ID) });
  const asked = task(approved.state);
  assert.deepEqual([asked.stage, asked.handoffPending, 'approval' in asked, asked.handover?.sessionId], ['spec', transitionKey({ from: 'spec', when: 'approved' }), false, own.sessionId]);
  // the stage run was stopped by hand: the fill leaves the task, a start takes the handover
  const spawn = [...approved.effects, ...reduce(approved.state, { type: 'start', itemId: ID }).effects].find((e) => e.type === 'spawn');
  assert.ok(spawn?.type === 'spawn' && spawn.run === 'continue' && spawn.activity.sessionId === own.sessionId && spawn.prompt === HANDOFF_PROMPT, JSON.stringify(spawn));
  assert.equal(sessionsOf(approved.state, ID).length, 2, 'the stage run\'s and the free one');
});

// The handoff run stopped by the user: the task sits in spec, stopped, still marked
function stoppedAsking(): State {
  const asked = stageEnd(running()).state;
  const ptyId = asked.workers[0].runId!;
  return reduce(reduce(asked, { type: 'stop', ptyId }).state, { type: 'exit', ptyId }).state;
}

test('Restart and a manual move clear handoffPending (#692)', () => {
  const stopped = stoppedAsking();
  assert.equal(task(stopped).handoffPending, transitionKey({ from: 'spec', when: 'done' }));
  const started = reduce(stopped, { type: 'stageStarted', activityId: workId(stopped, ID), stage: 'spec', commit: 'abc1234' }).state;
  const restarted = reduce(started, { type: 'restart', activityId: workId(started, ID) });
  assert.deepEqual([types(restarted.effects), 'handoffPending' in task(restarted.state)], [['spawn'], false]);
  const manual = reduce(stopped, { type: 'setAuto', taskId: ID, auto: false }).state; // auto off: the fill leaves it in plan, where the assertion reads it
  const moved = reduce(manual, { type: 'moveToStage', taskId: ID, stage: 'plan' }).state;
  assert.deepEqual([task(moved).stage, 'handoffPending' in task(moved)], ['plan', false]);
});

test('a handoff from an earlier stage never reaches a later one: asking for a new handoff drops the old, so a bare hive_done carries none (#692)', () => {
  const BUILD: LegacyStage = { name: 'build', from: { board: ['Doing'] }, prompt: '/hive:new-build {url}', handoff: true };
  const first = running([SPEC, { ...PLAN, onFinish: { board: [move('Doing')] } }, BUILD]);
  const inPlan = stageEnd(stageEnd(first).state, { handoff: 'spec to plan' }).state; // A -> B with a real handoff
  const asked = stageEnd(inPlan).state; // B ends: the handoff for C is asked, the old one dropped
  const { state, effects } = stageEnd(asked); // B answers with a bare hive_done
  const spawn = effects.find((e) => e.type === 'spawn');
  assert.deepEqual([task(state).stage, spawn?.type === 'spawn' ? spawn.result?.handoff : 'no spawn'], ['build', undefined]);
});

test('a task re-entering a handoff stage does not read the handoff of its first pass (#692)', () => {
  const fresh = running();
  // What the first pass left behind: its record still holds the handoff, and the task is in spec again
  const stale: State = { ...fresh, activityRecords: fresh.activityRecords.map((r) => (r.taskIds.includes(ID) ? { ...r, result: { handoff: 'first pass', keep: 1 } } : r)) };
  const { effects } = stageEnd(stageEnd(stale).state);
  const spawn = effects.find((e) => e.type === 'spawn');
  assert.ok(spawn?.type === 'spawn' && spawn.stage.name === 'plan');
  assert.deepEqual(spawn.result, { keep: 1 }, 'the handoff is gone, the other results stay');
});
