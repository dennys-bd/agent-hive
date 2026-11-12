import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecomposition } from '../src/decomposition.js';
import { entryStage, hiveEntries, type HiveWriteDeps, type HiveWriteTarget, NOT_CREATED_MESSAGE, originTaken, suggestedEntry, writeHiveDecomposition } from '../src/decomposition-write-hive.js';
import { flatten } from '../src/flows.js';
import { initialState, reduce } from '../src/orchestrator.js';
import { END, HIVE_EPIC, type Decomposition, type HiveEvent, type State, type Task } from '../src/types.js';
import { HIVE_TREE, hiveFlows } from './fixtures/decomposition.js';

// The hive target of a decomposition (#783): what `entra em` offers and suggests, the stage an entry names, the origin a root task would
// take, and the write of the tree as hive tasks over the real reducer.

const graph = (to?: string): Pick<State, 'flows' | 'stages' | 'transitions'> => {
  const flows = hiveFlows(to);
  return { flows, ...flatten(flows) };
};

test('hiveEntries: outside the flow, then each flow followed by each of its stages, in order (#783)', () => {
  assert.deepEqual(hiveEntries(hiveFlows()), [null, { flow: 'main' }, { flow: 'main', stage: 'goal' }, { flow: 'main', stage: 'spec' }, { flow: 'other' }, { flow: 'other', stage: 'build' }]);
});

test('entryStage: a flow\'s first stage, the stage named, none outside the flow (#783)', () => {
  const flows = hiveFlows();
  assert.deepEqual([entryStage(flows, { flow: 'other' }), entryStage(flows, { flow: 'main', stage: 'spec' }), entryStage(flows, null)], ['build', 'spec', undefined]);
});

test('suggestedEntry: the flow the approved exit leads to; the goal\'s own flow for END or no exit; the first flow outside the flow (#783)', () => {
  assert.deepEqual(suggestedEntry(graph('build'), { stage: 'goal' }), { flow: 'other' });
  assert.deepEqual(suggestedEntry(graph(END), { stage: 'goal' }), { flow: 'main' });
  assert.deepEqual(suggestedEntry(graph(), { stage: 'build' }), { flow: 'other' }, 'build has no approved exit');
  assert.deepEqual(suggestedEntry(graph('build'), {}), { flow: 'main' });
});

test('originTaken: a GitHub goal whose item a task holds as origin, until root is recorded; never a hive goal (#783)', () => {
  const goal: Task = { item: { itemId: 'board:I7', id: '7', title: 'G', body: '', url: '', source: 'board' }, boardColumn: '', auto: true };
  const copy: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'G', body: '', url: '', origin: 'board:I7' }, boardColumn: '', auto: true, created: true };
  assert.equal(originTaken({ tasks: [goal, copy] }, goal, {}), true);
  assert.equal(originTaken({ tasks: [goal, copy] }, goal, { root: 1 }), false, 'recorded: the write resumes');
  assert.equal(originTaken({ tasks: [goal] }, goal, {}), false);
  assert.equal(originTaken({ tasks: [goal, copy] }, copy, {}), false, 'a hive goal gets no root task');
});

function tree(): Decomposition {
  const { decomposition, problems } = parseDecomposition(HIVE_TREE);
  assert.deepEqual(problems, []);
  assert.ok(decomposition);
  return decomposition;
}
const GOAL: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Site for XPTO', body: '', url: '' }, stage: 'goal', boardColumn: '', auto: true, created: true, workspace: 'hive' };
const AT: HiveWriteTarget = { goal: GOAL, prefix: 'HIVE', stage: 'spec', workspace: 'hive' };
const taskIn = (state: State, itemId: string): Task | undefined => state.tasks.find((c) => c.item.itemId === itemId);

// The write's deps over the real reducer, with no worker: what latest() reads is what each dispatch reduced
function hive(tasks: Task[] = [GOAL]) {
  const flows = hiveFlows();
  let state: State = { ...initialState(0), workspaces: ['hive'], flows, ...flatten(flows), tasks, localCount: tasks.filter((c) => c.created === true).length };
  const events: HiveEvent[] = [];
  const records: [string, number][] = [];
  const deps: HiveWriteDeps = {
    dispatch: async (event) => { events.push(event); state = reduce(state, event).state; },
    latest: () => state,
    record: async (id, n) => { records.push([id, n]); },
  };
  return { deps, events, records, state: () => state, set: (next: State) => { state = next; } };
}

