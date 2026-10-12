import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGE_KEYED_FIELDS, stageKeyedState } from './fixtures/stage-keyed.js';

test('the audited fixture fills every stage-keyed field of State with a stage name or a transitionKey (#861)', () => {
  const state = stageKeyedState();
  for (const { field, read, before } of STAGE_KEYED_FIELDS) assert.deepEqual(read(state), before, field);
});
