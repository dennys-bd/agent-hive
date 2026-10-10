import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/orchestrator.js';
import { activityOf, resultOf, withActivity } from '../src/activities.js';
import { sessionsOf } from '../src/tasks.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { Activity, SourceItem, Task, Effect, State, Item } from '../src/types.js';
import { APPROVAL_HOLD_MAX_MIN, APPROVAL_MINUTES_DEFAULT } from '../src/types.js';
import { move, chained } from './fakes.js';
import { workId } from './fixtures/work.js';

const MINUTE = 60_000;
// spec asks for approval; dev goes on in the session, so a stage end in spec holds its Stop
const STAGES: LegacyStage[] = [
  { name: 'spec', from: { board: ['Backlog'] }, onStart: { board: [move('Specifying')] }, onFinish: { board: [move('Ready')] }, prompt: '/hive-spec {url}', approval: true },
  { name: 'dev', from: { board: ['Ready'] }, onFinish: { board: [move('In review')] }, prompt: '/hive-build {url}', session: 'continue' },
  { name: 'review', from: { board: ['In review'] } },
];
// dev starts a new session: an approval cannot start it in the held one, so the stage end frees the worker
const UNCHAINED: LegacyStage[] = STAGES.map((c) => (c.name === 'dev' ? { ...c, session: 'new' as const } : c));
const ID = 'board:item1';
const SLUG = 'hive-1-task-1';
const item = (n: number): Item => ({ itemId: `board:item${n}`, id: String(n), title: `Task ${n}`, body: '', url: `https://github.com/o/r/issues/${n}`, source: 'board' });
const listed = (n: number, column = 'Backlog'): SourceItem => ({ item: item(n), column });
// The task as these tests read it (#629): its own fields over its live activity's, where the reducer keeps the run fields now
const task = (s: State): (Task & Partial<Activity>) | undefined => {
  const found = s.tasks.find((c) => c.item.itemId === ID);
  return found && { ...activityOf(s, ID), ...found };
};
// Task 1 running spec in the only worker, green
const running = (stages = STAGES): State =>
  reduce({ ...initialState(1), workspaces: ['hive'], syncs: { board: {} }, ...chained(stages) }, { type: 'poll', source: 'board', items: [listed(1)] }).state;