test('on a hive goal every node is a task under its parent in file order, recorded as made; the inner node born an epic, the blocker on both ends; the goal left to the route (#783)', async () => {
  const { deps, events, records, state } = hive();
  assert.deepEqual(await writeHiveDecomposition(deps, tree(), AT, {}), { root: 'local:1' });
  assert.deepEqual(records, [['1', 2], ['1.1', 3], ['1.2', 4], ['2', 5]]);
  assert.equal(events.some((e) => e.type === 'markEpic'), false, 'born epics: no stamp');
  const s = state();
  assert.deepEqual(['local:2', 'local:3', 'local:4', 'local:5'].map((id) => [taskIn(s, id)?.item.parent, taskIn(s, id)?.item.epic, taskIn(s, id)?.stage, taskIn(s, id)?.auto]), [
    ['local:1', HIVE_EPIC, 'spec', true], ['local:2', undefined, 'spec', true], ['local:2', undefined, 'spec', true], ['local:1', undefined, 'spec', true],
  ]);
  assert.deepEqual([taskIn(s, 'local:1')?.item.children, taskIn(s, 'local:1')?.item.epic], [['local:2', 'local:5'], undefined]);
  assert.deepEqual([taskIn(s, 'local:4')?.item.blockers?.blockedBy.map((r) => r.id), taskIn(s, 'local:3')?.item.blockers?.blocking.map((r) => r.id)], [['HIVE-3'], ['HIVE-4']]);
  assert.match(taskIn(s, 'local:3')?.item.body ?? '', /^Parent: HIVE-2$/m);
  assert.doesNotMatch(taskIn(s, 'local:3')?.item.body ?? '', /^Design:/m, 'no address: no link');
});

test('a GitHub goal\'s root task is created first from the target\'s root, born an epic and recorded under root; with an address each body links its design (#783)', async () => {
  const goal: Task = { item: { itemId: 'board:I7', id: '7', title: 'Site for XPTO', body: '', url: 'https://github.com/acme/site/issues/7', source: 'board' }, stage: 'goal', boardColumn: 'Goals', auto: true };
  const { deps, records, state } = hive([goal]);
  const root = { title: 'Site for XPTO', body: 'A marketing site.', url: goal.item.url, origin: goal.item.itemId };
  const address = 'https://github.com/acme/docs/blob/trunk/decomposition.md';
  assert.deepEqual(await writeHiveDecomposition(deps, tree(), { ...AT, goal, root, address }, {}), { root: 'local:1' });
  assert.deepEqual(records[0], ['root', 1]);
  const s = state();
  assert.deepEqual([taskIn(s, 'local:1')?.item.origin, taskIn(s, 'local:1')?.item.url, taskIn(s, 'local:1')?.item.epic, taskIn(s, 'local:2')?.item.parent], ['board:I7', goal.item.url, HIVE_EPIC, 'local:1']);
  assert.match(taskIn(s, 'local:2')?.item.body ?? '', /^Parent: HIVE-1\nDesign: https:\/\/github\.com\/acme\/docs\/blob\/trunk\/decomposition\.md#design$/m);
});

test('a replay with every node recorded creates nothing, and its blocker lands once (#783)', async () => {
  const { deps, events, records, state } = hive();
  await writeHiveDecomposition(deps, tree(), AT, {});
  const first = events.length;
  assert.deepEqual(await writeHiveDecomposition(deps, tree(), AT, Object.fromEntries(records)), { root: 'local:1' });
  assert.deepEqual(events.slice(first).map((e) => e.type), ['blockerSet']);
  assert.deepEqual(taskIn(state(), 'local:4')?.item.blockers?.blockedBy.map((r) => r.id), ['HIVE-3']);
});

test('a createTask the reducer did not take stops the write with fixed words: nothing is recorded for it and nothing after it runs (#783)', async () => {
  const { deps, events, records, set, state } = hive();
  set({ ...state(), stages: state().stages.filter((s) => s.name !== 'spec') });
  assert.deepEqual(await writeHiveDecomposition(deps, tree(), AT, {}), { error: NOT_CREATED_MESSAGE });
  assert.deepEqual([records, events.map((e) => e.type)], [[], ['createTask']]);
});

