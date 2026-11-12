import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlows, type FlowParsers } from '../src/config-flows.js';
import type { Stage } from '../src/types.js';

// The stage parser config.ts hands in is tested by config.test; here a stage is taken as written, so only the flow rules are under test
const PARSE: FlowParsers = { stage: (raw) => raw as Stage, sources: (raw) => raw as Record<string, []> };
const st = (name: string, from: Record<string, string[]> = {}): Stage => ({ name, from, prompt: '/x' });
const flow = (name: string, stages: Stage[], transitions: unknown[] = []) => ({ name, stages, transitions });
const parse = (flows: unknown, extra: Record<string, unknown> = {}) => () => parseFlows({ flows, ...extra }, ['board'], PARSE);

test('parseFlows reads several flows in order, each with its own stages and transitions (#564)', () => {
  const flows = parseFlows({ flows: [flow('main', [st('spec', { board: ['Ready'] })], [{ from: 'spec', to: 'end', when: 'done' }]), flow('bug', [st('fix', { board: ['Bug'] })])] }, ['board'], PARSE);
  assert.deepEqual(flows.map((f) => [f.name, f.stages.map((s) => s.name), f.transitions.length]), [['main', ['spec'], 1], ['bug', ['fix'], 0]]);
});

test('the same stage name in two flows is refused naming both flows (#564)', () => {
  assert.throws(parse([flow('main', [st('spec', { board: ['Ready'] })]), flow('bug', [st('spec')])]),
    { message: 'hive.config.json: "comb.flows[1].stages[0].name" "spec" is already a stage of flow "main"' });
});

test('stages of two flows may cite the same source column: the task properties choose among them (#564, #670)', () => {
  const flows = parseFlows({ flows: [flow('main', [st('spec', { board: ['Ready'] })]), flow('bug', [st('triage', { board: ['Ready'] })])] }, ['board'], PARSE);
  assert.deepEqual(flows.map((f) => f.stages.map((s) => s.from.board)), [[['Ready']], [['Ready']]]);
  assert.doesNotThrow(parse([flow('main', [st('spec', { board: ['Ready'] }), st('dev', { board: ['Ready'] })])]), 'two stages of one flow, as before');
});

test('a duplicate, empty or untrimmed flow name is refused (#564)', () => {
  assert.throws(parse([flow('main', [st('a', { board: ['X'] })]), flow('main', [st('b')])]), { message: 'hive.config.json: "comb.flows[1].name" "main" is already the name of another flow' });
  for (const name of ['', ' bug', 7]) {
    assert.throws(parse([flow(name as string, [st('a', { board: ['X'] })])]), { message: 'hive.config.json: "comb.flows[0].name" must be a non-empty, trimmed string' }, JSON.stringify(name));
  }
});

test('flows is required and non-empty, each flow needs a stage, and flows with the flat pair is refused by name (#564)', () => {
  assert.throws(() => parseFlows({}, ['board'], PARSE), { message: 'hive.config.json: "comb.flows" is required' });
  assert.throws(parse([]), { message: 'hive.config.json: "comb.flows" must be a non-empty array' });
  assert.throws(parse([flow('main', [])]), { message: 'hive.config.json: "comb.flows[0].stages" must be a non-empty array' });
  assert.throws(parse([flow('main', [st('a', { board: ['X'] })])], { stages: [] }), { message: 'hive.config.json: "comb.stages" cannot be combined with "comb.flows": the flat pair moved into the flows (#564)' });
});

test('a source no flow enters from is refused over every flow; a transition into another flow\'s stage parses, and into a stage no flow has fails (#564, #691)', () => {
  assert.throws(parse([flow('main', [st('a')])]), { message: 'hive.config.json: "comb.flows" must have at least one stage with "from.board"' });
  const crossed = parseFlows({ flows: [flow('main', [st('a', { board: ['X'] })], [{ from: 'a', to: 'b', when: 'done' }]), flow('bug', [st('b')])] }, ['board'], PARSE);
  assert.deepEqual(crossed[0].transitions.map((t) => t.to), ['b']);
  assert.throws(parse([flow('main', [st('a', { board: ['X'] })], [{ from: 'a', to: 'b', when: 'done' }]), flow('bug', [st('c')])]),
    { message: 'hive.config.json: "comb.flows[0].transitions[0].to" names no stage nor "end"' }, 'bug\'s b removed while main still enters it');
});