// The worker's hive_done then its Stop: what ends a stage
const stageEnd = (state: State) => {
  const ptyId = state.workers[0].runId!;
  return reduce(reduce(state, { type: 'done', ptyId }).state, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
};
const held = (): State => stageEnd(running()).state;
const awaiting = (): State => stageEnd(running(UNCHAINED)).state; // approval, no worker
const red = (state: State): State => reduce(state, { type: 'setSignal', signal: 'red' }).state;
const withApproval = (state: State, approval: Activity['approval']): State => withActivity(state, { ...activityOf(state, ID)!, approval }); // the activity's (#629)
const types = (effects: Effect[]): string[] => effects.map((e) => e.type);
const past = (): string => new Date(Date.now() - 1).toISOString();

const LEAD = 'The user reviewed this stage and asks:'; // #134: a feedback transition's empty prompt (FEEDBACK_TEMPLATE)
const led = (text: string): string => `${LEAD}\n\n${text}`;

test('a Stop after hive_done in an approval stage whose next stage can go on in the session holds the worker: status approval, until the window, a hold effect, no source write (#268)', () => {
  const first = running();
  const ptyId = first.workers[0].runId!;
  const before = Date.now();
  const { state, effects } = stageEnd(first);
  const [worker] = state.workers;
  const parked = task(state)!;
  assert.deepEqual([worker.status, worker.runId, parked.workerId, parked.stage, parked.boardColumn], ['approval', ptyId, worker.id, 'spec', 'Specifying'], 'no onFinish: the stage is not approved yet');
  assert.ok(worker.waitingSince, 'the hold is time spent waiting for the user (#248)');
  const until = Date.parse(parked.approval?.until ?? '');
  assert.ok(until >= before + APPROVAL_MINUTES_DEFAULT * MINUTE && until <= Date.now() + APPROVAL_MINUTES_DEFAULT * MINUTE);
  assert.deepEqual(effects, [{ type: 'hold', ptyId, until: parked.approval?.until }]);
});

test('a Stop after hive_done in an approval stage whose next stage cannot go on in the session ends the run without stopping the task; the awaiting task is no fill candidate and start, continue and restart ignore it (#268)', () => {
  const first = running(UNCHAINED);
  const ptyId = first.workers[0].runId!;
  const { state, effects } = stageEnd(first);
  assert.deepEqual(effects, [{ type: 'kill', slug: SLUG, ptyId }, { type: 'forgetScrollback', ptyId: ptyId }], 'no hold, no setColumn, and the free worker takes nothing');
  const parked = task(state)!;
  assert.deepEqual([state.workers[0].status, parked.stage, parked.workerId, parked.stopped, 'until' in parked.approval!], ['empty', 'spec', undefined, undefined, false]);
  assert.deepEqual(reduce(state, { type: 'setSignal', signal: 'green' }).effects, [], 'awaiting is a stop for the user');
  for (const event of [{ type: 'start', itemId: ID }, { type: 'continue', activityId: workId(state, ID) }, { type: 'restart', activityId: workId(state, ID) }] as const) {
    assert.equal(reduce(state, event).state, state, event.type);
  }
});

test('approve on a held worker writes onFinish and answers the Stop with the next stage, same worker and same run, under green and under yellow (#268, #321)', () => {
  for (const signal of ['green', 'yellow'] as const) {
    const parked = reduce(held(), { type: 'setSignal', signal }).state;
    const ptyId = parked.workers[0].runId!;
    const { state, effects } = reduce(parked, { type: 'approve', activityId: workId(parked, ID) });
    assert.deepEqual(
      effects.map((e) => (e.type === 'continue' ? [e.type, e.stage.name, e.ptyId, e.prompt] : e.type === 'setColumn' ? [e.type, e.column] : [e.type])),
      [['setColumn', 'Ready'], ['continue', 'dev', ptyId, undefined]], `${signal}: approving is not a prompt, the next stage brings its own`,
    );
    const moved = task(state)!;
    assert.deepEqual([state.workers[0].status, state.workers[0].runId, state.workers[0].done, moved.stage, moved.workerId, 'approval' in moved], ['working', ptyId, undefined, 'dev', state.workers[0].id, false]);
    assert.equal(reduce(state, { type: 'approve', activityId: workId(state, ID) }).state, state, 'approved once: nothing awaits');
  }
});

// What canContinue refuses ends the held run like finish's kill; the task waits in dev for the fill (#321)
const assertEndedInDev = (parked: State, why: string): State => {
  const ptyId = parked.workers[0].runId!;
  const { state, effects } = reduce(parked, { type: 'approve', activityId: workId(parked, ID) });
  assert.deepEqual(effects, [
    { type: 'setColumn', itemId: ID, column: 'Ready' }, { type: 'release', ptyId }, { type: 'kill', slug: SLUG, ptyId },
  ], `${why}: no continue, and the fill starts nothing`);
  const moved = task(state)!;
  assert.deepEqual([moved.stage, moved.workerId, 'approval' in moved, state.workers.some((s) => s.runId === ptyId)], ['dev', undefined, false, false], why);
  return state;
};

test('approve on a held worker under red ends the run: release and kill, the task waits in dev with no worker, and starts once green (#321)', () => {
  const state = assertEndedInDev(red(held()), 'red');
  assert.deepEqual(types(reduce(state, { type: 'setSignal', signal: 'green' }).effects), ['spawn', 'forgetScrollback'], 'a candidate like any task in dev; #672: its continued session no longer sleeps');
});

test('approve on a held worker with the budget spent ends the run: release and kill, the task waits in dev (#321)', () => {
  const parked = held();
  assertEndedInDev({ ...parked, budget: { maxTokensPerHour: 1 }, usage: [{ at: new Date().toISOString(), tokens: 10 }] }, 'budget');
});

test('approve on a held worker that is draining over the cap ends the run: release and kill, the worker goes, the task waits in dev (#321)', () => {
  const tight = reduce(held(), { type: 'setMax', max: 0 }).state;
  assert.equal(tight.workers[0].draining, true);
  assert.deepEqual(assertEndedInDev(tight, 'draining').workers, []);
});

test('approve on a held worker with a task in a later stage queued ends the run and the fill hands the worker to that task (#321, #316)', () => {
  const stages: LegacyStage[] = [...STAGES, { name: 'ship', from: { board: ['Ship'] }, prompt: '/ship {url}' }]; // after dev in the stages array
  const parked = stageEnd(running(stages)).state;
  const queued = reduce(parked, { type: 'poll', source: 'board', items: [listed(1, 'Specifying'), listed(2, 'Ship')] }).state;
  const ptyId = queued.workers[0].runId!;
  assert.equal(queued.tasks.length, 2);
  const { state, effects } = reduce(queued, { type: 'approve', activityId: workId(queued, ID) });
  assert.deepEqual(types(effects), ['setColumn', 'release', 'kill', 'spawn'], JSON.stringify(effects));
  const [spawn] = effects.filter((e) => e.type === 'spawn');
  assert.ok(spawn?.type === 'spawn' && spawn.task.item.itemId === 'board:item2' && spawn.stage.name === 'ship', 'ship comes after dev: its task outranks the continuation');
  assert.deepEqual([task(state)?.stage, task(state)?.workerId, state.workers[0].runId === ptyId], ['dev', undefined, false]);
});

test('approve without a held worker writes onFinish and leaves the task queued in the next stage; after the last stage the task leaves the Hive (#268)', () => {
  const given = red(awaiting());
  const { state, effects } = reduce(given, { type: 'approve', activityId: workId(given, ID) });
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: ID, column: 'Ready' }], 'red: nothing starts it yet');
  assert.deepEqual([task(state)?.stage, task(state)?.boardColumn, 'approval' in task(state)!], ['dev', 'Ready', false]);
  assert.deepEqual(types(reduce(state, { type: 'setSignal', signal: 'green' }).effects), ['spawn'], 'a candidate like any task in dev');
  const last = stageEnd(running([STAGES[0]])).state; // spec alone: no next stage, so no hold either
  const gone = reduce(last, { type: 'approve', activityId: workId(last, ID) });
  assert.deepEqual([gone.state.tasks, gone.effects], [[], [{ type: 'setColumn', itemId: ID, column: 'Ready' }]]);
});

