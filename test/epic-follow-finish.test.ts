import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../src/activities.js';
import { followEpics } from '../src/epic-follow.js';
import { initialState, reduce } from '../src/orchestrator.js';
import type { Item, Stage, State, Task, Transition } from '../src/types.js';
import { move } from './fakes.js';
import { withWork } from './fixtures/work.js';
import { flowed, mainFlows } from './fixtures/main-flow.js';

// #843: a show epic finishes by itself: it never waits on a gate's approval, and moving into its flow's last stage closes its issue.

// In Review is a manual gate: a normal card waits there for a click, an epic follows its children through it
const FLOW: Stage[] = [
  { name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' },
  { name: 'review', from: { board: ['In review'] }, approval: true },
  { name: 'done', from: { board: ['Done'] } },
];
const COLUMN: Record<string, string> = { dev: 'Ready', review: 'In review', done: 'Done' };
const TO_DONE: Transition = { from: 'review', to: 'done', when: 'done', sources: { board: [move('Done')] } };
const node = (id: string, extra: Partial<Item> = {}): Item => ({ itemId: `board:${id}`, id, title: id, body: '', url: '', source: 'board', ...extra });
const child = (id: string, stage: string, parent = 'board:E'): Task => ({ item: node(id, { parent }), stage, boardColumn: COLUMN[stage], auto: true });
const epic = (stage: string, children: string[], extra: Partial<Item> = {}): Task => ({
  item: node('E', { children: children.map((id) => `board:${id}`), epic: { follows: 'behind', switchAt: 'dev' }, ...extra }), stage, boardColumn: COLUMN[stage], auto: true,
});
const at = (tasks: Task[], transitions: Transition[] = [TO_DONE]): State =>
  ({ ...initialState(0), workspaces: ['hive'], syncs: { board: {} }, ...flowed(FLOW, transitions), tasks });
const epicIn = (s: State): Task | undefined => s.tasks.find((t) => t.item.itemId === 'board:E');
const withTasks = (s: State, tasks: Task[]): State => ({ ...s, tasks });
const CLOSE = { type: 'sourceAction', itemId: 'board:E', taskId: 'board:E', action: { type: 'close' } };
const closes = (effects: readonly unknown[]) => effects.filter((e) => (e as { action?: { type: string } }).action?.type === 'close');

test('an epic placed in a gate has no approval on its activity (#843)', () => {
  const { state } = followEpics(withWork(at([epic('dev', ['c1']), child('c1', 'review')]), 'board:E'));
  assert.equal(epicIn(state)?.stage, 'review');
  assert.equal(activityOf(state, 'board:E')?.approval, undefined);
});

test('an epic follows its children through In Review into Done by itself, with no approval (#843)', () => {
  const inReview = followEpics(at([epic('dev', ['c1']), child('c1', 'review')])).state;
  const { state } = followEpics(withTasks(inReview, [epicIn(inReview) as Task, child('c1', 'done')]));
  assert.equal(epicIn(state)?.stage, 'done');
});

test('a task with no epic stamp entering In Review still awaits approval (#843)', () => {
  const { state } = reduce(at([child('c1', 'dev', '')]), { type: 'moveToStage', taskId: 'board:c1', stage: 'review' });
  assert.notEqual(activityOf(state, 'board:c1')?.approval, undefined);
});

test('a save that turns the stage an epic sits in into a gate gives it no approval; a plain task there awaits one (#843)', () => {
  const open = FLOW.map(({ approval: _approval, ...s }) => s); // no gate yet
  const before = withWork(withWork({ ...at([epic('review', ['c1']), child('c1', 'review'), child('p', 'review', '')]), ...flowed(open, [TO_DONE]) }, 'board:E'), 'board:p');
  const { state } = reduce(before, { type: 'setStages', flows: mainFlows(FLOW, [TO_DONE]) });
  assert.equal(activityOf(state, 'board:E')?.approval, undefined);
  assert.notEqual(activityOf(state, 'board:p')?.approval, undefined);
});

test('an epic whose children are all done closes its issue as it moves In Review → Done, after the move\'s own write (#843)', () => {
  const { effects } = followEpics(at([epic('review', ['c1']), child('c1', 'done')]));
  assert.deepEqual(effects, [{ type: 'setColumn', itemId: 'board:E', column: 'Done' }, CLOSE]);
});

test('a transition into the last stage that already closes the issue writes one close only (#843)', () => {
  const closing: Transition = { ...TO_DONE, sources: { board: [move('Done'), { type: 'close' }] } };
  const { effects } = followEpics(at([epic('review', ['c1']), child('c1', 'done')], [closing]));
  assert.equal(closes(effects).length, 1);
});

test('a local epic and one already in the last stage write no close (#843)', () => {
  const local = followEpics(at([{ ...epic('review', ['c1']), created: true }, child('c1', 'done')]));
  assert.equal(epicIn(local.state)?.stage, 'done');
  assert.deepEqual(closes(local.effects), []);
  const there = followEpics(at([epic('done', ['c1']), child('c1', 'done')]));
  assert.deepEqual(closes(there.effects), []);
});

test('a parent epic in Done whose child epic left the Hive, listed in its closedChildren, stays in Done (#843)', () => {
  const parent: Task = { item: node('R', { children: ['board:E'], closedChildren: ['board:E'], epic: { follows: 'behind', switchAt: 'dev' } }), stage: 'done', boardColumn: 'Done', auto: true };
  const before = at([parent]);
  const { state, effects } = followEpics(before);
  assert.equal(state.tasks.find((t) => t.item.itemId === 'board:R')?.stage, 'done');
  assert.deepEqual(effects, []);
});
