import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../src/activities.js';
import { followEpics } from '../src/epic-follow.js';
import { flatten } from '../src/flows.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { leave } from '../src/tasks.js';
import { transitionKey } from '../src/transitions.js';
import { END, type EpicFollows, type Flow, type Item, type Stage, type State, type Task, type Transition } from '../src/types.js';
import { HOUR_MS } from '../src/usage.js';
import { move } from './fakes.js';
import { activityIdOf, withWork } from './fixtures/work.js';
import { flowed } from './fixtures/main-flow.js';

// The show epic's rule (#31): a pass over the state after the step, pure, its moves written to the source like a move by hand.

// Every fixture is frozen deep: a rule that wrote to its input would throw here (ESM is strict mode)
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
const STAGES: Stage[] = [
  { name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive-spec {url}' },
  { name: 'build', from: { board: ['Ready'] }, prompt: '/hive-build {url}' },
  { name: 'done', from: { board: ['Done'] } },
];
const COLUMN: Record<string, string> = { spec: 'Backlog', build: 'Ready', dev: 'In progress', review: 'In review', done: 'Done' };
// The last stage's done exit out of the Hive, writing Shipped as the task passes
const ENDS: Transition = { from: 'done', to: END, when: 'done', sources: { board: [move('Shipped')] } };
const node = (id: string, extra: Partial<Item> = {}): Item => ({ itemId: `board:${id}`, id, title: id, body: '', url: '', source: 'board', ...extra });
const child = (id: string, stage: string): Task => ({ item: node(id, { parent: 'board:E' }), stage, boardColumn: COLUMN[stage], auto: true });
const epic = (stage: string, children: string[], follows: EpicFollows = 'behind', extra: Partial<Item> = {}): Task => ({
  item: node('E', { children: children.map((id) => `board:${id}`), epic: { follows, switchAt: 'build' }, ...extra }), stage, boardColumn: COLUMN[stage], auto: true,
});
const at = (tasks: Task[], transitions: Transition[] = [], stages: Stage[] = STAGES): State =>
  deepFreeze({ ...initialState(0), workspaces: ['hive'], syncs: { board: {} }, ...flowed(stages, transitions), tasks });
const epicIn = (s: State): Task | undefined => s.tasks.find((t) => t.item.itemId === 'board:E');
// #213: the issue's flow. dev writes In progress as a run starts there; review → done writes Done; done waits 12h and deletes the activity,
// then done → end archives. spec → dev writes a column of its own, so a test tells it from dev's first door
const FLOW: Stage[] = [
  { name: 'spec', from: { board: ['Backlog'] }, prompt: '/hive-spec {url}' },
  { name: 'dev', from: { board: ['Ready'] }, onStart: { board: [move('In progress')] }, prompt: '/hive-build {url}' },
  { name: 'review', from: { board: ['In review'] }, prompt: '/hive-review {url}' },
  { name: 'done', from: { board: ['Done'] }, action: 'deleteActivity', after: '12h' },
];
const TO_DEV: Transition = { from: 'spec', to: 'dev', when: 'done', maxTries: 2, sources: { board: [move('Specced')] } };
const TO_REVIEW: Transition = { from: 'dev', to: 'review', when: 'done', sources: { board: [move('In review')] } };
const BACK: Transition = { from: 'review', to: 'dev', when: 'feedback', sources: { board: [move('Changes requested')] } };
const TO_DONE: Transition = { from: 'review', to: 'done', when: 'done', sources: { board: [move('Done')] } };
const ARCHIVE: Transition = { from: 'done', to: END, when: 'done', sources: { board: [{ type: 'archive' }] } };
const ISSUE: Transition[] = [TO_DEV, TO_REVIEW, BACK, TO_DONE, ARCHIVE];
const ARCHIVED = { type: 'sourceAction', itemId: 'board:E', taskId: 'board:E', action: { type: 'archive' } };
// #843: an epic moving into its last stage closes its issue, after the move's writes
const CLOSED = { type: 'sourceAction', itemId: 'board:E', taskId: 'board:E', action: { type: 'close' } };
// The task as if it entered its stage `ms` ago: what isDue counts `after` from
const aged = (t: Task, ms: number): Task => ({ ...t, enteredAt: new Date(Date.now() - ms).toISOString() });
const column = (name: string) => ({ type: 'setColumn', itemId: 'board:E', column: name });

test('a child\'s move moves its epic where its rule puts it, with one setColumn to the target\'s first door; the input state is untouched (#31)', () => {
  const before = at([epic('spec', ['c1', 'c2']), child('c1', 'build'), child('c2', 'build')]);
  const { state, effects } = followEpics(before);
  assert.equal(epicIn(state)?.stage, 'build');
  assert.equal(epicIn(state)?.boardColumn, 'Ready', 'the column follows the write');
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:E', column: 'Ready' }]);
  assert.equal(epicIn(before)?.stage, 'spec', 'frozen, and unchanged');
});

test('no move and no effect when the epic already sits where its children put it, or when no child is a task (#31)', () => {
  const placed = at([epic('build', ['c1']), child('c1', 'build')]);
  const same = followEpics(placed);
  assert.equal(same.state, placed);
  assert.deepEqual(same.effects, []);
  const alone = at([epic('spec', ['gone'])]);
  assert.equal(followEpics(alone).state, alone, 'the child is not polled yet, filtered out or closed: the epic stays put');
});

test('every child done, with the last stage\'s done exit to end: the epic moves into the last stage, then, with no after, leaves the Hive through it in the same pass (#31, #213)', () => {
  const before = at([epic('build', ['c1', 'c2'], 'behind', { closedChildren: ['board:c2'] }), child('c1', 'done')], [ENDS]);
  const { state, effects } = followEpics(before);
  assert.equal(epicIn(state), undefined);
  assert.deepEqual(state.tasks.map((t) => t.item.itemId), ['board:c1']);
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:E', column: 'Done' }, CLOSED, { type: 'setColumn', itemId: 'board:E', column: 'Shipped' }]);
});

test('every child done and no done exit to end: the epic moves to the last stage and stays there (#31)', () => {
  const { state, effects } = followEpics(at([epic('build', ['c1']), child('c1', 'done')]));
  assert.equal(epicIn(state)?.stage, 'done');
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:E', column: 'Done' }, CLOSED]);
  const again = deepFreeze(state);
  assert.equal(followEpics(again).state, again, 'the next pass leaves it there');
});

test('a sub-epic moves before its parent epic in the same pass, so the parent reads it already moved (#31)', () => {
  const root: Task = { item: node('R', { children: ['board:E'], epic: { follows: 'behind', switchAt: 'build' } }), stage: 'spec', boardColumn: 'Backlog', auto: true };
  const { state } = followEpics(at([root, epic('spec', ['c1'], 'behind', { parent: 'board:R' }), child('c1', 'build')]));
  assert.deepEqual(state.tasks.map((t) => [t.item.itemId, t.stage]), [['board:R', 'build'], ['board:E', 'build'], ['board:c1', 'build']]);
});

test('a task without the epic stamp is never touched; an epic whose source action failed keeps its error and writes nothing again (#31)', () => {
  const parent: Task = { item: node('P', { children: ['board:c1'] }), stage: 'spec', boardColumn: 'Backlog', auto: true };
  const plain = at([parent, child('c1', 'build')]);
  assert.equal(followEpics(plain).state, plain);
  const failed = deepFreeze(withWork(at([epic('build', ['c1']), child('c1', 'done')], [ENDS]), 'board:E', { error: 'archive refused' }));
  const kept = followEpics(failed);
  assert.equal(kept.state, failed);
  assert.deepEqual(kept.effects, []);
});

test('a following move takes the transition configured straight to the target, its sources written, then the target\'s onStart, in that order (#213)', () => {
  const { state, effects } = followEpics(at([epic('spec', ['c1']), child('c1', 'dev')], ISSUE, FLOW));
  assert.deepEqual(effects, [column('Specced'), column('In progress')]);
  assert.deepEqual([epicIn(state)?.stage, epicIn(state)?.boardColumn], ['dev', 'In progress']);
});

test('with no transition straight to the target the move is plain: its first door, then its onStart; the stages in between write nothing (#213)', () => {
  const plain = followEpics(at([epic('spec', ['c1']), child('c1', 'dev')], [], FLOW));
  assert.deepEqual(plain.effects, [column('Ready'), column('In progress')], 'dev\'s first door, as a move by hand');
  const jump = followEpics(at([epic('spec', ['c1']), child('c1', 'review')], ISSUE, FLOW));
  assert.deepEqual(jump.effects, [column('In review')], 'spec → review: neither spec → dev, dev → review nor dev\'s onStart is written');
  assert.equal(epicIn(jump.state)?.stage, 'review');
});

test('a backward move takes the transition straight back when one exists (#213)', () => {
  const { state, effects } = followEpics(at([epic('review', ['c1']), child('c1', 'dev')], ISSUE, FLOW));
  assert.deepEqual(effects, [column('Changes requested'), column('In progress')]);
  assert.equal(epicIn(state)?.stage, 'dev');
});

test('the epic counts no try, keeps no try record and gets no handover: only the arrow it came through (#213)', () => {
  const tried = deepFreeze(withWork(at([epic('spec', ['c1']), child('c1', 'dev')], ISSUE, FLOW), 'board:E'));
  const forward = activityOf(followEpics(tried).state, 'board:E');
  assert.deepEqual([forward?.via, forward?.tries, forward?.tryLog], [transitionKey(TO_DEV), undefined, undefined], 'spec → dev has maxTries');
  const fed = deepFreeze(withWork(at([epic('review', ['c1']), child('c1', 'dev')], ISSUE, FLOW), 'board:E'));
  const back = activityOf(followEpics(fed).state, 'board:E');
  assert.deepEqual([back?.via, back?.handover], [transitionKey(BACK), undefined], 'a feedback into a stage with a prompt hands nothing over');
});

test('every child done with the epic in review: one pass takes review → done, writing Done, and does not archive it before done\'s after (#213)', () => {
  const { state, effects } = followEpics(at([epic('review', ['c1']), child('c1', 'done')], ISSUE, FLOW));
  assert.deepEqual(effects, [column('Done'), CLOSED]);
  assert.deepEqual([epicIn(state)?.stage, epicIn(state)?.boardColumn, epicIn(state)?.leaving], ['done', 'Done', undefined]);
});

test('in done the epic waits out done\'s after: before it the same state, after it done → end is taken, archive written, the epic held leaving (#213)', () => {
  const waiting = at([aged(epic('done', ['c1']), HOUR_MS), child('c1', 'done')], ISSUE, FLOW);
  const early = followEpics(waiting);
  assert.equal(early.state, waiting);
  assert.deepEqual(early.effects, []);
  const { state, effects } = followEpics(at([aged(epic('done', ['c1']), 13 * HOUR_MS), child('c1', 'done')], ISSUE, FLOW));
  assert.deepEqual(effects, [ARCHIVED]);
  assert.deepEqual([epicIn(state)?.stage, epicIn(state)?.leaving], ['done', true], 'held until the source answers');
});

test('a last stage with no after: the epic moves into it and leaves through done → end in the same pass (#213)', () => {
  const { after: _after, ...atOnce } = FLOW[3];
  const { state, effects } = followEpics(at([epic('review', ['c1']), child('c1', 'done')], ISSUE, [...FLOW.slice(0, 3), atOnce]));
  assert.deepEqual(effects, [column('Done'), CLOSED, ARCHIVED]);
  assert.deepEqual([epicIn(state)?.stage, epicIn(state)?.leaving], ['done', true]);
});

// #353 (#100's log): the delete-activity stage marked the epic's activity deleting before its item carried `epic`; the next poll's pass
// archived it mid-delete, closeTask was refused by the mark, and the delete's advance found it leaving: it stayed leaving for good
const WORKTREE = '/repo/.hive/worktrees/hive-e';

test('an epic whose activity is being deleted is neither moved nor archived; activityDeleted then takes done → end, and closeTask removes it (#353)', () => {
  const deleting = deepFreeze(withWork(at([aged(epic('done', ['c1']), 13 * HOUR_MS), child('c1', 'done')], ISSUE, FLOW), 'board:E', { worktree: WORKTREE, deleting: true }));
  const held = followEpics(deleting);
  assert.equal(held.state, deleting);
  assert.deepEqual(held.effects, []);
  const deleted = reduce(deleting, { type: 'activityDeleted', activityId: activityIdOf('board:E') });
  assert.deepEqual(deleted.effects.filter((e) => e.type === 'sourceAction' && e.itemId === 'board:E'), [ARCHIVED]);
  assert.equal(epicIn(deleted.state)?.leaving, true, 'held until the source answers');
  const closed = reduce(deleted.state, { type: 'closeTask', taskId: 'board:E' });
  assert.equal(epicIn(closed.state), undefined, 'the archive\'s ok closes it: no task stays leaving');
});

test('an epic whose activity is being deleted stays where it is even when its children moved (#353)', () => {
  const deleting = deepFreeze(withWork(at([epic('spec', ['c1']), child('c1', 'build')]), 'board:E', { worktree: WORKTREE, deleting: true }));
  const { state, effects } = followEpics(deleting);
  assert.equal(state, deleting);
  assert.deepEqual(effects, []);
});

const outside = (id: string): Task => leave(child(id, 'spec'));

test('children outside the flow say nothing of their epic\'s stage: all of them outside leaves it where it is; the in-flow ones alone decide, done included (#566)', () => {
  const alone = at([epic('spec', ['c1', 'c2']), outside('c1'), outside('c2')]);
  assert.equal(followEpics(alone).state, alone, 'every child outside: the epic stays');
  const mixed = at([epic('spec', ['c1', 'c2']), child('c1', 'build'), outside('c2')]);
  assert.equal(epicIn(followEpics(mixed).state)?.stage, 'build', 'the one child in the flow decides');
  const done = followEpics(at([epic('done', ['c1', 'c2']), child('c1', 'done'), outside('c2')], [ENDS]));
  assert.equal(epicIn(done.state), undefined, 'every child in the flow is done: out through done\'s end');
  assert.deepEqual(done.effects, [column('Shipped')]);
});

test('an epic outside the flow stays outside: a poll that stamps epic on a stageless task never moves it into a stage (#566)', () => {
  const before = at([leave(epic('spec', ['c1'])), child('c1', 'build')]);
  const { state, effects } = followEpics(before);
  assert.equal(state, before);
  assert.deepEqual(effects, []);
});

// #623, #639 (#723): delivery (spec, build, done) then discovery (brainstorm, decompose). The flattened comb's last stage is decompose, whose
// first door is Backlog: the column a finished epic was moved to when its last child left
const DISCOVERY: Stage[] = [
  { name: 'brainstorm', from: { board: ['Ideas'] }, prompt: '/hive-brainstorm {url}' },
  { name: 'decompose', from: { board: ['Backlog'] } },
];
const twoFlows = (tasks: Task[], delivery: Transition[] = []): State => {
  const flows: Flow[] = [{ name: 'delivery', stages: STAGES, transitions: delivery }, { name: 'discovery', stages: DISCOVERY, transitions: [] }];
  return deepFreeze({ ...initialState(0), workspaces: ['hive'], syncs: { board: {} }, flows, ...flatten(flows), tasks });
};
const inDiscovery = (id: string): Task => ({ ...child(id, 'spec'), stage: 'brainstorm', boardColumn: 'Ideas' });
const ALL_CLOSED: Partial<Item> = { closedChildren: ['board:c1', 'board:c2'] };

test('an epic in Done whose last child left stays in Done, or leaves through Done\'s own end; never into another flow\'s last stage, no setColumn (#723)', () => {
  const gone = twoFlows([epic('done', ['c1', 'c2'], 'behind', ALL_CLOSED)]);
  const kept = followEpics(gone);
  assert.equal(kept.state, gone, 'no done exit: it sits in Done');
  assert.deepEqual(kept.effects, []);
  const ends = followEpics(twoFlows([epic('done', ['c1', 'c2'], 'behind', ALL_CLOSED)], [ENDS]));
  assert.equal(epicIn(ends.state), undefined, 'out through done → end');
  assert.deepEqual(ends.effects, [column('Shipped')]);
});

test('the archive\'s closeTask of an epic\'s last child moves no task out of its own flow (#623, #639, #723)', () => {
  const archiving: Task = { ...child('c1', 'done'), leaving: true }; // its archive in flight: closeTask is the source's answer
  const before = twoFlows([epic('done', ['c1', 'c2'], 'behind', ALL_CLOSED), archiving]);
  const { state, effects } = reduce(before, { type: 'closeTask', taskId: 'board:c1' });
  assert.deepEqual(state.tasks.map((t) => [t.item.itemId, t.stage]), [['board:E', 'done']]);
  assert.deepEqual(effects.filter((e) => e.type === 'setColumn'), []);
});

test('a child in another flow neither places its epic nor keeps it from finishing (#723 decision 3)', () => {
  const ahead = followEpics(twoFlows([epic('spec', ['c1', 'c2'], 'ahead'), child('c1', 'build'), inDiscovery('c2')]));
  assert.equal(epicIn(ahead.state)?.stage, 'build', 'brainstorm is no stage of delivery: c2 places nothing');
  const done = followEpics(twoFlows([epic('build', ['c1', 'c2']), child('c1', 'done'), inDiscovery('c2')], [ENDS]));
  assert.equal(epicIn(done.state), undefined, 'c1, its one child in delivery, is done: into done and out through its end');
  assert.deepEqual(done.effects, [column('Done'), CLOSED, column('Shipped')]);
  const elsewhere = twoFlows([epic('spec', ['c2']), inDiscovery('c2')]);
  assert.equal(followEpics(elsewhere).state, elsewhere, 'every child in the other flow: the epic stays');
});