test('feedback on a held worker answers the Stop with the text in the same stage: worker working, done cleared, approval dropped; the next hive_done asks again (#268)', () => {
  const parked = held();
  const ptyId = parked.workers[0].runId!;
  const { state, effects } = reduce(parked, { type: 'feedback', activityId: workId(parked, ID), text: 'split the spec in two', start: false });
  assert.deepEqual(effects.map((e) => (e.type === 'continue' ? [e.type, e.stage.name, e.ptyId, e.prompt] : [e.type])), [['continue', 'spec', ptyId, led('split the spec in two')]], 'start is ignored on a held worker: it always answers now');
  assert.deepEqual([state.workers[0].status, state.workers[0].done, task(state)?.stage, 'approval' in task(state)!, 'handover' in task(state)!], ['working', undefined, 'spec', false, false]);
  const again = stageEnd(state);
  assert.deepEqual([again.state.workers[0].status, types(again.effects)], ['approval', ['hold']]);
});

test('feedback with start and no held worker resumes the stage\'s session at once as a continue run carrying the text, over the cap as a draining worker, past red (#268)', () => {
  const parked = awaiting();
  const session = sessionsOf(parked, ID).at(-1)?.id;
  const tight = reduce(red(parked), { type: 'setMax', max: 0 }).state;
  const { state, effects } = reduce(tight, { type: 'feedback', activityId: workId(tight, ID), text: 'add the error states', start: true });
  const [spawn] = effects;
  assert.ok(spawn?.type === 'spawn');
  assert.deepEqual([types(effects), spawn.stage.name, spawn.session, spawn.run, spawn.prompt, spawn.activity.sessionId], [['spawn'], 'spec', 'continue', 'continue', led('add the error states'), session], 'spec starts new sessions, but feedback answers the one that ran the stage');
  assert.deepEqual([state.workers.length, state.workers[0].draining, 'handover' in task(state)!, 'approval' in task(state)!], [1, true, false, false]);
});

test('queued feedback waits on the task, is picked by the fill as a continue run and leaves the task at the spawn (#268)', () => {
  const given = red(awaiting());
  const queued = reduce(given, { type: 'feedback', activityId: workId(given, ID), text: 'rename the flag', start: false });
  assert.deepEqual([queued.effects, task(queued.state)?.handover?.prompt, 'approval' in task(queued.state)!], [[], led('rename the flag'), false]);
  const { state, effects } = reduce(queued.state, { type: 'setSignal', signal: 'green' });
  const [spawn] = effects;
  assert.ok(spawn?.type === 'spawn' && spawn.run === 'continue' && spawn.prompt === led('rename the flag'), JSON.stringify(effects));
  assert.equal('handover' in task(state)!, false);
});

