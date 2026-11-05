import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryFor, placed, placesAgain } from '../src/task-entry.js';
import { initialState } from '../src/orchestrator.js';
import type { Flow, Item, SourceItem, Stage, Task, TaskEntry } from '../src/types.js';
import { withWork } from './fixtures/work.js';

const st = (name: string, from: Record<string, string[]> = {}): Stage => ({ name, from, prompt: '/x' });
// Router and Spec (delivery) and Research (discovery) all accept Backlog; Build accepts Ready only; Proposal accepts nothing
const FLOWS: Flow[] = [
  { name: 'delivery', stages: [st('Router', { board: ['Backlog'] }), st('Spec', { board: ['Backlog'] }), st('Build', { board: ['Ready'] })], transitions: [] },
  { name: 'discovery', stages: [st('Research', { board: ['Backlog'] }), st('Proposal')], transitions: [] },
];
const item = (entry?: TaskEntry): Item => ({ itemId: 'board:I1', id: '1', title: 'T', body: '', url: 'https://github.com/o/r/issues/1', source: 'board', ...(entry === undefined ? {} : { entry }) });
const seen = (entry: TaskEntry | undefined, column = 'Backlog'): SourceItem => ({ item: item(entry), column });
const nameOf = (s: Stage | null | undefined): string | null | undefined => (s === null || s === undefined ? s : s.name);
const TASK: Task = { item: item({ flow: 'delivery' }), stage: 'Router', boardColumn: 'Backlog', auto: true };

test('entryFor: a column that is no door answers undefined, null outside the flow, a flow its first stage, a stage that accepts the column itself (#670)', () => {
  assert.equal(entryFor(FLOWS, seen({ flow: 'delivery' }, 'Done')), undefined, 'no stage cites Done: no task');
  assert.equal(entryFor(FLOWS, seen(null, 'Done')), undefined, 'outside the flow still needs a door column');
  assert.equal(entryFor(FLOWS, seen(null)), null);
  assert.equal(nameOf(entryFor(FLOWS, seen({ flow: 'discovery' }))), 'Research');
  assert.equal(nameOf(entryFor(FLOWS, seen({ flow: 'delivery', stage: 'Spec' }))), 'Spec');
});

test('entryFor falls back to the column\'s door: a stage or a flow\'s first stage that does not accept the column, and a local item (#670)', () => {
  assert.equal(nameOf(entryFor(FLOWS, seen({ flow: 'delivery', stage: 'Build' }))), 'Router', 'Build does not accept Backlog');
  assert.equal(nameOf(entryFor(FLOWS, seen({ flow: 'delivery' }, 'Ready'))), 'Build', 'Router does not accept Ready: Ready\'s door');
  assert.equal(nameOf(entryFor(FLOWS, seen({ flow: 'discovery', stage: 'Proposal' }))), 'Router');
  assert.equal(nameOf(entryFor(FLOWS, seen(undefined))), 'Router', 'no entry: the door, as before #670');
});

test('placesAgain holds only for a new task: not started, not placed by hand, not created in the Hive, not orphan, leaving or an epic (#670)', () => {
  const empty = initialState(0);
  assert.equal(placesAgain(TASK, empty), true);
  assert.equal(placesAgain(TASK, withWork(empty, 'board:I1')), false, 'started: it has an activity');
  for (const extra of [{ placedByHand: true }, { created: true }, { orphan: true }, { leaving: true }] as const) {
    assert.equal(placesAgain({ ...TASK, ...extra }, empty), false, Object.keys(extra)[0]);
  }
  assert.equal(placesAgain({ ...TASK, item: { ...TASK.item, epic: { follows: 'behind', switchAt: 'Build' } } }, empty), false, 'an epic follows its children');
});

test('placed: another stage enters it, null takes it out of the flow, undefined and the same stage leave it as it is (#670)', () => {
  const [router, spec] = FLOWS[0].stages;
  assert.equal(placed(TASK, undefined), TASK);
  assert.equal(placed(TASK, router), TASK, 'same stage: the clock keeps running');
  assert.deepEqual([placed(TASK, spec).stage, typeof placed(TASK, spec).enteredAt], ['Spec', 'string']);
  assert.equal(placed(TASK, null).stage, undefined);
  const { stage: _stage, ...outside } = TASK;
  assert.equal(placed(outside, null), outside);
  assert.equal(placed(outside, spec).stage, 'Spec', 'a new task outside the flow enters when its entry names a flow again');
});

