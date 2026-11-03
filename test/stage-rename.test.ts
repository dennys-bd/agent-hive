import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/orchestrator.js';
import { renameStages } from '../src/stage-rename.js';
import { flowed } from './fixtures/main-flow.js';
import { transitionKey } from '../src/transitions.js';
import { RENAMES, STAGE_KEYED_FIELDS, stageKeyedState } from './fixtures/stage-keyed.js';

test('the audited fixture fills every stage-keyed field of State with a stage name or a transitionKey (#861)', () => {
  const state = stageKeyedState();
  for (const { field, read, before } of STAGE_KEYED_FIELDS) assert.deepEqual(read(state), before, field);
});

test('renameStages rewrites each audited field (#861)', () => {
  const renamed = renameStages(stageKeyedState(), RENAMES);
  for (const { field, read, after } of STAGE_KEYED_FIELDS) assert.deepEqual(read(renamed), after, field);
  assert.equal(/"[AB]"|\\"[AB]\\"/.test(JSON.stringify(renamed)), false, 'no value of the state names A or B any more, a field the audit missed included');
});

test('renameStages applies the map once per value: A ↔ B swaps the two (#861)', () => {
  const swapped = renameStages(stageKeyedState(), { A: 'B', B: 'A' });
  assert.deepEqual([swapped.tasks[0].stage, swapped.activities[0].stageStart, Object.keys(swapped.activityRecords[0].stageRuns ?? {})], ['B', { stage: 'B', commit: 'c0ffee', after: 'A' }, ['B', 'A']]);
  assert.equal(swapped.activities[0].handoffPending, transitionKey({ from: 'A', when: 'done' }));
});

test('renameStages with an empty map, or one naming no stage the state holds, is the same object (#861)', () => {
  const state = stageKeyedState();
  assert.equal(renameStages(state, {}), state);
  assert.equal(renameStages(state, { Q: 'R' }), state);
});

test('renameStages renames a stage inside its flow too, so flows never hold an old name (#564)', () => {
  const start = { ...initialState(0), ...flowed([{ name: 'spec', from: {} }], [{ from: 'spec', to: 'end', when: 'done' }]) };
  const renamed = renameStages(start, { spec: 'Spec' });
  assert.deepEqual(renamed.flows[0].stages.map((s) => s.name), ['Spec']);
  assert.deepEqual(renamed.flows[0].transitions[0].from, 'Spec');
});