test('on a manual task queued feedback waits for Continue, which sends it instead of the continue line; Restart runs the stage afresh and drops it (#268)', () => {
  const ran = running(UNCHAINED);
  const recorded = reduce(ran, { type: 'stageStarted', activityId: activityOf(ran, ID)?.id ?? 'none', stage: 'spec', commit: 'a1b2c3d' }).state; // #629: the activity's
  const parked = reduce(stageEnd(recorded).state, { type: 'setAuto', taskId: ID, auto: false }).state;
  const queued = reduce(parked, { type: 'feedback', activityId: workId(parked, ID), text: 'rename the flag', start: false });
  assert.deepEqual([queued.effects, task(queued.state)?.handover?.prompt], [[], led('rename the flag')], 'the fill never starts a manual task');
  const [continued] = reduce(queued.state, { type: 'continue', activityId: workId(queued.state, ID) }).effects;
  assert.ok(continued?.type === 'spawn' && continued.run === 'continue' && continued.prompt === led('rename the flag'), JSON.stringify(continued));
  const restarted = reduce(queued.state, { type: 'restart', activityId: workId(queued.state, ID) });
  const [fresh] = restarted.effects;
  assert.ok(fresh?.type === 'spawn' && fresh.run === 'stage' && fresh.session === 'new' && fresh.prompt === undefined, JSON.stringify(fresh));
  assert.equal('handover' in task(restarted.state)!, false);
});

test('extendApproval moves until to now plus the window, never past the Stop\'s arrival plus APPROVAL_HOLD_MAX_MIN, and emits hold; a task with no held worker is left alone (#268)', () => {
  const parked = held();
  const ptyId = parked.workers[0].runId!;
  const since = new Date(Date.now() - 30 * MINUTE).toISOString();
  const early = reduce(withApproval(parked, { since, until: new Date().toISOString() }), { type: 'extendApproval', activityId: workId(parked, ID) });
  const until = task(early.state)?.approval?.until ?? '';
  assert.ok(Math.abs(Date.parse(until) - (Date.now() + APPROVAL_MINUTES_DEFAULT * MINUTE)) < 1000, until);
  assert.deepEqual([task(early.state)?.approval?.since, early.effects], [since, [{ type: 'hold', ptyId, until }]]);
  const late = new Date(Date.now() - (APPROVAL_HOLD_MAX_MIN - 5) * MINUTE).toISOString();
  const capped = reduce(withApproval(parked, { since: late, until: new Date().toISOString() }), { type: 'extendApproval', activityId: workId(parked, ID) });
  assert.equal(task(capped.state)?.approval?.until, new Date(Date.parse(late) + APPROVAL_HOLD_MAX_MIN * MINUTE).toISOString(), 'the Stop hook\'s own timeout is the ceiling');
  const loose = awaiting();
  assert.equal(reduce(loose, { type: 'extendApproval', activityId: workId(loose, ID) }).state, loose);
});

test('approvalExpired releases the held Stop and ends the run once until has passed, the task keeping approval without until; a timer that went stale changes nothing (#268)', () => {
  const parked = held();
  const ptyId = parked.workers[0].runId!;
  assert.equal(reduce(parked, { type: 'approvalExpired', ptyId }).state, parked, 'extended meanwhile: until is still ahead');
  const since = task(parked)?.approval?.since ?? '';
  const { state, effects } = reduce(withApproval(parked, { since, until: past() }), { type: 'approvalExpired', ptyId });
  assert.deepEqual(effects, [{ type: 'release', ptyId }, { type: 'kill', slug: SLUG, ptyId }]);
  assert.deepEqual([state.workers[0].status, task(state)?.workerId, task(state)?.approval, task(state)?.stopped], ['empty', undefined, { since }, undefined]);
  assert.equal(reduce(state, { type: 'approvalExpired', ptyId }).state, state, 'answered already: the worker is free');
});

test('Stop (Parar) on a held worker releases the Stop and kills; the task keeps approval without until, is not stopped; an exit on its own drops until too (#268)', () => {
  const parked = held();
  const ptyId = parked.workers[0].runId!;
  const since = task(parked)?.approval?.since;
  const stopped = reduce(parked, { type: 'stop', ptyId });
  assert.deepEqual(stopped.effects, [{ type: 'release', ptyId }, { type: 'kill', slug: SLUG, ptyId }]);
  assert.deepEqual([task(stopped.state)?.approval, task(stopped.state)?.stopped], [{ since }, undefined], 'the stage reached hive_done: nothing to continue');
  const exited = reduce(parked, { type: 'exit', ptyId }).state; // the user closed the tab, or the session ended
  assert.deepEqual([exited.workers[0].status, task(exited)?.workerId, task(exited)?.approval, task(exited)?.stopped], ['empty', undefined, { since }, undefined]);
});

