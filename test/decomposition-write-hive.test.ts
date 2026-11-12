import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryStage, hiveEntries, originTaken, suggestedEntry } from '../src/decomposition-write-hive.js';
import { flatten } from '../src/flows.js';
import { END, type State, type Task } from '../src/types.js';
import { hiveFlows } from './fixtures/decomposition.js';

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
