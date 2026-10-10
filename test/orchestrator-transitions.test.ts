import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, resultOf, withActivity } from '../src/activities.js';
import { HANDOFF_PROMPT } from '../src/spawn.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { sessionsOf } from '../src/tasks.js';
import { transitionKey } from '../src/transitions.js';
import type { Effect, HiveEvent, Item, Stage, State, Transition } from '../src/types.js';
import { move } from './fakes.js';
import { workId } from './fixtures/work.js';

// The flow as a graph (#134), end to end through reduce: every stage end takes the transition its trigger fires.

const ID = 'board:1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const STAGES: Stage[] = [
  { name: 'Build', from: { board: ['Ready'] }, prompt: '/build {url}' },
  { name: 'Review', from: { board: ['Review'] }, prompt: '/review {url}' },
  { name: 'Ship', from: { board: ['Ship'] }, prompt: '/ship {url}' },
];
// Task 1 polled into the first stage, running in the only worker, green
const flow = (transitions: Transition[], stages: Stage[] = STAGES): State =>
  reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, stages, transitions }, { type: 'poll', source: 'board', items: [{ item, column: 'Ready' }] }).state;
// hive_done, then its Stop: what ends a stage
const stageEnd = (state: State, done: Partial<Extract<HiveEvent, { type: 'done' }>> = {}) => {
  const ptyId = state.workers[0].runId ?? '';
  return reduce(reduce(state, { type: 'done', ptyId, ...done }).state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
};
const taskOf = (s: State) => s.tasks.find((t) => t.item.itemId === ID);
const columns = (effects: Effect[]): string[] => effects.flatMap((e) => (e.type === 'setColumn' ? [e.column] : []));

test('a stage end takes the transition its trigger fires: its sources written in order, the task into `to` past a stage in between, the arrow kept as via (#134)', () => {
  const skip: Transition = { from: 'Build', to: 'Ship', when: 'done', sources: { board: [move('Shipping')] } };
  const { state, effects } = stageEnd(flow([skip]));
  assert.equal(taskOf(state)?.stage, 'Ship');
  assert.deepEqual(columns(effects), ['Shipping']);
  assert.equal(activityOf(state, ID)?.via, transitionKey(skip));
});

test('a transition to end takes the task out of the Hive after its sources, as the last stage did (#134)', () => {
  const { state, effects } = stageEnd(flow([{ from: 'Build', to: 'end', when: 'done', sources: { board: [move('Done')] } }]));
  assert.equal(taskOf(state), undefined);
  assert.deepEqual(columns(effects), ['Done']);
});

test('a stage end no transition matches stops the task in its stage with the error, out of the fill until a manual start (#134)', () => {
  const { state, effects } = stageEnd(flow([]));
  const live = activityOf(state, ID);
  assert.deepEqual([taskOf(state)?.stage, live?.stopped, live?.error], ['Build', true, 'no transition: done']);
  assert.ok(effects.some((e) => e.type === 'kill'));
  assert.equal(reduce(state, { type: 'setSignal', signal: 'green' }).effects.some((e) => e.type === 'spawn'), false);
});

test('approve fires the approved transition; with none (nor a feedback one) the task keeps awaiting; a gate approved to end leaves (#134)', () => {
  const stages: Stage[] = [{ name: 'Gate', from: { board: ['Ready'] }, approval: true }, ...STAGES.slice(1)];
  const gated = flow([{ from: 'Gate', to: 'Review', when: 'approved' }], stages);
  assert.equal(taskOf(reduce(gated, { type: 'approve', activityId: workId(gated, ID) }).state)?.stage, 'Review');
  const stuck = flow([], stages);
  const refused = reduce(stuck, { type: 'approve', activityId: workId(stuck, ID) }).state;
  assert.deepEqual([taskOf(refused)?.stage, activityOf(refused, ID)?.approval, activityOf(refused, ID)?.error], ['Gate', activityOf(stuck, ID)?.approval, undefined], 'no approved transition: the approval is kept');
  const unheard = reduce(stuck, { type: 'feedback', activityId: workId(stuck, ID), text: 'fix it', start: true }).state;
  assert.deepEqual([taskOf(unheard)?.stage, activityOf(unheard, ID)?.approval, activityOf(unheard, ID)?.error], ['Gate', activityOf(stuck, ID)?.approval, undefined], 'nor a feedback one');
  const out = flow([{ from: 'Gate', to: 'end', when: 'approved' }], stages);
  assert.equal(taskOf(reduce(out, { type: 'approve', activityId: workId(out, ID) }).state), undefined);
});

test('a handoff the destination asks for waits on the transition that asked; the next end fires that one (#134, #692)', () => {
  const stages: Stage[] = [STAGES[0], { ...STAGES[1], handoff: true }, STAGES[2]];
  const toReview: Transition = { from: 'Build', to: 'Review', when: 'done' };
  const asked = stageEnd(flow([toReview], stages)).state;
  assert.deepEqual([taskOf(asked)?.stage, activityOf(asked, ID)?.handoffPending], ['Build', transitionKey(toReview)]);
  assert.equal(taskOf(stageEnd(asked).state)?.stage, 'Review');
});

const VERDICT_STAGES: Stage[] = [STAGES[0], { ...STAGES[1], verdicts: ['ok', 'redo'] }, STAGES[2]];

test('an agent verdict fires its own transition with the evidence on the record; a verdict with none of its own falls back to done (#134)', () => {
  const transitions: Transition[] = [
    { from: 'Build', to: 'Review', when: 'done' }, { from: 'Review', to: 'Build', when: 'verdict', verdict: 'redo' }, { from: 'Review', to: 'Ship', when: 'done' },
  ];
  const inReview = reduce(stageEnd(flow(transitions, VERDICT_STAGES)).state, { type: 'setSignal', signal: 'green' }).state;
  const back = stageEnd(inReview, { verdict: 'redo', evidence: 'src/a.ts:3' }).state;
  assert.equal(taskOf(back)?.stage, 'Build');
  assert.deepEqual(resultOf(back, ID)?.verdict, { name: 'redo', evidence: 'src/a.ts:3' });
  const ok = stageEnd(inReview, { verdict: 'ok' }).state;
  assert.equal(taskOf(ok)?.stage, 'Ship');
});

test('an approval stage takes a verdict with a transition at once, and waits for the user on any other end (#134)', () => {
  const stages: Stage[] = [STAGES[0], { ...STAGES[1], approval: true, verdicts: ['redo'] }, STAGES[2]];
  const transitions: Transition[] = [
    { from: 'Build', to: 'Review', when: 'done' }, { from: 'Review', to: 'Build', when: 'verdict', verdict: 'redo' }, { from: 'Review', to: 'Ship', when: 'approved' },
  ];
  const inReview = reduce(stageEnd(flow(transitions, stages)).state, { type: 'setSignal', signal: 'green' }).state;
  const routed = stageEnd(inReview, { verdict: 'redo' }).state;
  assert.deepEqual([taskOf(routed)?.stage, activityOf(routed, ID)?.approval], ['Build', undefined]);
  const waits = stageEnd(inReview).state;
  assert.equal(taskOf(waits)?.stage, 'Review');
  assert.ok(activityOf(waits, ID)?.approval);
});

test('a transition with maxTries counts per task; once they ran out the task stops in the origin with the evidence kept; approve and a move by hand drop the tries (#134)', () => {
  const stages: Stage[] = [STAGES[0], { ...STAGES[1], approval: true, verdicts: ['redo'] }, STAGES[2]];
  const redo: Transition = { from: 'Review', to: 'Build', when: 'verdict', verdict: 'redo', maxTries: 1 };
  const transitions: Transition[] = [{ from: 'Build', to: 'Review', when: 'done' }, redo, { from: 'Review', to: 'Ship', when: 'approved' }];
  const green = (s: State): State => reduce(s, { type: 'setSignal', signal: 'green' }).state;
  const once = stageEnd(green(stageEnd(flow(transitions, stages)).state), { verdict: 'redo', evidence: 'first' }).state;
  assert.deepEqual([taskOf(once)?.stage, activityOf(once, ID)?.tries, activityOf(once, ID)?.via], ['Build', { [transitionKey(redo)]: 1 }, transitionKey(redo)]);
  const again = green(stageEnd(green(once)).state);
  const out = stageEnd(again, { verdict: 'redo', evidence: 'second' }).state;
  assert.deepEqual([taskOf(out)?.stage, activityOf(out, ID)?.stopped, activityOf(out, ID)?.error], ['Review', true, 'tries out: verdict:redo · 1']);
  assert.deepEqual(resultOf(out, ID)?.verdict, { name: 'redo', evidence: 'second' });
  const waiting = stageEnd(again).state;
  const approved = reduce(waiting, { type: 'approve', activityId: workId(waiting, ID) }).state;
  assert.deepEqual([taskOf(approved)?.stage, activityOf(approved, ID)?.tries], ['Ship', undefined], 'a user transition earns the tries back');
  const moved = reduce(out, { type: 'moveToStage', taskId: ID, stage: 'Build' }).state;
  assert.deepEqual([activityOf(moved, ID)?.tries, activityOf(moved, ID)?.via], [undefined, undefined]);
});

const spawnOf = (effects: Effect[]) => effects.find((e): e is Extract<Effect, { type: 'spawn' }> => e.type === 'spawn');
const sessionIn = (s: State, stage: string): string | undefined => sessionsOf(s, ID).filter((x) => x.stages.includes(stage)).at(-1)?.id;
// Under red the Stop's fill starts nothing, so the handover stays queued for the next spawn to read
const red = (s: State): State => reduce(s, { type: 'setSignal', signal: 'red' }).state;

test('a transition with a prompt and a session hands them to the destination\'s next spawn: the transition alone in the continued session, {verdict} filled (#134)', () => {
  const back: Transition = { from: 'Review', to: 'Build', when: 'verdict', verdict: 'redo', prompt: 'Fix:\n\n{verdict}', session: { continueOf: 'Build' } };
  const inReview = reduce(stageEnd(flow([{ from: 'Build', to: 'Review', when: 'done' }, back], VERDICT_STAGES)).state, { type: 'setSignal', signal: 'green' }).state;
  const build = sessionIn(inReview, 'Build');
  const queued = stageEnd(red(inReview), { verdict: 'redo', evidence: 'src/a.ts:3' }).state;
  assert.deepEqual(activityOf(queued, ID)?.handover, { prompt: 'Fix:\n\nsrc/a.ts:3', sessionId: build });
  const spawn = spawnOf(reduce(queued, { type: 'setSignal', signal: 'green' }).effects);
  assert.deepEqual([spawn?.stage.name, spawn?.session, spawn?.run, spawn?.prompt, spawn?.activity.sessionId, spawn?.activity.handover], ['Build', 'continue', 'continue', 'Fix:\n\nsrc/a.ts:3', build, undefined]);
});

test('a new session reads the transition\'s prompt, a blank line, then the destination\'s (#134)', () => {
  const ship: Transition = { from: 'Build', to: 'Ship', when: 'done', prompt: 'Ship it carefully.', session: 'new' };
  const queued = stageEnd(red(flow([ship]))).state;
  assert.deepEqual(activityOf(queued, ID)?.handover, { prompt: 'Ship it carefully.\n\n/ship https://github.com/o/r/issues/1' });
  const spawn = spawnOf(reduce(queued, { type: 'setSignal', signal: 'green' }).effects);
  assert.deepEqual([spawn?.session, spawn?.run], ['new', 'stage']);
});

test('a gate\'s feedback moves the task to the stage its transition names and resumes that stage\'s session with the feedback behind its lead (#134)', () => {
  const stages: Stage[] = [STAGES[0], { name: 'PR', from: { board: ['Review'] }, approval: true }];
  const transitions: Transition[] = [{ from: 'Build', to: 'PR', when: 'done' }, { from: 'PR', to: 'Build', when: 'feedback', session: { continueOf: 'Build' } }];
  const inGate = stageEnd(flow(transitions, stages)).state;
  const build = sessionIn(inGate, 'Build');
  const { state, effects } = reduce(inGate, { type: 'feedback', activityId: workId(inGate, ID), text: 'fix the title', start: true });
  assert.equal(taskOf(state)?.stage, 'Build');
  const spawn = spawnOf(effects);
  assert.deepEqual([spawn?.run, spawn?.prompt, spawn?.activity.sessionId], ['continue', 'The user reviewed this stage and asks:\n\nfix the title', build]);
});

test('feedback to its own stage keeps today\'s path: a held worker is answered in place with the transition\'s prompt (#134, #268)', () => {
  const stages: Stage[] = [{ ...STAGES[0], approval: true }, { ...STAGES[1], session: 'continue' }];
  const transitions: Transition[] = [{ from: 'Build', to: 'Build', when: 'feedback', session: 'previous' }, { from: 'Build', to: 'Review', when: 'approved' }];
  const held = stageEnd(flow(transitions, stages)).state;
  assert.equal(held.workers[0].status, 'approval');
  const { state, effects } = reduce(held, { type: 'feedback', activityId: workId(held, ID), text: 'more tests', start: false });
  const answered = effects.find((e): e is Extract<Effect, { type: 'continue' }> => e.type === 'continue');
  assert.deepEqual([answered?.prompt, answered?.stage.name, taskOf(state)?.stage, activityOf(state, ID)?.approval], ['The user reviewed this stage and asks:\n\nmore tests', 'Build', 'Build', undefined]);
});

test('a held worker goes on in place only on its own session: an approved transition to a new session ends the run (#134)', () => {
  const stages: Stage[] = [{ ...STAGES[0], approval: true }, { ...STAGES[1], session: 'continue' }];
  const own = stageEnd(flow([{ from: 'Build', to: 'Review', when: 'approved' }], stages)).state;
  assert.equal(own.workers[0].status, 'approval', 'continues the session: held');
  const fresh = stageEnd(flow([{ from: 'Build', to: 'Review', when: 'approved', session: 'new' }], stages));
  assert.deepEqual([fresh.state.workers[0].status, fresh.effects.some((e) => e.type === 'hold')], ['empty', false]);
});

test('feedback through a handoff reaches the destination: the handoff\'s end renders {feedback} from the pending handoff (#134, #692)', () => {
  const stages: Stage[] = [{ ...STAGES[0], approval: true }, { ...STAGES[1], handoff: true }];
  const inGate = stageEnd(flow([{ from: 'Build', to: 'Review', when: 'feedback' }], stages)).state;
  const asked = reduce(inGate, { type: 'feedback', activityId: workId(inGate, ID), text: 'split it', start: true });
  assert.equal(spawnOf(asked.effects)?.prompt, HANDOFF_PROMPT);
  const ended = stageEnd(red(asked.state), { result: { handoff: 'h' } }).state;
  assert.deepEqual([taskOf(ended)?.stage, activityOf(ended, ID)?.handover?.prompt], ['Review', 'The user reviewed this stage and asks:\n\nsplit it\n\n/review https://github.com/o/r/issues/1']);
});

test('a transition whose tries are spent stops the task with TRIES_OUT at once: no handoff turn runs for it (#134, #692)', () => {
  const stages: Stage[] = [STAGES[0], { ...STAGES[1], handoff: true }];
  const once: Transition = { from: 'Build', to: 'Review', when: 'done', maxTries: 1 };
  const running = flow([once], stages);
  const spent = withActivity(running, { ...activityOf(running, ID)!, tries: { [transitionKey(once)]: 1 } });
  const { state, effects } = stageEnd(spent);
  assert.deepEqual([taskOf(state)?.stage, activityOf(state, ID)?.error, activityOf(state, ID)?.handoffPending], ['Build', 'tries out: done · 1', undefined]);
  assert.equal(effects.some((e) => e.type === 'continue'), false);
});

test('a handoff whose transition loops to its own stage clears its pending mark when it fires: the next end asks again (#134, #692)', () => {
  const stages: Stage[] = [{ ...STAGES[0], handoff: true }];
  const loop: Transition = { from: 'Build', to: 'Build', when: 'done', maxTries: 2 };
  const asked = stageEnd(flow([loop], stages)).state;
  assert.equal(activityOf(asked, ID)?.handoffPending, transitionKey(loop));
  const looped = stageEnd(asked, { result: { handoff: 'h' } }).state;
  assert.deepEqual([taskOf(looped)?.stage, activityOf(looped, ID)?.handoffPending, activityOf(looped, ID)?.handoffFeedback], ['Build', undefined, undefined]);
});