test('a boot after a crash neither stops nor lists a task whose Stop was held, and one after a Quit keeps it started; either way it awaits approval without until (#268)', () => {
  const parked = held();
  const since = task(parked)?.approval?.since;
  const crashed = reduce(parked, { type: 'boot' }).state;
  assert.deepEqual([crashed.workers[0].status, task(crashed)?.approval, task(crashed)?.stopped, crashed.crash], ['empty', { since }, undefined, undefined]);
  const quit = reduce(reduce(parked, { type: 'quit' }).state, { type: 'boot' }).state;
  assert.deepEqual([task(quit)?.approval, task(quit)?.stopped], [{ since }, undefined]);
});

test('a stage change drops approval and a queued handover: they belong to the stage the task was in (#268)', () => {
  const parked = awaiting();
  const moved = reduce(parked, { type: 'poll', source: 'board', items: [listed(1, 'In review')] }).state; // moved on the source by hand
  assert.deepEqual([task(moved)?.stage, 'approval' in task(moved)!], ['review', false]);
  const given = red(parked);
  const queued = reduce(given, { type: 'feedback', activityId: workId(given, ID), text: 'x', start: false }).state;
  const away = reduce(queued, { type: 'poll', source: 'board', items: [listed(1, 'In review')] }).state;
  assert.deepEqual([task(away)?.stage, 'handover' in task(away)!], ['review', false]);
});

test('hive_done in a free session in an approval stage parks the task awaiting approval, keeps the session open and moves nothing until Aprovar (#268)', () => {
  const first = running(UNCHAINED);
  const worker = first.workers[0].runId!;
  const seen = reduce(first, { type: 'hook', ptyId: worker, payload: { hook_event_name: 'SessionStart', cwd: '/tmp/worktrees/hive-1-task-1' } }).state;
  const idle = reduce(reduce(seen, { type: 'stop', ptyId: worker }).state, { type: 'exit', ptyId: worker }).state;
  const opened = reduce(idle, { type: 'openSession', activityId: workId(idle, ID) }).state;
  const session = opened.workers.find((s) => s.freeSession)!;
  const { state, effects } = reduce(opened, { type: 'done', ptyId: session.runId!, result: { spec: 'docs/x.md' } });
  assert.deepEqual(effects, [], 'no advance, no board write');
  assert.deepEqual([task(state)?.stage, typeof task(state)?.approval?.since, task(state)?.approval?.until, resultOf(state, ID)], ['spec', 'string', undefined, { spec: 'docs/x.md' }]);
  assert.equal(state.workers.find((s) => s.freeSession)?.status, 'working', 'the session stays open');
  const approved = reduce(state, { type: 'approve', activityId: workId(state, ID) });
  assert.deepEqual([task(approved.state)?.stage, approved.effects], ['dev', [{ type: 'setColumn', itemId: ID, column: 'Ready' }]], 'the session still holds the task: the fill leaves it');
});

// The user's own session opened on the task after its stage run stopped: the stage's latest session. Its hive_done parks the task (#283, #268)
function sessionAwaiting(): { state: State; ptyId: string } {
  const first = running(UNCHAINED);
  const worker = first.workers[0].runId!;
  const seen = reduce(first, { type: 'hook', ptyId: worker, payload: { hook_event_name: 'SessionStart', cwd: '/tmp/worktrees/hive-1-task-1' } }).state;
  const idle = reduce(reduce(seen, { type: 'stop', ptyId: worker }).state, { type: 'exit', ptyId: worker }).state;
  const opened = reduce(idle, { type: 'openSession', activityId: workId(idle, ID) }).state;
  const ptyId = opened.workers.find((s) => s.freeSession)!.runId!;
  return { state: reduce(opened, { type: 'done', ptyId }).state, ptyId };
}

test('feedback on a task awaiting approval whose stage session is open in the user\'s own session is typed into it, started or not: one input with the lead, approval dropped, nothing queued, no spawn (#483)', () => {
  const { state: parked, ptyId } = sessionAwaiting();
  for (const start of [true, false]) {
    const { state, effects } = reduce(parked, { type: 'feedback', activityId: workId(parked, ID), text: 'split the spec in two', start });
    assert.deepEqual(effects, [{ type: 'input', ptyId, text: `${LEAD}\n\nsplit the spec in two` }], `start: ${start}`);
    const typed = task(state)!;
    assert.deepEqual([typed.stage, 'approval' in typed, 'handover' in typed, state.workers.find((s) => s.freeSession)?.runId], ['spec', false, false, ptyId]);
  }
});

