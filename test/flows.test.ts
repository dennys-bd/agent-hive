import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, flowOf, isFlowName, MAIN_FLOW } from '../src/flows.js';
import type { Flow } from '../src/types.js';

const FLOWS: Flow[] = [
  { name: 'main', stages: [{ name: 'spec', from: {} }, { name: 'dev', from: {} }], transitions: [{ from: 'spec', to: 'dev', when: 'done' }] },
  { name: 'bug', stages: [{ name: 'fix', from: {} }], transitions: [{ from: 'fix', to: 'end', when: 'done' }] },
];

test('flatten keeps flow order for both stages and transitions (#564)', () => {
  const { stages, transitions } = flatten(FLOWS);
  assert.deepEqual(stages.map((s) => s.name), ['spec', 'dev', 'fix']);
  assert.deepEqual(transitions.map((t) => t.from), ['spec', 'fix']);
  assert.deepEqual(flatten([]), { stages: [], transitions: [] });
});

test('flowOf returns the flow that holds a stage, or undefined (#564)', () => {
  assert.equal(flowOf(FLOWS, 'fix')?.name, 'bug');
  assert.equal(flowOf(FLOWS, 'dev')?.name, 'main');
  assert.equal(flowOf(FLOWS, 'gone'), undefined);
  assert.equal(flowOf(FLOWS, 'end'), undefined, 'end is no stage');
});

test('isFlowName takes a non-empty trimmed string only (#564)', () => {
  assert.equal(isFlowName(MAIN_FLOW), true);
  for (const bad of ['', ' main', 'main ', 7, undefined]) assert.equal(isFlowName(bad), false, JSON.stringify(bad));
});