test('feedback on a task whose open session is another conversation than the one feedback resumes is queued, or started, as before (#483)', () => {
  const { state: parked } = sessionAwaiting();
  const other: State = { ...parked, workers: parked.workers.map((s) => (s.freeSession ? { ...s, sessionId: 'another-session' } : s)) };
  const queued = reduce(other, { type: 'feedback', activityId: workId(other, ID), text: 'rename the flag', start: false });
  assert.deepEqual([queued.effects, task(queued.state)?.handover?.prompt, 'approval' in task(queued.state)!], [[], led('rename the flag'), false]);
  const started = reduce(other, { type: 'feedback', activityId: workId(other, ID), text: 'rename the flag', start: true });
  const [spawn] = started.effects;
  assert.ok(spawn?.type === 'spawn' && spawn.run === 'continue' && spawn.prompt === led('rename the flag'), JSON.stringify(started.effects));
});

test('hive_done in a new free session in an approval stage names that session on the approval; once it is closed, feedback resumes it as the stage\'s feedback run, which gives it the stage and keeps it free (#812)', () => {
  const first = running(UNCHAINED);
  const worker = first.workers[0].runId!;
  const seen = reduce(first, { type: 'hook', ptyId: worker, payload: { hook_event_name: 'SessionStart', cwd: '/tmp/worktrees/hive-1-task-1' } }).state;
  const idle = reduce(reduce(seen, { type: 'stop', ptyId: worker }).state, { type: 'exit', ptyId: worker }).state;
  const opened = reduce(idle, { type: 'openSession', activityId: workId(idle, ID) }).state; // a new session: no stage run's
  const own = opened.workers.find((s) => s.freeSession)!;
  const parked = reduce(opened, { type: 'done', ptyId: own.runId! }).state;
  assert.equal(task(parked)?.approval?.sessionId, own.sessionId);
  const closed = reduce(parked, { type: 'exit', ptyId: own.runId! }).state;
  const { state, effects } = reduce(closed, { type: 'feedback', activityId: workId(closed, ID), text: 'split it', start: true });
  const spawn = effects.find((e) => e.type === 'spawn');
  assert.ok(spawn?.type === 'spawn' && spawn.run === 'continue' && spawn.activity.sessionId === own.sessionId && spawn.prompt === led('split it'), JSON.stringify(effects));
  const resumed = sessionsOf(state, ID).find((s) => s.id === own.sessionId);
  assert.deepEqual([resumed?.stages, resumed?.free], [['spec'], true]);
});

test('with a held worker and an open session on the same session, the held worker answers: continue, no input (#483)', () => {
  const parked = held();
  const ptyId = parked.workers[0].runId!;
  const sessionId = sessionsOf(parked, ID).at(-1)!.id;
  const both: State = { ...parked, workers: [...parked.workers, { id: 'own', runId: 'own-worker', activityId: activityOf(parked, ID)?.id, status: 'working', sessionId, freeSession: true }] };
  const { effects } = reduce(both, { type: 'feedback', activityId: workId(both, ID), text: 'split the spec in two', start: false });
  assert.deepEqual(effects.map((e) => (e.type === 'continue' ? [e.type, e.ptyId] : [e.type])), [['continue', ptyId]]);
});

test('an armed shutdown-when-done never closes a held worker: it waits for the window, and shuts down once the expired hold frees the worker (#268)', () => {
  const armed = reduce(held(), { type: 'setShutdown', armed: true }).state;
  const longAgo: State = { ...armed, shutdown: { armedAt: new Date(Date.now() - 24 * 60 * MINUTE).toISOString() } }; // any wait window long past
  const ptyId = longAgo.workers[0].runId!;
  const ticked = reduce(longAgo, { type: 'tick' });
  assert.deepEqual([ticked.effects, ticked.state.workers[0].status], [[], 'approval'], 'a hold is not a wait the shutdown closes');
  const since = task(longAgo)?.approval?.since ?? '';
  const expired = reduce(withApproval(longAgo, { since, until: past() }), { type: 'approvalExpired', ptyId });
  assert.deepEqual(types(expired.effects), ['release', 'kill', 'shutdown']);
});

